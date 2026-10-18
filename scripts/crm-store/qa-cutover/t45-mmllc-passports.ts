/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Stop Drive S1d QA (round 5): an MMLLC client (owner + 2 members) through onboarding_setup with NO Drive folder and NO storage.
 * Each passport must sit in EXACTLY ONE storage — the owner's in the owner's, each member's in that member's — nothing in the
 * company's; the owner's passport data comes from the owner's passport ONLY; nothing appears in Drive. SANDBOX only.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t45-mmllc-passports.ts
 */
import { config } from "dotenv"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })
process.env.GOOGLE_DRIVE_LIVE = "1"
process.env.GOOGLE_SHARED_DRIVE_ID = "0ABz0eJKly9bkUk9PVA"
process.env.SANDBOX_MODE = "1"

const mrz = (name: string, num: string) => [`P<ITA${name}<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`, `${num}<8ITA8001014M3012315<<<<<<<<<<<<<<06`]

async function pdfWith(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create()
  const page = d.addPage([700, 300])
  const font = await d.embedFont(StandardFonts.Courier)
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 250 - i * 30, size: 14, font }))
  return Buffer.from(await d.save())
}

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; storage: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const drive = await import("../../../lib/google-drive")
  const stamp = Date.now()
  const name = `QA S1d MMLLC ${stamp} LLC`
  const made = { account: "", contacts: [] as string[], paths: [] as string[] }
  const rootCount = async () => ((await drive.listFolder(process.env.GOOGLE_SHARED_DRIVE_ID as string, 500)) as { files?: unknown[] }).files?.length ?? 0
  const before = await rootCount()
  try {
    const mk = async (first: string, email: string) => {
      const { data, error } = await sb.from("contacts").insert({ first_name: first, last_name: "Qamm", full_name: `${first} Qamm`, email, language: "English" }).select("id").single()
      if (error) throw new Error(error.message)
      made.contacts.push(data.id)
      return data.id as string
    }
    const owner = await mk("Mario", `qa-mm-owner-${stamp}@example.invalid`)
    const { data: account, error } = await sb.from("accounts").insert({ company_name: name, state_of_formation: "Wyoming", entity_type: "Multi Member LLC", status: "Active" }).select("id").single()
    if (error) throw new Error(error.message)
    made.account = account.id
    await sb.from("account_contacts").insert({ account_id: account.id, contact_id: owner, role: "Owner", is_primary: true })

    const files: Array<[string, string[]]> = [
      [`onboarding/${owner}/passport_owner_${stamp}_o.pdf`, mrz("QAMM<<MARIO", "AB1234567")],
      [`onboarding/${owner}/member_0_member_passport_${stamp}_a.pdf`, mrz("BIANCHI<<LUCA", "CD7654321")],
      [`onboarding/${owner}/member_1_member_passport_${stamp}_b.pdf`, mrz("VERDI<<ANNA", "EF1111111")],
    ]
    for (const [p, lines] of files) {
      const { error: uErr } = await sb.storage.from("onboarding-uploads").upload(p, await pdfWith(lines), { contentType: "application/pdf", upsert: true })
      if (uErr) throw new Error(uErr.message)
      made.paths.push(p)
    }
    const { handleOnboardingSetup } = await import("../../../lib/jobs/handlers/onboarding-setup")
    const res = await handleOnboardingSetup({
      id: "00000000-0000-0000-0000-000000000000", job_type: "onboarding_setup", status: "running", attempts: 1, max_attempts: 1, created_at: new Date().toISOString(),
      payload: {
        token: `qa-mm-${stamp}`, submission_id: null, account_id: account.id, contact_id: owner, lead_id: null, company_name: name, state_of_formation: "Wyoming", entity_type: "MMLLC", source: "portal_wizard", suite_choice: "waive",
        submitted_data: {
          company_name: name, owner_first_name: "Mario", owner_last_name: "Qamm", owner_email: `qa-mm-owner-${stamp}@example.invalid`, state_of_formation: "Wyoming",
          member_count: 2,
          member_0_member_first_name: "Luca", member_0_member_last_name: "Bianchi", member_0_member_email: `qa-mm-a-${stamp}@example.invalid`, member_0_member_ownership_pct: 25,
          member_1_member_first_name: "Anna", member_1_member_last_name: "Verdi", member_1_member_email: `qa-mm-b-${stamp}@example.invalid`, member_1_member_ownership_pct: 25,
        },
        upload_paths: made.paths,
      },
    } as never)
    const steps = (res.steps ?? []) as Array<{ name: string; status: string; detail?: string }>
    console.log(steps.filter((s) => /passport|member_|store_uploads|drive_folder/.test(s.name)).map((s) => `${s.status.padEnd(7)} ${s.name}${s.detail ? " — " + s.detail.slice(0, 100) : ""}`).join("\n"))
    check("M1 the job shows no drive_folder error", !steps.some((s) => s.name === "drive_folder" && s.status === "error"))

    const { data: links } = await sb.from("account_contacts").select("contact_id").eq("account_id", account.id)
    const people: string[] = (links ?? []).map((l: { contact_id: string }) => l.contact_id)
    for (const c of people) if (!made.contacts.includes(c)) made.contacts.push(c)
    const storageNames = async (where: Record<string, string>) => {
      const { data: o } = await sb.from("store_owners").select("id").match(where).eq("study_only", false)
      const out: string[] = []
      for (const x of o ?? []) { const { data: f } = await sb.from("store_files").select("name").eq("owner_id", x.id).is("trashed_at", null); out.push(...(f ?? []).map((y: { name: string }) => y.name)) }
      return out
    }
    const company = await storageNames({ account_id: account.id })
    check("M2 NO passport is in the company's storage", !company.some((n) => /passport/.test(n)), JSON.stringify(company))
    const ownerFiles = await storageNames({ contact_id: owner })
    check("M3 the owner's storage holds the OWNER passport and NO member passport", ownerFiles.some((n) => /passport_owner/.test(n)) && !ownerFiles.some((n) => /member_\d_member_passport/.test(n)), JSON.stringify(ownerFiles))
    const memberFiles: Record<string, string[]> = {}
    for (const c of people.filter((x) => x !== owner)) memberFiles[c] = await storageNames({ contact_id: c })
    const all = Object.values(memberFiles).flat()
    check("M4 each member passport is in exactly one member storage", all.filter((n) => /member_0_member_passport/.test(n)).length === 1 && all.filter((n) => /member_1_member_passport/.test(n)).length === 1, JSON.stringify(memberFiles))
    const { data: oc } = await sb.from("contacts").select("passport_number").eq("id", owner).single()
    check("M5 the owner's passport number comes from the OWNER's passport only", oc.passport_number === "AB1234567" || oc.passport_number == null, `owner passport_number=${oc.passport_number}`)
    check("M5b it is never a member's number", oc.passport_number !== "CD7654321" && oc.passport_number !== "EF1111111", String(oc.passport_number))
    check("M6 nothing new appeared at the top of the Drive", (await rootCount()) === before)
  } finally {
    for (const where of [made.account ? { account_id: made.account } : null, ...made.contacts.map((c) => ({ contact_id: c }))]) {
      if (!where) continue
      const { data: o } = await sb.from("store_owners").select("id").match(where)
      for (const x of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", x.id)
    }
    if (made.account) { await sb.from("tasks").delete().eq("account_id", made.account); await sb.from("accounts").update({ status: "Cancelled" }).eq("id", made.account) }
    if (made.paths.length) await sb.storage.from("onboarding-uploads").remove(made.paths)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
