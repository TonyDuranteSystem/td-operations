import { describe, it, expect } from "vitest"
import { cookieName, decideAccess, hashSecret, newSecret } from "@/lib/bofa-intake/lock"

describe("bofa intake one-time link lock", () => {
  it("lets the first visitor claim a never-opened link", () => {
    expect(decideAccess({ status: "pending", opener_hash: null }, null)).toEqual({ access: "claim" })
  })

  it("treats an opened row with no stored hash as claimable (never left half-locked)", () => {
    expect(decideAccess({ status: "opened", opener_hash: null }, null)).toEqual({ access: "claim" })
  })

  it("lets the same browser back in after it opened the link", () => {
    const secret = newSecret()
    expect(decideAccess({ status: "opened", opener_hash: hashSecret(secret) }, secret)).toEqual({ access: "owner" })
  })

  it("blocks a different browser (no cookie) once the link was opened", () => {
    const secret = newSecret()
    expect(decideAccess({ status: "opened", opener_hash: hashSecret(secret) }, null)).toEqual({ access: "used" })
  })

  it("blocks a browser holding the wrong secret", () => {
    const secret = newSecret()
    expect(decideAccess({ status: "opened", opener_hash: hashSecret(secret) }, newSecret())).toEqual({ access: "used" })
  })

  it("kills the link for everyone, including the opener, once submitted or revoked", () => {
    const secret = newSecret()
    const hash = hashSecret(secret)
    expect(decideAccess({ status: "completed", opener_hash: hash }, secret)).toEqual({ access: "used" })
    expect(decideAccess({ status: "revoked", opener_hash: hash }, secret)).toEqual({ access: "used" })
    expect(decideAccess({ status: "completed", opener_hash: null }, null)).toEqual({ access: "used" })
  })

  it("never stores the secret itself, only a 64-char hash", () => {
    const secret = newSecret()
    expect(hashSecret(secret)).toHaveLength(64)
    expect(hashSecret(secret)).not.toContain(secret)
  })

  it("builds a stable cookie name from the token", () => {
    expect(cookieName("abcdefghijklmnopqrstuvwxyz")).toBe("bofa_abcdefghijklmnop")
  })
})
