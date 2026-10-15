/* eslint-disable no-console */
/* sandbox only: the One-time customers group + empty storages for Active One-Time companies */
import { config } from "dotenv"
config({ path: ".env.local" })
async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const { planOneTimeStorages, createOneTimeStorages } = await import("@/lib/crm-store/one-time")
  const { navigation } = await import("@/lib/crm-store/structure")
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

  const before = await planOneTimeStorages()
  console.log("candidates:", before.map((c) => `${c.companyName}:${c.ok ? "ok" : c.why}`))
  const okNames = before.filter((c) => c.ok).map((c) => c.companyName)
  const res = await createOneTimeStorages()
  ck("1 every ok company got a storage", okNames.every((n) => res.created.includes(n)) && res.failed.length === 0, res)
  ck("2 unsafe ones were skipped, not created", before.filter((c) => !c.ok).every((c) => res.skipped.some((s) => s.company === c.companyName)), res.skipped)
  const again = await createOneTimeStorages()
  ck("3 running again creates nothing more (idempotent)", again.created.length === 0 && again.failed.length === 0, again)

  const nav = await navigation(null, false)
  const g = nav.find((x) => x.key === "one-time")
  ck("4 the One-time customers group exists", !!g && g.label === "One-time customers", nav.map((x) => x.key))
  ck("5 the new storages are in it", !!g && okNames.every((n) => g.owners.some((o) => o.label.includes(n.split(" ")[0]))), g?.owners.map((o) => o.label))
  ck("6 no One-Time company is left in a state group", nav.filter((x) => x.key.startsWith("state:")).every((x) => x.owners.length > 0))
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
