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
  const companyName = acct?.company_name ?? accountId

  // 1. Archive the confirmed Excel to Drive 3.Tax/{year}.
  try {
    if (acct?.drive_folder_id) {
      const { generatePnlExcel } = await import("@/lib/pnl-generator")
      const { findTaxFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
      const result = await generatePnlExcel(accountId, taxYear)
      const taxFolderId = await findTaxFolder(acct.drive_folder_id)
      const target = taxFolderId ?? acct.drive_folder_id
      await uploadBinaryToDrive(
        `${companyName} - PnL + Balance Sheet ${taxYear} (client-confirmed).xlsx`,
        result.buffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        target,
      )
    } else {
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
        description: `The client confirmed the generated P&L + Balance Sheet for ${taxYear} (attestation on the tax submission, confirmed Excel archived in Drive 3.Tax/${taxYear}). Do the staff final pass, then send to the accountant (tax_send_to_accountant).`,
        account_id: accountId,
        created_by: "System",
      })
    }
  } catch (e) {
    console.error("[attest-handoff] staff task creation failed:", e)
  }
}
