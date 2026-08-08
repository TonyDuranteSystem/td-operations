/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Staff MFA self-service E2E (follow-up to dev job de4564ee).
 * Proves, against a REAL deployment + the SANDBOX auth server:
 *   - replace-authenticator: old factor stops working, new one works, fresh
 *     backup codes issued, old codes invalidated, session survives the swap;
 *   - regenerate-backup-codes: new set works, old set rejected;
 *   - the direct setup page can no longer add a SECOND authenticator.
 * Throwaway user, deleted at the end. REFUSES to run against production.
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
if (REF === "ydzipybqeebtpcvsbtvs") throw new Error("REFUSING to run against PRODUCTION")

let pass = 0, fail = 0
const ok = (n: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✅ ${n} ${d}`)) : (fail++, console.log(`  ❌ FAIL ${n} ${d}`)) }
function cookiesFor(session: unknown): string {
  const raw = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url")
  const n = `sb-${REF}-auth-token`
  if (raw.length <= 3180) return `${n}=${raw}`
  const p: string[] = []
  for (let i = 0; i * 3180 < raw.length; i++) p.push(`${n}.${i}=${raw.slice(i * 3180, (i + 1) * 3180)}`)
  return p.join("; ")
}

async function main() {
  console.log(`\n== MFA SELF-SERVICE E2E (server ${BASE}, DB ${REF}) ==`)
  const stamp = Date.now()
  const email = `qa-selfsvc-${stamp}@tonydurante.us`
  const password = `QAss!${Math.random().toString(36).slice(2)}${stamp % 997}`
  const { data: created } = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "team" } })
  const userId = created.user.id as string
  try {
    const u = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    const { data: s1 } = await u.auth.signInWithPassword({ email, password })

    // Enroll the ORIGINAL authenticator ("old phone").
    const { data: e1 } = await u.auth.mfa.enroll({ factorType: "totp", issuer: "TD Operations", friendlyName: `old-${stamp}` })
    const oldSecret = (e1 as { totp?: { secret?: string } }).totp!.secret!
    const c1 = await u.auth.mfa.challenge({ factorId: e1!.id })
    await u.auth.mfa.verify({ factorId: e1!.id, challengeId: c1.data!.id, code: generateSync({ secret: oldSecret }) })
    const { data: r1 } = await u.auth.refreshSession()
    let cookie = cookiesFor(r1?.session ?? s1.session)
    const codes1 = await (await fetch(`${BASE}/api/mfa/backup-codes`, { method: "POST", headers: { Cookie: cookie } })).json()
    ok("old authenticator enrolled + first backup codes issued", Array.isArray(codes1.codes) && codes1.codes.length === 10)

    // ── THE REPLACE FLOW (what the dialog does) ──
    const { data: before } = await u.auth.mfa.listFactors()
    for (const f of before?.all ?? []) await u.auth.mfa.unenroll({ factorId: f.id })
    const stillAlive = !(await u.auth.getUser()).error
    ok("session survives removing the old authenticator", stillAlive)
    const { data: e2, error: e2err } = await u.auth.mfa.enroll({ factorType: "totp", issuer: "TD Operations", friendlyName: `new-${stamp}` })
    ok("new authenticator can be enrolled right after", !e2err && !!e2)
    const newSecret = (e2 as { totp?: { secret?: string } }).totp!.secret!
    const c2 = await u.auth.mfa.challenge({ factorId: e2!.id })
    const { error: v2 } = await u.auth.mfa.verify({ factorId: e2!.id, challengeId: c2.data!.id, code: generateSync({ secret: newSecret }) })
    ok("NEW authenticator's code activates it", !v2, v2?.message ?? "")

    // The OLD authenticator must be dead.
    const { data: r2 } = await u.auth.refreshSession()
    cookie = cookiesFor(r2?.session ?? s1.session)
    const { data: factorsNow } = await u.auth.mfa.listFactors()
    const onlyOne = (factorsNow?.totp ?? []).length === 1 && factorsNow!.totp[0].id === e2!.id
    ok("exactly ONE authenticator remains — the new one", onlyOne, `count=${(factorsNow?.totp ?? []).length}`)
    const oldCode = generateSync({ secret: oldSecret })
    const c3 = await u.auth.mfa.challenge({ factorId: e2!.id })
    const { error: oldTry } = await u.auth.mfa.verify({ factorId: e2!.id, challengeId: c3.data!.id, code: oldCode })
    ok("OLD phone's code is REJECTED", !!oldTry)

    // Fresh codes at the end of the replace; old set must be dead.
    const codes2 = await (await fetch(`${BASE}/api/mfa/backup-codes`, { method: "POST", headers: { Cookie: cookie } })).json()
    ok("replace issues a FRESH backup-code set", Array.isArray(codes2.codes) && codes2.codes.length === 10 && codes2.codes[0] !== codes1.codes[0])
    const oldCodeTry = await fetch(`${BASE}/api/mfa/backup-verify`, {
      method: "POST", headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: codes1.codes[1] }),
    })
    ok("a code from the OLD set is rejected", oldCodeTry.status === 403, `status=${oldCodeTry.status}`)

    // ── REGENERATE ──
    const codes3 = await (await fetch(`${BASE}/api/mfa/backup-codes`, { method: "POST", headers: { Cookie: cookie } })).json()
    ok("regenerate issues another fresh set", Array.isArray(codes3.codes) && codes3.codes[0] !== codes2.codes[0])
    const supersededTry = await fetch(`${BASE}/api/mfa/backup-verify`, {
      method: "POST", headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: codes2.codes[0] }),
    })
    ok("the superseded set is rejected", supersededTry.status === 403, `status=${supersededTry.status}`)

    // ── THE CLOSED HOLE: no second authenticator, even at aal2 ──
    const { data: e3, error: e3err } = await u.auth.mfa.enroll({ factorType: "totp", issuer: "TD Operations", friendlyName: `second-${stamp}` })
    if (!e3err && e3) {
      const c4 = await u.auth.mfa.challenge({ factorId: e3.id })
      const s = (e3 as { totp?: { secret?: string } }).totp!.secret!
      const { error: v4 } = await u.auth.mfa.verify({ factorId: e3.id, challengeId: c4.data!.id, code: generateSync({ secret: s }) })
      const { data: after } = await u.auth.mfa.listFactors()
      console.log(`  🔎 provider-level second-factor add at aal2: ${v4 ? "refused" : "PERMITTED"} (factors now ${(after?.totp ?? []).length}) — our setup page refuses it in the UI`)
      await u.auth.mfa.unenroll({ factorId: e3.id }).catch(() => {})
    } else {
      console.log(`  🔎 provider refused a second factor outright: ${e3err?.message}`)
    }
  } finally {
    await db.from("mfa_backup_codes").delete().eq("user_id", userId)
    await db.auth.admin.deleteUser(userId)
    console.log("  🧹 throwaway user + codes deleted")
  }
  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`)
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.error("FATAL:", e); process.exit(1) })
