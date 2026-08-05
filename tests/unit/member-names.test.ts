/**
 * One definition of "who is a member", for categorisation.
 *
 * Member names decide owner draws, and they are matched against free bank text
 * — so what qualifies as a name is safety-critical in BOTH directions:
 *
 *  - too permissive and a name blanket-matches merchants. The extreme case is
 *    real: ten linked contact records across six companies WITH bank data carry
 *    no name at all, and `"anything".includes("")` is true in JavaScript, so one
 *    of those in the roster books every row of the year as owner equity and the
 *    P&L reads zero income, zero expenses;
 *  - too strict, or matched too literally, and a member is MISSED — their draw
 *    is silently deducted as a business cost, which is the direction nobody
 *    notices until the return is filed.
 *
 * The rule was also first added to the categorisation engine ONLY, leaving the
 * portal ingest path with its own build. Two paths with two definitions is an
 * OSCILLATION once a periodic re-sort exists: ingest books a member's payments
 * as draws, the sweep disagrees and rewrites them, the next upload books them
 * back — the client's capital accounts move every time either path runs. Hence
 * one module, and these tests.
 */

import { describe, it, expect } from 'vitest'
import {
  buildMemberNames, filterMemberNames, isUsableMemberName, dedupeMemberNames,
  matchMemberName, findNearMissMember, normalizeForMatch, nameParts, payeePart, looksLikeCompany,
  MIN_NAME_PART_LENGTH, MIN_NAME_PARTS, MIN_SURNAME_LENGTH, MIN_FULL_NAME_LENGTH,
  findNearMissMembers, suspectedMembersFromNotes, ASK_CLIENT_NOTE, SUSPECTED_SEP,
} from '@/lib/tax/member-names'

describe('isUsableMemberName — the single predicate', () => {
  it('accepts a real full name', () => {
    expect(isUsableMemberName('Lucia Terracciano')).toBe(true)
    expect(isUsableMemberName('Antonio Pezzella')).toBe(true)
    expect(isUsableMemberName('Inmaculada Concepcion Sanchez Rocamora')).toBe(true)
  })

  /**
   * THE PRODUCTION CASE. Both first and last name NULL on ten linked contacts
   * (Aumianna, Economicamente, Nexo Agency, PAMAG ×3, VSV210, Zhang Holding).
   * An empty string matches EVERY transaction. This is the assertion that
   * stands between that data and a wiped-out P&L.
   */
  it('rejects the empty name that would match every transaction', () => {
    for (const n of ['', '   ', null, undefined, '\t\n']) {
      expect(isUsableMemberName(n)).toBe(false)
    }
  })

  it('rejects a single word — a first name alone is not an identification', () => {
    // "Marco" would match "Marco Polo Trading Ltd"; "Alessandro" is long but
    // still just as ambiguous, which is why a character count was the wrong bar.
    for (const n of ['Marco', 'Alessandro', 'Ada', 'Rossi']) {
      expect(isUsableMemberName(n)).toBe(false)
    }
  })

  it('rejects a name whose parts are too short to identify', () => {
    expect(isUsableMemberName('Li Wu')).toBe(false)
    expect(isUsableMemberName('A B')).toBe(false)
    expect(isUsableMemberName('a b c')).toBe(false)
  })

  /**
   * REGRESSION. The first cut required EVERY part to be substantial, which
   * silently dropped company members — their names are full of initials. A
   * dropped company member turns their distribution into a deducted expense,
   * the direction nobody notices.
   */
  it('keeps initials-heavy company members', () => {
    expect(isUsableMemberName('F.INVEST Holding LLC')).toBe(true)
    expect(isUsableMemberName('B&P International LLC')).toBe(true)
  })

  it('ignores surrounding whitespace and punctuation when measuring', () => {
    expect(isUsableMemberName('  Maria Rossi  ')).toBe(true)
    expect(isUsableMemberName('Rossi, Maria')).toBe(true)
  })

  it('holds the documented thresholds', () => {
    expect(MIN_NAME_PARTS).toBe(2)
    expect(MIN_NAME_PART_LENGTH).toBe(3)
    expect(MIN_FULL_NAME_LENGTH).toBe(5)
    expect(MIN_SURNAME_LENGTH).toBe(4)
  })
})

