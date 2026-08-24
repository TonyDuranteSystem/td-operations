import { describe, it, expect } from "vitest"
import { getGuideTranslatableText } from "@/lib/portal/guide-translatable-text"
import { ARTICLES_EN, GUIDE_CONTENT_EN } from "@/app/portal/guide/guide-content"

describe("getGuideTranslatableText", () => {
  it("keys every entry by its own English text (same convention as the wizard collector)", () => {
    const out = getGuideTranslatableText()
    for (const [key, value] of Object.entries(out)) {
      expect(value).toBe(key)
    }
  })

  it("includes every article's title, description, step text, tip, and link label", () => {
    const out = getGuideTranslatableText()
    const first = ARTICLES_EN[0]
    expect(out[first.title]).toBe(first.title)
    expect(out[first.desc]).toBe(first.desc)
    expect(out[first.steps[0].text]).toBe(first.steps[0].text)
    expect(out[first.link!.label]).toBe(first.link!.label)

    const withTip = ARTICLES_EN.find(a => a.tip)!
    expect(out[withTip.tip!]).toBe(withTip.tip)

    const withSub = ARTICLES_EN.flatMap(a => a.steps).find(s => s.sub)!
    expect(out[withSub.sub!]).toBe(withSub.sub)
  })

  it("does NOT include article keywords — search stays English-term-based, a documented scoping choice", () => {
    const out = getGuideTranslatableText()
    const withDistinctiveKeyword = ARTICLES_EN.find(a => a.keywords.includes('routing number'))!
    expect(out['routing number']).toBeUndefined()
    expect(withDistinctiveKeyword).toBeDefined()
  })

  it("includes the page-chrome fields (title, subtitle, search copy, sections, roadmap, help banner)", () => {
    const out = getGuideTranslatableText()
    expect(out[GUIDE_CONTENT_EN.pageTitle]).toBe(GUIDE_CONTENT_EN.pageTitle)
    expect(out[GUIDE_CONTENT_EN.pageSubtitle]).toBe(GUIDE_CONTENT_EN.pageSubtitle)
    expect(out[GUIDE_CONTENT_EN.searchPlaceholder]).toBe(GUIDE_CONTENT_EN.searchPlaceholder)
    expect(out[GUIDE_CONTENT_EN.searchNoResults]).toBe(GUIDE_CONTENT_EN.searchNoResults)
    expect(out[GUIDE_CONTENT_EN.roadmapTitle]).toBe(GUIDE_CONTENT_EN.roadmapTitle)
    expect(out[GUIDE_CONTENT_EN.helpTitle]).toBe(GUIDE_CONTENT_EN.helpTitle)
    expect(out[GUIDE_CONTENT_EN.helpDesc]).toBe(GUIDE_CONTENT_EN.helpDesc)
    expect(out[GUIDE_CONTENT_EN.chatBtn]).toBe(GUIDE_CONTENT_EN.chatBtn)
    for (const section of GUIDE_CONTENT_EN.sections) expect(out[section]).toBe(section)
    for (const item of GUIDE_CONTENT_EN.roadmapItems) {
      expect(out[item.title]).toBe(item.title)
      expect(out[item.desc]).toBe(item.desc)
    }
  })

  it("includes the search-result-count template for AI translation of non-English/Italian counts", () => {
    const out = getGuideTranslatableText()
    expect(out['{n} results found']).toBe('{n} results found')
  })

  it("never emits an empty-string key for a present-but-blank optional field", () => {
    const out = getGuideTranslatableText()
    expect(Object.keys(out).every(k => k.trim().length > 0)).toBe(true)
  })
})
