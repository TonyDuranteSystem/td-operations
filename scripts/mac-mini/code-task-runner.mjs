#!/usr/bin/env node
/**
 * Mac Mini — Code Task Runner (Slack → Claude Code rail).
 *
 * Every INTERVAL_MS it:
 *   1. Polls agent_messages for the oldest row with
 *      recipient='code_runner' AND status='pending'.
 *   2. Atomically CLAIMS it (status pending -> processing, guarded by
 *      .eq('status','pending') so two runners never double-claim).
 *   3. Runs a headless Claude Code session in the repo dir:
 *        claude --print --output-format stream-json --verbose "<instructions>"
 *      with full repo access. The implementation, build, and any edits happen
 *      inside that session. The stream-json events are parsed in real time
 *      (code-task-progress.mjs) so coarse milestones ("✏️ Editing code…",
 *      "🔨 Building…", "🧪 Running tests…", "💾 Committing…") are posted to the
 *      Slack thread as the work happens, and the final answer is read from the
 *      terminal `result` event (with stream-json, stdout is the event stream).
 *   4. Posts the session output back to the originating Slack thread
 *      (channel + thread carried on context_json by the Slack worker's
 *      start_code_task tool).
 *   5. Marks the row done (reply = output) or failed (error_text = reason).
 *
 * Design (mirrors ~/.hermes/agents/approval-runner.mjs):
 *   - NEVER crashes: every tick is wrapped; uncaught errors/rejections are
 *     logged and swallowed; the loop runs forever. launchd KeepAlive is the
 *     last resort.
 *   - Env reloaded each tick so a rotated value is picked up without restart.
 *   - One task per tick (code tasks are long-running; no batch drain).
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL    — Supabase project URL (same DB the Slack worker writes to)
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role key (bypasses RLS)
 *   SLACK_BOT_TOKEN_CLAUDE      — Slack bot token used to post results
 * Optional:
 *   CODE_TASK_REPO_DIR          — repo dir to run Claude Code in (default: this repo)
 *   CLAUDE_BIN                  — Claude Code binary (default: "claude")
 *   CLAUDE_EXTRA_ARGS           — extra args appended after --print (space-separated),
 *                                 e.g. "--permission-mode acceptEdits" for autonomous runs
 *   CODE_TASK_TIMEOUT_MS        — per-task ceiling (default: 1800000 = 30 min)
 *
 * Verified against: lib/ai-agent/worker-tools.ts (start_code_task insert shape:
 *   recipient='code_runner', context_json.{source,title,slack_channel_id,slack_thread_ts})
 *   and lib/ai-agent/slack-claude.ts (chat.postMessage shape), 2026-06-11.
 */

import { spawn, execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { parseStreamLine, milestoneFromEvent, finalResultFromEvent } from "./code-task-progress.mjs"
import {
  codeTaskBranchName,
  codeTaskWorktreePath,
  promoteTempBranch,
  promoteWorktreePath,
  repoWebUrlFromRemote,
  compareUrl,
} from "./deploy-utils.mjs"
import { randomUUID } from "node:crypto"
import { formatUserMessage, isEndSignal, eventToRow } from "./code-task-stream.mjs"

// Interactive (live-viewer) session pacing.
const INPUT_POLL_MS = 3000              // how often to drain admin-typed turns
const IDLE_END_MS = 3 * 60 * 1000       // auto-end if no input this long after a turn finishes
const INTERACTIVE_MAX_MS = 60 * 60 * 1000 // hard ceiling so a stuck session can't run forever

const INTERVAL_MS = 15000
const INSTANCE_ID = "code-runner-mac-mini"

// Progress heartbeats posted to the Slack thread while a long-running task is
// still executing. Each fires once at its elapsed mark (cleared when the task
// settles, so a fast task posts none). The Slack worker that queues the task
// runs in a 300s-capped serverless function and dies the moment it returns, so
// it CANNOT track progress — this daemon is the only component alive long enough
// to do it (its setTimeouts genuinely fire during the `await runClaude`).
const HEARTBEATS = [
  { ms: 5 * 60 * 1000, text: "⏳ Still running (5 min)…" },
  { ms: 10 * 60 * 1000, text: "⚠️ Taking longer than expected (10 min)…" },
]

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// scripts/mac-mini/ -> repo root is two levels up.
const DEFAULT_REPO_DIR = path.resolve(__dirname, "..", "..")

function log(...args) {
  const ts = new Date().toISOString()
  // eslint-disable-next-line no-console
  console.log(`[${ts}]`, ...args)
}

function getConfig() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    slackToken: process.env.SLACK_BOT_TOKEN_CLAUDE || "",
    repoDir: process.env.CODE_TASK_REPO_DIR || DEFAULT_REPO_DIR,
    claudeBin: process.env.CLAUDE_BIN || "claude",
    extraArgs: (process.env.CLAUDE_EXTRA_ARGS || "").trim(),
    timeoutMs: Number(process.env.CODE_TASK_TIMEOUT_MS) || 30 * 60 * 1000,
  }
}

