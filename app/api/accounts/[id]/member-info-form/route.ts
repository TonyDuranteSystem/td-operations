import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getOrCreateMemberInfoRequest, resolveMemberInfoContact } from "@/lib/members/member-info-request"
import { notifyClientOfAdminMessage } from "@/lib/portal/notifications"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/**
 * GET /api/accounts/[id]/member-info-form
 * Returns the latest member info request for this account (if any),
 * plus whether a contact can be resolved to send it to (so the UI can
 * disable the Send button proactively).
 *
 * Uses the SAME resolution POST/getOrCreateMemberInfoRequest uses (resolved
 * signer → Primary member → any linked contact) — dev job 9ad76300-6181-4250-a1de-c77f37933f82, second
 * pass. This used to be its own is_primary-ONLY check with no fallback, so
 * an account fixable via the client's own button (Generate Documents
 * screen) still showed a disabled Send button here for staff.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const [{ data: request }, contactId] = await Promise.all([
    supabaseAdmin
      .from("member_info_requests")
      .select("id, status, created_at, submitted_at")
      .eq("account_id", params.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    resolveMemberInfoContact(params.id),
  ])

  return NextResponse.json({ request: request ?? null, has_primary_contact: !!contactId })
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
  const denied = await requireStaffRoute()
  if (denied) return denied

  const accountId = params.id

  const result = await getOrCreateMemberInfoRequest(accountId)
  if (result.outcome === "error") {
    return NextResponse.json({ error: result.message }, { status: result.message === "Account not found" ? 404 : 400 })
  }
  // Same contact the helper resolved the request to — no re-derivation, so
  // this can never disagree with what was actually created (dev job
  // 9ad76300-6181-4250-a1de-c77f37933f82, second pass).
  const { formUrl, adminPreviewUrl, isExisting, companyName, contactId } = result

  const { data: contactData } = await supabaseAdmin
    .from("contacts")
    .select("language")
    .eq("id", contactId)
    .maybeSingle()

  const lang = contactData?.language ?? "en"
  const isItalian = lang === "it" || lang === "Italian"

  const chatMessage = isItalian
    ? `Ciao! Abbiamo bisogno di aggiornare le informazioni dei soci di **${companyName}**.\n\nPer favore compila questo breve modulo con i dati aggiornati di tutti i soci:\n\n${formUrl}`
    : `Hi! We need to update the member information for **${companyName}**.\n\nPlease fill out this short form with the updated details for all members:\n\n${formUrl}`

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
        ? `Aggiorna le informazioni dei soci di ${companyName}`
        : `Update member information for ${companyName}`,
    }).catch(err => console.error("[member-info-form] notify failed:", err))
  }

  return NextResponse.json({ form_url: formUrl, admin_preview_url: adminPreviewUrl, is_existing: isExisting })
}
