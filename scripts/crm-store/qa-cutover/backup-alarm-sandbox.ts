/* eslint-disable no-console */
/** Phase 4: run the real backup alarm against the SANDBOX database and print what it would raise. Run: npx tsx scripts/crm-store/qa-cutover/backup-alarm-sandbox.ts */
import { config } from "dotenv"
config({ path: ".env.local" })

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  const { runBackupAlarm } = await import("../../../lib/crm-store/backup-alarm")
  const r = await runBackupAlarm()
  console.log("counts:", JSON.stringify(r.counts))
  console.log("problems:", r.problems.length === 0 ? "none" : "")
  for (const p of r.problems) console.log("  -", p)
}
main().catch((e) => { console.error(e); process.exit(1) })
