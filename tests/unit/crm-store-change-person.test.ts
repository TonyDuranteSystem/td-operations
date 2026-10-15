import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { peopleChoices } from "@/lib/crm-store/change-person"

describe("peopleChoices", () => {
  it("offers the other people of the company, never the current person, no repeats, sorted", () => {
    const out = peopleChoices("a", [
      { contactId: "a", name: "Stefano Stella" },
      { contactId: "c", name: "Zed" },
      { contactId: "b", name: "Francesco Maggiorino-Ortuso" },
      { contactId: "b", name: "Francesco Maggiorino-Ortuso" },
    ])
    expect(out.map((p) => p.contactId)).toEqual(["b", "c"])
  })
  it("a person with no name still shows", () => {
    expect(peopleChoices("a", [{ contactId: "b", name: null }])[0].name).toBe("Person")
  })
  it("nobody else = nobody offered", () => {
    expect(peopleChoices("a", [{ contactId: "a", name: "X" }])).toEqual([])
  })
})
