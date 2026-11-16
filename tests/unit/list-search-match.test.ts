import { describe, it, expect } from 'vitest'
import { accountMatchesSearch, contactMatchesSearch } from '@/lib/crm-lists/search-match'
import { classifyIncomingQuery } from '@/lib/crm-lists/search-dropdown'

const ada = { full_name: 'Ada Rossi', email: 'ada@example.com', phone: '+1 (727) 417-0664' }

describe('contactMatchesSearch — the same things the dropdown matches', () => {
  it('an empty search matches everyone', () => {
    expect(contactMatchesSearch('', ada, [])).toBe(true)
    expect(contactMatchesSearch('   ', ada, [])).toBe(true)
  })
  it('matches the name, email or phone, in any case', () => {
    expect(contactMatchesSearch('ROSS', ada, [])).toBe(true)
    expect(contactMatchesSearch('example.com', ada, [])).toBe(true)
    expect(contactMatchesSearch('417-0664', ada, [])).toBe(true)
  })
  it('matches a company the person is linked to', () => {
    expect(contactMatchesSearch('redst', ada, ['Redstone Atlas LLC'])).toBe(true)
    expect(contactMatchesSearch('redst', ada, ['Other LLC'])).toBe(false)
  })
  it('does not match something unrelated', () => {
    expect(contactMatchesSearch('zzz', ada, ['Redstone Atlas LLC'])).toBe(false)
  })
  it('copes with missing fields', () => {
    expect(contactMatchesSearch('ada', { full_name: null, email: null, phone: null }, [])).toBe(false)
    expect(contactMatchesSearch('ada', { full_name: null, email: 'ada@x.com', phone: null }, [])).toBe(true)
  })
  it('treats % and _ as plain characters, not wildcards', () => {
    expect(contactMatchesSearch('%', ada, [])).toBe(false)
    expect(contactMatchesSearch('a_a', ada, [])).toBe(false)
  })
  it('trims what was typed', () => {
    expect(contactMatchesSearch('  ada  ', ada, [])).toBe(true)
  })
})

describe('accountMatchesSearch', () => {
  it('an empty search matches every company', () => {
    expect(accountMatchesSearch('', { company_name: 'Open LLC' }, [])).toBe(true)
  })
  it('matches the company name in any case', () => {
    expect(accountMatchesSearch('OPEN', { company_name: 'Open LLC' }, [])).toBe(true)
  })
  it('matches a person linked to the company', () => {
    expect(accountMatchesSearch('lahm', { company_name: 'Redstone Atlas LLC' }, ['Hamza Lahmar'])).toBe(true)
    expect(accountMatchesSearch('lahm', { company_name: 'Redstone Atlas LLC' }, ['Ada Rossi'])).toBe(false)
  })
  it('copes with a missing name', () => {
    expect(accountMatchesSearch('x', { company_name: null }, [])).toBe(false)
  })
})

describe('classifyIncomingQuery — a slow reply must not erase what was typed since', () => {
  const sent = new Set(['a', 'ab', 'abc'])
  it('the latest value arriving is settled', () => {
    expect(classifyIncomingQuery('abc', 'abc', sent)).toBe('settled')
  })
  it('an older value we sent ourselves is a stale echo', () => {
    expect(classifyIncomingQuery('ab', 'abc', sent)).toBe('stale-echo')
    expect(classifyIncomingQuery('', 'abc', new Set(['', 'a', 'abc']))).toBe('stale-echo')
  })
  it('a value we never sent (Back button, a link) is external', () => {
    expect(classifyIncomingQuery('zzz', 'abc', sent)).toBe('external')
  })
})
