import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { notifyClientOfAdminMessage } from "@/lib/portal/notifications"
import { buildFormUrl, buildAdminPreviewUrl } from "@/lib/forms/smart-url"

export const dynamic = "force-dynamic"

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

/**
 * POST /api/accounts/[id]/contact-request
 *
 * Sends an "add new contact" form to the account's primary contact via portal chat.
 * The recipient fills in: first/last name, email, phone, address, role.
 * On submit, a new contact is created with the chosen role and linked to the account.
 *
 * Idempotent: reuses pending request if one exists for this account.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const accountId = params.id

  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name")
    .eq("id", accountId)
    .single()

  if (accErr || !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 })
  }

  // Resolve recipient: the account's owner contact.
  // Try account_contacts.role ilike 'owner' first; fall back to first linked contact.
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role")
    .eq("account_id", accountId)

  if (!links || links.length === 0) {
    return NextResponse.json(
      { error: "No contacts linked to this account. Add a contact first." },
      { status: 400 }
    )
  }

  const ownerLink = links.find(l => (l.role || "").toLowerCase() === "owner") ?? links[0]
  const recipientContactId = ownerLink.contact_id

  // Fetch recipient contact for language
  const { data: recipientContact } = await supabaseAdmin
    .from("contacts")
    .select("language")
    .eq("id", recipientContactId)
    .maybeSingle()

  const isItalian = recipientContact?.language === "it" || recipientContact?.language === "Italian"

  // Idempotent: reuse existing pending add_new request for this account
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
  const { data: existing } = await (supabaseAdmin as any)
    .from("contact_request_forms")
    .select("id, token, access_code")
    .eq("account_id", accountId)
    .eq("form_type", "add_new")
    .eq("status", "pending")
    .maybeSingle()

  let token: string
  let accessCode: string
  let isExisting = false

  if (existing) {
    token = existing.token
    accessCode = existing.access_code
    isExisting = true
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
    const { data: created, error: createErr } = await (supabaseAdmin as any)
      .from("contact_request_forms")
      .insert({
        account_id: accountId,
        recipient_contact_id: recipientContactId,
        target_contact_id: null,
        form_type: "add_new",
        status: "pending",
      })
      .select("id, token, access_code")
      .single()

    if (createErr || !created) {
      return NextResponse.json(
        { error: createErr?.message ?? "Failed to create form" },
        { status: 500 }
      )
    }

    token = created.token
    accessCode = created.access_code
  }

  const formUrl = await buildFormUrl({
    contactId: recipientContactId,
    token,
    accessCode,
    formType: "contact_request",
  })
  const adminPreviewUrl = buildAdminPreviewUrl('contact_request', token, accessCode)

  const chatMessage = isItalian
    ? `Ciao! Per favore aggiungi una nuova persona di contatto per **${account.company_name}** compilando questo modulo:\n\n${formUrl}`
    : `Hi! Please add a new contact person for **${account.company_name}** by filling out this short form:\n\n${formUrl}`

  const { error: chatErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: accountId,
      contact_id: recipientContactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: chatMessage,
    })

  if (chatErr) {
    console.error("[contact-request] portal chat insert failed:", chatErr.message)
  }

  if (!chatErr) {
    notifyClientOfAdminMessage({
      account_id: accountId,
      contact_id: recipientContactId,
      messagePreview: isItalian
        ? `Aggiungi un nuovo contatto per ${account.company_name}`
        : `Add a new contact for ${account.company_name}`,
    }).catch(err => console.error("[contact-request] notify failed:", err))
  }

  return NextResponse.json({ form_url: formUrl, admin_preview_url: adminPreviewUrl, is_existing: isExisting })
}
