import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Set a company's Secretary-of-State ANNUAL REPORT due date, computed FROM THE
 * FORMATION DATE. Idempotent — only fills a blank.
 *
 * IMPORTANT (Antonio 2026-05-28):
 *  - The Annual Report renews the company at the SECRETARY OF STATE. It is tied
 *    to FORMATION (Articles of Organization received), NOT to the EIN. The EIN
 *    (IRS) is unrelated. So this is set when the company is FORMED, never at EIN.
 *  - The due date is derived from the FORMATION DATE — not from "now":
 *      FL → following May 1   (formation year + 1, 05-01)
 *      DE → following June 1  (formation year + 1, 06-01)
 *      WY → anniversary month (formation year + 1, formation month, 01)
 *      NM (and others) → no annual report.
 *  - CMRA is the LEASE, NOT the annual report — handled at lease creation, not here.
 *
 * Returns human-readable side-effect notes for the caller's audit log.
 */
export async function applyStateAnnualReportDate(accountId: string): Promise<string[]> {
  const notes: string[] = []
  try {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("annual_report_due_date, state_of_formation, formation_date")
      .eq("id", accountId)
      .single()
    if (!acct) return notes
    if (acct.annual_report_due_date) {
      return notes // already set — preserve
    }
    if (!acct.formation_date) {
      notes.push("Annual-report date skipped: no formation_date yet")
      return notes
    }

    const formationYear = parseInt(String(acct.formation_date).slice(0, 4), 10)
    const formationMonth = String(acct.formation_date).slice(5, 7) // MM
    if (!Number.isFinite(formationYear)) {
      notes.push(`Annual-report date skipped: unparseable formation_date ${acct.formation_date}`)
      return notes
    }
    const nextYear = formationYear + 1

    const st = (acct.state_of_formation || "")
      .toUpperCase()
      .replace("NEW MEXICO", "NM")
      .replace("WYOMING", "WY")
      .replace("FLORIDA", "FL")
      .replace("DELAWARE", "DE")

    let due: string | null = null
    if (st === "FL") due = `${nextYear}-05-01`
    else if (st === "DE") due = `${nextYear}-06-01`
    else if (st === "WY") due = `${nextYear}-${formationMonth}-01`
    // NM and any other state: no annual report → leave blank.

    if (!due) return notes

    const { error } = await supabaseAdmin
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      .from("accounts")
      .update({ annual_report_due_date: due, updated_at: new Date().toISOString() } as never)
      .eq("id", accountId)
    if (error) notes.push(`Annual-report date failed: ${error.message}`)
    else notes.push(`Annual-report date set: ${due} (${st || "?"}, from formation ${acct.formation_date})`)
  } catch (e) {
    notes.push(`Annual-report date failed: ${e instanceof Error ? e.message : "unknown"}`)
  }
  return notes
}
