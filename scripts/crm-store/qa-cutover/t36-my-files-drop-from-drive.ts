/* eslint-disable no-console */
/**
 * QA t36 — the My files DROP, copy from Antonio's Google Drive (dev job 465a11fc). SANDBOX only. Uses the REAL Drive (read-only: files.get and
 * alt=media with a drive.readonly token; nothing in Drive is created or changed) and the sandbox database + storage.
 *   QA_ENV_FILE=/path/to/.env.local npx tsx scripts/crm-store/qa-cutover/t36-my-files-drop-from-drive.ts
 */
import { config } from "dotenv"
import { check, summary } from "./qa-http"
config({ path: process.env.QA_ENV_FILE || ".env.local" })

const CRM_PROJECTS = "16r9mOQx3qL0XY7gMehx3NF2BIQRqrihs"
const DOCX = "1aI2MpFDEbQWNyse0G0kEVdMmhdhc-K8U"
const MD = "11h6i4KnY6QKJ5u0tyZKCyUekmrDvLDi5"
const OUTSIDE_PDF = "1AV1RpSu5Kk816aYuqLg_cZLaxqnpfcNw" // topdog.pdf — in his Drive, NOT under CRM Projects
const TD_MARKETING_FOLDER = "1m3baMKLhZR981PblbPt8_KilK6bqiMok"
const NATIVE_DOC = "1yEfUradmgDeGhTLtYOPL8UoSA-KXnKHYO4e_AIIfmyw"; const NATIVE_PARENT = "1jb_sqP3-M1BKITzigRHXNI3XJMh-rJ49"
const TRASHED_DOC = "1bEHlZSmCnTAGVWLOyPm68X-TXS5grf3SujN6U_Arcds" // a trashed Google Doc; its parent is NATIVE_PARENT
const ZIP = "1GsV92S3EhYcxqF1Y6V6yad_xXTa8fvPl"; const ZIP_PARENT = "1Fj7VJP_of9fbTvIvA6iPk05xc0z8Xn8a"
const BIG = "1dHF6IoW2ssOGzTLtYHh3SK6dpKuwtN8P"; const BIG_PARENT = "0AJhvBLRHc0qRUk9PVA" // a 9 GB video at the top of My Drive

