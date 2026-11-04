/* eslint-disable no-console */
/* SANDBOX proof of the Zoom recordings sync (dev job 9aec66fa, 4 Nov 2026): a FAKE Zoom serves a real 3 MB file and a small text file; the REAL storage, staging, registration and database do the rest.
   Seeds (only if missing): Business › Zoom Calls › "Zoom QA Marekting", and one active team with an owner. Cleans only its own rows afterwards. Refuses anything but the sandbox.
   Usage:  QA_ENV_FILE=/path/to/.env.local npx tsx scripts/marketing/qa-zoom-recordings.ts */
import { config } from "dotenv"
config({ path: process.env.QA_ENV_FILE ?? ".env.local" })
import { createHash } from "node:crypto"
import { Client } from "pg"
import type { ZoomApi, ZoomRecordingMeeting } from "@/lib/zoom"
import { syncRecordings, type SyncDeps } from "@/lib/marketing/zoom-recordings"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const MB3 = Buffer.alloc(3 * 1024 * 1024, 7).map((_, i) => (i * 31 + 7) % 251)
const TXT = Buffer.from("chat line 1\nchat line 2\n")
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
let checks = 0, failures = 0
const ok = (cond: boolean, what: string) => { checks++; if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${what}`) }

const MEETING: ZoomRecordingMeeting = {
  uuid: "qa-uuid-1", meetingId: "99900001", topic: "ZQA Call with Antonio Durante · Maria", startTime: "2026-11-04T15:30:00Z",
  files: [
    { id: "zqa-video-1", fileType: "MP4", extension: "mp4", sizeBytes: MB3.length, recordingType: "shared_screen_with_speaker_view", status: "completed", downloadUrl: "https://zoom.us/rec/download/zqa-video-1" },
    { id: "zqa-chat-1", fileType: "CHAT", extension: "txt", sizeBytes: TXT.length, recordingType: "chat_file", status: "completed", downloadUrl: "https://zoom.us/rec/download/zqa-chat-1" },
    { id: "zqa-wait-1", fileType: "MP4", extension: "mp4", sizeBytes: 5, recordingType: "audio_only", status: "processing", downloadUrl: "https://zoom.us/rec/download/zqa-wait-1" },
  ],
}
let failOpenFor: string | null = null
const fakeZoom: ZoomApi = {
  createMeeting: async () => { throw new Error("not used") }, updateMeeting: async () => {}, deleteMeeting: async () => {},
  listRecordings: async () => [MEETING],
  openRecording: async (url) => {
    const id = url.split("/").pop()!
    if (failOpenFor === id) throw new Error("Zoom answered 500 for the recording")
    const bytes = id === "zqa-video-1" ? MB3 : TXT
    let i = 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (i >= bytes.length) { c.close(); return } const n = Math.min(65536, bytes.length - i); c.enqueue(new Uint8Array(bytes.subarray(i, i + n))); i += n } })
    return { body, size: bytes.length, contentType: id === "zqa-video-1" ? "video/mp4" : "text/plain" }
  },
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes(SANDBOX_REF)) throw new Error("Sandbox only.")
  const pg = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await pg.connect()
  const made = { team: null as string | null, zoomCalls: null as string | null, folder: null as string | null }
  try {
    const { ensureArea } = await import("@/lib/crm-store/structure")
    const { ensureChildFolder } = await import("@/lib/crm-store/save-form")
    const ownerId = await ensureArea("business", null)
    const top = (await pg.query("select id from store_folders where owner_id=$1 and parent_id is null and trashed_at is null limit 1", [ownerId])).rows[0].id as string
    const found = (await pg.query("select id from store_folders where parent_id=$1 and name ilike 'Zoom Calls' and trashed_at is null limit 1", [top])).rows[0]?.id as string | undefined
    const zc = found ?? await ensureChildFolder(top, "Zoom Calls")
    if (!found) made.zoomCalls = zc
    const others = (await pg.query("select name from store_folders where parent_id=$1 and trashed_at is null and name ~* '(market|marek)'", [zc])).rows
    if (others.length) throw new Error(`Sandbox already has a marketing-looking folder in Zoom Calls (${others.map(o => o.name).join(", ")}); remove it first.`)
    made.folder = await ensureChildFolder(zc, "Zoom QA Marekting")
    const u = (await pg.query("select id from auth.users order by created_at limit 1")).rows[0].id as string
    made.team = (await pg.query("insert into marketing_teams (name, owner_user_id, status, created_by) values ('Zoom QA (ZQA)', $1, 'active', 'qa') returning id", [u])).rows[0].id as string
    const { liveSyncSetup } = await import("@/lib/marketing/zoom-recordings-live")
    const setup = await liveSyncSetup({ zoom: fakeZoom, teamId: made.team! })
    if (setup.ok === false) throw new Error(`setup refused: ${setup.reason}`)
    const deps: SyncDeps = { ...setup.deps, hosts: async () => [{ host: "qa@example.test", scope: "all" }] }

    // 1. first run: the finished files are saved, the one still processing is not
    const r1 = await syncRecordings(deps)
    ok(r1.saved === 2 && r1.failed.length === 0, `first run saved 2 files (${JSON.stringify({ saved: r1.saved, failed: r1.failed, seen: r1.seen })})`)
    const files = (await pg.query("select f.id, f.name, f.state, v.size_bytes, v.sha256 from store_files f left join store_file_versions v on v.id = f.current_version_id where f.folder_id=$1 and f.owner_id=$2 order by f.name", [made.folder, ownerId])).rows
    ok(files.length === 2, `two files are in the folder: ${files.map(f => f.name).join(" | ")}`)
    const video = files.find(f => /video\.mp4$/.test(f.name)), chat = files.find(f => /chat\.txt$/.test(f.name))
    ok(!!video && Number(video.size_bytes) === MB3.length && video.sha256 === sha(MB3), "the 3 MB video arrived byte for byte (size and sha256 match)")
    ok(!!chat && Number(chat.size_bytes) === TXT.length && chat.sha256 === sha(TXT), "the chat file arrived byte for byte")
    ok(files.every(f => f.name.startsWith("2026-11-04 15.30 UTC ZQA Call with Antonio Durante")), "names carry the UTC start and the call title")
    const rec = (await pg.query("select zoom_file_id, status, store_file_id from marketing_zoom_recordings where zoom_file_id like 'zqa-%' order by zoom_file_id")).rows
    ok(rec.length === 2 && rec.every(x => x.status === "saved" && x.store_file_id), "two records say 'saved' with their storage file")

    // 2. second run: nothing is saved twice
    const r2 = await syncRecordings(deps)
    ok(r2.saved === 0 && r2.skipped === 2, `second run saved nothing new (skipped ${r2.skipped})`)
    const after = (await pg.query("select count(*)::int n from store_files where folder_id=$1 and state='live'", [made.folder])).rows[0].n
    ok(after === 2, "still exactly two files in the folder")

    // 3. a failed download leaves no half file and no record, and the next run saves it
    await pg.query("delete from marketing_zoom_recordings where zoom_file_id='zqa-chat-1'")
    await pg.query("update store_files set state='trashed', trashed_at=now(), name_key=null where id=$1 and state='live'", [chat.id])
    failOpenFor = "zqa-chat-1"
    const r3 = await syncRecordings(deps)
    ok(r3.saved === 0 && r3.failed.length === 1, "a Zoom failure is reported, not hidden")
    const gone = (await pg.query("select count(*)::int n from marketing_zoom_recordings where zoom_file_id='zqa-chat-1'")).rows[0].n
    ok(gone === 0, "the failed file left no record behind")
    failOpenFor = null
    const r4 = await syncRecordings(deps)
    ok(r4.saved === 1 && r4.failed.length === 0, "the next run saves it")
  } finally {
    // clean ONLY what this run made
    const mine = (await pg.query("select id from store_files where caller_key like 'zoom:zqa-%'")).rows.map(r => r.id)
    if (mine.length) { const r = await pg.query("update store_files set state='trashed', trashed_at=now(), name_key=null where id = any($1) and state='live'", [mine]); console.log(`cleanup: trashed ${r.rowCount} QA file(s)`) }
    await pg.query("delete from marketing_zoom_recordings where zoom_file_id like 'zqa-%'")
    if (made.folder) { const r = await pg.query("update store_folders set trashed_at=now() where id=$1 and trashed_at is null", [made.folder]).catch((e) => { console.log("folder cleanup:", e.message); return { rowCount: 0 } }); console.log(`cleanup: folder trashed ${r.rowCount}`) }
    if (made.team) await pg.query("delete from marketing_teams where id=$1", [made.team])
    await pg.end()
  }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) process.exit(1)
}
main().catch(e => { console.error(e instanceof Error ? e.stack : e); process.exit(1) })
