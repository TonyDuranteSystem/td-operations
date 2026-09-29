/**
 * lib/money-input.ts — the shared money parser (dev job 89195c68).
 * The bug: an Italian "80.000" (eighty thousand) was saved as 80.
 */
import { describe, it, expect } from 'vitest'
import {
  parseMoneyInput,
  checkStoredMoney,
  coerceMoneyValue,
  decimalPlaces,
  formatMoneyUS,
  formatMoneyWithSymbol,
  formatMoneyItalian,
  amountInWords,
} from '@/lib/money-input'

const ok = (value: number, normalized = false) => ({ kind: 'ok', value, normalized })
const inv = (reason: string) => ({ kind: 'invalid', reason })

describe('parseMoneyInput — separators', () => {
  it.each([
    ['', { kind: 'empty' }],
    ['   ', { kind: 'empty' }],
    ['0', ok(0)],
    ['80', ok(80)],
    ['80000', ok(80000)],
    ['007', ok(7)],
    // US format
    ['80,000', ok(80000)],
    ['1,000,000', ok(1000000)],
    ['80,000.50', ok(80000.5)],
    ['80.5', ok(80.5)],
    ['80.50', ok(80.5)],
    ['.5', ok(0.5)],
    ['0.50', ok(0.5)],
    // Italian / European format
    ['80.000,50', ok(80000.5, true)],
    ['1.234,56', ok(1234.56, true)],
    ['1.000.000', ok(1000000, true)],
    ['100.000.000', ok(100000000, true)],
    ['80,5', ok(80.5, true)],
    ['80,50', ok(80.5, true)],
    ['1.000,5', ok(1000.5, true)],
    // spaces as thousands separator
    ['80 000', ok(80000, true)],
    ['1 234,56', ok(1234.56, true)],
    ['80 000', ok(80000, true)],
    ['80 000', ok(80000, true)],
  ])('%j', (input, expected) => {
    expect(parseMoneyInput(input)).toEqual(expected)
  })
})

describe('parseMoneyInput — the ambiguous dot', () => {
  it('asks for "80.000" (the reported bug)', () => {
    expect(parseMoneyInput('80.000')).toEqual({ kind: 'ambiguous', asThousands: 80000, asDecimal: 80 })
  })
  it('asks for "1.000" and "1.500"', () => {
    expect(parseMoneyInput('1.000')).toEqual({ kind: 'ambiguous', asThousands: 1000, asDecimal: 1 })
    expect(parseMoneyInput('1.500')).toEqual({ kind: 'ambiguous', asThousands: 1500, asDecimal: 1.5 })
    expect(parseMoneyInput('12.250')).toEqual({ kind: 'ambiguous', asThousands: 12250, asDecimal: 12.25 })
  })
  it('"10.596" cannot be cents (3 decimals) → only thousands', () => {
    expect(parseMoneyInput('10.596')).toEqual(ok(10596, true))
  })
  it('a leading "0" or 4+ digit group can never be thousands', () => {
    expect(parseMoneyInput('0.500')).toEqual(inv('too_many_decimals'))
    expect(parseMoneyInput('0.000')).toEqual(inv('too_many_decimals'))
    expect(parseMoneyInput('1500.000')).toEqual(inv('too_many_decimals'))
  })
})

describe('parseMoneyInput — invalid input', () => {
  it.each([
    ['80.', 'unreadable'],
    ['80..000', 'unreadable'],
    ['80.000.00', 'unreadable'],
    ['1,23,456', 'unreadable'],
    ['1,000.000', 'too_many_decimals'],
    ['0,500', 'too_many_decimals'],
    ['12345,678', 'too_many_decimals'],
    ['1.2345', 'too_many_decimals'],
    ['80.5000', 'too_many_decimals'],
    ['1e5', 'unreadable'],
    ['abc', 'unreadable'],
    ['80 5', 'unreadable'],
    ['1,5.000', 'unreadable'],
    ['80.000 USD dollars', 'unreadable'],
  ])('%j → %s', (input, reason) => {
    expect(parseMoneyInput(input)).toEqual(inv(reason))
  })
})

