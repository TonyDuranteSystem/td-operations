import { describe, it, expect } from 'vitest'
import { formatAmount, formatNumber, parseAmountInput } from '@/lib/signed-contracts/amount-input'

const ok = (input: string) => {
  const r = parseAmountInput(input)
  if (r.kind !== 'ok') throw new Error(`expected "${input}" to be read, got: ${r.error}`)
  return r
}
const refused = (input: unknown) => {
  const r = parseAmountInput(input)
  expect(r.kind).toBe('refused')
  return r.kind === 'refused' ? r.error : ''
}

describe('parseAmountInput — both ways of writing an amount mean the same thing', () => {
  it('reads the American and the European thousands separator as the same amount', () => {
    expect(ok('1,250').value).toBe(1250)
    expect(ok('1.250').value).toBe(1250)
    expect(ok('2,000').value).toBe(2000)
    expect(ok('2.000').value).toBe(2000)
    expect(ok('1250').value).toBe(1250)
  })

  it('reads decimals in either style', () => {
    expect(ok('1,250.50').value).toBe(1250.5)
    expect(ok('1.250,50').value).toBe(1250.5)
    expect(ok('1250.50').value).toBe(1250.5)
    expect(ok('1250,5').value).toBe(1250.5)
    expect(ok('12.5').value).toBe(12.5)
  })

  it('reads several thousands separators', () => {
    expect(ok('1.000.000').value).toBe(1000000)
    expect(ok('1,000,000').value).toBe(1000000)
    expect(refused('1.250.000')).toMatch(/not accepted/) // read correctly, then refused as too large
  })

  it('ignores currency symbols, words and spaces', () => {
    expect(ok('$1,250').value).toBe(1250)
    expect(ok('€ 1.250,00').value).toBe(1250)
    expect(ok('1 250').value).toBe(1250)
    expect(ok("1'250").value).toBe(1250)
    expect(ok('USD 1,250').value).toBe(1250)
    expect(ok('  1250  ').value).toBe(1250)
  })

  it('accepts zero (a June installment can be $0)', () => {
    expect(ok('0').value).toBe(0)
  })

  it('shows back how it read the text', () => {
    expect(ok('1.250').readAs).toBe('1,250')
    expect(ok('1250,5').readAs).toBe('1,250.50')
    expect(ok('849,50').readAs).toBe('849.50')
  })

  it('refuses instead of guessing', () => {
    expect(refused('')).toMatch(/Type an amount/)
    expect(refused('   ')).toMatch(/Type an amount/)
    expect(refused(undefined)).toMatch(/Type an amount/)
    expect(refused('abc')).toMatch(/digits only/)
    expect(refused('12a')).toMatch(/digits only/)
    expect(refused('-5')).toMatch(/negative/)
    expect(refused('1,25,0')).toMatch(/Could not read/)
    expect(refused('1250.123')).toMatch(/Could not read/) // three decimals after four digits is not an amount
    expect(refused('1..250')).toMatch(/Could not read/)
    expect(refused('.')).toMatch(/Could not read|Type an amount/)
    expect(refused('1.250,5.0')).toMatch(/Could not read/)
  })

  it('refuses an amount too large to be real (a glued number such as 200010001000)', () => {
    expect(refused('200010001000')).toMatch(/not accepted/)
    expect(refused('1,000,001')).toMatch(/not accepted/)
    expect(ok('1,000,000').value).toBe(1000000)
  })
})

describe('formatting', () => {
  it('formats with thousands separators and never invents a currency', () => {
    expect(formatNumber(1250)).toBe('1,250')
    expect(formatNumber(1250.5)).toBe('1,250.50')
    expect(formatAmount(1250, '$')).toBe('$1,250')
    expect(formatAmount(1250, '')).toBe('1,250')
    expect(formatAmount(0, '€')).toBe('€0')
  })
})
