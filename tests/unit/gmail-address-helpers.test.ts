import { describe, it, expect } from "vitest"
import { isOwnMailboxAddress, extractAllEmailAddresses } from "../../lib/gmail"

describe("isOwnMailboxAddress", () => {
  it("recognizes both TD mailboxes", () => {
    expect(isOwnMailboxAddress("support@tonydurante.us")).toBe(true)
    expect(isOwnMailboxAddress("antonio.durante@tonydurante.us")).toBe(true)
  })

  it("recognizes a display-name-wrapped own address", () => {
    expect(isOwnMailboxAddress('"Tony Durante LLC" <support@tonydurante.us>')).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isOwnMailboxAddress("Support@TonyDurante.US")).toBe(true)
  })

  it("rejects an external address, including a lookalike domain", () => {
    expect(isOwnMailboxAddress("dragos@payset.io")).toBe(false)
    expect(isOwnMailboxAddress("luca@tonydurante.us")).toBe(false)
    expect(isOwnMailboxAddress("support@nottonydurante.us")).toBe(false)
  })

  it("handles an empty/malformed value without throwing", () => {
    expect(isOwnMailboxAddress("")).toBe(false)
  })
})

describe("extractAllEmailAddresses", () => {
  it("extracts a single bare address", () => {
    expect(extractAllEmailAddresses("dragos@payset.io")).toEqual(["dragos@payset.io"])
  })

  it("extracts a single display-name-wrapped address", () => {
    expect(extractAllEmailAddresses('"Dragos Popescu" <dragos@payset.io>')).toEqual(["dragos@payset.io"])
  })

  it("extracts every address from a multi-recipient header", () => {
    expect(
      extractAllEmailAddresses('"Dragos Popescu" <dragos@payset.io>, Jane Smith <jane@example.com>')
    ).toEqual(["dragos@payset.io", "jane@example.com"])
  })

  // The exact failure mode a naive comma-split hits (lib/email-index/sync.ts
  // already has this bug) — the display name itself contains a comma, so
  // splitting on "," breaks the entry in half. Matching the address pattern
  // directly sidesteps it entirely: comma placement never matters.
  it("survives a comma INSIDE a display name — the exact case a naive split breaks on", () => {
    expect(
      extractAllEmailAddresses('"Popescu, Dragos" <dragos@payset.io>, John Smith <john@x.com>')
    ).toEqual(["dragos@payset.io", "john@x.com"])
  })

  it("lowercases and deduplicates while preserving first-seen order", () => {
    expect(
      extractAllEmailAddresses("Jane@Example.com, dragos@payset.io, jane@example.com")
    ).toEqual(["jane@example.com", "dragos@payset.io"])
  })

  it("returns an empty array for an empty or address-less header", () => {
    expect(extractAllEmailAddresses("")).toEqual([])
    expect(extractAllEmailAddresses("undisclosed-recipients:;")).toEqual([])
  })
})
