/**
 * lib/portal/translation-sources.ts — the single shared source-ordering
 * definition (dev job 12cab351, 2026-08-25). Previously defined three times
 * independently (translate-language.ts, the language-picker route, and now
 * the catch-up sweep); this is the regression guard that the one definition
 * stays internally consistent.
 */

import { describe, it, expect } from "vitest"
import { SOURCES_IN_ORDER, NEXT_SOURCE, sourceDictionaryFor } from "@/lib/portal/translation-sources"

describe("translation-sources", () => {
  it("SOURCES_IN_ORDER is dictionary, then wizard, then guide", () => {
    expect(SOURCES_IN_ORDER).toEqual(["dictionary", "wizard", "guide"])
  })

  it("NEXT_SOURCE chains dictionary -> wizard -> guide -> null, matching SOURCES_IN_ORDER exactly", () => {
    expect(NEXT_SOURCE.dictionary).toBe("wizard")
    expect(NEXT_SOURCE.wizard).toBe("guide")
    expect(NEXT_SOURCE.guide).toBeNull()
  })

  it("sourceDictionaryFor returns a non-empty dictionary for every source", () => {
    for (const source of SOURCES_IN_ORDER) {
      const dict = sourceDictionaryFor(source)
      expect(Object.keys(dict).length).toBeGreaterThan(0)
    }
  })
})
