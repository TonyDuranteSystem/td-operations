/* eslint-disable no-console */
/**
 * Phase 5 QA t13: the Storage page's upload for a LIVE (switched) company storage when the environment is NOT the sandbox pilot
 * (SANDBOX_MODE off — what production is). Needs a dev server on :3101 started with SANDBOX_MODE=0. SANDBOX database only.
 * Run: QA_BASE=http://localhost:3101 npx tsx scripts/crm-store/qa-cutover/t13-live-storage-upload-prodlike.ts
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const staff = await sessionCookie("staff")
  const stage = async (name: string) => { const p = `crm-uploads/store-staging/qa-${Date.now()}-${name}`; await sb.storage.from("onboarding-uploads").upload(p, pdf(name), { contentType: "application/pdf", upsert: true }); return p }

  const { data: live } = await sb.from("store_owners").select("id").eq("account_id", "30c2cd96-03e4-43cf-9536-81d961b18b1d").eq("study_only", false).maybeSingle()
  const { data: folder } = await sb.from("store_folders").select("id").eq("owner_id", live.id).eq("name", "1. Company").is("trashed_at", null).maybeSingle()
  const { data: study } = await sb.from("store_owners").select("id").eq("study_only", true).eq("kind", "company").limit(1).maybeSingle()
  const { data: studyFolder } = study ? await sb.from("store_folders").select("id").eq("owner_id", study.id).is("trashed_at", null).limit(1).maybeSingle() : { data: null }

  const up = await call("/api/crm-store/browse/upload", { cookie: staff, json: { ownerId: live.id, folderId: folder.id, storagePath: await stage("QA Test live upload.pdf"), fileName: "QA Test live upload.pdf", mimeType: "application/pdf", documentType: "other_document", visible: false } })
  console.log(`      (info) HTTP ${up.status} ${up.text.slice(0, 160)}`)
  check("L1 staff upload into a LIVE company storage works outside the pilot (the production case)", up.status === 200, `HTTP ${up.status} ${up.text.slice(0, 200)}`)
  const fileId = (up.json as { fileId?: string; id?: string } | null)?.fileId ?? (up.json as { id?: string } | null)?.id
  if (fileId) {
    const { data: f } = await sb.from("store_files").select("owner_id, published, document_type").eq("id", fileId).maybeSingle()
    check("L2 the file is in that storage, typed, and NOT shown to the client (we chose hidden)", f?.owner_id === live.id && f?.published === false && f?.document_type === "other_document", JSON.stringify(f))
  }
  if (study && studyFolder) {
    const blocked = await call("/api/crm-store/browse/upload", { cookie: staff, json: { ownerId: study.id, folderId: studyFolder.id, storagePath: await stage("QA Test study.pdf"), fileName: "QA Test study.pdf", mimeType: "application/pdf", documentType: "other_document", visible: false } })
    check("L3 a hidden STUDY copy is still refused here (not switched on)", blocked.status === 403, `HTTP ${blocked.status} ${blocked.text.slice(0, 120)}`)
  } else console.log("      (info) no study copy in the sandbox to test the refusal against")
  // reads still work
  const view = await call(`/api/crm-store/browse/folder?owner=${live.id}&folder=${folder.id}`, { cookie: staff })
  check("L4 the folder still opens for staff", view.status === 200, `HTTP ${view.status}`)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
