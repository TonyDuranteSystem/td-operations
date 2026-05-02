import { describe, it, expect } from 'vitest'
import {
  findFeedsForAccount,
  findPlaidMercuryDuplicates,
  type CascadeAccount,
  type CascadeContact,
  type CascadeInvoice,
  type CascadeFeed,
} from '@/lib/audit/bank-feed-cascade'

const ACCOUNT: CascadeAccount = {
  id: 'acct-1',
  company_name: 'Acme Marketing LLC',
}

const CONTACTS: CascadeContact[] = [
  { id: 'c-1', full_name: 'Adriano Graziosi', email: 'adrianograziosi7@gmail.com' },
  { id: 'c-2', full_name: 'Maria Bianchi', email: null },
]

const INVOICES: CascadeInvoice[] = [
  { invoice_number: 'INV-001311' },
  { invoice_number: 'INV-001305' },
]

function feed(overrides: Partial<CascadeFeed>): CascadeFeed {
  return {
    id: 'f-' + Math.random().toString(36).slice(2, 8),
    source: 'stripe',
    transaction_date: '2026-04-23',
    amount: 250,
    currency: 'USD',
    sender_name: null,
    sender_reference: null,
    memo: null,
    status: 'unmatched',
    matched_payment_id: null,
    matched_account_id: null,
    raw_data: null,
    ...overrides,
  }
}

