/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * QA t38 — Stop Drive slice S1c, fix round (dev job 264bb882). SANDBOX only. Real server functions, real sandbox database +
 * storage, Drive switched OFF (no live Drive, no service-account key — any Drive call would throw):
 *   item 7 — a completed e-sign envelope is filed (storage company → its storage; company without → bucket-served row),
 *            and filing it AGAIN is a no-op (the reconciliation cron re-runs exactly this function);
 *   item 8 — the lease-regenerate decision: a storage company can receive the copy, a company with nothing cannot — decided
 *            before the lease row would change;
 *   item 4 — a person with no storage gets one opened and the file lands there;
 *   decision — a Closed company with a folder and no storage is refused; an Active one with a folder is kept on its folder.
 *   QA_ENV_FILE=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t38-stop-drive-fix-round.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.QA_ENV_FILE ?? ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC — storage

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  delete process.env.GOOGLE_DRIVE_LIVE
  process.env.GOOGLE_SA_KEY = ""
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { fileEsignSignedPdf } = await import("../../../lib/operations/esign")
  const { accountCanReceiveFiles, decideNoStorage } = await import("../../../lib/crm-store/no-storage")
  const tag = `${Date.now()}`
  const { data: tc } = await sb.from("accounts").select("id").eq("company_name", "QA Test Co LLC").limit(1).maybeSingle()
  const TC = tc.id as string

  // ── item 7: e-sign filing ──
  const mkEnvelope = async (accountId: string, label: string) => {
    const path = `esign/qa-t38-${tag}-${label}/signed.pdf`
    await sb.storage.from("signed-documents").upload(path, Buffer.from(`%PDF-1.4 QA Test ${tag} ${label}`), { contentType: "application/pdf", upsert: true })
    const ins = await sb.from("esign_envelopes").insert({ token: `qa-t38-${tag}-${label}`, document_name: `QA Test envelope ${label}`, owner_account_id: accountId, signed_pdf_path: path, status: "completed", completed_at: new Date().toISOString(), total_signers: 1, signed_count: 1 }).select("id").single()
    if (ins.error) throw new Error(`fixture envelope: ${ins.error.message}`)
    return ins.data.id as string
  }
  const envUx = await mkEnvelope(UX, "ux")
  const r1 = await fileEsignSignedPdf(envUx)
  const { data: e1 } = await sb.from("esign_envelopes").select("signed_pdf_drive_id").eq("id", envUx).maybeSingle()
  check("E1 a storage company's signed PDF is filed in its storage (pointer written)", r1.filed && r1.hasStorage === true && String(e1?.signed_pdf_drive_id).startsWith("store:"), JSON.stringify({ r1, e1 }))
  const r1b = await fileEsignSignedPdf(envUx)
  check("E2 filing it again is a no-op that still counts as filed", r1b.filed === true)

  const envTc = await mkEnvelope(TC, "tc")
  const r2 = await fileEsignSignedPdf(envTc)
  const { data: d2 } = await sb.from("documents").select("id, portal_visible, drive_file_id").eq("account_id", TC).like("drive_file_id", `storage:signed-documents/esign/qa-t38-${tag}-tc/%`)
  check("E3 a company with no storage gets the bucket-served portal row", r2.filed && r2.hasStorage === false && (d2 ?? []).length === 1 && d2[0].portal_visible === true, JSON.stringify({ r2, d2 }))
  const r2b = await fileEsignSignedPdf(envTc)
  const { data: d2b } = await sb.from("documents").select("id").eq("account_id", TC).like("drive_file_id", `storage:signed-documents/esign/qa-t38-${tag}-tc/%`)
  check("E4 re-filing adds no second row (what the reconciliation cron relies on)", r2b.filed && (d2b ?? []).length === 1)

  // ── item 8 + decision ──
  check("L1 the lease-regenerate decision: a storage company can receive the copy", (await accountCanReceiveFiles(UX)) === true)
  check("L2 a company with no storage and no folder cannot — decided before any lease row changes", (await accountCanReceiveFiles(TC)) === false)
  check("L3 a Closed company with a folder is refused; an Active one with a folder is frozen (refused too, Stop Drive S2)", decideNoStorage({ status: "Closed", drive_folder_id: "F" }).route === "refuse" && decideNoStorage({ status: "Active", drive_folder_id: "F" }).route === "refuse")

  // ── item 4: a person with no storage ──
  const { data: c } = await sb.from("contacts").insert({ full_name: `QA Test Person ${tag}`, email: `qa-t38-${tag}@example.com` }).select("id").single()
  const { liveOwnerOfContact } = await import("../../../lib/crm-store/switched-drive-guard")
  const { ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
  const { saveDocumentForContact } = await import("../../../lib/crm-store/save-for-account")
  check("P0 the fixture person has no storage yet", (await liveOwnerOfContact(c.id)) === null)
  await ensurePersonOwner(c.id, `QA Test Person ${tag}`)
  const sv = await saveDocumentForContact({ contactId: c.id, name: `QA Test itin ${tag}.pdf`, bytes: Buffer.from(`%PDF QA ${tag}`), mimeType: "application/pdf", documentType: null, callerKey: `qa-t38:${tag}`, portalVisible: true, row: { status: "classified" } })
  check("P1 the file lands in the person's own storage (no signed link, a storage pointer)", sv.route === "store" && sv.pointer.startsWith("store:"), JSON.stringify(sv))
  if (sv.route === "store") await sb.from("documents").delete().eq("id", sv.documentRowId)

  // ── round 2/3: the sweep window is filtered in the query ──
  const { readSweepWindow } = await import("../../../lib/archive/skip-no-drive-folder")
  for (const [table, cols, real] of [["tax_return_submissions", "id, account_id, status, review_status, created_at, drive_archived_at, drive_archive_meta", "status.in.(completed,reviewed),review_status.not.is.null"], ["banking_submissions", "id, account_id, status, created_at, drive_archived_at, drive_archive_meta", "status.in.(completed,reviewed)"]] as const) {
    const w = await readSweepWindow<{ id: string; account_id: string | null; status: string | null }>(table, cols, { cutoffIso: "2020-01-01T00:00:00Z", realFilter: real })
    const ids = Array.from(new Set(w.candidates.map((r) => r.account_id).filter((x): x is string => !!x)))
    const { data: accs } = ids.length ? await sb.from("accounts").select("id, status").in("id", ids) : { data: [] }
    const bad = (accs ?? []).filter((a: { status: string }) => a.status === "Closed" || a.status === "Cancelled")
    check(`W-${table} the sweep window holds only real rows of companies that are not finished (read from the real database)`, !w.readError && bad.length === 0 && w.candidates.every((r) => r.status === "completed" || r.status === "reviewed" || table === "tax_return_submissions"), JSON.stringify({ err: w.readError, rows: w.candidates.length, skippedFinished: w.skippedFinished, bad: bad.length }))
  }
  const { fileClosureSubmission } = await import("../../../lib/crm-store/save-account-form")
  const sub = (account_id: string | null) => ({ token: `qa-t38-${tag}`, account_id, upload_paths: [] as string[], completed_at: new Date().toISOString() })
  const cUx = await fileClosureSubmission(sub(UX), { client_name: `QA Test ${tag}` }, "Uxio Test LLC", "qa/t38")
  check("C1 closure: a storage company's form is filed → may be marked reviewed", cUx.ok === true, JSON.stringify(cUx))
  const cTc = await fileClosureSubmission(sub(TC), { client_name: `QA Test ${tag}` }, "QA Test Co LLC", "qa/t38")
  check("C2 closure: an Active company with nothing to file it in → NOT reviewable", cTc.ok === false && cTc.lines.join(" ").includes("no document storage"), JSON.stringify(cTc))
  const { data: closedAcc } = await sb.from("accounts").select("id").eq("company_name", "PR2 QA Test LLC").limit(1).maybeSingle()
  if (closedAcc) {
    const cCl = await fileClosureSubmission(sub(closedAcc.id), { client_name: `QA Test ${tag}` }, "PR2 QA Test LLC", "qa/t38")
    check("C3 closure: a Cancelled company with nothing to file → reviewable, and it says so", cCl.ok === true && cCl.lines.join(" ").includes("closed"), JSON.stringify(cCl))
  }
  const cNo = await fileClosureSubmission(sub(null), {}, "x", "qa/t38")
  check("C4 closure: a form linked to neither a company nor a person is never stuck: reviewable, with a clear note", cNo.ok === true && cNo.lines.join(" ").includes("stay on the submission"), JSON.stringify(cNo))

  // cleanup of fixtures that are not storage objects
  await sb.from("documents").delete().eq("account_id", TC).like("drive_file_id", `storage:signed-documents/esign/qa-t38-${tag}-%`)
  await sb.from("esign_envelopes").delete().in("id", [envUx, envTc])
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
