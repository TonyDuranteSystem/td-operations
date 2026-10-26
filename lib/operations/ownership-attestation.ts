/**
 * Attestation of Beneficial Ownership — CRM-driven generation.
 *
 * One generic page any bank can accept: who owns 25% or more of the company.
 * Everything comes from the company's records, never typed by hand:
 * - owners and their percentages → the account's Members section
 * - date of birth and nationality → each owner's contact record
 * - company name / address / state → the account
 *
 * It REFUSES (with a message naming what to fix) rather than guess: no owners on
 * file, a percentage missing, percentages that do not add up to 100, an owner
 * with no birth date or nationality, or an interest held through another company
 * (that chart has to be drawn by hand).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { plainStoreError } from "@/lib/crm-store/lock-errors"
import { isMultiMemberEntity } from "@/lib/portal/entity-type"
import { generateOwnershipAttestationPDF, type OwnershipAttestationInput } from "@/lib/pdf/ownership-attestation-pdf"

export interface AttestationAccount {
  id: string
  company_name: string | null
  state_of_formation: string | null
  physical_address: string | null
  communication_email: string | null
}

export interface AttestationMember {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  ownership_pct: number | null
  is_primary: boolean | null
  is_signer: boolean | null
  email: string | null
  contact_id: string | null
}

export interface AttestationContact {
  id: string
  full_name: string | null
  email: string | null
  date_of_birth: string | null
  citizenship: string | null
}

/** Threshold from the bank's own wording: "25% or more". */
export const UBO_THRESHOLD_PCT = 25

const NATIONALITY: Record<string, string> = {
  italy: "Italian", italian: "Italian", portugal: "Portuguese", spain: "Spanish", france: "French", germany: "German",
  "united kingdom": "British", uk: "British", "united states": "American", usa: "American", "united states of america": "American",
  pakistan: "Pakistani", india: "Indian", brazil: "Brazilian", canada: "Canadian", mexico: "Mexican", argentina: "Argentine",
  colombia: "Colombian", romania: "Romanian", poland: "Polish", ukraine: "Ukrainian", russia: "Russian", turkey: "Turkish",
  greece: "Greek", ireland: "Irish", netherlands: "Dutch", belgium: "Belgian", switzerland: "Swiss", austria: "Austrian",
  sweden: "Swedish", norway: "Norwegian", denmark: "Danish", albania: "Albanian", morocco: "Moroccan", egypt: "Egyptian",
  china: "Chinese", japan: "Japanese", israel: "Israeli", malta: "Maltese", bulgaria: "Bulgarian", croatia: "Croatian",
}