describe('normalizeForMatch — accents and case are part of the definition', () => {
  it('folds accents and case so the bank and the CRM agree', () => {
    expect(normalizeForMatch('Josè Muñoz')).toBe('jose munoz')
    expect(normalizeForMatch('JOSE MUNOZ')).toBe('jose munoz')
    expect(normalizeForMatch('Nicolò Patti')).toBe('nicolo patti')
  })

  it('reduces punctuation to separators and collapses whitespace', () => {
    expect(normalizeForMatch('ROSSI/MARIO')).toBe('rossi mario')
    expect(normalizeForMatch('  Maria   Rossi ')).toBe('maria rossi')
  })

  it('nameParts drops empties rather than producing phantom parts', () => {
    expect(nameParts('  ')).toEqual([])
    expect(nameParts('Maria  Rossi')).toEqual(['maria', 'rossi'])
  })
})

describe('matchMemberName — finding a member in bank text', () => {
  const members = ['Josè Muñoz', 'Lucia Terracciano']

  it('matches across accent and case differences (the missed-member direction)', () => {
    expect(matchMemberName('Sent money to JOSE MUNOZ', members)).toBe('Josè Muñoz')
    expect(matchMemberName('bonifico a josè muñoz', members)).toBe('Josè Muñoz')
  })

  it('matches on whole words only — a name cannot hide inside a longer word', () => {
    expect(matchMemberName('CANADA ROSSIGNOL SARL', ['Ada Rossi'])).toBeNull()
    expect(matchMemberName('payment to Ada Rossi', ['Ada Rossi'])).toBe('Ada Rossi')
  })

  it('returns null on empty text and never matches an empty name', () => {
    expect(matchMemberName('', members)).toBeNull()
    expect(matchMemberName('any vendor at all', [''])).toBeNull()
  })

  it('the empty-name blanket match is impossible even if one reaches the matcher', () => {
    // Defence in depth: the roster filter should already have removed it.
    expect(matchMemberName('Stripe payout', ['', '   '])).toBeNull()
  })
})

describe('findNearMissMember — ask the client instead of guessing', () => {
  const titan = ['Gabriele Finelli', 'Matthew Finelli']

  it('flags a surname-only payee as uncertain', () => {
    expect(findNearMissMember('Sent money to M. Finelli', titan)).not.toBeNull()
  })

  it('is NOT a near miss when the full name is there — that books outright', () => {
    expect(findNearMissMember('Sent money to Matthew Finelli', titan)).toBeNull()
  })

  it('does not fire on an unrelated vendor', () => {
    expect(findNearMissMember('Sent money to Aurora Global Holdings Limited', titan)).toBeNull()
    expect(findNearMissMember('Sent money to TU YANAN', titan)).toBeNull()
  })

  it('only the surname counts — a shared first name is not enough', () => {
    // Otherwise every vendor called Marco becomes a question for the client.
    expect(findNearMissMember('Marco Polo Trading Ltd', ['Marco Gallerani'])).toBeNull()
    expect(findNearMissMember('payment Gallerani', ['Marco Gallerani'])).not.toBeNull()
  })

  it('ignores a surname too short to be distinctive', () => {
    expect(findNearMissMember('ACME LTD via WU', ['Li Wu', 'Jian Wu'])).toBeNull()
  })

  it('matches whole words, so a surname inside another word is not a question', () => {
    expect(findNearMissMember('ROSSIGNOL SPORTS', ['Maria Rossi'])).toBeNull()
  })

  /**
   * REGRESSION, found by replaying production (scripts/qa/replay-member-match).
   * A supplier payment whose INVOICE REFERENCE mentions a member is not a
   * payment to that member — asking the client about it is pure noise.
   */
  it('ignores a member named only in the payment reference', () => {
    expect(findNearMissMember(
      'Sent money to Lope Gómez Ibáñez with reference Marinoni factura 2024-005',
      ['Sofia Marinoni'],
    )).toBeNull()
  })

  it('still fires when the surname is in the payee, before the reference', () => {
    expect(findNearMissMember(
      'WIRE TRANSFER A/C: DEBORAH BERINI WOODHAVEN NY REF: SOFIA&RENATO',
      ['Donato Renato Berini'],
    )).not.toBeNull()
  })
})

