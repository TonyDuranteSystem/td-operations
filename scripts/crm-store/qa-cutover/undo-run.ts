/* eslint-disable no-console */
/** SANDBOX helper: undo one go-live run by id. Run: STORE_GO_LIVE=1 npx tsx scripts/crm-store/qa-cutover/undo-run.ts <runId> */
import { config } from "dotenv"
import { Client } from "pg"
config({ path: ".env.local" })

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const actor = (await db.query("select id from auth.users limit 1")).rows[0]?.id as string
  await db.end()
  const { undoGoLive } = await import("../../../lib/crm-store/go-live-run")
  console.log(JSON.stringify(await undoGoLive(process.argv[2], actor, { internal: true })))
}
main().catch((e) => { console.error(e); process.exit(1) })
