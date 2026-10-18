/**
 * Fax — where the copy of an UPLOADED file goes after a successful send (Stop Drive S1d, dev job 264bb882).
 *
 * `/api/tools/fax/send` used to keep a bucket-only copy (documents row with no company, no contact, hidden, untyped) of every
 * uploaded file — 144 such rows on production, 116 of them "…Signed_for_IRS" tax returns. The copy now goes into the COMPANY's
 * storage (Tax › year, type "IRS Fax", hidden from the client), listed against the company, when the company is known:
 *   1. the caller named it (`account_id`), or
 *   2. the fax belongs to a flow (`service_delivery_id` → its company), or
 *   3. exactly ONE company's full name appears in the file name (whole name, case-insensitive, 8+ letters — never a partial
 *      or wildcard match; two candidates = nobody is guessed).
 * Anything else, and a company that has no storage, keeps the old bucket copy (the fax history still opens it).
 */

export interface SentUploadInput {
  accountId: string | null
  serviceDeliveryId: string | null
  fileName: string
  bytes: Buffer
  mimeType: string
  actor: string | null
  /** stable per file content: a second send of the same file is a new VERSION, never a second copy */
  callerKey: string
}

export type SentUploadResult =
  | { route: "store"; accountId: string; documentRowId: string; inferred: boolean }
  | { route: "none"; reason: "no_company" | "company_has_no_storage" }

export interface SentUploadDeps {
  accountOfDelivery: (sdId: string) => Promise<string | null>
  accounts: () => Promise<Array<{ id: string; company_name: string | null }>>
  save: (i: {
    accountId: string; name: string; bytes: Buffer; mimeType: string | null; folder: "tax"; documentType: string; callerKey: string
    portalVisible: false; periodYear: number | null; actor: string | null; row: Record<string, unknown>
  }) => Promise<{ route: string; documentRowId?: string }>
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** The one company whose whole name appears in the file name, or null (none / several). */
export function companyNamedInFile(fileName: string, accounts: Array<{ id: string; company_name: string | null }>): string | null {
  const f = ` ${norm(fileName)} `
  const hits = new Set<string>()
  for (const a of accounts) {
    const n = a.company_name ? norm(a.company_name) : ""
    if (n.replace(/ /g, "").length < 8) continue
    if (f.includes(` ${n} `)) hits.add(a.id)
  }
  return hits.size === 1 ? Array.from(hits)[0] : null
}

export function periodYearFromName(fileName: string): number | null {
  const m = /(?:^|[^0-9])(20[12][0-9])(?:[^0-9]|$)/.exec(fileName)
  return m ? Number(m[1]) : null
}

async function defaultDeps(): Promise<SentUploadDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    accountOfDelivery: async (sdId) => {
      const { data } = await supabaseAdmin.from("service_deliveries").select("account_id").eq("id", sdId).maybeSingle()
      return (data?.account_id as string | null | undefined) ?? null
    },
    accounts: async () => {
      const { data, error } = await supabaseAdmin.from("accounts").select("id, company_name")
      if (error) throw new Error(`fax: could not read the companies — ${error.message}`)
      return (data ?? []) as Array<{ id: string; company_name: string | null }>
    },
    save: async (i) => (await import("@/lib/crm-store/save-for-account")).saveDocumentForAccount(i) as Promise<{ route: string; documentRowId?: string }>,
  }
}

export async function fileSentUpload(input: SentUploadInput, deps?: SentUploadDeps): Promise<SentUploadResult> {
  const d = deps ?? (await defaultDeps())
  let accountId = input.accountId
  let inferred = false
  if (!accountId && input.serviceDeliveryId) accountId = await d.accountOfDelivery(input.serviceDeliveryId)
  if (!accountId) {
    accountId = companyNamedInFile(input.fileName, await d.accounts())
    inferred = !!accountId
  }
  if (!accountId) return { route: "none", reason: "no_company" }
  const routed = await d.save({
    accountId, name: input.fileName, bytes: input.bytes, mimeType: input.mimeType, folder: "tax", documentType: "irs_fax",
    callerKey: input.callerKey, portalVisible: false, periodYear: periodYearFromName(input.fileName), actor: input.actor,
    row: { document_type_name: "IRS Fax", category: 3, status: "classified" },
  })
  if (routed.route !== "store" || !routed.documentRowId) return { route: "none", reason: "company_has_no_storage" }
  return { route: "store", accountId, documentRowId: routed.documentRowId, inferred }
}
