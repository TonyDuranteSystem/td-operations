import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The bell / push / digest email of a new client request (lib/operations/decision-request.ts) is in the
 * client's language: an Italian contact gets the Italian body, and the Italian title when the request
 * carries one (options.title_it). Before, it was English for everyone.
 */

let language: string | null = 'English'
const created: Array<Record<string, unknown>> = []
const notifications: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.insert = (row: Record<string, unknown>) => { created.push(row); return c }
      c.single = () => Promise.resolve({ data: { id: 'dr-1' }, error: null })
      c.maybeSingle = () =>
        Promise.resolve({
          data: table === 'service_deliveries' ? { id: 'sd-1', stage: 'X', account_id: 'a-1', contact_id: 'c-1' } : table === 'contacts' ? { language } : null,
          error: null,
        })
      return c
    },
  },
}))
vi.mock('@/lib/portal/notifications', () => ({
  createPortalNotification: (n: Record<string, unknown>) => { notifications.push(n); return Promise.resolve() },
}))

import { createDecisionRequest } from '@/lib/operations/decision-request'

beforeEach(() => {
  language = 'English'
  created.length = 0
  notifications.length = 0
})

const base = {
  service_delivery_id: 'sd-1',
  request_type: 'text_input',
  title: 'New company name needed',
  message: 'Please send us a new name.',
  options: { prompt: 'Name', title_it: 'Serve un nuovo nome per la società' },
  created_by: 'Luca',
}

describe('createDecisionRequest bell wording', () => {
  it('an English contact gets the English title and body', async () => {
    const r = await createDecisionRequest(base)
    expect(r.ok).toBe(true)
    expect(notifications[0]).toMatchObject({
      title: 'New company name needed',
      body: 'You have a new request from Tony Durante LLC — please review and respond.',
      link: '/portal/flows/sd-1',
    })
  })

  it('an Italian contact (free-text "Italiano") gets the Italian body and the Italian title', async () => {
    language = 'Italiano'
    await createDecisionRequest(base)
    expect(notifications[0].title).toBe('Serve un nuovo nome per la società')
    expect(notifications[0].body).toBe('Hai una nuova richiesta da Tony Durante LLC — controlla e rispondi.')
  })

  it('an Italian contact with a request that has no Italian title keeps the English title', async () => {
    language = 'Italian'
    await createDecisionRequest({ ...base, options: { prompt: 'Name' } })
    expect(notifications[0].title).toBe('New company name needed')
    expect(notifications[0].body).toMatch(/^Hai una nuova richiesta/)
  })

  it('the stored request is unchanged (title stays as given)', async () => {
    language = 'Italian'
    await createDecisionRequest(base)
    expect(created[0].title).toBe('New company name needed')
  })

  it('a failing language lookup keeps the English wording and never fails the request', async () => {
    language = null
    const r = await createDecisionRequest(base)
    expect(r.ok).toBe(true)
    expect(notifications[0].body).toMatch(/^You have a new request/)
  })
})
