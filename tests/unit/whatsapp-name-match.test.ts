import { describe, it, expect } from "vitest"
import { nameTokens, namesMatchForSuggestion, comparableChatNames, phoneSlotPlan, suggestionKind, isOneToOneNumberKey } from "@/lib/messaging/name-match"

describe("nameTokens", () => {
  it("lowercases, strips accents, keeps 3+ letter words, dedupes", () => {
    expect(nameTokens("Davide BIANCARDINI")).toEqual(["biancardini", "davide"])
    expect(nameTokens("José Núñez")).toEqual(["jose", "nunez"])
    expect(nameTokens("Al Bo")).toEqual([])
    expect(nameTokens(null)).toEqual([])
  })
})

describe("namesMatchForSuggestion", () => {
  it("matches the same two-word name in any order, case or accent", () => {
    expect(namesMatchForSuggestion("Davide Biancardini", "biancardini davide")).toBe(true)
  })
  it("matches a longer CRM name that fully contains the chat name", () => {
    expect(namesMatchForSuggestion("Davide Biancardini", "Davide Maria Biancardini")).toBe(true)
  })
  it("never matches on a single shared word (first name or surname only)", () => {
    expect(namesMatchForSuggestion("Davide", "Davide Biancardini")).toBe(false)
    expect(namesMatchForSuggestion("Davide Rossi", "Marco Rossi")).toBe(false)
  })
  it("never matches a nickname against the full first name", () => {
    expect(namesMatchForSuggestion("Ste Rossi", "Stefano Rossi")).toBe(false)
  })
  it("never matches when either side has no comparable words", () => {
    expect(namesMatchForSuggestion("", "Davide Biancardini")).toBe(false)
    expect(namesMatchForSuggestion("王 小明", "Davide Biancardini")).toBe(false)
  })
})

describe("comparableChatNames", () => {
  it("drops junk: empty, our own business name, TD Team, bare numbers, the chat's own number", () => {
    expect(comparableChatNames("Tony Durante LLC", ["TD Team", "+39 366 962 6437", null, "Davide Biancardini"], "393669626437@c.us")).toEqual(["Davide Biancardini"])
  })
  it("dedupes ignoring case and keeps order, saved name first", () => {
    expect(comparableChatNames("Luca Degasperi", ["luca degasperi", "Luca D."])).toEqual(["Luca Degasperi", "Luca D."])
  })
  it("returns nothing when every name is junk", () => {
    expect(comparableChatNames(null, [null, "Unknown"])).toEqual([])
  })
})

describe("phoneSlotPlan", () => {
  it("uses the first free slot", () => {
    expect(phoneSlotPlan({ phone: "+17272509796" }, "393669626437")).toEqual({ kind: "slot", slot: "phone_2" })
    expect(phoneSlotPlan({ phone: "+17272509796", phone_2: "", phone_3: null }, "393669626437")).toEqual({ kind: "slot", slot: "phone_2" })
  })
  it("fills the first slot when the contact has no number", () => {
    expect(phoneSlotPlan({}, "393669626437")).toEqual({ kind: "slot", slot: "phone" })
  })
  it("recognises the number already on the contact in any format and slot", () => {
    expect(phoneSlotPlan({ phone: "+1 727", phone_3: "+39 366 962 6437" }, "393669626437")).toEqual({ kind: "already" })
  })
  it("reports full when all four slots are taken", () => {
    expect(phoneSlotPlan({ phone: "1111111", phone_2: "2222222", phone_3: "3333333", phone_4: "4444444" }, "393669626437")).toEqual({ kind: "full" })
  })
})

describe("phoneSlotPlan — notes are never overwritten", () => {
  it("a slot holding free text counts as taken", () => {
    expect(phoneSlotPlan({ phone: "+1727", phone_2: "ask Maria" }, "393669626437")).toEqual({ kind: "slot", slot: "phone_3" })
  })
})

describe("isOneToOneNumberKey", () => {
  it("accepts a phone number key, with or without @c.us", () => {
    expect(isOneToOneNumberKey("393669626437@c.us")).toBe(true)
    expect(isOneToOneNumberKey("393669626437")).toBe(true)
  })
  it("rejects groups, linked ids and junk", () => {
    expect(isOneToOneNumberKey("120363123456789012@g.us")).toBe(false)
    expect(isOneToOneNumberKey("99999999999@lid")).toBe(false)
    expect(isOneToOneNumberKey("abc")).toBe(false)
    expect(isOneToOneNumberKey("123")).toBe(false)
  })
})

describe("suggestionKind", () => {
  it("offers a one-click only for exactly one candidate", () => {
    expect(suggestionKind([])).toBe("none")
    expect(suggestionKind([1])).toBe("one")
    expect(suggestionKind([1, 2])).toBe("several")
  })
})
