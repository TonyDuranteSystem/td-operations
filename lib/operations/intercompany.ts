/**
 * Intercompany Transfer Agreement — CRM-driven generation.
 *
 * Wires lib/pdf/intercompany-agreement-pdf.ts (previously dead code with
 * free-text inputs) to the CRM so that company addresses, EINs and ownership
 * percentages ALWAYS come from CRM records — never typed by hand.
 *
 * Data sources:
 * - Operating company  → accounts row (name, state, EIN, physical_address)
 * - Treasury company   → the account's members row with member_type='company'
 *                        (ownership_pct, and address/EIN when filled), with
 *                        fallback to the treasury company's own accounts row
 *                        (matched by company name) for EIN / address / state.
 * - Manager            → primary individual member, falling back to the
 *                        account's primary contact.
 *
 * Origin: Umberto Moretti incident (2026-07-07) — the manually-produced ICA
 * for Azarexa LLC ↔ Advertising Apex LLC still showed 1% (real: 99%) and a
 * 2023 address after the CRM had been corrected.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  generateIntercompanyAgreementPDF,
  type IntercompanyAgreementInput,
} from "@/lib/pdf/intercompany-agreement-pdf"
import { uploadBinaryToDrive } from "@/lib/google-drive"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { logAction } from "@/lib/mcp/action-log"

// ─── Types ───

export interface IcaAccountData {
  id: string
  company_name: string | null
  state_of_formation: string | null
  ein_number: string | null
  physical_address: string | null
}

export interface IcaMemberRow {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  ownership_pct: number | null
  is_primary: boolean | null
  ein: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
}

export interface AssembleIcaParams {
  operatingAccount: IcaAccountData
  members: IcaMemberRow[]
  /** The treasury company's own accounts row, when one exists (matched by name). */
  treasuryAccount?: IcaAccountData | null
  /** Fallback manager name (account primary contact) when no individual member exists. */
  primaryContactName?: string | null
  effectiveDate: string
  /** Effective date of the operating company's OA, when known. */
  oaEffectiveDate?: string | null
}

export type AssembleIcaResult =
  | { input: IntercompanyAgreementInput; error?: undefined }
  | { input?: undefined; error: string }

// ─── Pure assembly (unit-tested, no DB) ───

function composeAddress(m: IcaMemberRow): string | null {
  const parts = [m.address_street, m.address_city, m.address_state, m.address_zip, m.address_country].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : null
}

export function assembleIntercompanyInput(params: AssembleIcaParams): AssembleIcaResult {
  const { operatingAccount: acc, members, treasuryAccount, primaryContactName, effectiveDate, oaEffectiveDate } = params

  if (!acc.company_name) return { error: "Operating company has no company_name." }
  if (!acc.state_of_formation) return { error: `"${acc.company_name}" is missing state_of_formation in the CRM.` }
  if (!acc.physical_address) return { error: `"${acc.company_name}" is missing physical_address in the CRM.` }

  const companyMembers = members.filter(m => m.member_type === "company")
  if (companyMembers.length === 0) {
    return { error: `"${acc.company_name}" has no company member (treasury/holding) in its Members section. Add the treasury company as a member first.` }
  }
  if (companyMembers.length > 1) {
    const names = companyMembers.map(m => m.company_name ?? "Unknown").join(", ")
    return { error: `"${acc.company_name}" has ${companyMembers.length} company members (${names}) — intercompany generation currently supports exactly one treasury company.` }
  }

  const treasury = companyMembers[0]
  if (!treasury.company_name) return { error: "The company member row has no company_name." }

  const ownershipPct = Number(treasury.ownership_pct)
  if (!ownershipPct || ownershipPct <= 0) {
    return { error: `Ownership percentage for "${treasury.company_name}" is missing on its member row. Fill it in the Members section first.` }
  }

  const treasuryAddress = composeAddress(treasury) ?? treasuryAccount?.physical_address ?? null
  if (!treasuryAddress) {
    return { error: `No address on file for "${treasury.company_name}" — fill the member row's address (or the company's own account physical_address) first.` }
  }

  const treasuryState = treasuryAccount?.state_of_formation ?? null
  if (!treasuryState) {
    return { error: `State of formation for "${treasury.company_name}" not found — the treasury company needs its own CRM account with state_of_formation set.` }
  }

  const managerName =
    members.find(m => m.member_type === "individual" && m.is_primary)?.full_name ??
    members.find(m => m.member_type === "individual")?.full_name ??
    primaryContactName ??
    null
  if (!managerName) return { error: `No manager found — "${acc.company_name}" has no individual member and no primary contact.` }

  return {
    input: {
      operatingCompanyName: acc.company_name,
      operatingCompanyState: acc.state_of_formation,
      operatingCompanyEin: acc.ein_number ?? undefined,
      operatingCompanyAddress: acc.physical_address,
      treasuryCompanyName: treasury.company_name,
      treasuryCompanyState: treasuryState,
      treasuryCompanyEin: treasury.ein ?? treasuryAccount?.ein_number ?? undefined,
      treasuryCompanyAddress: treasuryAddress,
      treasuryOwnershipPct: ownershipPct,
      managerName,
      effectiveDate,
      oaEffectiveDate: oaEffectiveDate ?? undefined,
    },
  }
}

