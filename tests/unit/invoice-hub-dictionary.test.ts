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
  'tour.invoicing.introTitle', 'tour.invoicing.introBody', 'tour.start', 'tour.notNow', 'tour.dontShow', 'tour.takeTour', 'tour.next', 'tour.back', 'tour.skip', 'tour.done',
  'tour.invoicing.feature.title', 'tour.invoicing.feature.body', 'invoices.feature.title', 'invoices.feature.body', 'invoices.feature.placeholder', 'invoices.feature.send', 'invoices.feature.sent', 'invoices.feature.tooShort',
  'payment.howTitle', 'payment.howBody', 'payment.howExample',
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

// Antonio 2026-10-08: "what do you mean 'tell us'?" — in the client's own invoicing tool the CLIENT is the
// sender, so wording must never suggest Tony Durante receives their payment details or sends their invoices.
describe('client invoicing wording never speaks as Tony Durante', () => {
  // The feature box (invoices.feature.*, tour.invoicing.feature.*) IS Tony Durante's team talking to the client about
  // its software ("write us, we will do our best"), so "we" is correct there and only there.
  const keys = KEYS.filter(k => !k.includes('.feature.')).filter(k => k.startsWith('tour.invoicing.') || k.startsWith('invoices.') || k === 'nav.hint.invoicesHub' || k === 'nav.invoicesHub' || k.startsWith('profile.'))
  it.each(keys)('%s has no we/us/our (English) or noi/nostro/possiamo (Italian)', key => {
    expect(t(key, 'en')).not.toMatch(/\b(we|we're|we'll|us|our|ours)\b/i)
    expect(t(key, 'it')).not.toMatch(/\b(noi|nostro|nostra|nostri|nostre|possiamo|siamo|abbiamo)\b/i)
  })
})
