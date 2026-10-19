/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script creates throw-away fixtures */
/**
 * Stop Drive S1d QA (round 3): the formation package of an MMLLC with two members, filed by the SAME function the completion route, the
 * retry recipe and formation_form_review use. The owner's passport + other files land in the PRIMARY contact's storage with member-aware
 * names; the two members' passports are NOT filed there. A primary contact with only a hidden study copy gets nothing. SANDBOX only.
 * Run: DOTENV_PATH=<sandbox .env.local> npx tsx scripts/crm-store/qa-cutover/t46-formation-review-mmllc.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const { fileFormPackage, memberAwareFileName } = await import("../../../lib/forms/file-form-package")
  const stamp = Date.now()
  const mk = async (tag: string) => (await sb.from("contacts").insert({ first_name: "Qa", last_name: `${tag}${stamp}`, full_name: `Qa ${tag}${stamp}`, email: `qa-${tag}-${stamp}@example.invalid`, language: "English" }).select("id").single()).data
  const owner = await mk("Owner"), studyOwner = await mk("Study")
  const doc = await PDFDocument.create(); doc.addPage(); const bytes = Buffer.from(await doc.save())
  const P = (n: string) => `formation/l${stamp}/${n}_${stamp}.pdf`
  const paths = [P("passport_owner"), P("passport_member_0"), P("passport_member_1"), P("other_doc")]
  for (const p of paths) await sb.storage.from("onboarding-uploads").upload(p, bytes, { contentType: "application/pdf", upsert: true })
  const data = { owner_first_name: "Ada", owner_last_name: "Owner", llc_name_1: "Acme", additional_members: [{ member_first_name: "Bob", member_last_name: "One" }, { member_first_name: "Cy", member_last_name: "Two" }] }
  const names = async (cid: string) => {
    const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", cid).eq("study_only", false)
    const out: string[] = []
    for (const x of o ?? []) { const { data: f } = await sb.from("store_files").select("name").eq("owner_id", x.id).is("trashed_at", null); out.push(...(f ?? []).map((y: { name: string }) => y.name)) }
    return out
  }
  try {
    const step = await fileFormPackage({ route: "qa", formType: "formation", submittedData: data, uploadPaths: paths, contactId: owner.id, personName: "Ada Owner", fileNameOf: memberAwareFileName(data), meta: { token: `qa-f-${stamp}`, submittedAt: new Date().toISOString(), companyName: "Ada Owner" }, bucket: "onboarding-uploads" })
    check("F1 filed without errors", step.status === "ok", step.detail)
    const got = await names(owner.id)
    check("F2 the owner's passport and the other file are in the primary contact's storage, with member-aware names", got.some((n) => /^passport_owner_Ada_Owner/.test(n)) && got.some((n) => /other_doc/.test(n)), JSON.stringify(got))
    check("F3 NEITHER member's passport is in the primary contact's storage", !got.some((n) => /member/.test(n)), JSON.stringify(got))
    // study-only primary: nothing is filed
    const { data: so } = await sb.rpc("store_ensure_owner", { p_kind: "person", p_ref: studyOwner.id })
    await sb.from("store_owners").update({ study_only: true }).eq("id", so)
    const s2 = await fileFormPackage({ route: "qa", formType: "formation", submittedData: data, uploadPaths: paths, contactId: studyOwner.id, personName: "Study", fileNameOf: memberAwareFileName(data), meta: { token: `qa-f2-${stamp}`, submittedAt: new Date().toISOString(), companyName: "Study" }, bucket: "onboarding-uploads" })
    const { data: sf } = await sb.from("store_files").select("name").eq("owner_id", so)
    check("F4 a primary contact with only a hidden study copy: nothing filed, reported as an error", s2.status === "error" && (sf ?? []).length === 0, s2.detail)
  } finally {
    for (const c of [owner.id, studyOwner.id]) { const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", c); for (const y of o ?? []) await sb.from("store_owners").update({ study_only: true }).eq("id", y.id) }
    await sb.storage.from("onboarding-uploads").remove(paths)
  }
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
