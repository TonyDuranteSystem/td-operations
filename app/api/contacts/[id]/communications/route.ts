/**
 * GET /api/contacts/:id/communications
 *
 * Returns portal chat messages for a contact — both contact-direct messages
 * (no account) and messages under linked accounts. Deduplicates by message ID.
 * Also returns unread count and notification history.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const contactId = params.id

    // Verify contact exists
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email")
      .eq("id", contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    // Get linked account IDs
    const { data: accountContacts } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, accounts(company_name)")
      .eq("contact_id", contactId)

    const linkedAccounts = (accountContacts ?? []).map(ac => ({
      id: ac.account_id,
      company_name: (ac.accounts as unknown as { company_name: string })?.company_name ?? "Unknown",
    }))
    const accountIds = linkedAccounts.map(a => a.id)

    // Fetch portal messages: contact-direct + account-linked
    const queries = []

    // 1. Contact-direct messages (no account)
    queries.push(
      supabaseAdmin
        .from("portal_messages")
        .select("id, account_id, contact_id, sender_type, sender_id, message, attachment_url, attachment_name, read_at, reply_to_id, created_at")
        .eq("contact_id", contactId)
        .is("account_id", null)
        .order("created_at", { ascending: false })
        .limit(100)
    )

    // 2. Account-linked messages
    if (accountIds.length > 0) {
      queries.push(
        supabaseAdmin
          .from("portal_messages")
          .select("id, account_id, contact_id, sender_type, sender_id, message, attachment_url, attachment_name, read_at, reply_to_id, created_at")
          .in("account_id", accountIds)
          .order("created_at", { ascending: false })
          .limit(100)
      )
    }

    // 3. Notification history
    const notifQuery = supabaseAdmin
      .from("portal_notifications")
      .select("id, account_id, contact_id, type, title, body, link, read_at, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50)

    const results = await Promise.all([...queries, notifQuery])

    // Merge and deduplicate messages by ID
    const messagesMap = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < results.length - 1; i++) {
      const data = results[i].data ?? []
      for (const msg of data) {
        const m = msg as Record<string, unknown>
        if (!messagesMap.has(m.id as string)) {
          // Tag with source (personal vs company name)
          const accountId = m.account_id as string | null
          const linkedAcc = accountId ? linkedAccounts.find(a => a.id === accountId) : null
          messagesMap.set(m.id as string, {
            ...m,
            source: linkedAcc ? linkedAcc.company_name : "Personal",
          })
        }
      }
    }

    // Sort by created_at ascending (oldest first for chat display)
    const messages = Array.from(messagesMap.values())
      .sort((a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime())

    // Unread count (client messages not read by admin)
    const unreadCount = messages.filter(
      m => m.sender_type === "client" && !m.read_at
    ).length

    // Notifications
    const notifications = (results[results.length - 1].data ?? []) as Array<{
      id: string; account_id: string | null; contact_id: string; type: string
      title: string; body: string | null; link: string | null; read_at: string | null; created_at: string
    }>

    return NextResponse.json({
      messages,
      unreadCount,
      notifications,
      contactName: contact.full_name,
      linkedAccounts,
    })
  } catch (e) {
    console.error("[contact-communications] Error:", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
