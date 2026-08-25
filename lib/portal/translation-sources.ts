import { getEnglishDictionary } from "@/lib/portal/i18n"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"
import { getGuideTranslatableText } from "@/lib/portal/guide-translatable-text"

/**
 * The three content sources fed into the any-language translation engine
 * (dev job 12cab351), and the single order every chain/seed/catch-up call
 * site walks them in: dictionary, then wizard, then guide.
 *
 * Single source of truth — this used to be defined three times (a local
 * `Source` + `NEXT_SOURCE` map in translate-language.ts, a local
 * `TranslationSource` + `SOURCES_IN_ORDER` array in the language-picker
 * route, and implicitly again in the language-catchup sweep) and drifting
 * copies of this exact list is what let dev-job-12cab351 clients like
 * Spanish/French go quietly behind when a new source's key set grew: a
 * fourth call site couldn't add itself to "the order" without knowing
 * three other places also needed updating. Add a new source here once.
 */
export type TranslationSource = "dictionary" | "wizard" | "guide"

export const SOURCES_IN_ORDER: TranslationSource[] = ["dictionary", "wizard", "guide"]

/** Chain order: dictionary finishing hops into wizard, wizard finishing hops
 * into guide, guide finishing ends the chain for this language. */
export const NEXT_SOURCE: Record<TranslationSource, TranslationSource | null> = {
  dictionary: "wizard",
  wizard: "guide",
  guide: null,
}

export function sourceDictionaryFor(source: TranslationSource): Record<string, string> {
  if (source === "wizard") return getWizardTranslatableText()
  if (source === "guide") return getGuideTranslatableText()
  return getEnglishDictionary()
}
