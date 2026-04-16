/**
 * Internal endpoint: smoke-alert
 *
 * P2.6 — called by .github/workflows/post-deploy-smoke.yml when one of the
 * post-deploy smoke checks fails. Sends an HTML email to support@tonydurante.us
 * via the existing Gmail Service Account helper. Does NOT block deploys —
 * pure alerting.
 *
 * Auth: Bearer CRON_SECRET (re-used so we don't need a new secret on Vercel
 * or in GitHub Actions secrets). The smoke workflow already needs CRON_SECRET
 * to call /api/cron/audit-health-check during the smoke run.
 *
 * Idempotency: GitHub Actions retries failed workflows on its own; we don't
 * de-dupe alerts here. Worst case: 2 emails for the same broken deploy. The
 * subject + commit_sha + checked_at make duplicates obvious.
 *
 * Formatter lives in lib/post-deploy-smoke.ts (Next.js 14 strict route-type
 * check rejects non-route exports from route files).
 */

export const dynamic = "force-dynamic"
export const maxDuration = 30

import { NextRequest, NextResponse } from "next/server"
import { gmailPost } from "@/lib/gmail"
import { buildAlertEmail, type SmokeAlertBody } from "@/lib/post-deploy-smoke"

export async function POST(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfigured: CRON_SECRET not set" }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // ─── Body ──────────────────────────────────────────────
  let body: SmokeAlertBody
  try {
    body = (await req.json()) as SmokeAlertBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(body.failures) || body.failures.length === 0) {
    return NextResponse.json({ error: "failures[] required and non-empty" }, { status: 400 })
  }

  // ─── Compose email ─────────────────────────────────────
  const { subject, html } = buildAlertEmail(body)

  // ─── Send via Gmail SA ─────────────────────────────────
  // RFC 2047 base64-encoded subject per R041 (mandatory for ALL email senders).
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const mime = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    "To: support@tonydurante.us",
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n")
  const raw = Buffer.from(mime).toString("base64url")

  try {
    await gmailPost("/messages/send", { raw })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[smoke-alert] gmail send failed:", msg)
    return NextResponse.json({ error: "Email send failed", detail: msg }, { status: 502 })
  }

  return NextResponse.json({ ok: true, sent_to: "support@tonydurante.us", failure_count: body.failures.length })
}
