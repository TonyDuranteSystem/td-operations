import { describe, it, expect } from 'vitest'
import { mediaCaption } from '@/lib/messaging/media-caption'

describe('mediaCaption (the words under a photo or video)', () => {
  it('returns what the person typed', () => {
    expect(mediaCaption("it seems they can't send the OTP")).toBe("it seems they can't send the OTP")
    expect(mediaCaption('  two\nlines  ')).toBe('two\nlines')
  })
  it('gives nothing when there is no caption: empty or null', () => {
    expect(mediaCaption(null)).toBeNull()
    expect(mediaCaption(undefined)).toBeNull()
    expect(mediaCaption('   ')).toBeNull()
  })
  it('does not show the stand-in texts the system saves for a captionless file', () => {
    for (const p of ['[Photo]', '[Image]', '[Video]', '[Sticker]', '[Voice note]', '[Audio]', '[Document]', '[Document: 5472 FY24.pdf]', '[photo]']) {
      expect(mediaCaption(p)).toBeNull()
    }
  })
  it('still shows a real caption that merely contains brackets', () => {
    expect(mediaCaption('[urgent] please read')).toBe('[urgent] please read')
    expect(mediaCaption('see [Photo] above')).toBe('see [Photo] above')
  })
})
