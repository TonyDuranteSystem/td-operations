import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { notifyClientOfAdminMessage } from "@/lib/portal/notifications"
import { buildFormUrl } from "@/lib/forms/smart-url"

export const dynamic = "force-dynamic"

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

/**
 * POST /api/contacts/[id]/update-request
 *
 * Sends an "update your info" form to the contact via portal chat.
 * The form is pre-populated with the contact's current info.
 * On submit, the contact record is updated.
 *
 * Body (optional): { account_id } — to scope the portal chat message to a specific account context.
 *                  Defaults to the contact's first linked account.
 *
 * Idempotent: reuses pending update_existing request for this contact if one exists.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const contactId = params.id

  const { data: contact, error: contactErr } = await supabaseAdmin
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // Determine account context for portal chat (chat messages are scoped per account)
  let accountId: string | null = null
  try {
    const body = await req.json().catch(() => ({}))
    if (body && typeof body === "object" && body.account_id) {
      accountId = body.account_id as string
    }
  } catch {
    // body is optional
  }

  if (!accountId) {
    const { data: link } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", contactId)
      .limit(1)
      .maybeSingle()
    accountId = link?.account_id ?? null
  }

  if (!accountId) {
    return NextResponse.json(
      { error: "Contact is not linked to any account — cannot send via portal chat." },
      { status: 400 }
    )
  }

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("company_name")
    .eq("id", accountId)
    .single()

  const isItalian = contact.language === "it" || contact.language === "Italian"

  // Idempotent: reuse pending update request for this contact
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
  const { data: existing } = await (supabaseAdmin as any)
    .from("contact_request_forms")
    .select("id, token, access_code")
    .eq("target_contact_id", contactId)
    .eq("form_type", "update_existing")
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
    // Pre-populate with current contact data
    const prePopulatedData = {
      full_name: contact.full_name ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      address_line1: contact.address_line1 ?? "",
      address_city: contact.address_city ?? "",
      address_state: contact.address_state ?? "",
      address_zip: contact.address_zip ?? "",
      address_country: contact.address_country ?? "",
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
    const { data: created, error: createErr } = await (supabaseAdmin as any)
      .from("contact_request_forms")
      .insert({
        account_id: accountId,
        recipient_contact_id: contactId,
        target_contact_id: contactId,
        form_type: "update_existing",
        status: "pending",
        pre_populated_data: prePopulatedData,
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
    contactId,
    token,
    accessCode,
    publicPath: "contact-request",
  })
  const adminPreviewUrl = `${APP_BASE_URL}/contact-request/${token}/${accessCode}?preview=td`

  const chatMessage = isItalian
    ? `Ciao! Per favore conferma o aggiorna i tuoi dati di contatto compilando questo breve modulo:\n\n${formUrl}`
    : `Hi! Please confirm or update your contact information by filling out this short form:\n\n${formUrl}`

  const { error: chatErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      account_id: accountId,
      contact_id: contactId,
      sender_type: "admin",
      sender_id: ADMIN_SENDER_ID,
      message: chatMessage,
    })

  if (chatErr) {
    console.error("[update-request] portal chat insert failed:", chatErr.message)
  }

  if (!chatErr) {
    notifyClientOfAdminMessage({
      account_id: accountId,
      contact_id: contactId,
      messagePreview: isItalian
        ? `Aggiorna le tue informazioni di contatto${account ? ` — ${account.company_name}` : ""}`
        : `Update your contact information${account ? ` — ${account.company_name}` : ""}`,
    }).catch(err => console.error("[update-request] notify failed:", err))
  }

  return NextResponse.json({ form_url: formUrl, admin_preview_url: adminPreviewUrl, is_existing: isExisting })
}
