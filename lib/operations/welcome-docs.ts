/**
 * Welcome package — find the company's EIN letter and Articles of Organization.
 *
 * Looks in the CRM's own document records first (they point at the new storage for a company that has
 * switched, or at Drive for one that has not). Listing the Drive folder is only a fallback for a company whose
 * files are still in Drive — for a company in storage the Drive folder is a backup copy, and reading it would
 * create duplicate records (dev job ad09ea91, audit Part 36).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface WelcomeDocRow {
  drive_file_id: string | null
  file_name: string | null
  document_type_name: string | null
  status: string | null
  created_at: string | null
}

export interface WelcomeDocPick {
  /** What gmail_send / the portal use to open the file (a storage pointer or a Drive id). */
  pointer: string
  fileName: string | null
}

const EIN_TYPES = new Set(["EIN Letter (IRS)", "EIN Confirmation Letter", "EIN Letter"])
const ARTICLES_TYPES = new Set(["Articles of Organization", "Articles of Incorporation"])
// Some companies hold the IRS EIN confirmation only as a fax record (production: "IRS Fax" rows named "EIN confirmation fax …", "147C").
// Used only when no typed EIN letter exists.
const EIN_FAX_TYPE = "IRS Fax"
const EIN_FAX_NAME = /\bein\b|147c/i

function newest(rows: WelcomeDocRow[]): WelcomeDocRow | null {
  let best: WelcomeDocRow | null = null
  for (const r of rows) {
    if (!best || (r.created_at ?? "") > (best.created_at ?? "")) best = r
  }
  return best
}

/** Pure: pick the newest usable EIN letter and Articles from a company's document records. */
export function pickWelcomeDocs(rows: WelcomeDocRow[]): { ein: WelcomeDocPick | null; articles: WelcomeDocPick | null } {
  const usable = rows.filter((r) => r.drive_file_id && r.status !== "archived")
  const toPick = (r: WelcomeDocRow | null): WelcomeDocPick | null => (r ? { pointer: r.drive_file_id as string, fileName: r.file_name } : null)
  const typedEin = newest(usable.filter((r) => r.document_type_name && EIN_TYPES.has(r.document_type_name)))
  const faxEin = typedEin ? null : newest(usable.filter((r) => r.document_type_name === EIN_FAX_TYPE && EIN_FAX_NAME.test(r.file_name ?? "")))
  return {
    ein: toPick(typedEin ?? faxEin),
    articles: toPick(newest(usable.filter((r) => r.document_type_name && ARTICLES_TYPES.has(r.document_type_name)))),
  }
}

export async function findWelcomeDocsFromRecords(accountId: string): Promise<{ ein: WelcomeDocPick | null; articles: WelcomeDocPick | null }> {
  const { data, error } = await supabaseAdmin
    .from("documents")
    .select("drive_file_id, file_name, document_type_name, status, created_at")
    .eq("account_id", accountId)
    .in("document_type_name", Array.from(EIN_TYPES).concat(Array.from(ARTICLES_TYPES), [EIN_FAX_TYPE]))
  if (error) throw new Error(`Could not read the company's document records: ${error.message}`)
  return pickWelcomeDocs((data ?? []) as WelcomeDocRow[])
}
