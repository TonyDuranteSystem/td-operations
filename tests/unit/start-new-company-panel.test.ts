/**
 * The "State refused the company name?" panel of the Company Formation workspace (dev job bf9886a3, Antonio 2026-11-17):
 * when it shows and where it sits. Pure rules (lib/flows/start-new-company-panel.ts); the page and the step renderer only use them.
 */
import { describe, it, expect } from 'vitest'
import { ARTICLES_RECEIVED_STAGE, pickReplacementJob, showStartNewCompanyPanel, startNewCompanyPanelSlot } from '@/lib/flows/start-new-company-panel'
import { replacementNote } from '@/lib/operations/start-new-company-rules'

const base = { serviceType: 'Company Formation', status: 'active', accountId: 'acct-1', contactId: 'contact-1', stageOrder: 7, articlesReceivedOrder: 4 }

describe('when the panel shows', () => {
  it('names the step the company is created at', () => {
    expect(ARTICLES_RECEIVED_STAGE).toBe('Articles Received')
  })

  it('shows on an open formation with its company, from Articles Received to the last step', () => {
    for (const stageOrder of [4, 5, 6, 7, 8]) expect(showStartNewCompanyPanel({ ...base, stageOrder })).toBe(true)
  })

  it('does not show before the company exists: the names step handles a refusal there', () => {
    for (const stageOrder of [1, 2, 3]) expect(showStartNewCompanyPanel({ ...base, stageOrder })).toBe(false)
  })

  it('does not show without a company or without the buyer', () => {
    expect(showStartNewCompanyPanel({ ...base, accountId: null })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, accountId: '' })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, contactId: null })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, contactId: undefined })).toBe(false)
  })

  it('does not show on a job that is no longer open (cancelled, completed, on hold)', () => {
    for (const status of ['cancelled', 'completed', 'on_hold', 'blocked', null, undefined]) {
      expect(showStartNewCompanyPanel({ ...base, status })).toBe(false)
    }
  })

  it('does not show on any other service', () => {
    for (const serviceType of ['Company Closure', 'Tax Return', 'ITIN', 'Client Onboarding', null, undefined]) {
      expect(showStartNewCompanyPanel({ ...base, serviceType })).toBe(false)
    }
  })

  it('does not show when either step number is unknown: never guess where a job is', () => {
    expect(showStartNewCompanyPanel({ ...base, stageOrder: null })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, stageOrder: undefined })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, articlesReceivedOrder: null })).toBe(false)
    expect(showStartNewCompanyPanel({ ...base, articlesReceivedOrder: undefined })).toBe(false)
  })
})

describe('where the panel sits among the step\'s panels', () => {
  it('goes straight after the SS-4 correction panel (the formation step "SS-4 Sent to IRS")', () => {
    // waiting_notice, ss4_correction_panel, document_viewer, chat, action_buttons
    expect(startNewCompanyPanelSlot(['waiting_notice', 'ss4_correction_panel', 'document_viewer', 'chat', 'action_buttons'])).toBe(2)
  })

  it('goes just above the chat on the other steps (Articles Received, SS-4 Prepared, SS-4 Signed, EIN Received)', () => {
    expect(startNewCompanyPanelSlot(['document_viewer', 'info_panel', 'activate_ra', 'chat', 'action_buttons', 'members_panel'])).toBe(3)
    expect(startNewCompanyPanelSlot(['ss4_panel', 'document_viewer', 'info_panel', 'chat', 'action_buttons', 'members_panel'])).toBe(3)
    expect(startNewCompanyPanelSlot(['document_viewer', 'ss4_fax_panel', 'document_upload', 'chat'])).toBe(3)
    expect(startNewCompanyPanelSlot(['ein_entry', 'document_upload', 'document_viewer', 'info_panel', 'chat'])).toBe(4)
  })

  it('goes at the end when the step has neither', () => {
    expect(startNewCompanyPanelSlot(['info_panel', 'document_viewer'])).toBe(2)
    expect(startNewCompanyPanelSlot([])).toBe(0)
  })

  it('goes after the correction panel even when it is the last one', () => {
    expect(startNewCompanyPanelSlot(['info_panel', 'ss4_correction_panel'])).toBe(2)
  })
})

describe('which job took over from a cancelled formation (the "Replaced by" card)', () => {
  const OLD = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const row = (id: string, notes: string | null, created_at: string | null = '2026-11-17T10:00:00Z') => ({ id, notes, stage: 'Payment Confirmed', status: 'active', created_at })

  it('finds the job whose note says it replaces this one', () => {
    const rows = [row('new-1', replacementNote(OLD, 'Novag LLC', '2026-11-17', 'staff@example.com')), row('other', 'unrelated note')]
    expect(pickReplacementJob(rows, OLD)?.id).toBe('new-1')
  })

  it('finds nothing when no job says so, or when there are no rows', () => {
    expect(pickReplacementJob([row('x', 'Replaces job bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb (Other LLC) — the state refused the company name.')], OLD)).toBeNull()
    expect(pickReplacementJob([row('x', null)], OLD)).toBeNull()
    expect(pickReplacementJob([], OLD)).toBeNull()
    expect(pickReplacementJob(null, OLD)).toBeNull()
    expect(pickReplacementJob(undefined, OLD)).toBeNull()
  })

  it('takes the newest when a job was replaced more than once (a stopped press, then a new one)', () => {
    const note = replacementNote(OLD, 'Novag LLC', '2026-11-17', 'staff@example.com')
    const rows = [row('older', note, '2026-11-17T09:00:00Z'), row('newer', note, '2026-11-17T12:00:00Z'), row('no-date', note, null)]
    expect(pickReplacementJob(rows, OLD)?.id).toBe('newer')
  })

  it('never points a job at itself', () => {
    expect(pickReplacementJob([row(OLD, replacementNote(OLD, 'Novag LLC', '2026-11-17', 'x'))], OLD)).toBeNull()
  })

  it('does not mistake an id that merely starts with this one', () => {
    expect(pickReplacementJob([row('x', `Replaces job ${OLD}extra (Novag LLC) — the state refused the company name.`)], OLD)).toBeNull()
  })
})
