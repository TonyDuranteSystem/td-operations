import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { localeFromLanguage, isItalian } from '@/lib/locale'
import { isItalianLang } from '@/lib/operations/file-renewal'

/**
 * A client's language is free text in the CRM ("Italian", "it", "Italiano", "Italy ", "Italia"…). Antonio, 2026-11-11:
 * "make it flexible and not hardcoded — 'Italy' or 'Italian' means he speaks Italian." A client whose language field read
 * "Italy " (with a trailing space) was treated as English by about thirty places that compared the field to the exact word
 * "Italian" or "it" — welcome messages, requests, emails, invoice PDFs, forms went out in English to an Italian client.
 * ONE reader decides (lib/locale.ts); this test pins what it accepts and fails if a new exact-word comparison is written.
 */
describe('localeFromLanguage — anything that looks Italian is Italian', () => {
  const italian = ['Italian', 'italian', 'ITALIAN', 'it', 'IT', ' it ', 'Italiano', 'italiana', 'Italy', 'Italy ', ' ITALY', 'Italia', 'it-IT', 'it_IT', 'Italian - englis', 'Italian/English']
  const other = ['English', 'en', 'en-US', 'Germany', 'German', 'Deutsch', 'Spanish', 'Itinerant', '', '   ', null, undefined]
  for (const v of italian) it(`${JSON.stringify(v)} → it`, () => expect(localeFromLanguage(v)).toBe('it'))
  for (const v of other) it(`${JSON.stringify(v)} → en`, () => expect(localeFromLanguage(v as never)).toBe('en'))
  it('isItalian and the older isItalianLang agree with it', () => {
    for (const v of [...italian, ...other]) {
      expect(isItalian(v as never)).toBe(localeFromLanguage(v as never) === 'it')
      expect(isItalianLang(v as never)).toBe(localeFromLanguage(v as never) === 'it')
    }
  })
})

/** The exact-word comparisons that caused it: `x.language === "Italian"`, `rawLang === 'Italian'`, `clientLanguage === 'Italian'`. */
const RAW_WORD_COMPARE = /[Ll]ang(?:uage)?\)?\s*===?\s*["']Italian["']/
const ROOTS = ['lib', 'app', 'components']
const SKIP_DIRS = new Set(['node_modules', '.next', 'deprecated'])
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('nobody compares a language field to the exact word "Italian"', () => {
  it('every language read goes through lib/locale.ts', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(join(process.cwd(), root))) {
        if (file.endsWith('lib/locale.ts')) continue
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const code = line.trim()
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return // a comment describing the old bug is fine
          if (RAW_WORD_COMPARE.test(line)) offenders.push(`${file.replace(process.cwd() + '/', '')}:${i + 1}: ${line.trim().slice(0, 120)}`)
        })
      }
    }
    expect(offenders, `Use localeFromLanguage()/isItalian() from '@/lib/locale' instead:\n${offenders.join('\n')}`).toEqual([])
  })
  it('the guard itself catches the old pattern (and not a normal "it" locale code)', () => {
    expect(RAW_WORD_COMPARE.test('const x = contact.language === "Italian" ? "it" : "en"')).toBe(true)
    expect(RAW_WORD_COMPARE.test("if (rawLang === 'Italian' || rawLang === 'it') {")).toBe(true)
    expect(RAW_WORD_COMPARE.test("clientLanguage === 'Italian'")).toBe(true)
    expect(RAW_WORD_COMPARE.test("const l = language === 'it' ? 'Italian' : 'English'")).toBe(false)
    expect(RAW_WORD_COMPARE.test("translating === 'Italian'")).toBe(false)
  })
})
