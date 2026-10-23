import { describe, it, expect } from 'vitest'
import { buildDocumentShareMessage, normalizeTopic, resolveTypedTopic, sameShareAudience, topicChoices, DEFAULT_DOCUMENT_TOPIC, type ShareContext, type ShareTarget } from '@/lib/portal/document-share-text'
import { buildShareChatBody, type ShareMessageToSend } from '@/lib/crm-store/document-share-client'

describe('buildDocumentShareMessage', () => {
  it('one file, English and Italian', () => {
    expect(buildDocumentShareMessage('en', ['OA.pdf'])).toBe('A new document has been added to your folder: OA.pdf')
    expect(buildDocumentShareMessage('it', ['OA.pdf'])).toBe('Un nuovo documento è stato aggiunto alla tua cartella: OA.pdf')
  })
  it('several files make ONE message with a list', () => {
    const m = buildDocumentShareMessage('en', ['A.pdf', 'B.pdf', ' '])
    expect(m).toContain('• A.pdf')
    expect(m).toContain('• B.pdf')
    expect(m.split('•').length).toBe(3)
  })
})

describe('topics', () => {
  it('the default topic is Documents', () => expect(DEFAULT_DOCUMENT_TOPIC).toBe('Documents'))
  it('topicChoices puts the default first and drops case-insensitive duplicates', () => {
    expect(topicChoices('Documents', ['ITIN', 'documents', 'Tax 2025'])).toEqual(['Documents', 'ITIN', 'Tax 2025'])
  })
  it('a typed topic that matches an existing one reuses its spelling (no duplicate tab)', () => {
    expect(resolveTypedTopic('  documents ', ['Documents', 'ITIN'])).toBe('Documents')
    expect(resolveTypedTopic('New thing', ['Documents'])).toBe('New thing')
  })
  it('normalizeTopic trims and caps at 100 characters', () => {
    expect(normalizeTopic('  hi ')).toBe('hi')
    expect(normalizeTopic('x'.repeat(150))).toHaveLength(100)
  })
})

describe('buildShareChatBody', () => {
  const company: ShareMessageToSend = {
    target: { key: 'company:a1', kind: 'company', accountId: 'a1', contactId: null, label: 'Acme LLC', closed: false, isDefault: true, topics: [] },
    topic: 'Documents', message: 'hi', addressedToMemberId: null, addressedToCompany: false,
  }
  it('a company send declares company scope and carries no contact id', () => {
    const b = buildShareChatBody(company)
    expect(b).toMatchObject({ account_id: 'a1', sender_context: 'company', topic: 'Documents', message: 'hi' })
    expect(b).not.toHaveProperty('contact_id')
  })
  it('whole-company and per-member labels are never both sent', () => {
    expect(buildShareChatBody({ ...company, addressedToCompany: true })).toMatchObject({ addressed_to_company: true })
    expect(buildShareChatBody({ ...company, addressedToCompany: true })).not.toHaveProperty('addressed_to_member_id')
    expect(buildShareChatBody({ ...company, addressedToMemberId: 'm1' })).toMatchObject({ addressed_to_member_id: 'm1' })
  })
  it('a personal send carries only the contact id, never an account', () => {
    const b = buildShareChatBody({ ...company, target: { ...company.target, key: 'person:c1', kind: 'person', accountId: null, contactId: 'c1' } })
    expect(b).toMatchObject({ contact_id: 'c1', sender_context: 'person' })
    expect(b).not.toHaveProperty('account_id')
  })
})

describe('sameShareAudience (one pop-up for several files)', () => {
  const t = (key: string, isDefault: boolean, closed = false): ShareTarget => ({ key, kind: key.startsWith('company') ? 'company' : 'person', accountId: null, contactId: null, label: key, closed, isDefault, topics: [] })
  const ctx = (targets: ShareTarget[], locale: 'en' | 'it' = 'en'): ShareContext => ({ askable: true, fileName: 'x', locale, defaultTopic: 'Documents', targets })
  it('same choices, same default, same flags → one pop-up is fine', () => {
    expect(sameShareAudience(ctx([t('company:a', true), t('person:c', false)]), ctx([t('person:c', false), t('company:a', true)]))).toBe(true)
  })
  it('a different default company, or a different closed flag, or language → not the same audience', () => {
    expect(sameShareAudience(ctx([t('company:a', true), t('company:b', false)]), ctx([t('company:a', false), t('company:b', true)]))).toBe(false)
    expect(sameShareAudience(ctx([t('company:a', true)]), ctx([t('company:a', true, true)]))).toBe(false)
    expect(sameShareAudience(ctx([t('company:a', true)], 'en'), ctx([t('company:a', true)], 'it'))).toBe(false)
  })
  it('a different number of choices, or any non-askable file → not the same', () => {
    expect(sameShareAudience(ctx([t('company:a', true)]), ctx([t('company:a', true), t('person:c', false)]))).toBe(false)
    expect(sameShareAudience(ctx([t('company:a', true)]), { askable: false, reason: 'personal', fileName: 'p' })).toBe(false)
  })
})