describe('parseMoneyInput — currency', () => {
  it('accepts the field currency anywhere around the number', () => {
    expect(parseMoneyInput('$80,000')).toEqual(ok(80000))
    expect(parseMoneyInput('US$80,000')).toEqual(ok(80000))
    expect(parseMoneyInput('80,000 USD')).toEqual(ok(80000))
    expect(parseMoneyInput('USD 1.234,56')).toEqual(ok(1234.56, true))
    expect(parseMoneyInput('80.000 €', { currency: 'EUR' })).toEqual({ kind: 'ambiguous', asThousands: 80000, asDecimal: 80 })
    expect(parseMoneyInput('EUR 1.234,56', { currency: 'EUR' })).toEqual(ok(1234.56, true))
  })
  it('refuses a different currency', () => {
    expect(parseMoneyInput('€80.000')).toEqual(inv('wrong_currency'))
    expect(parseMoneyInput('80,000 EUR')).toEqual(inv('wrong_currency'))
    expect(parseMoneyInput('$80,000', { currency: 'EUR' })).toEqual(inv('wrong_currency'))
    expect(parseMoneyInput('£500')).toEqual(inv('wrong_currency'))
  })
  it('refuses the currency twice', () => {
    expect(parseMoneyInput('$80,000 USD')).toEqual(inv('unreadable'))
  })
})

describe('parseMoneyInput — sign', () => {
  const neg = { allowNegative: true }
  it('refuses negatives by default', () => {
    expect(parseMoneyInput('-5')).toEqual(inv('negative'))
    expect(parseMoneyInput('(5)')).toEqual(inv('negative'))
    expect(parseMoneyInput('-80.000')).toEqual(inv('negative'))
  })
  it('accepts every negative style when allowed', () => {
    expect(parseMoneyInput('-150.25', neg)).toEqual(ok(-150.25))
    expect(parseMoneyInput('1.234,56-', neg)).toEqual(ok(-1234.56, true))
    expect(parseMoneyInput('−1.234,56', neg)).toEqual(ok(-1234.56, true))
    expect(parseMoneyInput('(1,234.56)', neg)).toEqual(ok(-1234.56))
    expect(parseMoneyInput('-$1,234.56', neg)).toEqual(ok(-1234.56))
    expect(parseMoneyInput('$-1,234', neg)).toEqual(ok(-1234))
    expect(parseMoneyInput('1,234-$', neg)).toEqual(ok(-1234))
    expect(parseMoneyInput('-80.000', neg)).toEqual({ kind: 'ambiguous', asThousands: -80000, asDecimal: -80 })
  })
  it('refuses double signs', () => {
    for (const s of ['(-5000)', '--5000', '-(5000)', '-5000-', '5-000', '+5']) {
      expect(parseMoneyInput(s, neg)).toEqual(inv('unreadable'))
    }
  })
  it('-0 is 0', () => {
    expect(parseMoneyInput('-0', neg)).toEqual(ok(0))
  })
})

describe('parseMoneyInput — bounds', () => {
  it('refuses values above max', () => {
    expect(parseMoneyInput('99999999999999')).toEqual(inv('too_large'))
    expect(parseMoneyInput('1000', { max: 999 })).toEqual(inv('too_large'))
  })
  it('keeps 17.65 exact (float trap)', () => {
    expect(parseMoneyInput('17.65')).toEqual(ok(17.65))
    expect(checkStoredMoney(17.65)).toBeNull()
  })
})

describe('decimalPlaces', () => {
  it('counts on the string', () => {
    expect(decimalPlaces(17.65)).toBe(2)
    expect(decimalPlaces(10.596)).toBe(3)
    expect(decimalPlaces(80)).toBe(0)
    expect(decimalPlaces(1e-7)).toBe(7)
    expect(decimalPlaces(1.5e-7)).toBe(8)
  })
})

describe('checkStoredMoney', () => {
  it('empty is fine', () => {
    expect(checkStoredMoney('')).toBeNull()
    expect(checkStoredMoney(null)).toBeNull()
    expect(checkStoredMoney(undefined)).toBeNull()
  })
  it('numbers', () => {
    expect(checkStoredMoney(80000)).toBeNull()
    expect(checkStoredMoney(10.596)).toBe('too_many_decimals')
    expect(checkStoredMoney(-500)).toBe('negative')
    expect(checkStoredMoney(-500, { allowNegative: true })).toBeNull()
    expect(checkStoredMoney(Number.NaN)).toBe('not_a_number')
  })
  it('strings', () => {
    expect(checkStoredMoney('80.000')).toBe('unanswered')
    expect(checkStoredMoney('abc')).toBe('unanswered')
    expect(checkStoredMoney('5000')).toBeNull()
    expect(checkStoredMoney('1.2345')).toBe('too_many_decimals')
    expect(checkStoredMoney('-5')).toBe('negative')
  })
  it('other types', () => {
    expect(checkStoredMoney(true)).toBe('not_a_number')
    expect(checkStoredMoney(['1'])).toBe('not_a_number')
  })
})

