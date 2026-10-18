/* eslint-disable no-console */
/**
 * Storage Mac app, phase P3 step B (dev job 1992a087): PROOF, as a real portal CLIENT over HTTP, that a file saved from a Mac into a client folder is
 * invisible and unopenable. SANDBOX only; needs the dev server (PORT=3050 npm run dev) running against the sandbox.
 * Run: npx tsx scripts/crm-store/qa-cutover/t39-portal-client-cannot-see-mac-save.ts
 * A temporary sandbox login with role "client" linked to the Uxio Test LLC contact signs in through the real Supabase auth, then calls the real portal
 * routes with its session cookie: the download route and the search route. A CONTROL (a typed, visible document of the same company) proves the same
 * session CAN open a legitimate document, so the 404 for the Mac-saved file is the guard and not a broken login.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const BASE = process.env.BASE ?? "http://localhost:3050"
const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const UX_CONTACT = "138fc564-9a79-42cf-9b53-efba91af2058"
const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { trashFile } = await import("../../../lib/crm-store/folders")
  const { storePointer } = await import("../../../lib/crm-store/document-pointer")
  const slotRoute = (await import("../../../app/api/storage-app/upload-slot/route")).POST
  const saveRoute = (await import("../../../app/api/storage-app/save/route")).POST
  const stamp = Date.now()

  // a Mac login (team) and a CLIENT login
  const mk = async (email: string, meta: Record<string, unknown>, password: string) => {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: meta })
    if (error || !data?.user) throw new Error(`could not create ${email}: ${error?.message}`)
    return data.user as { id: string; email: string }
  }
  const clientPassword = randomBytes(18).toString("base64url")
  const mac = await mk(`qa-sa-t39mac-${stamp}@sandbox.td`, { role: "team", mfa_exempt: true }, randomBytes(18).toString("base64url"))
  const client = await mk(`qa-sa-t39client-${stamp}@sandbox.td`, { role: "client", contact_id: UX_CONTACT, mfa_exempt: true }, clientPassword)
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), mac.email], updated_at: new Date().toISOString() })   // ADD to the list (see t38)
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const saved: string[] = []

  const call = async (route: (r: NextRequest) => Promise<Response>, token: string, path: string, body: unknown) => {
    const r = await route(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  try {
    // the client signs in for real and we keep the session cookies the portal reads
    const jar: Record<string, string> = {}
    const sb = createServerClient(url, anon, { cookies: { getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })), setAll: (l: { name: string; value: string }[]) => l.forEach((c) => { jar[c.name] = c.value }) } })
    const { error: signErr } = await sb.auth.signInWithPassword({ email: client.email, password: clientPassword })
    if (signErr) throw new Error(`client sign-in failed: ${signErr.message}`)
    // the portal shows the company named in the portal_account_id cookie (a client may have several): Uxio Test LLC
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") + `; portal_account_id=${UX_ACCOUNT}`
    const asClient = (path: string) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" })

    // CONTROL: a typed, client-visible document of the same company opens for this client
    const { data: ctl } = await admin.from("documents").select("id, file_name, account_id").eq("account_id", UX_ACCOUNT).like("file_name", "QA Test Articles%").eq("portal_visible", true).like("drive_file_id", "store:%").limit(1).maybeSingle()
    if (!ctl) throw new Error("no control document found in the sandbox")
    {
      const r = await asClient(`/api/portal/documents/${ctl.id}`)
      check("1 CONTROL: this client session CAN open a legitimate visible store document", r.status === 200 || r.status === 302 || (r.status !== 401 && r.status !== 403 && r.status !== 404), `status ${r.status} (${ctl.file_name})`)
    }
    const unauth = await fetch(BASE + `/api/portal/documents/${randomUUID()}`, { redirect: "manual" })
    check("2 CONTROL: with no session the route answers 401", unauth.status === 401, `status ${unauth.status}`)

    // the Mac saves a file into the company's Correspondence folder
    const code = await A.createAuthCode({ userId: mac.id, deviceName: "QA t39 Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: co } = await admin.from("store_owners").select("id").eq("account_id", ctl.account_id).eq("kind", "company").single()
    const { data: corr } = await admin.from("store_folders").select("id").eq("owner_id", co.id).eq("kind", "correspondence").is("trashed_at", null).limit(1).single()
    const tag = randomBytes(6).toString("hex")      // a word that appears nowhere else (the temporary logins' e-mails contain the timestamp)
    const name = `QA t39 mac saved ${tag}.txt`, bytes = Buffer.from(`t39 ${stamp}`), key = randomUUID()
    const s = await call(slotRoute as never, t.access_token, "/api/storage-app/upload-slot", { ownerId: co.id, folderId: corr.id, name, size: bytes.length, mimeType: "text/plain", itemKey: key })
    await fetch(s.body.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" }, body: bytes })
    const sv = await call(saveRoute as never, t.access_token, "/api/storage-app/save", { intentId: s.body.intentId, itemKey: key })
    const fileId = sv.body?.fileId as string
    if (fileId) saved.push(fileId)
    const { data: doc } = await admin.from("documents").select("id, portal_visible").eq("drive_file_id", storePointer(fileId)).single()
    check("3 the Mac save worked and has a hidden documents row", sv.status === 200 && doc?.portal_visible === false, JSON.stringify({ status: sv.status, vis: doc?.portal_visible }))

    // AS THE CLIENT: the download route says "not found" (404), not "access denied" and not the bytes
    const dl = await asClient(`/api/portal/documents/${doc.id}`)
    check("4 CLIENT: opening the Mac-saved file by its id → 404 (the portal guard), no bytes", dl.status === 404, `status ${dl.status}`)
    // and when someone (wrongly) flips the row's visible flag to TRUE, the portal STILL refuses it
    await admin.from("documents").update({ portal_visible: true }).eq("id", doc.id)
    const dl2 = await asClient(`/api/portal/documents/${doc.id}`)
    await admin.from("documents").update({ portal_visible: false }).eq("id", doc.id)
    check("5 CLIENT: even with the row's visible flag forced TRUE the file is still refused (untyped files are closed)", dl2.status === 404, `status ${dl2.status}`)
    // the portal search does not find it
    const se = await asClient(`/api/portal/search?account_id=${UX_ACCOUNT}&q=${encodeURIComponent(`QA t39 mac saved ${tag}`)}`)
    const seText = await se.text()
    check("6 CLIENT: the portal search does not list it", !seText.includes(tag), `status ${se.status}`)
    const seCtl = await (await asClient(`/api/portal/search?account_id=${UX_ACCOUNT}&q=${encodeURIComponent("QA Test Articles")}`)).text()
    check("6b CONTROL: the same search DOES find the legitimate visible document", seCtl.includes("QA Test Articles"), `${seCtl.length} bytes`)
    const lst = await asClient(`/portal/documents`)
    const lstText = await lst.text()
    check("7 CLIENT: the portal Documents page does not mention it", !lstText.includes(tag), `status ${lst.status}`)
    // CONTROL for 7: the same page DOES list a legitimate visible document, so its silence about ours means something
    check("8 CONTROL: the portal Documents page does list the legitimate visible document", lstText.includes("QA Test Articles"), String(ctl.file_name))
  } finally {
    for (const id of saved) await trashFile(ACTOR, id, "qa t39").catch(() => null)
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", mac.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", mac.id)
    await admin.auth.admin.deleteUser(mac.id).catch(() => null)
    await admin.auth.admin.deleteUser(client.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
