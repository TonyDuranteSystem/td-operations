import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/google-drive-guard", () => ({ isProductionDatabase: () => false }))

import { storeSafeFileName } from "@/lib/crm-store/formation-pilot"

describe("storeSafeFileName", () => {
  it("keeps an ordinary name", () => expect(storeSafeFileName("Articles of Organization.pdf")).toBe("Articles of Organization.pdf"))
  it("replaces slashes and control characters", () => expect(storeSafeFileName("a/b\\c\u0007d.pdf")).toBe("a-b-c-d.pdf"))
  it("collapses and trims spaces", () => expect(storeSafeFileName("  spaces   in   name  .pdf")).toBe("spaces in name .pdf"))
  it("keeps unicode", () => expect(storeSafeFileName("Ñandú — résumé.pdf")).toBe("Ñandú — résumé.pdf"))
  it("shortens a too-long name but keeps the extension and the 255 limit", () => {
    const n = storeSafeFileName("X".repeat(300) + ".pdf")
    expect(n.length).toBe(255)
    expect(n.endsWith(".pdf")).toBe(true)
  })
  it("never returns an empty name", () => expect(storeSafeFileName("   ")).toBe("file"))
})
