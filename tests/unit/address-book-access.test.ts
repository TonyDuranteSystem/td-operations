import { describe, it, expect, vi, afterEach } from "vitest"
import { canUsePersonalBook, personalOwnerId } from "@/lib/address-book/personal-access"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("who may open the Personal book", () => {
  it("only the primary owner login", () => {
    expect(canUsePersonalBook({ id: "u1", email: "antonio.durante@tonydurante.us" })).toBe(true)
    expect(canUsePersonalBook({ id: "u1", email: "  Antonio.Durante@TonyDurante.us " })).toBe(true)
    expect(personalOwnerId({ id: "u1", email: "antonio.durante@tonydurante.us" })).toBe("u1")
  })

  it("not the team, not a client, not a signed-out visitor", () => {
    expect(canUsePersonalBook({ id: "u2", email: "support@tonydurante.us" })).toBe(false)
    expect(canUsePersonalBook({ id: "u3", email: "someone@example.com" })).toBe(false)
    expect(canUsePersonalBook({ id: "u4", email: null })).toBe(false)
    expect(canUsePersonalBook(null)).toBe(false)
    expect(canUsePersonalBook(undefined)).toBe(false)
    expect(personalOwnerId({ id: "u2", email: "support@tonydurante.us" })).toBeNull()
  })

  it("not even another OWNER added by the shared owner setting", () => {
    vi.stubEnv("NEXT_PUBLIC_EXTRA_OWNER_EMAILS", "jodi@tonydurante.us")
    expect(canUsePersonalBook({ id: "u5", email: "jodi@tonydurante.us" })).toBe(false)
    expect(personalOwnerId({ id: "u5", email: "jodi@tonydurante.us" })).toBeNull()
  })

  it("a login with no id cannot be scoped, so it is refused", () => {
    expect(canUsePersonalBook({ id: "", email: "antonio.durante@tonydurante.us" })).toBe(false)
    expect(canUsePersonalBook({ email: "antonio.durante@tonydurante.us" })).toBe(false)
    expect(personalOwnerId({ email: "antonio.durante@tonydurante.us" })).toBeNull()
  })
})