/** Post a message to a Slack thread. Best-effort — logs and returns on failure. */
async function postToSlack(token, channelId, threadTs, text) {
  if (!token || !channelId) {
    log("postToSlack skipped — missing token or channel")
    return
  }
  try {
    const payload = { channel: channelId, text }
    if (threadTs) payload.thread_ts = threadTs
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) log("chat.postMessage failed:", data.error || "unknown")
  } catch (e) {
    log("postToSlack ERROR:", e?.message || String(e))
  }
}

/**
 * INTERACTIVE session (item 3, model B). Runs the headless `claude` with bidirectional
 * stream-json so the admin can watch it live and type into it from the CRM viewer:
 *   - assigns a known sessionId (also surfaced on every event so the viewer can map);
 *   - writes the initial instructions as the first stdin turn, then keeps stdin OPEN;
 *   - persists every output event to code_task_events (seq-ordered) for the live tail;
 *   - polls code_task_inputs and writes each admin turn into stdin (marks delivered);
 *   - ends the session (EOF on stdin) on the END sentinel OR after IDLE_END_MS with no
 *     input following a completed turn — then the caller pushes the branch.
 * isPaused() (an ask-antonio question pending) suspends the idle auto-end. Never throws;
 * resolves { ok, output } from the LAST result event (with stream-json the reply is there).
 */
function runInteractiveClaude(cfg, opts) {
  const { instructions, workdir, taskId, sessionId, supabase, onMilestone, isPaused, taskEnv } = opts
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", sessionId,
    ]
    if (cfg.extraArgs) args.push(...cfg.extraArgs.split(/\s+/))

    let child
    try {
      child = spawn(cfg.claudeBin, args, { cwd: workdir, env: { ...process.env, ...(taskEnv || {}) } })
    } catch (e) {
      resolve({ ok: false, output: `Failed to launch ${cfg.claudeBin}: ${e?.message || String(e)}` })
      return
    }

    let lineBuf = ""
    let stderr = ""
    let finalText = ""
    let finalIsError = null
    let seq = 0
    let lastMilestoneKey = null
    let settled = false
    let ended = false
    let idleTimer = null

    const writeTurn = (text) => { try { child.stdin.write(formatUserMessage(text)) } catch { /* stdin closed */ } }
    const endSession = () => { if (!ended) { ended = true; try { child.stdin.end() } catch { /* ignore */ } } }
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (typeof isPaused === "function" && isPaused()) { armIdle(); return } // a question is pending — wait
        endSession()
      }, IDLE_END_MS)
    }

    const persist = (s, row) => {
      try {
        void supabase
          .from("code_task_events")
          .insert({ task_id: taskId, seq: s, event_type: row.event_type, payload: row.payload })
          .then(() => {}, () => {})
      } catch { /* best-effort */ }
    }

    function handleLine(line) {
      const ev = parseStreamLine(line)
      if (!ev) return
      const m = milestoneFromEvent(ev)
      if (m && m.key !== lastMilestoneKey) {
        lastMilestoneKey = m.key
        if (typeof onMilestone === "function") { try { onMilestone(m.text) } catch { /* best-effort */ } }
      }
      const row = eventToRow(ev)
      if (row) persist(seq++, row)
      const f = finalResultFromEvent(ev)
      if (f) {
        finalText = f.text
        finalIsError = f.isError
        armIdle() // a turn just finished — start the no-input countdown
      }
    }

    child.stdout?.on("data", (d) => {
      lineBuf += d.toString()
      let idx
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx)
        lineBuf = lineBuf.slice(idx + 1)
        handleLine(line)
      }
    })
    child.stderr?.on("data", (d) => { stderr += d.toString() })

    const markDelivered = (id) => {
      try {
        void supabase
          .from("code_task_inputs")
          .update({ status: "delivered", delivered_at: new Date().toISOString() })
          .eq("id", id)
          .then(() => {}, () => {})
      } catch { /* best-effort */ }
    }

    // Drain admin-typed turns from the viewer into the live session.
    const poller = setInterval(async () => {
      if (ended || settled) return
      try {
        const { data } = await supabase
          .from("code_task_inputs")
          .select("id, seq, text")
          .eq("task_id", taskId)
          .eq("status", "pending")
          .order("seq", { ascending: true })
        for (const inp of data || []) {
          if (isEndSignal(inp.text)) { markDelivered(inp.id); endSession(); break }
          if (idleTimer) clearTimeout(idleTimer) // active input cancels the idle countdown
          writeTurn(inp.text)
          markDelivered(inp.id)
        }
      } catch { /* best-effort */ }
    }, INPUT_POLL_MS)

    const hardTimer = setTimeout(endSession, INTERACTIVE_MAX_MS)
    const cleanup = () => { if (idleTimer) clearTimeout(idleTimer); clearInterval(poller); clearTimeout(hardTimer) }

    child.on("error", (e) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ok: false, output: `Spawn error: ${e?.message || String(e)}` })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (lineBuf.trim()) handleLine(lineBuf)
      const body = finalText.trim() || stderr.trim() || "(no output)"
      const ok = code === 0 && finalIsError !== true
      resolve({ ok, output: ok ? body : finalIsError === true ? body : `Claude exited ${code}.\n${body}` })
    })

    // Kick off the session with the task instructions as the first turn.
    writeTurn(instructions)
  })
}

