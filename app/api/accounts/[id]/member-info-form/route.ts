import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { notifyClientOfAdminMessage } from "@/lib/portal/notifications"

export const dynamic = "force-dynamic"

/**
 * GET /api/accounts/[id]/member-info-form
 * Returns the latest member info request for this account (if any),
 * plus whether a primary member can be resolved to a contact (so the UI can
 * disable the Send button proactively).
 *
 * Resolution order: members.contact_id → contacts.email match.
 * The "Primary" checkbox on the member row is the only thing the admin needs to set.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const [{ data: request }, { data: primary }] = await Promise.all([
    supabaseAdmin
      .from("member_info_requests")
      .select("id, status, created_at, submitted_at")
      .eq("account_id", params.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("members")
      .select("contact_id, email")
      .eq("account_id", params.id)
      .eq("is_primary", true)
      .maybeSingle(),
  ])

  let hasPrimaryContact = false
  if (primary) {
    if (primary.contact_id) {
      hasPrimaryContact = true
    } else if (primary.email) {
      const { data: contactByEmail } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("email", primary.email)
        .limit(1)
        .maybeSingle()
      hasPrimaryContact = !!contactByEmail
    }
  }

  return NextResponse.json({ request: request ?? null, has_primary_contact: hasPrimaryContact })
}

/**
 * POST /api/accounts/[id]/member-info-form
 *
 * Creates (or retrieves existing) member info request form for an MMLLC account,
 * then sends the link via portal chat to the primary member's contact.
 *
 * Resolution order for contact: members.contact_id → contacts.email match.
 * The "Primary" checkbox on the member row is the only thing the admin needs to set.
 *
 * Idempotent: if a pending request already exists, reuses it and sends a new message.
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

  // Resolve primary member. The "Primary" checkbox sets members.is_primary — that's all the admin needs.
  // contact_id on the member row is optional; we fall back to email lookup if it's not set.
  const { data: primaryMember } = await supabaseAdmin
    .from("members")
    .select("contact_id, email")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .maybeSingle()

  if (!primaryMember) {
    return NextResponse.json(
      { error: "No primary member set. Check the 'Primary' checkbox on the member you want to receive the form." },
      { status: 400 }
    )
  }

  // Resolve contact_id: direct link first, then email fallback
  let contactId: string | null = primaryMember.contact_id ?? null

  if (!contactId && primaryMember.email) {
    const { data: contactByEmail } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("email", primaryMember.email)
      .limit(1)
      .maybeSingle()
    contactId = contactByEmail?.id ?? null
  }

  if (!contactId) {
    return NextResponse.json(
      { error: "Primary member has no contact record in the system. Add them as a contact first." },
      { status: 400 }
    )
  }

  // Fetch contact language for bilingual message
  const { data: contactData } = await supabaseAdmin
    .from("contacts")
    .select("language")
    .eq("id", contactId)
    .maybeSingle()

  const lang = contactData?.language ?? "en"
  const isItalian = lang === "it" || lang === "Italian"

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

    const { data: created, error: createErr } = await supabaseAdmin
      .from("member_info_requests")
      .insert({
        account_id: accountId,
        contact_id: contactId,
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

  if (!chatErr) {
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
