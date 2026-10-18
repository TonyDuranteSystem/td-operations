/* eslint-disable no-console */
/**
 * Storage Mac app, phase P0 gate (dev job 1992a087): the REAL web path, through the gatekeeper (middleware.ts). SANDBOX only.
 * Needs the dev server running against the sandbox:  PORT=3050 npm run dev   (BASE can be overridden)
 * Run: npx tsx scripts/crm-store/qa-cutover/t34-storage-app-http.ts
 * Proves: the five exact routes work with a token and no cookie; nothing near them is public; the token opens nothing else; the sign-in
 * is the whole loop (code → tokens → list → renew → revoke) over HTTP exactly as the Mac app will do it.
 */
import { config } from "dotenv"
import { randomBytes, createHash } from "crypto"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

const BASE = process.env.BASE ?? "http://localhost:3050"
const REDIRECT = "http://127.0.0.1:53682/cb"
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox")
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const admin = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const A = await import("../../../lib/storage-app/device-auth")
  const stamp = Date.now()
  const { data, error } = await admin.auth.admin.createUser({ email: `qa-sa-http-${stamp}@sandbox.td`, password: randomBytes(18).toString("base64url"), email_confirm: true, app_metadata: { role: "team", mfa_exempt: true } })
  if (error || !data?.user) throw new Error(`could not create the test login: ${error?.message}`)
  const user = data.user as { id: string; email: string }
  const { data: priorList } = await admin.from("app_settings").select("value").eq("key", "storage_app_allowed_emails").maybeSingle()
  await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: [...(Array.isArray(priorList?.value) ? priorList.value : []), user.email], updated_at: new Date().toISOString() })   // ADD to the list: replacing it would lock the real Macs out for the length of the test

  const http = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(BASE + path, { redirect: "manual", ...init })
    const text = await res.text()
    let body: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
    try { body = JSON.parse(text) } catch { /* html or empty */ }
    return { status: res.status, body, location: res.headers.get("location") }
  }
  const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } })
  const postJson = (path: string, body: unknown) => http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  try {
    const code = await A.createAuthCode({ userId: user.id, deviceName: "QA HTTP Mac", codeChallenge: challenge, redirectUri: REDIRECT })
    const t = await postJson("/api/storage-app/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT })
    check("1 token swap works over the web with no cookie", t.status === 200 && t.body?.access_token?.startsWith("sa_at_"), `status ${t.status} ${t.location ?? ""}`)
    const tokens = t.body

    const who = await http("/api/storage-app/whoami", bearer(tokens.access_token))
    check("2 whoami with the token and no cookie → 200", who.status === 200 && who.body?.userId === user.id, `status ${who.status} ${who.location ?? ""}`)
    const nav = await http("/api/storage-app/navigation", bearer(tokens.access_token))
    check("3 navigation → 200 with groups", nav.status === 200 && Array.isArray(nav.body?.groups) && nav.body.groups.length > 0, `status ${nav.status}`)
    const owner = nav.body?.groups?.flatMap((g: { owners: { id: string }[] }) => g.owners)?.[0]?.id
    const fol = await http(`/api/storage-app/folder?owner=${owner}`, bearer(tokens.access_token))
    check("4 folder → 200", fol.status === 200 && Array.isArray(fol.body?.folders), `status ${fol.status}`)
    const head = await http("/api/storage-app/changes?head=1", bearer(tokens.access_token))
    check("5 changes?head=1 → 200", head.status === 200 && "cursor" in (head.body ?? {}), `status ${head.status}`)
    const someFile = fol.body?.files?.[0]?.id
    const aFolder = fol.body?.folders?.[0]?.id
    const it = await http(`/api/storage-app/item?kind=folder&id=${aFolder}`, bearer(tokens.access_token))
    check("6 item → 200", it.status === 200 && it.body?.id === aFolder, `status ${it.status}`)
    void someFile

    // nothing else is public, and the token opens nothing else
    const unknown = await http("/api/storage-app/nothing-here", bearer(tokens.access_token))
    check("7 an unlisted path under /api/storage-app is NOT public (the gatekeeper stops it)", unknown.status === 401 || unknown.status === 307 || unknown.status === 302, `status ${unknown.status}`)
    const deeper = await http("/api/storage-app/token/extra", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    check("8 a path that merely STARTS with a public one is not public (exact match only)", deeper.status === 401 || deeper.status === 307 || deeper.status === 302, `status ${deeper.status}`)
    const other = await http("/api/crm-store/browse/navigation", bearer(tokens.access_token))
    check("9 the device token opens NO other CRM route", other.status !== 200, `status ${other.status}`)
    const mcp = await http("/api/mcp", { ...bearer(tokens.access_token), method: "POST" })
    check("10 nor the MCP route", mcp.status !== 200, `status ${mcp.status}`)
    const approveNoCookie = await postJson("/api/store-devices/approve", { device_name: "x", code_challenge: challenge, redirect_uri: REDIRECT })
    check("11 the approval route is NOT public: no cookie → refused", approveNoCookie.status === 401 || approveNoCookie.status === 307 || approveNoCookie.status === 302 || approveNoCookie.status === 403, `status ${approveNoCookie.status}`)
    const noToken = await http("/api/storage-app/whoami")
    check("12 a public route still refuses a request with no token", noToken.status === 401, `status ${noToken.status}`)
    const cookieOnly = await http("/api/storage-app/whoami", { headers: { cookie: "sb-localhost-auth-token=nonsense" } })
    check("13 a cookie is never a substitute for the token", cookieOnly.status === 401, `status ${cookieOnly.status}`)

    // renewal and revocation over the web
    const r = await postJson("/api/storage-app/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    check("14 renewal over the web → a new pair", r.status === 200 && r.body?.access_token !== tokens.access_token, `status ${r.status}`)
    await A.revokeDevice(tokens.device_id, "qa http")
    const after = await http("/api/storage-app/whoami", bearer(r.body.access_token))
    check("15 after the Mac is revoked its newest token stops at once", after.status === 401, `status ${after.status}`)
    const refreshRevoked = await postJson("/api/storage-app/token", { grant_type: "refresh_token", refresh_token: r.body.refresh_token })
    check("16 and it cannot renew", refreshRevoked.status === 403, `status ${refreshRevoked.status}`)
  } finally {
    if (priorList) await admin.from("app_settings").upsert({ key: "storage_app_allowed_emails", value: priorList.value, updated_at: new Date().toISOString() })
    else await admin.from("app_settings").delete().eq("key", "storage_app_allowed_emails")
    await admin.from("storage_app_devices").delete().eq("user_id", user.id)
    await admin.from("storage_app_auth_codes").delete().eq("user_id", user.id)
    await admin.auth.admin.deleteUser(user.id).catch(() => null)
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
