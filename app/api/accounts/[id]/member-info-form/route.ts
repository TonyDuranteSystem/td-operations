import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { notifyClientOfAdminMessage } from "@/lib/portal/notifications"

export const dynamic = "force-dynamic"

/**
 * POST /api/accounts/[id]/member-info-form
 *
 * Creates (or retrieves existing) member info request form for an MMLLC account,
 * then sends the link via portal chat to the primary contact.
 *
 * Idempotent: if a pending request already exists, reuses it and sends a new chat message.
 *
 * Returns: { form_url, admin_preview_url, is_existing }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const accountId = params.id

  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, entity_type")
    .eq("id", accountId)
    .single()

  if (accErr || !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 })
  }

  // Check for existing pending request (idempotent)
  const { data: existing } = await supabaseAdmin
    .from("member_info_requests")
    .select("id, token, access_code, status")
    .eq("account_id", accountId)
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
    // Pre-populate from existing members table
    const { data: members } = await supabaseAdmin
      .from("members")
      .select(
        "member_type, full_name, company_name, ein, email, phone, ownership_pct, is_primary, " +
        "address_street, address_city, address_state, address_zip, address_country, " +
        "representative_name, representative_email, representative_phone, " +
        "representative_address_street, representative_address_city, " +
        "representative_address_state, representative_address_zip, representative_address_country"
      )
      .eq("account_id", accountId)
      .order("is_primary", { ascending: false })

    const prePopulatedData = members?.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? { members: (members as any[]).map(m => ({ ...m, ownership_pct: m.ownership_pct ? String(m.ownership_pct) : "" })) }
      : null

    const { data: primaryMember } = await supabaseAdmin
      .from("members")
      .select("contact_id")
      .eq("account_id", accountId)
      .eq("is_primary", true)
      .maybeSingle()

    const { data: created, error: createErr } = await supabaseAdmin
      .from("member_info_requests")
      .insert({
        account_id: accountId,
        contact_id: primaryMember?.contact_id ?? null,
        status: "pending",
        company_name: account.company_name,
        entity_type: account.entity_type ?? "Multi Member LLC",
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

  const formUrl = `${APP_BASE_URL}/member-info/${token}/${accessCode}`
  const adminPreviewUrl = `${formUrl}?preview=td`

  // Resolve primary contact for language-aware message + email notification
  const { data: primaryContact } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, contacts(language)")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .maybeSingle()

  const contactId = primaryContact?.contact_id ?? null
  const contactRow = primaryContact?.contacts as { language?: string | null } | null
  const isItalian = (contactRow?.language ?? "en") === "it"

  const chatMessage = isItalian
    ? `Ciao! Abbiamo bisogno di aggiornare le informazioni dei soci di **${account.company_name}**.\n\nPer favore compila questo breve modulo con i dati aggiornati di tutti i soci:\n\n${formUrl}`
    : `Hi! We need to update the member information for **${account.company_name}**.\n\nPlease fill out this short form with the updated details for all members:\n\n${formUrl}`

  const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

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
    console.error("[member-info-form] portal chat insert failed:", chatErr.message)
  }

  if (!chatErr && contactId) {
    notifyClientOfAdminMessage({
      account_id: accountId,
      contact_id: contactId,
      messagePreview: isItalian
        ? `Aggiorna le informazioni dei soci di ${account.company_name}`
        : `Update member information for ${account.company_name}`,
    }).catch(err => console.error("[member-info-form] notify failed:", err))
  }

  return NextResponse.json({ form_url: formUrl, admin_preview_url: adminPreviewUrl, is_existing: isExisting })
}
