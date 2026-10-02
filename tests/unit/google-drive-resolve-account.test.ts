import { describe, it, expect } from "vitest"
import { resolveDriveAccount } from "@/lib/google-drive"

describe("resolveDriveAccount — which Google account a copy may open", () => {
  it("'me' and empty mean the owner", () => {
    expect(resolveDriveAccount("me")).toBe(resolveDriveAccount(""))
    expect(resolveDriveAccount(undefined)).toMatch(/@tonydurante\.us$/)
  })
  it("accepts any address of the firm's own domain, lower-cased", () => {
    expect(resolveDriveAccount("Luca@TonyDurante.us")).toBe("luca@tonydurante.us")
    expect(resolveDriveAccount(" support@tonydurante.us ")).toBe("support@tonydurante.us")
  })
  it("refuses other domains and malformed addresses", () => {
    expect(() => resolveDriveAccount("someone@gmail.com")).toThrow()
    expect(() => resolveDriveAccount("a@tonydurante.us.evil.com")).toThrow()
    expect(() => resolveDriveAccount("not-an-email")).toThrow()
    expect(() => resolveDriveAccount("x y@tonydurante.us")).toThrow()
  })
})
