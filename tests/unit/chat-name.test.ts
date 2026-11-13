import { describe, it, expect } from "vitest"
import { formatChatPhone, isJunkChatName, resolveChatName, OWN_BUSINESS_NAME } from "@/lib/messaging/chat-name"

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
  it("a saved name that is really OUR OWN business identity (2026-10-01: GOWA leaking it onto client chats) is ignored, case-insensitively, even with a real CRM link it never wins because the link already takes priority", () => {
    expect(resolveChatName({ ...base, savedName: OWN_BUSINESS_NAME })).toBe("+393339980702")
    expect(resolveChatName({ ...base, savedName: "tony durante llc" })).toBe("+393339980702")
    expect(resolveChatName({ ...base, savedName: "  Tony Durante LLC  " })).toBe("+393339980702")
    expect(resolveChatName({ ...base, contactName: "Paul Andrei Ciuban", savedName: OWN_BUSINESS_NAME })).toBe("Paul Andrei Ciuban")
  })
  it("blank linked names do not win", () => {
    expect(resolveChatName({ ...base, contactName: "  ", savedName: "Patrick" })).toBe("Patrick")
  })
  it("trims", () => expect(resolveChatName({ ...base, contactName: "  Stefano Stella " })).toBe("Stefano Stella"))
})

describe("isJunkChatName / formatChatPhone", () => {
  it("flags empty, Unknown, number-like names, and our own business identity; keeps real names (even with digits)", () => {
    for (const j of [null, undefined, "", "  ", "Unknown", "unknown", "12066409886", "+1 206 640 9886", "Tony Durante LLC", "TONY DURANTE LLC"]) expect(isJunkChatName(j)).toBe(true)
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

describe("sender-name fallback (Antonio, 2026-11-13: the phone knew the name, the CRM header showed only the number)", () => {
  const KEY = "393662406426@c.us"

  it("uses the sender's WhatsApp name only when nothing better exists, and says where it came from", async () => {
    const { resolveChatNameWithSource } = await import("@/lib/messaging/chat-name")
    expect(resolveChatNameWithSource({ senderName: "Vincenzo (Avvocato) Randazzo", externalGroupId: KEY })).toEqual({ name: "Vincenzo (Avvocato) Randazzo", source: "whatsapp" })
    expect(resolveChatNameWithSource({ savedName: "Vincenzo R", senderName: "x y", externalGroupId: KEY })).toEqual({ name: "Vincenzo R", source: "phone" })
    expect(resolveChatNameWithSource({ contactName: "Santo Catania", savedName: "S", senderName: "x y", externalGroupId: KEY })).toEqual({ name: "Santo Catania", source: "crm" })
    expect(resolveChatNameWithSource({ externalGroupId: KEY })).toEqual({ name: "+393662406426", source: "number" })
  })

  it("never uses a junk sender name: our business name, TD Team, a bare number, Unknown", async () => {
    const { resolveChatNameWithSource, pickSenderName } = await import("@/lib/messaging/chat-name")
    for (const bad of ["Tony Durante LLC", "TD Team", "td team", "+393662406426", "Unknown", "", null]) {
      expect(resolveChatNameWithSource({ senderName: bad, externalGroupId: KEY }).source).toBe("number")
    }
    expect(pickSenderName(["TD Team", null, "Tony Durante LLC", "Vincenzo R"], KEY)).toBe("Vincenzo R")
    expect(pickSenderName(["TD Team"], KEY)).toBeNull()
    expect(pickSenderName([], KEY)).toBeNull()
  })

  it("keeps the newest usable name first", async () => {
    const { pickSenderName } = await import("@/lib/messaging/chat-name")
    expect(pickSenderName(["Newest Name", "Older Name"], KEY)).toBe("Newest Name")
  })
})
