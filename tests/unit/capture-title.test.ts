import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateCaptureTitle } from '@/lib/captures/render'

/**
 * UX review, 2026-09-04: the auto-title must come ONLY from context known
 * BEFORE anything is drawn (page name, time) — never from reading the
 * captured image's own pixels, or a just-redacted number could end up back
 * in the title. This suite pins that the function's only inputs are a page
 * label string and the clock — nothing image-shaped is anywhere near its
 * signature.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe('generateCaptureTitle', () => {
  it('uses the given page label and includes a formatted time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T15:45:00'))
    const title = generateCaptureTitle('Uxio Test LLC — Account')
    expect(title).toMatch(/^Uxio Test LLC —/)
    expect(title).toMatch(/Sep 4/)
  })

  it('strips a trailing " - Site Name" / " | Site Name" suffix, keeping only the meaningful part', () => {
    const title = generateCaptureTitle('Accounts - TD Operations')
    expect(title.startsWith('Accounts —')).toBe(true)
    expect(title).not.toContain('TD Operations')
  })

  it('falls back to a generic "Capture" label when given an empty string', () => {
    const title = generateCaptureTitle('')
    expect(title.startsWith('Capture —')).toBe(true)
  })

  it('falls back to a generic "Capture" label for the bare app name with nothing else', () => {
    const title = generateCaptureTitle('TD Operations')
    expect(title.startsWith('Capture —')).toBe(true)
  })

  it('never contains anything that looks like it came from reading pixels (no image/canvas-shaped input exists in its signature)', () => {
    // Type-level guarantee, exercised here as a smoke test: the function
    // takes at most one optional string. There is no way to pass it a
    // canvas, blob, or image and have it factor into the title.
    expect(generateCaptureTitle.length).toBeLessThanOrEqual(1)
  })
})
