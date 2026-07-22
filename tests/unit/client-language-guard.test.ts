/**
 * THE CLIENT-LANGUAGE GUARD — stops the seventh Italian-clients-get-English bug.
 *
 * `contacts.language` is free text. Production (2026-07-22) holds 211 rows of
 * "Italian", 200 of "English", 47 null, and five one-off spellings
 * ("Italiano", "Italian - englis", "Italiano - Ingle", "Italian / Englis",
 * "English or Italian"). It holds ZERO rows of "it".
 *
 * So every hand-rolled `language === "it"` check matched NOBODY and sent English
 * to all 211 Italian clients. lib/locale.ts was written to end this, and its own
 * header records the bug being fixed in five separate places. It then recurred
 * three more times — the ITIN "Send wizard link to client" action, its sibling
 * waiting-message handler, and the ITIN IRS-processing reminder cron — because
 * nothing stopped the next person writing the comparison by hand.
 *
 * Verified live: Pietro De Pellegrino (language "Italian") was sent the ENGLISH
 * ITIN wizard message on 2026-07-21; staff wrote him an Italian one by hand a
 * minute later.
 *
 * ── IF THIS TEST FAILS ────────────────────────────────────────────────────────
 * You compared a raw language value to a locale string. Don't. Call
 * `localeFromLanguage()` (or `isItalian()`) from lib/locale.ts — it is the single
 * normalizer and handles every production spelling. If your comparison is against
 * an ALREADY-normalized locale (a value typed `"en" | "it"`), name the variable
 * `locale` rather than `language` and this guard will leave it alone.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const ROOTS = ["lib", "app", "components"]
const SKIP_DIRS = new Set(["node_modules", ".next", "deprecated"])
// lib/locale.ts IS the normalizer — it is allowed to compare raw values.
const ALLOWLIST = new Set(["lib/locale.ts"])

/**
 * Only `contacts` and `leads` hold FREE TEXT. Verified on production 2026-07-22:
 *   contacts — "Italian" 211, "English" 200, null 47, 5 one-offs, "it" ZERO
 *   leads    — "Italian" 82, "English" 20, "it" 4, "en" 1   (mixed!)
 * Every other table storing a language holds the short code, so a strict
 * comparison there is CORRECT and must not be flagged:
 *   offers "it" 198 / "en" 42 · itin_submissions "it" 2 / "en" 6
 *   oa_agreements "en" 186 / "it" 1 · ss4_applications "en" 10 / "it" 6
 * So the guard fires only in files that actually read one of the free-text
 * tables — that is what makes it precise rather than noisy.
 */
const FREE_TEXT_TABLE = /\.from\(\s*['"](?:contacts|leads)['"]\s*\)/

/**
 * The receiver must be contact/lead-shaped. A file can legitimately read BOTH a
 * contact and a submission (e.g. the tax-quote route compares `sub.language`,
 * where the submission column really does hold "it"), so filtering by file alone
 * produces false alarms. `data` is included because the destructured supabase
 * result is the shape the real defects used (`data?.language === "it"`).
 */
const RAW_LANGUAGE_COMPARE =
  /\b(?:contact|contacts|lead|leads|data|c|l)\s*\??\.\s*(?:language|client_language)\s*(?:===|==|!==|!=)\s*['"](?:it|en)['"]/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

describe("client-language guard", () => {
  it("nobody compares a raw language value to a locale string", () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = file.replace(/\\/g, "/")
        if (ALLOWLIST.has(rel)) continue
        const src = readFileSync(file, "utf8")
        // Only files that read a free-text language column can have this bug.
        if (!FREE_TEXT_TABLE.test(src)) continue
        const lines = src.split("\n")
        lines.forEach((line, i) => {
          // Ignore comments — several files legitimately DESCRIBE the old bug.
          const code = line.trim()
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return
          if (!RAW_LANGUAGE_COMPARE.test(line)) return
          // A comparison that ALSO handles the long spelling is correct, just
          // hand-rolled — e.g. `lead.language === "Italian" || lead.language === "it"`.
          // The defect is comparing to the short code ALONE, which matches none
          // of the 211 "Italian" contacts. Don't fail those; they work.
          if (/['"]Ital/i.test(line) || /localeFromLanguage|isItalian/.test(line)) return
          offenders.push(`${rel}:${i + 1}  ${code.slice(0, 100)}`)
        })
      }
    }

    expect(
      offenders,
      `Raw contacts.language comparison found. Production stores "Italian", not "it", ` +
        `so this matches none of the 211 Italian clients and sends them English. ` +
        `Use localeFromLanguage() from lib/locale.ts.\n\n${offenders.join("\n")}\n`,
    ).toEqual([])
  })

  it("the guard actually catches the shape it is written for", () => {
    // Negative control: the pattern must match the real defects that shipped.
    expect(RAW_LANGUAGE_COMPARE.test(`return data?.language === "it" ? "it" : "en"`)).toBe(true)
    expect(RAW_LANGUAGE_COMPARE.test(`const lang = contact?.language === "it" ? "it" : "en"`)).toBe(true)
    expect(RAW_LANGUAGE_COMPARE.test(`if (data?.language === 'it') return 'it'`)).toBe(true)
    // And must NOT flag an already-normalized locale...
    expect(RAW_LANGUAGE_COMPARE.test(`const isIt = locale === 'it'`)).toBe(false)
    expect(RAW_LANGUAGE_COMPARE.test(`if (locale === 'it') return stage.client_label_it`)).toBe(false)
    // ...nor a table that genuinely stores the short code.
    expect(RAW_LANGUAGE_COMPARE.test(`const introField = sub.language === "it" ? "intro_it" : "intro_en"`)).toBe(false)
    expect(RAW_LANGUAGE_COMPARE.test(`const cl = CL[offer.language === 'it' ? 'it' : 'en']`)).toBe(false)
  })
})
