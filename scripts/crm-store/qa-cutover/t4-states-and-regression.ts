/* eslint-disable no-console */
/**
 * Phase 3 QA t4: the three company states (drive / moving / store), a Drive company behaving exactly as before (regression),
 * and the Drive-write guard with the live TEST Drive. SANDBOX only. Run: npx tsx scripts/crm-store/qa-cutover/t4-states-and-regression.ts
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const g = await import("../../../lib/crm-store/switched-drive-guard")
  const { saveDocumentForAccount } = await import("../../../lib/crm-store/save-for-account")
  const staff = await sessionCookie("staff")
  const t0 = new Date().toISOString()

  const { data: tc } = await sb.from("accounts").select("id, company_name, drive_folder_id").eq("company_name", "Test Company LLC").limit(1).maybeSingle()
  if (!tc) { console.log("Test Company LLC not found"); return }
  console.log(`      (info) Test Company LLC ${tc.id}, folder ${tc.drive_folder_id}`)

  // ── states ──────────────────────────────────────────────────────────────────────────────────────────────
  check("S1 fixture is in the storage", (await g.companyDocState(UX)) === "store", String(await g.companyDocState(UX)))
  check("S2 Test Company LLC is on Drive", (await g.companyDocState(tc.id)) === "drive", String(await g.companyDocState(tc.id)))

  // ── regression: a Drive company saves nothing in the storage ──────────────────────────────────────────────
  const bytes = Buffer.from(`QA Test regression ${Date.now()}`)
  const drv = await saveDocumentForAccount({ accountId: tc.id, name: "QA Test regression.txt", bytes, mimeType: "text/plain", folder: "correspondence", documentType: null, callerKey: `qa-t4-drive:${Date.now()}` })
  check("R1 a Drive company is told to use Drive (nothing saved in the storage)", drv.route === "drive", JSON.stringify(drv))

  // the staff upload route for a Drive company must still save to Drive (live TEST Drive in this run)
  const stagePath = `qa-cutover/${Date.now()}-QA Test drive co.pdf`
  await sb.storage.from("onboarding-uploads").upload(stagePath, pdf("drive company"), { contentType: "application/pdf", upsert: true })
  const up = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: tc.id, storage_path: stagePath, file_name: "QA Test drive co.pdf", mime_type: "application/pdf", document_type: "QA Test drive co", category: "Company" } })
  const ub = up.json as { success?: boolean; driveFileId?: string } | null
  check("R2 staff upload for a Drive company works", up.status === 200 && ub?.success === true, `HTTP ${up.status} ${up.text.slice(0, 160)}`)
  check("R3 …and it is a Drive id, not a storage pointer", !!ub?.driveFileId && !ub.driveFileId.startsWith("store:"), `driveFileId=${ub?.driveFileId}`)
  const { data: storeStray } = await sb.from("store_files").select("id").gt("created_at", t0).eq("name", "QA Test drive co.pdf")
  check("R4 nothing for that file appears in the new storage", (storeStray ?? []).length === 0, JSON.stringify(storeStray))

  // ── moving: the company is locked, uploads refuse with the plain message ───────────────────────────────────
  const { data: run, error: runErr } = await sb.from("store_import_runs").insert({ account_id: tc.id, mode: "move", status: "moving" }).select("id").single()
  if (runErr) {
    console.log("      fixture move-run insert failed:", runErr.message)
  } else {
    check("M1 state reads 'moving'", (await g.companyDocState(tc.id)) === "moving", String(await g.companyDocState(tc.id)))
    const movePath = `qa-cutover/${Date.now()}-QA Test moving.pdf`
    await sb.storage.from("onboarding-uploads").upload(movePath, pdf("moving"), { contentType: "application/pdf", upsert: true })
    const mv = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: tc.id, storage_path: movePath, file_name: "QA Test moving.pdf", mime_type: "application/pdf", document_type: "QA Test moving", category: "Company" } })
    check("M2 an upload to a moving company is refused (not lost, not sent to Drive)", mv.status >= 400, `HTTP ${mv.status} ${mv.text.slice(0, 200)}`)
    console.log(`      (info) refusal text: ${mv.text.slice(0, 200)}`)
    await sb.from("store_import_runs").delete().eq("id", run.id)
    check("M3 back to 'drive' when the run is gone", (await g.companyDocState(tc.id)) === "drive", String(await g.companyDocState(tc.id)))
  }

  // (the Drive-write guard against the real TEST Drive is t5-guard-live-drive.ts)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
