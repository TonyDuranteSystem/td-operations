/* eslint-disable no-console, no-restricted-syntax -- sandbox QA script: prints its results and builds throw-away fixture rows directly */
/**
 * Stop Drive S2 (dev job 264bb882) — SANDBOX ONLY, REAL TEST Shared Drive, REAL local dev server: the staff routes that used to write
 * to Drive, called over HTTP as a signed-in staff member, against a company "left on Drive" (a real folder, no storage) and a Closed one.
 *
 * Proof = the TEST Drive's own state: the folder trees of both companies are listed before and after and must be IDENTICAL (nothing
 * created, renamed, moved or trashed), and a file placed in the folder must still be there untrashed after "Delete".
 * Controls: a company WITH storage still takes the same upload (200, saved in its storage), and the read route still lists the Drive folder.
 *
 * Run (dev server on QA_BASE, default http://localhost:3100):
 *   QA_BASE=http://localhost:3000 npx tsx scripts/crm-store/qa-cutover/t50-stop-drive-s2-routes.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })
import { call, sessionCookie, pdf, check, summary } from "./qa-http"

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // Uxio Test LLC — a company WITH storage (the fixture every document test uses)

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("sandbox only: refusing to run")
  const testDrive = (process.env.GOOGLE_SHARED_DRIVE_ID ?? "").trim()
  if (process.env.GOOGLE_DRIVE_LIVE !== "1" || !testDrive || testDrive === "0AOLZHXSfKUMHUk9PVA") throw new Error("needs the TEST Shared Drive (GOOGLE_DRIVE_LIVE=1, GOOGLE_SHARED_DRIVE_ID=<test drive>)")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await (await import("../_drive-fixture")).driveFixture()
  const realDrive = await import("../../../lib/google-drive")
  const staff = await sessionCookie("staff")

  const stamp = Date.now()
  const made: string[] = []
  const mk = async (parent: string, name: string) => { const f = await drive.createFolder(parent, name); made.push(f.id as string); return f.id as string }
  const folderF = await mk(testDrive, `QA Test S2 routes frozen ${stamp}`)
  const folderC = await mk(testDrive, `QA Test S2 routes closed ${stamp}`)
  const subF = await mk(folderF, "1. Company")
  const keep = await drive.uploadBinaryToDrive("QA Test keep me.pdf", pdf("keep"), "application/pdf", subF) as { id: string }
  made.push(keep.id)
  const base = { state_of_formation: "Wyoming", entity_type: "Single Member LLC" }
  const { data: F } = await sb.from("accounts").insert({ ...base, company_name: `QA S2 routes frozen ${stamp} LLC`, status: "Offboarding", drive_folder_id: folderF }).select("id").single()
  const { data: C } = await sb.from("accounts").insert({ ...base, company_name: `QA S2 routes closed ${stamp} LLC`, status: "Closed", drive_folder_id: folderC }).select("id").single()
  const { data: doc } = await sb.from("documents").insert({ file_name: "QA Test keep me.pdf", drive_file_id: keep.id, account_id: F.id, document_type_name: "Other", category: 1, status: "classified" }).select("id").single()

  // the whole tree (name, id, trashed) of a company folder, as the Drive itself reports it
  const tree = async (id: string): Promise<string[]> => {
    const out: string[] = []
    const walk = async (folder: string, path: string) => {
      const r = (await realDrive.listFolder(folder, 200)) as { files?: Array<{ id: string; name: string; mimeType: string }> } | Array<{ id: string; name: string; mimeType: string }>
      const files = Array.isArray(r) ? r : (r.files ?? [])
      for (const f of files) { out.push(`${path}/${f.name}#${f.id}`); if (f.mimeType === "application/vnd.google-apps.folder") await walk(f.id, `${path}/${f.name}`) }
    }
    await walk(id, "")
    return out.sort()
  }
  const stage = async (account: string) => {
    const path = `crm-account-uploads/${account}/${Date.now()}_qa-s2.pdf`
    const { error } = await sb.storage.from("onboarding-uploads").upload(path, pdf("route"), { contentType: "application/pdf" })
    if (error) throw new Error(`stage: ${error.message}`)
    return path
  }

  const beforeF = await tree(folderF), beforeC = await tree(folderC)
  let uxDocId: string | null = null
  try {
    // 1-2 staff upload to a company left on Drive / a Closed company
    for (const [label, acc, why] of [["left on Drive", F.id, /read-only/], ["Closed", C.id, /closed/]] as const) {
      const r = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: acc, storage_path: await stage(acc), file_name: "QA Test S2.pdf", mime_type: "application/pdf", document_type: "Other", category: "Company" } })
      check(`R1 upload-account-document, company ${label}: refused (409) with a plain sentence`, r.status === 409 && why.test(JSON.stringify(r.json)), JSON.stringify({ status: r.status, body: r.text.slice(0, 200) }).slice(0, 300))
    }
    // 3 control: a company WITH storage still takes it
    const ux = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: UX, storage_path: await stage(UX), file_name: "QA Test S2 storage ok.pdf", mime_type: "application/pdf", document_type: "Other", category: "Company" } })
    check("R2 control: the same upload for a company WITH storage works (saved in its storage, not Drive)", ux.status === 200 && (ux.json as { success?: boolean })?.success === true && String((ux.json as { driveFileId?: string })?.driveFileId).startsWith("store:"), JSON.stringify({ status: ux.status, body: ux.text.slice(0, 200) }).slice(0, 300))
    if (ux.status === 200) {
      const { data: d } = await sb.from("documents").select("id").eq("account_id", UX).eq("file_name", "QA Test S2 storage ok.pdf").order("created_at", { ascending: false }).limit(1)
      uxDocId = d?.[0]?.id ?? null
    }
    // 4 correspondence letter
    const f1 = new FormData(); f1.set("file", new Blob([new Uint8Array(pdf("letter"))], { type: "application/pdf" }), "QA Test letter.pdf"); f1.set("account_id", F.id)
    const corr = await call("/api/accounts/correspondence", { cookie: staff, form: f1 })
    check("R3 correspondence letter for a company left on Drive: refused (409), no letter recorded", corr.status === 409 && /read-only/.test(corr.text), JSON.stringify({ status: corr.status, body: corr.text.slice(0, 200) }).slice(0, 300))
    const { data: letters } = await sb.from("client_correspondence").select("id").eq("account_id", F.id)
    check("R3b no correspondence row was created", (letters ?? []).length === 0)
    // 5 the three removed file-manager routes
    for (const verb of ["rename", "move", "delete"]) {
      const r = await call(`/api/accounts/${F.id}/files/${verb}`, { cookie: staff, json: { fileId: keep.id, newName: "x", targetFolderId: folderC } })
      check(`R4 /files/${verb} is gone (404) — it cannot touch the Drive file`, r.status === 404, JSON.stringify({ status: r.status }).slice(0, 300))
    }
    // 6 the removed contact action
    const pd = await call("/api/crm/admin-actions/contact-actions", { cookie: staff, json: { contact_id: "00000000-0000-0000-0000-000000000000", action: "process_documents" } })
    check("R5 the contact action 'process_documents' (rebuilt a Drive folder) is gone", pd.status >= 400 || (pd.json as { success?: boolean })?.success === false, JSON.stringify({ status: pd.status, body: pd.text.slice(0, 200) }).slice(0, 300))
    // 7 delete-document on a raw-Drive record only removes the CRM listing
    const del = await call("/api/crm/admin-actions/delete-document", { cookie: staff, json: { document_id: doc.id } })
    check("R6 delete-document on a raw Drive record: 200, the listing is removed", del.status === 200 && (del.json as { success?: boolean })?.success === true, JSON.stringify({ status: del.status, body: del.text.slice(0, 200) }).slice(0, 300))
    const meta = (await realDrive.getFileMetadata(keep.id)) as { trashed?: boolean }
    check("R6b the Google Drive file itself was NOT trashed (the archive is read-only)", meta.trashed !== true, JSON.stringify(meta).slice(0, 300))
    // 8 the READ route still lists the Drive folder
    const rd = await call(`/api/accounts/${F.id}/files`, { cookie: staff })
    check("R7 control: reading the old Drive folder still works (the archive stays readable)", rd.status === 200 && /QA Test keep me/.test(rd.text), JSON.stringify({ status: rd.status, body: rd.text.slice(0, 200) }).slice(0, 300))

    // the proof: the Drive trees are exactly as they were
    const afterF = await tree(folderF), afterC = await tree(folderC)
    check("R8 the Drive folder of the company left on Drive is IDENTICAL before and after every call", JSON.stringify(beforeF) === JSON.stringify(afterF), JSON.stringify({ beforeF, afterF }).slice(0, 300))
    check("R9 the Drive folder of the Closed company is IDENTICAL before and after", JSON.stringify(beforeC) === JSON.stringify(afterC), JSON.stringify({ beforeC, afterC }).slice(0, 300))
  } finally {
    if (uxDocId) await call("/api/crm/admin-actions/delete-document", { cookie: staff, json: { document_id: uxDocId } }).catch(() => undefined)
    await sb.from("documents").delete().eq("account_id", F.id)
    await sb.from("accounts").delete().in("id", [F.id, C.id])
    for (const id of made.reverse()) await drive.trashFile(id).catch(() => undefined)
    summary()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
