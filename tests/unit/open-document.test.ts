import { describe, it, expect } from "vitest"
import { classifyPointer } from "@/lib/documents/open-document"

describe("classifyPointer — which place a document pointer names", () => {
  const id = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"
  it("a store pointer is the new storage (checked before the older one-letter-apart prefix)", () => {
    expect(classifyPointer(`store:${id}`)).toBe("store")
  })
  it("a storage: pointer is the older Supabase bucket", () => {
    expect(classifyPointer("storage:onboarding/abc/passport.pdf")).toBe("storage")
  })
  it("anything else is a Google Drive id", () => {
    expect(classifyPointer("1Vks3ZU5wn7t2I6ELAhT7LU-ilDTVB_2y")).toBe("drive")
  })
  it("a malformed store pointer is never treated as a Drive id", () => {
    expect(classifyPointer("store:not-a-uuid")).toBeNull()
    expect(classifyPointer("store:")).toBeNull()
  })
  it("empty values are unreadable", () => {
    expect(classifyPointer(null)).toBeNull()
    expect(classifyPointer(undefined)).toBeNull()
    expect(classifyPointer("")).toBeNull()
  })
})
