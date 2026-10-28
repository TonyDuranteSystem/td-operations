/**
 * Dev job e3215801 — THE Storage rule "which document types does this place take", now one pure function shared by the Storage page and the
 * workspace upload box (a workspace upload that ends up in Storage must follow the Storage rule).
 */
import { describe, it, expect } from 'vitest'
import { typesForTarget } from '@/lib/crm-store/types-for-target'

const ALL = [
  { slug: 'passport', personal: true },
  { slug: 'itin_letter', personal: true },
  { slug: 'articles', personal: false },
  { slug: 'other_document', personal: false },
]
const slugs = (r: Array<{ slug: string }>) => r.map((x) => x.slug)

// the rule exactly as the Storage page had it inline before it was shared (the oracle)
const oracle = (all: typeof ALL, ownerKind: string, folderKind: string | null, via: boolean) => {
  const isPerson = ownerKind === 'person' || via
  const contacts = folderKind === 'contacts'
  return all.filter((t) => (via ? t.personal : isPerson ? true : contacts ? t.personal : ownerKind === 'private' ? true : !t.personal))
}

describe('typesForTarget', () => {
  it('a person\'s storage takes every type', () => {
    expect(slugs(typesForTarget(ALL, { ownerKind: 'person' }))).toEqual(['passport', 'itin_letter', 'articles', 'other_document'])
    expect(slugs(typesForTarget(ALL, { ownerKind: 'person', folderKind: 'itin' }))).toHaveLength(4)
  })
  it('a company storage takes only company types (not a person\'s papers)', () => {
    expect(slugs(typesForTarget(ALL, { ownerKind: 'company', folderKind: 'company' }))).toEqual(['articles', 'other_document'])
  })
  it('a company\'s "2. Contacts" folder, and a person\'s folder opened via a company, take only personal types', () => {
    expect(slugs(typesForTarget(ALL, { ownerKind: 'company', folderKind: 'contacts' }))).toEqual(['passport', 'itin_letter'])
    expect(slugs(typesForTarget(ALL, { ownerKind: 'company', viaCompany: true }))).toEqual(['passport', 'itin_letter'])
    expect(slugs(typesForTarget(ALL, { ownerKind: 'person', viaCompany: true }))).toEqual(['passport', 'itin_letter'])
  })
  it('a staff member\'s private My files takes every type', () => {
    expect(slugs(typesForTarget(ALL, { ownerKind: 'private' }))).toHaveLength(4)
  })
  it('an unknown or missing list is empty, never a crash', () => {
    expect(typesForTarget(null, { ownerKind: 'person' })).toEqual([])
    expect(typesForTarget(undefined, { ownerKind: 'company' })).toEqual([])
  })
  it('gives exactly the answer the Storage page gave before it was shared — for every combination', () => {
    for (const ownerKind of ['person', 'company', 'private', 'business', 'formation']) {
      for (const folderKind of [null, 'contacts', 'itin', 'company', 'personal']) {
        for (const viaCompany of [false, true]) {
          expect(slugs(typesForTarget(ALL, { ownerKind, folderKind, viaCompany })), `${ownerKind}/${folderKind}/${viaCompany}`)
            .toEqual(slugs(oracle(ALL, ownerKind, folderKind, viaCompany)))
        }
      }
    }
  })
})
