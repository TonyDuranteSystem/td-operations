/**
 * Fax — where the copy of an UPLOADED file goes after a successful send (Stop Drive S1d, dev job 264bb882).
 *
 * `/api/tools/fax/send` used to keep a bucket-only copy (documents row with no company, no contact, hidden, untyped) of every
 * uploaded file — 144 such rows on production, 116 of them "…Signed_for_IRS" tax returns. When the company is known the copy goes
 * into the COMPANY's storage instead: 3. Tax › <year> (the year only when the file name says it unambiguously — otherwise the
 * Tax folder itself), type "IRS Fax", hidden from the client, listed against the company.
 *
 * The company is:
 *   1. the one the caller named (`account_id`), or
 *   2. the one of the flow (`service_delivery_id`), or
 *   3. exactly ONE company whose WHOLE name is in the file name (8+ letters, never partial) — read from the complete list of
 *      companies, not a capped page. An inferred company is used for the copy only; it is never written to the activity log.
 * A PERSONAL document (passport, ID, W-7/ITIN papers, proof of address …) never goes into a company's storage: it keeps the old
 * bucket copy. Same bytes sent again for the SAME company = the same file ("unchanged"); the key includes the company, so the
 * same PDF faxed for company A and then company B never attaches B to A's document.
 */

export interface SentUploadInput {
  accountId: string | null
  serviceDeliveryId: string | null
  fileName: string
  bytes: Buffer
  mimeType: string
  actor: string | null
  /** sha256 of the bytes; the company id is added to it here */
  contentHash: string
}

export type SentUploadResult =
  | { route: "store"; accountId: string; documentRowId: string; inferred: boolean }
  | { route: "none"; reason: "no_company" | "company_has_no_storage" | "company_moving" | "personal_document" }

export interface SentUploadDeps {
  accountOfDelivery: (sdId: string) => Promise<string | null>
  accounts: () => Promise<Array<{ id: string; company_name: string | null }>>
  save: (i: { accountId: string; name: string; bytes: Buffer; mimeType: string; year: number | null; callerKey: string; actor: string | null }) =>
    Promise<{ route: "store"; documentRowId: string } | { route: "drive" } | { route: "moving" }>
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

const TAX_WORDS = /(return|1120|1065|1040|tax|proforma|extension|7004|8879|k-?1)/i

/** The tax year, only when the file is clearly a tax paper and names exactly ONE plausible year ("SS-4 … 2026" is not a tax year). */
export function periodYearFromName(fileName: string, now: Date = new Date()): number | null {
  if (!TAX_WORDS.test(fileName)) return null
  const years = new Set<number>()
  const re = /(?:^|[^0-9])(20[12][0-9])(?![0-9])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fileName))) years.add(Number(m[1]))
  const max = now.getFullYear() + 1
  const ok = Array.from(years).filter((y) => y >= 2015 && y <= max)
  return ok.length === 1 ? ok[0] : null
}

/** A person's own paper: it must never sit in a company's storage. */
export function looksPersonal(fileName: string): boolean {
  return /(passport|passaporto|id[ _-]?card|identity|driver|licen[cs]e|carta d.identit|\bw-?7\b|\bitin\b|\bssn\b|social security|proof of address|utility bill)/i.test(fileName)
}

const PAGE = 1000

async function defaultDeps(): Promise<SentUploadDeps> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return {
    accountOfDelivery: async (sdId) => {
      const { data, error } = await supabaseAdmin.from("service_deliveries").select("account_id").eq("id", sdId).maybeSingle()
      if (error) throw new Error(`fax: could not read the flow's company — ${error.message}`)
      return (data?.account_id as string | null | undefined) ?? null
    },
    accounts: async () => {
      const all: Array<{ id: string; company_name: string | null }> = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabaseAdmin.from("accounts").select("id, company_name").order("id").range(from, from + PAGE - 1)
        if (error) throw new Error(`fax: could not read the companies — ${error.message}`)
        const rows = (data ?? []) as Array<{ id: string; company_name: string | null }>
        all.push(...rows)
        if (rows.length < PAGE) return all
      }
    },
    save: async (i) => {
      const guard = await import("@/lib/crm-store/switched-drive-guard")
      const state = await guard.companyDocState(i.accountId)
      if (state === "moving") return { route: "moving" }
      if (state === "drive") return { route: "drive" }
      const ownerId = await guard.liveOwnerOfAccount(i.accountId)
      if (!ownerId) throw new Error("This company's files live in the new storage, but its storage could not be found — nothing was saved.")
      const pilot = await import("@/lib/crm-store/formation-pilot")
      const { ensureYearFolder } = await import("@/lib/crm-store/save-form")
      const taxFolder = await pilot.folderOfKind(ownerId, "tax")
      const folderId = i.year ? await ensureYearFolder(taxFolder, String(i.year)) : taxFolder
      const w = await pilot.savePilotFile({
        ownerId, folderKind: "tax", folderId, name: i.name, bytes: i.bytes, mimeType: i.mimeType, documentType: "irs_fax",
        callerKey: i.callerKey, published: false, periodYear: i.year,
        // the store's actor is a user id (uuid); anything else (an e-mail, a label) is not an id and is left out
        actor: i.actor && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.actor) ? i.actor : null,
      })
      try {
        const row = await pilot.upsertStoreDocumentRow(w.fileId, {
          file_name: i.name, mime_type: i.mimeType, file_size: i.bytes.length, account_id: i.accountId, portal_visible: false,
          document_type_name: "IRS Fax", category: 3, status: "classified",
        }, w.status)
        return { route: "store", documentRowId: row.id }
      } catch (e) {
        // the file was saved but could not be listed: do not leave a hidden orphan behind (best effort; the caller alarms and keeps the old copy)
        if (w.status === "created") {
          try { await (await import("@/lib/supabase-admin")).supabaseAdmin.rpc("store_trash_file" as never, { p_file_id: w.fileId, p_actor: null, p_reason: "fax copy could not be listed" } as never) } catch { /* best effort */ }
        }
        throw e
      }
    },
  }
}

export async function fileSentUpload(input: SentUploadInput, deps?: SentUploadDeps): Promise<SentUploadResult> {
  if (looksPersonal(input.fileName)) return { route: "none", reason: "personal_document" }
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
    accountId, name: input.fileName, bytes: input.bytes, mimeType: input.mimeType, year: periodYearFromName(input.fileName),
    callerKey: `fax-upload:${accountId}:${input.contentHash}`, actor: input.actor,
  })
  if (routed.route === "moving") return { route: "none", reason: "company_moving" }
  if (routed.route !== "store") return { route: "none", reason: "company_has_no_storage" }
  return { route: "store", accountId, documentRowId: routed.documentRowId, inferred }
}
