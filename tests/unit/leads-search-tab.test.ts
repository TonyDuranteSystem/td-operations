import { describe, it, expect } from 'vitest'
import { tabOfLead, tabFromParam, paramOfTab, decideLiveTarget } from '@/lib/leads/search-tab'

const lead = { status: 'Call Scheduled', existing_client_contact_id: null }
const client = { status: 'Call Scheduled', existing_client_contact_id: 'c1' }
const converted = { status: 'Converted', existing_client_contact_id: 'c2' }

describe('tabOfLead', () => {
  it('follows the Leads page rule: Converted first, then existing client, then leads', () => {
    expect(tabOfLead(lead)).toBe('leads')
    expect(tabOfLead(client)).toBe('clients')
    expect(tabOfLead(converted)).toBe('converted')
    expect(tabOfLead({ status: null, existing_client_contact_id: null })).toBe('leads')
  })
})

describe('tab address value', () => {
  it('reads and writes the client parameter', () => {
    expect(tabFromParam('clients')).toBe('clients')
    expect(tabFromParam('converted')).toBe('converted')
    expect(tabFromParam('')).toBe('leads')
    expect(tabFromParam(null)).toBe('leads')
    expect(tabFromParam('junk')).toBe('leads')
    expect(paramOfTab('leads')).toBe('')
    expect(paramOfTab('clients')).toBe('clients')
  })
})

describe('decideLiveTarget', () => {
  it('moves to the other tab when the current one has no match (the Franzinelli case)', () => {
    const t = decideLiveTarget([client], 'leads')
    expect(t.tab).toBe('clients')
    expect(t.others).toEqual([])
  })
  it('stays on the current tab when it has a match, and lists the other tabs', () => {
    const t = decideLiveTarget([client, lead, lead], 'leads')
    expect(t.tab).toBe('leads')
    expect(t.others).toEqual([{ tab: 'clients', count: 1 }])
  })
  it('stays put when nothing matches', () => {
    expect(decideLiveTarget([], 'clients')).toEqual({ tab: 'clients', others: [] })
  })
  it('goes to the tab of the first match when the current tab has none and several others do', () => {
    const t = decideLiveTarget([converted, client], 'leads')
    expect(t.tab).toBe('converted')
    expect(t.others).toEqual([{ tab: 'clients', count: 1 }])
  })
})
