/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX check of merge_contacts() COMBINING two people's storages, on throw-away QA Test contacts */
/**
 * Contact merge slice 2 (dev job 938af003): when BOTH contacts already have their own storage, the merge combines them.
 * Proves in the SANDBOX, over a direct database connection (the same rights the production merge runs with):
 *   - the plan (store_combine_plan) is read-only and matches what the merge then does;
 *   - same-name folders are merged, a branch only the removed contact has moves over, files keep their ids;
 *   - a name clash keeps BOTH files (the incoming one is renamed, identical content is flagged, nothing is dropped);
 *   - people / shares / pending uploads follow; the removed storage and its top folder are gone;
 *   - trashed items on the removed side REFUSE the merge and leave everything where it was;
 *   - a refused merge (conflicting passport numbers) leaves both storages untouched;
 *   - the merge log carries the combine plan.
 * Refuses to run against production. Run: npx tsx scripts/crm-store/qa-cutover/merge-combine-storage-sandbox-check.ts
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

type Row = Record<string, unknown>

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await db.query(sql, p)).rows
  const tag = randomBytes(3).toString("hex")

  const mkContact = async (label: string, extra = "") => (await q(`insert into contacts (full_name, first_name, last_name, email${extra ? ", passport_number" : ""}) values ($1,'QA',$2,$3${extra ? ",$4" : ""}) returning id`,
    extra ? [`QA Test Combine ${tag}`, `Combine ${tag}`, `qa-combine-${label}-${tag}@example.test`, extra] : [`QA Test Combine ${tag}`, `Combine ${tag}`, `qa-combine-${label}-${tag}@example.test`]))[0].id as string
  const ownerOf = async (contact: string) => {
    const id = (await q("select store_ensure_owner('person', $1) as id", [contact]))[0].id as string
    if ((await q("select id from store_folders where owner_id=$1", [id])).length === 0) await q("select store_apply_template($1::uuid, 'person_standard', $2)", [id, `QA Test Combine ${tag} ${id.slice(0, 4)}`])
    return id
  }
  const rootOf = async (owner: string) => (await q("select id from store_folders where owner_id=$1 and parent_id is null", [owner]))[0].id as string
  const mkFolder = async (owner: string, parent: string, name: string) => (await q("insert into store_folders (owner_id, parent_id, kind, name, created_by) values ($1,$2,'custom',$3,null) returning id", [owner, parent, name]))[0].id as string
  let n = 0
  const mkFile = async (owner: string, folder: string, name: string, content: string) => {
    n++
    const sha = require("crypto").createHash("sha256").update(content).digest("hex") as string
    const f = (await q("insert into store_files (owner_id, folder_id, name) values ($1,$2,$3) returning id", [owner, folder, name]))[0].id as string
    const v = (await q("insert into store_file_versions (file_id, version_no, storage_bucket, storage_path, sha256, size_bytes, mime_type) values ($1,1,'crm-store',$2,$3,$4,'text/plain') returning id", [f, `qa-combine/${tag}/${n}`, sha, content.length]))[0].id as string
    await q("update store_files set current_version_id=$1 where id=$2", [v, f])
    return f
  }
  const merge = async (loser: string, winner: string, choices = "{}") =>
    (await q("select merge_contacts($1::uuid,$2::uuid,'qa-sandbox-check',$3::jsonb) as r", [loser, winner, choices]))[0].r as Row

  // ── Pair A: the full scenario ─────────────────────────────────────────────
  const W = await mkContact("w")
  const L = await mkContact("l")
  const ow = await ownerOf(W)
  const ol = await ownerOf(L)
  const rw = await rootOf(ow)
  const rl = await rootOf(ol)
  const wShared = await mkFolder(ow, rw, "Shared")
  await mkFolder(ow, rw, "OnlyKept")
  const lShared = await mkFolder(ol, rl, "Shared")
  const lOnly = await mkFolder(ol, rl, "OnlyRemoved")
  const lNested = await mkFolder(ol, lOnly, "Nested")

  const wA = await mkFile(ow, wShared, "a.txt", "kept a")
  const wRoot = await mkFile(ow, rw, "root.pdf", "same bytes")
  const lA2 = await mkFile(ol, lShared, "a (2).txt", "removed a2")
  const lA = await mkFile(ol, lShared, "a.txt", "removed a")
  const lB = await mkFile(ol, lShared, "b.txt", "removed b")
  const lRoot = await mkFile(ol, rl, "root.pdf", "same bytes")
  const lDeep = await mkFile(ol, lNested, "deep.txt", "deep")
  const lOnlyFile = await mkFile(ol, lOnly, "only.txt", "only")
  const removedFileIds = [lA2, lA, lB, lRoot, lDeep, lOnlyFile]

  // a person on a file, a share, a pending upload — all must follow
  await q("insert into store_file_subjects (file_id, subject_kind, contact_id, role) values ($1,'person',$2,'concerns')", [lA, L])
  const user = (await q("select id from auth.users limit 1"))[0]?.id as string | undefined
  if (user) await q("insert into store_file_shares (file_id, user_id, shared_by) values ($1,$2,$2)", [lB, user])
  const intent = (await q("insert into store_upload_intents (owner_id, folder_id, created_by, file_name, caller_key, staging_path, expires_at) values ($1,$2,$3,'x.txt',$4,'qa/x-' || $4, now() + interval '1 hour') returning id", [ol, lShared, user, `qa-combine-${tag}`]))[0].id as string

  // 1. the plan is read-only
  const planRes = (await q("select store_combine_plan($1::uuid,$2::uuid) as p", [L, W]))[0].p as Row
  check("C1 the plan says the storages are combined and lists every file", planRes.combined === true && planRes.files_moved === 6, JSON.stringify(planRes).slice(0, 300))
  const renamedPlan = (planRes.files_renamed as Row[]) ?? []
  check("C2 the plan lists the renames (a.txt -> a (3).txt, root.pdf identical content flagged)", renamedPlan.some((r) => r.name === "a.txt" && r.new_name === "a (3).txt" && r.same_content === false) && renamedPlan.some((r) => r.name === "root.pdf" && r.same_content === true), JSON.stringify(renamedPlan))
  check("C3 the plan lists the merged folder and the moved branch", JSON.stringify(planRes.folders_merged).includes("/Shared") && JSON.stringify(planRes.folders_moved).includes("OnlyRemoved"), JSON.stringify([planRes.folders_merged, planRes.folders_moved]))
  check("C4 the plan changed NOTHING (removed storage and its files are still there)",
    (await q("select id from store_owners where id=$1", [ol])).length === 1 && (await q("select id from store_files where owner_id=$1", [ol])).length === 6 && (await q("select id from store_folders where owner_id=$1", [ol])).length >= 4, "")

  // 2. a merge that is refused (different passport numbers, no choice) leaves both storages alone
  const P1 = await mkContact("p1", "AA111")
  const P2 = await mkContact("p2", "BB222")
  const op1 = await ownerOf(P1); const op2 = await ownerOf(P2)
  await mkFile(op2, await rootOf(op2), "p2.txt", "p2")
  let refused = ""
  try { await merge(P2, P1) } catch (e) { refused = (e as Error).message }
  check("C5 conflicting passport numbers refuse the merge", /different values for passport_number/.test(refused), refused)
  check("C6 ...and both storages are untouched", (await q("select id from store_owners where id=any($1)", [[op1, op2]])).length === 2 && (await q("select id from store_files where owner_id=$1", [op2])).length === 1, "")

  // 3. trashed items on the removed side refuse the combine
  const T1 = await mkContact("t1"); const T2 = await mkContact("t2")
  const ot1 = await ownerOf(T1); const ot2 = await ownerOf(T2)
  const trashed = await mkFile(ot2, await rootOf(ot2), "gone.txt", "gone")
  await q("select store_trash_file($1::uuid, $2::uuid, 'qa')", [trashed, user])
  const blocked = (await q("select store_combine_plan($1::uuid,$2::uuid) as p", [T2, T1]))[0].p as Row
  check("C7 trashed files make the plan say it cannot combine", blocked.combined === false && /trash/i.test(String(blocked.blocker)), JSON.stringify(blocked))
  let trashedErr = ""
  try { await merge(T2, T1) } catch (e) { trashedErr = (e as Error).message }
  check("C8 the merge itself refuses, in plain words", /trash/i.test(trashedErr), trashedErr)
  check("C9 ...and nothing moved", (await q("select id from store_owners where id=any($1)", [[ot1, ot2]])).length === 2 && (await q("select id from contacts where id=$1 and merged_into is null", [T2])).length === 1, "")

  // 4. the real merge of pair A
  const res = await merge(L, W)
  console.log("      storage_combined:", JSON.stringify(res.storage_combined).slice(0, 240))
  check("M1 the merge runs and reports the combine", res.ok === true && (res.storage_combined as Row)?.combined === true, JSON.stringify(res).slice(0, 200))
  check("M2 the removed storage record is gone, the kept one stays", (await q("select id from store_owners where id=$1", [ol])).length === 0 && (await q("select contact_id from store_owners where id=$1", [ow]))[0]?.contact_id === W, "")
  const moved = await q("select id, owner_id, folder_id, name, state, current_version_id from store_files where id = any($1)", [removedFileIds])
  check("M3 every file of the removed contact exists, with its own id, now owned by the kept storage", moved.length === 6 && moved.every((f) => f.owner_id === ow && f.state === "live"), JSON.stringify(moved.map((f) => [f.name, f.owner_id === ow])))
  check("M4 every file still has its version", (await q("select count(*)::int c from store_file_versions where file_id = any($1)", [removedFileIds]))[0].c === 6, "")
  const names = await q("select f.name, fo.name as folder from store_files f join store_folders fo on fo.id=f.folder_id where f.owner_id=$1 order by 2,1", [ow])
  console.log("      kept storage now:", JSON.stringify(names.map((r) => `${r.folder}/${r.name}`)))
  const inShared = names.filter((r) => r.folder === "Shared").map((r) => r.name as string).sort()
  check("M5 the clash kept BOTH files: Shared holds a.txt, a (2).txt, a (3).txt, b.txt", JSON.stringify(inShared) === JSON.stringify(["a (2).txt", "a (3).txt", "a.txt", "b.txt"]), JSON.stringify(inShared))
  const rootNames = (await q("select name from store_files where owner_id=$1 and folder_id=$2 order by name", [ow, rw])).map((r) => r.name as string)
  check("M6 identical content is NOT dropped: root.pdf and root (2).pdf both stay", JSON.stringify(rootNames) === JSON.stringify(["root (2).pdf", "root.pdf"]), JSON.stringify(rootNames))
  const kept = (await q("select content from (select 'kept a' as content) x"))[0]
  void kept
  check("M7 the kept contact's own file was not touched", (await q("select name, folder_id from store_files where id=$1", [wA]))[0].name === "a.txt" && (await q("select id from store_files where id=$1", [wRoot])).length === 1, "")
  check("M8 the branch only the removed contact had moved over whole", (await q("select fo.name from store_files f join store_folders fo on fo.id=f.folder_id where f.id=$1", [lDeep]))[0].name === "Nested", "")
  const sib = await q("select parent_id, name_key, count(*)::int c from store_folders where owner_id=$1 group by 1,2 having count(*)>1", [ow])
  check("M9 no two folders with the same name side by side", sib.length === 0, JSON.stringify(sib))
  check("M10 the removed top folder and the merged folder are gone; the moved branch now belongs to the kept storage", (await q("select id from store_folders where owner_id=$1", [ol])).length === 0 && (await q("select id from store_folders where id = any($1)", [[rl, lShared]])).length === 0 && (await q("select owner_id from store_folders where id=$1", [lOnly]))[0]?.owner_id === ow, "")
  check("M11 the person on the file moved to the kept contact", (await q("select contact_id from store_file_subjects where file_id=$1", [lA]))[0]?.contact_id === W, "")
  if (user) check("M12 the share followed the file", (await q("select user_id from store_file_shares where file_id=$1", [lB])).length === 1, "")
  const it = (await q("select owner_id, folder_id from store_upload_intents where id=$1", [intent]))[0]
  check("M13 the pending upload now points at the kept storage and its Shared folder", it?.owner_id === ow && it?.folder_id === wShared, JSON.stringify(it))
  const snap = (await q("select snapshot->'storage_combined' as s from contact_merge_log where loser_id=$1", [L]))[0]?.s as Row | undefined
  check("M14 the merge log carries the combine plan (files, renames, ids)", snap?.combined === true && Array.isArray(snap.file_ids) && (snap.files_renamed as Row[]).length === 2, JSON.stringify(snap).slice(0, 200))
  check("M15 the removed contact is a tombstone", (await q("select merged_into from contacts where id=$1", [L]))[0].merged_into === W, "")
  check("M16 a 'combined' event was recorded", (await q("select id from store_events where event='combined' and owner_id=$1", [ow])).length === 1, "")

  // 5. only the removed contact has storage: still works as before (the storage becomes the kept contact's)
  const S1 = await mkContact("s1"); const S2 = await mkContact("s2")
  const os2 = await ownerOf(S2)
  await mkFile(os2, await rootOf(os2), "solo.txt", "solo")
  const r2 = await merge(S2, S1)
  check("S1 only the removed contact had storage: it becomes the kept contact's", r2.storage_combined === null && (await q("select contact_id from store_owners where id=$1", [os2]))[0]?.contact_id === S1, JSON.stringify(r2).slice(0, 200))

  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
