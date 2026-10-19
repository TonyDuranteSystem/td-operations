/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Stop Drive S1d QA (round 8): the REAL onboarding setup handler on a brand-new MMLLC (owner + member 1 WITH an email + member 2 WITHOUT one),
 * first run, in order: account created -> storage opened (never a Drive folder) -> uploads + summary filed -> each passport in the
 * right place. The Drive client is a SPY that fails on ANY call (read or write), so a single Drive touch fails the run. SANDBOX only.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t47-onboarding-mmllc-first-run.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  // Drive is watched at the network: every request to the Drive API is recorded (a read or a write), and the Drive credentials are
  // made invalid so a call could not succeed anyway. One recorded request fails the run.
  const touched: string[] = []
  process.env.GOOGLE_SA_KEY = "invalid"
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (/googleapis\.com\/(upload\/)?drive\//.test(url)) { touched.push(url.slice(0, 80)); throw new Error("Drive must not be touched") }
    return realFetch(input, init)
  }) as typeof fetch
  const stamp = Date.now()
  const { data: owner } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `Owner${stamp}`, full_name: `Qa Owner${stamp}`, email: `qa-owner-${stamp}@example.invalid`, language: "English" }).select("id").single()
  const doc = await PDFDocument.create(); doc.addPage(); const bytes = Buffer.from(await doc.save())
  const base = `onboarding/qa${stamp}`
  const paths = [`${base}/passport_owner_${stamp}_o.pdf`, `${base}/member_0_member_passport_${stamp}_m0.pdf`, `${base}/member_1_member_passport_${stamp}_m1.pdf`]
  for (const p of paths) await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true })
  const companyName = `ZZ QA S1d r8 ${stamp} LLC`
  const submitted = {
    company_name: companyName, owner_first_name: "Qa", owner_last_name: `Owner${stamp}`, state_of_formation: "Wyoming", entity_type: "MMLLC",
    member_count: 2,
    member_0_member_first_name: "Mia", member_0_member_last_name: `One${stamp}`, member_0_member_email: `qa-m0-${stamp}@example.invalid`, member_0_member_ownership_pct: 30,
    member_1_member_first_name: "Noa", member_1_member_last_name: `Two${stamp}`, member_1_member_ownership_pct: 20,
  }
  const { data: job, error } = await sb.from("job_queue").insert({ job_type: "onboarding_setup", status: "processing", payload: {}, priority: 5, created_by: "qa" }).select("id, created_at").single()
  if (error) throw new Error(error.message)
  const created: { acct?: string; contacts: string[] } = { contacts: [owner.id] }
  try {
    const { handleOnboardingSetup } = await import("../../../lib/jobs/handlers/onboarding-setup")
    const res = await handleOnboardingSetup({ id: job.id, created_at: job.created_at, job_type: "onboarding_setup", status: "processing", attempts: 1, max_attempts: 3,
      payload: { token: `qa-onb-${stamp}`, submission_id: null, account_id: null, contact_id: owner.id, lead_id: null, company_name: companyName, state_of_formation: "Wyoming", entity_type: "MMLLC", submitted_data: submitted, upload_paths: paths, suite_choice: "waive", suite_waive_reason: "qa" } } as never)
    const steps = res.steps as Array<{ name: string; status: string; detail?: string }>
    const st = (n: string) => steps.find((s) => s.name === n)
    const { data: acct } = await sb.from("accounts").select("id, drive_folder_id").eq("company_name", companyName).maybeSingle()
    created.acct = acct?.id
    check("O1 the account was created FIRST and has no Drive folder", !!acct && acct.drive_folder_id === null, JSON.stringify(acct))
    check("O2 NOT ONE Drive call was made (read or write) reached the Drive API", touched.length === 0, touched.join(","))
    check("O3 the uploads and the data summary were filed in the company's storage (no drive_folder error)", st("drive_folder") === undefined && st("store_uploads")?.status === "ok" && st("data_summary_pdf")?.status === "ok", JSON.stringify(steps.filter((s) => /drive|store|summary/.test(s.name))).slice(0, 300))
    const names = async (where: Record<string, string>) => {
      const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
      const out: string[] = []
      for (const x of o ?? []) { const { data: f } = await sb.from("store_files").select("name").eq("owner_id", x.id).is("trashed_at", null); out.push(...(f ?? []).map((y: { name: string }) => y.name)) }
      return out
    }
    const companyFiles = await names({ account_id: acct.id }), ownerFiles = await names({ contact_id: owner.id })
    const { data: m0 } = await sb.from("contacts").select("id").eq("email", `qa-m0-${stamp}@example.invalid`).maybeSingle()
    if (m0) created.contacts.push(m0.id)
    const m0Files = m0 ? await names({ contact_id: m0.id }) : []
    check("O4 the OWNER's passport is in the owner's own storage; neither member's passport is", ownerFiles.some((n) => /passport_owner/.test(n)) && !ownerFiles.some((n) => /member_/.test(n)), JSON.stringify(ownerFiles))
    check("O5 member 1 (has an email): THEIR passport is in THEIR OWN storage only", !!m0 && m0Files.some((n) => /member_0_member_passport/.test(n)) && !ownerFiles.some((n) => /member_0/.test(n)) && !companyFiles.some((n) => /member_/.test(n)), JSON.stringify({ m0Files, ownerFiles, companyFiles }))
    check("O6 member 2 (NO email): no contact exists, so their passport is filed NOWHERE (held on the submission, a step + alarm say so) — never in the owner's or the company's storage", !companyFiles.some((n) => /member_1/.test(n)) && !ownerFiles.some((n) => /member_1/.test(n)) && /Kept on the submission/.test(st("member_2_passport")?.detail ?? ""), JSON.stringify(st("member_2_passport")))
    check("O7 the job result is NOT a failure when the only problem is a passport held on purpose", res.ok !== false, String(res.summary).slice(0, 200))
  } finally {
    if (created.acct) await sb.from("accounts").update({ status: "Cancelled" }).eq("id", created.acct)
    for (const c of created.contacts) { const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", c); for (const y of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", y.id) }
    if (created.acct) { const { data: o } = await sb.from("store_owners").select("id").eq("account_id", created.acct); for (const y of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", y.id) }
    await sb.storage.from("onboarding-uploads").remove(paths)
    await sb.from("job_queue").update({ status: "completed" }).eq("id", job.id)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
