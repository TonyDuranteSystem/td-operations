import { describe, it, expect } from 'vitest'
import { resolveDropPreset } from '@/lib/crm-store/drop-preset'

const base = { allowedTypeSlugs: ['itin_letter', 'passport', 'other_document'], defaultType: 'other_document', folderIsContacts: false, fileCount: 1 }

describe('resolveDropPreset', () => {
  it('carries the panel type into the window', () => {
    expect(resolveDropPreset({ type: 'itin_letter' }, base).type).toBe('itin_letter')
  })
  it('falls back to the folder default when nothing was picked', () => {
    expect(resolveDropPreset(undefined, base).type).toBe('other_document')
    expect(resolveDropPreset({ type: '' }, base).type).toBe('other_document')
  })
  it('ignores "Custom…" and a type this folder does not take', () => {
    expect(resolveDropPreset({ type: '__custom__' }, base).type).toBe('other_document')
    expect(resolveDropPreset({ type: 'tax_return' }, base).type).toBe('other_document')
  })
  it('carries the person only into a "2. Contacts" folder', () => {
    expect(resolveDropPreset({ person: 'c1' }, { ...base, folderIsContacts: true }).person).toBe('c1')
    expect(resolveDropPreset({ person: 'c1' }, base).person).toBe('')
  })
  it('carries the shown name only for a single file', () => {
    expect(resolveDropPreset({ name: 'ITIN Adam' }, base).name).toBe('ITIN Adam')
    expect(resolveDropPreset({ name: 'ITIN Adam' }, { ...base, fileCount: 3 }).name).toBe('')
  })
  it('trims whitespace', () => {
    expect(resolveDropPreset({ type: ' itin_letter ', name: '  X  ' }, base)).toEqual({ type: 'itin_letter', person: '', name: 'X' })
  })
})
