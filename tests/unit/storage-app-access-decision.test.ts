import { describe, it, expect } from "vitest"
import type { User } from "@supabase/supabase-js"
import { decideAccess, signInExpiry } from "@/lib/storage-app/device-auth"
import { DEVICE_MAX_AGE_MS } from "@/lib/storage-app/tokens"

const staff = { id: "u1", email: "Luca@Example.com", app_metadata: { role: "admin", mfa_exempt: true } } as unknown as User

describe("deciding whether a Mac may keep its sign-in — a failed READ is never 'not allowed'", () => {
  it("could not read the login → unavailable (the Mac keeps its sign-in and asks again)", () => {
    expect(decideAccess({ kind: "error" }, ["luca@example.com"], false)).toEqual({ kind: "unavailable" })
  })
  it("could not read the allow-list → unavailable, not 'nobody is allowed'", () => {
    expect(decideAccess({ kind: "ok", user: staff }, null, false)).toEqual({ kind: "unavailable" })
  })
  it("a login that was read and is on the list → allowed", () => {
    expect(decideAccess({ kind: "ok", user: staff }, ["luca@example.com"], false)).toMatchObject({ kind: "allowed" })
  })
  it("a login that was read but is NOT on the list → denied", () => {
    expect(decideAccess({ kind: "ok", user: staff }, ["someone@else.com"], false)).toEqual({ kind: "denied", reason: "not on the allow-list" })
  })
  it("an empty allow-list that was READ means nobody → denied (still fails closed)", () => {
    expect(decideAccess({ kind: "ok", user: staff }, [], false)).toMatchObject({ kind: "denied" })
  })
  it("a login that no longer exists → denied", () => {
    expect(decideAccess({ kind: "gone" }, ["luca@example.com"], false)).toMatchObject({ kind: "denied" })
  })
})

describe("when a Mac must be approved again", () => {
  it("30 days after its first sign-in", () => {
    const created = "2026-11-01T10:00:00.000Z"
    expect(new Date(signInExpiry(created) as string).getTime() - new Date(created).getTime()).toBe(DEVICE_MAX_AGE_MS)
  })
  it("unknown device → null", () => {
    expect(signInExpiry(null)).toBeNull()
    expect(signInExpiry("not a date")).toBeNull()
  })
})
