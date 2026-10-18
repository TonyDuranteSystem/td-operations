/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates and removes throw-away fixtures */
/**
 * Stop Drive S1d QA (dev job 264bb882): an EXISTING-LLC client through onboarding_setup with NO Drive folder and NO storage.
 * Real sandbox database + real isolated TEST Shared Drive. The company's storage must be opened by the job itself, the wizard
 * uploads + the data summary must land in it, the job must show no drive_folder error, and NOTHING may appear in Drive.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t42-stop-drive-onboarding.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })
process.env.GOOGLE_DRIVE_LIVE = "1"
process.env.GOOGLE_SHARED_DRIVE_ID = "0ABz0eJKly9bkUk9PVA"
process.env.SANDBOX_MODE = "1" // outgoing mail is a no-op

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await import("../../../lib/google-drive")
  const stamp = Date.now()
  const name = `QA S1d Onboarding ${stamp} LLC`
  const made: { account?: string; contact?: string; paths: string[] } = { paths: [] }
  const rootCount = async () => ((await drive.listFolder(process.env.GOOGLE_SHARED_DRIVE_ID as string, 500)) as { files?: unknown[] }).files?.length ?? 0
  const before = await rootCount()
  try {
    const { data: contact, error: cErr } = await sb.from("contacts").insert({ first_name: "Qa", last_name: `S1d${stamp}`, full_name: `Qa S1d${stamp}`, email: `qa-s1d-${stamp}@example.invalid`, language: "English" }).select("id").single()
    if (cErr) throw new Error(`contact: ${cErr.message}`)
    made.contact = contact.id
    const { data: account, error: aErr } = await sb.from("accounts").insert({ company_name: name, state_of_formation: "Wyoming", entity_type: "Single Member LLC", status: "Active" }).select("id, drive_folder_id").single()
    if (aErr) throw new Error(`account: ${aErr.message}`)
    made.account = account.id
    await sb.from("account_contacts").insert({ account_id: account.id, contact_id: contact.id, role: "Owner", is_primary: true })

    const doc = await PDFDocument.create(); doc.addPage()
    const bytes = Buffer.from(await doc.save())
    for (const f of [`onboarding/${contact.id}/passport_owner_s1d${stamp}.pdf`, `onboarding/${contact.id}/ein_letter_s1d${stamp}.pdf`]) {
      const { error } = await sb.storage.from("onboarding-uploads").upload(f, bytes, { contentType: "application/pdf", upsert: true })
      if (error) throw new Error(`upload ${f}: ${error.message}`)
      made.paths.push(f)
    }
    check("S0 fixture company has NO Drive folder and NO storage", !account.drive_folder_id)

    const { handleOnboardingSetup } = await import("../../../lib/jobs/handlers/onboarding-setup")
    const res = await handleOnboardingSetup({
      id: "00000000-0000-0000-0000-00000000s1d0".replace("s1d0", "0000"), job_type: "onboarding_setup", status: "running", attempts: 1, max_attempts: 1, created_at: new Date().toISOString(),
      payload: {
        token: `qa-s1d-${stamp}`, submission_id: null, account_id: account.id, contact_id: contact.id, lead_id: null, company_name: name, state_of_formation: "Wyoming", entity_type: "SMLLC", source: "portal_wizard", suite_choice: "waive",
        submitted_data: { company_name: name, owner_first_name: "Qa", owner_last_name: `S1d${stamp}`, owner_email: `qa-s1d-${stamp}@example.invalid`, state_of_formation: "Wyoming" },
        upload_paths: made.paths,
      },
    } as never)
    const steps = (res.steps ?? []) as Array<{ name: string; status: string; detail?: string }>
    const by = (n: string) => steps.find((s) => s.name === n)
    console.log(steps.map((s) => `${s.status.padEnd(7)} ${s.name}${s.detail ? " — " + s.detail.slice(0, 90) : ""}`).join("\n"))
    check("S1 the job shows NO drive_folder error", by("drive_folder")?.status !== "error", by("drive_folder")?.detail ?? "no drive_folder step")
    check("S2 the wizard uploads were saved in the company's storage", by("store_uploads")?.status === "ok", by("store_uploads")?.detail ?? "missing")
    check("S3 the data summary PDF was saved in storage", by("data_summary_pdf")?.status === "ok", by("data_summary_pdf")?.detail ?? "missing")
    const { data: owner } = await sb.from("store_owners").select("id").eq("account_id", account.id).eq("study_only", false).maybeSingle()
    check("S4 the company now has a live storage", !!owner)
    const { data: files } = owner ? await sb.from("store_files").select("name").eq("owner_id", owner.id).is("trashed_at", null) : { data: [] }
    check("S5 the EIN upload and the data summary are in the company's storage", (files ?? []).length >= 2, JSON.stringify((files ?? []).map((f: { name: string }) => f.name)).slice(0, 200))
    const { data: pOwner } = await sb.from("store_owners").select("id").eq("contact_id", contact.id).eq("kind", "person").eq("study_only", false).maybeSingle()
    const { data: pFiles } = pOwner ? await sb.from("store_files").select("name").eq("owner_id", pOwner.id).is("trashed_at", null) : { data: [] }
    check("S5b the passport went to the PERSON's own storage", (pFiles ?? []).some((f: { name: string }) => /passport_owner/.test(f.name)), JSON.stringify((pFiles ?? []).map((f: { name: string }) => f.name)).slice(0, 160))
    const { data: acc2 } = await sb.from("accounts").select("drive_folder_id").eq("id", account.id).single()
    check("S6 no Drive folder was linked to the company", !acc2.drive_folder_id)
    check("S7 nothing new appeared at the top of the Drive", (await rootCount()) === before, `${before} -> ${await rootCount()}`)
  } finally {
    if (made.account) {
      const { data: o } = await sb.from("store_owners").select("id").eq("account_id", made.account)
      for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id) // retire (storage folders are never deleted)
      await sb.from("documents").delete().eq("account_id", made.account)
      await sb.from("tasks").delete().eq("account_id", made.account)
      await sb.from("account_contacts").delete().eq("account_id", made.account)
    }
    if (made.contact) {
      const { data: po } = await sb.from("store_owners").select("id").eq("contact_id", made.contact)
      for (const x of po ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
    }
    if (made.paths.length) await sb.storage.from("onboarding-uploads").remove(made.paths)
    if (made.account) await sb.from("accounts").update({ status: "Cancelled" }).eq("id", made.account)
    console.log("(fixture rows left for inspection are named 'QA S1d Onboarding …' — safe to delete)")
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
