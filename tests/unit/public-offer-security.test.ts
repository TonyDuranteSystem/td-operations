/**
 * N0 (dev job f907220c) — the pure rules behind the server-side offer routes.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { toPublicOfferView, OFFER_PRIVATE_FIELDS, toPublicRenewalView } from '@/lib/offers/public-offer-view'
import {
  signKindFor, sanitizeContractFields, signingOfferUpdate, offerSignRefusal, validateSelection,
  signedPdfPathFor, isOwnSignedPdfPath, wireReceiptPathFor, isOwnWireReceiptPath,
} from '@/lib/offers/public-signing'
import { sniffFileKind } from '@/lib/offers/upload-sniff'
import { signRenewalPass, verifyRenewalPass, RENEWAL_PORTAL_PASS_TTL_MS } from '@/lib/offers/renewal-pass'

// Every offers column in production (2026-09-30). A NEW column must be classified:
// either client-facing (leave it off both lists below) or private (OFFER_PRIVATE_FIELDS).
const PROD_OFFER_COLUMNS = 'id, token, client_name, client_email, offer_date, intro_en, intro_it, issues, immediate_actions, strategy, services, additional_services, cost_summary, recurring_costs, future_developments, next_steps, status, expires_at, viewed_at, view_count, created_at, updated_at, payment_links, payment_type, bank_details, effective_date, language, lead_id, deal_id, referrer_name, referrer_email, referrer_type, referrer_account_id, referrer_commission_type, referrer_commission_pct, referrer_agreed_price, referrer_notes, access_code, contract_type, account_id, bundled_pipelines, selected_services, required_documents, admin_notes, currency, version, superseded_by, installment_currency, entity_type, bundled_pipeline_entry_ids, partner_id, partner_invoice_target, partner_agreed_price, partner_payout_model, partner_payout_rate, contact_id, partner_renewal_payout, referrer_contact_id, card_fee_rate, formation_state, credit_amount, credit_payment_id, credit_kind, payment_plan, commission_released_at, packages, selected_package_key, package_locked_at, allow_split_payment_choice, payment_choice_made_at, bill_to'.split(', ')

describe('public offer view', () => {
  it('never returns the access code, commissions, partner terms, notes or CRM links', () => {
    const row = Object.fromEntries(PROD_OFFER_COLUMNS.map((c) => [c, `v-${c}`]))
    const view = toPublicOfferView(row)
    for (const f of OFFER_PRIVATE_FIELDS) expect(view).not.toHaveProperty(f)
    const json = JSON.stringify(view)
    expect(json).not.toMatch(/referrer_|partner_|commission|admin_notes|access_code|lead_id|deal_id/)
    expect(view.services).toBe('v-services')
    expect(view.bank_details).toBe('v-bank_details')
  })

  it('classifies every internal-looking column (fails when a new one appears unclassified)', () => {
    const suspicious = PROD_OFFER_COLUMNS.filter((c) => /^(referrer_|partner_|commission|admin)|_id$|access_code|bill_to|superseded/.test(c))
    const allowedPublicIds = ['id', 'selected_package_key']
    for (const c of suspicious) {
      if (allowedPublicIds.includes(c)) continue
      expect((OFFER_PRIVATE_FIELDS as readonly string[]).includes(c), `${c} must be private`).toBe(true)
    }
  })

  it('shapes a renewal agreement the way the contract page always built it', () => {
    const v = toPublicRenewalView({ id: 'x', account_id: 'acc', token: 't', client_name: 'A', services: null, cost_summary: null, status: 'draft', agreement_year: 2027 })
    expect(v).toMatchObject({ contract_type: 'renewal', currency: 'USD', installment_currency: 'USD', services: [], cost_summary: [], token: 't', agreement_year: 2027 })
    expect(v).not.toHaveProperty('account_id')
    expect(v).not.toHaveProperty('id')
  })
})

describe('sign kind', () => {
  it('matches the contract page component routing', () => {
    expect(signKindFor('renewal')).toBe('renewal')
    expect(signKindFor('tax_return')).toBe('standalone')
    expect(signKindFor('itin')).toBe('standalone')
    expect(signKindFor('closure')).toBe('standalone')
    expect(signKindFor('onboarding')).toBe('service')
    expect(signKindFor('formation')).toBe('main')
    expect(signKindFor(null)).toBe('main')
  })
})

describe('contract row fields', () => {
  const full = {
    client_name: 'Mario', client_email: 'm@x.com', client_phone: '+39 1', client_address: 'Via 1', client_city: 'Roma',
    client_state: 'RM', client_zip: '00100', client_country: 'Italy', client_nationality: 'IT', client_passport: 'P1',
    client_passport_exp: '2030-01-01', llc_type: 'MMLLC', annual_fee: '2000', contract_year: '2026',
    installments: JSON.stringify({ jan: 1000, jun: 1000 }),
    offer_token: 'someone-else', status: 'hacked', pdf_path: 'x', signed_at: '1999',
  }
  it('main/service keep exactly the fields the pages wrote, never server-owned ones', () => {
    const out = sanitizeContractFields(full, 'main')
    expect(out).toMatchObject({ client_name: 'Mario', client_passport: 'P1', llc_type: 'MMLLC', annual_fee: '2000', contract_year: '2026', installments: '{"jan":1000,"jun":1000}' })
    for (const k of ['offer_token', 'status', 'pdf_path', 'signed_at']) expect(out).not.toHaveProperty(k)
  })
  it('standalone and renewal keep only name and email (as their components wrote)', () => {
    expect(sanitizeContractFields(full, 'standalone')).toEqual({ client_name: 'Mario', client_email: 'm@x.com' })
    expect(sanitizeContractFields(full, 'renewal')).toEqual({ client_name: 'Mario', client_email: 'm@x.com' })
  })
  it('drops malformed derived fields instead of storing them', () => {
    const out = sanitizeContractFields({ llc_type: 'XX', annual_fee: '1e9;drop', contract_year: '26', installments: '{bad' }, 'service')
    expect(out).toMatchObject({ llc_type: null, annual_fee: null, contract_year: null, installments: null })
  })
})

describe('what the formation MSA rewrites on the offer at signing', () => {
  const base = {
    currency: 'EUR',
    services: [{ name: 'Company Formation', price: '€2,500' }, { name: 'ITIN', price: '€800', optional: true }],
    cost_summary: [],
    bank_details: { iban: 'DK89', amount: '€9,999' },
    selected_services: ['Company Formation'],
  }
  it('only the main contract touches payment links and the wire amount', () => {
    expect(signingOfferUpdate(base, 'service').update).toEqual({})
    expect(signingOfferUpdate(base, 'standalone').update).toEqual({})
    const main = signingOfferUpdate(base, 'main').update
    expect(main.payment_links).toBeNull()
    expect((main.bank_details as { iban: string }).iban).toBe('DK89')
  })
  it('quotes the net amount of what was selected (optional line not ticked is not billed)', () => {
    const main = signingOfferUpdate(base, 'main').update
    expect((main.bank_details as { amount: string }).amount).toBe('€2,500')
    const withItin = signingOfferUpdate({ ...base, selected_services: ['Company Formation', 'ITIN'] }, 'main').update
    expect((withItin.bank_details as { amount: string }).amount).toBe('€3,300')
  })
  it('applies a credit (net, not gross)', () => {
    const main = signingOfferUpdate({ ...base, credit_amount: 500 }, 'main').update
    expect((main.bank_details as { amount: string }).amount).toBe('€2,000')
  })
  it('quotes the part due at signing when the fee is paid in parts', () => {
    const planned = signingOfferUpdate({
      ...base,
      payment_plan: [
        { seq: 1, amount: 1250, currency: 'EUR', trigger: { kind: 'signing' } },
        { seq: 2, amount: 1250, currency: 'EUR', trigger: { kind: 'manual', label: 'Bank account opened' } },
      ],
    }, 'main')
    expect(planned.planRefusal).toBeNull()
    expect((planned.update.bank_details as { amount: string }).amount).toBe('€1,250')
  })
  it('quotes nothing new when the payment plan disagrees with the offer', () => {
    const bad = signingOfferUpdate({
      ...base,
      payment_plan: [
        { seq: 1, amount: 1250, currency: 'EUR', trigger: { kind: 'signing' } },
        { seq: 2, amount: 900, currency: 'EUR', trigger: { kind: 'manual' } },
      ],
    }, 'main')
    expect(bad.planRefusal).toContain('2150')
    expect(bad.update).not.toHaveProperty('bank_details')
    expect(bad.update.payment_links).toBeNull()
  })
  it('without bank details only clears the links', () => {
    expect(signingOfferUpdate({ ...base, bank_details: null }, 'main').update).toEqual({ payment_links: null })
  })
})

describe('when an offer may be signed', () => {
  const now = new Date('2026-09-30T12:00:00Z')
  it('allows the statuses clients sign from today', () => {
    for (const status of ['draft', 'sent', 'published', 'viewed']) expect(offerSignRefusal({ status }, now)).toBeNull()
  })
  it('refuses expired, superseded and cancelled offers', () => {
    expect(offerSignRefusal({ status: 'expired' }, now)).toMatch(/expired/)
    expect(offerSignRefusal({ status: 'superseded' }, now)).toMatch(/replaced/)
    expect(offerSignRefusal({ status: 'cancelled' }, now)).toMatch(/no longer/)
    expect(offerSignRefusal({ status: 'viewed', expires_at: '2026-09-01T00:00:00Z' }, now)).toMatch(/expired/)
  })
  it('refuses an unpicked multi-option offer and an unmade split-payment choice', () => {
    expect(offerSignRefusal({ status: 'viewed', packages: [{ key: 'a' }], package_locked_at: null }, now)).toMatch(/choose one of the options/)
    expect(offerSignRefusal({ status: 'viewed', packages: [{ key: 'a' }], package_locked_at: '2026-09-29' }, now)).toBeNull()
    const split = { status: 'viewed', allow_split_payment_choice: true, payment_choice_made_at: null, currency: 'EUR', services: [{ name: 'X', price: '€1,000' }], cost_summary: [] }
    expect(offerSignRefusal(split, now)).toMatch(/how you want to pay/)
    expect(offerSignRefusal({ ...split, payment_choice_made_at: '2026-09-29' }, now)).toBeNull()
  })
})

describe('selection of optional services', () => {
  const offer = { services: [{ name: 'A' }, { name: 'B', optional: true }, { name: 'C', optional: true }] }
  it('keeps required + ticked optional lines', () => {
    expect(validateSelection(offer, ['A', 'C'])).toEqual(['A', 'C'])
    expect(validateSelection(offer, ['A'])).toEqual(['A'])
  })
  it('refuses unknown names, a dropped required line, or a non-list', () => {
    expect(validateSelection(offer, ['A', 'Z'])).toBeNull()
    expect(validateSelection(offer, ['B'])).toBeNull()
    expect(validateSelection(offer, 'A')).toBeNull()
  })
})

describe('server-issued storage paths', () => {
  it('signed PDF paths stay in the offer folder and are recognised only for that offer', () => {
    const p = signedPdfPathFor('mario-rossi-2026', 'main', 123)
    expect(p).toBe('mario-rossi-2026/contract-signed-123.pdf')
    expect(isOwnSignedPdfPath('mario-rossi-2026', p)).toBe(true)
    expect(isOwnSignedPdfPath('luigi-2026', p)).toBe(false)
    expect(isOwnSignedPdfPath('mario-rossi-2026', 'mario-rossi-2026/../x/contract-signed-1.pdf')).toBe(false)
    expect(isOwnSignedPdfPath('mario-rossi-2026', 'mario-rossi-2026/evil.pdf')).toBe(false)
  })
  it('wire receipts accept images and PDFs only', () => {
    expect(wireReceiptPathFor('t', 'IMG_1.HEIC', 5)).toBe('t/wire-receipt-5.heic')
    expect(wireReceiptPathFor('t', 'x.exe', 5)).toBeNull()
    expect(isOwnWireReceiptPath('t', 't/wire-receipt-5.heic')).toBe(true)
    expect(isOwnWireReceiptPath('t', 'u/wire-receipt-5.heic')).toBe(false)
  })
})

describe('file kind by first bytes', () => {
  const b = (s: string) => new Uint8Array(Array.from(s).map((c) => c.charCodeAt(0)))
  it('recognises PDF and the common image kinds', () => {
    expect(sniffFileKind(b('%PDF-1.7\n'))).toBe('pdf')
    expect(sniffFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png')
    expect(sniffFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffFileKind(b('RIFF....WEBP'))).toBe('webp')
    expect(sniffFileKind(b('....ftypheic'))).toBe('heic')
  })
  it('rejects anything else, whatever its name claims', () => {
    expect(sniffFileKind(b('<html><script>'))).toBeNull()
    expect(sniffFileKind(new Uint8Array([]))).toBeNull()
  })
})

describe('renewal passes', () => {
  beforeAll(() => { process.env.API_SECRET_TOKEN = 'test-secret-for-renewal-pass' })
  it('a pass works only for its own agreement and only until it expires', async () => {
    const now = 1_000_000
    const pass = await signRenewalPass({ agreementId: 'ag-1', kind: 'portal' }, now)
    expect(await verifyRenewalPass(pass, 'ag-1', now + 1000)).toMatchObject({ agreementId: 'ag-1', kind: 'portal' })
    expect(await verifyRenewalPass(pass, 'ag-2', now + 1000)).toBeNull()
    expect(await verifyRenewalPass(pass, 'ag-1', now + RENEWAL_PORTAL_PASS_TTL_MS + 1)).toBeNull()
  })
  it('a grant outlives the handoff pass; a tampered token is refused', async () => {
    const now = 1_000_000
    const grant = await signRenewalPass({ agreementId: 'ag-1', kind: 'grant' }, now)
    expect(await verifyRenewalPass(grant, 'ag-1', now + 60 * 60 * 1000)).not.toBeNull()
    expect(await verifyRenewalPass(grant.slice(0, -2) + 'xx', 'ag-1', now)).toBeNull()
    expect(await verifyRenewalPass('', 'ag-1', now)).toBeNull()
  })
})
