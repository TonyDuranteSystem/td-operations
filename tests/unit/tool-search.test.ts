/**
 * Finding a tool by describing it in English.
 *
 * THE FIXTURES BELOW ARE MEASURED, NOT IMAGINED. Every phrase in "the seven that returned
 * nothing" was run against the real 216-tool catalog on 2026-07-20 and produced zero hits,
 * which is why the assistant kept telling staff to do things by hand while saying it would
 * like to help. They are the regression suite: if any of them goes empty again, the
 * assistant has silently lost its reach.
 */

import { describe, it, expect } from 'vitest'
import { searchTools, scoreTool, queryTerms, formatToolSearch } from '@/lib/ai-agent/tool-search'

// A faithful slice of the real catalog — names and first lines as they actually are.
const CATALOG = [
  { name: 'conv_log', description: 'Log a conversation with a client. Records channel, topic and summary.' },
  { name: 'conv_search', description: 'Search logged conversations by client or topic.' },
  { name: 'crm_update_record', description: 'Update any CRM record (account, contact, service, payment, task, deal) by UUID.' },
  { name: 'crm_create_task', description: 'Create a new task/ticket with priority, category, assignee.' },
  { name: 'crm_search_accounts', description: 'Search accounts by company name, status or type.' },
  { name: 'portal_invoice_create', description: 'Create an invoice for a client in the portal.' },
  { name: 'drive_upload_file', description: 'Upload a binary file (PDF, image) to Google Drive.' },
  { name: 'gmail_read_thread', description: 'Read a full Gmail conversation thread by id.' },
  { name: 'deadline_update', description: 'Update a compliance deadline: status, filed date, confirmation number.' },
  // Real description, verbatim — it is the tool that actually carries the word "notes",
  // which is why a query about notes has anywhere to land at all.
  { name: 'lead_update', description: "Update a lead's fields (status, notes, offer data, etc.). Use lead_search first to find the ID." },
]

describe('the seven phrases that returned nothing', () => {
  // Measured against the live catalog before the fix. Each MUST now find something.
  const MEASURED_FAILURES = [
    'add note to account',
    'account note',
    'log conversation',
    'note on account',
    'add a note',
    'record conversation',
    'update account notes',
  ]

  for (const phrase of MEASURED_FAILURES) {
    it(`finds something for "${phrase}"`, () => {
      const hits = searchTools(CATALOG, phrase)
      expect(hits.length, `"${phrase}" must not come back empty`).toBeGreaterThan(0)
    })
  }

  it('puts the conversation logger first for "log conversation"', () => {
    // Not just "returns something" — returns the RIGHT thing. The assistant takes the top
    // of the list, so an answer buried at position nine is the same as no answer.
    expect(searchTools(CATALOG, 'log conversation')[0].name).toBe('conv_log')
  })

  it('puts the record updater first for "update account notes"', () => {
    expect(searchTools(CATALOG, 'update account notes')[0].name).toBe('crm_update_record')
  })
})

describe('ranking', () => {
  it('ranks a name match above a description match', () => {
    // "conversation" appears in the Gmail tool's description and in conv_search's name.
    const hits = searchTools(CATALOG, 'conversation')
    expect(hits[0].name.startsWith('conv_')).toBe(true)
  })

  it('scores more matching words higher', () => {
    const both = scoreTool({ name: 'conv_log', description: 'Log a conversation with a client.' }, 'log conversation')
    const one = scoreTool({ name: 'conv_search', description: 'Search logged conversations.' }, 'log conversation')
    expect(both).toBeGreaterThan(one)
  })

  it('is stable — the same query twice gives the same order', () => {
    // The assistant may re-search mid-conversation; a reshuffling list makes it re-decide.
    const a = searchTools(CATALOG, 'account').map((t) => t.name)
    const b = searchTools(CATALOG, 'account').map((t) => t.name)
    expect(a).toEqual(b)
  })

  it('honours an explicit limit', () => {
    expect(searchTools(CATALOG, 'a', 2).length).toBeLessThanOrEqual(2)
  })
})

describe('everything the old search could find, this still finds', () => {
  // The fix must be purely additive — an exact substring was the ONLY thing that worked
  // before, so if any of it regressed we would have traded one blind spot for another.
  const exactHits = ['conv_log', 'invoice', 'drive_upload_file', 'deadline']
  for (const q of exactHits) {
    it(`still finds "${q}"`, () => {
      expect(searchTools(CATALOG, q).length).toBeGreaterThan(0)
    })
  }

  it('ranks an exact name match at the very top', () => {
    expect(searchTools(CATALOG, 'conv_log')[0].name).toBe('conv_log')
  })
})

describe('plurals — the most common near-miss', () => {
  it('a singular query finds a plural word', () => {
    // "note" must reach the tool whose description says "notes".
    expect(searchTools(CATALOG, 'note').some((t) => t.name === 'lead_update')).toBe(true)
  })

  it('a plural query finds a singular word', () => {
    // "invoices" must still find the tool whose description says "invoice".
    expect(searchTools(CATALOG, 'invoices').some((t) => t.name === 'portal_invoice_create')).toBe(true)
  })
})

describe('queryTerms', () => {
  it('drops grammar words but keeps the meaningful verb', () => {
    // "log" is the single most discriminating word in "log a conversation" — dropping
    // verbs as noise would have re-created the original bug in a new form.
    expect(queryTerms('log a conversation for the client')).toEqual(['log', 'conversation', 'client'])
  })

  it('ignores punctuation and casing', () => {
    expect(queryTerms('Add NOTE, to-account!')).toEqual(['add', 'note', 'account'])
  })

  it('returns nothing for a query made only of grammar words', () => {
    expect(queryTerms('to the a of')).toEqual([])
  })
})

describe('when nothing matches', () => {
  it('says so, and shows what it actually searched for', () => {
    // A bare "no tools match" left the assistant concluding the job was impossible.
    // Naming the terms makes rephrasing the obvious next move.
    const out = formatToolSearch(CATALOG, 'xylophone repair schedule')
    expect(out).toContain('No tools match')
    expect(out).toContain('xylophone')
  })

  it('suggests a single key word to retry with', () => {
    expect(formatToolSearch(CATALOG, 'xylophone repair schedule').toLowerCase()).toContain('try')
  })
})
