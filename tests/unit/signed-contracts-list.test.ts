import { describe, it, expect } from 'vitest'
import { replaceEntry } from '@/lib/signed-contracts/list'
import type { SignedContractEntry } from '@/lib/signed-contracts/types'

const line = (id: string, updatedAt: string): SignedContractEntry => ({ id, updatedAt } as unknown as SignedContractEntry)

describe('replaceEntry — a correction stays in the page list', () => {
  it('swaps only the corrected line and keeps the order', () => {
    const before = [line('a', 'U1'), line('b', 'U1'), line('c', 'U1')]
    const after = replaceEntry(before, line('b', 'U2'))
    expect(after.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(after.map((e) => e.updatedAt)).toEqual(['U1', 'U2', 'U1'])
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })

  it('does not change the list it was given, and ignores a line that is not in it', () => {
    const before = [line('a', 'U1')]
    const after = replaceEntry(before, line('zzz', 'U2'))
    expect(after).toEqual(before)
    expect(after).not.toBe(before)
    expect(before[0].updatedAt).toBe('U1')
  })
})
