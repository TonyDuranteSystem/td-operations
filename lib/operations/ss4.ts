/**
 * SS-4 (EIN Application) creation — the single, reusable core extracted from the
 * `ss4_create` MCP tool (lib/mcp/tools/ss4.ts) so it can be called from the
 * server (flow Workspace "Generate SS-4" button + the advance-to-"SS-4 Prepared"
 * auto-generate hook) without going through the MCP layer.
 *
 * Returns a STRUCTURED result (never throws on the expected business outcomes)
 * so each caller renders its own UI:
 *   - the MCP tool maps the outcome back to text,
 *   - the API route returns JSON,
 *   - the advance hook logs to auto_triggers.
 *
 * Behaviour is a faithful port of the original inline tool logic — same
 * prerequisites (state_of_formation, a responsible-party contact, a Registered
 * Agent with a county for IRS Line 6), same MMLLC signer-selection rule, same
 * messages — so the MCP tool's output is unchanged.
 */

import { randomBytes } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { formatCountyAndState } from "@/lib/addresses"

export interface CreateSS4Params {
  account_id: string
  /** Responsible-party contact UUID (auto-detected from members/account_contacts if omitted). */
  contact_id?: string
  entity_type?: "SMLLC" | "MMLLC" | "Corporation"
  member_count?: number
  /** Create directly at 'awaiting_signature' (visible in the portal) instead of 'draft'. */
  ready_to_sign?: boolean
}

export type CreateSS4Outcome =
  | "created"
  | "already_exists"
  | "missing_account"
  | "missing_state"
  | "no_contact"
  | "needs_signer_selection"
  | "missing_ra"
  | "missing_county"
  | "error"

export interface CreateSS4Ss4 {
  id: string
  token: string
  access_code: string
  status: string
  company_name: string
  entity_type: string
  member_count: number
  responsible_party_name: string
  state: string
}

export interface CreateSS4Result {
  ok: boolean
  outcome: CreateSS4Outcome
  /** Present on success and on already_exists (existing record's identity). */
  ss4?: CreateSS4Ss4
  /** Admin preview URL — present on success and already_exists. */
  previewUrl?: string
  /** Human-readable detail: the signer-selection list, or the reason a
   *  prerequisite blocked creation. Callers surface this verbatim. */
  message?: string
}

const ENTITY_MAP: Record<string, string> = {
  "SINGLE MEMBER LLC": "SMLLC", "SMLLC": "SMLLC",
  "MULTI-MEMBER LLC": "MMLLC", "MULTI MEMBER LLC": "MMLLC", "MMLLC": "MMLLC",
  "CORPORATION": "Corporation", "CORP": "Corporation", "C-CORP": "Corporation",
}

const STATE_MAP: Record<string, string> = {
  "NEW MEXICO": "NM", "NM": "NM",
  "WYOMING": "WY", "WY": "WY",
  "FLORIDA": "FL", "FL": "FL",
  "DELAWARE": "DE", "DE": "DE",
}

