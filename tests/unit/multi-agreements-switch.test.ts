import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAppSetting = vi.fn()
vi.mock('@/lib/settings', () => ({ getAppSetting: (...a: unknown[]) => getAppSetting(...a) }))

import { multiAgreementsEnabled, MULTI_AGREEMENTS_KEY } from '@/lib/offers/multi-agreements-switch'

beforeEach(() => { getAppSetting.mockReset() })

describe('multiAgreementsEnabled — OFF by default, fails closed', () => {
  it('reads the documented key with a default of false', async () => {
    getAppSetting.mockResolvedValue(false)
    await multiAgreementsEnabled()
    expect(getAppSetting).toHaveBeenCalledWith(MULTI_AGREEMENTS_KEY, false)
    expect(MULTI_AGREEMENTS_KEY).toBe('short_contract_multi_agreements')
  })
  it('only an explicit true turns it on', async () => {
    for (const [v, want] of [[true, true], [false, false], [null, false], ['true', false], [1, false], [undefined, false]] as const) {
      getAppSetting.mockResolvedValue(v)
      expect(await multiAgreementsEnabled(), String(v)).toBe(want)
    }
  })
  it('a failed read means OFF', async () => {
    getAppSetting.mockImplementation(async () => { throw new Error('db down') })
    expect(await multiAgreementsEnabled()).toBe(false)
  })
  it('a staff preview is always ON and does not even read the setting', async () => {
    getAppSetting.mockResolvedValue(false)
    expect(await multiAgreementsEnabled({ staffPreview: true })).toBe(true)
    expect(getAppSetting).not.toHaveBeenCalled()
  })
})
