import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * GET /api/client-threads?contact_id=… | account_id=… | lead_id=…
 * Lists the client_threads tagged to ONE entity (no rollup), newest first, for the
 * collapsible Conversations panel on the contact/account/lead pages. Staff-only.
 * client_threads is RLS deny-all, so reads go through the service role after an
 * explicit staff auth check.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const accountId = req.nextUrl.searchParams.get("account_id")
  const contactId = req.nextUrl.searchParams.get("contact_id")
  const leadId = req.nextUrl.searchParams.get("lead_id")
  if (!accountId && !contactId && !leadId) {
    return NextResponse.json({ error: "Provide account_id, contact_id, or lead_id" }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let q = db
    .from("client_threads")
    .select("id, topic_slug, source, source_ref, status, source_kind, created_at")
    .order("created_at", { ascending: false })
    .limit(100)
  if (accountId) q = q.eq("account_id", accountId)
  if (contactId) q = q.eq("contact_id", contactId)
  if (leadId) q = q.eq("lead_id", leadId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const threads = (data ?? []).map((r: any) => {
    let slackLink: string | null = null
    if (r.source === "slack" && typeof r.source_ref === "string" && r.source_ref.includes(":")) {
      const [ch, ts] = r.source_ref.split(":")
      if (ch && ts) slackLink = `https://slack.com/archives/${ch}/p${ts.replace(".", "")}`
    }
    return {
      id: r.id,
      topic_slug: r.topic_slug,
      source: r.source,
      status: r.status,
      source_kind: r.source_kind,
      created_at: r.created_at,
      slackLink,
    }
  })

  return NextResponse.json({ threads })
}
