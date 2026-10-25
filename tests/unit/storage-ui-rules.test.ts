import { describe, it, expect } from 'vitest'
import {
  HttpError, sameNameKey, isNetworkFailure, errorText, NETWORK_MESSAGE, isGoneError, fmtSize,
  canShowToClient, cantShowReason, resetFailedToWaiting, hasHiddenPart, idsStillToMark, type ShowRuleFile,
} from '@/components/storage/store-ui-rules'

describe('sameNameKey (matches the server key)', () => {
  it('an iPhone photo is compared as the JPEG the server saves', () => {
    expect(sameNameKey('IMG_0001.HEIC')).toBe(sameNameKey('img_0001.jpg'))
    expect(sameNameKey('IMG_0002.heif')).toBe('img_0002.jpg')
    expect(sameNameKey('photo.bin', 'image/heic')).toBe('photo.bin.jpg')
  })
  it('composed and decomposed accents are the same name', () => {
    const composed = 'Società.pdf'.normalize('NFC')
    const decomposed = 'Società.pdf'.normalize('NFD')
    expect(composed).not.toBe(decomposed)
    expect(sameNameKey(decomposed)).toBe(sameNameKey(composed))
  })
  it('trims and ignores case; a different name stays different', () => {
    expect(sameNameKey('  Invoice.PDF ')).toBe('invoice.pdf')
    expect(sameNameKey('a.pdf')).not.toBe(sameNameKey('b.pdf'))
  })
})

describe('error wording', () => {
  it('a dropped connection becomes one plain sentence', () => {
    expect(errorText(new TypeError('Failed to fetch'), 'x')).toBe(NETWORK_MESSAGE)
    expect(errorText(new TypeError('Load failed'), 'x')).toBe(NETWORK_MESSAGE)
    expect(errorText(new TypeError('NetworkError when attempting to fetch resource.'), 'x')).toBe(NETWORK_MESSAGE)
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true)
  })
  it('the server own message is kept, also when it looks like a network word', () => {
    expect(errorText(new HttpError('The file is too big (12 MB).', 413), 'x')).toBe('The file is too big (12 MB).')
    expect(errorText(new HttpError('Failed to fetch', 502), 'x')).toBe('Failed to fetch')
  })
  it('falls back for a non-error and for an empty message', () => {
    expect(errorText('boom', 'Fallback.')).toBe('Fallback.')
    expect(errorText(new Error(''), 'Fallback.')).toBe('Fallback.')
    expect(errorText(new TypeError('Cannot read properties of undefined'), 'F')).toBe('Cannot read properties of undefined')
  })
  it('isGoneError: only a 404 / "not found" from the server', () => {
    expect(isGoneError(new HttpError('Folder not found.', 404))).toBe(true)
    expect(isGoneError(new HttpError('store browse: folder not found for this owner', 500))).toBe(true)
    expect(isGoneError(new HttpError('Could not read the folder.', 500))).toBe(false)
    expect(isGoneError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isGoneError(new Error('not found'))).toBe(false)
  })
})

describe('fmtSize', () => {
  it('empty is 0 KB, tiny is 1 KB, big is MB', () => {
    expect(fmtSize(0)).toBe('0 KB')
    expect(fmtSize(null)).toBe('')
    expect(fmtSize(10)).toBe('1 KB')
    expect(fmtSize(2048)).toBe('2 KB')
    expect(fmtSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

const base: ShowRuleFile = { staffOnly: false, state: 'live', listed: true, clientVisible: false, filingStatus: null, documentType: 'passport_copy', personal: false, inPersonStorage: false, needsReview: null }

describe('the eye', () => {
  it('a normal typed file can be shown', () => { expect(canShowToClient(base)).toBe(true) })
  it('a Needs review file cannot be shown, and says why', () => {
    const f = { ...base, needsReview: 'Uploaded into a closed company' }
    expect(canShowToClient(f)).toBe(false)
    expect(cantShowReason(f, false)).toMatch(/review/i)
  })
  it('a file already shown can still be hidden even if it needs review', () => {
    expect(canShowToClient({ ...base, clientVisible: true, needsReview: 'x' })).toBe(true)
  })
  it('untyped, draft, staff-only, unlinked stay locked', () => {
    expect(canShowToClient({ ...base, documentType: null })).toBe(false)
    expect(canShowToClient({ ...base, filingStatus: 'draft' })).toBe(false)
    expect(canShowToClient({ ...base, staffOnly: true })).toBe(false)
    expect(canShowToClient({ ...base, listed: false })).toBe(false)
    expect(cantShowReason({ ...base, documentType: null }, false)).toMatch(/document type/)
  })
})

describe('small helpers', () => {
  it('failed drop items go back to waiting; the rest is untouched', () => {
    const out = resetFailedToWaiting([{ status: 'failed', n: 1 }, { status: 'saved', n: 2 }, { status: 'cancelled', n: 3 }])
    expect(out.map((x) => x.status)).toEqual(['waiting', 'saved', 'cancelled'])
  })
  it('hidden folders and files are spotted anywhere in a path', () => {
    expect(hasHiddenPart('proj/.git/config')).toBe(true)
    expect(hasHiddenPart('.DS_Store')).toBe(true)
    expect(hasHiddenPart('proj/src/a.ts')).toBe(false)
    expect(hasHiddenPart('proj/file.name.txt')).toBe(false)
  })
  it('only files without a mark are asked for', () => {
    expect(idsStillToMark(['a', 'b', 'c', 'a'], { a: {} }, new Set(['c']))).toEqual(['b'])
  })
})
