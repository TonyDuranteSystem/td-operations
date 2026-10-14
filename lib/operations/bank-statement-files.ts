/**
 * bank_statement_process without a named file — find a company's statements from the CRM's own document
 * records (they point at the new storage for a company that has switched). Scanning the Drive "3. Tax"
 * folder is only for a company still in Drive: for a company in storage that folder is a backup copy
 * and would be re-read as duplicates (dev job ad09ea91, audit Part 36).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface StatementRecord {
  drive_file_id: string | null
  file_name: string | null
  mime_type: string | null
  document_type_name: string | null
  tax_year: number | null
  status: string | null
}

export interface StatementFile {
  id: string
  name: string
  mimeType: string
}

export interface StatementPick {
  files: StatementFile[]
  /** Statements with no year that were left out because their name does not carry the year — staff can name them with file_id. */
  undated: number
}

const SUPPORTED = /\.(csv|pdf|zip)$/i

/** Pure: choose this year's statement records. A record with no year is taken only when its file name carries the year. */
export function pickStatementRecords(rows: StatementRecord[], taxYear: number): StatementPick {
  const files: StatementFile[] = []
  let undated = 0
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r.drive_file_id || r.status === "archived" || r.document_type_name !== "Bank Statement") continue
    const name = r.file_name ?? r.drive_file_id
    if (!SUPPORTED.test(name) && r.mime_type !== "application/pdf" && r.mime_type !== "text/csv") continue
    if (r.tax_year != null && r.tax_year !== taxYear) continue
    if (r.tax_year == null && !name.includes(String(taxYear))) {
      undated++
      continue
    }
    if (seen.has(r.drive_file_id)) continue
    seen.add(r.drive_file_id)
    files.push({ id: r.drive_file_id, name, mimeType: r.mime_type ?? "application/octet-stream" })
  }
  return { files, undated }
}

export async function findStatementRecords(accountId: string, taxYear: number): Promise<StatementPick> {
  const { data, error } = await supabaseAdmin
    .from("documents")
    .select("drive_file_id, file_name, mime_type, document_type_name, tax_year, status")
    .eq("account_id", accountId)
    .eq("document_type_name", "Bank Statement")
  if (error) throw new Error(`Could not read the company's document records: ${error.message}`)
  return pickStatementRecords((data ?? []) as StatementRecord[], taxYear)
}
