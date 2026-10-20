import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { connectMeta } from "@/lib/marketing/meta-leads/connect"
import { configuredPageIds, exchangeForLongLived, identityWithKey, listAccountsWithKey } from "@/lib/marketing/meta-leads/graph"
import { saveStoredKey } from "@/lib/marketing/meta-leads/key-store"
import { clearStoredKeyCache } from "@/lib/marketing/meta-leads/key-resolver"
import { leadDb } from "@/lib/marketing/meta-leads/service"

export const dynamic = "force-dynamic"
export const maxDuration = 60
const NO_STORE = { "Cache-Control": "no-store" }

/** A Facebook access key is one long run of letters, digits and a few symbols. Anything else is refused before any Meta call. */
const KEY_SHAPE = /^[A-Za-z0-9_\-|.]{20,1000}$/

/**
 * POST /api/marketing-admin/meta/connect — Antonio's "Connect Meta" button (TD Marketing, dev job 9aec66fa, Slice 1c). Strict admin only.
 * Body (JSON, required content type, which also blocks cross-site form posts): { userKey?: string }. With no key it starts from the one set on
 * Vercel. It makes the Page's own long-lasting key, checks it belongs to the configured Page, and stores it ENCRYPTED. The answer is a plain-
 * English step list; no key is ever returned or logged.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Send the request as JSON." }, { status: 415, headers: NO_STORE })
  }
  const body = await req.json().catch(() => ({})) as { userKey?: unknown }
  let userKey: string | null = null
  if (typeof body.userKey === "string" && body.userKey.trim()) {
    userKey = body.userKey.trim()
    if (!KEY_SHAPE.test(userKey)) return NextResponse.json({ error: "That does not look like a Facebook key. Copy the whole key again, with no spaces or quotes." }, { status: 400, headers: NO_STORE })
  }
  const secret = process.env.META_APP_SECRET ?? null
  const db = leadDb()
  const report = await connectMeta({
    appId: /^\d{5,30}$/.test(process.env.META_APP_ID ?? "") ? (process.env.META_APP_ID as string) : null,
    appSecret: secret,
    pageIds: configuredPageIds(),
    userKey,
    envKey: process.env.META_PAGE_ACCESS_TOKEN || null,
    connectedBy: user.email ?? user.id,
    identity: key => identityWithKey(key),
    exchange: (key, appId, appSecret) => exchangeForLongLived(key, appId, appSecret),
    accounts: key => listAccountsWithKey(key),
    save: i => saveStoredKey(db, secret, i),
  })
  clearStoredKeyCache()
  console.warn(`[meta-leads] connect by ${user.email ?? user.id}: ${report.ok ? "connected " + report.connectedPages.map(p => p.id).join(",") : "failed"}`)
  return NextResponse.json(report, { headers: NO_STORE })
}
