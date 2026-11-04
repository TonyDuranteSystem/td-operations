/* eslint-disable no-console */
/**
 * Storage Mac app 0.2.9 (dev job 1992a087, 2026-11-03): a Mac can RENAME, MOVE and TRASH what already exists (Antonio: "I can't rename a folder in TD Storage").
 * SANDBOX only. Real database + storage + the real route handlers (no dev server). Run: npx tsx scripts/crm-store/qa-cutover/t55-storage-app-edit.ts
 * Proves: rename (file, folder), a taken name is refused, move (file, folder) inside Business, a fixed folder is never renamed/moved/trashed, a client's file
 * cannot be changed from the Mac, trash goes to the CRM trash (file, folder with its files) and can be restored, a missing token / bad request is refused.
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
  const { trashFolder, trashList, restoreBatch } = await import("../../../lib/crm-store/folders")
  const folderRoute = (await import("../../../app/api/storage-app/new-folder/route")).POST
  const editRoute = (await import("../../../app/api/storage-app/edit/route")).POST
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-edit-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const madeFolders: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown) => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA edit Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const tok = t.access_token as string
    const edit = (o: Record<string, unknown>) => call(editRoute as never, tok, "/api/storage-app/edit", o)
    const { data: biz } = await admin.from("store_owners").select("id").eq("kind", "business").limit(1).maybeSingle()
    const ownerId = biz.id as string
    const { data: kids } = await admin.from("store_folders").select("id").eq("owner_id", ownerId).eq("kind", "custom").is("trashed_at", null).limit(1)
    const parentId = kids[0].id as string
    const mk = async (name: string, parent: string) => { const r = await call(folderRoute as never, tok, "/api/storage-app/new-folder", { ownerId, parentId: parent, name }); if (r.body?.folderId) madeFolders.push(r.body.folderId); return r.body?.folderId as string }
    const fA = await mk(`QA edit A ${stamp}`, parentId)
    const fB = await mk(`QA edit B ${stamp}`, parentId)
    const bytes = Buffer.from(`edit test ${stamp}`)
    const key = randomUUID()
    const s1 = await call(slotRoute as never, tok, "/api/storage-app/upload-slot", { ownerId, folderId: fA, name: `QA file ${stamp}.txt`, size: bytes.length, mimeType: "text/plain", itemKey: key })
    await fetch(s1.body.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes as unknown as BodyInit })
    const sv = await call(saveRoute as never, tok, "/api/storage-app/save", { intentId: s1.body.intentId, itemKey: key })
    const fileId = sv.body.fileId as string
    check("0 set-up: two folders and a file made from the Mac", !!fA && !!fB && !!fileId)

    const nm = (table: string, id: string) => admin.from(table).select("*").eq("id", id).maybeSingle().then((r: any) => r.data) // eslint-disable-line @typescript-eslint/no-explicit-any
    const r1 = await edit({ kind: "folder", id: fA, action: "rename", name: `QA edit A renamed ${stamp}` })
    check("1 a folder is renamed", r1.status === 200 && (await nm("store_folders", fA)).name === `QA edit A renamed ${stamp}`, JSON.stringify(r1.body))
    const r2 = await edit({ kind: "file", id: fileId, action: "rename", name: `QA file renamed ${stamp}.txt` })
    check("2 a file is renamed", r2.status === 200 && (await nm("store_files", fileId)).name === `QA file renamed ${stamp}.txt`, JSON.stringify(r2.body))
    const r3 = await edit({ kind: "folder", id: fA, action: "rename", name: `QA edit B ${stamp}` })
    check("3 a name already taken is refused in plain words, nothing changes", r3.status === 422 && /already exists/.test(r3.body?.message) && (await nm("store_folders", fA)).name === `QA edit A renamed ${stamp}`, JSON.stringify(r3.body))
    const r4 = await edit({ kind: "file", id: fileId, action: "move", toParentId: fB })
    check("4 a file is moved to another folder", r4.status === 200 && (await nm("store_files", fileId)).folder_id === fB, JSON.stringify(r4.body))
    const r5 = await edit({ kind: "folder", id: fA, action: "move", toParentId: fB })
    check("5 a folder is moved inside another", r5.status === 200 && (await nm("store_folders", fA)).parent_id === fB, JSON.stringify(r5.body))
    const r6 = await edit({ kind: "folder", id: fB, action: "move", toParentId: fA })
    check("6 a folder cannot go inside its own sub-folder", r6.status === 422, JSON.stringify(r6.body))

    const { data: fixed } = await admin.from("store_folders").select("id, name, parent_id").eq("owner_id", ownerId).not("template_slug", "is", null).not("parent_id", "is", null).limit(1)
    if (fixed?.[0]) {
      for (const [label, body] of [["7 a fixed folder cannot be renamed", { action: "rename", name: "x" }], ["8 a fixed folder cannot be moved", { action: "move", toParentId: fB }], ["9 a fixed folder cannot be trashed", { action: "trash" }]] as const) {
        const r = await edit({ kind: "folder", id: fixed[0].id, ...body })
        check(label, r.status === 422, `${r.status} ${JSON.stringify(r.body)}`)
      }
      check("9b the fixed folder is untouched", (await nm("store_folders", fixed[0].id)).name === fixed[0].name && !(await nm("store_folders", fixed[0].id)).trashed_at)
    } else console.log("SKIP 7-9 (Business has no fixed folder in the sandbox — covered by the unit test and by the client-storage refusal in 10)")

    const { data: cf } = await admin.from("store_files").select("id, name, store_owners!inner(kind)").eq("state", "live").in("store_owners.kind", ["company", "person"]).limit(1)
    if (cf?.[0]) {
      const r = await edit({ kind: "file", id: cf[0].id, action: "rename", name: "hacked.pdf" })
      check("10 a client's file cannot be changed from the Mac", r.status === 422 && /CRM/.test(r.body?.message) && (await nm("store_files", cf[0].id)).name === cf[0].name, JSON.stringify(r.body))
    } else console.log("SKIP 10 (no client file in the sandbox)")

    const r11 = await edit({ kind: "file", id: fileId, action: "trash" })
    const gone = await nm("store_files", fileId)
    check("11 a file goes to the CRM trash (not erased)", r11.status === 200 && gone.state === "trashed" && !!gone.trashed_at, JSON.stringify(r11.body))
    const r12 = await edit({ kind: "folder", id: fB, action: "trash" })
    check("12 a folder goes to the trash with everything under it", r12.status === 200 && !!(await nm("store_folders", fB)).trashed_at && !!(await nm("store_folders", fA)).trashed_at, JSON.stringify(r12.body))
    const tl = await trashList(ACTOR, ownerId)
    const batch = tl.find((b) => b.top_name === `QA edit B ${stamp}`)
    check("13 the trashed folder is in the CRM trash list (restorable)", !!batch && batch.folders >= 2, JSON.stringify(batch))
    if (batch) await restoreBatch(ACTOR, batch.batch_id).catch((e) => console.log("restore:", e.message))
    check("14 restoring brings the folder back", !(await nm("store_folders", fB)).trashed_at)

    const none = await call(editRoute as never, "", "/api/storage-app/edit", { kind: "file", id: fileId, action: "trash" })
    check("15 no token = 401", none.status === 401)
    const bad = await edit({ kind: "file", id: "nope", action: "rename", name: "x" })
    check("16 a bad request = 400", bad.status === 400)
    const { data: ev } = await admin.from("store_events").select("event").eq("actor", user.id).in("event", ["app_item_rename", "app_item_move", "app_item_trash", "app_edit_refused"])
    check("17 every change and refusal is on record", (ev ?? []).length >= 8, `${(ev ?? []).length} rows`)
  } finally {
    for (const id of madeFolders.reverse()) await trashFolder(ACTOR, id, "qa edit").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
