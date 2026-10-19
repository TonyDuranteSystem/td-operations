/**
 * Meta lead-ads webhook (TD Marketing, dev job 9aec66fa). Meta calls this when someone fills in a lead form on the Page.
 *   GET  — the subscription handshake (hub.mode / hub.verify_token / hub.challenge), answered only with OUR verify token.
 *   POST — the notification. The body carries ids only; we verify the HMAC signature of the RAW body, store every notification as a
 *          durable event, then fetch and store the lead. A fetch that fails stays 'failed' and the retry cron picks it up.
 * Fails CLOSED: no app secret configured, or a wrong/missing signature, is a refusal (503 / 401), never a pass.
 * Env (set by Antonio on Vercel; never typed by Claude): META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_PAGE_ACCESS_TOKEN.
 * Under /api/webhooks so the existing public-path rule applies and the sandbox guard blocks it in the test environment.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { checkVerifyHandshake, verifyMetaSignature } from "@/lib/marketing/meta-leads/signature"
import { parseLeadgenWebhook } from "@/lib/marketing/meta-leads/parse-webhook"
import { ingestLeadgenEvent, recordLeadgenEvent } from "@/lib/marketing/meta-leads/ingest"
import { leadDb, liveDeps } from "@/lib/marketing/meta-leads/service"

const MAX_BODY = 1_000_000
const MAX_EVENTS = 50
/** Leads fetched inline per notification; the rest are already stored as events and the retry cron finishes them. */
const INLINE_FETCH = 5

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const r = checkVerifyHandshake(
    { mode: p.get("hub.mode"), token: p.get("hub.verify_token"), challenge: p.get("hub.challenge") },
    process.env.META_WEBHOOK_VERIFY_TOKEN,
  )
  if (r.ok === false) return new NextResponse("Forbidden", { status: 403 })
  return new NextResponse(r.challenge, { status: 200, headers: { "Content-Type": "text/plain" } })
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too large" }, { status: 413 })
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    console.error("[meta-leads-webhook] META_APP_SECRET is not set — refusing every notification")
    return NextResponse.json({ error: "not configured" }, { status: 503 })
  }
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 })
  }
  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }) }

  const events = parseLeadgenWebhook(body).slice(0, MAX_EVENTS)
  const db = leadDb()
  // 1. store every notification first: nothing below can lose a lead
  for (const ev of events) await recordLeadgenEvent(db, ev, "webhook")
  // 2. fetch and store a few right away; never fail the response because of Meta or our own database being slow
  let stored = 0
  const deps = liveDeps()
  for (const ev of events.slice(0, INLINE_FETCH)) {
    try {
      const out = await ingestLeadgenEvent(deps, ev, "webhook")
      if (out.status === "stored") stored++
    } catch (e) {
      console.error("[meta-leads-webhook] inline ingest failed:", e instanceof Error ? e.message : String(e))
    }
  }
  return NextResponse.json({ received: events.length, stored })
}
