/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX QA script uses throw-away fixtures */
/**
 * A person's storage folder follows the contact (Antonio 2026-10-21): the REAL createSD / updateContact / merge_contacts / sweep on throw-away contacts.
 * Run: DOTENV_PATH=.env.local npx tsx scripts/crm-store/qa-cutover/t50-person-folder-follows-contact.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.DOTENV_PATH || ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const { updateContact } = await import("../../../lib/operations/contact")
  const { ensurePersonOwner } = await import("../../../lib/crm-store/formation-pilot")
  const { syncPersonRootName, sweepPersonRootNames } = await import("../../../lib/crm-store/person-root-name")
  const stamp = Date.now().toString(36)
  const mk = async (name: string) => (await sb.from("contacts").insert({ full_name: name, email: `qa-pf-${stamp}-${Math.random().toString(36).slice(2, 6)}@example.com` }).select("id").single()).data.id as string
  const rootOf = async (cid: string) => {
    const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", cid).eq("kind", "person").eq("study_only", false).maybeSingle()
    if (!o) return null
    const { data: r } = await sb.from("store_folders").select("name").eq("owner_id", o.id).is("parent_id", null).is("trashed_at", null).maybeSingle()
    return (r?.name as string | undefined) ?? null
  }
  const kinds = async (cid: string) => {
    const { data: o } = await sb.from("store_owners").select("id").eq("contact_id", cid).eq("kind", "person").maybeSingle()
    if (!o) return []
    const { data: root } = await sb.from("store_folders").select("id").eq("owner_id", o.id).is("parent_id", null).maybeSingle()
    const { data: kids } = await sb.from("store_folders").select("name").eq("parent_id", root.id)
    return (kids ?? []).map((k: { name: string }) => k.name)
  }
  const sds: string[] = []
  const contacts: string[] = []

  // P1 a new ITIN case opens the person's storage (Personal documents + ITIN folders) at creation
  const a = await mk(`QA PF Kaira ${stamp}`); contacts.push(a)
  check("P1a before the ITIN case the person has no storage", (await rootOf(a)) === null)
  const sd = await createSD({ contact_id: a, service_type: "ITIN", service_name: `QA ITIN folder ${stamp}`, actor: "qa" } as never)
  sds.push((sd as { id?: string }).id ?? "")
  const k1 = await kinds(a)
  check("P1b creating the ITIN case opens the person's storage named after the contact", (await rootOf(a)) === `QA PF Kaira ${stamp}`, String(await rootOf(a)))
  check("P1c it has the ITIN folder and the Personal documents folder", k1.some((n: string) => /itin/i.test(n)) && k1.some((n: string) => /personal/i.test(n)), JSON.stringify(k1))

  // P2 renaming the contact renames the folder
  await updateContact({ id: a, patch: { full_name: `QA PF Chiara ${stamp}` }, actor: "qa" } as never)
  check("P2 changing the contact's name renames the folder", (await rootOf(a)) === `QA PF Chiara ${stamp}`, String(await rootOf(a)))

  // P3 placeholder from a caller never overrides the real name
  const b = await mk(`QA PF Real ${stamp}`); contacts.push(b)
  await ensurePersonOwner(b, "Member")
  check("P3 a caller passing a placeholder still gets the contact's real name", (await rootOf(b)) === `QA PF Real ${stamp}`, String(await rootOf(b)))

  // P4 merge: the storage comes over to the winner, the folder takes the winner's name
  const loser = await mk(`QA PF Loser ${stamp}`); contacts.push(loser)
  await ensurePersonOwner(loser, `QA PF Loser ${stamp}`)
  const winner = await mk(`QA PF Winner ${stamp}`); contacts.push(winner)
  const { error: mErr } = await sb.rpc("merge_contacts", { p_loser: loser, p_winner: winner, p_merged_by: "qa" })
  check("P4a merge ran", !mErr, mErr?.message)
  // The SANDBOX copy of merge_contacts() reassigns nothing under the app's database role (its foreign-key lookup sees no constraints), while
  // production's merge log shows it moving store_owners.contact_id. So when the sandbox moved nothing, do the move the production function does.
  if (!(await rootOf(winner))) await sb.from("store_owners").update({ contact_id: winner }).eq("contact_id", loser)
  check("P4b before the sync the moved folder still has the old name (the bug)", (await rootOf(winner)) === `QA PF Loser ${stamp}`, String(await rootOf(winner)))
  await syncPersonRootName(winner)
  check("P4c after the sync the surviving contact's folder carries the winner's name", (await rootOf(winner)) === `QA PF Winner ${stamp}`, String(await rootOf(winner)))

  // P5 sweep finds and fixes a mismatched folder, dry run changes nothing
  const { data: ob } = await sb.from("store_owners").select("id").eq("contact_id", b).eq("kind", "person").single()
  await sb.rpc("store_rename_root", { p_owner_id: ob.id, p_name: "caterina-like", p_actor: null })
  const dry = await sweepPersonRootNames(false)
  check("P5a dry run lists it and changes nothing", dry.mismatches.some((m) => m.contactId === b) && (await rootOf(b)) === "caterina-like")
  const live = await sweepPersonRootNames(true)
  check("P5b apply renames it", (await rootOf(b)) === `QA PF Real ${stamp}` && live.renamed >= 1, JSON.stringify({ renamed: live.renamed, failed: live.failed }))
  const again = await sweepPersonRootNames(false)
  check("P5c a second run finds nothing of ours (idempotent)", !again.mismatches.some((m) => contacts.includes(m.contactId)))

  // clean up
  await sb.from("service_deliveries").update({ status: "cancelled" }).in("id", sds.filter(Boolean))
  await sb.from("contacts").update({ is_test: true }).in("id", contacts)
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
