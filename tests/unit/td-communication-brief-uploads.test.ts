import { describe, it, expect } from 'vitest'
import { applySignedUrls, isSignableUploadPath } from '@/lib/td-communication/brief-uploads'
import { prettyUploadName, groupBrief, type BriefUpload } from '@/lib/td-communication/pipeline'

const upload = (over: Partial<BriefUpload>): BriefUpload => ({ name: 'logo.png', url: 'path/logo.png', ...over })

describe('applySignedUrls', () => {
  it('swaps each path for its signed URL', () => {
    const uploads = [upload({ url: 'a/1.png', name: '1.png' }), upload({ url: 'a/2.png', name: '2.png' })]
    const map = new Map([
      ['a/1.png', 'https://signed/1'],
      ['a/2.png', 'https://signed/2'],
    ])
    expect(applySignedUrls(uploads, map)).toEqual([
      { name: '1.png', url: 'https://signed/1' },
      { name: '2.png', url: 'https://signed/2' },
    ])
  })

  it('uses "" for a path missing from the map (unsignable → unavailable)', () => {
    const uploads = [upload({ url: 'a/1.png', name: '1.png' }), upload({ url: 'gone/2.png', name: '2.png' })]
    const map = new Map([['a/1.png', 'https://signed/1']])
    const out = applySignedUrls(uploads, map)
    expect(out[0].url).toBe('https://signed/1')
    expect(out[1].url).toBe('')
  })

  it('preserves order and other fields (name, mime_type)', () => {
    const uploads = [upload({ url: 'a/1.pdf', name: 'brief.pdf', mime_type: 'application/pdf' })]
    const out = applySignedUrls(uploads, new Map([['a/1.pdf', 'https://signed/brief']]))
    expect(out[0]).toEqual({ name: 'brief.pdf', url: 'https://signed/brief', mime_type: 'application/pdf' })
  })

  it('returns [] for no uploads', () => {
    expect(applySignedUrls([], new Map())).toEqual([])
  })

  it('empty map → every url becomes "" (e.g. a total signing failure upstream)', () => {
    const uploads = [upload({ url: 'a/1.png' }), upload({ url: 'a/2.png' })]
    expect(applySignedUrls(uploads, new Map()).every((u) => u.url === '')).toBe(true)
  })
})

describe('isSignableUploadPath', () => {
  it('accepts brand-audit upload paths', () => {
    expect(isSignableUploadPath('td_communication/user@x.com/upload_materials_ab12cd34_logo.png')).toBe(true)
    expect(isSignableUploadPath('wizard/user@x.com/upload_materials_ab12cd34_ref.jpg')).toBe(true)
  })

  it("rejects OTHER wizards' uploads in the shared bucket (a td_comm brief must not sign passports/tax docs)", () => {
    expect(isSignableUploadPath('formation/acme/passport_1.pdf')).toBe(false)
    expect(isSignableUploadPath('tax/acme/statement.csv')).toBe(false)
    expect(isSignableUploadPath('itin/acme/passport.pdf')).toBe(false)
  })

  it('rejects arbitrary bucket paths', () => {
    expect(isSignableUploadPath('secrets/passport.pdf')).toBe(false)
    expect(isSignableUploadPath('some-other-folder/file.png')).toBe(false)
  })

  it('rejects path traversal and empties', () => {
    expect(isSignableUploadPath('td_communication/../formation/passport.pdf')).toBe(false)
    expect(isSignableUploadPath('')).toBe(false)
    expect(isSignableUploadPath('   ')).toBe(false)
  })
})

describe('prettyUploadName', () => {
  it('strips the minted {field}_{8hex}_ prefix back to the original filename', () => {
    expect(prettyUploadName('upload_materials_ab12cd34_logo.png')).toBe('logo.png')
    expect(prettyUploadName('current_materials_00ff00aa_brand guide_v2.pdf')).toBe('brand guide_v2.pdf')
  })

  it('keeps an original filename that itself contains an _8hex_ segment', () => {
    // Non-greedy: the FIRST field+unique prefix is stripped, the rest survives.
    expect(prettyUploadName('materials_ab12cd34_ref_deadbeef_x.png')).toBe('ref_deadbeef_x.png')
  })

  it('returns non-matching names unchanged (legacy / external)', () => {
    expect(prettyUploadName('logo.png')).toBe('logo.png')
    expect(prettyUploadName('upload_materials_XYZ_logo.png')).toBe('upload_materials_XYZ_logo.png')
  })

  it('flows through groupBrief: uploads carry the pretty name, url keeps the full path', () => {
    const brief = groupBrief({
      upload_materials: ['td_communication/user@x.com/upload_materials_ab12cd34_logo.png'],
    })
    expect(brief.uploads).toEqual([
      { name: 'logo.png', url: 'td_communication/user@x.com/upload_materials_ab12cd34_logo.png' },
    ])
  })
})
