/**
 * Post-attestation handoff (Slice 9, master plan §3.7).
 *
 * After the client confirms the financials: archive the client-confirmed
 * Excel (P&L + Balance Sheet) to the client's Drive 3.Tax/{year} folder and
 * create the staff final-pass task (plan A4 — staff review before
 * tax_send_to_accountant). Fire-and-forget from the attest route; every
 * failure is logged, never surfaced to the client (the attestation itself is
 * already stored).
 *
 * Re-ingestion safety (W3): the archived Excel is NOT a statement and the
 * raw CSVs already live in Supabase storage with content-hash sources — even
 * if a staff folder scan picks the archive up, deterministic transaction_refs
 * collide harmlessly with the dedup index.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"

export async function runAttestHandoff(accountId: string, taxYear: number): Promise<void> {
  const { data: acct } = await supabaseAdmin
    .from("accounts")
    .select("company_name, drive_folder_id")
    .eq("id", accountId)
    .single()
  // Never put the account UUID in the filename: a uuid segment like "…-2025-…"
  // reads as a year to the accountant file picker, which would then refuse the
  // workbook as ambiguous (lib/tax/pick-tax-file.ts). It is also meaningless to
  // a human reading the folder.
  const companyName = acct?.company_name?.trim() || "Company"
  // What actually happened to the archive — the staff task must not claim a file
  // that isn't there, and must not cry "failed" when nothing failed (Council
  // 2026-07-17). The year-folder lookup adds a throw path the flat-root create
  // never had, and it is caught below.
  type ArchiveOutcome = "archived" | "nothing_to_archive" | "no_drive_folder" | "failed"
  let outcome: ArchiveOutcome = "failed"

  // 1. Archive the confirmed Excel to Drive 3.Tax/{year}.
  //    Built from the SAME engine draft the client attested on screen
  //    (buildFinancialsWorkbookForAccount) — never the legacy transaction-based
  //    generator — so the accountant files exactly the numbers the client saw.
  //
  //    Council 2026-07-17 (blocker): this used to archive into the '3. Tax' ROOT
  //    (findTaxFolder) despite the comments claiming 3.Tax/{year}, and used a
  //    plain create. For a multi-year client that piled every year's workbook
  //    into ONE flat folder under near-identical names, and re-confirming left a
  //    stale same-named twin — from which tax_send_to_accountant could pick the
  //    WRONG YEAR'S or a superseded P&L and email it to the accountant. Now: the
  //    year subfolder is the target, and the upsert REPLACES the year's file in
  //    place so exactly one client-confirmed workbook exists per year.
  try {
    if (acct?.drive_folder_id) {
      const { buildFinancialsWorkbookForAccount } = await import("@/lib/tax/financials-orchestration")
      const { findTaxFolder, findOrCreateYearFolder, uploadBinaryToDriveUpsert } = await import("@/lib/google-drive")
      const result = await buildFinancialsWorkbookForAccount(accountId, taxYear)
      if (!result) {
        // No transactions at all (dormant / first year). Nothing failed — there
        // are simply no books to archive.
        outcome = "nothing_to_archive"
        console.warn(`[attest-handoff] no transactions for account ${accountId} ${taxYear} — Excel not archived`)
      } else {
        const taxFolderId = await findTaxFolder(acct.drive_folder_id)
        // Fall back to the Drive root only when there is no '3. Tax' folder at all.
        const target = taxFolderId
          ? await findOrCreateYearFolder(taxFolderId, taxYear)
          : acct.drive_folder_id
        await uploadBinaryToDriveUpsert(
          `${companyName} - PnL + Balance Sheet ${taxYear} (client-confirmed).xlsx`,
          result.buffer,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          target,
        )
        outcome = "archived"
      }
    } else {
      // Nothing failed — the client has no Drive folder to archive into.
      outcome = "no_drive_folder"
      console.warn(`[attest-handoff] no Drive folder for account ${accountId} — Excel not archived`)
    }
  } catch (e) {
    console.error("[attest-handoff] Drive archive failed:", e)
  }

  // 2. Staff final-pass task (deduped by title, same pattern as back-filing).
  try {
    const taskTitle = `Final pass: client-confirmed financials (${taxYear}) — ${companyName}`
    const { data: existing } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .eq("account_id", accountId)
      .eq("task_title", taskTitle)
      .neq("status", "Done")
      .limit(1)
      .maybeSingle()
    if (!existing) {
      // eslint-disable-next-line no-restricted-syntax -- same legacy plain-task path as the wizard tasks
      await supabaseAdmin.from("tasks").insert({
        task_title: taskTitle,
        assigned_to: defaultTaskAssignee(),
        status: "To Do",
        priority: "High",
        category: "Filing",
        description: {
          archived: `The client confirmed the generated P&L + Balance Sheet for ${taxYear} (attestation on the tax submission, confirmed Excel archived in Drive 3.Tax/${taxYear}). Do the staff final pass, then send to the accountant (tax_send_to_accountant).`,
          nothing_to_archive: `The client confirmed the financials for ${taxYear} (attestation stored), but the company has NO transactions for ${taxYear}, so there is no workbook to archive or send. Check this is genuinely a dormant/first year — if so, the accountant send needs no_pnl_reason. If transactions were expected, the bank statements are missing.`,
          no_drive_folder: `The client confirmed the generated P&L + Balance Sheet for ${taxYear} (attestation stored), but this account has NO Drive folder, so the confirmed Excel could not be archived. Create the client's Drive folder, then regenerate the workbook from the tax financials page before the final pass.`,
          failed: `The client confirmed the generated P&L + Balance Sheet for ${taxYear} (attestation stored), but ARCHIVING THE EXCEL TO DRIVE FAILED — there is no confirmed workbook in 3.Tax/${taxYear} to send. Regenerate it from the tax financials page before the final pass, then send to the accountant (tax_send_to_accountant).`,
        }[outcome],
        account_id: accountId,
        created_by: "System",
      })
    }
  } catch (e) {
    console.error("[attest-handoff] staff task creation failed:", e)
  }
}
