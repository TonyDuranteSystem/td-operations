import { describe, it, expect } from "vitest"
import { fillSlots } from "@/components/talk/talk-i18n"
import { IT } from "@/lib/marketing/i18n-it"

describe("the chat screen's translator", () => {
  it("by default (TD Talk, Team Chat) it is the English text exactly as written, with {slots} filled in — nothing changes there", () => {
    expect(fillSlots("Send")).toBe("Send")
    expect(fillSlots("Replying to {who}", { who: "Luca" })).toBe("Replying to Luca")
    expect(fillSlots("Up to {n} files per message.", { n: 5 })).toBe("Up to 5 files per message.")
    expect(fillSlots("Can't attach: {names}", {})).toBe("Can't attach: {names}") // an unfilled slot is left visible, never blanked
  })
  it("the Italian chat keeps every slot of the English text", () => {
    for (const k of ["Replying to {who}", "Up to {n} files per message.", "Can't attach: {names}", "Remove {name}", "React {emoji}", "{who} is typing…", "{who} is recording a voice message…"]) {
      const slots = (x: string) => (x.match(/\{\w+\}/g) ?? []).sort().join(",")
      expect(IT[k], k).toBeTruthy()
      expect(slots(IT[k])).toBe(slots(k))
    }
  })
})
