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
  candidatesFromNote, confirmedMemberFromNote, matchMemberForTransaction,
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
 * REGRESSION (2026-09-03) — Fast Consulting LLC / MushBrew LLC / THW Global
 * LLC. Real Relay corporate-card descriptions name the CARD HOLDER, not the
 * payee, while counterparty already correctly names the real vendor. Strings
 * below are the actual production text (company names changed where they
 * were the client's own vendor, kept verbatim where they matter to the shape).
 */
describe('matchMemberForTransaction — counterparty raw, description through payeePart', () => {
  const fastConsulting = ['Donato Ciardo', 'Cristian Ciardo']

  it('a real vendor in counterparty wins even though the card holder is named in the description ("Spend")', () => {
    expect(matchMemberForTransaction(
      'FBC Consulting & Services | Spend | business service - Sent By Donato Ciardo',
      'FBC Consulting & Services',
      fastConsulting,
    )).toBeNull()
    expect(matchMemberForTransaction(
      'Airbnb | Spend | Donato Ciardo - 5221 (Spese)',
      'Airbnb',
      fastConsulting,
    )).toBeNull()
    expect(matchMemberForTransaction(
      "ARANYKEHELY PATIKA | Spend | Peter Czegle - 0677 (CP's card)",
      'ARANYKEHELY PATIKA',
      ['Peter Czegle', 'Balint Gulyas'],
    )).toBeNull()
  })

  it('the same holds for a "Receive" line (a refund/credit back to the card)', () => {
    expect(matchMemberForTransaction(
      "OBI | Receive | Balint Gulyas - 3855 (GB's card)",
      'OBI',
      ['Peter Czegle', 'Balint Gulyas'],
    )).toBeNull()
  })

  it('a training course product NAMED AFTER the owner is not a payment to the owner', () => {
    // Estro LLC: "corso Giulia Fiorenza" is the course's brand name, not the payee.
    expect(matchMemberForTransaction(
      'Ricevuto denaro da ILACQUA CARMELO con causale Saldo quinta rata percorso Giulia Fiorenza',
      'ILACQUA CARMELO',
      ['Giulia Fiorenza'],
    )).toBeNull()
  })

  it('a wire genuinely made out to the member still fires — counterparty is checked RAW (Dynamiq preserved)', () => {
    expect(matchMemberForTransaction('Wire transfer', 'Donato Renato Berini', ['Donato Renato Berini'])).toBe('Donato Renato Berini')
  })

  it('a blank counterparty still falls back to the description (Dynamiq preserved)', () => {
    expect(matchMemberForTransaction(
      'ONLINE DOMESTIC WIRE TRANSFER VIA: COMMUNITY FSB/026073150 A/C: ANDREA BOSCO MONTE DA CAPARICA PT',
      '',
      ['Andrea Bosco'],
    )).toBe('Andrea Bosco')
    expect(matchMemberForTransaction('Peter Czegle', '', ['Peter Czegle'])).toBe('Peter Czegle')
  })

  it('a supplier invoice reference mentioning a member by coincidence is not a payment to them', () => {
    expect(matchMemberForTransaction(
      'Sent money to Lope Gómez Ibáñez with reference Marinoni factura 2024-005',
      'Lope Gómez Ibáñez',
      ['Sofia Marinoni'],
    )).toBeNull()
  })

  /**
   * REGRESSION (2026-09-03, bug-hunter finding, second round). The FIRST
   * version of this fix added bare words "spend"/"receive" to the general
   * REFERENCE_MARKERS list. "Causale"/"concepto"/"motivo" are technical
   * reference-field labels nobody types in a sentence — "spend" and "receive"
   * are ordinary English verbs, and TD's client base writes wire memos in
   * plain, often non-native English. A genuine inflow/outflow with no
   * counterparty to fall back on would have had its payee cut away by the
   * bare word, silently missing a real member payment — the exact 2026-07-07
   * Dynamiq failure this whole mechanism exists to prevent. The fix now
   * matches Relay's LITERAL pipe-bounded structure, never a bare word.
   */
  it('an ordinary sentence using "spend"/"receive" as a plain verb still finds the member (no counterparty to fall back on)', () => {
    expect(matchMemberForTransaction('To receive urgent funds from Marco Rossi', '', ['Marco Rossi'])).toBe('Marco Rossi')
    expect(matchMemberForTransaction('Approved to spend by Marco Rossi for personal use', '', ['Marco Rossi'])).toBe('Marco Rossi')
  })

  it('a vendor whose own name starts with "Spend"/"Receive" keeps its name — the cut anchors on the pipe-bounded label, not the bare word', () => {
    expect(matchMemberForTransaction(
      'Spend Club | Spend | monthly fee - Sent By Donato Ciardo',
      'Spend Club',
      ['Donato Ciardo'],
    )).toBeNull() // still correctly excluded — "Spend Club" is the vendor, not a member
    expect(payeePart('Spend Club | Spend | monthly fee - Sent By Donato Ciardo')).toBe('spend club')
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

/**
 * NAMES THE MATCHER USED TO MISS ENTIRELY — the silent-deduction direction.
 */
describe('name shapes that were being missed', () => {
  it('matches an apostrophe surname the bank stripped', () => {
    // Banks and SWIFT send "MARCO DAMICO" for "Marco D'Amico".
    expect(matchMemberName('Sent money to MARCO DAMICO', ["Marco D'Amico"])).toBe("Marco D'Amico")
    expect(matchMemberName("bonifico a Marco D'Amico", ["Marco D'Amico"])).toBe("Marco D'Amico")
    // and the near-miss twin
    expect(findNearMissMembers('WIRE OUT DAMICO', ["Marco D'Amico"])).toEqual(["Marco D'Amico"])
  })

  it('curly apostrophes normalise the same way', () => {
    expect(matchMemberName('Sent money to MARCO DAMICO', ['Marco D’Amico'])).toBe('Marco D’Amico')
  })

  /**
   * A two-letter legal suffix is also a real name particle — "João Sá
   * Ferreira", "Maria Sa Silva". Treating those as companies switched the owner
   * question OFF for a real person and deducted their draws in silence.
   */
  it('does not mistake a short name particle for a company', () => {
    expect(looksLikeCompany('João Sá Ferreira')).toBe(false)
    expect(looksLikeCompany('Maria Sa Silva')).toBe(false)
    expect(findNearMissMembers('WIRE OUT FERREIRA', ['João Sá Ferreira'])).toEqual(['João Sá Ferreira'])
  })

  it('still recognises company members, including non-US forms', () => {
    for (const n of ['Nexo Agency LLC', 'Indaco LTD', 'Something GmbH', 'Foo Technologies', 'Bar Media', 'Baz SL']) {
      expect(looksLikeCompany(n)).toBe(true)
    }
  })
})

/**
 * THE CANDIDATE BREADCRUMB. Answering "Yes — Gabriele" consumes the mark on
 * rows flagged for BOTH brothers, so without remembering who else was in the
 * running, the change buttons could only offer "a supplier" — a client who
 * mis-tapped had no way to say it was Matthew, in the exact shared-surname
 * case the card exists for.
 */
describe('candidatesFromNote — the answer remembers who was in the running', () => {
  it('round-trips the candidate list through an answered note', () => {
    const note = 'manual: client answer (owner_draw) | Member: Gabriele Finelli | Of: Gabriele Finelli; Matthew Finelli'
    expect(candidatesFromNote(note)).toEqual(['Gabriele Finelli', 'Matthew Finelli'])
    // and the confirmed-member reader is NOT confused by the trailer
    expect(confirmedMemberFromNote(note)).toBe('Gabriele Finelli')
  })

  it('is empty on notes without the breadcrumb', () => {
    expect(candidatesFromNote('manual: client answer (owner_draw) | Member: Gabriele Finelli')).toEqual([])
    expect(candidatesFromNote('ask: possible payment to member Gabriele Finelli')).toEqual([])
    expect(candidatesFromNote('')).toEqual([])
  })
})

/**
 * THE DETERMINISTIC PARSER'S BARE NOTE. bank-statement-parser.ts writes
 * `Member: ${matched}` (no leading pipe) when a payee/description exactly
 * matches a declared member's full name — a real, common auto-attribution the
 * client never explicitly answered. Before 2026-08-23 this shape matched
 * neither confirmedMemberFromNote nor suspectedMembersFromNotes, so a row it
 * auto-booked as a distribution/contribution was invisible to both exclusion
 * sets a generic merchant chip is checked against — one click could silently
 * flip it to a plain expense with no warning (bug-hunter finding).
 */
describe('confirmedMemberFromNote — recognises the deterministic parser note too', () => {
  it('reads the bare "Member: X" shape the parser writes, no pipe', () => {
    expect(confirmedMemberFromNote('Member: Gabriele Finelli')).toBe('Gabriele Finelli')
  })

  it('still reads the client-answer "| Member: X" shape unchanged', () => {
    expect(confirmedMemberFromNote('manual: client answer (owner_draw) | Member: Gabriele Finelli')).toBe('Gabriele Finelli')
  })

  it('does not treat an open owner-question mark as confirmed', () => {
    expect(confirmedMemberFromNote('ask: possible payment to member Gabriele Finelli')).toBeNull()
  })

  it('does not false-positive on unrelated notes, including ones that merely mention a member mid-string', () => {
    expect(confirmedMemberFromNote('manual: client answer (business_expense)')).toBeNull()
    expect(confirmedMemberFromNote('Paid Gabriele Finelli for consulting, not equity')).toBeNull()
    expect(confirmedMemberFromNote(null)).toBeNull()
    expect(confirmedMemberFromNote('')).toBeNull()
  })

  it('is empty, not a blank name, when the bare prefix has nothing after it', () => {
    expect(confirmedMemberFromNote('Member: ')).toBeNull()
  })
})
