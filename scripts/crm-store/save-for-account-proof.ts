/* eslint-disable no-console -- a proof script prints its results */
/**
 * Sandbox proof for saveDocumentForAccount (dev job ad09ea91, Phase 2): uses the REAL sandbox database and storage.
 *  - a company that lives in the new storage (the Uxio Test LLC fixture) → saved in storage + listed in the CRM documents list
 *  - the same bytes again → no second file
 *  - a company still on Drive → { route: "drive" }, nothing saved
 * Run: npx tsx scripts/crm-store/save-for-account-proof.ts   (refuses to run against production)
 */
import { config } from "dotenv"
config({ path: ".env.local" })

const STORE_COMPANY = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC (QA fixture)

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { saveDocumentForAccount } = await import("../../lib/crm-store/save-for-account")
  const { supabaseAdmin } = await import("../../lib/supabase-admin")
  const g = await import("../../lib/crm-store/switched-drive-guard")

  console.log("state of the fixture:", await g.companyDocState(STORE_COMPANY))
  const bytes = Buffer.from(`QA Test cutover proof ${new Date().toISOString().slice(0, 10)}`)
  const input = { accountId: STORE_COMPANY, name: "QA Test cutover proof.txt", bytes, mimeType: "text/plain", folder: "correspondence" as const, documentType: null, callerKey: `qa-cutover-proof:${bytes.toString("hex").slice(0, 24)}` }

  const first = await saveDocumentForAccount(input)
  console.log("first save:", first)
  const second = await saveDocumentForAccount(input)
  console.log("second save (same bytes):", second.route === "store" ? { status: second.status, sameFile: second.fileId === (first as { fileId: string }).fileId, sameRow: second.documentRowId === (first as { documentRowId: string }).documentRowId } : second)

  // shown to the client: an untyped file may be published (only staff-only types and "Needs review" files are refused)
  const shownBytes = Buffer.from(`QA Test cutover proof shown ${new Date().toISOString().slice(0, 10)}`)
  const shown = await saveDocumentForAccount({ ...input, name: "QA Test cutover proof shown.txt", bytes: shownBytes, callerKey: `qa-cutover-proof-shown:${shownBytes.toString("hex").slice(0, 24)}`, portalVisible: true })
  if (shown.route === "store") {
    const { data: r2 } = await supabaseAdmin.from("documents").select("portal_visible").eq("id", shown.documentRowId).single()
    const { data: f2 } = await (supabaseAdmin as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { single: () => Promise<{ data: unknown }> } } } }).from("store_files").select("published, needs_review_at, document_type").eq("id", shown.fileId).single()
    console.log("client-visible untyped save → documents.portal_visible:", r2?.portal_visible, "| store file:", f2)
    await supabaseAdmin.from("documents").delete().eq("id", shown.documentRowId)
  }

  if (first.route === "store") {
    const { data: row } = await supabaseAdmin.from("documents").select("id, file_name, drive_file_id, account_id, portal_visible, drive_link").eq("id", first.documentRowId).single()
    console.log("CRM documents row:", row)
    await supabaseAdmin.from("documents").delete().eq("id", first.documentRowId)
    console.log("test documents row removed (the stored file stays in the sandbox storage: stored files are never deleted)")
  }

  // the signed-PDF shape the automatic flows use: lease (client sees it) and SS-4 (internal — never shown)
  const { saveSignedPdfForAccount } = await import("../../lib/crm-store/save-for-account")
  const pdf = Buffer.from(`%PDF-1.4 QA Test cutover proof ${Date.now()}`)
  const lease = await saveSignedPdfForAccount({ accountId: STORE_COMPANY, fileName: "QA Test lease signed.pdf", bytes: pdf, label: "Lease Agreement", callerKey: `qa-lease:${Date.now()}`, documentType: "office_lease" })
  const ss4 = await saveSignedPdfForAccount({ accountId: STORE_COMPANY, fileName: "QA Test ss4 signed.pdf", bytes: Buffer.concat([pdf, Buffer.from("ss4")]), label: "Form SS-4 (Signed)", callerKey: `qa-ss4:${Date.now()}`, portalVisible: false, documentType: "form_ss_4" })
  for (const [name, r] of [["lease", lease], ["ss4", ss4]] as const) {
    if (r.route !== "store") { console.log(name, "→", r); continue }
    const { data: row } = await supabaseAdmin.from("documents").select("document_type_name, portal_visible, category, status").eq("id", r.documentRowId).single()
    const { data: f } = await (supabaseAdmin as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { single: () => Promise<{ data: unknown }> } } } }).from("store_files").select("document_type, published").eq("id", r.fileId).single()
    console.log(`${name} signed PDF → documents row:`, row, "| store file:", f)
    await supabaseAdmin.from("documents").delete().eq("id", r.documentRowId)
  }

  // a company still on Drive
  const { data: accts } = await supabaseAdmin.from("accounts").select("id, company_name").not("drive_folder_id", "is", null).limit(60)
  for (const a of (accts ?? []) as Array<{ id: string; company_name: string }>) {
    if ((await g.companyDocState(a.id)) === "drive") {
      console.log(`company still on Drive (${a.company_name}):`, await saveDocumentForAccount({ ...input, accountId: a.id }))
      break
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
