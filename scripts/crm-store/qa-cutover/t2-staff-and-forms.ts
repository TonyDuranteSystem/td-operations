/* eslint-disable no-console */
/**
 * Phase 3 QA t2 (bug-hunter rows 6, 7, 19, 21): staff company upload, staff contact upload (person's own storage, OCR path),
 * workflow task file, and every form summary through the ONE seam saveFormToDrive. SANDBOX only.
 * Run: npx tsx scripts/crm-store/qa-cutover/t2-staff-and-forms.ts
 */
import { config } from "dotenv"
import { call, check, pdf, sessionCookie, summary, form } from "./qa-http"
config({ path: ".env.local" })

const UX = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"

async function main() {
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const t0 = new Date().toISOString()
  const staff = await sessionCookie("staff")
  const clientUx = await sessionCookie("clientUx")

  const stage = async (name: string, data: Buffer, type = "application/pdf") => {
    const path = `qa-cutover/${Date.now()}-${name}`
    const { error } = await sb.storage.from("onboarding-uploads").upload(path, data, { contentType: type, upsert: true })
    if (error) throw new Error(`could not stage ${name}: ${error.message}`)
    return path
  }

  // ── row 6: staff uploads a company document, shown to the client ──────────────────────────────────────────
  const p6 = await stage("QA Test staff doc.pdf", pdf("staff company doc"))
  const r6 = await call("/api/crm/admin-actions/upload-account-document", { cookie: staff, json: { account_id: UX, storage_path: p6, file_name: "QA Test staff doc.pdf", mime_type: "application/pdf", document_type: "QA Test staff doc", category: "Company" } })
  const b6 = r6.json as { success?: boolean; driveFileId?: string; detail?: string } | null
  check("6a staff company upload accepted", r6.status === 200 && b6?.success === true, `HTTP ${r6.status} ${r6.text.slice(0, 160)}`)
  check("6b stored as a pointer (no Drive id)", !!b6?.driveFileId?.startsWith("store:"), `driveFileId=${b6?.driveFileId}`)
  const { data: d6 } = await sb.from("documents").select("id, portal_visible, document_type_name, category, drive_link").eq("drive_file_id", b6?.driveFileId).maybeSingle()
  check("6c listed and shown to the client (as the Drive path does)", d6?.portal_visible === true, `portal_visible=${d6?.portal_visible} link=${d6?.drive_link}`)
  const { data: f6 } = await sb.from("store_files").select("document_type, published").eq("id", String(b6?.driveFileId).replace("store:", "")).maybeSingle()
  check("6d typed + published in the storage too (the store and the CRM row say the same)", f6?.document_type === "other_document" && f6?.published === true, `type=${f6?.document_type} published=${f6?.published}`)
  const o6 = await call(`/api/portal/documents/${d6?.id}`, { cookie: clientUx })
  check("6e the client opens it", o6.status === 200 && o6.bytes.length > 10, `HTTP ${o6.status}`)
  const staffOpen = await call(`/api/documents/${d6?.id}/preview`, { cookie: staff })
  check("6f staff open it in the CRM", staffOpen.status === 200, `HTTP ${staffOpen.status}`)

  // ── row 7: staff uploads a passport for a member (person storage) ─────────────────────────────────────────
  const { data: ownerBefore } = await sb.from("store_owners").select("id, study_only").eq("contact_id", UX_CONTACT).eq("kind", "person")
  console.log(`      (info) person storage before: ${JSON.stringify(ownerBefore)}`)
  const p7 = await stage("QA Test passport.pdf", pdf("passport"))
  const r7 = await call("/api/crm/admin-actions/upload-document", { cookie: staff, json: { contact_id: UX_CONTACT, storage_path: p7, file_name: "QA Test passport.pdf", mime_type: "application/pdf", document_type: "Passport", category: "Contacts" } })
  const b7 = r7.json as { success?: boolean; detail?: string; side_effects?: string[] } | null
  check("7a staff passport upload accepted", r7.status === 200 && b7?.success === true, `HTTP ${r7.status} ${r7.text.slice(0, 200)}`)
  const { data: d7 } = await sb.from("documents").select("id, drive_file_id, account_id, contact_id, category, portal_visible").eq("contact_id", UX_CONTACT).gt("created_at", t0).like("drive_file_id", "store:%").order("created_at", { ascending: false }).limit(1)
  const row7 = (d7 ?? [])[0]
  check("7b listed as a storage pointer for the PERSON", !!row7, `row=${JSON.stringify(row7)}`)
  if (row7) {
    const fid = row7.drive_file_id.replace("store:", "")
    const { data: sf } = await sb.from("store_files").select("owner_id, document_type").eq("id", fid).maybeSingle()
    const { data: ow } = await sb.from("store_owners").select("kind, contact_id").eq("id", sf?.owner_id).maybeSingle()
    check("7c the file sits in the person's OWN storage, not the company's", ow?.kind === "person" && ow?.contact_id === UX_CONTACT, `owner=${JSON.stringify(ow)} type=${sf?.document_type}`)
    check("7d typed as a passport", sf?.document_type === "passport", `type=${sf?.document_type}`)
  }
  console.log(`      (info) side effects: ${JSON.stringify(b7?.side_effects)}`)

  // ── row 19: a workflow task file ──────────────────────────────────────────────────────────────────────────
  let { data: task } = await sb.from("tasks").select("id").eq("account_id", UX).limit(1).maybeSingle()
  if (!task) {
    // eslint-disable-next-line no-restricted-syntax -- a QA fixture task in the SANDBOX
    const ins = await sb.from("tasks").insert({ task_title: "QA Test cutover task", assigned_to: "Luca", status: "To Do", priority: "Normal", category: "Document", account_id: UX, description: "QA Test" }).select("id").single()
    task = ins.data
  }
  const f19 = form({ task_id: task!.id as string, subfolder: "3. Tax/2025" }, { name: "QA Test task file.pdf", data: pdf("task file"), type: "application/pdf" })
  const r19 = await call("/api/workflows/upload-task-file", { cookie: staff, form: f19 })
  const b19 = r19.json as { file_id?: string; drive_url?: string | null; error?: string } | null
  check("19a task file accepted and returns a storage pointer", r19.status === 200 && !!b19?.file_id?.startsWith("store:") && b19?.drive_url === null, `HTTP ${r19.status} ${r19.text.slice(0, 160)}`)
  if (b19?.file_id) {
    const { data: sf } = await sb.from("store_files").select("folder_id, document_type, published").eq("id", b19.file_id.replace("store:", "")).maybeSingle()
    const { data: fo } = await sb.from("store_folders").select("name, parent_id").eq("id", sf?.folder_id).maybeSingle()
    const { data: po } = await sb.from("store_folders").select("name").eq("id", fo?.parent_id).maybeSingle()
    check("19b filed in 3. Tax › 2025, internal", `${po?.name} › ${fo?.name}` === "3. Tax › 2025" && sf?.published === false, `${po?.name} › ${fo?.name} published=${sf?.published}`)
  }

  // ── row 21: every form summary through the ONE seam ───────────────────────────────────────────────────────
  const { data: acct } = await sb.from("accounts").select("drive_folder_id, company_name").eq("id", UX).single()
  const folder = acct!.drive_folder_id as string
  const { saveFormToDrive } = await import("../../../lib/form-to-drive")
  const sample = { company_name: "Uxio Test LLC", llc_name: "Uxio Test LLC", owner_first_name: "Uxio", owner_last_name: "Test", first_name: "Uxio", last_name: "Test", email: "uxio@example.test", owner_email: "uxio@example.test" }
  const token = `qa-${Date.now()}`
  const kinds: Array<{ type: string; expectTop: string; year?: number; staffOnly?: boolean }> = [
    { type: "tax_return", expectTop: "3. Tax", year: 2025 },
    { type: "formation", expectTop: "1. Company", staffOnly: true },
    { type: "onboarding", expectTop: "1. Company" },
    { type: "banking", expectTop: "4. Banking" },
    { type: "closure", expectTop: "1. Company" },
  ]
  for (const k of kinds) {
    const r = await saveFormToDrive(k.type, sample, [], folder, { token: `${token}-${k.type}`, submittedAt: new Date().toISOString(), companyName: "Uxio Test LLC", year: k.year })
    check(`21 ${k.type}: summary saved in the storage (no error)`, !!r.summaryFileId?.startsWith("store:") && r.errors.length === 0, `summary=${r.summaryFileId} errors=${JSON.stringify(r.errors)}`)
    if (r.summaryFileId) {
      const { data: sf } = await sb.from("store_files").select("folder_id, document_type").eq("id", r.summaryFileId.replace("store:", "")).maybeSingle()
      const { data: fo } = await sb.from("store_folders").select("name, parent_id, kind").eq("id", sf?.folder_id).maybeSingle()
      const { data: po } = fo?.parent_id ? await sb.from("store_folders").select("name").eq("id", fo.parent_id).maybeSingle() : { data: null }
      const where = k.year ? `${po?.name} › ${fo?.name}` : fo?.name
      check(`21 ${k.type}: filed under ${k.year ? `${k.expectTop} › ${k.year}` : k.expectTop}`, where === (k.year ? `${k.expectTop} › ${k.year}` : k.expectTop), `where=${where} type=${sf?.document_type}`)
      if (k.staffOnly) check("21 formation summary keeps its staff-only type", sf?.document_type === "formation_summary", `type=${sf?.document_type}`)
      // re-submission with the same token → a version of the same file, never a second one
      const again = await saveFormToDrive(k.type, sample, [], folder, { token: `${token}-${k.type}`, submittedAt: new Date().toISOString(), companyName: "Uxio Test LLC", year: k.year })
      check(`21 ${k.type}: re-submitting gives the SAME file`, again.summaryFileId === r.summaryFileId, `${r.summaryFileId} vs ${again.summaryFileId}`)
    }
  }

  // ── nothing written to Drive for this company in this run ─────────────────────────────────────────────────
  const { data: stray } = await sb.from("documents").select("id, drive_file_id").eq("account_id", UX).gt("created_at", t0).not("drive_file_id", "like", "store:%")
  check("Q3 no document of this run points at a Drive id", (stray ?? []).length === 0, `rows=${JSON.stringify(stray)}`)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