export async function createSS4(params: CreateSS4Params): Promise<CreateSS4Result> {
  // ─── 1. FETCH ACCOUNT ───
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account, error: accErr } = await (supabaseAdmin as any)
    .from("accounts")
    .select("id, company_name, entity_type, state_of_formation, formation_date, ein_number, registered_agent_id, physical_address, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)")
    .eq("id", params.account_id)
    .single()

  if (accErr || !account) {
    return { ok: false, outcome: "missing_account", message: `Account not found: ${accErr?.message || "no data"}` }
  }
  if (!account.state_of_formation) {
    return { ok: false, outcome: "missing_state", message: `Account "${account.company_name}" missing state_of_formation.` }
  }

  // Already exists?
  const { data: existing } = await supabaseAdmin
    .from("ss4_applications")
    .select("id, token, access_code, status, company_name, entity_type, member_count, responsible_party_name, state_of_formation")
    .eq("account_id", params.account_id)
    .maybeSingle()

  if (existing) {
    return {
      ok: false,
      outcome: "already_exists",
      ss4: {
        id: existing.id, token: existing.token, access_code: existing.access_code, status: existing.status,
        company_name: existing.company_name, entity_type: existing.entity_type, member_count: existing.member_count,
        responsible_party_name: existing.responsible_party_name, state: existing.state_of_formation,
      },
      previewUrl: `${APP_BASE_URL}/ss4/${existing.token}/${existing.access_code}?preview=td`,
      message: `SS-4 already exists for ${account.company_name} (token: ${existing.token}, status: ${existing.status}). Use ss4_get to view it.`,
    }
  }

  // ─── 2. ENTITY TYPE ───
  const rawEntity = params.entity_type || (account.entity_type || "").toUpperCase().trim()
  const entityType = ENTITY_MAP[rawEntity] || "SMLLC"

  // ─── 3. STATE ───
  const state = STATE_MAP[(account.state_of_formation || "").toUpperCase().trim()] || account.state_of_formation

  // ─── 4. RESOLVE RESPONSIBLE PARTY CONTACT ───
  let contactId = params.contact_id
  if (!contactId) {
    const { data: membersRows } = await supabaseAdmin
      .from("members")
      .select("id, member_type, full_name, company_name, email, representative_name, representative_email, contact_id, is_primary, is_signer")
      .eq("account_id", params.account_id)
      .order("is_signer", { ascending: false })
      .order("is_primary", { ascending: false })

    if (membersRows && membersRows.length > 0) {
      if (entityType === "MMLLC" && membersRows.length > 1) {
        const signers = membersRows.filter(m => m.is_signer)
        if (signers.length !== 1) {
          const memberList = await Promise.all(membersRows.map(async (m, i) => {
            if (m.member_type === "company") {
              let repContactId = m.contact_id
              if (!repContactId && m.representative_email) {
                const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", m.representative_email).maybeSingle()
                repContactId = repC?.id ?? null
              }
              const repInfo = m.representative_name ? ` (rep: ${m.representative_name})` : ""
              const signerFlag = m.is_signer ? " ✓ signer" : ""
              return `  ${i + 1}. [Company] ${m.company_name || "Unknown"}${repInfo}${signerFlag} — contact_id: ${repContactId || "no contact"}`
            }
            const signerFlag = m.is_signer ? " ✓ signer" : ""
            return `  ${i + 1}. ${m.full_name || "Unknown"}${signerFlag} — contact_id: ${m.contact_id || "no contact"}`
          }))
          const hint = signers.length === 0
            ? `Tip: set is_signer=true on the intended responsible party via the CRM Members card, then re-run to auto-select.`
            : `Warning: ${signers.length} members have is_signer=true. Set exactly one as the signer, then re-run.`
          return {
            ok: false,
            outcome: "needs_signer_selection",
            message: [
              `This is a Multi-Member LLC with ${membersRows.length} members. Please specify which member will sign the SS-4 as the responsible party.`,
              ``,
              `Members:`,
              ...memberList,
              ``,
              hint,
              `Or re-run with the contact_id of the chosen member.`,
            ].join("\n"),
          }
        }
        const signer = signers[0]
        if (signer.member_type === "company") {
          if (!signer.contact_id && signer.representative_email) {
            const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", signer.representative_email).maybeSingle()
            contactId = repC?.id ?? signer.contact_id
          } else {
            contactId = signer.contact_id
          }
        } else {
          contactId = signer.contact_id
        }
      } else {
        const m = membersRows[0]
        if (m.member_type === "company" && m.representative_email) {
          const { data: repC } = await supabaseAdmin.from("contacts").select("id").eq("email", m.representative_email).maybeSingle()
          contactId = repC?.id ?? m.contact_id
        } else {
          contactId = m.contact_id
        }
      }
    } else {
      // Legacy fallback: account_contacts.
      const { data: links } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id, role, contacts(id, full_name, email)")
        .eq("account_id", params.account_id)

      if (!links?.length) {
        return { ok: false, outcome: "no_contact", message: `No contacts linked to account "${account.company_name}". Link a contact first.` }
      }
      if (entityType === "MMLLC" && links.length > 1) {
        const memberList = links.map((l, i) => {
          const c = l.contacts as unknown as { id: string; full_name: string; email: string } | null
          return `  ${i + 1}. ${c?.full_name || "Unknown"} (${(l as unknown as { role: string }).role || "Member"}) — contact_id: ${l.contact_id}`
        }).join("\n")
        return {
          ok: false,
          outcome: "needs_signer_selection",
          message: [
            `This is a Multi-Member LLC with ${links.length} members. Please specify which member will sign the SS-4 as the responsible party.`,
            ``,
            `Members:`,
            memberList,
            ``,
            `Re-run with the contact_id of the chosen member.`,
          ].join("\n"),
        }
      }
      contactId = links[0].contact_id
    }
  }

  if (!contactId) {
    return { ok: false, outcome: "no_contact", message: `Could not resolve responsible party contact for "${account.company_name}". Link a contact or specify contact_id.` }
  }

  const { data: contact, error: ctErr } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, itin_number, phone, language")
    .eq("id", contactId)
    .single()

  if (ctErr || !contact) {
    return { ok: false, outcome: "no_contact", message: `Contact not found: ${ctErr?.message || "no data"}` }
  }

  // ─── 5. MEMBER COUNT ───
  let memberCount = params.member_count
  if (!memberCount) {
    if (entityType === "SMLLC") {
      memberCount = 1
    } else {
      const { count: membersCount } = await supabaseAdmin
        .from("members")
        .select("*", { count: "exact", head: true })
        .eq("account_id", params.account_id)
      let base = membersCount ?? 0
      if (base === 0) {
        const { count: acCount } = await supabaseAdmin
          .from("account_contacts")
          .select("*", { count: "exact", head: true })
          .eq("account_id", params.account_id)
        base = acCount ?? 0
      }
      memberCount = Math.max(base, 2)
    }
  }

  // ─── 6. LINE 6 county_and_state FROM REGISTERED AGENT ───
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raId = (account as any).registered_agent_id as string | null
  if (!raId) {
    return { ok: false, outcome: "missing_ra", message: `No Registered Agent set for ${account.company_name}. Link a Registered Agent in the addresses registry before creating an SS-4.` }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: raAddress } = await (supabaseAdmin as any)
    .from("addresses")
    .select("county, state")
    .eq("id", raId)
    .single()
  if (!raAddress?.county) {
    return { ok: false, outcome: "missing_county", message: `Registered Agent address for ${account.company_name} is missing county. Set the county in the addresses registry, then retry.` }
  }
  const resolvedCountyAndState = formatCountyAndState(raAddress.county, raAddress.state)

  // ─── 7. MAILING ADDRESS ───
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma = (account as any).mailing_address ?? null
  const TD_FALLBACK_STREET = "11125 Park Blvd, Suite 104-153"
  const TD_FALLBACK_CITY_STATE_ZIP = "Seminole, FL 33772"
  let mailingStreet: string
  let mailingCityStateZip: string
  if (ma && (ma.address_line1 || ma.city)) {
    mailingStreet = [ma.address_line1, ma.address_line2].filter(Boolean).join(", ")
    mailingCityStateZip = [ma.city, ma.state, ma.zip].filter(Boolean).join(", ")
  } else if ((account as any).physical_address) {
    const raw = (account as any).physical_address as string
    const commaIdx = raw.indexOf(",")
    if (commaIdx > -1) {
      mailingStreet = raw.slice(0, commaIdx).trim()
      mailingCityStateZip = raw.slice(commaIdx + 1).trim()
    } else {
      mailingStreet = raw
      mailingCityStateZip = ""
    }
  } else {
    mailingStreet = TD_FALLBACK_STREET
    mailingCityStateZip = TD_FALLBACK_CITY_STATE_ZIP
  }

  // ─── 8. TOKEN ───
  const slug = account.company_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
  const token = `ss4-${slug}-${new Date().getFullYear()}`

  // ─── 9. INSERT ───
  const title = entityType === "SMLLC" ? "Owner" : entityType === "MMLLC" ? "Member" : "President"

  const { data: ss4, error: insertErr } = await supabaseAdmin
    .from("ss4_applications")
    .insert({
      token,
      account_id: params.account_id,
      contact_id: contactId,
      company_name: account.company_name,
      entity_type: entityType,
      state_of_formation: state,
      formation_date: account.formation_date || null,
      member_count: memberCount,
      responsible_party_name: contact.full_name,
      responsible_party_itin: contact.itin_number || null,
      responsible_party_phone: contact.phone || null,
      responsible_party_title: title,
      language: "en",
      county_and_state: resolvedCountyAndState,
      mailing_street: mailingStreet,
      mailing_city_state_zip: mailingCityStateZip,
      // Generate the access code explicitly (8 hex chars, matching the existing
      // format) rather than relying on a DB column default — the default is
      // absent in sandbox (schema drift), which left access_code NULL and broke
      // the portal sign URL (/ss4/{token}/{access_code} → "Invalid access code").
      access_code: randomBytes(4).toString("hex"),
      status: params.ready_to_sign ? "awaiting_signature" : "draft",
    })
    .select("id, token, access_code, status")
    .single()

  if (insertErr || !ss4) {
    return { ok: false, outcome: "error", message: `Error creating SS-4: ${insertErr?.message || "insert failed"}` }
  }

  // ─── 10. LOG ───
  await logAction({
    action_type: "create",
    table_name: "ss4_applications",
    record_id: ss4.id,
    account_id: params.account_id,
    summary: `Created SS-4 for ${account.company_name} (${entityType}, ${state})`,
  })

  // ─── 10b. SYNC member_count TO ACCOUNTS (MMLLC only, don't overwrite) ───
  if (memberCount && entityType === "MMLLC") {
    // eslint-disable-next-line no-restricted-syntax
    await supabaseAdmin
      .from("accounts")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ member_count: memberCount } as any)
      .eq("id", params.account_id)
      .is("member_count", null)
  }

  // ─── 11. REGISTER THE UNSIGNED SS-4 AS A FLOW DOCUMENT ───
  // The unsigned SS-4 PDF is rendered live (GET /api/ss4/[token]/pdf), so there's
  // no stored file — the documents row's drive_link points at that route so the
  // workspace document_viewer + portal Documents "View" both open it. Stamped
  // with the active Company Formation SD so it appears in the flow workspace.
  // Non-fatal: a failure here must not undo the SS-4 we just created.
  try {
    const { data: sdRow } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, contact_id")
      .eq("account_id", params.account_id)
      .eq("service_type", "Company Formation")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (sdRow?.id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id not in generated types
      const { data: existingDoc } = await (supabaseAdmin as any)
        .from("documents")
        .select("id")
        .eq("service_delivery_id", sdRow.id)
        .eq("document_type_name", "SS-4")
        .maybeSingle()
      if (!existingDoc) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service_delivery_id
        await (supabaseAdmin as any).from("documents").insert({
          account_id: params.account_id,
          contact_id: contactId,
          service_delivery_id: sdRow.id,
          file_name: `SS-4 - ${account.company_name}.pdf`,
          document_type_name: "SS-4",
          category: 1,
          status: "classified",
          // drive_file_id is NOT NULL on documents — the unsigned SS-4 is rendered
          // live (no stored file), so use a sentinel marker (also keeps the row
          // unique for idempotency). drive_link is RELATIVE so the workspace
          // "View" opens the route on whatever origin it's viewed from (sandbox
          // or prod) rather than a fixed APP_BASE_URL that could point at prod.
          drive_file_id: `ss4-live:${ss4.token}`,
          drive_link: `/api/ss4/${ss4.token}/pdf?code=${ss4.access_code}`,
          // INTERNAL ONLY — the SS-4 (signed or unsigned) carries the responsible
          // party's tax ID and must NEVER reach the client portal (Antonio's rule).
          // The client signs via the Sign-Documents flow (driven by
          // ss4_applications.status), NOT this documents row. Staff still see it in
          // the workspace viewer (service_delivery_id-scoped, not portal-gated).
          portal_visible: false,
          processed_at: new Date().toISOString(),
        })
      }
    }
  } catch {
    /* non-fatal — the SS-4 record already exists; the doc link is best-effort */
  }

  // ─── 12. NOTIFY THE SIGNER (only when created directly signable) ───
  // ready_to_sign=true creates the record at 'awaiting_signature' — the client
  // can sign NOW, so tell them (action-required: chat + immediate email +
  // bell/push). A 'draft' creation stays silent: staff review first and the
  // send-ss4 / ss4_update promotion paths notify at that later transition.
  // Best-effort — a notification failure never fails the creation.
  if (ss4.status === "awaiting_signature") {
    try {
      const { notifySs4ReadyToSign } = await import("@/lib/portal/action-required")
      const { data: sdForNotify } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", params.account_id)
        .eq("service_type", "Company Formation")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      await notifySs4ReadyToSign({ ss4Id: ss4.id, serviceDeliveryId: sdForNotify?.id ?? null })
    } catch (notifyErr) {
      console.error("[createSS4] action-required notification failed:", notifyErr)
    }
  }

  return {
    ok: true,
    outcome: "created",
    ss4: {
      id: ss4.id, token: ss4.token, access_code: ss4.access_code, status: ss4.status,
      company_name: account.company_name, entity_type: entityType, member_count: memberCount,
      responsible_party_name: contact.full_name, state,
    },
    previewUrl: `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?preview=td`,
  }
}
