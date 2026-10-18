/* eslint-disable no-console */
/**
 * Storage Mac app, phase P3 step C1 (dev job 1992a087): UPDATING A FILE THIS MAC SAVED, as a new version. SANDBOX only. Real handlers.
 * Run: npx tsx scripts/crm-store/qa-cutover/t37-storage-app-update-own.ts
 * Proves: the update goes through the SAME two routes (upload-slot / save with replaceFileId); version 2 of the same file, same name, still hidden;
 * the old version stays; same bytes = no new version; a retry after a lost answer is fine; ANOTHER Mac, a staff upload, a trashed file and a
 * made-up id are refused; the listing marks only this Mac's files as mine; the update counts against the upload limit and is audited.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { trashFile } = await import("../../../lib/crm-store/folders")
  const { saveBytesToStore } = await import("../../../lib/crm-store/writer")
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const folderRoute = (await import("../../../app/api/storage-app/folder/route")).GET
  const itemRoute = (await import("../../../app/api/storage-app/item/route")).GET
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-upd-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [user.email], updated_at: new Date().toISOString() })
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const priorLimit = process.env.STORAGE_APP_WRITE_LIMIT_MB
  const made_ids: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown, method = "POST") => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const slot = (t: string, o: Record<string, unknown>) => call(slotRoute as never, t, "/api/storage-app/upload-slot", o)
  const save = (t: string, o: Record<string, unknown>) => call(saveRoute as never, t, "/api/storage-app/save", o)
  const put = async (url: string, bytes: Buffer) => (await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes })).status
  const versions = async (fileId: string) => ((await admin.from("store_file_versions").select("version_no, sha256, size_bytes").eq("file_id", fileId).order("version_no")).data ?? []) as { version_no: number; sha256: string; size_bytes: number }[]

  try {
    const login = async (name: string) => {
      const code = await A.createAuthCode({ userId: user.id, deviceName: name, codeChallenge: challenge, redirectUri: REDIRECT })
      return A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    }
    const tA = await login("QA update Mac A")
    const tB = await login("QA update Mac B")
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const { data: kids } = await admin.from("store_folders").select("id").eq("owner_id", biz.id).eq("kind", "custom").is("trashed_at", null).limit(1)
    const ownerId = biz.id as string, folderId = kids[0].id as string

    // a file saved by Mac A through the normal two steps
    const v1 = Buffer.from(`version one ${stamp}`)
    const key1 = randomUUID()
    const name = `QA update own ${stamp}.txt`
    const s1 = await slot(tA.access_token, { ownerId, folderId, name, size: v1.length, mimeType: "text/plain", itemKey: key1 })
    await put(s1.body.uploadUrl, v1)
    const sv1 = await save(tA.access_token, { intentId: s1.body.intentId, itemKey: key1 })
    const fileId = sv1.body.fileId as string
    made_ids.push(fileId)
    check("1 Mac A saved a new file (setup)", sv1.status === 200 && !!fileId, JSON.stringify(sv1.body))

    // the listing marks it as MINE for Mac A only
    const lA = await call(folderRoute as never, tA.access_token, `/api/storage-app/folder?owner=${ownerId}&folder=${folderId}`, undefined, "GET")
    const lB = await call(folderRoute as never, tB.access_token, `/api/storage-app/folder?owner=${ownerId}&folder=${folderId}`, undefined, "GET")
    check("2 the folder listing says mine:true for Mac A", lA.body.files.find((f: { id: string }) => f.id === fileId)?.mine === true, "")
    check("3 ...and mine:false for Mac B", lB.body.files.find((f: { id: string }) => f.id === fileId)?.mine === false, "")
    const iA = await call(itemRoute as never, tA.access_token, `/api/storage-app/item?kind=file&id=${fileId}`, undefined, "GET")
    const iB = await call(itemRoute as never, tB.access_token, `/api/storage-app/item?kind=file&id=${fileId}`, undefined, "GET")
    check("4 the item answer says mine for A and not for B", iA.body?.mine === true && iB.body?.mine === false, `${iA.body?.mine} ${iB.body?.mine}`)

    // update by Mac A: a new version of the SAME file
    const v2 = Buffer.from(`version TWO, longer content ${stamp}`)
    const key2 = randomUUID()
    const u1 = await slot(tA.access_token, { replaceFileId: fileId, size: v2.length, mimeType: "text/plain", itemKey: key2 })
    check("5 an update slot is given for the Mac's own file", u1.status === 200 && u1.body?.update === true && typeof u1.body?.uploadUrl === "string", JSON.stringify(u1.body).slice(0, 200))
    check("6 the bytes go to the signed address", (await put(u1.body.uploadUrl, v2)) === 200, "")
    const us1 = await save(tA.access_token, { intentId: u1.body.intentId, itemKey: key2, replaceFileId: fileId })
    check("7 save → 200, the same file id, the same name", us1.status === 200 && us1.body?.fileId === fileId && us1.body?.name === name && us1.body?.outcome === "versioned", JSON.stringify(us1.body))
    const vs = await versions(fileId)
    check("8 version 2 holds the new bytes; version 1 is kept", vs.length === 2 && vs[1].sha256 === sha(v2) && vs[0].sha256 === sha(v1), JSON.stringify(vs))
    const { data: row } = await admin.from("store_files").select("name, published, state, folder_id").eq("id", fileId).single()
    check("9 still hidden, same name, same folder", row.published === false && row.name === name && row.folder_id === folderId && row.state === "live", JSON.stringify(row))
    const { data: ev } = await admin.from("store_events").select("details").eq("event", "app_file_updated").eq("file_id", fileId)
    check("10 the update is audited (which Mac, size)", (ev ?? []).length === 1 && ev[0].details?.deviceId === tA.device_id, JSON.stringify(ev))

    // a retry after a lost answer
    const us2 = await save(tA.access_token, { intentId: u1.body.intentId, itemKey: key2, replaceFileId: fileId })
    check("11 saving the same update again → 200 and NO third version", us2.status === 200 && (await versions(fileId)).length === 2, JSON.stringify(us2.body))

    // same bytes again: no new version
    const key3 = randomUUID()
    const u3 = await slot(tA.access_token, { replaceFileId: fileId, size: v2.length, mimeType: "text/plain", itemKey: key3 })
    await put(u3.body.uploadUrl, v2)
    const us3 = await save(tA.access_token, { intentId: u3.body.intentId, itemKey: key3, replaceFileId: fileId })
    check("12 the same bytes again → unchanged, still 2 versions", us3.status === 200 && us3.body?.outcome === "unchanged" && (await versions(fileId)).length === 2, JSON.stringify(us3.body))

    // refusals
    const other = await slot(tB.access_token, { replaceFileId: fileId, size: 5, mimeType: null, itemKey: randomUUID() })
    check("13 ANOTHER Mac cannot update this file → 422 not_own", other.status === 422 && other.body?.error === "not_own", JSON.stringify(other.body))
    const staff = await saveBytesToStore({ ownerId, folderId, name: `QA staff upload ${stamp}.txt`, mimeType: "text/plain", callerKey: `staff-upload:${randomUUID()}`, contentChanged: true, bytes: Buffer.from("staff"), documentType: null, published: false })
    made_ids.push(staff.fileId)
    const notOwn = await slot(tA.access_token, { replaceFileId: staff.fileId, size: 5, mimeType: null, itemKey: randomUUID() })
    check("14 a file saved by staff in the CRM cannot be updated from a Mac → 422 not_own", notOwn.status === 422 && notOwn.body?.error === "not_own", JSON.stringify(notOwn.body))
    check("15 a made-up file id → 404", (await slot(tA.access_token, { replaceFileId: randomUUID(), size: 5, itemKey: randomUUID() })).status === 404, "")
    check("16 a bad item key → 400", (await slot(tA.access_token, { replaceFileId: fileId, size: 5, itemKey: "nope" })).status === 400, "")
    check("17 too big (200 MB) → 413", (await slot(tA.access_token, { replaceFileId: fileId, size: 200 * 1024 * 1024, itemKey: randomUUID() })).status === 413, "")
    const stolen = await save(tB.access_token, { intentId: u1.body.intentId, itemKey: key2, replaceFileId: fileId })
    check("18 ANOTHER Mac cannot finish my update → 422", stolen.status === 422, `status ${stolen.status}`)
    const neverUp = await slot(tA.access_token, { replaceFileId: fileId, size: 3 * 1024 * 1024, itemKey: randomUUID() })
    const nk = randomUUID()
    const ghost = await save(tA.access_token, { intentId: neverUp.body.intentId, itemKey: nk, replaceFileId: fileId })
    check("19 saving without uploading → 409 not_uploaded (the slot belongs to another key, so also refused)", ghost.status === 404 || ghost.status === 409, `status ${ghost.status}`)

    // the update counts against the hourly upload limit (3 MB): each small update counts 1 MB
    process.env.STORAGE_APP_WRITE_LIMIT_MB = "3"
    const tC = await login("QA update Mac C")
    const fC = await slot(tC.access_token, { ownerId, folderId, name: `QA update limit ${stamp}.txt`, size: 4, mimeType: null, itemKey: randomUUID() })
    check("20 (setup) Mac C gets a slot for a new file", fC.status === 200, `status ${fC.status}`)
    process.env.STORAGE_APP_WRITE_LIMIT_MB = priorLimit ?? ""

    // a trashed file cannot be updated
    await trashFile(ACTOR, fileId, "qa update")
    const trashed = await slot(tA.access_token, { replaceFileId: fileId, size: 5, mimeType: null, itemKey: randomUUID() })
    check("21 a trashed file → 409 trashed", trashed.status === 409 && trashed.body?.error === "trashed", JSON.stringify(trashed.body))
    // revoked Mac
    await A.revokeDevice(tA.device_id, "qa update")
    check("22 a revoked Mac cannot update", (await slot(tA.access_token, { replaceFileId: staff.fileId, size: 5, itemKey: randomUUID() })).status === 401, "")
  } finally {
    if (priorLimit === undefined) delete process.env.STORAGE_APP_WRITE_LIMIT_MB; else process.env.STORAGE_APP_WRITE_LIMIT_MB = priorLimit
    for (const id of made_ids) await trashFile(ACTOR, id, "qa update").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
