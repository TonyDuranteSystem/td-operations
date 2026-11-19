import { describe, it, expect } from "vitest"
import { decryptPersonal, decryptPersonalJson, encryptPersonal, encryptPersonalJson, personalSecretFromEnv, PERSONAL_KEY_ENV } from "@/lib/address-book/crypto"

const SECRET = "test-secret-test-secret-test-secret-123"
const OWNER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

describe("Personal book encryption", () => {
  it("round-trips a person and never leaves the name in the stored text", () => {
    const person = { full_name: "Sofia Marchetti", phones: ["+1 (555) 010-0142"] }
    const blob = encryptPersonalJson(person, SECRET, OWNER)
    expect(blob.startsWith("v1.")).toBe(true)
    expect(blob).not.toContain("Sofia")
    expect(blob).not.toContain("555")
    expect(decryptPersonalJson(blob, SECRET, OWNER)).toEqual(person)
  })

  it("two saves of the same text are different (fresh random iv)", () => {
    expect(encryptPersonal("same", SECRET, OWNER)).not.toBe(encryptPersonal("same", SECRET, OWNER))
  })

  it("a wrong secret opens to null, never throws", () => {
    const blob = encryptPersonal("hello", SECRET, OWNER)
    expect(decryptPersonal(blob, "another-secret-another-secret-another-1", OWNER)).toBeNull()
  })

  it("a payload moved onto another owner's row does not open", () => {
    const blob = encryptPersonal("hello", SECRET, OWNER)
    expect(decryptPersonal(blob, SECRET, OTHER)).toBeNull()
    expect(decryptPersonal(blob, SECRET, OWNER)).toBe("hello")
  })

  it("a changed value, a cut value or another format opens to null", () => {
    const blob = encryptPersonal("hello", SECRET, OWNER)
    const parts = blob.split(".")
    const flipped = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA")].join(".")
    expect(decryptPersonal(flipped, SECRET, OWNER)).toBeNull()
    expect(decryptPersonal(parts.slice(0, 3).join("."), SECRET, OWNER)).toBeNull()
    expect(decryptPersonal("plain text", SECRET, OWNER)).toBeNull()
    expect(decryptPersonal("v2." + parts.slice(1).join("."), SECRET, OWNER)).toBeNull()
    expect(decryptPersonal("", SECRET, OWNER)).toBeNull()
    expect(decryptPersonal(null, SECRET, OWNER)).toBeNull()
  })

  it("refuses to store without a trustworthy key or an owner", () => {
    expect(() => encryptPersonal("x", null, OWNER)).toThrow(/key is not set/)
    expect(() => encryptPersonal("x", "short", OWNER)).toThrow(/key is not set/)
    expect(() => encryptPersonal("x", SECRET, "")).toThrow(/no owner/)
    expect(decryptPersonal("v1.a.b.c", null, OWNER)).toBeNull()
  })

  it("decryptPersonalJson gives null for text that is not JSON", () => {
    const blob = encryptPersonal("not json {", SECRET, OWNER)
    expect(decryptPersonalJson(blob, SECRET, OWNER)).toBeNull()
  })

  it("the key comes from the environment, and a short or missing one switches the book off", () => {
    expect(personalSecretFromEnv({ [PERSONAL_KEY_ENV]: SECRET })).toBe(SECRET)
    expect(personalSecretFromEnv({ [PERSONAL_KEY_ENV]: `  ${SECRET}  ` })).toBe(SECRET)
    expect(personalSecretFromEnv({ [PERSONAL_KEY_ENV]: "short" })).toBeNull()
    expect(personalSecretFromEnv({})).toBeNull()
  })
})
