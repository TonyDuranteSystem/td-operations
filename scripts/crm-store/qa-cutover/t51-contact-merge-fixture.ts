/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script uses throw-away fixtures */
/**
 * Contact Merge QA fixture (Graziella-shaped): K = the person with the ITIN case (right spelling, no storage);
 * L = the same person entered again as a 50% owner of a company, misspelled, with a storage. Same email.
 *   seed:   DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t51-contact-merge-fixture.ts seed
 *   verify: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t51-contact-merge-fixture.ts verify <K> <L> <ACCOUNT>
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const mode = process.argv[2]
  const rootOf = async (cid: string) => {
    const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", cid).eq("kind", "person").eq("study_only", false).maybeSingle()
    if (!o) return null
    const { data: r } = await sb.from("store_folders").select("name").eq("owner_id", o.id).is("parent_id", null).is("trashed_at", null).maybeSingle()
    return (r?.name as string | undefined) ?? null
  }
  if (mode === "seed") {
    const s = Date.now().toString(36)
    const email = `qa-merge-${s}@example.com`
    const mk = async (name: string) => (await sb.from("contacts").insert({ full_name: name, email, is_test: true }).select("id").single()).data.id as string
    const k = await mk(`QA Merge Chiara ${s}`)
    const l = await mk(`QA Merge Chaira ${s}`)
    const { data: acct } = await sb.from("accounts").insert({ company_name: `QA Merge Co ${s} LLC`, is_test: true, status: "Active" }).select("id").single()
    await sb.from("account_contacts").insert({ account_id: acct.id, contact_id: l, role: "Member" })
    await sb.from("members").insert({ account_id: acct.id, member_type: "individual", contact_id: l, full_name: `QA Merge Chaira ${s}`, ownership_pct: 50 })
    const { ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
    await ensurePersonOwner(l, `QA Merge Chaira ${s}`)
    const { createSD } = await import("../../../lib/operations/service-delivery")
    await createSD({ contact_id: k, service_type: "ITIN", service_name: `QA Merge ITIN ${s}`, actor: "qa" } as never)
    console.log(JSON.stringify({ k, l, account: acct.id, stamp: s }))
    return
  }
  if (mode === "edit") {
    // a name edit: the owner record that carried the old name follows; one with a different legal name (name order) does not
    const { updateContact } = await import("../../../lib/operations/contact")
    const [, , , , l, account] = process.argv
    const { data: before } = await sb.from("contacts").select("full_name").eq("id", l).single()
    await sb.from("members").insert({ account_id: account, member_type: "individual", full_name: "Legal Order Name", ownership_pct: 10, contact_id: null })
    const r = await updateContact({ id: l, patch: { full_name: `${before.full_name} FIXED` }, actor: "qa" } as never)
    const { data: m } = await sb.from("members").select("full_name, contact_id").eq("account_id", account)
    check("E1 edit ran", r.success === true)
    check("E2 the owner record that had the old name now has the new name", (m ?? []).some((x: { contact_id: string | null; full_name: string }) => x.contact_id === l && x.full_name === `${before.full_name} FIXED`), JSON.stringify(m))
    check("E3 an unrelated owner record is untouched", (m ?? []).some((x: { full_name: string }) => x.full_name === "Legal Order Name"))
    check("E4 the folder follows too", (await rootOf(l)) === `${before.full_name} FIXED`, String(await rootOf(l)))
    summary()
    return
  }
  const [, , , k, l, account, s] = process.argv
  const { data: kc } = await sb.from("contacts").select("full_name, merged_into").eq("id", k).single()
  const { data: lc } = await sb.from("contacts").select("full_name, merged_into").eq("id", l).single()
  const { data: m } = await sb.from("members").select("contact_id, full_name, ownership_pct").eq("account_id", account)
  const { data: sd } = await sb.from("service_deliveries").select("contact_id").like("service_name", "QA Merge ITIN %").eq("contact_id", k)
  check("V1 the merged-away contact points at the kept one", lc.merged_into === k)
  check("V2 the owner record now belongs to the kept contact and carries the kept name, 50% unchanged", (m ?? []).length === 1 && m[0].contact_id === k && m[0].full_name === kc.full_name && m[0].ownership_pct === 50, JSON.stringify(m))
  check("V3 the ITIN case stays with the kept contact", (sd ?? []).length === 1)
  check("V4 the storage moved to the kept contact and its top folder carries the kept name", (await rootOf(k)) === kc.full_name && (await rootOf(l)) === null, String(await rootOf(k)))
  void s
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