describe('payeePart — who was paid, not what for', () => {
  it('cuts the reference tail', () => {
    expect(payeePart('Sent money to Lope Gomez with reference Marinoni factura'))
      .toBe('sent money to lope gomez')
    expect(payeePart('Bonifico a ACME SRL causale Rossi consulenza'))
      .toBe('bonifico a acme srl')
  })

  it('leaves a line with no reference marker intact', () => {
    expect(payeePart('Sent money to Enrico Berini')).toBe('sent money to enrico berini')
  })

  it('does not fire on a marker hiding inside a longer word', () => {
    // "ref" must not cut "Refund".
    expect(payeePart('Refund from Enrico Berini')).toBe('refund from enrico berini')
  })

  it('is empty for empty input', () => {
    expect(payeePart('')).toBe('')
    expect(payeePart(null)).toBe('')
  })

  /**
   * REGRESSION. A marker at position 0 cut the line to nothing, which switched
   * the near-miss check OFF for every description of that shape — a member
   * payment would silently go back to being deducted. With no payee half to
   * read, search the whole line instead.
   */
  it('falls back to the whole line when a marker starts the description', () => {
    expect(payeePart('REF: Berini payment')).toBe('ref berini payment')
    expect(payeePart('Invoice 2024-005 Marinoni')).toBe('invoice 2024 005 marinoni')
  })

  it('so a leading-reference bank format still asks the client', () => {
    expect(findNearMissMember('REF: Berini payment', ['Donato Renato Berini'])).not.toBeNull()
  })
})

/**
 * Non-Latin scripts normalise to the empty string (the accent-stripping keeps
 * only a-z0-9). Verified against production: no such member exists today — the
 * only non-ASCII names are Latin-with-accents ("Nicolò Patti", "Bernát Nimród
 * Blahó"), which fold correctly. This pins the SAFE failure: such a name is
 * rejected outright, never admitted as a blanket matcher.
 */
describe('non-Latin names fail safe', () => {
  it('are rejected rather than becoming an empty blanket match', () => {
    for (const n of ['Пётр Иванов', '张伟', 'Γιώργος Παπαδόπουλος']) {
      expect(isUsableMemberName(n)).toBe(false)
      expect(matchMemberName('any vendor payment at all', [n])).toBeNull()
    }
  })

  it('the real accented members in production DO fold correctly', () => {
    expect(matchMemberName('Sent money to NICOLO PATTI', ['Nicolò Patti'])).toBe('Nicolò Patti')
    expect(matchMemberName('Wire to BERNAT NIMROD BLAHO', ['Bernát Nimród Blahó'])).toBe('Bernát Nimród Blahó')
  })
})

/**
 * A COMPANY member has no surname. Taking the last word of a legal name yields
 * "Limited" / "Holdings" / "GmbH", which would question every UK or German
 * supplier on the books — the exact flood the near-miss check exists to avoid.
 * Verified against production: all 10 company members today end in LLC or LTD
 * (3 letters, already below the surname floor), so this closes the hazard
 * before a member named "… Limited" ever arrives.
 */
describe('company members never produce a near-miss', () => {
  it('recognises a company by its legal tokens', () => {
    for (const n of ['Aurora Global Holdings Limited', 'Indaco LTD', 'estro llc', 'Kira Strategy LLC', 'Something GmbH']) {
      expect(looksLikeCompany(n)).toBe(true)
    }
    for (const n of ['Gabriele Finelli', 'Lucia Terracciano', 'Nicolò Patti']) {
      expect(looksLikeCompany(n)).toBe(false)
    }
  })

  it('does NOT question every supplier sharing a corporate word', () => {
    const roster = ['Aurora Global Holdings Limited']
    expect(findNearMissMember('Sent money to Kingsway Trading Limited', roster)).toBeNull()
    expect(findNearMissMember('Sent money to Berlin Handels GmbH', ['Munich Handels GmbH'])).toBeNull()
  })

  it('but an EXACT company match still books outright', () => {
    expect(matchMemberName('Sent money to Aurora Global Holdings Limited', ['Aurora Global Holdings Limited']))
      .toBe('Aurora Global Holdings Limited')
  })
})

describe('buildMemberNames — from contact rows', () => {
  it('joins first and last, drops the unusable', () => {
    expect(buildMemberNames([
      { first_name: 'Lucia', last_name: 'Terracciano' },
      { first_name: 'Ada', last_name: null },
      { first_name: null, last_name: null },
    ])).toEqual(['Lucia Terracciano'])
  })

  it('survives nulls in the list itself', () => {
    expect(buildMemberNames([null, undefined, { first_name: 'Maria', last_name: 'Rossi' }]))
      .toEqual(['Maria Rossi'])
  })

  it('a first name alone is NOT a member (changed 2026-08-04)', () => {
    expect(buildMemberNames([{ first_name: 'Alessandro', last_name: null }])).toEqual([])
  })
})

