import { describe, it, expect } from "vitest"
import {
  mergeNames,
  normalizeForDedup,
  isDuplicateName,
  validateAdminAddedName,
  classifyNameSource,
  companyNameForAccount,
} from "@/lib/llc-name-helpers"

describe("llc-name-helpers", () => {
  describe("mergeNames", () => {
    it("returns only wizard names in rank order when no admin-added", () => {
      const out = mergeNames({ name1: "Acme", name2: "Beta", name3: "Gamma" })
      expect(out).toEqual([
        { name: "Acme", source: "wizard", rank: 1 },
        { name: "Beta", source: "wizard", rank: 2 },
        { name: "Gamma", source: "wizard", rank: 3 },
      ])
    })

    it("skips empty wizard slots", () => {
      const out = mergeNames({ name1: "Acme", name2: "", name3: null })
      expect(out).toHaveLength(1)
      expect(out[0].name).toBe("Acme")
    })

    it("trims whitespace on wizard names", () => {
      const out = mergeNames({ name1: "  Acme  ", name2: "\tBeta\n", name3: "" })
      expect(out.map((n) => n.name)).toEqual(["Acme", "Beta"])
    })

    it("appends admin-added after wizard, ordered by added_at asc", () => {
      const out = mergeNames(
        { name1: "Acme LLC", name2: "", name3: "" },
        [
          { name: "Delta Co", added_at: "2026-04-22T10:00:00Z" },
          { name: "Epsilon Inc", added_at: "2026-04-22T09:00:00Z" },
        ],
      )
      expect(out.map((n) => ({ name: n.name, source: n.source }))).toEqual([
        { name: "Acme LLC", source: "wizard" },
        { name: "Epsilon Inc", source: "admin_added" },
        { name: "Delta Co", source: "admin_added" },
      ])
    })

    it("skips empty admin-added entries", () => {
      const out = mergeNames(
        { name1: "Acme", name2: "", name3: "" },
        [{ name: "   ", added_at: "2026-04-22T10:00:00Z" }],
      )
      expect(out).toHaveLength(1)
    })

    it("returns empty array on empty inputs", () => {
      expect(mergeNames({})).toEqual([])
      expect(mergeNames({ name1: "", name2: "", name3: "" }, [])).toEqual([])
    })
  })

  describe("normalizeForDedup", () => {
    it("lowercases + trims + collapses whitespace", () => {
      expect(normalizeForDedup("  ACME   LLC  ")).toBe("acme llc")
      expect(normalizeForDedup("Acme\tLLC")).toBe("acme llc")
    })

    it("returns empty string for null/empty", () => {
      expect(normalizeForDedup("")).toBe("")
      expect(normalizeForDedup("   ")).toBe("")
    })
  })

  describe("isDuplicateName", () => {
    it("detects duplicates case-insensitively", () => {
      expect(isDuplicateName("ACME LLC", ["Acme LLC"])).toBe(true)
      expect(isDuplicateName("acme llc", ["ACME LLC"])).toBe(true)
    })

    it("detects whitespace variants as duplicates", () => {
      expect(isDuplicateName("Acme  LLC", ["Acme LLC"])).toBe(true)
      expect(isDuplicateName("  Acme LLC  ", ["Acme LLC"])).toBe(true)
    })

    it("distinguishes different names", () => {
      expect(isDuplicateName("Acme Co", ["Acme LLC"])).toBe(false)
    })

    it("treats empty candidate as not duplicate", () => {
      expect(isDuplicateName("", ["Acme"])).toBe(false)
      expect(isDuplicateName("   ", ["Acme"])).toBe(false)
    })
  })

  describe("validateAdminAddedName", () => {
    it("accepts a trimmed non-empty name", () => {
      expect(validateAdminAddedName("Acme LLC")).toEqual({ valid: true, trimmed: "Acme LLC" })
      expect(validateAdminAddedName("  Beta Co  ")).toEqual({ valid: true, trimmed: "Beta Co" })
    })

    it("rejects empty / whitespace-only", () => {
      expect(validateAdminAddedName("").valid).toBe(false)
      expect(validateAdminAddedName("   ").valid).toBe(false)
    })

    it("rejects overly long names", () => {
      const tooLong = "A".repeat(201)
      const res = validateAdminAddedName(tooLong)
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/too long/i)
    })

    it("accepts at-boundary length (200)", () => {
      const atLimit = "A".repeat(200)
      expect(validateAdminAddedName(atLimit).valid).toBe(true)
    })
  })

  describe("classifyNameSource", () => {
    const wiz = { name1: "Acme", name2: "Beta", name3: "Gamma" }

    it("classifies exact match against wizard names as wizard", () => {
      expect(classifyNameSource("Acme", wiz, [])).toBe("wizard")
      expect(classifyNameSource("Beta", wiz, [])).toBe("wizard")
      expect(classifyNameSource("Gamma", wiz, [])).toBe("wizard")
    })

    it("classifies match against admin-added list as admin_added", () => {
      const added = [{ name: "Delta Co", added_at: "2026-04-22T10:00:00Z" }]
      expect(classifyNameSource("Delta Co", wiz, added)).toBe("admin_added")
    })

    it("admin_added wins over wizard if the same string is in both (defensive)", () => {
      const added = [{ name: "Acme", added_at: "2026-04-22T10:00:00Z" }]
      expect(classifyNameSource("Acme", wiz, added)).toBe("admin_added")
    })

    it("unknown name defaults to admin_added (verbatim-safe)", () => {
      expect(classifyNameSource("Zeta", wiz, [])).toBe("admin_added")
    })

    it("matching is exact (case-sensitive) — different casing is NOT wizard", () => {
      // Intentional: staff types what they want on the account; any casing
      // difference is treated as an admin-added (verbatim) value.
      expect(classifyNameSource("acme", wiz, [])).toBe("admin_added")
    })
  })

  describe("companyNameForAccount", () => {
    it("admin-added names are stored verbatim (no LLC append)", () => {
      expect(companyNameForAccount("Acme LLC", "admin_added")).toBe("Acme LLC")
      expect(companyNameForAccount("Acme Corporation", "admin_added")).toBe("Acme Corporation")
      expect(companyNameForAccount("Just a Name", "admin_added")).toBe("Just a Name")
    })

    it("wizard names get LLC appended when missing", () => {
      expect(companyNameForAccount("Acme", "wizard")).toBe("Acme LLC")
      expect(companyNameForAccount("Beta Co", "wizard")).toBe("Beta Co LLC")
    })

    it("wizard names already ending with LLC are NOT double-suffixed", () => {
      expect(companyNameForAccount("Acme LLC", "wizard")).toBe("Acme LLC")
      expect(companyNameForAccount("Acme llc", "wizard")).toBe("Acme llc")
      expect(companyNameForAccount("Acme LLC  ", "wizard")).toBe("Acme LLC")
    })

    it("trims leading/trailing whitespace", () => {
      expect(companyNameForAccount("  Acme  ", "admin_added")).toBe("Acme")
      expect(companyNameForAccount("  Acme  ", "wizard")).toBe("Acme LLC")
    })
  })
})
