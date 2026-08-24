/* eslint-disable no-console -- CLI script reports progress via stdout. */
/**
 * Generate real translations for one language, from the portal's
 * translatable content sources, via the AI provider — dev job 12cab351.
 *
 * Idempotent: rerunning skips keys already 'done' for that language.
 *
 * Run against sandbox first:
 *   npx tsx scripts/generate-portal-translations.ts ja Japanese          # central dictionary
 *   npx tsx scripts/generate-portal-translations.ts ja Japanese wizard   # wizard field labels
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL from .env.local to determine the target
 * env. Refuses to run unless it points to sandbox.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { generateTranslationsForLanguage } from "@/lib/portal/translation-generator"
import { isValidLanguageCode } from "@/lib/portal/language-codes"
import { getEnglishDictionary } from "@/lib/portal/i18n"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes(SANDBOX_REF)) {
  console.error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL must point to sandbox ref ${SANDBOX_REF}.`)
  console.error(`Currently: ${url}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const source = args[args.length - 1] === "wizard" ? "wizard" : "dictionary"
const nameParts = source === "wizard" ? args.slice(1, -1) : args.slice(1)
const languageCode = args[0]
const languageName = nameParts.join(" ")

if (!languageCode || !languageName) {
  console.error("Usage: npx tsx scripts/generate-portal-translations.ts <iso-code> <Language Name> [wizard]")
  console.error("Example: npx tsx scripts/generate-portal-translations.ts ja Japanese")
  console.error("Example: npx tsx scripts/generate-portal-translations.ts ja Japanese wizard")
  process.exit(1)
}
if (!isValidLanguageCode(languageCode)) {
  console.error(`"${languageCode}" is not a real ISO 639-1 code — see lib/portal/language-codes.ts.`)
  process.exit(1)
}

const sourceDictionary = source === "wizard" ? getWizardTranslatableText() : getEnglishDictionary()
console.log(`Source: ${source} (${Object.keys(sourceDictionary).length} phrases)`)

generateTranslationsForLanguage(languageCode, languageName, sourceDictionary)
  .then(result => {
    console.log(JSON.stringify(result, null, 2))
    if (result.failed > 0) {
      console.error(`${result.failed} key(s) failed — rerun this script to retry them.`)
      process.exit(1)
    }
  })
  .catch(err => {
    console.error("Generation failed:", err)
    process.exit(1)
  })
