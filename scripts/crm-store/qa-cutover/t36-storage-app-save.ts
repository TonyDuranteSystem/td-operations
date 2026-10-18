/* eslint-disable no-console */
/**
 * Storage Mac app, phase P3 step A (dev job 1992a087): SAVING a new file from a Mac. SANDBOX only. Real database + real storage + the real
 * route handlers (no dev server needed).  Run: npx tsx scripts/crm-store/qa-cutover/t36-storage-app-save.ts
 * Proves: slot → upload → save puts the file in Business, hidden, byte-exact; a retry gives the same file, never a second; a taken name,
 * junk names, too-big, top folders, client storages, hidden study copies and other people's My files are refused; the upload limit stops a
 * Mac (one audit row); a file that never arrived is refused and its limit share given back; another Mac cannot finish my upload; a revoked Mac is stopped.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { trashFile } = await import("../../../lib/crm-store/folders")
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const folderRoute = (await import("../../../app/api/storage-app/folder/route")).GET
  const itemRoute = (await import("../../../app/api/storage-app/item/route")).GET
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-save-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD to the list: replacing it would lock the real Macs out for the length of the test
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const priorLimit = process.env.STORAGE_APP_WRITE_LIMIT_MB
  const savedIds: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown, method = "POST") => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const slot = (token: string, o: Record<string, unknown>) => call(slotRoute as never, token, "/api/storage-app/upload-slot", o)
  const save = (token: string, o: Record<string, unknown>) => call(saveRoute as never, token, "/api/storage-app/save", o)
  const put = async (url: string, bytes: Buffer) => (await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes })).status

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA save Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const { data: rootF } = await admin.from("store_folders").select("id, kind").eq("owner_id", biz.id).is("parent_id", null).maybeSingle()
    const { data: kids } = await admin.from("store_folders").select("id, kind").eq("owner_id", biz.id).eq("kind", "custom").is("trashed_at", null).limit(1)
    const folderId = kids[0].id as string
    const ownerId = biz.id as string
    const bytes = Buffer.from(`hello from a Mac ${stamp}`)
    const sha = createHash("sha256").update(bytes).digest("hex")

    // 1 — the folder says whether a Mac may save into it
    const fl = await call(folderRoute as never, t.access_token, `/api/storage-app/folder?owner=${ownerId}&folder=${folderId}`, undefined, "GET")
    check("1 the folder answer says canSave:true for a Business folder", fl.status === 200 && fl.body?.folder?.canSave === true, JSON.stringify(fl.body?.folder))
    const rootItem = await call(itemRoute as never, t.access_token, `/api/storage-app/item?kind=folder&id=${rootF.id}`, undefined, "GET")
    check("2 the top folder says canSave:false", rootItem.status === 200 && rootItem.body?.canSave === false, JSON.stringify(rootItem.body))
    const folderItem = await call(itemRoute as never, t.access_token, `/api/storage-app/item?kind=folder&id=${folderId}`, undefined, "GET")
    check("3 the item answer for a Business folder says canSave:true", folderItem.body?.canSave === true, JSON.stringify(folderItem.body))

    // 2 — the happy path: slot → upload → save
    const itemKey = randomUUID()
    const name = `QA saved from a Mac ${stamp}.txt`
    const s1 = await slot(t.access_token, { ownerId, folderId, name, size: bytes.length, mimeType: "text/plain", itemKey })
    check("4 a slot is given for a normal file", s1.status === 200 && typeof s1.body?.intentId === "string" && typeof s1.body?.uploadUrl === "string", `status ${s1.status} ${JSON.stringify(s1.body)}`.slice(0, 200))
    const up = await put(s1.body.uploadUrl, bytes)
    check("5 the bytes go straight to the signed address", up === 200, `status ${up}`)
    const sv = await save(t.access_token, { intentId: s1.body.intentId, itemKey })
    check("6 save → 200 with the file id and the name", sv.status === 200 && typeof sv.body?.fileId === "string" && sv.body?.name === name, JSON.stringify(sv.body))
    if (sv.body?.fileId) savedIds.push(sv.body.fileId)
    const { data: row } = await admin.from("store_files").select("id, owner_id, folder_id, published, document_type, state, caller_key, current_version_id").eq("id", sv.body.fileId).single()
    const { data: ver } = await admin.from("store_file_versions").select("sha256, size_bytes, version_no, created_by").eq("id", row.current_version_id).single()
    check("7 stored byte-exact, version 1, in the chosen folder, by this person", ver.sha256 === sha && ver.size_bytes === bytes.length && ver.version_no === 1 && row.folder_id === folderId && ver.created_by === user.id, JSON.stringify(ver))
    check("8 HIDDEN from clients (published false), no document type", row.published === false && row.document_type === null, JSON.stringify(row))
    const { data: ev } = await admin.from("store_events").select("event, details").eq("event", "app_file_saved").eq("file_id", row.id)
    check("9 the save is audited (who, which Mac, size)", (ev ?? []).length === 1 && ev[0].details?.deviceId === t.device_id, JSON.stringify(ev))

    // 3 — a retry never makes a second copy
    const sv2 = await save(t.access_token, { intentId: s1.body.intentId, itemKey })
    check("10 saving the same file again returns the SAME file", sv2.status === 200 && sv2.body?.fileId === sv.body.fileId, JSON.stringify(sv2.body))
    const s1b = await slot(t.access_token, { ownerId, folderId, name, size: bytes.length, mimeType: "text/plain", itemKey })
    check("11 asking for a slot again says already saved, same file", s1b.status === 200 && s1b.body?.alreadySaved === true && s1b.body?.fileId === sv.body.fileId, JSON.stringify(s1b.body))
    const { data: copies } = await admin.from("store_files").select("id").eq("folder_id", folderId).eq("caller_key", row.caller_key)
    check("12 exactly one file exists for the key", (copies ?? []).length === 1, `rows=${(copies ?? []).length}`)

    // 4 — what is refused
    const sameName = await slot(t.access_token, { ownerId, folderId, name, size: 5, mimeType: "text/plain", itemKey: randomUUID() })
    check("13 a name already taken in the folder → 409 exists (never a new version)", sameName.status === 409 && sameName.body?.error === "exists", JSON.stringify(sameName.body))
    const sameNameCase = await slot(t.access_token, { ownerId, folderId, name: name.toUpperCase(), size: 5, mimeType: "text/plain", itemKey: randomUUID() })
    check("14 the same name in other capitals is also taken", sameNameCase.status === 409, `status ${sameNameCase.status}`)
    await trashFile(ACTOR, sv.body.fileId, "qa save")
    const inTrash = await slot(t.access_token, { ownerId, folderId, name, size: 5, mimeType: "text/plain", itemKey: randomUUID() })
    check("15 a name whose file is in the trash is free again (the trash frees the name)", inTrash.status === 200, `status ${inTrash.status}`)
    for (const junk of [".DS_Store", "._x.pdf", "~$a.docx", "x.crdownload", "y.download"]) {
      const j = await slot(t.access_token, { ownerId, folderId, name: junk, size: 5, mimeType: null, itemKey: randomUUID() })
      check(`16 junk name ${junk} → 422 ignored`, j.status === 422 && j.body?.error === "ignored", `status ${j.status}`)
    }
    const huge = await slot(t.access_token, { ownerId, folderId, name: `huge ${stamp}.bin`, size: 200 * 1024 * 1024, mimeType: null, itemKey: randomUUID() })
    check("17 a 200 MB file → 413 too_big", huge.status === 413 && huge.body?.error === "too_big", `status ${huge.status}`)
    const top = await slot(t.access_token, { ownerId, folderId: rootF.id, name: `top ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
    check("18 a storage's top folder → 422", top.status === 422 && top.body?.error === "not_allowed", `status ${top.status} ${JSON.stringify(top.body)}`)
    const { data: coOwner } = await admin.from("store_owners").select("id").eq("kind", "company").eq("study_only", false).limit(1).maybeSingle()
    // a client folder of a kind that is NOT allowed (Banking): refused. (Allowed client folders are tested in t38.)
    const { data: coFolder } = await admin.from("store_folders").select("id").eq("owner_id", coOwner.id).eq("kind", "banking").is("trashed_at", null).limit(1).maybeSingle()
    const client = await slot(t.access_token, { ownerId: coOwner.id, folderId: coFolder.id, name: `client ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
    check("19 a client company's BANKING folder → 422 (not available yet)", client.status === 422 && client.body?.error === "not_allowed", `status ${client.status}`)
    const { data: study } = await admin.from("store_owners").select("id").eq("study_only", true).limit(1).maybeSingle()
    if (study) {
      const { data: sf } = await admin.from("store_folders").select("id").eq("owner_id", study.id).limit(1).maybeSingle()
      const sr = await slot(t.access_token, { ownerId: study.id, folderId: sf.id, name: `study ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
      check("20 a hidden study copy → 404", sr.status === 404, `status ${sr.status}`)
    }
    const { data: priv } = await admin.from("store_owners").select("id").eq("kind", "private").limit(1).maybeSingle()
    const { data: pf } = await admin.from("store_folders").select("id").eq("owner_id", priv.id).not("parent_id", "is", null).limit(1).maybeSingle()
    if (pf) {
      const pr = await slot(t.access_token, { ownerId: priv.id, folderId: pf.id, name: `private ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
      check("21 someone else's My files → 404", pr.status === 404, `status ${pr.status}`)
    }
    const mismatch = await slot(t.access_token, { ownerId: coOwner.id, folderId, name: `x ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
    check("22 a folder that is not in the named storage → 404", mismatch.status === 404, `status ${mismatch.status}`)
    check("23 a bad item key → 400", (await slot(t.access_token, { ownerId, folderId, name: "a.txt", size: 5, itemKey: "nope" })).status === 400, "")
    check("24 no token → 401", (await slot("", { ownerId, folderId, name: "a.txt", size: 5, itemKey: randomUUID() })).status === 401, "")

    // 5 — a file that never arrived: refused, and its share of the limit is given back
    const ghostKey = randomUUID()
    const ghost = await slot(t.access_token, { ownerId, folderId, name: `ghost ${stamp}.txt`, size: 3 * 1024 * 1024, mimeType: null, itemKey: ghostKey })
    const gs = await save(t.access_token, { intentId: ghost.body.intentId, itemKey: ghostKey })
    check("25 saving without uploading → 409 not_uploaded", gs.status === 409 && gs.body?.error === "not_uploaded", JSON.stringify(gs.body))

    // 6 — another Mac cannot finish my upload
    const code2 = await A.createAuthCode({ userId: user.id, deviceName: "QA save Mac B", codeChallenge: challenge, redirectUri: REDIRECT })
    const tB = await A.exchangeCode({ code: code2, codeVerifier: verifier, redirectUri: REDIRECT })
    const kA = randomUUID()
    const sA = await slot(t.access_token, { ownerId, folderId, name: `mine ${stamp}.txt`, size: 4, mimeType: null, itemKey: kA })
    await put(sA.body.uploadUrl, Buffer.from("mine"))
    const stolen = await save(tB.access_token, { intentId: sA.body.intentId, itemKey: kA })
    check("26 another Mac cannot save with my slot → 404", stolen.status === 404, `status ${stolen.status}`)
    const mine = await save(t.access_token, { intentId: sA.body.intentId, itemKey: kA })
    check("27 my own Mac can", mine.status === 200, `status ${mine.status}`)
    if (mine.body?.fileId) savedIds.push(mine.body.fileId)

    // 7 — the upload limit: 3 MB per Mac per hour; each small file counts 1 MB; ONE audit row for the refusals
    process.env.STORAGE_APP_WRITE_LIMIT_MB = "3"
    const codeC = await A.createAuthCode({ userId: user.id, deviceName: "QA save Mac C", codeChallenge: challenge, redirectUri: REDIRECT })
    const tC = await A.exchangeCode({ code: codeC, codeVerifier: verifier, redirectUri: REDIRECT })
    const outcomes: number[] = []
    for (let i = 0; i < 5; i++) outcomes.push((await slot(tC.access_token, { ownerId, folderId, name: `limit ${i} ${stamp}.txt`, size: 10, mimeType: null, itemKey: randomUUID() })).status)
    check("28 three slots fit in 3 MB, the next ones are refused 429", outcomes.join(",") === "200,200,200,429,429", outcomes.join(","))
    const { data: hits } = await admin.from("store_events").select("id").eq("event", "app_upload_limit_hit").eq("details->>deviceId", tC.device_id)
    check("29 the refusals wrote ONE audit row", (hits ?? []).length === 1, `rows=${(hits ?? []).length}`)
    process.env.STORAGE_APP_WRITE_LIMIT_MB = priorLimit ?? ""

    // 8 — a revoked Mac
    await A.revokeDevice(t.device_id, "qa save")
    check("30 a revoked Mac cannot ask for a slot", (await slot(t.access_token, { ownerId, folderId, name: "b.txt", size: 5, itemKey: randomUUID() })).status === 401, "")
  } finally {
    if (priorLimit === undefined) delete process.env.STORAGE_APP_WRITE_LIMIT_MB; else process.env.STORAGE_APP_WRITE_LIMIT_MB = priorLimit
    for (const id of savedIds) await trashFile(ACTOR, id, "qa save").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
