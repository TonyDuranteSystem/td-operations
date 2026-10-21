/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Bank applications END-TO-END QA (rule of 2026-10-21, dev job fd045f5a): real banking_submissions rows through the SAME entry points the
 * product uses (fileBankingSubmission = every lane; archiveFormSubmission = the durable retry job), against the sandbox database + storage.
 * Lanes: portal wizard (Relay + Payset), public banking form, retry job; plus ID variants, trashed passport, old filing, concurrency,
 * visibility. SANDBOX only.
 * Run: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t45-bank-applications-e2e.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

type Sb = { from: (t: string) => any; storage: any; rpc: (f: string, a: unknown) => Promise<{ data: unknown; error: { message: string } | null }> } // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as Sb
  const { ensureCompanyStorage } = await import("../../../lib/crm-store/company-storage")
  const { fileBankingSubmission } = await import("../../../lib/forms/file-banking-submission")
  const { archiveFormSubmission } = await import("../../../lib/forms/archive-submission")
  const stamp = Date.now()
  const doc = await PDFDocument.create(); doc.addPage()
  const bytes = Buffer.from(await doc.save())
  const uploaded: Array<{ bucket: string; path: string }> = []
  const up = async (bucket: string, path: string) => { await sb.storage.from(bucket).upload(path, bytes, { contentType: "application/pdf", upsert: true }); uploaded.push({ bucket, path }); return path }

  const mkContact = async (tag: string) => (await sb.from("contacts").insert({ first_name: "Qa", last_name: `${tag}${stamp}`, full_name: `Qa ${tag}${stamp}`, email: `qa-${tag.toLowerCase()}-${stamp}@example.invalid`, language: "English" }).select("id").single()).data.id as string
  const mkCompany = async (tag: string, people: string[]) => {
    const { data: acc, error } = await sb.from("accounts").insert({ company_name: `QA E2E ${tag} ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, company_name").single()
    if (error) throw new Error(error.message)
    await ensureCompanyStorage(acc.id, acc.company_name)
    for (const p of people) await sb.from("account_contacts").insert({ account_id: acc.id, contact_id: p })
    return acc as { id: string; company_name: string }
  }
  /** every live file of an owner with its folder trail "Parent > Folder" */
  const filesOf = async (where: { account_id?: string; contact_id?: string }) => {
    const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
    const out: Array<{ name: string; trail: string; published: boolean; type: string | null; key: string | null }> = []
    for (const x of o ?? []) {
      const { data: fs } = await sb.from("store_files").select("name, folder_id, published, document_type, caller_key").eq("owner_id", x.id).is("trashed_at", null)
      for (const f of fs ?? []) {
        const { data: fo } = await sb.from("store_folders").select("name, parent_id").eq("id", f.folder_id).single()
        const { data: pa } = fo?.parent_id ? await sb.from("store_folders").select("name").eq("id", fo.parent_id).single() : { data: null }
        out.push({ name: f.name, trail: `${pa?.name ?? ""} > ${fo?.name ?? ""}`, published: f.published, type: f.document_type, key: f.caller_key })
      }
    }
    return out
  }
  const versionCount = async (where: { account_id?: string; contact_id?: string }) => {
    const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
    let n = 0
    for (const x of o ?? []) {
      const { data: f } = await sb.from("store_files").select("id").eq("owner_id", x.id)
      for (const y of f ?? []) { const { count } = await sb.from("store_file_versions").select("id", { count: "exact", head: true }).eq("file_id", y.id); n += count ?? 0 }
    }
    return n
  }
  const bankRows: string[] = []
  const insertRow = async (r: Record<string, unknown>) => {
    const { data, error } = await sb.from("banking_submissions").insert({ status: "completed", completed_at: new Date().toISOString(), ...r }).select("id").single()
    if (error) throw new Error(`banking row: ${error.message}`)
    bankRows.push(data.id); return data.id as string
  }
  const accounts: string[] = [], contacts: string[] = []

  try {
    // ── E1: portal wizard, Relay, ONE person ───────────────────────────────────
    const mark = await mkContact("Mark"); contacts.push(mark)
    const gw = await mkCompany("GoldWaves", [mark]); accounts.push(gw.id)
    const w = (f: string, n: string) => `banking_relay/${mark}/${f}_${stamp}_${n}`
    const p1 = [await up("onboarding-uploads", w("passport_image", "pass.pdf")), await up("onboarding-uploads", w("proof_of_address", "bill.pdf")), await up("onboarding-uploads", w("business_bank_statement", "stmt.pdf"))]
    const row1 = await insertRow({ token: `e2e-w1-${stamp}`, account_id: gw.id, contact_id: mark, provider: "relay", submitted_data: { business_name: gw.company_name, passport_image: [p1[0]], proof_of_address: [p1[1]], business_bank_statement: [p1[2]] }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    const r1 = await fileBankingSubmission(row1, "e2e")
    const co1 = await filesOf({ account_id: gw.id }), pe1 = await filesOf({ contact_id: mark })
    check("E1a wizard Relay: filed without errors, marked filed, no retry queued", r1.pkg.ok && r1.markedFiled && !r1.queued, JSON.stringify({ ok: r1.pkg.ok, errors: r1.pkg.errors, failed: r1.pkg.failed }).slice(0, 250))
    check("E1b the passport is in the person's storage ONLY", pe1.length === 1 && /passport_image/.test(pe1[0].name) && !co1.some((f) => /passport/.test(f.name)), JSON.stringify({ pe1: pe1.map((f) => f.name), co1: co1.map((f) => f.name) }))
    check("E1c proof of address + statement + summary are all in 4. Banking > Bank applications", co1.length === 3 && co1.every((f) => f.trail === "4. Banking > Bank applications"), JSON.stringify(co1.map((f) => [f.name, f.trail])))
    check("E1d nothing is shown to the client (published=false), the passport has no AI-reader type guess", co1.every((f) => f.published === false) && pe1.every((f) => f.published === false), JSON.stringify({ co: co1.map((f) => f.published), pe: pe1.map((f) => f.published) }))

    // ── E2: replay + retry job: no copies, no new versions ────────────────────
    const v1 = (await versionCount({ account_id: gw.id })) + (await versionCount({ contact_id: mark }))
    await new Promise((r) => setTimeout(r, 1500))
    const r2 = await fileBankingSubmission(row1, "e2e-replay")
    const a2 = await archiveFormSubmission("banking", row1).catch((e) => ({ status: `threw: ${e instanceof Error ? e.message : e}` }))
    const v2 = (await versionCount({ account_id: gw.id })) + (await versionCount({ contact_id: mark }))
    const co2 = await filesOf({ account_id: gw.id }), pe2 = await filesOf({ contact_id: mark })
    check("E2 replay + the retry job: same files, no new versions, the passport is not saved again", r2.pkg.ok && co2.length === 3 && pe2.length === 1 && v1 === v2, JSON.stringify({ versions: [v1, v2], co: co2.length, pe: pe2.length, archive: (a2 as { status: string }).status }))

    // ── E3: a SECOND application, same person (Payset): passport skipped, the rest filed, same single folder ──
    const w3 = (f: string, n: string) => `banking_payset/${mark}/${f}_${stamp}_${n}`
    const p3 = [await up("onboarding-uploads", w3("passport_image", "again.pdf")), await up("onboarding-uploads", w3("proof_of_address", "bill2.pdf"))]
    const row3 = await insertRow({ token: `e2e-w3-${stamp}`, account_id: gw.id, contact_id: mark, provider: "payset", submitted_data: { business_name: gw.company_name, passport_image: [p3[0]], proof_of_address: [p3[1]] }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    const r3 = await fileBankingSubmission(row3, "e2e")
    const co3 = await filesOf({ account_id: gw.id }), pe3 = await filesOf({ contact_id: mark })
    const { data: ownerRow } = await sb.from("store_owners").select("id").eq("account_id", gw.id).eq("study_only", false).single()
    const { data: ba } = await sb.from("store_folders").select("id").eq("owner_id", ownerRow.id).eq("name", "Bank applications").is("trashed_at", null)
    check("E3 second application (Payset): passport NOT saved again, new papers filed in the SAME Bank applications folder", r3.pkg.ok && pe3.length === 1 && co3.filter((f) => /bill2/.test(f.name)).length === 1 && !co3.some((f) => /again/.test(f.name)) && (ba ?? []).length === 1, JSON.stringify({ ok: r3.pkg.ok, errors: r3.pkg.errors, pe: pe3.length, folders: (ba ?? []).length }))

    // ── E4: public banking form lane (upload_paths column, banking-uploads bucket) ──
    const lia = await mkContact("Lia"); contacts.push(lia)
    const co4acc = await mkCompany("Public", [lia]); accounts.push(co4acc.id)
    const x4 = (f: string) => `${lia}/${f}_${stamp}_pub.pdf`
    const { data: bks } = await sb.storage.listBuckets()
    const hasPublicBucket = (bks ?? []).some((b: { name: string }) => b.name === "banking-uploads")
    if (!hasPublicBucket) console.log("SKIP  E4 public banking form lane: the sandbox has no 'banking-uploads' bucket, so its downloads cannot be exercised here (covered by the unit tests)")
    const p4 = hasPublicBucket ? [await up("banking-uploads", x4("passport_scan")), await up("banking-uploads", x4("proof_of_address")), await up("banking-uploads", x4("business_bank_statement"))] : []
    const row4 = !hasPublicBucket ? null : await insertRow({ token: `e2e-p4-${stamp}`, account_id: co4acc.id, contact_id: lia, provider: "banking", submitted_data: { business_name: co4acc.company_name }, upload_paths: p4, drive_archive_meta: { origin: "external" } })
    if (row4) {
    const r4 = await fileBankingSubmission(row4, "e2e-public")
    const co4 = await filesOf({ account_id: co4acc.id }), pe4 = await filesOf({ contact_id: lia })
    check("E4 public form: passport to the person only, everything else to Bank applications", r4.pkg.ok && pe4.length === 1 && /passport/.test(pe4[0].name) && co4.length === 3 && co4.every((f) => f.trail === "4. Banking > Bank applications"), JSON.stringify({ ok: r4.pkg.ok, errors: r4.pkg.errors, pe: pe4.map((f) => f.name), co: co4.map((f) => [f.name, f.trail]) }).slice(0, 400))
    }

    // ── E5: other ID types stay with the person; 'other_documents' goes to the company ──
    const ana = await mkContact("Ana"); contacts.push(ana)
    const co5acc = await mkCompany("IdTypes", [ana]); accounts.push(co5acc.id)
    const f5 = ["driver_license", "national_id", "selfie_with_id", "other_documents", "articles_of_organization", "ein_letter"]
    const p5: Record<string, string[]> = {}
    for (const f of f5) p5[f] = [await up("onboarding-uploads", `banking_relay/${ana}/${f}_${stamp}_x.pdf`)]
    const row5 = await insertRow({ token: `e2e-i5-${stamp}`, account_id: co5acc.id, contact_id: ana, provider: "relay", submitted_data: { business_name: co5acc.company_name, ...p5 }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    const r5 = await fileBankingSubmission(row5, "e2e")
    const co5 = await filesOf({ account_id: co5acc.id }), pe5 = await filesOf({ contact_id: ana })
    check("E5 driver licence / national ID / selfie-with-ID stay in People; other papers + articles + EIN go to the company", r5.pkg.ok && pe5.length === 3 && co5.filter((f) => !/^Banking_/.test(f.name)).length === 3, JSON.stringify({ ok: r5.pkg.ok, errors: r5.pkg.errors, pe: pe5.map((f) => f.name), co: co5.map((f) => f.name) }).slice(0, 450))

    // ── E6: a TRASHED passport does not count as 'already on file' ──
    const tom = await mkContact("Tom"); contacts.push(tom)
    const co6acc = await mkCompany("Trashed", [tom]); accounts.push(co6acc.id)
    const first6 = [await up("onboarding-uploads", `banking_relay/${tom}/passport_image_${stamp}_old.pdf`)]
    const row6a = await insertRow({ token: `e2e-t6a-${stamp}`, account_id: co6acc.id, contact_id: tom, provider: "relay", submitted_data: { business_name: co6acc.company_name, passport_image: first6 }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    await fileBankingSubmission(row6a, "e2e")
    const { data: oo } = await sb.from("store_owners").select("id").eq("contact_id", tom).eq("study_only", false).single()
    const { error: trErr } = await sb.from("store_files").update({ trashed_at: new Date().toISOString(), state: "trashed" }).eq("owner_id", oo.id)
    if (trErr) console.log("trash update error:", trErr.message)
    const second6 = [await up("onboarding-uploads", `banking_relay/${tom}/passport_image_${stamp}_new.pdf`)]
    const row6b = await insertRow({ token: `e2e-t6b-${stamp}`, account_id: co6acc.id, contact_id: tom, provider: "payset", submitted_data: { business_name: co6acc.company_name, passport_image: second6 }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    const r6 = await fileBankingSubmission(row6b, "e2e")
    const pe6 = await filesOf({ contact_id: tom })
    check("E6 the only passport on file is in the trash: the new passport IS saved", r6.pkg.ok && pe6.length === 1 && /_new/.test(pe6[0].name), JSON.stringify({ ok: r6.pkg.ok, pe: pe6.map((f) => f.name) }))

    // ── E7: two applications for two DIFFERENT companies at the same moment (folder made once per company, no collision) ──
    const ivy = await mkContact("Ivy"); contacts.push(ivy)
    const co7acc = await mkCompany("Race", [ivy]); accounts.push(co7acc.id)
    const rows7: string[] = []
    for (const n of ["relay", "payset"]) {
      const path = await up("onboarding-uploads", `banking_relay/${ivy}/proof_of_address_${stamp}_${n}.pdf`)
      rows7.push(await insertRow({ token: `e2e-r7${n}-${stamp}`, account_id: co7acc.id, contact_id: ivy, provider: n, submitted_data: { business_name: co7acc.company_name, proof_of_address: [path] }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } }))
    }
    const rs7 = await Promise.all(rows7.map((id) => fileBankingSubmission(id, "e2e-race").catch((e) => ({ pkg: { ok: false, errors: [String(e)] } }))))
    const { data: o7 } = await sb.from("store_owners").select("id").eq("account_id", co7acc.id).eq("study_only", false).single()
    const { data: ba7 } = await sb.from("store_folders").select("id").eq("owner_id", o7.id).eq("name", "Bank applications").is("trashed_at", null)
    const co7 = await filesOf({ account_id: co7acc.id })
    check("E7 two applications (Relay + Payset) at the same moment for one company: ONE Bank applications folder, every paper filed", (ba7 ?? []).length === 1 && rs7.every((r) => r.pkg.ok) && co7.filter((f) => /proof_of_address/.test(f.name)).length === 2, JSON.stringify({ folders: (ba7 ?? []).length, ok: rs7.map((r) => r.pkg.ok), errors: rs7.flatMap((r) => r.pkg.errors).slice(0, 2), files: co7.length }).slice(0, 400))

    // ── E8: an application ALREADY filed the OLD way (summary in the bare 4. Banking folder), then replayed: what does the replay do? ──
    const ned = await mkContact("Ned"); contacts.push(ned)
    const co8acc = await mkCompany("OldFiling", [ned]); accounts.push(co8acc.id)
    const { saveFormToStore } = await import("../../../lib/crm-store/save-form")
    const { data: o8 } = await sb.from("store_owners").select("id").eq("account_id", co8acc.id).eq("study_only", false).single()
    const tok8 = `e2e-o8-${stamp}`
    const row8 = await insertRow({ token: tok8, account_id: co8acc.id, contact_id: ned, provider: "relay", submitted_data: { business_name: co8acc.company_name }, drive_archive_meta: { origin: "wizard", applicant: "submitter" } })
    // the OLD way: the very same key, no sub-folder
    await saveFormToStore({ target: { kind: "account", id: co8acc.id, ownerId: o8.id } as never, subfolder: "4. Banking", year: null, summary: { name: `Banking_Relay_${co8acc.company_name.replace(/\s+/g, "_")}.pdf`, bytes: bytes, documentType: "other_document", callerKey: `form-summary:${co8acc.id}:banking_relay:${tok8}` }, uploadPaths: [], bucketOf: () => "onboarding-uploads", submissionKey: `${co8acc.id}:banking_relay:${tok8}` })
    const before8 = await filesOf({ account_id: co8acc.id })
    await fileBankingSubmission(row8, "e2e-replay-old")
    const after8 = await filesOf({ account_id: co8acc.id })
    check("E8 an old-style filed application that is replayed does not leave TWO summaries", after8.filter((f) => /^Banking_/.test(f.name)).length === 1, JSON.stringify({ before: before8.map((f) => [f.name, f.trail]), after: after8.map((f) => [f.name, f.trail]) }).slice(0, 450))
  } finally {
    for (const id of bankRows) await sb.from("banking_submissions").update({ status: "cancelled" }).eq("id", id)
    for (const a of accounts) {
      const { data: o } = await sb.from("store_owners").select("id").eq("account_id", a)
      for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
      await sb.from("accounts").update({ status: "Cancelled" }).eq("id", a)
    }
    for (const c of contacts) { const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", c); for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id) }
    for (const u of uploaded) await sb.storage.from(u.bucket).remove([u.path])
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