describe('filterMemberNames — from already-assembled names', () => {
  it('applies the identical rule to the members list / workspace display_name shape', () => {
    expect(filterMemberNames(['Lucia Terracciano', 'Ada', null, '  ', 'Maria Rossi']))
      .toEqual(['Lucia Terracciano', 'Maria Rossi'])
  })

  it('keeps a company member — its name is what appears on the wire', () => {
    expect(filterMemberNames(['F.INVEST Holding LLC'])).toEqual(['F.INVEST Holding LLC'])
  })
})

describe('dedupeMemberNames — the union must not double-count', () => {
  it('folds names differing only by accent or case', () => {
    expect(dedupeMemberNames(['Josè Muñoz', 'Jose Munoz', 'JOSE MUNOZ'])).toEqual(['Josè Muñoz'])
  })

  it('keeps the first spelling — the curated one, since members come first', () => {
    expect(dedupeMemberNames(['Nicolò Patti', 'Nicolo Patti'])).toEqual(['Nicolò Patti'])
  })

  it('drops blanks outright', () => {
    expect(dedupeMemberNames(['', '   ', 'Maria Rossi'])).toEqual(['Maria Rossi'])
  })
})

// The invariant that actually prevents the flip-flop.
describe('the builders agree', () => {
  it('the same person is a member on BOTH paths, or on neither', () => {
    const cases: Array<{ first_name: string | null; last_name: string | null }> = [
      { first_name: 'Lucia', last_name: 'Terracciano' },
      { first_name: 'Ada', last_name: null },
      { first_name: 'Li', last_name: 'Wu' },
      { first_name: null, last_name: 'Pezzella' },
      { first_name: null, last_name: null },
      { first_name: 'Josè', last_name: 'Muñoz' },
    ]
    for (const c of cases) {
      const viaContacts = buildMemberNames([c])
      const viaDisplayName = filterMemberNames([`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()])
      expect(viaContacts).toEqual(viaDisplayName)
    }
  })
})

/**
 * TWO OWNERS SHARING A SURNAME — Titan's real shape (Gabriele and Matthew
 * Finelli). Returning only the FIRST match meant the card offered one name, so
 * a client whose payment went to the other one had no way to say so: they
 * either credited the wrong partner's K-1 or answered "not an owner". Both
 * wrong. We narrow the field; the client picks.
 */
describe('every matching owner is offered, not just the first', () => {
  const titan = ['Gabriele Finelli', 'Matthew Finelli']

  it('returns BOTH owners for a shared surname', () => {
    expect(findNearMissMembers('Sent money to M. Finelli', titan))
      .toEqual(['Gabriele Finelli', 'Matthew Finelli'])
  })

  it('returns just the one when only one surname matches', () => {
    expect(findNearMissMembers('payment Gallerani', ['Marco Gallerani', 'Gabriele Finelli']))
      .toEqual(['Marco Gallerani'])
  })

  it('returns none on an exact match — that books outright', () => {
    expect(findNearMissMembers('Sent money to Matthew Finelli', titan)).toEqual([])
  })

  it('returns none for an unrelated supplier', () => {
    expect(findNearMissMembers('Sent money to Aurora Global Holdings Limited', titan)).toEqual([])
  })

  it('the note carries every name, and the reader gets them all back', () => {
    const note = `${ASK_CLIENT_NOTE} ${['Gabriele Finelli', 'Matthew Finelli'].join(SUSPECTED_SEP)}`
    expect(suspectedMembersFromNotes(note)).toEqual(['Gabriele Finelli', 'Matthew Finelli'])
    // and the old single-name shape still reads
    expect(suspectedMembersFromNotes(`${ASK_CLIENT_NOTE} Gabriele Finelli`)).toEqual(['Gabriele Finelli'])
  })

  it('an appended related-entity tail never becomes a name', () => {
    expect(suspectedMembersFromNotes(`${ASK_CLIENT_NOTE} Gabriele Finelli | Related entity: Acme FZCO`))
      .toEqual(['Gabriele Finelli'])
  })
})