/**
 * Create an ISOLATED worktree for a task on a fresh branch cut from origin/main,
 * so the session only ever sees its own changes and can never mix with or clobber
 * another session's in-flight work. Symlinks node_modules from the main checkout
 * so the pre-push build/tests have their deps without a reinstall. Returns
 * { ok, detail } and never throws.
 */
function prepareWorktree(cfg, branch, wtPath) {
  try {
    // Clear any stale worktree/branch left by a previous crashed run of THIS task.
    try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* none */ }
    try { execSync("git worktree prune", { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* none */ }
    try { execSync(`git branch -D "${branch}"`, { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* none */ }
    // Cut the branch from the CURRENT origin/main so it holds only this task's commits.
    execSync("git fetch origin main --quiet", { cwd: cfg.repoDir, timeout: 120000, encoding: "utf8" })
    execSync(`git worktree add --quiet "${wtPath}" -b "${branch}" origin/main`, {
      cwd: cfg.repoDir,
      timeout: 120000,
      encoding: "utf8",
    })
    // Symlink node_modules from the main checkout (fast; no reinstall). If the task
    // changes dependencies, the pre-push build step surfaces it for a follow-up.
    const mainNodeModules = path.join(cfg.repoDir, "node_modules")
    const wtNodeModules = path.join(wtPath, "node_modules")
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
      fs.symlinkSync(mainNodeModules, wtNodeModules, "dir")
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) }
  }
}

/**
 * Remove a task's worktree (and its local branch once it's safely on origin).
 * Best-effort — never throws. A push failure keeps the local branch for retry.
 */
function cleanupWorktree(cfg, wtPath, branch, branchPushed) {
  try {
    execSync(`git worktree remove --force "${wtPath}"`, { cwd: cfg.repoDir, encoding: "utf8" })
  } catch (e) {
    log("worktree remove failed:", e?.message || String(e))
  }
  try { execSync("git worktree prune", { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
  // The branch is preserved on origin for review; the local ref is redundant.
  if (branchPushed) {
    try { execSync(`git branch -D "${branch}"`, { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
  }
}

/**
 * Startup sweep: remove orphaned code-task worktrees left by a crashed/killed
 * runner before launchd restarted it. Safe to run at boot because no task is in
 * flight yet. Best-effort — never throws.
 */
function sweepOrphanWorktrees(cfg) {
  try {
    const out = execSync("git worktree list --porcelain", { cwd: cfg.repoDir, encoding: "utf8" })
    const paths = out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter((p) => p.includes("/.claude/worktrees/code-task-"))
    for (const p of paths) {
      try {
        execSync(`git worktree remove --force "${p}"`, { cwd: cfg.repoDir, encoding: "utf8" })
        log("swept orphan worktree:", p)
      } catch (e) {
        log("sweep failed for", p, ":", e?.message || String(e))
      }
    }
    try { execSync("git worktree prune", { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
  } catch (e) {
    log("sweepOrphanWorktrees ERROR (ignored):", e?.message || String(e))
  }
}

/**
 * Promote a code branch to production: merge it into the CURRENT origin/main in an
 * isolated worktree and push main. This is the ONLY place the rail pushes to main,
 * and it runs only for a "ship it" promote task (R104 — explicit human approval).
 *
 * SURGICAL + SAFE: merges exactly the one branch's commits. If origin/main has
 * advanced and the branch conflicts, the merge is aborted and NOTHING is pushed —
 * the branch is reported as needing a rebase, never force-merged. The pre-push
 * hooks (build, unit tests, ESLint, R107 doc gate, remote-sync) run on the main
 * push, so a broken or doc-stale promotion is rejected before it reaches prod.
 * Returns { ok, output } and never throws.
 */
function promoteBranchToMain(cfg, branch) {
  const wtPath = promoteWorktreePath(cfg.repoDir, branch)
  const tmpBranch = promoteTempBranch(branch)
  const cleanup = () => {
    try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
    try { execSync("git worktree prune", { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
    try { execSync(`git branch -D "${tmpBranch}"`, { cwd: cfg.repoDir, encoding: "utf8" }) } catch { /* ignore */ }
  }
  try {
    cleanup() // clear any stale promote worktree/branch from a prior run
    execSync("git fetch origin --quiet", { cwd: cfg.repoDir, timeout: 120000, encoding: "utf8" })
    // The branch must exist on origin (it was pushed by its build task).
    try {
      execSync(`git rev-parse --verify "origin/${branch}"`, { cwd: cfg.repoDir, encoding: "utf8", stdio: "pipe" })
    } catch {
      return { ok: false, output: `⚠️ Can't promote — branch \`${branch}\` no longer exists on origin. Was it already shipped or deleted?` }
    }
    // Isolated worktree on the CURRENT origin/main; symlink deps for the hooks.
    execSync(`git worktree add --quiet "${wtPath}" -b "${tmpBranch}" origin/main`, {
      cwd: cfg.repoDir,
      timeout: 120000,
      encoding: "utf8",
    })
    const mainNodeModules = path.join(cfg.repoDir, "node_modules")
    const wtNodeModules = path.join(wtPath, "node_modules")
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
      fs.symlinkSync(mainNodeModules, wtNodeModules, "dir")
    }
    // Try a clean merge of the branch into current main.
    try {
      execSync(`git merge --no-ff --no-edit "origin/${branch}"`, { cwd: wtPath, encoding: "utf8", stdio: "pipe" })
    } catch {
      try { execSync("git merge --abort", { cwd: wtPath, encoding: "utf8" }) } catch { /* ignore */ }
      return {
        ok: false,
        output: `⚠️ Can't ship \`${branch}\` cleanly — main has advanced and the branch conflicts. It needs a rebase first. Nothing was pushed to production.`,
      }
    }
    // Clean merge → push to main. This is the human-approved production deploy.
    execSync("ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin HEAD:main", {
      cwd: wtPath,
      timeout: 120000,
      encoding: "utf8",
    })
    return { ok: true, output: `🚀 Shipped \`${branch}\` to production (merged into main and deployed).` }
  } catch (e) {
    return { ok: false, output: `⚠️ Promotion of \`${branch}\` failed:\n${String(e?.message || e).slice(0, 500)}` }
  } finally {
    cleanup()
  }
}

/**
 * Claim and process the oldest pending code task. Returns true if a task was
 * handled this tick (so main() can log activity), false if the queue was empty.
 */
async function tick(cfg) {
  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false },
  })

  // 1) Find the oldest pending code task.
  const { data: pending, error: selErr } = await supabase
    .from("agent_messages")
    .select("id, subject, body, context_json")
    .eq("recipient", "code_runner")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)

  if (selErr) {
    log("select ERROR:", selErr.message)
    return false
  }
  const row = (pending || [])[0]
  if (!row) return false

  // 2) Atomic claim — guarded by status='pending' so a second runner gets nothing.
  const { data: claimed, error: claimErr } = await supabase
    .from("agent_messages")
    .update({
      status: "processing",
      claimed_at: new Date().toISOString(),
      claimed_by: INSTANCE_ID,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")

  if (claimErr) {
    log("claim ERROR for", row.id, ":", claimErr.message)
    return false
  }
  if (!claimed || claimed.length === 0) {
    // Someone else claimed it between select and update — fine, try next tick.
    return false
  }

  const ctx = row.context_json || {}
  const channelId = ctx.slack_channel_id || null
  const threadTs = ctx.slack_thread_ts || null
  const title = ctx.title || row.subject || "Code task"

  // When we can reach Antonio (channel + thread known), tell the session it may
  // ask him a blocking question via the ask-antonio CLI. Only for genuine
  // can't-proceed decisions — the preamble says so. Omitted when there's no
  // thread to post into (the CLI would have nowhere to reach him).
  const canAskAntonio = Boolean(channelId && threadTs)
  const askPreamble = canAskAntonio
    ? `[ASK ANTONIO] If you hit a decision only Antonio can make and genuinely cannot proceed correctly without it (e.g. a naming choice, production vs sandbox, an ambiguous requirement), you can ask him in Slack and WAIT for his reply by running:\n    node scripts/mac-mini/ask-antonio.mjs "your question here"\nIt blocks until he replies and prints his answer to stdout. Use it sparingly — prefer making a sound decision and reporting your assumption. Never use it for anything you can verify or decide yourself.\n\n`
    : ""
  const instructions = askPreamble + (row.body || "")

  // Per-task env for the spawned session, so the ask-antonio CLI knows which
  // task/thread it's in. Inherited by the session's Bash-tool child processes.
  const taskEnv = canAskAntonio
    ? {
        CODE_TASK_ID: String(row.id),
        CODE_TASK_QUESTION_CHANNEL: String(channelId),
        CODE_TASK_QUESTION_THREAD_TS: String(threadTs),
      }
    : {}

  log("claimed code task", row.id, "—", title)

  // 2b) Tell the originating Slack thread the task is now running. The user only
  // saw "I've queued the task" from the Slack worker; without this they get
  // silence until done/failed. Best-effort — postToSlack never throws.
  await postToSlack(cfg.slackToken, channelId, threadTs, `🔧 *${title}* — Mac Mini picked it up, working on it…`)

  // 2b-0) PROMOTE TASK — a "ship it" request carries a code branch to merge into
  // main. This is the ONLY path that deploys to production, and only here (R104,
  // explicit human approval). It runs no Claude session — just the guarded merge.
  const promoteBranch = typeof ctx.promote_branch === "string" ? ctx.promote_branch : null
  if (promoteBranch) {
    await postToSlack(cfg.slackToken, channelId, threadTs, `🚀 Shipping \`${promoteBranch}\` to production…`)
    const pr = promoteBranchToMain(cfg, promoteBranch)
    const phdr = pr.ok ? `✅ *${title}* — shipped` : `⚠️ *${title}* — not shipped`
    await postToSlack(cfg.slackToken, channelId, threadTs, `${phdr}\n\n${pr.output.slice(0, 3500)}`)
    const pupd = pr.ok
      ? { status: "done", reply: pr.output.slice(0, 100000), replied_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      : { status: "failed", error_text: pr.output.slice(0, 10000), updated_at: new Date().toISOString() }
    const { error: pErr } = await supabase.from("agent_messages").update(pupd).eq("id", row.id)
    if (pErr) log("promote finalize ERROR for", row.id, ":", pErr.message)
    log(pr.ok ? "promoted" : "promote failed", row.id, promoteBranch)
    return true
  }

  // 2b-i) ISOLATED WORKSPACE — every task runs in its OWN git worktree on its OWN
  // branch cut from origin/main, so it only ever sees its own changes and can never
  // mix with, or clobber, another session's in-flight work (no shared main, no
  // reset --hard on the live checkout, no stash collisions).
  const branch = codeTaskBranchName(row.id, title)
  const wtPath = codeTaskWorktreePath(cfg.repoDir, row.id)
  let branchPushed = false
  const prep = prepareWorktree(cfg, branch, wtPath)
  if (!prep.ok) {
    const msg = `⚠️ *${title}* — couldn't set up an isolated workspace:\n${prep.detail}`
    await postToSlack(cfg.slackToken, channelId, threadTs, msg)
    await supabase
      .from("agent_messages")
      .update({ status: "failed", error_text: msg.slice(0, 10000), updated_at: new Date().toISOString() })
      .eq("id", row.id)
    log("worktree prep failed", row.id, ":", prep.detail)
    return true
  }

  // 2b-ii) INTERACTIVE SESSION — assign a known session id and store it on the row
  // so the CRM viewer can map this task to its live transcript + accept typed input.
  const sessionId = randomUUID()
  try {
    await supabase
      .from("agent_messages")
      .update({ context_json: { ...ctx, session_id: sessionId }, updated_at: new Date().toISOString() })
      .eq("id", row.id)
  } catch (e) {
    log("session_id store failed", row.id, ":", e?.message || String(e))
  }
  const viewerBase = process.env.CODE_TASK_VIEWER_BASE_URL || "https://td-operations.vercel.app"
  await postToSlack(cfg.slackToken, channelId, threadTs, `👁 Watch + type into this session live: ${viewerBase}/code-tasks/${row.id}`)

  // 2c) Arm progress heartbeats for the duration of runClaude. Each setTimeout
  // fires once at its elapsed mark (5 min, 10 min); all are cleared the moment
  // the session settles, so a sub-5-min task posts none. These genuinely fire
  // because Node timers run during the `await runClaude` below.
  const heartbeatTimers = HEARTBEATS.map((hb) =>
    setTimeout(() => {
      void postToSlack(cfg.slackToken, channelId, threadTs, `${hb.text} _${title}_`)
    }, hb.ms),
  )

  // 2d) Watch for a pending ask-antonio question on this task. While one is
  // pending, runClaude's kill-timer is paused (isPaused below) so Antonio's
  // reply delay never kills in-progress work. Polls every 8s; best-effort (a
  // failed/absent code_task_questions query just leaves questionPending false,
  // so the feature degrades to the plain timeout).
  let questionPending = false
  const questionWatcher = canAskAntonio
    ? setInterval(async () => {
        try {
          const { data } = await supabase
            .from("code_task_questions")
            .select("id")
            .eq("task_id", row.id)
            .eq("status", "pending")
            .limit(1)
          questionPending = Boolean(data && data.length)
        } catch {
          questionPending = false
        }
      }, 8000)
    : null

  // 3) Run Claude Code in the repo dir. The onMilestone callback posts coarse
  // progress lines ("✏️ Editing code…", "🔨 Building…", "🧪 Running tests…",
  // "💾 Committing…") to the Slack thread as the session works — deduped against
  // the previous milestone inside runClaude, so a burst of reads/edits is one
  // line. Best-effort: postToSlack never throws.
  let result
  try {
    result = await runInteractiveClaude(cfg, {
      instructions,
      workdir: wtPath,
      taskId: row.id,
      sessionId,
      supabase,
      onMilestone: (text) => {
        void postToSlack(cfg.slackToken, channelId, threadTs, `${text} _${title}_`)
      },
      isPaused: () => questionPending,
      taskEnv,
    })
  } finally {
    for (const t of heartbeatTimers) clearTimeout(t)
    if (questionWatcher) clearInterval(questionWatcher)
    // Expire any still-pending question for this task so a late reply can't be
    // swallowed by the now-finished task (the webhook only answers 'pending').
    if (canAskAntonio) {
      try {
        await supabase
          .from("code_task_questions")
          .update({ status: "expired" })
          .eq("task_id", row.id)
          .eq("status", "pending")
      } catch (e) {
        log("expire-questions ERROR for", row.id, ":", e?.message || String(e))
      }
    }
  }
  let { ok, output } = result

  // 3b) On success with commits, push the task's BRANCH (never main). Because the
  // worktree was cut from origin/main, the branch holds ONLY this task's commits —
  // surgical: "ship it" later promotes exactly these and nothing else. Production
  // deploy is a separate, explicit step (R104): the rail does NOT auto-ship. The
  // pre-push hooks (build, unit tests, ESLint, remote-sync) run on this push, so a
  // broken change is rejected before it reaches a reviewable branch.
  if (ok) {
    try {
      const newCommits = execSync('git log --oneline HEAD...origin/main 2>/dev/null || echo ""', {
        cwd: wtPath,
        encoding: "utf8",
      }).trim()
      if (newCommits) {
        // Narrate the push phase — the session's own git tool_use is suppressed in
        // code-task-progress.mjs so this is the single "pushing" signal.
        await postToSlack(
          cfg.slackToken,
          channelId,
          threadTs,
          `📦 Pushing to branch \`${branch}\` for review (preview — NOT production)… _${title}_`,
        )
        execSync(`git push -u origin "${branch}"`, { cwd: wtPath, timeout: 120000, encoding: "utf8" })
        branchPushed = true
        const repoWeb = repoWebUrlFromRemote(
          execSync("git remote get-url origin", { cwd: wtPath, encoding: "utf8" }),
        )
        const url = compareUrl(repoWeb, branch)
        output +=
          `\n\n🌿 Pushed to branch \`${branch}\` — preview build, NOT production.` +
          (url ? `\nReview / open PR: ${url}` : "") +
          `\nReply "ship it" in this thread to promote to production.`
      }
    } catch (pushErr) {
      ok = false
      output +=
        "\n\n⚠️ Code changes committed locally but branch push failed:\n" +
        String(pushErr?.message || pushErr).slice(0, 500)
    }
  }

  // 3c) Tear down the isolated worktree. The branch lives on origin (if pushed) for
  // review; the working dir is disposable. Best-effort — never throws.
  cleanupWorktree(cfg, wtPath, branch, branchPushed)

  // 4) Post the result back to the originating Slack thread.
  const header = ok ? `✅ *${title}* — done` : `⚠️ *${title}* — failed`
  await postToSlack(cfg.slackToken, channelId, threadTs, `${header}\n\n${output.slice(0, 3500)}`)

  // 5) Finalize the row.
  // Record the pushed branch on the row so the "ship it" promotion step can find
  // exactly this task's branch (null if nothing was pushed).
  const ctxOut = { ...ctx, session_id: sessionId, code_branch: branchPushed ? branch : null }
  const update = ok
    ? { status: "done", reply: output.slice(0, 100000), context_json: ctxOut, replied_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: "failed", error_text: output.slice(0, 10000), context_json: ctxOut, updated_at: new Date().toISOString() }

  const { error: finErr } = await supabase
    .from("agent_messages")
    .update(update)
    .eq("id", row.id)
  if (finErr) log("finalize ERROR for", row.id, ":", finErr.message)

  log(ok ? "completed" : "failed", row.id)
  return true
}

// Never let a stray error kill the process.
process.on("uncaughtException", (e) => log("uncaughtException (ignored):", e?.stack || String(e)))
process.on("unhandledRejection", (e) => log("unhandledRejection (ignored):", e?.stack || String(e)))

async function main() {
  log("code-task-runner starting; instance=", INSTANCE_ID, "interval=", `${INTERVAL_MS}ms`)
  // Clear any code-task worktrees orphaned by a crashed/killed previous run before
  // we start claiming tasks (safe: nothing is in flight at boot).
  const bootCfg = getConfig()
  if (bootCfg.repoDir) sweepOrphanWorktrees(bootCfg)
  for (;;) {
    const cfg = getConfig()
    if (!cfg.supabaseUrl || !cfg.supabaseKey) {
      log("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping tick")
    } else {
      try {
        await tick(cfg)
      } catch (e) {
        log("tick ERROR (caught):", e?.stack || e?.message || String(e))
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

main().catch((e) => log("main FATAL (caught):", e?.stack || e?.message || String(e)))
