/* eslint-disable no-console */
/**
 * Storage Mac app 0.2.8 (dev job 1992a087, 2026-11-03): a Mac can make a NEW FOLDER (a folder of Zoom recordings pasted into Finder never reached the
 * CRM because the app refused every folder). SANDBOX only. Real database + the real route handlers (no dev server needed).
 * Run: npx tsx scripts/crm-store/qa-cutover/t54-storage-app-new-folder.ts
 * Proves: a folder is made inside a Business folder (audit rows, nobody else's); the SAME folder again (also with other case / extra spaces) is REUSED —
 * one row, same id; a folder inside the new folder works; a file can then be saved INTO the new folder; a slash / junk name, a missing request, an
 * unknown folder, a storage's top folder and a missing token are refused with nothing written.
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
  const { trashFolder } = await import("../../../lib/crm-store/folders")
  const folderRoute = (await import("../../../app/api/storage-app/new-folder/route")).POST
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-folder-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD, never replace
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const madeFolders: string[] = []
  const savedFiles: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown) => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const newFolder = (token: string, o: Record<string, unknown>) => call(folderRoute as never, token, "/api/storage-app/new-folder", o)
  const count = async (parent: string, name: string) => (await admin.from("store_folders").select("id", { count: "exact", head: true }).eq("parent_id", parent).eq("name", name).is("trashed_at", null)).count as number

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA folder Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const { data: rootF } = await admin.from("store_folders").select("id").eq("owner_id", biz.id).is("parent_id", null).maybeSingle()
    const { data: kids } = await admin.from("store_folders").select("id").eq("owner_id", biz.id).eq("kind", "custom").is("trashed_at", null).limit(1)
    const ownerId = biz.id as string
    const parentId = kids[0].id as string
    const name = `QA Zoom Calls ${stamp}`

    const r1 = await newFolder(t.access_token, { ownerId, parentId, name })
    check("1 a new folder is made inside a Business folder", r1.status === 200 && r1.body?.created === true && typeof r1.body?.folderId === "string", `${r1.status} ${JSON.stringify(r1.body)}`)
    const fid = r1.body.folderId as string
    madeFolders.push(fid)
    const { data: row } = await admin.from("store_folders").select("owner_id, parent_id, kind, name, created_by").eq("id", fid).maybeSingle()
    check("2 the row is in the right storage and folder, a normal custom folder, made by this login", row?.owner_id === ownerId && row?.parent_id === parentId && row?.kind === "custom" && row?.name === name && row?.created_by === user.id, JSON.stringify(row))
    const { data: ev } = await admin.from("store_events").select("event, actor").eq("folder_id", fid).in("event", ["folder_created", "app_folder_created"])
    check("3 both audit rows are written (the CRM's folder_created and the Mac's app_folder_created)", (ev ?? []).some((e: { event: string }) => e.event === "folder_created") && (ev ?? []).some((e: { event: string }) => e.event === "app_folder_created"), JSON.stringify(ev))

    const r2 = await newFolder(t.access_token, { ownerId, parentId, name })
    check("4 the SAME folder again is reused: same id, created:false", r2.status === 200 && r2.body?.folderId === fid && r2.body?.created === false, JSON.stringify(r2.body))
    const r3 = await newFolder(t.access_token, { ownerId, parentId, name: `  ${name.toUpperCase()}  ` })
    check("5 other case and extra spaces reuse it too", r3.status === 200 && r3.body?.folderId === fid, JSON.stringify(r3.body))
    check("6 there is exactly ONE folder of that name (no copies)", (await count(parentId, name)) === 1)
    const { data: ev2 } = await admin.from("store_events").select("id").eq("folder_id", fid).eq("event", "app_folder_created")
    check("7 a repeat writes no second 'created' row", (ev2 ?? []).length === 1)

    const r4 = await newFolder(t.access_token, { ownerId, parentId: fid, name: "2026-06-05 09.30.34 Andrea and Antonio" })
    check("8 a folder inside the new folder works", r4.status === 200 && r4.body?.created === true, JSON.stringify(r4.body))
    madeFolders.push(r4.body.folderId)

    const bytes = Buffer.from(`zoom note ${stamp}`)
    const itemKey = randomUUID()
    const s1 = await call(slotRoute as never, t.access_token, "/api/storage-app/upload-slot", { ownerId, folderId: r4.body.folderId, name: `QA recording ${stamp}.txt`, size: bytes.length, mimeType: "text/plain", itemKey })
    const up = s1.body?.uploadUrl ? (await fetch(s1.body.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes as unknown as BodyInit })).status : 0
    const sv = await call(saveRoute as never, t.access_token, "/api/storage-app/save", { intentId: s1.body?.intentId, itemKey })
    if (sv.body?.fileId) savedFiles.push(sv.body.fileId)
    check("9 a file can be saved INTO the folder made from the Mac", s1.status === 200 && up === 200 && sv.status === 200 && !!sv.body?.fileId, `${s1.status}/${up}/${sv.status} ${JSON.stringify(sv.body)}`.slice(0, 200))
    const { data: file } = await admin.from("store_files").select("folder_id, published").eq("id", sv.body?.fileId ?? randomUUID()).maybeSingle()
    check("10 the file really is in that folder", file?.folder_id === r4.body.folderId)

    const before = (await admin.from("store_folders").select("id", { count: "exact", head: true })).count as number
    const bad = [
      ["11 a slash in the name is refused (400)", { ownerId, parentId, name: "a/b" }, 400],
      ["12 a system junk folder name is refused (422)", { ownerId, parentId, name: ".DS_Store" }, 422],
      ["13 a missing name is refused (400)", { ownerId, parentId }, 400],
      ["14 an unknown folder is refused (404)", { ownerId, parentId: randomUUID(), name: "x" }, 404],
      ["15 a storage's top folder is refused (422)", { ownerId, parentId: rootF.id, name: "x" }, 422],
    ] as const
    for (const [label, body, want] of bad) {
      const r = await newFolder(t.access_token, body as Record<string, unknown>)
      check(label, r.status === want, `${r.status} ${JSON.stringify(r.body)}`)
    }
    check("16 the refusals wrote nothing", (await admin.from("store_folders").select("id", { count: "exact", head: true })).count === before)
    const none = await newFolder("", { ownerId, parentId, name: "x" })
    check("17 no token = 401", none.status === 401)
  } finally {
    for (const id of savedFiles) await admin.from("store_files").update({ state: "trashed", trashed_at: new Date().toISOString() }).eq("id", id).then(() => null, () => null)
    for (const id of madeFolders.reverse()) await trashFolder(ACTOR, id, "qa new folder").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
