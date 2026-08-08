/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Staff MFA live QA (dev job de4564ee) — full scripted E2E against a REAL
 * deployment (the sandbox) + the SANDBOX auth server. TOTP codes are
 * computed with otplib from the enrollment secret — no human needed.
 *
 * Run (after deploying the branch to the sandbox):
 *   QA_BASE_URL=https://td-operations-sandbox.vercel.app \
 *     npx tsx --env-file=.env.local scripts/qa/mfa-live-qa.ts
 *
 * Creates TEMP auth users (team + admin), enrolls them, probes the gate,
 * and deletes everything at the end. REFUSES to run against production.
 */
import { createClient as createSb } from "@supabase/supabase-js"
import { generateSync } from "otplib"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3210"
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const REF = new URL(SB_URL).hostname.split(".")[0]
if (REF === "ydzipybqeebtpcvsbtvs") {
  throw new Error("REFUSING to run MFA QA against PRODUCTION")
}

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name} ${detail}`) }
  else { fail++; console.log(`  ❌ FAIL ${name} ${detail}`) }
}

/** @supabase/ssr cookie encoding: "base64-" + base64url(JSON session), chunked at 3180. */
function sessionCookies(session: unknown): string {
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
  const name = `sb-${REF}-auth-token`
  if (raw.length <= 3180) return `${name}=${raw}`
  const parts: string[] = []
  for (let i = 0; i * 3180 < raw.length; i++) parts.push(`${name}.${i}=${raw.slice(i * 3180, (i + 1) * 3180)}`)
  return parts.join("; ")
}

type Sb = ReturnType<typeof createSb>

async function enrollAndVerify(anon: Sb): Promise<{ secret: string; factorId: string }> {
  const { data: enrolled, error: eErr } = await anon.auth.mfa.enroll({
    factorType: "totp", issuer: "TD Operations", friendlyName: `qa-${Date.now()}`,
  })
  if (eErr || !enrolled) throw new Error(`enroll: ${eErr?.message}`)
  const secret = (enrolled as { totp?: { secret?: string } }).totp?.secret
  if (!secret) throw new Error("enroll returned no secret")
  const { data: challenge, error: cErr } = await anon.auth.mfa.challenge({ factorId: enrolled.id })
  if (cErr || !challenge) throw new Error(`challenge: ${cErr?.message}`)
  const { error: vErr } = await anon.auth.mfa.verify({
    factorId: enrolled.id, challengeId: challenge.id, code: generateSync({ secret }),
  })
  if (vErr) throw new Error(`verify: ${vErr.message}`)
  return { secret, factorId: enrolled.id }
}

async function aalOf(anon: Sb): Promise<string | null> {
  const { data } = await anon.auth.mfa.getAuthenticatorAssuranceLevel()
  return data?.currentLevel ?? null
}

async function main() {
  console.log(`\n== STAFF MFA LIVE QA (server ${BASE}, DB ${REF}) ==`)
  const stamp = Date.now()
  const teamEmail = `qa-mfa-team-${stamp}@tonydurante.us`
  const adminEmail = `qa-mfa-admin-${stamp}@tonydurante.us`
  const password = `QAmfa!${Math.random().toString(36).slice(2)}${stamp % 997}`

  const { data: teamUser, error: tErr } = await db.auth.admin.createUser({
    email: teamEmail, password, email_confirm: true, app_metadata: { role: "team" },
  })
  if (tErr) throw new Error(`team user: ${tErr.message}`)
  const teamId = teamUser.user.id as string
  const { data: adminUser, error: aErr } = await db.auth.admin.createUser({
    email: adminEmail, password, email_confirm: true, app_metadata: { role: "admin" },
  })
  if (aErr) throw new Error(`admin user: ${aErr.message}`)
  const adminId = adminUser.user.id as string

  const cleanup = async () => {
    await db.from("mfa_backup_codes").delete().in("user_id", [teamId, adminId])
    await db.auth.admin.deleteUser(teamId).catch(() => {})
    await db.auth.admin.deleteUser(adminId).catch(() => {})
  }

  try {
    // ── 1. aal1 enrolled-user gate ──────────────────────────────────
    const anon = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } }) as Sb
    const { data: s1, error: s1e } = await anon.auth.signInWithPassword({ email: teamEmail, password })
    if (s1e || !s1.session) throw new Error(`sign-in: ${s1e?.message}`)
    ok("fresh sign-in is aal1", (await aalOf(anon)) === "aal1")

    await enrollAndVerify(anon)
    ok("challenge+verify upgrades session to aal2", (await aalOf(anon)) === "aal2")

    // Live-check: does token refresh PRESERVE aal2? (SDK docs silent)
    const { data: refreshed, error: rErr } = await anon.auth.refreshSession()
    ok("token refresh preserves aal2", !rErr && (await aalOf(anon)) === "aal2")

    // aal2 cookies pass the middleware gate → backup-codes route works E2E.
    const aal2Cookie = sessionCookies(refreshed?.session ?? s1.session)
    const codesRes = await fetch(`${BASE}/api/mfa/backup-codes`, {
      method: "POST", headers: { Cookie: aal2Cookie }, redirect: "manual",
    })
    const codesBody = await codesRes.json().catch(() => ({}))
    ok("aal2 session passes gate → backup codes generated", codesRes.status === 200 && Array.isArray(codesBody.codes) && codesBody.codes.length === 10, `status=${codesRes.status}`)
    const savedCode = codesBody.codes?.[0] as string

    // Remember-device mint at aal2.
    const remRes = await fetch(`${BASE}/api/mfa/remember`, {
      method: "POST", headers: { Cookie: aal2Cookie }, redirect: "manual",
    })
    const rdCookie = remRes.headers.get("set-cookie")?.match(/td_mfa_rd=([^;]+)/)?.[1]
    ok("remember-device cookie minted at aal2", remRes.status === 200 && !!rdCookie)

    // ── 2. NEW session (aal1, factor exists): the gate must bite ────
    const anon2 = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } }) as Sb
    const { data: s2 } = await anon2.auth.signInWithPassword({ email: teamEmail, password })
    if (!s2.session) throw new Error("second sign-in failed")
    const aal1Cookie = sessionCookies(s2.session)

    const apiBlocked = await fetch(`${BASE}/api/mfa/backup-codes`, {
      method: "POST", headers: { Cookie: aal1Cookie }, redirect: "manual",
    })
    const apiBlockedBody = await apiBlocked.json().catch(() => ({}))
    ok("aal1 staff API fetch → 401 MFA_REQUIRED JSON (not redirect HTML)", apiBlocked.status === 401 && apiBlockedBody.code === "MFA_REQUIRED", `status=${apiBlocked.status}`)

    const navBlocked = await fetch(`${BASE}/`, {
      headers: { Cookie: aal1Cookie, "sec-fetch-mode": "navigate", accept: "text/html" }, redirect: "manual",
    })
    ok("aal1 staff navigation → redirect to /mfa/verify", navBlocked.status === 307 && (navBlocked.headers.get("location") || "").includes("/mfa/verify"), `status=${navBlocked.status} loc=${navBlocked.headers.get("location")}`)

    const navRemembered = await fetch(`${BASE}/`, {
      headers: { Cookie: `${aal1Cookie}; td_mfa_rd=${rdCookie}`, "sec-fetch-mode": "navigate", accept: "text/html" }, redirect: "manual",
    })
    ok("aal1 + remember-device cookie → gate passes (no /mfa redirect)", !(navRemembered.headers.get("location") || "").includes("/mfa/"), `status=${navRemembered.status} loc=${navRemembered.headers.get("location") ?? "-"}`)

    // Exempt path stays reachable at aal1.
    const verifyPage = await fetch(`${BASE}/mfa/verify`, {
      headers: { Cookie: aal1Cookie, "sec-fetch-mode": "navigate", accept: "text/html" }, redirect: "manual",
    })
    ok("/mfa/verify reachable at aal1", verifyPage.status === 200, `status=${verifyPage.status}`)

    // ── 3. SECURITY PROBE: second factor at aal1 (Blocker-2 live answer) ──
    let secondFactorAtAal1: string
    try {
      const { data: e2, error: e2err } = await anon2.auth.mfa.enroll({
        factorType: "totp", issuer: "TD Operations", friendlyName: `probe-${Date.now()}`,
      })
      if (e2err || !e2) {
        secondFactorAtAal1 = `ENROLL REFUSED (${e2err?.message})`
      } else {
        const probeSecret = (e2 as { totp?: { secret?: string } }).totp?.secret ?? ""
        const { data: ch2, error: ch2e } = await anon2.auth.mfa.challenge({ factorId: e2.id })
        if (ch2e || !ch2) {
          secondFactorAtAal1 = `CHALLENGE REFUSED (${ch2e?.message})`
        } else {
          const { error: v2e } = await anon2.auth.mfa.verify({
            factorId: e2.id, challengeId: ch2.id, code: generateSync({ secret: probeSecret }),
          })
          if (v2e) {
            secondFactorAtAal1 = `VERIFY REFUSED (${v2e.message})`
          } else {
            secondFactorAtAal1 = `⚠️ PERMITTED — aal now ${await aalOf(anon2)} (residual is REAL)`
            await anon2.auth.mfa.unenroll({ factorId: e2.id }).catch(() => {})
          }
        }
      }
    } catch (err) {
      secondFactorAtAal1 = `THREW (${err instanceof Error ? err.message : String(err)})`
    }
    console.log(`  🔎 GoTrue second-factor-at-aal1 probe: ${secondFactorAtAal1}`)

    // ── 4. Backup code = one-shot recovery ──────────────────────────
    const backupRes = await fetch(`${BASE}/api/mfa/backup-verify`, {
      method: "POST",
      headers: { Cookie: aal1Cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: savedCode }),
      redirect: "manual",
    })
    const backupBody = await backupRes.json().catch(() => ({}))
    ok("backup code accepted at aal1 (exempt path)", backupRes.status === 200 && backupBody.reenroll === true, `status=${backupRes.status}`)

    const { data: postFactors } = await db.auth.admin.mfa.listFactors({ userId: teamId })
    ok("factors deleted after backup use (one-shot)", (postFactors?.factors ?? []).length === 0)
    const { data: remaining } = await db.from("mfa_backup_codes").select("id").eq("user_id", teamId)
    ok("all backup codes purged after use", (remaining ?? []).length === 0)

    const reuse = await fetch(`${BASE}/api/mfa/backup-verify`, {
      method: "POST",
      headers: { Cookie: aal1Cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: savedCode }),
      redirect: "manual",
    })
    ok("used code cannot be replayed", reuse.status === 401 || reuse.status === 403, `status=${reuse.status}`)

    // ── 5. Admin reset path ─────────────────────────────────────────
    const anonAdmin = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } }) as Sb
    const { data: sa } = await anonAdmin.auth.signInWithPassword({ email: adminEmail, password })
    if (!sa.session) throw new Error("admin sign-in failed")
    await enrollAndVerify(anonAdmin)
    const { data: saFresh } = await anonAdmin.auth.refreshSession()
    const adminCookie = sessionCookies(saFresh?.session ?? sa.session)

    // Re-enroll the team user so there is something to reset.
    const anon3 = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } }) as Sb
    const { data: s3 } = await anon3.auth.signInWithPassword({ email: teamEmail, password })
    if (!s3.session) throw new Error("third sign-in failed")
    await enrollAndVerify(anon3)

    const resetRes = await fetch(`${BASE}/api/mfa/admin-reset`, {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: teamId }),
      redirect: "manual",
    })
    const resetBody = await resetRes.json().catch(() => ({}))
    ok("admin reset succeeds (aal2 admin)", resetRes.status === 200 && resetBody.ok === true, `status=${resetRes.status} deleted=${resetBody.factorsDeleted}`)
    const { data: afterReset } = await db.auth.admin.mfa.listFactors({ userId: teamId })
    ok("reset removed the target's factors", (afterReset?.factors ?? []).length === 0)
    const { data: bumped } = await db.auth.admin.getUserById(teamId)
    ok("reset bumped mfa_rd_version", (bumped?.user?.app_metadata?.mfa_rd_version ?? 0) === 1, `version=${bumped?.user?.app_metadata?.mfa_rd_version}`)
  } finally {
    await cleanup()
    console.log("  🧹 temp users + codes cleaned up")
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`)
  if (fail > 0) process.exit(1)
}

main().catch(err => { console.error("FATAL:", err); process.exit(1) })
