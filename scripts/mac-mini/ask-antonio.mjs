#!/usr/bin/env node
/**
 * ask-antonio — a running code-task session asks Antonio a question in the
 * originating Slack thread and BLOCKS until he replies, then prints his answer.
 *
 * The headless session invokes it via its Bash tool:
 *     node scripts/mac-mini/ask-antonio.mjs "Should I name the column X or Y?"
 * stdout = Antonio's answer (the session reads it as the command result).
 *
 * Context is injected as env vars by the runner when it spawns the session:
 *   CODE_TASK_ID                  — agent_messages.id of the running task (FK)
 *   CODE_TASK_QUESTION_CHANNEL    — Slack channel to post the question in
 *   CODE_TASK_QUESTION_THREAD_TS  — Slack thread to post the question in
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — DB
 *   SLACK_BOT_TOKEN_CLAUDE        — Slack bot token used to post
 *
 * Flow: INSERT a pending code_task_questions row → post the question to Slack →
 * poll the row every ASK_POLL_MS until it leaves 'pending' (answered/expired) or
 * the ASK_MAX_WAIT_MS self-cap is hit (then mark expired and proceed). The runner
 * keeps the per-task kill-timer paused while a question is pending, so a human
 * delay never kills in-progress work; this CLI's cap is what ultimately bounds
 * the wait. Exit 0 on answered/expired/timeout (normal outcomes), exit 1 only on
 * a hard misconfig / DB-insert failure.
 */

import { createClient } from "@supabase/supabase-js"
import {
  ASK_POLL_MS,
  ASK_MAX_WAIT_MS,
  buildQuestionSlackText,
  interpretQuestionRow,
} from "./ask-antonio-lib.mjs"

function out(text) {
  // eslint-disable-next-line no-console
  console.log(text)
}
function err(text) {
  // eslint-disable-next-line no-console
  console.error(text)
}

async function postToSlack(token, channel, threadTs, text) {
  if (!token || !channel) return
  try {
    const payload = { channel, text }
    if (threadTs) payload.thread_ts = threadTs
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) err(`[ask-antonio] chat.postMessage failed: ${data.error || "unknown"}`)
  } catch (e) {
    err(`[ask-antonio] postToSlack error: ${e?.message || String(e)}`)
  }
}

async function main() {
  const question = process.argv.slice(2).join(" ").trim()
  if (!question) {
    err('[ask-antonio] usage: node ask-antonio.mjs "your question"')
    process.exit(1)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  const slackToken = process.env.SLACK_BOT_TOKEN_CLAUDE || ""
  const taskId = process.env.CODE_TASK_ID || null
  const channel = process.env.CODE_TASK_QUESTION_CHANNEL || ""
  const threadTs = process.env.CODE_TASK_QUESTION_THREAD_TS || ""
  const maxWaitMs = Number(process.env.ASK_ANTONIO_MAX_WAIT_MS) || ASK_MAX_WAIT_MS

  if (!supabaseUrl || !supabaseKey) {
    err("[ask-antonio] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    process.exit(1)
  }
  if (!channel || !threadTs) {
    err("[ask-antonio] missing CODE_TASK_QUESTION_CHANNEL / CODE_TASK_QUESTION_THREAD_TS — cannot reach Antonio")
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  // 1) Record the pending question.
  const { data: inserted, error: insErr } = await supabase
    .from("code_task_questions")
    .insert({
      task_id: taskId,
      slack_channel: channel,
      slack_thread_ts: threadTs,
      question,
      status: "pending",
    })
    .select("id")
    .single()
  if (insErr || !inserted?.id) {
    err(`[ask-antonio] failed to record question: ${insErr?.message || "no id"}`)
    process.exit(1)
  }
  const questionId = inserted.id

  // 2) Post the question to the Slack thread.
  await postToSlack(slackToken, channel, threadTs, buildQuestionSlackText(question))

  // 3) Poll until answered / expired / self-cap.
  const startedAt = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, ASK_POLL_MS))

    const { data: row } = await supabase
      .from("code_task_questions")
      .select("status, answer")
      .eq("id", questionId)
      .maybeSingle()

    const verdict = interpretQuestionRow(row)
    if (verdict.done) {
      if (row?.status === "answered") {
        await postToSlack(slackToken, channel, threadTs, "✅ Got it — continuing.")
      }
      out(verdict.output)
      process.exit(verdict.exitCode)
    }

    // Self-cap: give up waiting, mark expired, let the session proceed.
    if (Date.now() - startedAt >= maxWaitMs) {
      await supabase
        .from("code_task_questions")
        .update({ status: "expired" })
        .eq("id", questionId)
        .eq("status", "pending")
      out(`(No answer within ${Math.round(maxWaitMs / 60000)} min — proceeding without Antonio's input.)`)
      process.exit(0)
    }
  }
}

main().catch((e) => {
  err(`[ask-antonio] fatal: ${e?.stack || e?.message || String(e)}`)
  process.exit(1)
})
