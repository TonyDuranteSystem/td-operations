import { describe, it, expect } from "vitest"
import { formatChatPhone, isJunkChatName, resolveChatName } from "@/lib/messaging/chat-name"

describe("resolveChatName — never 'Unknown'", () => {
  const base = { externalGroupId: "393339980702@c.us" }
  it("CRM contact name wins over everything (the CRM is the source of truth for people it knows)", () => {
    expect(resolveChatName({ ...base, contactName: "Stefano Stella", leadName: "Stef", accountName: "Stella LLC", savedName: "Ste" })).toBe("Stefano Stella")
  })
  it("then the lead, then the company", () => {
    expect(resolveChatName({ ...base, leadName: "Stefano Stella", accountName: "Stella LLC", savedName: "x" })).toBe("Stefano Stella")
    expect(resolveChatName({ ...base, accountName: "Stella LLC", savedName: "x" })).toBe("Stella LLC")
  })
  it("with no CRM link, the name saved on the phone", () => {
    expect(resolveChatName({ ...base, savedName: "Patrick Covelli" })).toBe("Patrick Covelli")
  })
  it("with nothing, the formatted phone number — not 'Unknown'", () => {
    expect(resolveChatName({ ...base })).toBe("+393339980702")
    expect(resolveChatName({ externalGroupId: "393339980702", savedName: null })).toBe("+393339980702")
  })
  it("a saved 'name' that is just the number (WhatsApp echoing it) or 'Unknown' is ignored", () => {
    expect(resolveChatName({ ...base, savedName: "393339980702" })).toBe("+393339980702")
    expect(resolveChatName({ ...base, savedName: "+39 333 998 0702" })).toBe("+393339980702")
    expect(resolveChatName({ ...base, savedName: "Unknown" })).toBe("+393339980702")
    expect(resolveChatName({ ...base, savedName: "   " })).toBe("+393339980702")
  })
  it("blank linked names do not win", () => {
    expect(resolveChatName({ ...base, contactName: "  ", savedName: "Patrick" })).toBe("Patrick")
  })
  it("trims", () => expect(resolveChatName({ ...base, contactName: "  Stefano Stella " })).toBe("Stefano Stella"))
})

describe("isJunkChatName / formatChatPhone", () => {
  it("flags empty, Unknown and number-like names, keeps real names (even with digits)", () => {
    for (const j of [null, undefined, "", "  ", "Unknown", "unknown", "12066409886", "+1 206 640 9886"]) expect(isJunkChatName(j)).toBe(true)
    for (const g of ["Barnabas", "Studio 54", "Max Schipilliti", "Vastradrobe India Private Limited"]) expect(isJunkChatName(g)).toBe(false)
  })
  it("formats keys of both shapes and copes with garbage", () => {
    expect(formatChatPhone("393339980702@c.us")).toBe("+393339980702")
    expect(formatChatPhone("393339980702")).toBe("+393339980702")
    expect(formatChatPhone("120363000000@g.us")).toBe("+120363000000")
    expect(formatChatPhone("")).toBe("Unknown number")
    expect(formatChatPhone(null)).toBe("Unknown number")
  })
})
