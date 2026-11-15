import { describe, it, expect } from 'vitest'
import { LETTERS, LETTER_OTHER, letterCounts, letterMatches, nameInitial, parseLetter } from '@/lib/crm-lists/letters'
import { listYearOptions, parseListYear } from '@/lib/crm-lists/year'

describe('nameInitial', () => {
  it('uses the first letter, upper-cased', () => {
    expect(nameInitial('abdelbasset Lahmar')).toBe('A')
    expect(nameInitial('  northwind Holdings LLC')).toBe('N')
  })
  it('removes accents', () => {
    expect(nameInitial('Élan Studio LLC')).toBe('E')
    expect(nameInitial('Çelik')).toBe('C')
    expect(nameInitial('Ñandú')).toBe('N')
  })
  it('puts a dash, a number, a quote or nothing under #', () => {
    expect(nameInitial('— Holdings')).toBe(LETTER_OTHER)
    expect(nameInitial('2nd Street LLC')).toBe(LETTER_OTHER)
    expect(nameInitial('"Quoted" LLC')).toBe(LETTER_OTHER)
    expect(nameInitial('')).toBe(LETTER_OTHER)
    expect(nameInitial(null)).toBe(LETTER_OTHER)
    expect(nameInitial(undefined)).toBe(LETTER_OTHER)
  })
})

describe('parseLetter', () => {
  it('accepts A to Z (any case) and #', () => {
    expect(parseLetter('a')).toBe('A')
    expect(parseLetter('Z')).toBe('Z')
    expect(parseLetter('#')).toBe('#')
    expect(parseLetter(['m', 'x'])).toBe('M')
  })
  it('ignores anything else', () => {
    expect(parseLetter('AB')).toBe('')
    expect(parseLetter('1')).toBe('')
    expect(parseLetter('')).toBe('')
    expect(parseLetter(undefined)).toBe('')
    expect(parseLetter("'; drop table")).toBe('')
  })
  it('has all 26 letters', () => {
    expect(LETTERS).toHaveLength(26)
  })
})

describe('letterMatches / letterCounts', () => {
  it('no letter matches everything; a letter matches its names only', () => {
    expect(letterMatches('Anything', '')).toBe(true)
    expect(letterMatches('Marco', 'M')).toBe(true)
    expect(letterMatches('Marco', 'N')).toBe(false)
    expect(letterMatches('2 Bros', '#')).toBe(true)
  })
  it('counts names per letter and in all', () => {
    const c = letterCounts(['Ana', 'Adam', 'Luca', '2nd LLC', null, 'Élan'])
    expect(c.all).toBe(6)
    expect(c.byLetter).toEqual({ A: 2, L: 1, '#': 2, E: 1 })
  })
})

describe('invoice year choices', () => {
  it('offers every year with invoices plus the current one, newest first', () => {
    expect(listYearOptions([2026, 2025, 2026], 2026)).toEqual([2026, 2025])
    expect(listYearOptions([2026], 2027)).toEqual([2027, 2026])
    expect(listYearOptions([], 2026)).toEqual([2026])
  })
  it('ignores empty and nonsense years', () => {
    expect(listYearOptions([null, undefined, 20, 99999, 2025.5], 2026)).toEqual([2026])
  })
  it('reads the URL value, falling back to the current year', () => {
    const opts = [2027, 2026, 2025]
    expect(parseListYear('2025', opts, 2026)).toBe(2025)
    expect(parseListYear(['2027', '2025'], opts, 2026)).toBe(2027)
    expect(parseListYear('1999', opts, 2026)).toBe(2026)
    expect(parseListYear('abc', opts, 2026)).toBe(2026)
    expect(parseListYear('2026; x', opts, 2026)).toBe(2026)
    expect(parseListYear(undefined, opts, 2026)).toBe(2026)
  })
})
