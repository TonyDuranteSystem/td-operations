/**
 * POST /api/portal/chat/topic/create
 *
 * Opens a new topic in a portal-chat thread by posting a bilingual starter
 * admin message tagged with the given topic name. From this point onward
 * the topic appears as a tab (topics are derived from portal_messages.topic).
 *
 * The catalog row for each topic template (catalog_id='topic_templates')
 * fires an api_call to this endpoint via the dispatcher in
 * app/(dashboard)/portal-chats/page.tsx (Slice 7).
 *
 * Body:
 *   topic_name: string                — value stored in portal_messages.topic
 *   account_id: string | null         — one of account_id / contact_id required
 *   contact_id: string | null
 *   starter_message_en: string        — used when client language is en/null/unknown
 *   starter_message_it: string | null — used when client language is it
 *
 * Language resolution:
 *   - Account-level threads: read contacts.language for the account's primary
 *     contact (account_contacts.is_primary=true) if available; else 'en'.
 *   - Contact-level threads: read contacts.language directly; else 'en'.
 *
 * Auth: dashboard users only.
 * Response: { topic_name, message_id } on success; { error } on failure.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { isContactLinkedToAccount } from "@/lib/portal/admin-send-scope"

interface CreateTopicBody {
  topic_name?: unknown
  account_id?: unknown
  contact_id?: unknown
  starter_message_en?: unknown
  starter_message_it?: unknown
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  let body: CreateTopicBody
  try {
    body = (await request.json()) as CreateTopicBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // ── Validate inputs ────────────────────────────────────────────────────
  const topicName = typeof body.topic_name === "string" ? body.topic_name.trim() : ""
  if (!topicName) {
    return NextResponse.json({ error: "topic_name is required" }, { status: 400 })
  }
  if (topicName.length > 100) {
    return NextResponse.json({ error: "topic_name must be 100 characters or fewer" }, { status: 400 })
  }

  const accountId =
    typeof body.account_id === "string" && body.account_id.length > 0 ? body.account_id : null
  const contactId =
    typeof body.contact_id === "string" && body.contact_id.length > 0 ? body.contact_id : null

  if (!accountId && !contactId) {
    return NextResponse.json(
      { error: "One of account_id or contact_id is required" },
      { status: 400 },
    )
  }

  // Send-scope invariant (2026-08-07 leak, dev job 4bad3094): a starter tagged
  // with BOTH a person and a company must have the person actually in that
  // company, or the topic thread lands in another client's company view.
  if (accountId && contactId) {
    const linked = await isContactLinkedToAccount(accountId, contactId)
    if (!linked) {
      return NextResponse.json(
        { error: "The contact is not a member of that account — the topic would open in the wrong company's thread." },
        { status: 400 },
      )
    }
  }

  const starterEn =
    typeof body.starter_message_en === "string" ? body.starter_message_en.trim() : ""
  if (!starterEn) {
    return NextResponse.json({ error: "starter_message_en is required" }, { status: 400 })
  }

  const starterIt =
    typeof body.starter_message_it === "string" ? body.starter_message_it.trim() : null

  // ── Resolve primary contact for account-level threads ─────────────────
  // Mirrors app/api/portal/chat/route.ts:181-191 — for account-level threads
  // the message must carry the primary contact_id so it surfaces in the
  // client's contact-scoped thread on their side.
  let resolvedContactId: string | null = contactId
  if (!resolvedContactId && accountId) {
    const { data: primary } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", accountId)
      .eq("is_primary", true)
      .maybeSingle()
    resolvedContactId = primary?.contact_id || null
  }

  // ── Resolve client language ────────────────────────────────────────────
  // Falls back to 'en' on any failure (network, missing row, missing column).
  let language: string = "en"
  try {
    if (resolvedContactId) {
      const { data: c } = await supabaseAdmin
        .from("contacts")
        .select("language")
        .eq("id", resolvedContactId)
        .maybeSingle()
      if (c?.language) language = c.language
    }
  } catch (err) {
    console.warn(`[topic/create] language resolution failed (using en):`, err)
  }

  const messageText = language === "it" && starterIt ? starterIt : starterEn

  // ── Insert the starter admin message ───────────────────────────────────
  // Schema mirrors app/api/portal/chat/route.ts:210-222:
  //   sender_id NOT NULL → user.id
  //   sender_type NOT NULL → 'admin'
  //   attachments NOT NULL → []
  //   topic carries the template name; from now on the topic tab exists
  //   (topics are derived from portal_messages.topic — no separate table).
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: accountId,
      contact_id: resolvedContactId,
      sender_type: "admin",
      sender_id: user.id,
      // sender_context is constrained to ('person' | 'company' | NULL). For
      // auto-generated topic starter messages we leave it NULL (the admin is
      // posting on behalf of the team, not specifically as person or company).
      sender_context: null,
      topic: topicName,
      message: messageText,
      attachment_url: null,
      attachment_name: null,
      attachments: [],
      reply_to_id: null,
    })
    .select("id")
    .single()

  if (insertError) {
    return NextResponse.json(
      { error: `Failed to create topic: ${insertError.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    topic_name: topicName,
    message_id: inserted.id,
    language,
  })
}
