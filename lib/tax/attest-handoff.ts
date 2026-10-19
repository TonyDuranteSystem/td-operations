/**
 * Post-attestation handoff (Slice 9, master plan §3.7).
 *
 * After the client confirms the financials: archive the client-confirmed
 * Excel (P&L + Balance Sheet) to the company storage, 3. Tax › {year}.
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
 * not deduped, since the new signal already carries the "do the final pass"
 * instruction.
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
    .select("company_name")
    .eq("id", accountId)
    .single()
  // Never put the account UUID in the filename: a uuid segment like "…-2025-…"
  // reads as a year to a file-name year check. It is also meaningless to
  // a human reading the folder.
  const companyName = acct?.company_name?.trim() || "Company"
  // What actually happened to the archive — the staff task must not claim a file
  // that isn't there, and must not cry "failed" when nothing failed (Council
  // 2026-07-17). The year-folder lookup adds a throw path the flat-root create
  // never had, and it is caught below.
  type ArchiveOutcome = "archived" | "nothing_to_archive" | "no_storage" | "failed"
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
  //    stale same-named twin — where a later step could pick the
  //    WRONG YEAR'S or a superseded P&L. Now: the
  //    year subfolder is the target, and the upsert REPLACES the year's file in
  //    place so exactly one client-confirmed workbook exists per year.
  try {
    // The confirmed workbook is kept in the company's storage (3. Tax › <year>); a company with no storage is reported
    // below as "no_storage" (audit log), never skipped quietly.
    const { companyDocState } = await import("@/lib/crm-store/switched-drive-guard")
    const inStorage = (await companyDocState(accountId)) !== "drive"
    if (inStorage) {
      const { buildFinancialsWorkbookForAccount } = await import("@/lib/tax/financials-orchestration")
      const result = await buildFinancialsWorkbookForAccount(accountId, taxYear)
      if (!result) {
        // No transactions at all (dormant / first year). Nothing failed — there
        // are simply no books to archive.
        outcome = "nothing_to_archive"
        console.warn(`[attest-handoff] no transactions for account ${accountId} ${taxYear} — Excel not archived`)
      } else {
        const workbookName = `${companyName} - PnL + Balance Sheet ${taxYear} (client-confirmed).xlsx`
        const workbookMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        // the same key on a re-confirm is a new VERSION of the year's one workbook, never a second copy
        const { saveTaxFileForAccount } = await import("@/lib/crm-store/save-form")
        const routed = await saveTaxFileForAccount({
          accountId, year: taxYear, name: workbookName, bytes: Buffer.from(result.buffer), mimeType: workbookMime,
          callerKey: `attest-workbook:${accountId}:${taxYear}`,
        })
        if (routed.route !== "store") throw new Error("This company's storage was not available while the workbook was being saved — nothing was saved.")

        outcome = "archived"
      }
    } else {
      // Nothing failed — the company has no storage to archive into.
      outcome = "no_storage"
      console.warn(`[attest-handoff] account ${accountId} has no storage — Excel not archived`)
    }
  } catch (e) {
    console.error("[attest-handoff] archive failed:", e)
  }

  // 2. Record the archive outcome (audit trail only — no task here anymore,
  // see the header comment). The outcome detail is genuinely useful to staff
  // (e.g. "archiving failed, regenerate before the final pass"), so it isn't
  // discarded — it goes to action_log instead of a second staff task.
  try {
    const detail = {
      archived: `Confirmed Excel archived in the company storage, 3. Tax › ${taxYear}.`,
      nothing_to_archive: `No transactions for ${taxYear} — nothing to archive. Confirm this is genuinely a dormant/first year.`,
      no_storage: `This company has no document storage in the CRM, so the confirmed Excel could not be archived. Regenerate the workbook from the tax financials page before the final pass.`,
      failed: `ARCHIVING THE EXCEL FAILED — there is no confirmed workbook in 3. Tax › ${taxYear} to send. Regenerate it from the tax financials page before the final pass.`,
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