// ─── CRM orchestration ───

export interface GenerateIcaResult {
  success?: boolean
  error?: string
  file_name?: string
  drive_file_id?: string
  document_id?: string
  treasury_company?: string
  ownership_pct?: number
}

export async function generateIntercompanyForAccount(
  accountId: string,
  opts: { effective_date?: string; actor?: string } = {},
): Promise<GenerateIcaResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account } = await (supabaseAdmin as any)
    .from("accounts")
    .select("id, company_name, state_of_formation, ein_number, physical_address, drive_folder_id")
    .eq("id", accountId)
    .single()
  if (!account) return { error: "Account not found." }

  const { data: memberRows } = await supabaseAdmin
    .from("members")
    .select("id, member_type, full_name, company_name, ownership_pct, is_primary, ein, address_street, address_city, address_state, address_zip, address_country")
    .eq("account_id", accountId)
    .order("is_primary", { ascending: false })

  const members = (memberRows ?? []) as IcaMemberRow[]

  // Treasury company's own account (matched by name, case-insensitive) for
  // EIN / address / state fallback.
  const treasuryName = members.find(m => m.member_type === "company")?.company_name ?? null
  let treasuryAccount: IcaAccountData | null = null
  if (treasuryName) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: match } = await (supabaseAdmin as any)
      .from("accounts")
      .select("id, company_name, state_of_formation, ein_number, physical_address")
      .ilike("company_name", treasuryName.trim())
      .limit(1)
      .maybeSingle()
    treasuryAccount = match ?? null
  }

  // Primary contact (manager fallback)
  const { data: contactLink } = await supabaseAdmin
    .from("account_contacts")
    .select("contacts(full_name)")
    .eq("account_id", accountId)
    .limit(1)
    .maybeSingle()
  const primaryContactName = (contactLink?.contacts as { full_name: string | null } | null)?.full_name ?? null

  // OA effective date (reference in the recitals), when an OA exists
  const { data: oaRow } = await supabaseAdmin
    .from("oa_agreements")
    .select("effective_date")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const effectiveDate = opts.effective_date || new Date().toISOString().slice(0, 10)

  const assembled = assembleIntercompanyInput({
    operatingAccount: account as IcaAccountData,
    members,
    treasuryAccount,
    primaryContactName,
    effectiveDate,
    oaEffectiveDate: (oaRow?.effective_date as string | null) ?? null,
  })
  if (assembled.error) return { error: assembled.error }

  const pdfBytes = await generateIntercompanyAgreementPDF(assembled.input)

  if (!account.drive_folder_id) {
    return { error: `"${account.company_name}" has no Drive folder (drive_folder_id) — cannot file the PDF.` }
  }

  const fileName = `Intercompany Transfer Agreement - ${account.company_name} - ${assembled.input.treasuryCompanyName}.pdf`
  let driveFileId: string | undefined
  try {
    const uploaded = await uploadBinaryToDrive(fileName, Buffer.from(pdfBytes), "application/pdf", account.drive_folder_id)
    driveFileId = uploaded?.id
  } catch (err) {
    return { error: `Drive upload failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const docResult = await autoSaveDocument({
    accountId,
    fileName,
    documentType: "Intercompany Transfer Agreement",
    category: 1, // Company
    driveFileId,
    portalVisible: true,
  })
  if (docResult.error) {
    // Drive upload succeeded — surface the partial failure rather than a rollback.
    return { error: `PDF uploaded to Drive (${driveFileId}) but registering the document failed: ${docResult.error}` }
  }

  logAction({
    actor: opts.actor ?? "crm-admin",
    action_type: "create",
    table_name: "documents",
    record_id: docResult.id,
    account_id: accountId,
    summary: `Generated Intercompany Transfer Agreement for ${account.company_name} ↔ ${assembled.input.treasuryCompanyName} (${assembled.input.treasuryOwnershipPct}%) from CRM data`,
    details: { drive_file_id: driveFileId, effective_date: effectiveDate, source: "crm-button" },
  })

  return {
    success: true,
    file_name: fileName,
    drive_file_id: driveFileId,
    document_id: docResult.id,
    treasury_company: assembled.input.treasuryCompanyName,
    ownership_pct: assembled.input.treasuryOwnershipPct,
  }
}
