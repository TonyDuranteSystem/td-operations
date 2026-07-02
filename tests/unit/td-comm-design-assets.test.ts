import { describe, it, expect } from 'vitest'
import { validateDesignAsset, DESIGN_ASSET_MAX_BYTES } from '@/lib/td-communication/design-assets'
import { isDesignAssetType } from '@/lib/td-communication/deliverables'

describe('isDesignAssetType', () => {
  it('accepts only the two tool types', () => {
    expect(isDesignAssetType('mockup')).toBe(true)
    expect(isDesignAssetType('asset_kit')).toBe(true)
    expect(isDesignAssetType('logo_draft')).toBe(false)
    expect(isDesignAssetType('other')).toBe(false)
    expect(isDesignAssetType(null)).toBe(false)
  })
})

describe('validateDesignAsset', () => {
  it('accepts a mockup PNG and an asset_kit ZIP', () => {
    expect(validateDesignAsset('card.png', 1000, 'mockup')).toBeNull()
    expect(validateDesignAsset('kit.zip', 1000, 'asset_kit')).toBeNull()
  })
  it('rejects an unknown type', () => {
    expect(validateDesignAsset('card.png', 1000, 'logo_draft')).toMatch(/Invalid design-asset type/)
    expect(validateDesignAsset('card.png', 1000, undefined)).toMatch(/Invalid design-asset type/)
  })
  it('rejects a wrong extension for the type', () => {
    expect(validateDesignAsset('kit.zip', 1000, 'mockup')).toMatch(/mockup must be a PNG/)
    expect(validateDesignAsset('card.png', 1000, 'asset_kit')).toMatch(/asset kit must be a ZIP/)
  })
  it('rejects a disallowed extension entirely', () => {
    expect(validateDesignAsset('logo.svg', 1000, 'mockup')).toMatch(/Only PNG .* and ZIP/)
    expect(validateDesignAsset('noext', 1000, 'mockup')).toMatch(/Only PNG .* and ZIP/)
  })
  it('enforces the size cap', () => {
    expect(validateDesignAsset('kit.zip', DESIGN_ASSET_MAX_BYTES + 1, 'asset_kit')).toMatch(
      /too large/,
    )
  })
})
