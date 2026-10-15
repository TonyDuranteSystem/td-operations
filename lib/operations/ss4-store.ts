/**
 * The unsigned SS-4 as a FILE in the company's storage (Antonio 2026-10-15: "SS-4 stored in 1. Company at creation, then the
 * signed copy as well once it is signed"). Until now the unsigned SS-4 was only a live-rendered link (`ss4-live:` record) and
 * nothing was stored until the client signed. Now, for a company whose files live in the new storage:
 *   · created  → "Form SS-4 - <company> - Unsigned.pdf" is saved in 1. Company (staff only, never shown to the client);
 *   · refreshed → the same file gets a NEW VERSION when the SS-4 changed (same key), "unchanged" when it did not;
 *   · signed   → the signed copies are saved as before (app/api/ss4-signed) next to it.
 * A company still on Drive is left exactly as it was. Best-effort: never throws, never undoes the SS-4 — a failure is logged
 * and raised as a store alarm.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"
import { CLIENT_ADDRESS_FALLBACK } from "@/lib/td-address"

/** The columns of an ss4_applications row that fill the form (shared by the live PDF route and the stored copy — one place). */
export interface Ss4Row {
  company_name: string
  trade_name?: string | null
  entity_type: string
  state_of_formation: string
  formation_date?: string | null
  member_count: number
  responsible_party_name: string
  responsible_party_itin?: string | null
  responsible_party_phone?: string | null
  responsible_party_title: string
  mailing_street?: string | null
  mailing_city_state_zip?: string | null
  county_and_state?: string | null
}

export function ss4FillDataFromRow(ss4: Ss4Row): SS4FillData {
  return {
    companyName: ss4.company_name,
    tradeName: ss4.trade_name || undefined,
    entityType: ss4.entity_type as SS4FillData["entityType"],
    stateOfFormation: ss4.state_of_formation,
    formationDate: ss4.formation_date || "",
    memberCount: ss4.member_count,
    responsiblePartyName: ss4.responsible_party_name,
    responsiblePartyItin: ss4.responsible_party_itin || undefined,
    responsiblePartyPhone: ss4.responsible_party_phone || undefined,
    responsiblePartyTitle: ss4.responsible_party_title,
    // Mailing address — fall back to the TD address for legacy rows without a stored one
    mailingStreet: ss4.mailing_street || CLIENT_ADDRESS_FALLBACK.street,
    mailingCityStateZip: ss4.mailing_city_state_zip || CLIENT_ADDRESS_FALLBACK.cityStateZip,
    countyAndState: ss4.county_and_state || undefined,
  }
}

/** Pure: the stored file's name and its stable key (one file per application; a change is a new version of it). */
export function unsignedSs4Names(companyName: string, ss4Id: string): { fileName: string; callerKey: string } {
  return { fileName: `Form SS-4 - ${companyName} - Unsigned.pdf`, callerKey: `ss4-unsigned:${ss4Id}` }
}

export interface StoreUnsignedResult { stored: boolean; reason: string }

export async function storeUnsignedSs4(accountId: string, source: string): Promise<StoreUnsignedResult> {
  try {
    // the application that is still being worked on (a signed one is saved by the signing route)
    const { data: row } = await supabaseAdmin.from("ss4_applications").select("*").eq("account_id", accountId)
      .in("status", ["draft", "awaiting_signature"]).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (!row) return { stored: false, reason: "no unsigned SS-4" }
    const { data: sd } = await supabaseAdmin.from("service_deliveries").select("id").eq("account_id", accountId)
      .eq("service_type", "Company Formation").eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle()
    const bytes = Buffer.from(await fillSS4(ss4FillDataFromRow(row as unknown as Ss4Row)))
    const { fileName, callerKey } = unsignedSs4Names(row.company_name, row.id)
    const { saveSignedPdfForAccount } = await import("@/lib/crm-store/save-for-account")
    const routed = await saveSignedPdfForAccount({
      accountId, fileName, bytes, label: "Form SS-4 (Unsigned)", category: 1, callerKey,
      // INTERNAL: the SS-4 carries the responsible party's tax ID — never shown to the client
      portalVisible: false, documentType: "form_ss_4", serviceDeliveryId: sd?.id ?? null,
    })
    if (routed.route !== "store") return { stored: false, reason: "company is on Drive" }
    return { stored: true, reason: routed.status }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[ss4-store] unsigned SS-4 was not saved to the storage (${source}):`, message)
    try {
      const { raisePilotAlarm } = await import("@/lib/crm-store/formation-pilot")
      await raisePilotAlarm("store_save_failed", { what: "unsigned SS-4", accountId, source, error: message })
    } catch { /* the console line above stays */ }
    return { stored: false, reason: message }
  }
}
