/**
 * After a client creates an invoice, a pop-up shows every option at once (Antonio 2026-10-17: "I had to look around to
 * find them under view"). The invoice page owns the logic; the pop-up only offers it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { t } from '@/lib/portal/i18n'
import { invoiceCreatedPopupIsOff, turnInvoiceCreatedPopupOff, INVOICE_CREATED_POPUP_OFF_KEY } from '@/lib/portal/invoice-created-popup'

const form = readFileSync('components/portal/invoice-form.tsx', 'utf8')
const page = readFileSync('app/portal/invoices/[id]/page.tsx', 'utf8')
const dialog = readFileSync('components/portal/invoice-created-dialog.tsx', 'utf8')

afterEach(() => vi.unstubAllGlobals())

describe('after creating an invoice', () => {
  it('the client lands on the new invoice with the created flag, and falls back to the list only if there is no id', () => {
    expect(form).toMatch(/router\.push\(result\.data\?\.id \? `\/portal\/invoices\/\$\{result\.data\.id\}\?created=1` : '\/portal\/invoices'\)/)
  })
  it('the page opens the pop-up only for that flag, unless it was turned off, and clears the flag so a refresh does not reopen it', () => {
    expect(page).toContain("searchParams.get('created') === '1'")
    expect(page).toContain('if (!invoiceCreatedPopupIsOff()) setShowCreated(true)')
    expect(page).toMatch(/router\.replace\(`\/portal\/invoices\/\$\{invoiceId\}`\)/)
  })
  it('the pop-up closes by itself once the invoice is no longer a Draft (it was sent)', () => {
    expect(page).toMatch(/invoice\.status !== 'Draft'\) setShowCreated\(false\)/)
  })
  it('the pop-up reuses the page logic: send, download, close', () => {
    expect(page).toContain('void handleSend()')
    expect(page).toContain('onDownload={handleDownloadPDF}')
  })
})

describe('what the pop-up offers', () => {
  it('Send only for a Draft, PDF always with a DRAFT warning for a Draft, edit only for a Draft, plus view, another, list', () => {
    expect(dialog).toMatch(/isDraft && \(\s*<button onClick=\{p\.onSend\}/)
    expect(dialog).toMatch(/isDraft && <span[^>]*>\{t\('invCreated\.pdfDraftNote'\)\}/)
    expect(dialog).toMatch(/isDraft && \(\s*<Link href=\{`\/portal\/invoices\/\$\{p\.invoiceId\}\/edit`\}/)
    expect(dialog).toContain('href="/portal/invoices/new"')
    expect(dialog).toContain('href="/portal/invoices"')
  })
  it('the repeat line only shows when the invoice repeats', () => {
    expect(dialog).toContain('{p.nextRecurringDate && (')
    expect(page).toContain('nextRecurringDate={invoice.recurring_frequency ? (invoice.recurring_next_date ?? null) : null}')
  })
  it('the "Don\'t show again" choice is remembered on this browser, and a broken storage never blocks the pop-up', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } } })
    expect(invoiceCreatedPopupIsOff()).toBe(false)
    store[INVOICE_CREATED_POPUP_OFF_KEY] = '1'
    expect(invoiceCreatedPopupIsOff()).toBe(true)
    delete store[INVOICE_CREATED_POPUP_OFF_KEY]
    turnInvoiceCreatedPopupOff()
    expect(store[INVOICE_CREATED_POPUP_OFF_KEY]).toBe('1')
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked') } } })
    expect(invoiceCreatedPopupIsOff()).toBe(false)
  })
})

describe('the words', () => {
  const keys = ['title', 'subtitle', 'send', 'sendNoEmail', 'pdf', 'pdfDraftNote', 'edit', 'view', 'another', 'list', 'nextRecurring', 'dontShow']
  it('exist in English and Italian, and differ between them', () => {
    for (const k of keys) {
      expect(t(`invCreated.${k}`, 'en'), k).not.toBe(`invCreated.${k}`)
      expect(t(`invCreated.${k}`, 'it'), k).not.toBe(`invCreated.${k}`)
      expect(t(`invCreated.${k}`, 'it'), k).not.toBe(t(`invCreated.${k}`, 'en'))
    }
    expect(t('invCreated.title', 'it')).toContain('{number}')
    expect(t('invCreated.send', 'it')).toContain('{email}')
    expect(t('invCreated.dontShow', 'en')).toBe("Don't show this again")
  })
  it('the removed "send from my email" text is really gone', () => {
    expect(t('invMail.button', 'en')).toBe('invMail.button')
  })
})
