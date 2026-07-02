import { describe, it, expect } from 'vitest'
import { applySignedUrls } from '@/lib/td-communication/brief-uploads'
import type { BriefUpload } from '@/lib/td-communication/pipeline'

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