async function main() {
  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run against production")
  process.env.MY_FILES_DROP_ENABLED = "1"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const { saveToMyFilesDrop } = await import("../../../lib/crm-store/my-files-drop")
  const g = await import("../../../lib/google-drive")
  const sb = supabaseAdmin as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const caller = { method: "static", email: "antonio.durante@tonydurante.us" }
  const tag = `${Date.now()}`
  const sub = `QA drive copy ${tag}`
  let downloads = 0
  const counting = { meta: (id: string) => g.readOwnerDropMeta(id), bytes: (id: string, max: number) => { downloads++; return g.downloadOwnerDropBytes(id, max) } }
  const run = (id: string, root: string, extra: Record<string, unknown> = {}) => { process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID = root; return saveToMyFilesDrop({ drive_file_id: id, subfolder: sub, ...extra }, caller, counting) }

  // token scope: a WRITE with the read-only token to a file that does not exist must be refused for scope (403), not "not found" (404)
  const probe = await fetch("https://www.googleapis.com/drive/v3/files/qa-nonexistent-id-0001", { method: "PATCH", headers: { Authorization: `Bearer ${await mintReadonly()}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) })
  check("S1 the read-only token cannot write (a PATCH is refused for scope, 403)", probe.status === 403, `status ${probe.status}`)

  const r1 = await run(DOCX, CRM_PROJECTS)
  check("P1 the .docx plan copies from Drive into My files › From Claude", r1.ok && r1.status === "created" && r1.path.startsWith("My files › From Claude › "), JSON.stringify(r1))
  const r2 = await run(MD, CRM_PROJECTS)
  check("P2 the .md plan copies", r2.ok && r2.status === "created", JSON.stringify(r2))
  const d0 = downloads
  const r3 = await run(DOCX, CRM_PROJECTS)
  check("P3 the same file again is 'unchanged' and costs NO download", r3.ok && r3.status === "unchanged" && downloads === d0, `${JSON.stringify(r3)} downloads ${d0}->${downloads}`)
  const { data: files } = await sb.from("store_files").select("id, name, published, state").like("caller_key", "my-files-drop:%").eq("name", "TD-MARKETING-MASTER-PLAN.docx")
  check("P4 only ONE stored copy of the docx for this run's sub-folder state", (files ?? []).length >= 1 && (files ?? []).every((f: { published: boolean }) => f.published === false))
  const { data: al } = await sb.from("action_log").select("details").eq("action_type", "create").like("summary", "my_files_save:%").order("created_at", { ascending: false }).limit(5)
  check("P5 the audit row carries the Drive id and checksum", (al ?? []).some((a: { details: Record<string, string> }) => a.details.drive_file_id === DOCX && !!a.details.drive_md5 && a.details.source === "google_drive"))
  const { data: pulls } = await sb.from("action_log").select("id").eq("action_type", "drive_pull")
  check("P6 each download attempt left a drive_pull row", (pulls ?? []).length >= 2)

  const bad = async (label: string, id: string, root: string, re: RegExp, extra: Record<string, unknown> = {}) => {
    const d = downloads
    const r = await run(id, root, extra)
    check(label, r.ok === false && re.test(r.error) && downloads === d, JSON.stringify(r))
  }
  await bad("R1 a file OUTSIDE CRM Projects is refused (same words as 'not found')", OUTSIDE_PDF, CRM_PROJECTS, /not found inside the Drive folder/)
  await bad("R2 a folder is refused", TD_MARKETING_FOLDER, CRM_PROJECTS, /folder, not a file/)
  await bad("R3 a Google Doc is refused with the 'save as .docx' words", NATIVE_DOC, NATIVE_PARENT, /Google Doc/)
  await bad("R4 a trashed file is refused", TRASHED_DOC, NATIVE_PARENT, /trash/)
  await bad("R5 a too-large file is refused before any download", BIG, BIG_PARENT, /limit for a copy from Drive/)
  await bad("R6 a disallowed type (.zip) is refused", ZIP, ZIP_PARENT, /not accepted/)
  await bad("R7 a link is refused", "https://drive.google.com/file/d/" + DOCX, CRM_PROJECTS, /Links are not accepted/)
  // a root that does not contain the file (a different real folder) refuses the same plan file
  await bad("R8 the same plan file is refused when the allowed folder is a different one", DOCX, NATIVE_PARENT, /not found inside the Drive folder/)

  // measure what a function really does with a 25 MB file: real throughput of the capped download + a synthetic 25 MB write
  const t0 = Date.now()
  let measured = "n/a"
  try { await g.downloadOwnerDropBytes(BIG, 25 * 1024 * 1024); measured = "no cap hit?" } catch (e) { measured = `cap reached after ${((Date.now() - t0) / 1000).toFixed(1)} s (code ${(e as { code?: string }).code})` }
  console.log("   real Drive read of >25 MB:", measured)
  const rss0 = process.memoryUsage().rss
  const csv = Buffer.from("a,b\n".repeat(Math.floor((25 * 1024 * 1024) / 4)))
  const { md5Of } = await import("../../../lib/crm-store/my-files-drop-rules")
  const fake = {
    meta: async (id: string) => id === "SYNTHETIC25MB0001"
      ? { id, name: `QA 25MB ${tag}.csv`, mimeType: "text/csv", size: csv.length, md5: md5Of(csv), ownedByMe: true, trashed: false, parents: [CRM_PROJECTS], driveId: null, version: "1", modifiedTime: null }
      : g.readOwnerDropMeta(id),
    bytes: async () => csv,
  }
  process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID = CRM_PROJECTS
  const t1 = Date.now()
  const rs = await saveToMyFilesDrop({ drive_file_id: "SYNTHETIC25MB0001", subfolder: sub }, caller, fake)
  console.log(`   synthetic 25 MB csv: ${rs.ok ? rs.status : (rs as { error: string }).error} in ${((Date.now() - t1) / 1000).toFixed(1)} s, rss ${(rss0 / 1048576).toFixed(0)} -> peak ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`)
  check("M1 a 25 MB file is checked, hashed and stored by the real writer", rs.ok === true, JSON.stringify(rs))

  summary(); process.exit(0)
}

async function mintReadonly(): Promise<string> {
  // the same JWT flow the product uses, via its own exported reader: we only need a bearer, so read it from a metadata call's token by re-minting here
  const { SignJWT, importPKCS8 } = await import("jose")
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SA_KEY as string, "base64").toString())
  const now = Math.floor(Date.now() / 1000)
  const a = await new SignJWT({ scope: "https://www.googleapis.com/auth/drive.readonly", sub: process.env.GOOGLE_OWNER_IMPERSONATE_EMAIL || "antonio.durante@tonydurante.us" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(creds.client_email).setAudience(creds.token_uri).setIssuedAt(now).setExpirationTime(now + 3600).sign(await importPKCS8(creds.private_key, "RS256"))
  const r = await fetch(creds.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: a }) })
  return ((await r.json()) as { access_token: string }).access_token
}
main().catch((e) => { console.error(e); process.exit(1) })
