/**
 * The "State refused the company name?" panel of the Company Formation workspace (dev job bf9886a3, Antonio 2026-11-17):
 * when it shows and where it sits. Pure rules (lib/flows/start-new-company-panel.ts); the page and the step renderer only use them.
 */
import { describe, it, expect } from 'vitest'
import { ARTICLES_RECEIVED_STAGE, showStartNewCompanyPanel, startNewCompanyPanelSlot } from '@/lib/flows/start-new-company-panel'

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
