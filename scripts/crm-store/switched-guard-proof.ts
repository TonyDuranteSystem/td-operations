/* eslint-disable no-console -- a proof script prints its results */
/**
 * Sandbox proof for the cutover safety layer (dev job ad09ea91): reads the REAL sandbox database and shows
 * which Drive folders the guard would lock, the state of a few companies, and that a write into a locked
 * folder is refused while an unlocked one passes. Read-only. Run: npx tsx scripts/crm-store/switched-guard-proof.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const g = await import("../../lib/crm-store/switched-drive-guard")
  const locked = await g.readLockedFolderIds()
  console.log("locked Drive folders (switched or moving):", locked.size, Array.from(locked).slice(0, 5))

  const { supabaseAdmin } = await import("../../lib/supabase-admin")
  const { data: owners } = await supabaseAdmin.from("store_owners" as never).select("account_id, kind, study_only").not("account_id", "is", null).limit(5) as unknown as { data: Array<{ account_id: string; kind: string; study_only: boolean }> }
  for (const o of owners ?? []) console.log("state of", o.account_id, `(owner kind ${o.kind}, study_only ${o.study_only}):`, await g.companyDocState(o.account_id))

  const deps = { lockedFolderIds: async () => locked, parentsOf: async () => [] as string[] }
  const first = Array.from(locked)[0]
  if (first) {
    try { await g.assertTargetsNotSwitched([first], deps); console.log("UNEXPECTED: write into a locked folder passed") }
    catch (e) { console.log("write into a locked folder refused:", (e as Error).name) }
  } else console.log("no locked folder in this sandbox (nothing switched) — guard is dormant, as designed")
  await g.assertTargetsNotSwitched(["some-unlocked-folder"], deps)
  console.log("write into an unlocked folder passes")
}
main().catch((e) => { console.error(e); process.exit(1) })
