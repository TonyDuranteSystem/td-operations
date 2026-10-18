/* eslint-disable no-console */
/**
 * Storage Mac app, phase P3 step B slice 1 (dev job 1992a087): SAVING into CLIENT folders (a company's and a person's own custom + correspondence
 * folders). SANDBOX only, the Uxio Test LLC company and its person. Real handlers, real database.
 * Run: npx tsx scripts/crm-store/qa-cutover/t38-storage-app-save-client.ts
 * Proves: the file is saved hidden, typeless, "Needs review — Saved from a Mac", with a hidden documents row linked to the company / person; a portal
 * CLIENT cannot see or open it (the portal's own guards, even if the row's flag were true); the mark and row are re-applied on a retry and by the
 * nightly sweep but never put back after staff cleared the mark; the Mac can update it only while it is still untyped and marked; Banking, Tax,
 * Tax year, the company's own papers, ITIN, personal folders, "2. Contacts", the top folder and companies being formed are refused.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { trashFile, trashFolder } = await import("../../../lib/crm-store/folders")
  const { createFolder, clearNeedsReview } = await import("../../../lib/crm-store/structure")
  const { sweepClientSaves } = await import("../../../lib/storage-app/client-records")
  const { storePointer, staffOnlyStorePointers } = await import("../../../lib/crm-store/document-pointer")
  const { dropStoreRowsClientCannotOpen, clientMayOpen } = await import("../../../lib/portal/client-store-docs")
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const folderRoute = (await import("../../../app/api/storage-app/folder/route")).GET
  const itemRoute = (await import("../../../app/api/storage-app/item/route")).GET
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-cli-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD to the list: replacing it would lock the real Macs out for the length of the test
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const made_files: string[] = []
  let personFolderId: string | null = null

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body?: unknown, method = "POST") => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const slot = (t: string, o: Record<string, unknown>) => call(slotRoute as never, t, "/api/storage-app/upload-slot", o)
  const save = (t: string, o: Record<string, unknown>) => call(saveRoute as never, t, "/api/storage-app/save", o)
  const put = async (url: string, bytes: Buffer) => (await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes })).status
  const saveFile = async (t: string, ownerId: string, folderId: string, name: string, bytes: Buffer) => {
    const key = randomUUID()
    const s = await slot(t, { ownerId, folderId, name, size: bytes.length, mimeType: "text/plain", itemKey: key })
    if (s.status !== 200) return { s, sv: s, key, fileId: null as string | null }
    await put(s.body.uploadUrl, bytes)
    const sv = await save(t, { intentId: s.body.intentId, itemKey: key })
    if (sv.body?.fileId) made_files.push(sv.body.fileId)
    return { s, sv, key, fileId: (sv.body?.fileId ?? null) as string | null }
  }
  const docsRow = async (fileId: string) => (await admin.from("documents").select("id, drive_file_id, portal_visible, flow_stage, service_delivery_id, account_id, contact_id, file_name, file_size, document_type_name, category").eq("drive_file_id", storePointer(fileId)).maybeSingle()).data
  const fileRow = async (fileId: string) => (await admin.from("store_files").select("published, document_type, needs_review_at, needs_review_reason, period_year, state, name").eq("id", fileId).single()).data

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA client save Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: co } = await admin.from("store_owners").select("id").eq("account_id", UX_ACCOUNT).eq("kind", "company").single()
    const { data: pe } = await admin.from("store_owners").select("id").eq("contact_id", UX_CONTACT).eq("kind", "person").single()
    const folderOf = async (ownerId: string, kind: string) => (await admin.from("store_folders").select("id").eq("owner_id", ownerId).eq("kind", kind).is("trashed_at", null).limit(1).maybeSingle()).data?.id as string | undefined
    const corr = await folderOf(co.id, "correspondence")
    const { data: pRoot } = await admin.from("store_folders").select("id").eq("owner_id", pe.id).eq("kind", "root").single()
    const pf = await createFolder(pRoot.id, `QA Mac saves ${stamp}`, qa.id)
    personFolderId = pf.id

    // 1 — which folders say canSave
    const itemOf = async (id: string) => (await call(itemRoute as never, t.access_token, `/api/storage-app/item?kind=folder&id=${id}`, undefined, "GET")).body
    check("1 a company's Correspondence folder says canSave:true", (await itemOf(corr!)).canSave === true, "")
    check("2 a person's team-made folder says canSave:true", (await itemOf(pf.id)).canSave === true, "")
    for (const kind of ["banking", "company", "tax", "tax_year", "contacts", "root"]) {
      const fid = await folderOf(co.id, kind)
      check(`3 company ${kind} folder says canSave:false`, fid ? (await itemOf(fid)).canSave === false : true, kind)
    }
    for (const kind of ["itin", "personal", "person_tax", "root"]) {
      const fid = await folderOf(pe.id, kind)
      check(`4 person ${kind} folder says canSave:false`, fid ? (await itemOf(fid)).canSave === false : true, kind)
    }

    // 2 — a save into the company's Correspondence folder
    const body1 = Buffer.from(`client save one ${stamp}`)
    const r1 = await saveFile(t.access_token, co.id, corr!, `QA client save ${stamp}.txt`, body1)
    check("5 the save works (slot → upload → save)", r1.s.status === 200 && r1.sv.status === 200 && !!r1.fileId, JSON.stringify(r1.sv.body))
    const f1 = await fileRow(r1.fileId!)
    check("6 HIDDEN (published false), NO document type", f1.published === false && f1.document_type === null && f1.state === "live", JSON.stringify(f1))
    check("7 marked Needs review: 'Saved from a Mac — choose its type'", !!f1.needs_review_at && String(f1.needs_review_reason).startsWith("Saved from a Mac"), JSON.stringify(f1))
    const d1 = await docsRow(r1.fileId!)
    check("8 a CRM documents row exists: hidden, no workspace stage, linked to the company", !!d1 && d1.portal_visible === false && d1.flow_stage === null && d1.service_delivery_id === null && d1.account_id === UX_ACCOUNT && d1.document_type_name === null, JSON.stringify(d1))
    const { data: ev } = await admin.from("store_events").select("details").eq("event", "app_file_saved").eq("file_id", r1.fileId)
    check("9 the audit row says needsType", ev?.[0]?.details?.needsType === true, JSON.stringify(ev))

    // 3 — PORTAL PROOF: a client cannot see or open it
    const row = { id: d1.id as string, drive_file_id: d1.drive_file_id as string, portal_visible: d1.portal_visible as boolean, service_delivery_id: d1.service_delivery_id as string | null, flow_stage: d1.flow_stage as string | null }
    check("10 PORTAL: the documents list (rule + stored-file checks) drops it", (await dropStoreRowsClientCannotOpen([row])).length === 0, "")
    check("11 PORTAL: even if the row's visible flag were TRUE the stored-file check still drops it (typeless is closed)", (await dropStoreRowsClientCannotOpen([{ ...row, portal_visible: true }])).length === 0, "")
    check("12 PORTAL: the download check refuses it even with the flag true", (await clientMayOpen({ ...row, portal_visible: true })) === false, "")
    check("13 PORTAL: its pointer is in the 'closed to clients' set", (await staffOnlyStorePointers([storePointer(r1.fileId!)])).has(storePointer(r1.fileId!)), "")
    const { data: shown } = await admin.from("documents").select("id").eq("account_id", UX_ACCOUNT).eq("portal_visible", true).eq("drive_file_id", storePointer(r1.fileId!))
    check("14 PORTAL: no visible documents row points at it", (shown ?? []).length === 0, "")

    // 4 — the folder listing shows it to the Mac; same name refused; retry returns the same file
    const lst = await call(folderRoute as never, t.access_token, `/api/storage-app/folder?owner=${co.id}&folder=${corr}`, undefined, "GET")
    check("15 the Mac's folder listing shows the file as its own", lst.body.files.find((f: { id: string }) => f.id === r1.fileId)?.mine === true, "")
    const dup = await slot(t.access_token, { ownerId: co.id, folderId: corr, name: `QA client save ${stamp}.txt`, size: 4, mimeType: null, itemKey: randomUUID() })
    check("16 the same name in the folder → 409 exists", dup.status === 409, `status ${dup.status}`)

    // 5 — crash safety: records lost → a retry re-applies; the nightly sweep re-applies; a staff-cleared mark is NOT put back
    await admin.from("documents").delete().eq("id", d1.id)
    await admin.from("store_files").update({ needs_review_at: null, needs_review_reason: null }).eq("id", r1.fileId)
    const again = await slot(t.access_token, { ownerId: co.id, folderId: corr, name: `QA client save ${stamp}.txt`, size: body1.length, mimeType: null, itemKey: r1.key })
    const d1b = await docsRow(r1.fileId!), f1b = await fileRow(r1.fileId!)
    check("17 RETRY of a save whose mark/row were lost → alreadySaved AND both re-applied", again.status === 200 && again.body?.alreadySaved === true && !!d1b && !!f1b.needs_review_at, JSON.stringify({ d1b: !!d1b, mark: !!f1b.needs_review_at }))
    await admin.from("documents").delete().eq("id", d1b.id)
    await admin.from("store_files").update({ needs_review_at: null, needs_review_reason: null }).eq("id", r1.fileId)
    const sw = await sweepClientSaves()
    const d1c = await docsRow(r1.fileId!), f1c = await fileRow(r1.fileId!)
    check("18 the NIGHTLY SWEEP repairs it too", sw.repaired >= 1 && !!d1c && !!f1c.needs_review_at, JSON.stringify(sw))
    await clearNeedsReview(r1.fileId!, qa.id)
    await call(slotRoute as never, t.access_token, "/api/storage-app/upload-slot", { ownerId: co.id, folderId: corr, name: `QA client save ${stamp}.txt`, size: body1.length, mimeType: null, itemKey: r1.key })
    await sweepClientSaves()
    check("19 a mark staff CLEARED is never put back (row exists)", (await fileRow(r1.fileId!)).needs_review_at === null, "")

    // 6 — update only while untyped and marked
    const r2 = await saveFile(t.access_token, co.id, corr!, `QA client update ${stamp}.txt`, Buffer.from("v1 small"))
    const v2 = Buffer.from("version two, a good deal longer than the first one")
    const k2 = randomUUID()
    const u = await slot(t.access_token, { replaceFileId: r2.fileId, size: v2.length, mimeType: "text/plain", itemKey: k2 })
    await put(u.body.uploadUrl, v2)
    const us = await save(t.access_token, { intentId: u.body.intentId, itemKey: k2, replaceFileId: r2.fileId })
    const d2 = await docsRow(r2.fileId!)
    check("20 the Mac updated its own still-untyped client file (version 2)", us.status === 200 && us.body?.outcome === "versioned", JSON.stringify(us.body))
    check("21 the documents row followed the new size", Number(d2?.file_size) === v2.length, JSON.stringify(d2))
    await clearNeedsReview(r2.fileId!, qa.id)
    const blocked = await slot(t.access_token, { replaceFileId: r2.fileId, size: 5, mimeType: null, itemKey: randomUUID() })
    check("22 after staff cleared the mark, a Mac update is REFUSED", blocked.status === 422 && blocked.body?.error === "not_own", JSON.stringify(blocked.body))
    // a file staff TYPED (hidden but typed) is also closed to Mac updates
    const r3 = await saveFile(t.access_token, co.id, corr!, `QA client typed ${stamp}.txt`, Buffer.from("will be typed"))
    await admin.from("store_files").update({ document_type: "correspondence" }).eq("id", r3.fileId)
    const typed = await slot(t.access_token, { replaceFileId: r3.fileId, size: 5, mimeType: null, itemKey: randomUUID() })
    check("23 a file staff TYPED (still hidden) is also refused for a Mac update", typed.status === 422, `status ${typed.status}`)

    // 7 — person storage
    const r4 = await saveFile(t.access_token, pe.id, pf.id, `QA person save ${stamp}.txt`, Buffer.from("person file"))
    const d4 = r4.fileId ? await docsRow(r4.fileId) : null
    const f4 = r4.fileId ? await fileRow(r4.fileId) : null
    check("24 a save into the person's own folder works: hidden, untyped, marked, row linked to the contact", !!f4 && f4.published === false && f4.document_type === null && !!f4.needs_review_at && !!d4 && d4.contact_id === UX_CONTACT && d4.portal_visible === false, JSON.stringify({ f4, d4 }))
    if (d4) check("25 PORTAL: the person's file is closed to the client too", (await dropStoreRowsClientCannotOpen([{ id: d4.id, drive_file_id: d4.drive_file_id, portal_visible: true, service_delivery_id: null, flow_stage: null }])).length === 0, "")

    // 8 — name that looks like an ID: saved (no refusal), with the nudge in the reason
    const r5 = await saveFile(t.access_token, co.id, corr!, `Passport scan ${stamp}.txt`, Buffer.from("passport-looking name"))
    const f5 = r5.fileId ? await fileRow(r5.fileId) : null
    check("26 an ID-looking name is SAVED (not refused) with a nudge in the Needs-review reason", !!f5 && String(f5.needs_review_reason).includes("looks like an ID"), JSON.stringify(f5))

    // 9 — refused places
    for (const kind of ["banking", "company", "tax", "tax_year", "contacts", "root"]) {
      const fid = await folderOf(co.id, kind)
      if (!fid) continue
      const r = await slot(t.access_token, { ownerId: co.id, folderId: fid, name: `x ${kind} ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
      check(`27 company ${kind} folder → refused`, r.status === 422, `status ${r.status}`)
    }
    for (const kind of ["itin", "personal", "person_tax", "person_tax_year"]) {
      const fid = await folderOf(pe.id, kind)
      if (!fid) continue
      const r = await slot(t.access_token, { ownerId: pe.id, folderId: fid, name: `x ${kind} ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
      check(`28 person ${kind} folder → refused`, r.status === 422, `status ${r.status}`)
    }
    const { data: ff } = await admin.from("store_folders").select("id, owner_id, store_owners!inner(kind)").eq("kind", "banking").eq("store_owners.kind", "formation").is("trashed_at", null).limit(1).maybeSingle()
    if (ff) {
      const r = await slot(t.access_token, { ownerId: ff.owner_id, folderId: ff.id, name: `x formation ${stamp}.txt`, size: 5, mimeType: null, itemKey: randomUUID() })
      check("29 a company still being formed → refused (not in slice 1)", r.status === 422, `status ${r.status}`)
    }
  } finally {
    for (const id of made_files) await trashFile(ACTOR, id, "qa client save").catch(() => null)
    if (personFolderId) await trashFolder(ACTOR, personFolderId, "qa client save").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
