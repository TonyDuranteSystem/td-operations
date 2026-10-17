import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { User } from "@supabase/supabase-js"
import { userMayUseApp } from "@/lib/storage-app/device-auth"

const user = (o: Partial<User> & { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): User =>
  ({ id: "u1", email: "luca@example.test", aud: "authenticated", created_at: "", app_metadata: {}, user_metadata: {}, factors: [], ...o }) as unknown as User
const totp = [{ id: "f1", factor_type: "totp", status: "verified" }] as unknown as User["factors"]

describe("who may use the Mac app", () => {
  const saved = process.env.MFA_GRACE_UNTIL
  beforeEach(() => { delete process.env.MFA_GRACE_UNTIL })
  afterEach(() => { if (saved === undefined) delete process.env.MFA_GRACE_UNTIL; else process.env.MFA_GRACE_UNTIL = saved })

  it("lets staff (admin / team) with the two-step login set up in", () => {
    expect(userMayUseApp(user({ app_metadata: { role: "team" }, factors: totp })).ok).toBe(true)
    expect(userMayUseApp(user({ app_metadata: { role: "admin" }, factors: totp })).ok).toBe(true)
  })
  it("refuses clients, partners, nobody and a role nobody has thought about", () => {
    for (const role of ["client", "partner", "", undefined, "viewer"]) {
      expect(userMayUseApp(user({ app_metadata: { role }, factors: totp })).ok).toBe(false)
    }
    expect(userMayUseApp(null).ok).toBe(false)
  })
  it("never trusts the role the user can edit (user_metadata)", () => {
    const r = userMayUseApp(user({ app_metadata: {}, user_metadata: { role: "admin" }, factors: totp }))
    expect(r.ok).toBe(false)
    const r2 = userMayUseApp(user({ app_metadata: { role: "client" }, user_metadata: { role: "admin" }, factors: totp }))
    expect(r2.ok).toBe(false)
  })
  it("refuses a suspended login", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect(userMayUseApp(user({ app_metadata: { role: "team" }, factors: totp, banned_until: future } as never)).ok).toBe(false)
    const past = new Date(Date.now() - 3_600_000).toISOString()
    expect(userMayUseApp(user({ app_metadata: { role: "team" }, factors: totp, banned_until: past } as never)).ok).toBe(true)
  })
  it("follows the CRM's own two-step-login decision for a person with no authenticator", () => {
    const team = { role: "team" }
    expect(userMayUseApp(user({ app_metadata: team, factors: [] })).ok).toBe(false)                          // not enrolled, no grace → refused
    expect(userMayUseApp(user({ app_metadata: { ...team, mfa_exempt: true }, factors: [] })).ok).toBe(true) // owner-set exemption
    process.env.MFA_GRACE_UNTIL = new Date(Date.now() + 86_400_000).toISOString()
    expect(userMayUseApp(user({ app_metadata: team, factors: [] })).ok).toBe(true)                           // inside the grace period
    process.env.MFA_GRACE_UNTIL = "not a date"
    expect(userMayUseApp(user({ app_metadata: team, factors: [] })).ok).toBe(false)                          // garbage deadline → enforce
  })
})
