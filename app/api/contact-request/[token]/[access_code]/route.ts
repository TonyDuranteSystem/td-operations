import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { emitClientChatEvent } from "@/lib/portal/chat-events"

export const dynamic = "force-dynamic"

/** Surface a contact-request submission in the staff What's New feed. Fire-and-
 *  forget — a notification failure must never fail the client's submission.
 *  Prefers the account thread when the form is account-linked, else the contact. */
async function notifyContactUpdated(opts: {
  formId: string
  accountId: string | null
  contactId: string | null
  message: string
}) {
  try {
    await emitClientChatEvent({
      account_id: opts.accountId,
      contact_id: opts.accountId ? null : opts.contactId,
      topic: "Contact",
      message: opts.message,
      source: { table: "contact_request_forms", id: opts.formId },
      event_kind: "contact_updated",
    })
  } catch (err) {
    console.error("[contact-request] What's New emit failed (non-fatal):", err)
  }
}

/**
 * GET /api/contact-request/[token]/[access_code]
 * Returns the form metadata + pre-populated data + available roles (for add_new only).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string; access_code: string } }
) {
  const { token, access_code } = params

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
  const { data: form, error } = await (supabaseAdmin as any)
    .from("contact_request_forms")
    .select("id, account_id, recipient_contact_id, target_contact_id, form_type, status, pre_populated_data")
    .eq("token", token)
    .eq("access_code", access_code)
    .maybeSingle()

  if (error || !form) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 })
  }

  // Fetch account name for context
  let companyName: string | null = null
  if (form.account_id) {
    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("company_name")
      .eq("id", form.account_id)
      .maybeSingle()
    companyName = account?.company_name ?? null
  }

  // For add_new, fetch role options from the catalog
  let roles: { slug: string; display_name: string; display_name_translations: Record<string, string> }[] = []
  if (form.form_type === "add_new") {
    const { data: roleEntries } = await supabaseAdmin
      .from("catalog_entries")
      .select("slug, display_name, display_name_translations")
      .eq("catalog_id", "contact_roles")
      .eq("status", "active")
      .order("display_name")
    roles = (roleEntries ?? []) as typeof roles
  }

  return NextResponse.json({ form, company_name: companyName, roles })
}

/**
 * POST /api/contact-request/[token]/[access_code]
 * Submits the form. Behavior depends on form_type:
 *   add_new        → creates a new contact, links to account with chosen role
 *   update_existing → updates the target contact's record
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string; access_code: string } }
) {
  const { token, access_code } = params

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_request_forms types not yet generated
  const { data: form, error: formErr } = await (supabaseAdmin as any)
    .from("contact_request_forms")
    .select("id, account_id, recipient_contact_id, target_contact_id, form_type, status")
    .eq("token", token)
    .eq("access_code", access_code)
    .maybeSingle()

  if (formErr || !form) {
    return NextResponse.json({ error: "Invalid or expired link." }, { status: 404 })
  }

  if (form.status === "submitted") {
    return NextResponse.json({ error: "This form has already been submitted." }, { status: 409 })
  }

  if (form.status === "cancelled") {
    return NextResponse.json({ error: "This form has been cancelled." }, { status: 410 })
  }

  const body = await req.json()
  const now = new Date().toISOString()

  // Common fields collected by both form types
  const fullName = String(body.full_name ?? "").trim()
  const email = String(body.email ?? "").trim()
  const phone = String(body.phone ?? "").trim() || null
  const addressLine1 = String(body.address_line1 ?? "").trim() || null
  const addressCity = String(body.address_city ?? "").trim() || null
  const addressState = String(body.address_state ?? "").trim() || null
  const addressZip = String(body.address_zip ?? "").trim() || null
  const addressCountry = String(body.address_country ?? "").trim() || null

  if (!fullName) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 })
  }
  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 })
  }

  if (form.form_type === "add_new") {
    if (!form.account_id) {
      return NextResponse.json({ error: "Form has no account linkage." }, { status: 400 })
    }

    const role = String(body.role ?? "").trim()
    if (!role) {
      return NextResponse.json({ error: "Role is required." }, { status: 400 })
    }

    // Validate role is in the catalog
    const { data: roleEntry } = await supabaseAdmin
      .from("catalog_entries")
      .select("slug, display_name")
      .eq("catalog_id", "contact_roles")
      .eq("slug", role)
      .eq("status", "active")
      .maybeSingle()

    if (!roleEntry) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 })
    }

    // Find or create contact by email
    const { data: existingContact } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("email", email)
      .limit(1)
      .maybeSingle()

    let contactId: string

    if (existingContact) {
      contactId = existingContact.id
    } else {
      // eslint-disable-next-line no-restricted-syntax -- public form contact creation; validated input
      const { data: created, error: createErr } = await supabaseAdmin
        .from("contacts")
        .insert({
          full_name: fullName,
          email,
          phone,
          address_line1: addressLine1,
          address_city: addressCity,
          address_state: addressState,
          address_zip: addressZip,
          address_country: addressCountry,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single()

      if (createErr || !created) {
        return NextResponse.json({ error: createErr?.message ?? "Failed to create contact." }, { status: 500 })
      }
      contactId = created.id
    }

    // Link contact to account with chosen role (display_name preserved as-is)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabaseAdmin.from("account_contacts").upsert(
      { account_id: form.account_id, contact_id: contactId, role: roleEntry.display_name } as any,
      { onConflict: "account_id,contact_id" },
    )

    await markSubmitted(form.id, body, now)

    await supabaseAdmin.from("action_log").insert({
      action_type: "contact_added_via_request_form",
      table_name: "contacts",
      record_id: contactId,
      account_id: form.account_id,
      summary: `New contact added via request form: ${fullName} (${roleEntry.display_name})`,
      details: { form_id: form.id, role_slug: role },
    })

    await notifyContactUpdated({
      formId: form.id,
      accountId: form.account_id ?? null,
      contactId,
      message: `The client added a new contact via the form: ${fullName} (${roleEntry.display_name}).`,
    })

    return NextResponse.json({ success: true, contact_id: contactId })
  }

  // form_type === 'update_existing'
  if (!form.target_contact_id) {
    return NextResponse.json({ error: "Form has no target contact." }, { status: 400 })
  }

  /* eslint-disable no-restricted-syntax -- public form update; only the contact whose token this is can update */
  const { error: updateErr } = await supabaseAdmin
    .from("contacts")
    .update({
      full_name: fullName,
      email,
      phone,
      address_line1: addressLine1,
      address_city: addressCity,
      address_state: addressState,
      address_zip: addressZip,
      address_country: addressCountry,
      updated_at: now,
    })
    .eq("id", form.target_contact_id)
  /* eslint-enable no-restricted-syntax */

  if (updateErr) {
    return NextResponse.json({ error: `Failed to update contact: ${updateErr.message}` }, { status: 500 })
  }

  await markSubmitted(form.id, body, now)

  await supabaseAdmin.from("action_log").insert({
    action_type: "contact_updated_via_request_form",
    table_name: "contacts",
    record_id: form.target_contact_id,
    account_id: form.account_id,
    summary: `Contact updated via self-service form: ${fullName}`,
    details: { form_id: form.id },
  })

  await notifyContactUpdated({
    formId: form.id,
    accountId: form.account_id ?? null,
    contactId: form.target_contact_id,
    message: `${fullName} updated their contact details via the self-service form.`,
  })

  return NextResponse.json({ success: true, contact_id: form.target_contact_id })
}

async function markSubmitted(formId: string, submittedData: unknown, now: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("contact_request_forms")
    .update({ status: "submitted", submitted_data: submittedData, submitted_at: now, updated_at: now })
    .eq("id", formId)
}
