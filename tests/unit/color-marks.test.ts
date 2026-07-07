import { describe, it, expect } from 'vitest'
import {
  COLOR_MARKS,
  MARK_LABEL_PREFIX,
  markByKey,
  markFromLabelNames,
} from '@/lib/inbox/color-marks'

describe('color-marks', () => {
  it('every mark has a unique key and a Marked/ label name', () => {
    const keys = COLOR_MARKS.map((m) => m.key)
    expect(new Set(keys).size).toBe(COLOR_MARKS.length)
    for (const m of COLOR_MARKS) {
      expect(m.labelName.startsWith(MARK_LABEL_PREFIX)).toBe(true)
      expect(m.hex).toMatch(/^#[0-9a-f]{6}$/i)
      expect(m.gmailColor.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('markByKey resolves known keys and rejects unknown/empty', () => {
    expect(markByKey('red')?.labelName).toBe('Marked/Red')
    expect(markByKey('teal')).toBeNull()
    expect(markByKey(null)).toBeNull()
    expect(markByKey(undefined)).toBeNull()
  })

  it('markFromLabelNames finds the mark among other labels', () => {
    expect(
      markFromLabelNames(['INBOX', 'IMPORTANT', 'Marked/Blue'])?.key
    ).toBe('blue')
    expect(markFromLabelNames(['INBOX', 'Newsletter'])).toBeNull()
    expect(markFromLabelNames([])).toBeNull()
  })

  it('markFromLabelNames is deterministic when multiple marks exist (COLOR_MARKS order)', () => {
    expect(
      markFromLabelNames(['Marked/Purple', 'Marked/Red'])?.key
    ).toBe('red')
  })
})
