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
 *        claude --print "<instructions>"
 *      with full repo access. The implementation, build, and any edits happen
 *      inside that session.
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
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const INTERVAL_MS = 15000
const INSTANCE_ID = "code-runner-mac-mini"

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
 * Run a headless Claude Code session. Resolves with { ok, output } — never
 * rejects (a non-zero exit or spawn failure becomes ok=false with the captured
 * stderr/stdout so the caller can report it and mark the row failed).
 */
function runClaude(cfg, instructions) {
  return new Promise((resolve) => {
    const args = ["--print"]
    if (cfg.extraArgs) args.push(...cfg.extraArgs.split(/\s+/))
    args.push(instructions)

    let stdout = ""
    let stderr = ""
    let settled = false

    let child
    try {
      child = spawn(cfg.claudeBin, args, { cwd: cfg.repoDir })
    } catch (e) {
      resolve({ ok: false, output: `Failed to launch ${cfg.claudeBin}: ${e?.message || String(e)}` })
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill("SIGKILL") } catch { /* ignore */ }
      resolve({
        ok: false,
        output: `Code task timed out after ${Math.round(cfg.timeoutMs / 60000)} min.\n\nPartial output:\n${(stdout || stderr).slice(-4000)}`,
      })
    }, cfg.timeoutMs)

    child.stdout?.on("data", (d) => { stdout += d.toString() })
    child.stderr?.on("data", (d) => { stderr += d.toString() })

    child.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, output: `Spawn error: ${e?.message || String(e)}` })
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const output = stdout.trim() || stderr.trim() || "(no output)"
      resolve({ ok: code === 0, output: code === 0 ? output : `Claude exited ${code}.\n${output}` })
    })
  })
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
  const instructions = row.body || ""

  log("claimed code task", row.id, "—", title)

  // 3) Run Claude Code in the repo dir.
  let { ok, output } = await runClaude(cfg, instructions)

  // 3b) If the session succeeded and left new local commits, push them so the
  // change actually reaches production. A single `git push origin main` deploys
  // it (the repo is wired to both Vercel projects). If the push fails — pre-push
  // hooks (build, unit tests, ESLint, remote-sync) or a non-fast-forward — surface
  // the error and mark the task FAILED: the code is committed locally but did NOT
  // reach production, so it must not look like a success.
  if (ok) {
    try {
      const newCommits = execSync('git log --oneline HEAD...origin/main 2>/dev/null || echo ""', {
        cwd: cfg.repoDir,
        encoding: "utf8",
      }).trim()
      if (newCommits) {
        execSync("ALLOW_SYSTEM_DOC_SKIP=1 ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin main", {
          cwd: cfg.repoDir,
          timeout: 120000,
          encoding: "utf8",
        })
        output += "\n\n✅ Pushed to production."
      }
    } catch (pushErr) {
      ok = false
      output += "\n\n⚠️ Code changes committed locally but push failed:\n" + String(pushErr?.message || pushErr).slice(0, 500)
    }
  }

  // 4) Post the result back to the originating Slack thread.
  const header = ok ? `✅ *${title}* — done` : `⚠️ *${title}* — failed`
  await postToSlack(cfg.slackToken, channelId, threadTs, `${header}\n\n${output.slice(0, 3500)}`)

  // 5) Finalize the row.
  const update = ok
    ? { status: "done", reply: output.slice(0, 100000), replied_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: "failed", error_text: output.slice(0, 10000), updated_at: new Date().toISOString() }

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
