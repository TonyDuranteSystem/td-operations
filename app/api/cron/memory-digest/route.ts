/**
 * Weekly Decision Memory digest (Decision Memory — Phase 6)
 *
 * Schedule: Sunday 09:00 UTC (vercel.json). Summarizes the memories created in
 * the last 7 days — how many corrections vs decisions, which domains, and the
 * top-5 by confidence — and posts the summary to the #td-dev Slack channel.
 *
 * Read-only over decision_memory; the only side effect is the Slack post.
 * Auth: CRON_SECRET Bearer token.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/memory-digest"

// #td-dev channel. Overridable via env so a wrong/rotated id is a config change,
// not a redeploy — the literal is the last-known id (unverified in this session).
const DEV_CHANNEL_ID = process.env.SLACK_DEV_CHANNEL_ID || "C0BAB08DSDN"

interface DigestRow {
  situation: string
  decision: string
  domain: string | null
  correction_type: string | null
  confidence: number | null
  created_at: string
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("decision_memory")
      .select("situation, decision, domain, correction_type, confidence, created_at")
      .gt("created_at", oneWeekAgo)
      .eq("status", "active")
      .order("confidence", { ascending: false })
    if (error) throw new Error(error.message)

    const memories = (data ?? []) as DigestRow[]

    if (memories.length === 0) {
      logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - start, details: { count: 0 } })
      return NextResponse.json({ ok: true, count: 0, message: "No new memories this week" })
    }

    const corrections = memories.filter((m) => m.correction_type)
    const decisions = memories.filter((m) => !m.correction_type)
    const domains = Array.from(new Set(memories.map((m) => m.domain).filter(Boolean))) as string[]

    const lines = [
      `🧠 *Weekly Memory Digest* — ${memories.length} new ${memories.length === 1 ? "memory" : "memories"} this week`,
      "",
      `📊 ${corrections.length} corrections | ${decisions.length} decisions | Domains: ${domains.join(", ") || "general"}`,
      "",
      "*Top learnings:*",
      ...memories.slice(0, 5).map((m, i) => {
        const tag = m.domain ? `[${m.domain}] ` : ""
        const text = m.decision.length > 150 ? `${m.decision.slice(0, 150)}...` : m.decision
        return `${i + 1}. ${tag}${text}`
      }),
    ]

    const token = process.env.SLACK_BOT_TOKEN_CLAUDE
    let posted = false
    if (token) {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: DEV_CHANNEL_ID, text: lines.join("\n") }),
      })
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      posted = json.ok === true
      if (!posted) console.warn(`[memory-digest] Slack post failed: ${json.error ?? "unknown"}`)
    }

    logCron({
      endpoint: ENDPOINT,
      status: "success",
      duration_ms: Date.now() - start,
      details: { count: memories.length, posted },
    })
    return NextResponse.json({ ok: true, count: memories.length, posted })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