describe('findFeedsForAccount — Tier 1 email match (HIGH)', () => {
  it('matches via stripe metadata.email', () => {
    const f = feed({
      source: 'stripe',
      sender_name: 'Cardholder Name',
      raw_data: { metadata: { email: 'adrianograziosi7@gmail.com', Name: 'Adriano Graziosi' } },
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(1)
    expect(out[0].tier).toBe(1)
    expect(out[0].rule).toBe('email_match')
    expect(out[0].confidence).toBe('high')
    expect(out[0].match_evidence).toBe('adrianograziosi7@gmail.com')
  })

  it('matches via stripe billing_details.email', () => {
    const f = feed({
      raw_data: { billing_details: { email: 'AdrianoGraziosi7@Gmail.com' } },
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(1)
    expect(out[0].match_evidence).toBe('adrianograziosi7@gmail.com')
  })

  it('matches via email embedded in memo text', () => {
    const f = feed({
      memo: 'Tony Durante LLC - PL-00295 | Name: Adriano, email: adrianograziosi7@gmail.com',
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(1)
  })

  it('does not match when email belongs to a different contact', () => {
    const f = feed({
      raw_data: { metadata: { email: 'someone-else@example.com' } },
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })

  it('skips contacts with null email when scanning', () => {
    const f = feed({ raw_data: { metadata: { email: '' } } })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })
})

describe('findFeedsForAccount — Tier 2 invoice reference (HIGH)', () => {
  it('matches INV-001311 in memo', () => {
    const f = feed({
      memo: 'Tony Durante LLC - INV-001311 | Name: Acme',
      sender_name: 'Random Cardholder',
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(2)
    expect(out[0].rule).toBe('reference_match')
    expect(out[0].match_evidence).toBe('INV-001311')
  })

  it('matches INV-001305 with timestamp suffix', () => {
    const f = feed({
      memo: 'Tony Durante LLC - INV-001305-1769537890446',
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(2)
    expect(out[0].match_evidence).toBe('INV-001305')
  })

  it('matches inv1311 (no dash) variant', () => {
    const f = feed({ memo: 'wire payment ref inv1311 thanks' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(2)
  })

  it('matches bare 6-digit padded number (001311)', () => {
    const f = feed({ memo: 'Payment 001311' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(2)
  })

  it('does not match an invoice number from another account', () => {
    const f = feed({ memo: 'INV-999999' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })
})

describe('findFeedsForAccount — Tier 3 company name fuzzy (MEDIUM)', () => {
  it('matches a meaningful token of the company name', () => {
    const f = feed({ sender_name: 'Marketing wire from Acme' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(3)
    expect(out[0].rule).toBe('company_name_match')
    expect(out[0].confidence).toBe('medium')
  })

  it('does not match purely on a stop word like "consulting"', () => {
    const account: CascadeAccount = { id: 'acct-2', company_name: 'X Consulting LLC' }
    const f = feed({ sender_name: 'Some Other Consulting Group' })
    const out = findFeedsForAccount(account, [], [], [f])
    expect(out).toHaveLength(0)
  })

  it('returns no Tier 3 hit when company name has only short/stop tokens', () => {
    const account: CascadeAccount = { id: 'acct-3', company_name: 'AG Group LLC' }
    const f = feed({ sender_name: 'AG payment' })
    const out = findFeedsForAccount(account, [], [], [f])
    expect(out).toHaveLength(0) // 'ag' too short, 'group' is stop word, 'llc' too short
  })
})

describe('findFeedsForAccount — Tier 4 contact name fuzzy (MEDIUM)', () => {
  it('matches contact full_name token in sender_name', () => {
    const f = feed({ sender_name: 'Adriano Graziosi' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(4)
    expect(out[0].rule).toBe('contact_name_match')
  })

  it('matches contact full_name token in stripe metadata.Name', () => {
    const f = feed({
      sender_name: 'Random Cardholder',
      raw_data: { metadata: { Name: 'Adriano Graziosi' } },
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(4)
  })

  it('matches against any of multiple contacts', () => {
    const f = feed({ sender_name: 'Bianchi wire' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(4)
    expect(out[0].match_evidence).toBe('bianchi')
  })

  it('returns no match when neither sender nor metadata contains contact tokens', () => {
    const f = feed({ sender_name: 'Wire transfer' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })
})

describe('findFeedsForAccount — tier ordering', () => {
  it('Tier 1 wins over Tier 2 + 3 + 4', () => {
    const f = feed({
      memo: 'INV-001311 from Adriano Graziosi for Acme Marketing',
      raw_data: { metadata: { email: 'adrianograziosi7@gmail.com' } },
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(1)
  })

  it('Tier 2 wins over Tier 3 + 4', () => {
    const f = feed({
      memo: 'INV-001311 from Adriano Graziosi for Acme Marketing',
    })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(2)
  })

  it('Tier 3 wins over Tier 4', () => {
    const f = feed({ sender_name: 'Acme Marketing wire from Adriano' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(3)
  })
})

describe('findFeedsForAccount — status filtering', () => {
  it('skips status=matched', () => {
    const f = feed({ status: 'matched', sender_name: 'Adriano Graziosi' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })

  it('skips status=ignored', () => {
    const f = feed({ status: 'ignored', sender_name: 'Adriano Graziosi' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })

  it('skips status=outgoing', () => {
    const f = feed({ status: 'outgoing', sender_name: 'Adriano Graziosi' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })

  it('skips status=duplicate', () => {
    const f = feed({ status: 'duplicate', sender_name: 'Adriano Graziosi' })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [f])
    expect(out).toHaveLength(0)
  })
})

describe('findFeedsForAccount — sorting', () => {
  it('orders HIGH-confidence tiers before MEDIUM, then by date desc', () => {
    const tier3 = feed({ id: 't3', sender_name: 'Acme Marketing', transaction_date: '2026-04-30' })
    const tier1 = feed({ id: 't1', raw_data: { metadata: { email: 'adrianograziosi7@gmail.com' } }, transaction_date: '2026-04-01' })
    const tier4_old = feed({ id: 't4-old', sender_name: 'Adriano', transaction_date: '2026-01-01' })
    const tier4_new = feed({ id: 't4-new', sender_name: 'Adriano', transaction_date: '2026-04-15' })

    const out = findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [tier3, tier1, tier4_old, tier4_new])
    expect(out.map(o => o.feed.id)).toEqual(['t1', 't3', 't4-new', 't4-old'])
  })
})

describe('findFeedsForAccount — empty inputs', () => {
  it('handles no feeds', () => {
    expect(findFeedsForAccount(ACCOUNT, CONTACTS, INVOICES, [])).toEqual([])
  })

  it('handles no contacts (Tier 1/4 unavailable)', () => {
    const f = feed({ memo: 'INV-001311' })
    const out = findFeedsForAccount(ACCOUNT, [], INVOICES, [f])
    expect(out[0].tier).toBe(2)
  })

  it('handles no invoices (Tier 2 unavailable)', () => {
    const f = feed({ raw_data: { metadata: { email: 'adrianograziosi7@gmail.com' } } })
    const out = findFeedsForAccount(ACCOUNT, CONTACTS, [], [f])
    expect(out[0].tier).toBe(1)
  })

  it('handles null company_name (Tier 3 unavailable)', () => {
    const account: CascadeAccount = { id: 'acct-x', company_name: null }
    const f = feed({ sender_name: 'Adriano' })
    const out = findFeedsForAccount(account, CONTACTS, INVOICES, [f])
    expect(out[0].tier).toBe(4)
  })
})

describe('findPlaidMercuryDuplicates', () => {
  it('finds a Plaid-Mercury pair with matching date+amount+currency, attribution via cascade', () => {
    const plaid = feed({ id: 'p', source: 'mercury', transaction_date: '2026-04-23', amount: 63, currency: 'USD', sender_name: 'Adriano Graziosi' })
    const api = feed({ id: 'api', source: 'mercury_api', transaction_date: '2026-04-23', amount: 63, currency: 'USD' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid, api])
    expect(out).toHaveLength(1)
    expect(out[0].plaid_feed.id).toBe('p')
    expect(out[0].twin_feed.id).toBe('api')
    expect(out[0].attribution).toBe('cascade')
  })

  it('attributes via matched_account_id when present', () => {
    const plaid = feed({ id: 'p', source: 'mercury', matched_account_id: 'acct-1' })
    const api = feed({ id: 'api', source: 'mercury_api' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, [], [], [plaid, api])
    expect(out[0].attribution).toBe('matched')
  })

  it('does not attribute to a different account', () => {
    const plaid = feed({ id: 'p', source: 'mercury', sender_name: 'Someone Else', matched_account_id: 'other' })
    const api = feed({ id: 'api', source: 'mercury_api', matched_account_id: 'other' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid, api])
    expect(out).toHaveLength(0)
  })

  it('does not return a Plaid mercury feed without an api twin', () => {
    const plaid = feed({ id: 'p', source: 'mercury', sender_name: 'Adriano' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid])
    expect(out).toHaveLength(0)
  })

  it('matches twin only when amount+date+currency all align', () => {
    const plaid = feed({ id: 'p', source: 'mercury', transaction_date: '2026-04-23', amount: 63, currency: 'USD', sender_name: 'Adriano' })
    const apiDifferentDate = feed({ id: 'api', source: 'mercury_api', transaction_date: '2026-04-24', amount: 63, currency: 'USD' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid, apiDifferentDate])
    expect(out).toHaveLength(0)
  })

  it('handles currency case-insensitively', () => {
    const plaid = feed({ source: 'mercury', currency: 'usd', sender_name: 'Adriano' })
    const api = feed({ source: 'mercury_api', currency: 'USD' })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid, api])
    expect(out).toHaveLength(1)
  })

  it('handles amount stored as float by normalizing to 2 decimals', () => {
    const plaid = feed({ source: 'mercury', amount: 63.0, sender_name: 'Adriano' })
    const api = feed({ source: 'mercury_api', amount: 63.00 })
    const out = findPlaidMercuryDuplicates(ACCOUNT, CONTACTS, INVOICES, [plaid, api])
    expect(out).toHaveLength(1)
  })
})
