import { describe, it, expect } from 'vitest'
import { prepareChatFiles, CHAT_ATTACHMENT_MAX_COUNT } from '@/lib/team/attachment'

/** Helper: a non-empty File of a given name/type. */
function file(name: string, type = '', bytes = 'x'): File {
  return new File([bytes], name, { type })
}

describe('prepareChatFiles', () => {
  it('accepts normal document/image/csv files', () => {
    const r = prepareChatFiles(
      [file('a.pdf', 'application/pdf'), file('b.png', 'image/png'), file('c.csv', 'text/csv')],
      0,
    )
    expect(r.accepted.map(f => f.name)).toEqual(['a.pdf', 'b.png', 'c.csv'])
    expect(r.rejected).toEqual([])
    expect(r.overflow).toBe(0)
  })

  it('rejects active-content / executable types by extension', () => {
    const r = prepareChatFiles([file('ok.pdf', 'application/pdf'), file('x.exe'), file('logo.svg', 'image/svg+xml')], 0)
    expect(r.accepted.map(f => f.name)).toEqual(['ok.pdf'])
    expect(r.rejected).toEqual(['x.exe', 'logo.svg'])
  })

  it('rejects empty files / dropped folders (size 0)', () => {
    const empty = new File([], 'folder-or-empty.csv', { type: 'text/csv' })
    const r = prepareChatFiles([empty, file('real.csv', 'text/csv')], 0)
    expect(r.accepted.map(f => f.name)).toEqual(['real.csv'])
    expect(r.rejected).toEqual(['folder-or-empty.csv'])
  })

  it('caps against files already staged and reports overflow', () => {
    // 3 already staged, cap 5 → room 2; 4 incoming → 2 accepted, 2 overflow.
    const r = prepareChatFiles([file('1.png'), file('2.png'), file('3.png'), file('4.png')], 3)
    expect(r.accepted).toHaveLength(2)
    expect(r.overflow).toBe(2)
  })

  it('leaves exactly cap-minus-current room', () => {
    const incoming = [file('1.png'), file('2.png'), file('3.png')]
    const r = prepareChatFiles(incoming, 3) // room = 5 - 3 = 2
    expect(r.accepted).toHaveLength(2)
    expect(r.overflow).toBe(1)
  })

  it('adds nothing and counts all as overflow when already at the cap', () => {
    const r = prepareChatFiles([file('1.png'), file('2.png')], CHAT_ATTACHMENT_MAX_COUNT)
    expect(r.accepted).toEqual([])
    expect(r.overflow).toBe(2)
  })

  it('synthesizes a filename for a nameless pasted blob', () => {
    const blob = new File(['bytes'], '', { type: 'image/png' })
    const r = prepareChatFiles([blob], 0)
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0].name).toMatch(/^pasted-\d+\.png$/)
    expect(r.rejected).toEqual([])
  })

  it('handles an empty batch', () => {
    const r = prepareChatFiles([], 0)
    expect(r).toEqual({ accepted: [], rejected: [], overflow: 0 })
  })
})
