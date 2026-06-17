import { describe, it, expect } from 'vitest'
import { selectSettingsBank } from '@/lib/invoice-auto-send'

const banks = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Mercury', currency: 'USD', bank_name: 'Mercury', account_number: '1', routing_number: '2', iban: '', swift: '', active: true },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Airwallex', currency: 'EUR', bank_name: 'Airwallex', account_number: '', routing_number: '', iban: 'IE00', swift: 'AWXX', active: true },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Old Relay', currency: 'USD', bank_name: 'Relay', account_number: '9', routing_number: '8', iban: '', swift: '', active: false },
]

describe('selectSettingsBank', () => {
  it('resolves settings_bank:<id> to the bank with that id (stable across order)', () => {
    expect(selectSettingsBank('settings_bank:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', banks)?.name).toBe('Airwallex')
    // Even if the array order changes, the id still maps to the same bank.
    expect(selectSettingsBank('settings_bank:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [...banks].reverse())?.name).toBe('Airwallex')
  })

  it('returns the matched bank even if inactive (caller decides on active)', () => {
    expect(selectSettingsBank('settings_bank:cccccccc-cccc-4ccc-8ccc-cccccccccccc', banks)?.active).toBe(false)
  })

  it('returns null for an unknown id', () => {
    expect(selectSettingsBank('settings_bank:00000000-0000-4000-8000-000000000000', banks)).toBeNull()
    expect(selectSettingsBank('settings_bank:', banks)).toBeNull()
  })

  it('supports the legacy positional settings_bank_N fallback', () => {
    expect(selectSettingsBank('settings_bank_0', banks)?.name).toBe('Mercury')
    expect(selectSettingsBank('settings_bank_99', banks)).toBeNull()
  })

  it('returns null for legacy named values and empty input (caller handles default)', () => {
    expect(selectSettingsBank('auto', banks)).toBeNull()
    expect(selectSettingsBank('mercury', banks)).toBeNull()
    expect(selectSettingsBank(null, banks)).toBeNull()
    expect(selectSettingsBank(undefined, banks)).toBeNull()
  })
})