/** "Italy" → "Italian" for the page; an unknown country is printed as given, never guessed. */
export function nationalityLabel(citizenship: string): string {
  const raw = citizenship.trim()
  return NATIONALITY[raw.toLowerCase()] ?? raw
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** "1994-05-14" → "May 14, 1994" (no time-zone shift); anything unparseable returns null. */
export function formatLongDate(iso: string | null | undefined): string | null {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return `${MONTHS[month - 1]} ${Number(m[3])}, ${m[1]}`
}

export interface AssembleAttestationParams {
  account: AttestationAccount
  members: AttestationMember[]
  contacts: AttestationContact[]
  /** ISO date for the letter. */
  effectiveDate: string
}

export interface AttestationSigner {
  contactId: string | null
  name: string
  email: string | null
}

/** What exactly is missing about an owner — lets a screen name it plainly instead of a vague "incomplete". */
export interface AttestationGap {
  code: "owner_dob" | "owner_citizenship" | "owner_contact"
  /** the owner's name */
  who: string
}

export type AssembleAttestationResult =
  | { input: OwnershipAttestationInput; signer: AttestationSigner; error?: undefined; gap?: undefined }
  | { input?: undefined; signer?: undefined; error: string; gap?: AttestationGap }

export function assembleOwnershipAttestation(params: AssembleAttestationParams): AssembleAttestationResult {
  const { account, members, contacts, effectiveDate } = params
  const name = account.company_name
  if (!name) return { error: "The company has no name on file." }
  if (!account.state_of_formation) return { error: `"${name}" is missing its state of formation in the CRM.` }
  if (!account.physical_address) return { error: `"${name}" is missing its address in the CRM.` }
  if (members.length === 0) {
    return { error: `"${name}" has no owners in its Members section. Add the owner(s) with their ownership percentage first.` }
  }

  const individuals = members.filter(m => m.member_type === "individual")
  const companies = members.filter(m => m.member_type !== "individual")

  // A single owner with no percentage written down owns all of it.
  const soleOwnerImplied = individuals.length === 1 && companies.length === 0
  const pctOf = (m: AttestationMember): number | null => {
    const v = m.ownership_pct == null ? null : Number(m.ownership_pct)
    if (v != null && v > 0) return v
    return soleOwnerImplied ? 100 : null
  }

  for (const c of companies) {
    const p = c.ownership_pct == null ? null : Number(c.ownership_pct)
    if (p == null || p >= UBO_THRESHOLD_PCT) {
      return { error: `"${name}" is partly owned through a company (${c.company_name ?? "unnamed"}). The people behind that company must be shown in the chart, so this attestation has to be prepared by hand.` }
    }
  }
  for (const m of individuals) {
    if (pctOf(m) == null) {
      return { error: `The ownership percentage of ${m.full_name ?? "a member"} is missing in the Members section. Fill it in first.` }
    }
  }

  const total =
    individuals.reduce((s, m) => s + (pctOf(m) ?? 0), 0) +
    companies.reduce((s, m) => s + Number(m.ownership_pct ?? 0), 0)
  if (Math.abs(total - 100) > 0.01) {
    return { error: `The ownership percentages of "${name}" add up to ${Math.round(total * 100) / 100}%, not 100%. Fix the Members section first.` }
  }

  const ubos = individuals.filter(m => (pctOf(m) ?? 0) >= UBO_THRESHOLD_PCT)
  if (ubos.length === 0) {
    return { error: `No individual holds ${UBO_THRESHOLD_PCT}% or more of "${name}" — the "no natural person" version of the attestation is needed, and that one is prepared by hand.` }
  }

  const contactById = new Map(contacts.map(c => [c.id, c]))
  const owners: OwnershipAttestationInput["owners"] = []
  for (const m of ubos) {
    const c = m.contact_id ? contactById.get(m.contact_id) : undefined
    const fullName = m.full_name ?? c?.full_name ?? null
    if (!fullName) return { error: "An owner has no name on file." }
    if (!c) return { error: `${fullName} is not linked to a contact record, so their date of birth and nationality cannot be read. Link the member to the contact first.`, gap: { code: "owner_contact", who: fullName } }
    const dob = formatLongDate(c.date_of_birth)
    if (!dob) return { error: `${fullName} has no date of birth on their contact record. Fill it in first.`, gap: { code: "owner_dob", who: fullName } }
    if (!c.citizenship?.trim()) return { error: `${fullName} has no citizenship on their contact record. Fill it in first.`, gap: { code: "owner_citizenship", who: fullName } }
    owners.push({ fullName, dateOfBirth: dob, nationality: nationalityLabel(c.citizenship), ownershipPct: pctOf(m) as number })
  }

  const signer = ubos.find(m => m.is_signer) ?? ubos.find(m => m.is_primary) ?? ubos[0]
  const signerContact = signer.contact_id ? contactById.get(signer.contact_id) : undefined
  const sole = individuals.length === 1 && companies.length === 0

  const signerName = signer.full_name ?? signerContact?.full_name ?? owners[0].fullName
  return {
    signer: { contactId: signer.contact_id, name: signerName, email: signerContact?.email || signer.email || null },
    input: {
      companyName: name,
      registeredIn: `${account.state_of_formation}, United States`,
      companyAddress: account.physical_address,
      contactEmail: account.communication_email || signer.email || signerContact?.email || null,
      dateLine: formatLongDate(effectiveDate) ?? effectiveDate,
      owners,
      signerName,
      signerPosition: sole ? "Sole Member / Owner" : "Member",
    },
  }
}

export interface GenerateAttestationResult {
  success?: boolean
  error?: string
  file_name?: string
  drive_file_id?: string
  document_id?: string
  owners?: Array<{ name: string; pct: number }>
}

export async function loadAttestation(accountId: string, effectiveDate: string): Promise<AssembleAttestationResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: account } = await db
    .from("accounts")
    .select("id, company_name, state_of_formation, physical_address, communication_email, entity_type, member_structure")
    .eq("id", accountId)
    .single()
  if (!account) return { error: "Account not found." }

  // The company address the portal's own documents use (the Operating Agreement, tax statement, …): the official address built
  // from the company's suite number, else the saved one. The plain `accounts.physical_address` column is empty for many companies
  // whose address lives in linked address records (Beril LLC) — reading only that column refused them for "no address".
  const { getPortalAccountDetail } = await import("@/lib/portal/queries")
  const detail = await getPortalAccountDetail(accountId)
  if (detail?.physical_address) account.physical_address = detail.physical_address

  const { data: memberRows } = await db
    .from("members")
    .select("id, member_type, full_name, company_name, ownership_pct, is_primary, is_signer, email, contact_id")
    .eq("account_id", accountId)
    .is("end_date", null)
    .order("is_primary", { ascending: false })
  let members = (memberRows ?? []) as AttestationMember[]

  // A Single-Member LLC keeps its one owner as the account's linked contact, not in the Members list.
  if (members.length === 0 && !isMultiMemberEntity(account.entity_type, account.member_structure)) {
    const { data: links } = await db
      .from("account_contacts")
      .select("contact_id, role, contacts(full_name, email)")
      .eq("account_id", accountId)
    const owners = ((links ?? []) as Array<{ contact_id: string; role: string | null; contacts: { full_name: string | null; email: string | null } | null }>)
      .filter(l => (l.role ?? "").toLowerCase() === "owner")
    if (owners.length !== 1) {
      return { error: `"${account.company_name}" is a single-member company but ${owners.length === 0 ? "no linked contact has the Owner role" : "more than one linked contact has the Owner role"}. Fix the company's contacts first.` }
    }
    const o = owners[0]
    members = [{ id: o.contact_id, member_type: "individual", full_name: o.contacts?.full_name ?? null, company_name: null, ownership_pct: null, is_primary: true, is_signer: true, email: o.contacts?.email ?? null, contact_id: o.contact_id }]
  }

  const contactIds = members.map(m => m.contact_id).filter((v): v is string => !!v)
  let contacts: AttestationContact[] = []
  if (contactIds.length > 0) {
    const { data: contactRows } = await db
      .from("contacts")
      .select("id, full_name, email, date_of_birth, citizenship")
      .in("id", contactIds)
    contacts = (contactRows ?? []) as AttestationContact[]
  }

  return assembleOwnershipAttestation({ account: account as AttestationAccount, members, contacts, effectiveDate })
}