describe('coerceMoneyValue', () => {
  it('turns clean strings into numbers and leaves the rest', () => {
    expect(coerceMoneyValue('5000')).toBe(5000)
    expect(coerceMoneyValue('80,000')).toBe(80000)
    expect(coerceMoneyValue('  ')).toBe('')
    expect(coerceMoneyValue('80.000')).toBe('80.000')
    expect(coerceMoneyValue(12)).toBe(12)
    expect(coerceMoneyValue(null)).toBeNull()
  })
})

describe('formatting', () => {
  it('US box text has no currency symbol', () => {
    expect(formatMoneyUS(80000)).toBe('80,000')
    expect(formatMoneyUS(80.5)).toBe('80.50')
    expect(formatMoneyUS(1234.56)).toBe('1,234.56')
    expect(formatMoneyUS(-1234.5)).toBe('-1,234.50')
    expect(formatMoneyUS(10.596, { keepAllDecimals: true })).toBe('10.596')
    expect(formatMoneyUS(3.02822, { keepAllDecimals: true })).toBe('3.02822')
    expect(formatMoneyUS(12345.678, { keepAllDecimals: true })).toBe('12,345.678')
  })
  it('with symbol', () => {
    expect(formatMoneyWithSymbol(80000)).toBe('$80,000.00')
    expect(formatMoneyWithSymbol(1.5)).toBe('$1.50')
    expect(formatMoneyWithSymbol(-12.3, 'EUR')).toBe('-€12.30')
  })
  it('Italian', () => {
    expect(formatMoneyItalian(80000)).toBe('80.000')
    expect(formatMoneyItalian(1500)).toBe('1.500')
    expect(formatMoneyItalian(1.5)).toBe('1,50')
    expect(formatMoneyItalian(1234.56)).toBe('1.234,56')
    expect(formatMoneyItalian(80)).toBe('80')
    expect(formatMoneyItalian(80, { cents: true })).toBe('80,00')
  })
})

describe('amountInWords', () => {
  it('EN', () => {
    expect(amountInWords(80000, 'en')).toBe('80 thousand dollars')
    expect(amountInWords(80, 'en')).toBe('80 dollars')
    expect(amountInWords(1, 'en')).toBe('1 dollar')
    expect(amountInWords(1500, 'en')).toBe('One thousand five hundred dollars')
    expect(amountInWords(1.5, 'en')).toBe('1 dollar and 50 cents')
    expect(amountInWords(12.25, 'en')).toBe('12 dollars and 25 cents')
    expect(amountInWords(2_000_000, 'en')).toBe('2 million dollars')
    expect(amountInWords(155954, 'en')).toBeNull()
    expect(amountInWords(9999, 'en')).toBe('Nine thousand nine hundred ninety-nine dollars')
  })
  it('IT', () => {
    expect(amountInWords(80000, 'it')).toBe('80 mila dollari')
    expect(amountInWords(80, 'it')).toBe('80 dollari')
    expect(amountInWords(1500, 'it')).toBe('Millecinquecento dollari')
    expect(amountInWords(1.5, 'it')).toBe('1 dollaro e 50 centesimi')
    expect(amountInWords(1_000_000, 'it')).toBe('1 milione di dollari')
    expect(amountInWords(2183, 'it')).toBe('Duemilacentottantatré dollari')
    expect(amountInWords(1021, 'it')).toBe('Milleventuno dollari')
  })
  it('EUR', () => {
    expect(amountInWords(80000, 'en', 'EUR')).toBe('80 thousand euros')
    expect(amountInWords(80000, 'it', 'EUR')).toBe('80 mila euro')
  })
  it('no words for negatives', () => {
    expect(amountInWords(-5, 'en')).toBeNull()
  })
})
