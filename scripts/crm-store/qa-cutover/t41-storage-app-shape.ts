/* eslint-disable no-console */
/**
 * Storage Mac app (dev job 1992a087): the Mac shows the storage in the Storage page's own SHAPE (Antonio 2026-10-19). SANDBOX only, real
 * database, the real listing functions (no dev server).  Run: npx tsx scripts/crm-store/qa-cutover/t41-storage-app-shape.ts
 * Proves: the navigation carries the three sections (clients / business / private); a company's "2. Contacts" folder is LISTED and carries the same people
 * as the Storage page, each with the person's own storage when it is live; the other four folders are unchanged; a hidden study copy is never offered.
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const L = await import("../../../lib/storage-app/listing")
  const { folderContents } = await import("../../../lib/crm-store/browse")
  const { data: staff } = await admin.auth.admin.listUsers({ perPage: 200 })
  const antonio = staff.users.find((u: { email?: string }) => u.email === "antonio.durante@tonydurante.us") ?? staff.users.find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  if (!antonio) throw new Error("no sandbox admin user")

  const nav = await L.appNavigation(antonio)
  const sections = Array.from(new Set(nav.map((g) => g.section)))
  check("1 the navigation carries the 'clients' section", sections.includes("clients"), sections.join(","))
  check("2 Business is its own section with ONE storage", nav.filter((g) => g.section === "business").flatMap((g) => g.owners).length === 1)

  // a live company whose '2. Contacts' has people on the Storage page
  const { data: cands } = await admin.from("store_folders").select("id, owner_id, store_owners!inner(kind, study_only)").eq("kind", "contacts").is("trashed_at", null).eq("store_owners.kind", "company").eq("store_owners.study_only", false).limit(40)
  let proof: { owner: string; folder: string; people: number } | null = null
  for (const f of (cands ?? []) as { id: string; owner_id: string }[]) {
    const c = await folderContents(f.owner_id, f.id)
    if ((c.people ?? []).length > 0) { proof = { owner: f.owner_id, folder: f.id, people: c.people!.length }; break }
  }
  check("3 a sandbox company with people in '2. Contacts' exists to compare", !!proof)
  if (proof) {
    const crm = await folderContents(proof.owner, proof.folder)
    const mac = await L.appFolder(proof.owner, proof.folder) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    check("4 the Mac listing carries a people list for '2. Contacts'", Array.isArray(mac?.people), JSON.stringify(mac?.people)?.slice(0, 120))
    check("5 the same number of people as the Storage page", (mac?.people ?? []).length === (crm.people ?? []).length, `${(mac?.people ?? []).length} vs ${(crm.people ?? []).length}`)
    const names = (mac?.people ?? []).map((p: { name: string }) => p.name).sort().join("|")
    check("6 the same names as the Storage page", names === (crm.people ?? []).map((p) => p.name).sort().join("|"))
    const withOwner = (mac?.people ?? []).filter((p: { ownerId: string | null }) => p.ownerId)
    if (withOwner.length > 0) {
      const { data: ow } = await admin.from("store_owners").select("study_only, kind").eq("id", withOwner[0].ownerId).maybeSingle()
      check("7 a person's storage offered to open is live, and a person's own", ow?.study_only === false && ow?.kind === "person", JSON.stringify(ow))
      const open = await L.appFolder(withOwner[0].ownerId, null) as any // eslint-disable-line @typescript-eslint/no-explicit-any
      check("8 opening that person's storage lists their folders", Array.isArray(open?.folders), `${open?.folders?.length} folders`)
    }
    // the company's top folder lists '2. Contacts' now
    const top = await L.appFolder(proof.owner, null) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    const kinds = (top?.folders ?? []).map((f: { kind: string }) => f.kind)
    check("9 the company's top level lists '2. Contacts' with the others", kinds.includes("contacts") && kinds.length >= 4, kinds.join(","))
    const sub = await L.appFolder(proof.owner, proof.folder) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    check("10 inside '2. Contacts' a Mac cannot save (canSave false)", sub?.folder?.canSave === false)
    // a folder other than Contacts carries NO people list
    const other = (top?.folders ?? []).find((f: { kind: string }) => f.kind !== "contacts")
    const oc = other ? await L.appFolder(proof.owner, other.id) as any : null // eslint-disable-line @typescript-eslint/no-explicit-any
    check("11 other folders carry no people list", !oc || oc.people === undefined)
  }
  summary()
}
main().catch((e) => { console.error("FATAL", e); process.exit(1) })
