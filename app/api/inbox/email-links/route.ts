import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"

export const dynamic = "force-dynamic"

// email_links is not in the generated Database types yet (regenerated from
// production after the prod DDL). Same escape hatch as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function requireStaff() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return null
  return user
}

/**
 * Email → client links ("Link to client" in the inbox).
 *
 * GET  ?thread_id=…&mailbox=…  → links for one thread (link dialog)
 * GET  ?account_id=… | ?contact_id=… → links for one client (email views)
 * POST { gmailThreadId, mailbox?, accountId?, contactId?, subject?, sender? }
 * DELETE { id }
 */
export async function GET(req: NextRequest) {
  const user = await requireStaff()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  const threadId = req.nextUrl.searchParams.get("thread_id")
  const accountId = req.nextUrl.searchParams.get("account_id")
  const contactId = req.nextUrl.searchParams.get("contact_id")

  let query = db
    .from("email_links")
    .select("id, thread_id, mailbox, account_id, contact_id, lead_id, partner_id, subject, sender, linked_by, created_at, account:accounts(company_name), contact:contacts(full_name), lead:leads(full_name), partner:client_partners(partner_name)")
    .order("created_at", { ascending: false })

  if (threadId) {
    const mailbox = req.nextUrl.searchParams.get("mailbox") === "antonio" ? "antonio" : "support"
    query = query.eq("thread_id", threadId).eq("mailbox", mailbox)
  } else if (accountId) {
    query = query.eq("account_id", accountId)
  } else if (contactId) {
    query = query.eq("contact_id", contactId)
  } else {
    return NextResponse.json(
      { error: "thread_id, account_id or contact_id is required" },
      { status: 400 }
    )
  }

  const { data, error } = await query.limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ links: data ?? [] })
}

export async function POST(req: NextRequest) {
  const user = await requireStaff()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  let body: {
    gmailThreadId?: string
    mailbox?: string
    accountId?: string
    contactId?: string
    leadId?: string
    partnerId?: string
    subject?: string
    sender?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const gmailThreadId = body.gmailThreadId?.trim()
  const hasTarget = !!(body.accountId || body.contactId || body.leadId || body.partnerId)
  if (!gmailThreadId || !hasTarget) {
    return NextResponse.json(
      { error: "gmailThreadId and one of accountId/contactId/leadId/partnerId are required" },
      { status: 400 }
    )
  }
  // Linking an antonio@ thread exposes its existence — admin-only, like every
  // other inbox surface.
  if (!(await checkMailboxAccess(body.mailbox))) {
    return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
  }

  const mailbox = body.mailbox === "antonio" ? "antonio" : "support"

  // ONE link per thread (uq_email_links_thread): linking again REPLACES the
  // target — same upsert target the create-from-email dialog uses. Exactly
  // one role column is set per link.
  const { data, error } = await db
    .from("email_links")
    .upsert(
      {
        thread_id: gmailThreadId,
        mailbox,
        account_id: body.accountId ?? null,
        contact_id: body.contactId ?? null,
        lead_id: body.leadId ?? null,
        partner_id: body.partnerId ?? null,
        subject: body.subject?.slice(0, 500) ?? null,
        sender: body.sender?.slice(0, 300) ?? null,
        linked_by: user.email ?? null,
      },
      { onConflict: "thread_id" }
    )
    .select("id")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}

export async function DELETE(req: NextRequest) {
  const user = await requireStaff()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 403 })

  let body: { id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 })

  const { error } = await db.from("email_links").delete().eq("id", body.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
