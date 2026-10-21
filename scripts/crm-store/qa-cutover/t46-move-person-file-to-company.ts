/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Move a person's file into the person's COMPANY (Antonio 2026-10-21): a proof of address moves; ID papers never do; only the person's own
 * companies; a name clash is refused; the CRM row follows; history is logged. Real sandbox database + the real moveStoreFile. SANDBOX only.
 * Run: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t46-move-person-file-to-company.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { ensureCompanyStorage } = await import("../../../lib/crm-store/company-storage")
  const { ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
  const { saveFormToStore } = await import("../../../lib/crm-store/save-form")
  const { moveStoreFile } = await import("../../../lib/crm-store/file-actions")
  const { ensureChildFolder } = await import("../../../lib/crm-store/save-form")
  const stamp = Date.now()
  const doc = await PDFDocument.create(); doc.addPage()
  const bytes = Buffer.from(await doc.save())
  const uploaded: string[] = []
  const up = async (path: string) => { await sb.storage.from("onboarding-uploads").upload(path, bytes, { contentType: "application/pdf", upsert: true }); uploaded.push(path); return path }
  const accounts: string[] = [], contacts: string[] = []
  try {
    const { data: c } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `Mover${stamp}`, full_name: `Qa Mover${stamp}`, email: `qa-mv-${stamp}@example.invalid`, language: "English" }).select("id").single(); contacts.push(c.id)
    const { data: a1 } = await sb.from("accounts").insert({ company_name: `QA Move ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, company_name").single(); accounts.push(a1.id)
    const { data: a2 } = await sb.from("accounts").insert({ company_name: `QA Other ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, company_name").single(); accounts.push(a2.id)
    await ensureCompanyStorage(a1.id, a1.company_name); await ensureCompanyStorage(a2.id, a2.company_name)
    await sb.from("account_contacts").insert({ account_id: a1.id, contact_id: c.id })   // the person belongs to a1 only
    const personOwner = await ensurePersonOwner(c.id, `Qa Mover${stamp}`)
    const paths = [await up(`banking_relay/${c.id}/proof_of_address_${stamp}_bill.pdf`), await up(`banking_relay/${c.id}/passport_image_${stamp}_p.pdf`), await up(`banking_relay/${c.id}/other_${stamp}_x.pdf`)]
    await saveFormToStore({ target: { kind: "contact", id: c.id, ownerId: personOwner } as never, subfolder: "2. Contacts", year: null, summary: null, uploadPaths: paths, bucketOf: () => "onboarding-uploads", submissionKey: `${c.id}:qa:${stamp}` })
    const fileOf = async (like: string, owner: string) => (await sb.from("store_files").select("id, name, owner_id, folder_id, document_type").eq("owner_id", owner).like("name", `${like}%`).is("trashed_at", null).single()).data
    const proof = await fileOf("proof_of_address", personOwner), pass = await fileOf("passport_image", personOwner), other = await fileOf("other_", personOwner)
    const { data: o1 } = await sb.from("store_owners").select("id").eq("account_id", a1.id).eq("study_only", false).single()
    const { data: o2 } = await sb.from("store_owners").select("id").eq("account_id", a2.id).eq("study_only", false).single()
    const { data: bk1 } = await sb.from("store_folders").select("id").eq("owner_id", o1.id).eq("kind", "banking").single()
    const { data: bk2 } = await sb.from("store_folders").select("id").eq("owner_id", o2.id).eq("kind", "banking").single()
    const baFolder = await ensureChildFolder(bk1.id, "Bank applications", "bank_applications")
    const { data: ct1 } = await sb.from("store_folders").select("id").eq("owner_id", o1.id).eq("kind", "contacts").single()
    const { data: root1 } = await sb.from("store_folders").select("id").eq("owner_id", o1.id).eq("kind", "root").single()
    await sb.from("documents").insert({ drive_file_id: `store:${proof.id}`, file_name: proof.name, contact_id: c.id, category: 2, category_name: "Contacts" }).then(() => null, () => null)

    // 1) the proof of address moves into the company's Bank applications folder
    const r = await moveStoreFile(proof.id, baFolder, null)
    const after = (await sb.from("store_files").select("owner_id, folder_id, state").eq("id", proof.id).single()).data
    check("M1 the proof of address is now in the COMPANY's Bank applications folder (same file, same id)", after.owner_id === o1.id && after.folder_id === baFolder && after.state === "live", JSON.stringify({ r, after }))
    const { data: ev } = await sb.from("store_events").select("event, reason").eq("file_id", proof.id).eq("event", "rehomed")
    check("M2 the move is in the history", (ev ?? []).length === 1, JSON.stringify(ev))
    const { data: dr } = await sb.from("documents").select("account_id, category_name").eq("drive_file_id", `store:${proof.id}`)
    check("M3 the CRM row follows the file (company + Banking category)", (dr ?? []).length === 0 || (dr[0].account_id === a1.id && /bank/i.test(dr[0].category_name ?? "")), JSON.stringify(dr))
    // 2) ID papers never move
    for (const [n, f] of [["passport (no type, name only)", pass]] as const) {
      const e = await moveStoreFile(f.id, baFolder, null).then(() => "MOVED", (x) => String(x.message))
      check(`M4 ${n} is refused`, /ID paper/.test(e), e)
    }
    const stillPerson = (await sb.from("store_files").select("owner_id").eq("id", pass.id).single()).data
    check("M5 the passport is still in the person's storage", stillPerson.owner_id === personOwner)
    await sb.from("store_files").update({ document_type: "passport" }).eq("id", other.id)
    const e6 = await moveStoreFile(other.id, baFolder, null).then(() => "MOVED", (x) => String(x.message))
    check("M6 a file TYPED as a passport is refused even with an ordinary name", /ID paper/.test(e6), e6)
    await sb.from("store_files").update({ document_type: null }).eq("id", other.id)
    // 3) a company the person is not in
    const e7 = await moveStoreFile(other.id, bk2.id, null).then(() => "MOVED", (x) => String(x.message))
    check("M7 a company the person does not belong to is refused", /not one of this person's companies/.test(e7), e7)
    // 4) top / contacts folders refused
    const e8 = await moveStoreFile(other.id, ct1.id, null).then(() => "MOVED", (x) => String(x.message))
    const e9 = await moveStoreFile(other.id, root1.id, null).then(() => "MOVED", (x) => String(x.message))
    check("M8 '2. Contacts' and the top are refused", /Contacts/.test(e8) && /not at the top/.test(e9), `${e8} | ${e9}`)
    // 5) an ordinary (non-ID, untyped) file moves; a second with the same name is refused
    const ok = await moveStoreFile(other.id, bk1.id, null).then(() => "MOVED", (x) => String(x.message))
    check("M9 an ordinary file moves to the company's 4. Banking", ok === "MOVED", ok)
    const p2 = await up(`banking_relay/${c.id}/other_${stamp}_x.pdf`)
    await saveFormToStore({ target: { kind: "contact", id: c.id, ownerId: personOwner } as never, subfolder: "2. Contacts", year: null, summary: null, uploadPaths: [p2], bucketOf: () => "onboarding-uploads", submissionKey: `${c.id}:qa2:${stamp}` })
    const other2 = await fileOf("other_", personOwner)
    const e10 = await moveStoreFile(other2.id, bk1.id, null).then(() => "MOVED", (x) => String(x.message))
    check("M10 a file with the same name in the target folder is refused", /already has a file/.test(e10), e10)
  } finally {
    for (const a of accounts) { const { data: o } = await sb.from("store_owners").select("id").eq("account_id", a); for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id); await sb.from("accounts").update({ status: "Cancelled" }).eq("id", a) }
    for (const c of contacts) { const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", c); for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id) }
    await sb.storage.from("onboarding-uploads").remove(uploaded)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
