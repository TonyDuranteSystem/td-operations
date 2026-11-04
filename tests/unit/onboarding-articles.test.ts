/**
 * lib/flows/onboarding-articles.ts — which uploads belong to an onboarding submission, and which of them is the Articles (job 64d2be64).
 */
import { describe, it, expect } from 'vitest'
import { ownedUploadPaths, articlesUploads, mimeTypeFromFileName, pickOcrMimeType } from '@/lib/flows/onboarding-articles'

const sub = { token: 'tok-1', account_id: null, lead_id: 'lead-1', offer_id: 'offer-1', contact_id: 'contact-1' }

describe('ownedUploadPaths', () => {
  it('keeps the paths under the submission\'s own folders and counts the rest as rejected', () => {
    const paths = [
      'onboarding/lead-1/articles_of_organization_a.pdf',
      'onboarding/offer-1/passport_owner_b.pdf',
      'onboarding/contact-1/ein_letter_c.pdf',
      'tok-1/articles_of_organization_d.pdf',
      'onboarding/someone-else/articles_of_organization_e.pdf',
      'other-token/articles_of_organization_f.pdf',
    ]
    const { owned, rejected } = ownedUploadPaths(sub, paths)
    expect(owned).toEqual(paths.slice(0, 4))
    expect(rejected).toBe(2)
  })

  it('uses the account folder only when the submission has an account', () => {
    const paths = ['onboarding/acct-1/articles_of_organization_a.pdf']
    expect(ownedUploadPaths({ ...sub, account_id: null }, paths).owned).toEqual([])
    expect(ownedUploadPaths({ ...sub, account_id: 'acct-1' }, paths).owned).toEqual(paths)
  })

  it('never matches a folder whose id merely starts the same way', () => {
    expect(ownedUploadPaths(sub, ['onboarding/lead-10/articles_of_organization_a.pdf']).owned).toEqual([])
  })

  it('a submission with no token and no ids owns nothing', () => {
    const none = { token: null, account_id: null, lead_id: null, offer_id: null, contact_id: null }
    expect(ownedUploadPaths(none, ['onboarding/x/a.pdf'])).toEqual({ owned: [], rejected: 1 })
  })
})

describe('articlesUploads', () => {
  it('finds the files in the Articles slot by their name, in the order given', () => {
    const paths = [
      'onboarding/lead-1/passport_owner_1_Passport.pdf',
      'onboarding/lead-1/articles_of_organization_abc12345_Articles of Organization - X LLC.pdf',
      'onboarding/lead-1/ein_letter_2_CP575.pdf',
      'onboarding/lead-1/Articles_of_Organization_second.pdf',
    ]
    expect(articlesUploads(paths)).toEqual([paths[1], paths[3]])
  })

  it('a file only NAMED like articles inside another slot is not the Articles slot', () => {
    expect(articlesUploads(['onboarding/lead-1/ein_letter_1_articles_of_organization.pdf'])).toEqual([])
  })

  it('handles the old token-folder layout and an empty list', () => {
    expect(articlesUploads(['onb-hamid-2026/articles_of_organization_IAA.pdf'])).toEqual(['onb-hamid-2026/articles_of_organization_IAA.pdf'])
    expect(articlesUploads([])).toEqual([])
  })
})

describe('mimeTypeFromFileName', () => {
  it('maps the kinds the review screen can show', () => {
    expect(mimeTypeFromFileName('a.PDF')).toBe('application/pdf')
    expect(mimeTypeFromFileName('scan.jpeg')).toBe('image/jpeg')
    expect(mimeTypeFromFileName('scan.png')).toBe('image/png')
  })

  it('is null for an unknown or missing extension', () => {
    expect(mimeTypeFromFileName('notes.docx')).toBeNull()
    expect(mimeTypeFromFileName('noextension')).toBeNull()
  })
})

describe('pickOcrMimeType', () => {
  it('uses the type storage reports when it is a real one', () => {
    expect(pickOcrMimeType('application/pdf', null)).toBe('application/pdf')
    expect(pickOcrMimeType('image/jpeg', 'application/pdf')).toBe('image/jpeg')
  })

  it('a missing or generic type (the wizard stores octet-stream when the browser gave none) falls back to the file name\'s type', () => {
    expect(pickOcrMimeType('application/octet-stream', 'image/png')).toBe('image/png')
    expect(pickOcrMimeType('', 'application/pdf')).toBe('application/pdf')
    expect(pickOcrMimeType(null, 'image/jpeg')).toBe('image/jpeg')
  })

  it('and only then to PDF', () => {
    expect(pickOcrMimeType('application/octet-stream', null)).toBe('application/pdf')
    expect(pickOcrMimeType(undefined, null)).toBe('application/pdf')
  })
})
