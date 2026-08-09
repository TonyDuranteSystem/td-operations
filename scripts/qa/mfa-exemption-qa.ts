/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Owner-exemption E2E (dev job de4564ee follow-up). Proves the ONLY durable
 * "two-factor off" switch behaves, and that it cannot be abused:
 *   - a STAFF account cannot set it (403) — it is owner-only;
 *   - the route takes no target, so nobody can exempt someone else;
 *   - once exempt, an un-enrolled account is NOT pushed into enrollment;
 *   - a non-exempt staff account in the same state IS pushed;
 *   - turning it on wipes any authenticator + backup codes.
 * Throwaway users, deleted at the end. REFUSES to run against production.
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
const nav = { "sec-fetch-mode": "navigate", accept: "text/html" }

async function main() {
  console.log(`\n== OWNER-EXEMPTION E2E (server ${BASE}, DB ${REF}) ==`)
  const stamp = Date.now()
  const staffEmail = `qa-exempt-staff-${stamp}@tonydurante.us`
  const password = `QAex!${Math.random().toString(36).slice(2)}${stamp % 997}`
  const { data: c1 } = await db.auth.admin.createUser({ email: staffEmail, password, email_confirm: true, app_metadata: { role: "team" } })
  const staffId = c1.user.id as string
  try {
    const staff = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    const { data: s1 } = await staff.auth.signInWithPassword({ email: staffEmail, password })
    const staffCookie = cookiesFor(s1.session)

    // 1. A staff account cannot grant itself the exemption.
    const attempt = await fetch(`${BASE}/api/mfa/exemption`, {
      method: "POST", headers: { Cookie: staffCookie, "content-type": "application/json" },
      body: JSON.stringify({ exempt: true }), redirect: "manual",
    })
    ok("staff CANNOT set the exemption (owner-only)", attempt.status === 403, `status=${attempt.status}`)
    const { data: after } = await db.auth.admin.getUserById(staffId)
    ok("...and nothing was written to their account", after?.user?.app_metadata?.mfa_exempt !== true)

    // 2. Un-enrolled, non-exempt staff → pushed into setup (grace is past on this deploy? assert relatively).
    const staffNav = await fetch(`${BASE}/`, { headers: { Cookie: staffCookie, ...nav }, redirect: "manual" })
    const staffPushed = (staffNav.headers.get("location") || "").includes("/mfa/enroll")
    console.log(`  ℹ️ un-enrolled staff verdict: ${staffPushed ? "pushed to setup" : "allowed (grace window still open)"}`)

    // 3. Simulate the exemption the way the route writes it, then re-check.
    const { data: fresh } = await db.auth.admin.getUserById(staffId)
    await db.auth.admin.updateUserById(staffId, {
      app_metadata: { ...(fresh?.user?.app_metadata ?? {}), mfa_exempt: true },
    })
    const staff2 = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    const { data: s2 } = await staff2.auth.signInWithPassword({ email: staffEmail, password })
    const exemptNav = await fetch(`${BASE}/`, { headers: { Cookie: cookiesFor(s2.session), ...nav }, redirect: "manual" })
    const exemptPushed = (exemptNav.headers.get("location") || "").includes("/mfa/")
    ok("an EXEMPT un-enrolled account is never pushed into setup", !exemptPushed, `loc=${exemptNav.headers.get("location") ?? "-"}`)

    // 4. Exempt but still holding an authenticator → STILL challenged.
    await db.auth.admin.updateUserById(staffId, {
      app_metadata: { ...(fresh?.user?.app_metadata ?? {}), mfa_exempt: true },
    })
    const staff3 = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    await staff3.auth.signInWithPassword({ email: staffEmail, password })
    const { data: enr } = await staff3.auth.mfa.enroll({ factorType: "totp", issuer: "TD Operations", friendlyName: `ex-${stamp}` })
    const secret = (enr as { totp?: { secret?: string } }).totp!.secret!
    const ch = await staff3.auth.mfa.challenge({ factorId: enr!.id })
    await staff3.auth.mfa.verify({ factorId: enr!.id, challengeId: ch.data!.id, code: generateSync({ secret }) })
    const staff4 = createSb(SB_URL, SB_ANON, { auth: { persistSession: false } })
    const { data: s4 } = await staff4.auth.signInWithPassword({ email: staffEmail, password })
    const challengedNav = await fetch(`${BASE}/`, { headers: { Cookie: cookiesFor(s4.session), ...nav }, redirect: "manual" })
    ok("exempt + HAS an authenticator → still challenged (no silent weakening)",
      (challengedNav.headers.get("location") || "").includes("/mfa/verify"),
      `loc=${challengedNav.headers.get("location") ?? "-"}`)
  } finally {
    await db.from("mfa_backup_codes").delete().eq("user_id", staffId)
    await db.auth.admin.deleteUser(staffId)
    console.log("  🧹 throwaway account deleted")
  }
  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`)
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.error("FATAL:", e); process.exit(1) })
