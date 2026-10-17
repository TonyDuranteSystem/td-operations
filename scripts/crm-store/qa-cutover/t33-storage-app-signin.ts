/* eslint-disable no-console */
/**
 * Storage Mac app, phase P0 gate (dev job 1992a087): sign-in, renewal, revocation and what a team login may see. SANDBOX only.
 * Uses the real database and the real route handlers (called directly — the gatekeeper entry is a separate approval).
 * Run: npx tsx scripts/crm-store/qa-cutover/t33-storage-app-signin.ts
 */
import { config } from "dotenv"
import { randomBytes, createHash } from "crypto"
import { NextRequest } from "next/server"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const UX_ACCOUNT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const stamp = Date.now()

  const mk = async (key: string, app_metadata: Record<string, unknown>, user_metadata: Record<string, unknown> = {}) => {
    const { data, error } = await admin.auth.admin.createUser({ email: `qa-sa-${key}-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata, user_metadata })
    if (error || !data?.user) throw new Error(`could not create ${key}: ${error?.message}`)
    return data.user as { id: string }
  }
  const team = await mk("team", { role: "team", mfa_exempt: true })
  const client = await mk("client", { role: "client", mfa_exempt: true })
  const selfPromoted = await mk("self", {}, { role: "admin" })
  const created = [team.id, client.id, selfPromoted.id]
  // who may use the app is a SETTING (Antonio: Antonio and Luca only); for this run the test logins are on it
  const emailOf = async (id: string) => (await admin.auth.admin.getUserById(id)).data.user.email as string
  const teamEmail = await emailOf(team.id), clientEmail = await emailOf(client.id), selfEmail = await emailOf(selfPromoted.id)
  const setList = (emails: string[] | null) => emails === null
    ? admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    : admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: emails, updated_at: new Date().toISOString() })
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await setList([teamEmail, clientEmail, selfEmail])
  const call = async (path: string, token: string, h: (r: NextRequest) => Promise<Response>, qs = "") => {
    const res = await h(new NextRequest(`http://localhost/api/storage-app/${path}${qs}`, { headers: { authorization: `Bearer ${token}` } }))
    return { status: res.status, body: await res.json().catch(() => null) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const whoami = (await import("../../../app/api/storage-app/whoami/route")).GET
  const nav = (await import("../../../app/api/storage-app/navigation/route")).GET
  const folder = (await import("../../../app/api/storage-app/folder/route")).GET
  const changes = (await import("../../../app/api/storage-app/changes/route")).GET
  const item = (await import("../../../app/api/storage-app/item/route")).GET
  const tokenRoute = (await import("../../../app/api/storage-app/token/route")).POST
  const post = async (body: unknown) => { const r = await tokenRoute(new NextRequest("http://localhost/api/storage-app/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() as any } } // eslint-disable-line @typescript-eslint/no-explicit-any

  try {
    // ── sign-in
    const code = await A.createAuthCode({ userId: team.id, deviceName: "QA MacBook", codeChallenge: challenge, redirectUri: REDIRECT })
    const bad1 = await post({ grant_type: "authorization_code", code, code_verifier: "x".repeat(50), redirect_uri: REDIRECT })
    check("1 wrong PKCE verifier → refused (and the code is burned)", bad1.status === 400 && bad1.body.error === "invalid_grant", JSON.stringify(bad1.body))
    const again = await post({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT })
    check("2 a code that was already tried cannot be used again", again.status === 400, JSON.stringify(again.body))

    const code2 = await A.createAuthCode({ userId: team.id, deviceName: "QA MacBook", codeChallenge: challenge, redirectUri: REDIRECT })
    const wrongRedirect = await post({ grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: "http://127.0.0.1:53683/cb" })
    check("3 different redirect address → refused", wrongRedirect.status === 400, JSON.stringify(wrongRedirect.body))

    const code3 = await A.createAuthCode({ userId: team.id, deviceName: "QA MacBook", codeChallenge: challenge, redirectUri: REDIRECT })
    await admin.from("storage_app_auth_codes").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("user_id", team.id).is("used_at", null)
    const expired = await post({ grant_type: "authorization_code", code: code3, code_verifier: verifier, redirect_uri: REDIRECT })
    check("4 an expired code → refused", expired.status === 400, JSON.stringify(expired.body))

    const code4 = await A.createAuthCode({ userId: team.id, deviceName: "QA MacBook", codeChallenge: challenge, redirectUri: REDIRECT })
    const ok = await post({ grant_type: "authorization_code", code: code4, code_verifier: verifier, redirect_uri: REDIRECT })
    check("5 correct code + verifier → tokens", ok.status === 200 && ok.body.access_token?.startsWith("sa_at_") && ok.body.refresh_token?.startsWith("sa_rt_"), `status ${ok.status}`)
    const t1 = ok.body

    const who = await call("whoami", t1.access_token, whoami)
    check("6 whoami = the team login, not an owner", who.status === 200 && who.body.role === "team" && who.body.owner === false && who.body.userId === team.id, JSON.stringify(who.body))
    const noToken = await call("whoami", "", whoami)
    check("7 no token → 401", noToken.status === 401, `status ${noToken.status}`)
    const asRefresh = await call("whoami", t1.refresh_token, whoami)
    check("8 a refresh token is not accepted as an access token", asRefresh.status === 401, `status ${asRefresh.status}`)
    const junk = await call("whoami", "sa_at_" + "A".repeat(43), whoami)
    check("9 a made-up token → 401", junk.status === 401, `status ${junk.status}`)
    const cookieOnly = await whoami(new NextRequest("http://localhost/api/storage-app/whoami", { headers: { cookie: "sb-access-token=anything" } }))
    check("10 a browser cookie alone is never enough → 401", cookieOnly.status === 401, `status ${cookieOnly.status}`)

    // ── the allow-list (Antonio and Luca only): a role that is fine is still refused when not on it
    await setList([clientEmail, selfEmail])
    let offListRefused = false
    try { await A.createAuthCode({ userId: team.id, deviceName: "x", codeChallenge: challenge, redirectUri: REDIRECT }) } catch (e) { offListRefused = (e as { code?: string }).code === "access_denied" }
    check("10b a staff login that is NOT on the allow-list cannot start a sign-in", offListRefused)
    await setList(null)
    let noRowRefused = false
    try { await A.createAuthCode({ userId: team.id, deviceName: "x", codeChallenge: challenge, redirectUri: REDIRECT }) } catch (e) { noRowRefused = (e as { code?: string }).code === "access_denied" }
    check("10c no allow-list setting at all = nobody (fails closed)", noRowRefused)
    await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: "luca@tonydurante.us", updated_at: new Date().toISOString() })
    let malformedRefused = false
    try { await A.createAuthCode({ userId: team.id, deviceName: "x", codeChallenge: challenge, redirectUri: REDIRECT }) } catch (e) { malformedRefused = (e as { code?: string }).code === "access_denied" }
    check("10d a malformed allow-list setting = nobody", malformedRefused)
    await setList([teamEmail, clientEmail, selfEmail])

    // ── who may even start
    let clientRefused = false, selfRefused = false
    try { await A.createAuthCode({ userId: client.id, deviceName: "x", codeChallenge: challenge, redirectUri: REDIRECT }) } catch (e) { clientRefused = (e as { code?: string }).code === "access_denied" }
    try { await A.createAuthCode({ userId: selfPromoted.id, deviceName: "x", codeChallenge: challenge, redirectUri: REDIRECT }) } catch (e) { selfRefused = (e as { code?: string }).code === "access_denied" }
    check("11 a client login cannot start a device sign-in", clientRefused)
    check("12 a login that only edited its own user_metadata to 'admin' cannot either", selfRefused)

    // ── what a team login sees
    const n = await call("navigation", t1.access_token, nav)
    const groups = (n.body?.groups ?? []) as Array<{ key: string; section: string; owners: Array<{ id: string; kind: string }> }>
    const ownerIds = groups.flatMap((g) => g.owners.map((o) => o.id))
    check("13 navigation lists the clients and Business", n.status === 200 && groups.some((g) => g.section === "clients") && groups.some((g) => g.section === "business"), `${groups.map((g) => g.label ?? g.key).join(",")}`)
    check("14 navigation has NO My files group for a team login", !groups.some((g) => g.section === "private") && !groups.flatMap((g) => g.owners).some((o) => o.kind === "private"))
    const { data: uxOwner } = await admin.from("store_owners").select("id").eq("account_id", UX_ACCOUNT).eq("kind", "company").maybeSingle()
    check("15 the live test company is listed", ownerIds.includes(uxOwner.id))
    const { data: study } = await admin.from("store_owners").select("id").eq("study_only", true).limit(1).maybeSingle()
    if (study) check("16 a hidden study copy is not listed", !ownerIds.includes(study.id))
    const top = await call("folder", t1.access_token, folder, `?owner=${uxOwner.id}`)
    check("17 the test company's top folder opens with its standard folders", top.status === 200 && top.body.folders.length > 0, JSON.stringify(top.body).slice(0, 160))
    const { data: priv } = await admin.from("store_owners").select("id").eq("kind", "private").limit(1).maybeSingle()
    if (priv) {
      const p = await call("folder", t1.access_token, folder, `?owner=${priv.id}`)
      check("18 someone's My files is Not found for a team login", p.status === 404, `status ${p.status}`)
    }
    if (study) {
      const s = await call("folder", t1.access_token, folder, `?owner=${study.id}`)
      check("19 a hidden study copy is Not found", s.status === 404, `status ${s.status}`)
    }
    const badId = await call("folder", t1.access_token, folder, `?owner=not-a-uuid`)
    check("20 a malformed id → 400", badId.status === 400, `status ${badId.status}`)
    const head = await call("changes", t1.access_token, changes, "?head=1")
    check("21 changes?head=1 answers", head.status === 200 && "cursor" in head.body, JSON.stringify(head.body))
    const badCursor = await call("changes", t1.access_token, changes, "?since=nonsense")
    check("22 a malformed cursor → 400", badCursor.status === 400, `status ${badCursor.status}`)

    // ── sensitive documents are flagged not-downloadable (the test company's own PERSON storage, which is live and holds real test files)
    const { data: person } = await admin.from("store_owners").select("id").eq("contact_id", "138fc564-9a79-42cf-9b53-efba91af2058").eq("kind", "person").maybeSingle()
    const { data: pf } = await admin.from("store_files").select("id, name, folder_id, document_type").eq("owner_id", person.id).eq("state", "live")
    const listFolder = async (folderId: string) => (await call("folder", t1.access_token, folder, `?owner=${person.id}&folder=${folderId}`)).body.files as Array<{ id: string; name: string; downloadable: boolean }>
    const passport = (pf ?? []).find((f: { document_type: string | null }) => f.document_type === "passport")
    const typedOk = (pf ?? []).find((f: { document_type: string | null }) => f.document_type && !["passport", "id_document", "itin_letter", "form_w_7", "form_1040_nr", "itin_application", "itin_schedule_oi"].includes(f.document_type))
    const untyped = (pf ?? []).find((f: { document_type: string | null }) => !f.document_type)
    if (passport) { const l = await listFolder(passport.folder_id); check("23 a passport is listed as NOT downloadable", l.find((x) => x.id === passport.id)?.downloadable === false, passport.name) }
    if (typedOk) { const l = await listFolder(typedOk.folder_id); check("24 an ordinary typed file in a person storage IS downloadable", l.find((x) => x.id === typedOk.id)?.downloadable === true, typedOk.name) }
    if (untyped) { const l = await listFolder(untyped.folder_id); check("25 an UNTYPED file in a person storage is NOT downloadable", l.find((x) => x.id === untyped.id)?.downloadable === false, untyped.name) }
    const { data: coFile } = await admin.from("store_files").select("id, name, folder_id").eq("owner_id", uxOwner.id).eq("state", "live").is("document_type", null).limit(1).maybeSingle()
    if (coFile) { const l = await listFolder2(uxOwner.id, coFile.folder_id); check("26 an untyped file in a COMPANY storage IS downloadable", l.find((x) => x.id === coFile.id)?.downloadable === true, coFile.name) }
    async function listFolder2(ownerId: string, folderId: string) { return (await call("folder", t1.access_token, folder, `?owner=${ownerId}&folder=${folderId}`)).body.files as Array<{ id: string; downloadable: boolean }> }

    // ── one item by id, with its parent (what Finder asks)
    if (passport) {
      const it = await call("item", t1.access_token, item, `?kind=file&id=${passport.id}`)
      check("26a item(file): parent folder and the not-downloadable flag", it.status === 200 && it.body.parentId === passport.folder_id && it.body.downloadable === false && it.body.ownerId === person.id, JSON.stringify(it.body))
      const fl = await call("item", t1.access_token, item, `?kind=folder&id=${passport.folder_id}`)
      check("26b item(folder): has a parent (or is the top folder)", fl.status === 200 && fl.body.id === passport.folder_id && "parentId" in fl.body, JSON.stringify(fl.body))
    }
    check("26c item with a bad id → 400", (await call("item", t1.access_token, item, `?kind=file&id=nope`)).status === 400)
    check("26d item with an unknown id → 404", (await call("item", t1.access_token, item, `?kind=file&id=00000000-0000-4000-8000-000000000999`)).status === 404)
    if (priv) {
      const { data: pf2 } = await admin.from("store_folders").select("id").eq("owner_id", priv.id).limit(1).maybeSingle()
      if (pf2) check("26e item inside someone's My files → 404 for a team login", (await call("item", t1.access_token, item, `?kind=folder&id=${pf2.id}`)).status === 404)
    }
    if (study) {
      const { data: sf } = await admin.from("store_folders").select("id").eq("owner_id", study.id).limit(1).maybeSingle()
      if (sf) check("26f item inside a hidden study copy → 404", (await call("item", t1.access_token, item, `?kind=folder&id=${sf.id}`)).status === 404)
    }

    // ── renewal, grace, reuse
    const r1 = await post({ grant_type: "refresh_token", refresh_token: t1.refresh_token })
    check("27 renewal → a new pair", r1.status === 200 && r1.body.refresh_token !== t1.refresh_token, `status ${r1.status}`)
    const t2 = r1.body
    const graceAgain = await post({ grant_type: "refresh_token", refresh_token: t1.refresh_token })
    check("28 the same refresh token used again within 10 s = a lost answer → a new pair, device NOT revoked", graceAgain.status === 200, `status ${graceAgain.status} ${JSON.stringify(graceAgain.body).slice(0, 100)}`)
    await admin.from("storage_app_tokens").update({ used_at: new Date(Date.now() - 60_000).toISOString() }).eq("token_hash", createHash("sha256").update(t1.refresh_token).digest("hex"))
    const replay = await post({ grant_type: "refresh_token", refresh_token: t1.refresh_token })
    check("29 the old refresh token replayed later = theft → refused and the DEVICE is revoked", replay.status === 403 && replay.body.error === "device_revoked", JSON.stringify(replay.body))
    const afterRevoke = await call("whoami", t2.access_token, whoami)
    check("30 after revocation every token of that device stops at once", afterRevoke.status === 401, `status ${afterRevoke.status}`)
    const refreshRevoked = await post({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token })
    check("31 and so does its newest refresh token", refreshRevoked.status === 403, `status ${refreshRevoked.status}`)

    // ── two renewals at the SAME instant (the app + its Finder extension) must not read as theft
    const dev4 = await (async () => {
      const c = await A.createAuthCode({ userId: team.id, deviceName: "QA parallel Mac", codeChallenge: challenge, redirectUri: REDIRECT })
      return (await post({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT })).body
    })()
    const [pa, pb] = await Promise.all([post({ grant_type: "refresh_token", refresh_token: dev4.refresh_token }), post({ grant_type: "refresh_token", refresh_token: dev4.refresh_token })])
    const { data: dev4row } = await admin.from("storage_app_devices").select("revoked_at").eq("id", dev4.device_id).maybeSingle()
    check("32b two simultaneous renewals with the same token: both answered, device NOT signed out", pa.status === 200 && pb.status === 200 && dev4row.revoked_at === null, `${pa.status}/${pb.status} revoked=${dev4row?.revoked_at}`)

    // ── the audit trail
    const { data: ev } = await admin.from("store_events").select("event, actor, details").in("event", ["app_device_signed_in", "app_device_revoked", "app_signin_refused"]).gte("occurred_at", new Date(stamp - 5000).toISOString()).eq("actor", team.id)
    const names = (ev ?? []).map((e: { event: string }) => e.event)
    check("32c audit rows: sign-in and the theft revocation are recorded", names.includes("app_device_signed_in") && names.includes("app_device_revoked"), JSON.stringify(names))
    const { data: evc } = await admin.from("store_events").select("event").eq("event", "app_signin_refused").eq("actor", client.id)
    check("32d audit row: the refused client sign-in is recorded", (evc ?? []).length >= 1, JSON.stringify(evc))

    // ── demotion / suspension are seen on the very next call
    const dev2 = await (async () => {
      const c = await A.createAuthCode({ userId: team.id, deviceName: "QA second Mac", codeChallenge: challenge, redirectUri: REDIRECT })
      return (await post({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT })).body
    })()
    check("32 a second Mac signs in independently", (await call("whoami", dev2.access_token, whoami)).status === 200)
    await setList([clientEmail, selfEmail])
    check("32e taken off the allow-list → the Mac stops on the very next call", (await call("whoami", dev2.access_token, whoami)).status === 401)
    await setList([teamEmail, clientEmail, selfEmail])
    const back = await call("whoami", dev2.access_token, whoami)
    check("32f put back on the list → the same Mac works again (nothing was revoked)", back.status === 200, `status ${back.status} ${JSON.stringify(back.body)}`)
    await admin.auth.admin.updateUserById(team.id, { app_metadata: { role: "client", mfa_exempt: true } })
    check("33 demoted to client → refused on the very next call", (await call("whoami", dev2.access_token, whoami)).status === 401)
    const refreshDemoted = await post({ grant_type: "refresh_token", refresh_token: dev2.refresh_token })
    check("34 and cannot renew (the device is revoked)", refreshDemoted.status === 403, JSON.stringify(refreshDemoted.body))
    await admin.auth.admin.updateUserById(team.id, { app_metadata: { role: "team", mfa_exempt: true } })

    // ── 30-day device cap
    const dev3 = await (async () => {
      const c = await A.createAuthCode({ userId: team.id, deviceName: "QA old Mac", codeChallenge: challenge, redirectUri: REDIRECT })
      return (await post({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT })).body
    })()
    await admin.from("storage_app_devices").update({ created_at: new Date(Date.now() - 31 * 86_400_000).toISOString() }).eq("id", dev3.device_id)
    check("35 a device older than 30 days is refused until approved again", (await call("whoami", dev3.access_token, whoami)).status === 401)
    check("36 and cannot renew", (await post({ grant_type: "refresh_token", refresh_token: dev3.refresh_token })).status === 400)

    // ── the 24-hour lease is enforced on the SERVER too (not only in the app)
    const dev5 = await (async () => {
      const c = await A.createAuthCode({ userId: team.id, deviceName: "QA away Mac", codeChallenge: challenge, redirectUri: REDIRECT })
      return (await post({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT })).body
    })()
    check("37a a fresh Mac works", (await call("whoami", dev5.access_token, whoami)).status === 200)
    await admin.from("storage_app_devices").update({ last_seen_at: new Date(Date.now() - 25 * 3600_000).toISOString() }).eq("id", dev5.device_id)
    check("37b a Mac that has not reached the CRM for 25 hours is refused by the server", (await call("whoami", dev5.access_token, whoami)).status === 401)
    const awayRefresh = await post({ grant_type: "refresh_token", refresh_token: dev5.refresh_token })
    check("37c and cannot renew — it must be approved again", awayRefresh.status === 400 && awayRefresh.body.error === "invalid_grant", JSON.stringify(awayRefresh.body))
    await admin.from("storage_app_devices").update({ last_seen_at: new Date(Date.now() - 23 * 3600_000).toISOString() }).eq("id", dev5.device_id)
    const stillOk = await post({ grant_type: "refresh_token", refresh_token: dev5.refresh_token })
    check("37d at 23 hours it is still inside the lease and renews", stillOk.status === 200, `status ${stillOk.status}`)

    // ── at most 5 Macs signed in per login
    let refusedAt = 0
    for (let i = 1; i <= 8; i++) {
      try {
        const c = await A.createAuthCode({ userId: team.id, deviceName: `QA cap Mac ${i}`, codeChallenge: challenge, redirectUri: REDIRECT })
        await post({ grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT })
      } catch (e) { if ((e as { code?: string }).code === "access_denied") { refusedAt = i; break } else throw e }
    }
    const { count: activeNow } = await admin.from("storage_app_devices").select("id", { count: "exact", head: true }).eq("user_id", team.id).is("revoked_at", null)
    check("37e the sixth active Mac is refused with a plain message (and exactly 5 are active)", refusedAt > 0 && activeNow === 5, `refusedAt=${refusedAt} active=${activeNow}`)

    // ── nothing is stored in clear
    const { data: rows } = await admin.from("storage_app_tokens").select("token_hash").eq("device_id", dev2.device_id)
    check("37 only hashes are stored (no sa_ token in the table)", (rows ?? []).every((r: { token_hash: string }) => /^[0-9a-f]{64}$/.test(r.token_hash)), "")
  } finally {
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    for (const id of created) {
      await admin.from("storage_app_devices").delete().eq("user_id", id)
      await admin.from("storage_app_auth_codes").delete().eq("user_id", id)
      await admin.auth.admin.deleteUser(id).catch(() => null)
    }
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