export async function generateOwnershipAttestationForAccount(
  accountId: string,
  opts: { effective_date?: string; actor?: string } = {},
): Promise<GenerateAttestationResult> {
  const effectiveDate = opts.effective_date || new Date().toISOString().slice(0, 10)
  const assembled = await loadAttestation(accountId, effectiveDate)
  if (assembled.error) return { error: assembled.error }

  const pdfBytes = await generateOwnershipAttestationPDF(assembled.input)
  const fileName = `Attestation of Beneficial Ownership - ${assembled.input.companyName}.pdf`

  const { saveSignedPdfForAccount } = await import("@/lib/crm-store/save-for-account")
  let routed
  try {
    routed = await saveSignedPdfForAccount({
      accountId, fileName, bytes: Buffer.from(pdfBytes), label: "Attestation of Beneficial Ownership", category: 4,
      // staff send it to the client by hand when needed — nothing becomes visible or notifies by accident
      portalVisible: false,
      // regenerating is a new VERSION of one file, never a second copy
      callerKey: `ownership-attestation:${accountId}`,
    })
  } catch (err) {
    return { error: `Saving to the new storage failed: ${plainStoreError(err)}` }
  }

  if (routed.route === "store") {
    logAction({
      actor: opts.actor ?? "crm-admin",
      action_type: "create",
      table_name: "documents",
      record_id: routed.documentRowId,
      account_id: accountId,
      summary: `Generated Attestation of Beneficial Ownership for ${assembled.input.companyName} (${assembled.input.owners.map(o => `${o.fullName} ${o.ownershipPct}%`).join(", ")}) from CRM data — saved in the new storage, not shown to the client`,
      details: { drive_file_id: routed.pointer, effective_date: effectiveDate, source: "crm-button" },
    })
    return {
      success: true,
      file_name: fileName,
      drive_file_id: routed.pointer,
      document_id: routed.documentRowId,
      owners: assembled.input.owners.map(o => ({ name: o.fullName, pct: o.ownershipPct })),
    }
  }

  // Nothing is ever written to Drive. A company with no storage is an error for the caller plus a staff alarm.
  const { legacyDriveForAccount, raiseDriveWriteRefused } = await import("@/lib/crm-store/legacy-drive")
  const legacy = await legacyDriveForAccount(accountId)
  return { error: await raiseDriveWriteRefused({ flow: "ownership-attestation", accountId, reason: legacy.reason, detail: fileName }) }
}

export interface SendAttestationResult {
  success?: boolean
  error?: string
  envelope_id?: string
  signer_name?: string
  /** how the signer was reached: "portal" (shows in Sign Documents + notified) or "email" (direct signing link) */
  channel?: "portal" | "email"
  owners?: Array<{ name: string; pct: number }>
}

/**
 * Build the attestation and send it to the company's signer to sign in the client portal (Sign Documents).
 * When the signer finishes, the e-sign engine files the signed copy in the company's documents, where the client
 * can see and download it. Nothing is saved as an unsigned copy here. One open request per company at a time.
 */
