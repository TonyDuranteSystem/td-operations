/**
 * Post-attestation handoff (Slice 9, master plan §3.7).
 *
 * After the client confirms the financials: archive the client-confirmed
 * Excel (P&L + Balance Sheet) to the client's Drive 3.Tax/{year} folder.
 * Fire-and-forget from the attest route; every failure is logged, never
 * surfaced to the client (the attestation itself is already stored).
 *
 * The staff "you need to do the final pass" signal is NOT this handoff's job
 * anymore (dev job 9b7892d6, 2026-08-26): the attest route itself now emits a
 * proper Notification Center card + What's New note right after the
 * confirmation is durably saved, in the request's own awaited path — reliably,
 * regardless of whether this fire-and-forget archive step ever runs. Before
 * this change, this handoff ALSO raised a plain `tasks` row for the same
 * event, which — once the route grew a real notification — became a second,
 * duplicate staff signal for one event (AI architect finding). Removed here,
 * not deduped, since the new signal already carries the "do the final pass,
 * then send to the accountant" instruction.
 *
 * Re-ingestion safety (W3): the archived Excel is NOT a statement and the
 * raw CSVs already live in Supabase storage with content-hash sources — even
 * if a staff folder scan picks the archive up, deterministic transaction_refs
 * collide harmlessly with the dedup index.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

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

  // 2. Record the archive outcome (audit trail only — no task here anymore,
  // see the header comment). The outcome detail is genuinely useful to staff
  // (e.g. "archiving failed, regenerate before the final pass"), so it isn't
  // discarded — it goes to action_log instead of a second staff task.
  try {
    const detail = {
      archived: `Confirmed Excel archived in Drive 3.Tax/${taxYear}.`,
      nothing_to_archive: `No transactions for ${taxYear} — nothing to archive. Confirm this is genuinely a dormant/first year before sending to the accountant.`,
      no_drive_folder: `This account has no Drive folder — the confirmed Excel could not be archived. Create the client's Drive folder, then regenerate the workbook before the final pass.`,
      failed: `ARCHIVING THE EXCEL TO DRIVE FAILED — there is no confirmed workbook in 3.Tax/${taxYear} to send. Regenerate it from the tax financials page before the final pass.`,
    }[outcome]
    await supabaseAdmin.from("action_log").insert({
      actor: "system",
      action_type: "financials_attest_handoff",
      table_name: "tax_return_submissions",
      account_id: accountId,
      summary: `Client-confirmed financials handoff (${taxYear}) — ${companyName}: ${outcome}`,
      details: { tax_year: taxYear, outcome, detail },
    })
  } catch (e) {
    console.error("[attest-handoff] action_log write failed:", e)
  }
}
