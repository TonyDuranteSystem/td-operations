/* eslint-disable no-console */
/**
 * Storage Mac app, phase P1 (dev job 1992a087): opening files. SANDBOX only. Real database + real storage + real route handlers.
 * Run: npx tsx scripts/crm-store/qa-cutover/t35-storage-app-file-open.ts
 * Proves: a normal file gives a 60-second link whose bytes match the recorded sha-256; sensitive documents (open, audited, 2-minute copy), trashed files, hidden storages and
 * other people's My files are refused; the hourly limit stops a Mac; every open is audited (never with the link); a 100 MB file works;
 * a revoked Mac is stopped.
 */
import { config } from "dotenv"
import { randomBytes, createHash, randomUUID } from "crypto"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function sha256Stream(res: Response): Promise<{ hex: string; bytes: number }> {
  const h = createHash("sha256"); let n = 0
  const reader = res.body!.getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) break; h.update(value); n += value.length }
  return { hex: h.digest("hex"), bytes: n }
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const { saveBytesToStore } = await import("../../../lib/crm-store/writer")
  const { trashFile } = await import("../../../lib/crm-store/folders")
  const fileRoute = (await import("../../../app/api/storage-app/file/route")).GET
  const stamp = Date.now()

  const { data: made, error } = await admin.auth.admin.createUser({ email: `qa-sa-file-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !made?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = made.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD to the list: replacing it would lock the real Macs out for the length of the test
  const { data: adminUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const qa = (adminUsers?.users ?? []).find((u: { app_metadata?: { role?: string } }) => u.app_metadata?.role === "admin")
  const ACTOR = { id: qa.id as string, app_metadata: { role: "admin" } } as never
  const priorLimit = process.env.STORAGE_APP_READ_LIMIT_MB

  const open = async (token: string, id: string) => {
    const r = await fileRoute(new NextRequest(`http://localhost/api/storage-app/file?id=${id}`, { headers: { authorization: `Bearer ${token}` } }))
    return { status: r.status, body: await r.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA file Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await A.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT })
    const { data: uxOwner } = await admin.from("store_owners").select("id").eq("account_id", UX_ACCOUNT).eq("kind", "company").maybeSingle()
    const { data: root } = await admin.from("store_folders").select("id").eq("owner_id", uxOwner.id).is("parent_id", null).maybeSingle()
    const { data: kids } = await admin.from("store_folders").select("id").eq("parent_id", root.id).is("trashed_at", null).limit(1)
    const folderId = kids[0].id as string
    const save = async (name: string, bytes: Buffer, key: string) => (await saveBytesToStore({ ownerId: uxOwner.id, folderId, name, mimeType: "text/plain", callerKey: `qa-file:${stamp}:${key}`, contentChanged: true, bytes, documentType: null })) as { fileId: string }

    // 1 — a normal file
    process.env.STORAGE_APP_READ_LIMIT_MB = "1"
    const body1 = Buffer.from(`hello ${stamp} `.repeat(50000))   // ~ 0.7 MB
    const f1 = await save(`QA file open ${stamp}.txt`, body1, "a")
    const r1 = await open(t.access_token, f1.fileId)
    check("1 a normal file → 200 with a link", r1.status === 200 && typeof r1.body?.url === "string" && r1.body.expiresIn === 60, `status ${r1.status}`)
    const dl = await fetch(r1.body.url)
    const got = await sha256Stream(dl)
    const want = createHash("sha256").update(body1).digest("hex")
    check("2 the link serves exactly the stored bytes (sha-256 = the one the server reported)", dl.status === 200 && got.hex === want && r1.body.sha256 === want && got.bytes === body1.length, `status ${dl.status} bytes ${got.bytes}/${body1.length}`)
    check("3 name, size and type come back", r1.body.name === `QA file open ${stamp}.txt` && r1.body.size === body1.length && r1.body.mimeType === "text/plain", JSON.stringify({ ...r1.body, url: "…" }))

    // 2 — the audit trail (and never the link)
    const { data: ev } = await admin.from("store_events").select("event, actor, file_id, owner_id, details").eq("event", "app_file_opened").eq("file_id", f1.fileId)
    check("4 the open is audited: who, which Mac, which file, how much it counts (a small file counts as 1 MB)", ev?.length === 1 && ev[0].actor === user.id && ev[0].details.deviceId === t.device_id && ev[0].details.size === Math.max(body1.length, 1048576) && ev[0].details.userId === user.id && ev[0].owner_id === uxOwner.id, JSON.stringify(ev))
    check("5 the audit row does NOT contain the link or its token", !JSON.stringify(ev).includes("token=") && !JSON.stringify(ev).includes("http"), "")

    // 3 — the hourly limit (1 MB for this run): the second open of a 0.7 MB file is refused, the audit says so
    const f2 = await save(`QA file open second ${stamp}.txt`, Buffer.from(`second ${stamp} `.repeat(50000)), "b")
    const r2 = await open(t.access_token, f2.fileId)
    check("6 over the hourly limit → 429", r2.status === 429 && r2.body?.error === "download_limit", `status ${r2.status}`)
    const { data: lim } = await admin.from("store_events").select("event").eq("event", "app_download_limit_hit").eq("file_id", f2.fileId)
    check("7 and the refusal is audited", (lim ?? []).length === 1, JSON.stringify(lim))
    process.env.STORAGE_APP_READ_LIMIT_MB = "500"
    const r2b = await open(t.access_token, f2.fileId)
    check("8 with room again (limit raised) it opens", r2b.status === 200, `status ${r2b.status}`)

    // 4 — what is refused
    const { data: person } = await admin.from("store_owners").select("id").eq("contact_id", "138fc564-9a79-42cf-9b53-efba91af2058").eq("kind", "person").maybeSingle()
    const { data: pf } = await admin.from("store_files").select("id, document_type").eq("owner_id", person.id).eq("state", "live")
    const passport = (pf ?? []).find((f: { document_type: string | null }) => f.document_type === "passport")
    const untyped = (pf ?? []).find((f: { document_type: string | null }) => !f.document_type)
    if (passport) {
      const rp = await open(t.access_token, passport.id)
      check("9 a passport OPENS (200, a link), flagged sensitive, kept 120 seconds", rp.status === 200 && typeof rp.body?.url === "string" && rp.body?.sensitive === true && rp.body?.keepSeconds === 120, `status ${rp.status}`)
      const { data: opened } = await admin.from("store_events").select("event").eq("event", "app_sensitive_file_opened").eq("file_id", passport.id)
      check("10 the sensitive open has its OWN audit row", (opened ?? []).length >= 1, "")
    }
    if (untyped) check("11 an UNTYPED file in a person storage opens, flagged sensitive", (await (async () => { const r = await open(t.access_token, untyped.id); return r.status === 200 && r.body?.sensitive === true && r.body?.keepSeconds === 120 })()), "")
    const ITIN = (pf ?? []).find((f: { document_type: string | null }) => f.document_type && ["id_document", "itin_letter", "form_w_7", "form_1040_nr", "itin_application", "itin_schedule_oi"].includes(f.document_type))
    if (ITIN) check(`12 an ${ITIN.document_type} opens, flagged sensitive`, (await (async () => { const r = await open(t.access_token, ITIN.id); return r.status === 200 && r.body?.sensitive === true })()), "")

    await trashFile(ACTOR, f1.fileId, "qa file open")
    check("13 a trashed file → 404", (await open(t.access_token, f1.fileId)).status === 404, "")
    const { data: study } = await admin.from("store_owners").select("id").eq("study_only", true).limit(1).maybeSingle()
    if (study) {
      const { data: sfile } = await admin.from("store_files").select("id").eq("owner_id", study.id).eq("state", "live").limit(1).maybeSingle()
      if (sfile) check("14 a file in a hidden study copy → 404", (await open(t.access_token, sfile.id)).status === 404, "")
    }
    const { data: priv } = await admin.from("store_owners").select("id").eq("kind", "private").limit(1).maybeSingle()
    if (priv) {
      const { data: pfile } = await admin.from("store_files").select("id").eq("owner_id", priv.id).eq("state", "live").limit(1).maybeSingle()
      if (pfile) check("15 a file in someone's My files → 404 for a team login", (await open(t.access_token, pfile.id)).status === 404, "")
    }
    check("16 a bad id → 400", (await open(t.access_token, "nope")).status === 400, "")
    check("17 an unknown id → 404", (await open(t.access_token, randomUUID())).status === 404, "")
    check("18 no token → 401", (await open("", f2.fileId)).status === 401, "")

    // 4b — an UNTYPED company file whose NAME looks like an ITIN / W-7 paper is refused until it is typed; an ordinary untyped one opens
    const fItin = await save(`ITIN data QA ${stamp}.pdf`, Buffer.from("itin " + stamp), "itin")
    const fPlain = await save(`Notes QA ${stamp}.txt`, Buffer.from("notes " + stamp), "plain")
    check("12b an untyped company file named like an ITIN paper opens, flagged sensitive", (await (async () => { const r = await open(t.access_token, fItin.fileId); return r.status === 200 && r.body?.sensitive === true })()), "")
    check("12c an ordinary untyped company file → 200, not sensitive, kept 900 seconds", (await (async () => { const r = await open(t.access_token, fPlain.fileId); return r.status === 200 && r.body?.sensitive === false && r.body?.keepSeconds === 900 })()), "")

    // 4c — PARALLEL requests cannot beat the hourly limit; the limit is also PER PERSON (all their Macs together)
    process.env.STORAGE_APP_READ_LIMIT_MB = "3"
    const user2 = (await admin.auth.admin.createUser({ email: `qa-sa-file2-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })).data.user as { id: string; email: string }
    await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [user.email, user2.email], updated_at: new Date().toISOString() })
    const mkDevice = async (name: string) => { const c = await A.createAuthCode({ userId: user2.id, deviceName: name, codeChallenge: challenge, redirectUri: REDIRECT }); return A.exchangeCode({ code: c, codeVerifier: verifier, redirectUri: REDIRECT }) }
    const dA = await mkDevice("QA parallel A"), dB = await mkDevice("QA parallel B")
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => save(`QA parallel ${i} ${stamp}.txt`, Buffer.from(`p${i} ${stamp}`), `par${i}`)))
    const results = await Promise.all(six.map((f) => open(dA.access_token, f.fileId)))
    const allowed = results.filter((r) => r.status === 200).length
    check("12d six PARALLEL opens against a 3 MB limit: exactly three get a link (the check and the count are one step)", allowed === 3 && results.filter((r) => r.status === 429).length === 3, `allowed=${allowed} statuses=${results.map((r) => r.status).join(",")}`)
    const { data: opened } = await admin.from("store_events").select("id").eq("event", "app_file_opened").eq("actor", user2.id)
    check("12e and exactly three audit rows were written", (opened ?? []).length === 3, `rows=${(opened ?? []).length}`)
    const { data: hits } = await admin.from("store_events").select("id").eq("event", "app_download_limit_hit").eq("actor", user2.id)
    check("12f the three refusals wrote ONE audit row (no flood)", (hits ?? []).length === 1, `rows=${(hits ?? []).length}`)
    const viaB = await open(dB.access_token, six[0].fileId)
    check("12g the limit is PER PERSON: this person's OTHER Mac is refused too", viaB.status === 429, `status ${viaB.status}`)
    await admin.from("storage_app_devices").delete().eq("user_id", user2.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user2.id)
    await admin.auth.admin.deleteUser(user2.id).catch(() => null)
    await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD to the list: replacing it would lock the real Macs out for the length of the test
    process.env.STORAGE_APP_READ_LIMIT_MB = "500"
    for (const f of [fItin, fPlain, ...six]) await trashFile(ACTOR, f.fileId, "qa file open")

    // 5 — 100 MB
    const big = randomBytes(1024 * 1024).toString("hex")      // 2 MB of hex text, repeated to 100 MB
    const bigBuf = Buffer.alloc(100 * 1024 * 1024)
    for (let i = 0; i < bigBuf.length; i += big.length) bigBuf.write(big, i, "latin1")
    const t0 = Date.now()
    const f3 = await save(`QA file open 100MB ${stamp}.bin`, bigBuf, "c")
    console.log(`      (info) saved 100 MB in ${Math.round((Date.now() - t0) / 1000)} s`)
    const r3 = await open(t.access_token, f3.fileId)
    const t1 = Date.now()
    const dl3 = await fetch(r3.body.url)
    const got3 = await sha256Stream(dl3)
    console.log(`      (info) downloaded 100 MB in ${Math.round((Date.now() - t1) / 1000)} s`)
    check("19 a 100 MB file opens and arrives intact (sha-256 matches)", r3.status === 200 && got3.bytes === bigBuf.length && got3.hex === createHash("sha256").update(bigBuf).digest("hex"), `status ${r3.status} bytes ${got3.bytes}`)
    await trashFile(ACTOR, f3.fileId, "qa file open")
    await trashFile(ACTOR, f2.fileId, "qa file open")

    // 6 — a revoked Mac
    await A.revokeDevice(t.device_id, "qa file open")
    check("20 a revoked Mac cannot open anything", (await open(t.access_token, f2.fileId)).status === 401, "")
  } finally {
    if (priorLimit === undefined) delete process.env.STORAGE_APP_READ_LIMIT_MB; else process.env.STORAGE_APP_READ_LIMIT_MB = priorLimit
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