export async function sendOwnershipAttestationForSignature(
  accountId: string,
  opts: { effective_date?: string; actor?: string; baseUrl: string },
): Promise<SendAttestationResult> {
  const effectiveDate = opts.effective_date || new Date().toISOString().slice(0, 10)
  const assembled = await loadAttestation(accountId, effectiveDate)
  if (assembled.error) return { error: assembled.error }
  const { input, signer } = assembled
  if (!signer.contactId && !signer.email) {
    return { error: `${signer.name} has no linked contact and no email, so there is no way to reach them. Fix that first.` }
  }
  if (!signer.email) {
    return { error: `${signer.name} has no email on their contact record. Add it first so they can be notified.` }
  }

  const documentName = `Attestation of Beneficial Ownership - ${input.companyName}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { isTerminalEnvelopeStatus, TERMINAL_ENVELOPE_STATUSES } = await import("@/lib/esign/envelope-status")
  const { data: open } = await db
    .from("esign_envelopes")
    .select("id, status")
    .eq("owner_account_id", accountId)
    .eq("document_name", documentName)
    .not("status", "in", `(${TERMINAL_ENVELOPE_STATUSES.join(",")})`)
    .limit(1)
  if (open && open.length > 0 && !isTerminalEnvelopeStatus(open[0].status)) {
    return { error: `An attestation for "${input.companyName}" is already waiting for ${signer.name} to sign. Void it in the E-Sign tool first if it must be replaced.` }
  }

  const { buildOwnershipAttestation } = await import("@/lib/pdf/ownership-attestation-pdf")
  const built = await buildOwnershipAttestation(input)

  const { createEsignEnvelope } = await import("@/lib/operations/esign")
  let envelope
  try {
    envelope = await createEsignEnvelope({
      document_name: documentName,
      description: "Confirms who owns 25% or more of the company.",
      pdfBuffer: Buffer.from(built.bytes),
      fileName: `${documentName}.pdf`.replace(/[^A-Za-z0-9 ._-]/g, ""),
      pageCount: 1,
      fields: [{ field_type: "signature", ...built.signature, required: true, signer_index: 0 }],
      signers: [{ name: signer.name, email: signer.email, contact_id: signer.contactId, role_label: input.signerPosition }],
      owner_account_id: accountId,
      contact_id: signer.contactId,
      origin: "staff",
      routing_order: "sequential",
      created_by: opts.actor ?? "crm-admin",
      baseUrl: opts.baseUrl,
    })
  } catch (err) {
    return { error: `Could not create the signing request: ${err instanceof Error ? err.message : String(err)}` }
  }

  const { dispatchSignerDelivery } = await import("@/lib/esign/dispatch-delivery")
  const channel = await dispatchSignerDelivery({ signerId: envelope.signers[0].id, baseUrl: opts.baseUrl, createdBy: opts.actor ?? "crm-admin" })
  if (channel === "none") {
    return { error: `The signing request was created but ${signer.name} could not be reached. Open it in the E-Sign tool to send it by hand.`, envelope_id: envelope.id }
  }
  await db.from("esign_envelopes").update({ status: "sent", updated_at: new Date().toISOString() }).eq("id", envelope.id)

  logAction({
    actor: opts.actor ?? "crm-admin",
    action_type: "create",
    table_name: "esign_envelopes",
    record_id: envelope.id,
    account_id: accountId,
    summary: `Sent Attestation of Beneficial Ownership for ${input.companyName} to ${signer.name} to sign (${channel})`,
    details: { owners: input.owners.map(o => `${o.fullName} ${o.ownershipPct}%`), source: "crm-button" },
  })
  return { success: true, envelope_id: envelope.id, signer_name: signer.name, channel, owners: input.owners.map(o => ({ name: o.fullName, pct: o.ownershipPct })) }
}

/** What the client's own Generate Documents page needs to show and sign the attestation. */
export type ClientAttestation =
  | { kind: "ready"; input: Omit<OwnershipAttestationInput, "dateLine">; signerName: string; youAreSigner: boolean }
  | { kind: "unavailable"; reason: string; gap?: AttestationGap }

/**
 * The same data as the staff button, for the signed-in client's company. `youAreSigner` is true only when the person looking at
 * the screen is the company's signer: the page prints that person's name under the signature line, so nobody else may sign it.
 * `reason` is staff-facing wording (what to fix in the records); the client page shows a plain localized sentence instead.
 */
export async function prepareAttestationForClient(accountId: string, viewerContactId: string | null): Promise<ClientAttestation> {
  const assembled = await loadAttestation(accountId, new Date().toISOString().slice(0, 10))
  if (assembled.error) return { kind: "unavailable", reason: assembled.error, gap: assembled.gap }
  const { dateLine: _unused, ...rest } = assembled.input
  void _unused
  return { kind: "ready", input: rest, signerName: assembled.signer.name, youAreSigner: !!viewerContactId && assembled.signer.contactId === viewerContactId }
}
