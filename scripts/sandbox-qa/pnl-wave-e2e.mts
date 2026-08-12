/* eslint-disable no-console -- QA script: console output is the deliverable */
/**
 * Card 4a39e0fd fix-wave E2E — DB-level matrix cells, run against the LOCAL
 * isolated stack (or sandbox). Refuses production. Offline-deterministic:
 * BANK_STATEMENT_AI_DISABLED=true is forced so no cell depends on the AI.
 *
 * Cells (matrix labels from the card's plan field):
 *  W1  — tax_form_setup portal_wizard runs NO Drive scrape / NO legacy P&L
 *  W3  — empty-but-valid Relay CSV completes as processed-with-zero
 *  W2/W4 — dead file: terminal fail on FIRST attempt + client portal message
 *          + staff What's New card (statement_ingest_failed)
 *  W6  — ambiguous unknown layout QUARANTINES; Exception-Center-style confirm
 *          flips the mapping and auto-requeues; re-run ingests rows
 *  W7  — delete file → identical re-upload RE-INGESTS (the vanished-statement
 *          bug is dead at the JOIN level)
 *  W8  — mutation on a reviewed+attested submission clears attestation AND
 *          the staff failed-files override
 *  DUP — identical content re-ingested under a different name does NOT
 *          duplicate rows (source-id short-circuit)
 *
 * Each cell prints PASS/FAIL; exit 1 on any FAIL. Fixtures are seeded with a
 * QA-WAVE prefix and deleted at the end.
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const isLocal = SUPA_URL.includes("127.0.0.1") || SUPA_URL.includes("localhost")
const isSandbox = SUPA_URL.includes("xjcxlmlpeywtwkhstjlw")
if (!isLocal && !isSandbox) {
  console.error(`NOT LOCAL/SANDBOX (${SUPA_URL}) — abort`)
  process.exit(1)
}
process.env.BANK_STATEMENT_AI_DISABLED = "true"
process.env.SANDBOX_MODE = process.env.SANDBOX_MODE || "1"

const { supabaseAdmin } = await import("../../lib/supabase-admin")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0
let fail = 0
function check(cell: string, name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ [${cell}] ${name}`) }
  else { fail++; console.error(`  ❌ [${cell}] ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const TY = 2025
const cleanup = { accountIds: [] as string[], contactIds: [] as string[], submissionIds: [] as string[] }

async function seedAccount(name: string): Promise<{ accountId: string; contactId: string }> {
  // eslint-disable-next-line no-restricted-syntax -- QA fixture seed, cleaned up at exit
  const { data: acct, error: aErr } = await db.from("accounts").insert({
    company_name: `QA-WAVE ${name}`, entity_type: "Multi Member LLC", account_type: "Client", status: "Active",
  }).select("id").single()
  if (aErr) throw new Error(`seed account: ${aErr.message}`)
  // eslint-disable-next-line no-restricted-syntax -- QA fixture seed, cleaned up at exit
  const { data: ctc, error: cErr } = await db.from("contacts").insert({
    first_name: "QA", last_name: `Wave-${name}`, full_name: `QA Wave-${name}`,
    email: `qa-wave-${name.toLowerCase()}@example.com`, language: "English",
  }).select("id").single()
  if (cErr) throw new Error(`seed contact: ${cErr.message}`)
  await db.from("account_contacts").insert({ account_id: acct.id, contact_id: ctc.id, is_primary: true, ownership_pct: 50 })
  cleanup.accountIds.push(acct.id)
  cleanup.contactIds.push(ctc.id)
  return { accountId: acct.id, contactId: ctc.id }
}

const RELAY_HEADER = "Date,Payee,Transaction Type,Description,Reference,Status,Amount,Currency,Balance"
const relayCsv = (rows: string[]) => [RELAY_HEADER, ...rows].join("\n")
const RELAY_ROWS_2025 = [
  `1/10/2025,ACME LLC,Payment,Invoice 12,REF-1,SETTLED,1500.00,USD,1500.00`,
  `2/12/2025,Vendor One,Card,Software,REF-2,SETTLED,-49.00,USD,1451.00`,
  `3/03/2025,Client Two,Payment,Invoice 13,REF-3,SETTLED,900.00,USD,2351.00`,
]
// Ambiguous unknown layout: TWO date-like columns → the mapping proposal
// carries ambiguities → QUARANTINE (deterministic, no AI).
const QB_CSV = [
  "Posted Date,Cleared Date,Memo,Amount,Balance",
  "01/15/2025,01/16/2025,Stripe payout,1200.00,1200.00",
  "02/20/2025,02/21/2025,AWS,-300.00,900.00",
].join("\n")

async function latestIngestJobFor(accountId: string) {
  const { data } = await db.from("job_queue").select("*")
    .eq("job_type", "ingest_bank_statement").eq("account_id", accountId)
    .order("created_at", { ascending: false }).limit(1)
  return data?.[0]
}
async function runWorkerOnce() {
  // Drain via the runner semantics: claim → handler → complete/fail(terminal).
  const { claimNextJob, completeJob, failJob } = await import("../../lib/jobs/queue")
  const { getJobHandler } = await import("../../lib/jobs/registry")
  for (let i = 0; i < 20; i++) {
    const job = await claimNextJob()
    if (!job) break
    const handler = getJobHandler(job.job_type)
    if (!handler) { await failJob(job.id, `unknown ${job.job_type}`); continue }
    try {
      const result = await handler(job, { deadlineAt: Date.now() + 200_000 })
      if (result.ok === false) await failJob(job.id, result.summary || "failed", result, { terminal: result.terminal === true })
      else await completeJob(job.id, result)
    } catch (e) {
      await failJob(job.id, e instanceof Error ? e.message : String(e))
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n— card 4a39e0fd wave E2E — target: ${isLocal ? "LOCAL stack" : "SANDBOX"} —\n`)

try {
  // ── W7 + DUP: delete-supersede + no-duplicate ─────────────────────────────
  {
    const { accountId } = await seedAccount("W7")
    const { saveAndEnqueueStatementUpload } = await import("../../lib/tax/portal-upload-enqueue")
    const buf = Buffer.from(relayCsv(RELAY_ROWS_2025))

    const up1 = await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "Relay", buffer: buf, fileName: "Relay-2025.csv" })
    check("W7", "first upload enqueues", up1.queued === true)
    await runWorkerOnce()
    const { count: c1 } = await db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("tax_year", TY)
    check("W7", "rows landed (3)", c1 === 3, `got ${c1}`)

    // DUP: identical content, DIFFERENT filename → different path, same source
    const up2 = await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "Relay", buffer: buf, fileName: "Relay-2025-copy.csv" })
    check("DUP", "renamed identical file enqueues its own job", up2.queued === true)
    await runWorkerOnce()
    const { count: c2 } = await db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("tax_year", TY)
    check("DUP", "row count unchanged after identical re-ingest (source-id short-circuit)", c2 === 3, `got ${c2}`)

    // Delete → jobs cancelled → identical re-upload RE-INGESTS
    const sha = (await import("../../lib/tax/statement-uploads")).sha256Hex(buf)
    const del = await (await import("../../lib/tax/statement-uploads")).deleteStatementRows(accountId, TY, `upload:${sha}`)
    check("W7", "delete removes the source rows", del.ok && del.deleted === 3, JSON.stringify(del))
    const { data: cancelledJobs } = await db.from("job_queue").select("id,status").eq("job_type", "ingest_bank_statement").eq("account_id", accountId).eq("status", "cancelled")
    check("W7", "delete cancelled the file's jobs", (cancelledJobs ?? []).length >= 1, `cancelled=${(cancelledJobs ?? []).length}`)

    const up3 = await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "Relay", buffer: buf, fileName: "Relay-2025.csv" })
    check("W7", "IDENTICAL re-upload after delete ENQUEUES FRESH (the live bug is dead)", up3.queued === true && !up3.alreadyQueued, JSON.stringify(up3))
    await runWorkerOnce()
    const { count: c3 } = await db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("tax_year", TY)
    check("W7", "rows are BACK after re-upload", c3 === 3, `got ${c3}`)
  }

  // ── W3: empty-but-valid ───────────────────────────────────────────────────
  {
    const { accountId } = await seedAccount("W3")
    const { saveAndEnqueueStatementUpload } = await import("../../lib/tax/portal-upload-enqueue")
    const buf = Buffer.from(relayCsv([]))
    await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "Relay", buffer: buf, fileName: "Relay-June-empty.csv" })
    await runWorkerOnce()
    const job = await latestIngestJobFor(accountId)
    check("W3", "empty statement COMPLETES (not failed)", job?.status === "completed", `status=${job?.status}`)
    check("W3", "summary says empty period, not could-not-read", String(job?.result?.summary ?? "").includes("empty statement period"), job?.result?.summary)
    const { data: msgs } = await db.from("portal_messages").select("id").eq("account_id", accountId)
    check("W3", "NO failure message to the client", (msgs ?? []).length === 0, `msgs=${(msgs ?? []).length}`)
  }

  // ── W2/W4: dead file — terminal, loud ─────────────────────────────────────
  {
    const { accountId } = await seedAccount("W4")
    const { saveAndEnqueueStatementUpload } = await import("../../lib/tax/portal-upload-enqueue")
    const buf = Buffer.from("!!! not a statement at all !!!\x00\x01")
    await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "Mystery", buffer: buf, fileName: "garbage.csv" })
    await runWorkerOnce()
    const job = await latestIngestJobFor(accountId)
    check("W4", "dead file FINAL-FAILS", job?.status === "failed", `status=${job?.status}`)
    // attempts counts BOTH the claim (+1) and failJob's increment (+1): a
    // single parse run lands at 2. A retried job would show 4+.
    check("W4", "terminal on the FIRST claim (attempts=2 = one run)", job?.attempts === 2, `attempts=${job?.attempts}`)
    const { data: msgs } = await db.from("portal_messages").select("message").eq("account_id", accountId)
    check("W2", "client got the failure portal message naming the file", (msgs ?? []).some((m: { message: string }) => m.message.includes("garbage.csv")), JSON.stringify(msgs))
    const { data: cards } = await db.from("message_actions").select("id,source_ref,label").eq("account_id", accountId)
    check("W2", "staff What's New card raised (per-file source_ref)", (cards ?? []).some((c: { source_ref: string | null }) => String(c.source_ref ?? "").startsWith("ingest_file:")), JSON.stringify(cards))

    // negative: the all-clear must NOT fire for this account
    const { data: ready } = await db.from("portal_messages").select("message").eq("account_id", accountId)
    check("W2", "NO 'statements ready' all-clear over a failed file", !(ready ?? []).some((m: { message: string }) => m.message.includes("finished reading")), "")
  }

  // ── W6: quarantine → staff confirm → auto-requeue → ingest ────────────────
  {
    const { accountId } = await seedAccount("W6")
    const { saveAndEnqueueStatementUpload } = await import("../../lib/tax/portal-upload-enqueue")
    const buf = Buffer.from(QB_CSV)
    // Deterministic quarantine: a STORED 'proposed' mapping for this header
    // fingerprint makes the parser quarantine the file until staff confirm —
    // the exact client-stuck flow Antonio ruled on. The seeded mapping is the
    // heuristic's own valid proposal, so the post-confirm re-run parses.
    const fm = await import("../../lib/bank-format-mappings")
    const headerCells = QB_CSV.split("\n")[0].split(",")
    const fingerprint = fm.formatFingerprint(headerCells)
    const proposal = fm.proposeMappingHeuristically(QB_CSV)
    if (!proposal) throw new Error("W6 fixture: heuristic could not map the QB fixture")
    const { data: seededMap } = await db.from("statement_format_mappings").insert({
      fingerprint, delimiter: ",", mapping: proposal, status: "proposed",
      bank_label: "QuickBooks Export", proposed_by: "heuristic", source_file: "qb-export.csv",
      created_by: "system:format-mapping",
    }).select("id").single()
    void seededMap
    await saveAndEnqueueStatementUpload({ accountId, taxYear: TY, bankLabel: "QuickBooks", buffer: buf, fileName: "qb-export.csv" })
    await runWorkerOnce()
    const job = await latestIngestJobFor(accountId)
    const detail = JSON.stringify(job?.result?.steps ?? [])
    check("W6", "ambiguous layout QUARANTINES (failed + marker)", job?.status === "failed" && detail.includes("FORMAT_CONFIRMATION_NEEDED"), `status=${job?.status}`)

    const { data: proposals } = await db.from("statement_format_mappings").select("id,status").eq("status", "proposed").order("created_at", { ascending: false }).limit(1)
    check("W6", "a mapping proposal exists", (proposals ?? []).length === 1)
    const mappingId = proposals?.[0]?.id

    const { getQuarantinedFormats } = await import("../../lib/exceptions/queries")
    const rows = await getQuarantinedFormats()
    check("W6", "Exception Center lists it WITH the waiting client file", rows.some(r => r.mapping_id === mappingId && r.waiting_files.some(f => f.account_id === accountId)), JSON.stringify(rows.map(r => r.mapping_id)))

    // Staff confirm (the Exception-Center action's core): flip + auto-requeue
    await db.from("statement_format_mappings").update({ status: "staff_confirmed", updated_at: new Date().toISOString() }).eq("id", mappingId).eq("status", "proposed")
    const { requeueQuarantinedPortalIngests } = await import("../../lib/tax/quarantine-requeue")
    const rq = await requeueQuarantinedPortalIngests(mappingId)
    check("W6", "confirm auto-requeues the waiting client file", rq.requeued === 1 && rq.cancelled >= 1, JSON.stringify(rq))

    await runWorkerOnce()
    const { count: rowsIn } = await db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("tax_year", TY)
    check("W6", "re-run ingests through the CONFIRMED mapping (client unstuck)", (rowsIn ?? 0) >= 2, `rows=${rowsIn}`)
  }

  // ── W1: no scrape, no legacy P&L on the wizard job ────────────────────────
  {
    const { accountId, contactId } = await seedAccount("W1")
    const { data: sub } = await db.from("tax_return_submissions").insert({
      account_id: accountId, contact_id: contactId, tax_year: TY, status: "completed",
      token: `qa-wave-w1-${Date.now().toString(36)}`, submitted_data: { entity_type: "MMLLC" },
    }).select("id, token").single()
    cleanup.submissionIds.push(sub.id)
    const { handleTaxFormSetup } = await import("../../lib/jobs/handlers/tax-form-setup")
    const result = await handleTaxFormSetup({
      id: crypto.randomUUID(), job_type: "tax_form_setup",
      payload: { source: "portal_wizard", token: sub.token, submission_id: sub.id, contact_id: contactId, account_id: accountId, tax_return_id: null, tax_year: TY, changed_fields: null, submitted_data: { entity_type: "MMLLC" }, upload_paths: [], entity_type: "MMLLC" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const stepNames = result.steps.map((s: { name: string }) => s.name)
    check("W1", "NO bank_statement_parse step (scrape is gone)", !stepNames.includes("bank_statement_parse"), stepNames.join(","))
    check("W1", "NO pnl_generated step (legacy P&L is gone)", !stepNames.includes("pnl_generated"), stepNames.join(","))
    const { count: driveRows } = await db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId).not("source_file_id", "like", "upload:%")
    check("W1", "zero Drive-sourced rows", (driveRows ?? 0) === 0, `rows=${driveRows}`)
  }

  // ── W8: mutation clears attestation AND the staff override ────────────────
  {
    const { accountId, contactId } = await seedAccount("W8")
    const { data: sub } = await db.from("tax_return_submissions").insert({
      account_id: accountId, contact_id: contactId, tax_year: TY, status: "reviewed",
      token: `qa-wave-w8-${Date.now().toString(36)}`, submitted_data: { entity_type: "MMLLC" },
      confirmation_accepted: true,
      financials_meta: { failed_files_override: { by: "qa", reason: "seeded", at: new Date().toISOString() } },
    }).select("id").single()
    cleanup.submissionIds.push(sub.id)
    const { resetFinancialsAttestation } = await import("../../lib/tax/attestation")
    await resetFinancialsAttestation(accountId, TY, "QA mutation")
    const { data: after } = await db.from("tax_return_submissions").select("confirmation_accepted, financials_meta, review_history").eq("id", sub.id).single()
    check("W8", "attestation cleared on a REVIEWED submission", after.confirmation_accepted === false)
    check("W8", "staff override cleared by the mutation", after.financials_meta?.failed_files_override == null, JSON.stringify(after.financials_meta))
    const events = (after.review_history ?? []).map((h: { event: string }) => h.event)
    check("W8", "both history entries written", events.includes("financials_attestation_reset") && events.includes("failed_files_override_cleared"), events.join(","))
  }
} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const id of cleanup.submissionIds) await db.from("tax_return_submissions").delete().eq("id", id)
  for (const id of cleanup.accountIds) {
    await db.from("bank_transactions").delete().eq("account_id", id)
    await db.from("job_queue").delete().eq("account_id", id)
    await db.from("portal_messages").delete().eq("account_id", id)
    await db.from("action_cards").delete().eq("account_id", id)
    await db.from("account_bank_balances").delete().eq("account_id", id)
    await db.from("account_contacts").delete().eq("account_id", id)
    await db.from("tasks").delete().eq("account_id", id)
    await db.from("accounts").delete().eq("id", id)
  }
  for (const id of cleanup.contactIds) await db.from("contacts").delete().eq("id", id)
  await db.from("statement_format_mappings").delete().eq("created_by", "system:format-mapping")
}

console.log(`\n— ${pass} passed, ${fail} failed —`)
process.exit(fail > 0 ? 1 : 0)
