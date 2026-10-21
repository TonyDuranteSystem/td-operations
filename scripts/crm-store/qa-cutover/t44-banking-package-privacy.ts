/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Bank applications QA (rule of 2026-10-21): a company in storage with NO Drive folder; the client's PASSPORT lands in the PERSON's
 * storage ONLY, the proof of address + the business statement + the summary PDF in the COMPANY's "4. Banking › Bank applications", a second
 * run files the same things (no second copies), and a passport the person already has is NOT saved again. SANDBOX only.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t44-banking-package-privacy.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any; rpc: (f: string, a: unknown) => Promise<{ data: string; error: { message: string } | null }> } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { ensureCompanyStorage } = await import("../../../lib/crm-store/company-storage")
  const { fileBankingPackage } = await import("../../../lib/forms/file-banking-package")
  const stamp = Date.now()
  const { data: contact } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `Bank${stamp}`, full_name: `Qa Bank${stamp}`, email: `qa-bank-${stamp}@example.invalid`, language: "English" }).select("id").single()
  const { data: acc, error } = await sb.from("accounts").insert({ company_name: `QA S1d Bank ${stamp} LLC`, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, company_name").single()
  if (error) throw new Error(error.message)
  await ensureCompanyStorage(acc.id, acc.company_name)
  const doc = await PDFDocument.create(); doc.addPage()
  const bytes = Buffer.from(await doc.save())
  const paths = [`banking_relay/${contact.id}/passport_image_${stamp}_front.pdf`, `banking_relay/${contact.id}/proof_of_address_${stamp}_bill.pdf`, `banking_relay/${contact.id}/business_bank_statement_${stamp}.pdf`]
  for (const p of paths) await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true })
  try {
    const run = () => fileBankingPackage({
      flow: "qa", formType: "banking_relay", accountId: acc.id, contactId: contact.id, submittedData: { business_name: acc.company_name, first_name: "Qa" },
      uploadPaths: paths, bucket: "onboarding-uploads", token: `qa-bank-${stamp}`, submittedAt: new Date().toISOString(), companyName: acc.company_name,
    })
    const r1 = await run()
    check("B1 the package was filed without errors", r1.ok, JSON.stringify({ errors: r1.errors, failed: r1.failed }).slice(0, 300))
    const names = async (where: { account_id?: string; contact_id?: string }) => {
      const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
      const out: string[] = []
      for (const x of o ?? []) { const { data: f } = await sb.from("store_files").select("name").eq("owner_id", x.id).is("trashed_at", null); out.push(...(f ?? []).map((y: { name: string }) => y.name)) }
      return out
    }
    // the number of VERSIONS stored (not files): a replay must not add one
    const versions = async (where: { account_id?: string; contact_id?: string }) => {
      const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
      let n = 0
      for (const x of o ?? []) {
        const { data: f } = await sb.from("store_files").select("id").eq("owner_id", x.id)
        for (const y of f ?? []) { const { count } = await sb.from("store_file_versions").select("id", { count: "exact", head: true }).eq("file_id", y.id); n += count ?? 0 }
      }
      return n
    }
    const v1 = (await versions({ account_id: acc.id })) + (await versions({ contact_id: contact.id }))
    const company = await names({ account_id: acc.id }), person = await names({ contact_id: contact.id })
    check("B2 the passport is in the PERSON's storage, and ONLY the passport", person.some((n) => /passport_image/.test(n)) && !person.some((n) => /proof_of_address/.test(n)), JSON.stringify(person))
    check("B3 the proof of address is in the company's storage and NO passport is", company.some((n) => /proof_of_address/.test(n)) && !company.some((n) => /passport/.test(n)), JSON.stringify(company))
    check("B4 the business statement and the summary PDF are in the company's storage", company.some((n) => /business_bank_statement/.test(n)) && company.some((n) => /^Banking_/.test(n)), JSON.stringify(company))
    {
      const { data: o } = await sb.from("store_owners").select("id").eq("account_id", acc.id).eq("study_only", false)
      const { data: fs } = await sb.from("store_files").select("name, folder_id").eq("owner_id", o[0].id).is("trashed_at", null)
      const ids = Array.from(new Set((fs ?? []).map((f: { folder_id: string }) => f.folder_id)))
      const { data: fo } = await sb.from("store_folders").select("id, name, parent_id").in("id", ids)
      const { data: par } = await sb.from("store_folders").select("id, name").in("id", (fo ?? []).map((f: { parent_id: string }) => f.parent_id))
      const where = (fo ?? []).map((f: { name: string; parent_id: string }) => `${(par ?? []).find((x: { id: string }) => x.id === f.parent_id)?.name} > ${f.name}`)
      check("B4b every company paper is filed in 4. Banking > Bank applications", where.length === 1 && /Banking > Bank applications$/.test(where[0]), JSON.stringify(where))
    }
    await new Promise((r) => setTimeout(r, 1500)) // a different clock second: the old PDF would have carried a new stamp
    const r2 = await run()
    const v2 = (await versions({ account_id: acc.id })) + (await versions({ contact_id: contact.id }))
    check("B5v running it again stores NO new VERSION of anything (two runs, same answers -> the same versions)", r2.ok && v2 === v1 && v1 > 0, `versions ${v1} -> ${v2}`)
    const company2 = await names({ account_id: acc.id }), person2 = await names({ contact_id: contact.id })
    check("B5 running it again files the SAME files (no second copies)", r2.ok && company2.length === company.length && person2.length === person.length, `${company.length}->${company2.length}, ${person.length}->${person2.length}`)
    const r3 = await fileBankingPackage({ flow: "qa", formType: "banking_relay", accountId: acc.id, contactId: null, submittedData: {}, uploadPaths: paths, bucket: "onboarding-uploads", token: `qa-bank-${stamp}`, companyName: acc.company_name })
    check("B6 with no person linked the personal papers are NOT filed (error), the company is untouched by them", !r3.ok && r3.failed.length >= 1, JSON.stringify(r3.failed).slice(0, 200))
    // B7: a package filed inline sets the SAME marker the archive job sets, so the sweep leaves the row alone (its "not filed" alarm clears)
    const { data: bs, error: bsErr } = await sb.from("banking_submissions").insert({ token: `qa-bank-row-${stamp}`, account_id: acc.id, contact_id: contact.id, provider: "relay", status: "completed", completed_at: new Date().toISOString(), submitted_data: {} }).select("id, token, status, created_at, drive_archived_at, drive_archive_meta, account_id, contact_id").single()
    if (bsErr) throw new Error(`banking row: ${bsErr.message}`)
    const { decideFormArchiveSweep } = await import("../../../lib/forms/archive-sweep")
    const { getArchiveRecipe } = await import("../../../lib/forms/archive-registry")
    const later = new Date(Date.now() + 60 * 60 * 1000)
    const before = decideFormArchiveSweep(bs, getArchiveRecipe("banking")!, later)
    const { markBankingSubmissionFiled } = await import("../../../lib/forms/mark-banking-filed")
    const marked = await markBankingSubmissionFiled(bs.id, { flow: "qa", summaryFileId: r1.summaryFileId, copied: r1.copied, folderId: r1.pinFolderId })
    const { data: after } = await sb.from("banking_submissions").select("id, token, status, created_at, drive_archived_at, drive_archive_meta").eq("id", bs.id).single()
    check("B7 before the marker the sweep would queue the row; after it the sweep skips it (the alarm clears)", before === "enqueue" && marked && decideFormArchiveSweep(after, getArchiveRecipe("banking")!, later) === "skip", `before=${before} marked=${marked} after=${decideFormArchiveSweep(after, getArchiveRecipe("banking")!, later)}`)
    await sb.from("banking_submissions").update({ status: "cancelled" }).eq("id", bs.id)

    // B8: a person with only a hidden STUDY copy of their storage: nothing is filed into it, the papers are held, ONE alarm
    const { data: study } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `Study${stamp}`, full_name: `Qa Study${stamp}`, email: `qa-study-${stamp}@example.invalid`, language: "English" }).select("id").single()
    const { data: so, error: soErr } = await sb.rpc("store_ensure_owner", { p_kind: "person", p_ref: study.id })
    if (soErr) throw new Error(`study owner: ${soErr.message}`)
    await sb.from("store_owners").update({ study_only: true }).eq("id", so)
    const r8 = await fileBankingPackage({ flow: "qa", formType: "banking_relay", accountId: acc.id, contactId: study.id, submittedData: {}, uploadPaths: paths, bucket: "onboarding-uploads", token: `qa-bank8-${stamp}`, companyName: acc.company_name })
    const { data: studyFiles } = await sb.from("store_files").select("name").eq("owner_id", so)
    check("B8 a person with only a hidden study copy: nothing filed into it, the papers are held (error), not reported filed", !r8.ok && r8.heldPersonal.length >= 1 && (studyFiles ?? []).length === 0, JSON.stringify({ held: r8.heldPersonal.length, files: (studyFiles ?? []).length }))
    // B9: WRONG MEMBER — the row was seeded with member A, member B submitted (the row records B): the papers go to B only
    const { data: memberB } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `MemberB${stamp}`, full_name: `Qa MemberB${stamp}`, email: `qa-b-${stamp}@example.invalid`, language: "English" }).select("id").single()
    await sb.from("account_contacts").insert([{ account_id: acc.id, contact_id: contact.id }, { account_id: acc.id, contact_id: memberB.id }])
    const { fileBankingSubmission } = await import("../../../lib/forms/file-banking-submission")
    const pathsB = [`banking_relay/${memberB.id}/passport_image_${stamp}_b.pdf`, `banking_relay/${memberB.id}/proof_of_address_${stamp}_b.pdf`]
    for (const p of pathsB) await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true })
    const data9 = { business_name: acc.company_name, passport_image: [pathsB[0]], proof_of_address: [pathsB[1]] }
    const { data: row9, error: r9err } = await sb.from("banking_submissions").insert({ token: `qa-bank9-${stamp}`, account_id: acc.id, contact_id: contact.id, provider: "payset", status: "completed", completed_at: new Date().toISOString(), submitted_data: data9, drive_archive_meta: { origin: "wizard" } }).select("id").single()
    if (r9err) throw new Error(`row9: ${r9err.message}`)
    const held = await fileBankingSubmission(row9.id, "qa-wrong-member")
    check("B9a seeded with member A, submitter unknown, TWO people in the company: B's papers are NOT filed under A (held, error)", !held.pkg.ok && held.pkg.heldPersonal.length === 1 && (await names({ contact_id: contact.id })).every((n) => !/_b\./.test(n)), JSON.stringify(held.pkg.failed).slice(0, 200))
    await sb.from("banking_submissions").update({ contact_id: memberB.id, drive_archive_meta: { origin: "wizard", applicant: "submitter" } }).eq("id", row9.id)
    const healed = await fileBankingSubmission(row9.id, "qa-wrong-member")
    const bNames = await names({ contact_id: memberB.id }), aNames = await names({ contact_id: contact.id })
    check("B9b once the row records B as the submitter the retry files B's papers in B's storage only", healed.pkg.ok && bNames.some((n) => /passport_image/.test(n)) && aNames.every((n) => !/_b\./.test(n)), JSON.stringify({ ok: healed.pkg.ok, bNames, errors: healed.pkg.errors }).slice(0, 300))
    await sb.from("banking_submissions").update({ status: "cancelled" }).eq("id", row9.id)
    for (const x of [study.id, memberB.id]) { const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", x); for (const y of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", y.id) }
    await sb.storage.from("onboarding-uploads").remove(pathsB)
    // B10: a SECOND application from the same person: the passport they already have is NOT saved again (one copy, under People)
    const paths10 = [`banking_relay/${contact.id}/passport_image_${stamp}_again.pdf`, `banking_relay/${contact.id}/proof_of_address_${stamp}_again.pdf`]
    for (const p of paths10) await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true })
    const before10 = (await names({ contact_id: contact.id })).filter((n) => /passport/.test(n)).length
    const r10 = await fileBankingPackage({ flow: "qa", formType: "banking_relay", accountId: acc.id, contactId: contact.id, submittedData: { business_name: acc.company_name }, uploadPaths: paths10, bucket: "onboarding-uploads", token: `qa-bank10-${stamp}`, companyName: acc.company_name })
    const after10 = (await names({ contact_id: contact.id })).filter((n) => /passport/.test(n)).length
    const companyNow = await names({ account_id: acc.id })
    check("B10 a second application: the passport is NOT saved again, the new proof of address is filed with the company", r10.ok && before10 === 1 && after10 === 1 && companyNow.some((n) => /proof_of_address.*again/.test(n)), JSON.stringify({ before10, after10, ok: r10.ok, errors: r10.errors }))
    await sb.storage.from("onboarding-uploads").remove(paths10)
  } finally {
    const { data: o } = await sb.from("store_owners").select("id").or(`account_id.eq.${acc.id},contact_id.eq.${contact.id}`)
    for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
    await sb.from("accounts").update({ status: "Cancelled" }).eq("id", acc.id)
    await sb.storage.from("onboarding-uploads").remove(paths)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
