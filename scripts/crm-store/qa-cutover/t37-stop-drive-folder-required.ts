/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script inserts QA Test fixture rows */
/**
 * QA t37 — Stop Drive slice S1c (dev job 264bb882). SANDBOX only. Real server functions, real sandbox database + storage, Drive
 * switched OFF (no live Drive, no service-account key, so any Drive call would throw):
 *   - a company WITH storage: a document save and a form filing land in its storage with the right type / visibility;
 *   - a company with NO storage: both answer "no storage" (the routes turn that into the one plain sentence, 409).
 *   QA_ENV_FILE=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t37-stop-drive-folder-required.ts
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
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { companyDocState } = await import("../../../lib/crm-store/switched-drive-guard")
  const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
  const { saveFormForAccount } = await import("../../../lib/crm-store/save-account-form")
  const { NO_STORAGE_SENTENCE } = await import("../../../lib/crm-store/no-storage")
  const tag = `${Date.now()}`

  const { data: tc } = await sb.from("accounts").select("id").eq("company_name", "QA Test Co LLC").limit(1).maybeSingle()
  const TC = tc.id as string
  check("S0 the fixtures are what we think: Uxio Test = storage, QA Test Co = no storage", (await companyDocState(UX)) === "store" && (await companyDocState(TC)) === "drive")

  // 1. document save for a storage company
  const bytes = Buffer.from(`%PDF-1.4 QA Test ${tag}`)
  const r1 = await saveDocumentForAccount({ accountId: UX, name: `QA Test stop-drive ${tag}.pdf`, bytes, mimeType: "application/pdf", folder: "company", documentType: "other_document", callerKey: `qa-t37:${tag}`, portalVisible: false, row: { document_type_name: "QA Test", category: 1, status: "classified" } })
  check("D1 a storage company's document is saved in its storage", r1.route === "store", JSON.stringify(r1))
  if (r1.route === "store") {
    const { data: f } = await sb.from("store_files").select("owner_id, published, document_type, state").eq("id", r1.fileId).maybeSingle()
    const { data: d } = await sb.from("documents").select("portal_visible, account_id, drive_file_id").eq("id", r1.documentRowId).maybeSingle()
    check("D2 stored hidden, live, typed other_document", f?.published === false && f?.state === "live" && f?.document_type === "other_document", JSON.stringify(f))
    check("D3 the CRM row points at the storage, hidden from the client", d?.drive_file_id === r1.pointer && d?.portal_visible === false && d?.account_id === UX, JSON.stringify(d))
    const again = await saveDocumentForAccount({ accountId: UX, name: `QA Test stop-drive ${tag}.pdf`, bytes, mimeType: "application/pdf", folder: "company", documentType: "other_document", callerKey: `qa-t37:${tag}`, portalVisible: false })
    check("D4 the same save again is one file (idempotent)", again.route === "store" && again.fileId === r1.fileId, JSON.stringify(again))
    await sb.from("documents").delete().eq("id", r1.documentRowId)
  }

  // 2. a company with no storage: the answer the routes turn into the one sentence
  const r2 = await saveDocumentForAccount({ accountId: TC, name: `QA Test stop-drive ${tag}.pdf`, bytes, mimeType: "application/pdf", folder: "company", documentType: null, callerKey: `qa-t37-tc:${tag}` })
  check("N1 a company with no storage gets no save (route drive = 'no storage')", r2.route === "drive")
  check("N2 and the sentence has no Drive wording", !/drive/i.test(NO_STORAGE_SENTENCE), NO_STORAGE_SENTENCE)

  // 3. form filing by company (the MCP review tools)
  const submitted = { client_name: `QA Test ${tag}`, reason: "stop drive qa" }
  const f1 = await saveFormForAccount({ accountId: UX, formType: "closure", submittedData: submitted, uploadPaths: [], meta: { token: `qa-t37-${tag}`, submittedAt: new Date().toISOString(), companyName: "Uxio Test LLC" } })
  check("F1 a storage company's form summary is filed in its storage", f1.route === "store" && !!f1.result.summaryFileId && f1.result.errors.length === 0, JSON.stringify(f1))
  if (f1.route === "store" && f1.result.summaryFileId) {
    const id = f1.result.summaryFileId.replace(/^store:/, "")
    const { data: sf } = await sb.from("store_files").select("owner_id, published, state, name").eq("id", id).maybeSingle()
    check("F2 the summary is a live, hidden file", sf?.state === "live" && sf?.published === false, JSON.stringify(sf))
  }
  const f2 = await saveFormForAccount({ accountId: TC, formType: "closure", submittedData: submitted, uploadPaths: [], meta: { token: `qa-t37-${tag}`, submittedAt: new Date().toISOString(), companyName: "QA Test Co LLC" } })
  check("F3 a company with no storage: nothing filed ({route:'none'})", f2.route === "none", JSON.stringify(f2))
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
