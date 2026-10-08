import { describe, it, expect } from 'vitest'
import { t } from '@/lib/portal/i18n'
import { INVOICE_TABS } from '@/lib/portal/invoice-hub'

// Every word the client sees in the new invoice notices and the Setup tab must exist in BOTH
// English and Italian (the portal's built-in dictionary); other languages come from the translation store.
const KEYS = [
  'invoices.draftExplainer', 'invoices.noEmailBanner', 'invoices.emailPlaceholder', 'invoices.saveEmail',
  'invoices.emailSaved', 'invoices.noPaymentBanner', 'invoices.addPaymentDetails', 'invoices.sendAnyway',
  'invoices.notYet', 'invoices.sentNotSaved', 'invoices.emailNeededToSend',
  'invoices.tabCustomers', 'invoices.tabSetup', 'invoices.setupSubtitle', 'invoices.setupMissingHint',
  'invoices.setupChecklist', 'invoices.setup.logo', 'invoices.setup.payment', 'invoices.setup.customer',
  'nav.invoicesHub', 'nav.hint.invoicesHub', 'invoices.hubSubtitle',
  'invoices.setupRequired', 'invoices.setupOptional', 'profile.invoiceSettingsMoved', 'profile.openInvoiceSetup',
  ...INVOICE_TABS.map(t => t.labelKey),
]

describe('invoice hub wording', () => {
  it.each(KEYS)('%s exists in English and Italian', key => {
    const en = t(key, 'en')
    const it_ = t(key, 'it')
    expect(en).not.toBe(key)
    expect(it_).not.toBe(key)
  })

  it('Italian differs from English for the new sentences (not copied)', () => {
    for (const key of ['invoices.draftExplainer', 'invoices.noEmailBanner', 'invoices.noPaymentBanner', 'invoices.sendAnyway']) {
      expect(t(key, 'it')).not.toBe(t(key, 'en'))
    }
  })
})
