/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Stop Drive S1d QA: the banking package. A company in storage with NO Drive folder; the client's PASSPORT + PROOF OF ADDRESS must land
 * in the PERSON's storage, the business statement + the summary PDF in the COMPANY's, and a second run must file the same things (no
 * second copies). SANDBOX only.
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
    const company = await names({ account_id: acc.id }), person = await names({ contact_id: contact.id })
    check("B2 the passport and the proof of address are in the PERSON's storage", person.some((n) => /passport_image/.test(n)) && person.some((n) => /proof_of_address/.test(n)), JSON.stringify(person))
    check("B3 NO personal paper is in the company's storage", !company.some((n) => /passport|proof_of_address/.test(n)), JSON.stringify(company))
    check("B4 the business statement and the summary PDF are in the company's storage", company.some((n) => /business_bank_statement/.test(n)) && company.some((n) => /^Banking_/.test(n)), JSON.stringify(company))
    const r2 = await run()
    const company2 = await names({ account_id: acc.id }), person2 = await names({ contact_id: contact.id })
    check("B5 running it again files the SAME files (no second copies)", r2.ok && company2.length === company.length && person2.length === person.length, `${company.length}->${company2.length}, ${person.length}->${person2.length}`)
    const r3 = await fileBankingPackage({ flow: "qa", formType: "banking_relay", accountId: acc.id, contactId: null, submittedData: {}, uploadPaths: paths, bucket: "onboarding-uploads", token: `qa-bank-${stamp}`, companyName: acc.company_name })
    check("B6 with no person linked the personal papers are NOT filed (error), the company is untouched by them", !r3.ok && r3.failed.length >= 2, JSON.stringify(r3.failed).slice(0, 200))
  } finally {
    const { data: o } = await sb.from("store_owners").select("id").or(`account_id.eq.${acc.id},contact_id.eq.${contact.id}`)
    for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
    await sb.from("accounts").update({ status: "Cancelled" }).eq("id", acc.id)
    await sb.storage.from("onboarding-uploads").remove(paths)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
