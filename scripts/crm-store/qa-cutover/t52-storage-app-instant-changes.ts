/* eslint-disable no-console */
/**
 * Storage Mac app (dev job 1992a087): the "tell me when something changes" answer. SANDBOX only.
 * Proves with the real sandbox database and the real library function the route uses (changesWaiting + changesSince):
 *  - a question with a 20 s wait that finds nothing stays open, and answers within a few seconds of a file being saved;
 *  - a question made when a change already exists answers at once;
 *  - wait 0 answers at once even when empty; a question with nothing new gives up at its time.
 * Run: npx tsx scripts/crm-store/qa-cutover/t52-storage-app-instant-changes.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const STAFF = { id: "00000000-0000-4000-8000-000000000052", email: "qa-push@example.test", app_metadata: { role: "team" }, user_metadata: {}, aud: "authenticated", created_at: "" } as never
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const url = process.env.SUPABASE_DB_URL || ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("REFUSED: not the sandbox database")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any; rpc: (f: string, a?: any) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { changesSince, changesHead, changesWaiting, parseCursor } = await import("../../../lib/storage-app/changes")
  const { createFolder } = await import("../../../lib/crm-store/structure")
  const { saveBytesToStore } = await import("../../../lib/crm-store/writer")
  const { data: owner } = await sb.from("store_owners").select("id").eq("account_id", UX_ACCOUNT).eq("kind", "company").maybeSingle()
  const { data: root } = await sb.from("store_folders").select("id").eq("owner_id", owner.id).is("parent_id", null).maybeSingle()
  let qa: { id: string } | null = null
  for (let page = 1; page <= 10 && !qa; page++) {
    const { data: users } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage: 200 }) // eslint-disable-line @typescript-eslint/no-explicit-any
    qa = (users?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin") ?? null
    if (!(users?.users ?? []).length) break
  }
  if (!qa) throw new Error("no admin login found in the sandbox")
  const tag = `QA Test ap-push ${Date.now()}`
  const folder = await createFolder(root!.id, tag, null)
  const deps = (from0: { v: string | null }) => ({
    read: (c: ReturnType<typeof parseCursor>) => changesSince(STAFF, c, 500),
    sleep, now: () => Date.now(), aborted: () => false, _from: from0,
  })
  const head = async () => { const h = await changesHead(); return h ? parseCursor(h) : null }

  // A — nothing new: with wait 0 it answers at once, empty
  let cur = await head()
  let t0 = Date.now()
  let r = await changesWaiting(cur, 0, deps({ v: null }))
  check("A wait 0 and nothing new → answers at once, empty", Date.now() - t0 < 2000 && r.changes.length === 0, `${Date.now() - t0} ms, ${r.changes.length} changes`)

  // B — nothing new, wait 4 s → gives up at about 4 s
  t0 = Date.now()
  r = await changesWaiting(cur, 4000, deps({ v: null }))
  const gave = Date.now() - t0
  check("B wait 4 s and nothing new → gives up at about 4 s, empty", gave >= 3500 && gave < 7000 && r.changes.length === 0, `${gave} ms`)

  // C — the question is open, a file is saved 3 s later → the answer comes within ~3 s of the save
  cur = await head()
  t0 = Date.now()
  let savedAt = 0
  const waiter = changesWaiting(cur, 20000, deps({ v: null }))
  await sleep(3000)
  const saved = await saveBytesToStore({ ownerId: owner.id, folderId: folder.id, name: "QA push.txt", mimeType: "text/plain", callerKey: `qa-push:${tag}`, contentChanged: true, bytes: Buffer.from("push " + tag), documentType: null })
  savedAt = Date.now()
  const fileId = (saved as { fileId: string }).fileId
  r = await waiter
  const latency = Date.now() - savedAt
  check("C file saved while the question was open → answered with that file", r.changes.some((c) => c.id === fileId && c.op === "upsert"), JSON.stringify(r.changes.map((c) => [c.kind, c.op])))
  check("C2 …and within 4 s of the save (a tick is 1.5 s)", latency < 4000, `${latency} ms after the save; total wait ${Date.now() - t0} ms`)
  console.log(`   latency from save to answer: ${latency} ms`)

  // D — a change already exists → answers at once
  const older = cur
  t0 = Date.now()
  r = await changesWaiting(older, 20000, deps({ v: null }))
  check("D a change already exists → answers at once", Date.now() - t0 < 2500 && r.changes.length > 0, `${Date.now() - t0} ms, ${r.changes.length} changes`)

  // cleanup: trash the QA folder (and the file in it)
  await sb.rpc("store_trash_folder", { p_folder_id: folder.id, p_actor: qa.id, p_reason: "qa push" })
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
