import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { subscribePages } from "@/lib/marketing/meta-leads/connection"
import { configuredPageIds, subscribePageToLeads } from "@/lib/marketing/meta-leads/graph"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/meta/subscribe — Antonio's one-time "send us this Page's new leads" button (TD Marketing, dev job 9aec66fa).
 * Admin only (the strict check). It installs OUR app on each configured Page (Meta: POST /{page}/subscribed_apps, subscribed_fields=leadgen).
 * Safe to repeat. The reverse is a DELETE on the same address, done by hand in Meta if ever needed.
 */
export async function POST() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const pages = configuredPageIds()
  if (pages.length === 0) return NextResponse.json({ error: "No Page ids are configured on the server yet (set the Page ids on Vercel first)." }, { status: 400, headers: NO_STORE })
  const results = await subscribePages(pages, id => subscribePageToLeads(id))
  console.warn(`[meta-leads] subscribe by ${user.email ?? user.id}: ${results.map(r => `${r.pageId}=${r.ok ? "ok" : "failed"}`).join(", ")}`)
  return NextResponse.json({ results }, { headers: NO_STORE })
}
