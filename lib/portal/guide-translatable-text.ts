import { ARTICLES_EN, GUIDE_CONTENT_EN, RESULT_COUNT_TEMPLATE } from "@/app/portal/guide/guide-content"

/**
 * Every translatable English phrase in the client portal's help-article
 * library (dev job 12cab351) — the third content source fed into the shared
 * AI translation engine (lib/portal/translation-generator.ts), after the
 * central dictionary and the wizard field labels.
 *
 * Keyed by the phrase's own English text, same convention as
 * wizard-translatable-text.ts — the English text IS the key, not a
 * synthetic id. app/portal/guide/page.tsx looks each string up the same
 * "translations[en] ?? (locale === 'it' ? it : en)" way the wizard already
 * does, using its own hand-written Italian as the it/fallback side — this
 * file only needs to enumerate the English side.
 *
 * Deliberately NOT included: each article's `keywords` array. Those exist
 * purely to match against whatever the client types into the search box —
 * translating them would require also translating the search input itself
 * into every picked language to be useful, which this pass doesn't attempt.
 * Search stays English-term-based; article CONTENT (title/description/
 * steps/tip) is what gets translated. A real limitation, not an oversight —
 * documented in docs/systems/portal.md rather than silently shipped.
 */

function addIfPresent(out: Record<string, string>, text: string | undefined): void {
  if (text && text.trim()) out[text] = text
}

export function getGuideTranslatableText(): Record<string, string> {
  const out: Record<string, string> = {}

  for (const article of ARTICLES_EN) {
    addIfPresent(out, article.title)
    addIfPresent(out, article.desc)
    for (const s of article.steps) {
      addIfPresent(out, s.text)
      addIfPresent(out, s.sub)
    }
    addIfPresent(out, article.tip)
    addIfPresent(out, article.link?.label)
  }

  for (const section of GUIDE_CONTENT_EN.sections) addIfPresent(out, section)

  addIfPresent(out, GUIDE_CONTENT_EN.pageTitle)
  addIfPresent(out, GUIDE_CONTENT_EN.pageSubtitle)
  addIfPresent(out, GUIDE_CONTENT_EN.searchPlaceholder)
  addIfPresent(out, GUIDE_CONTENT_EN.searchNoResults)
  addIfPresent(out, GUIDE_CONTENT_EN.roadmapTitle)
  for (const item of GUIDE_CONTENT_EN.roadmapItems) {
    addIfPresent(out, item.title)
    addIfPresent(out, item.desc)
  }
  addIfPresent(out, GUIDE_CONTENT_EN.helpTitle)
  addIfPresent(out, GUIDE_CONTENT_EN.helpDesc)
  addIfPresent(out, GUIDE_CONTENT_EN.chatBtn)

  addIfPresent(out, RESULT_COUNT_TEMPLATE)

  return out
}
