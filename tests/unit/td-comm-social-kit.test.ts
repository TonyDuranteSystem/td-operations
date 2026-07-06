import { describe, it, expect } from 'vitest'
import {
  POST_FORMATS,
  POST_TEMPLATES,
  getPostFormat,
  getPostTemplate,
  resolvePostColors,
  FALLBACK_POST_BG,
  wrapText,
  escapeXmlText,
  renderPostSvg,
  postFileName,
  socialKitZipName,
  validateSocialKitZip,
  SOCIAL_KIT_MAX_BYTES,
} from '@/lib/td-communication/social-kit'

describe('social-kit — registry', () => {
  it('exposes post + story formats and all three templates', () => {
    expect(POST_FORMATS.map((f) => f.id)).toEqual(['post', 'story'])
    expect(getPostFormat('post')?.width).toBe(1080)
    expect(getPostFormat('story')?.height).toBe(1920)
    expect(getPostFormat('nope')).toBeUndefined()

    expect(POST_TEMPLATES.map((t) => t.id)).toEqual(['announcement', 'tagline', 'launch'])
    expect(getPostTemplate('tagline')?.usesSubtext).toBe(false)
    expect(getPostTemplate('announcement')?.usesSubtext).toBe(true)
    expect(getPostTemplate('nope')).toBeUndefined()
  })
})

describe('social-kit — resolvePostColors', () => {
  it('uses the first two valid palette colours', () => {
    const c = resolvePostColors(['#123456', '#abcdef', 'garbage'])
    expect(c.bg).toBe('#123456')
    expect(c.accent).toBe('#abcdef')
    expect(['#000000', '#ffffff']).toContain(c.ink)
  })

  it('falls back to a neutral bg on empty/invalid palette', () => {
    expect(resolvePostColors([]).bg).toBe(FALLBACK_POST_BG)
    expect(resolvePostColors(null).bg).toBe(FALLBACK_POST_BG)
    expect(resolvePostColors(['nothex', '', null, undefined]).bg).toBe(FALLBACK_POST_BG)
  })

  it('ink contrasts the background (light bg → dark ink)', () => {
    expect(resolvePostColors(['#ffffff']).ink).toBe('#000000')
    expect(resolvePostColors(['#000000']).ink).toBe('#ffffff')
  })
})

describe('social-kit — wrapText', () => {
  it('returns [] for empty input', () => {
    expect(wrapText('', 20, 3)).toEqual([])
    expect(wrapText('   ', 20, 3)).toEqual([])
  })

  it('wraps into <= maxLines lines around maxChars', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12, 3)
    expect(lines.length).toBeLessThanOrEqual(3)
    // first line stays within a word of the limit
    expect(lines[0].length).toBeLessThanOrEqual(13)
  })

  it('keeps an over-long single word whole', () => {
    expect(wrapText('supercalifragilistic', 8, 2)).toEqual(['supercalifragilistic'])
  })

  it('ellipsises when text overflows the last line', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 6, 2)
    expect(lines.length).toBe(2)
    expect(lines[lines.length - 1]).toContain('…')
  })
})

describe('social-kit — escapeXmlText', () => {
  it('escapes &, <, >', () => {
    expect(escapeXmlText('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;')
  })
})

describe('social-kit — renderPostSvg', () => {
  it('returns a well-formed svg for every template × format', () => {
    for (const t of POST_TEMPLATES) {
      for (const f of POST_FORMATS) {
        const svg = renderPostSvg(t.id, f.id, {
          palette: ['#204080', '#f0c040'],
          logoHref: 'data:image/png;base64,AAAA',
          headline: 'Hello world',
          subtext: 'a subtext line',
        })
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg).toContain(`viewBox="0 0 ${f.width} ${f.height}"`)
        expect(svg).toContain('</svg>')
      }
    }
  })

  it('returns "" for unknown template/format', () => {
    expect(renderPostSvg('nope', 'post', {})).toBe('')
    expect(renderPostSvg('tagline', 'nope', {})).toBe('')
  })

  it('escapes headline text (no raw injection)', () => {
    const svg = renderPostSvg('tagline', 'post', { headline: '</text><script>x</script>' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('escapes the logo href in the image attribute', () => {
    const svg = renderPostSvg('announcement', 'post', { logoHref: 'data:image/png;base64,"><rect/>' })
    expect(svg).not.toContain('base64,"><rect/>')
    expect(svg).toContain('&quot;')
  })

  it('falls back to the template default headline when blank', () => {
    const svg = renderPostSvg('launch', 'post', { headline: '  ' })
    expect(svg).toContain('Coming')
  })

  it('omits the logo image when no href is given', () => {
    const svg = renderPostSvg('tagline', 'post', { logoHref: null })
    expect(svg).not.toContain('<image')
  })
})

describe('social-kit — naming', () => {
  it('builds a posts/ zip path from a slugified brand', () => {
    expect(postFileName('announcement', 'story', 'Acme Studio!')).toBe(
      'posts/acme-studio-announcement-story.png',
    )
  })

  it('falls back to "brand" for an empty name', () => {
    expect(postFileName('tagline', 'post', '')).toBe('posts/brand-tagline-post.png')
    expect(socialKitZipName('')).toBe('brand-social-sharing-kit.zip')
  })

  it('builds the kit zip name', () => {
    expect(socialKitZipName('Uxio Test LLC')).toBe('uxio-test-llc-social-sharing-kit.zip')
  })
})

describe('social-kit — validateSocialKitZip', () => {
  it('accepts a zip under the cap', () => {
    expect(validateSocialKitZip('kit.zip', 1024)).toBeNull()
  })

  it('rejects a non-zip', () => {
    expect(validateSocialKitZip('kit.png', 1024)).toMatch(/ZIP/)
    expect(validateSocialKitZip('kit', 1024)).toMatch(/ZIP/)
  })

  it('rejects an oversized zip', () => {
    expect(validateSocialKitZip('kit.zip', SOCIAL_KIT_MAX_BYTES + 1)).toMatch(/too large/i)
  })
})
