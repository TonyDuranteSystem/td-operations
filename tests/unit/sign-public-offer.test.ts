/**
 * N0 (dev job f907220c) — server-side signing: order, races, and resuming after a
 * failure at every step. All I/O is faked; each test builds its own world.
 */
import { describe, it, expect } from 'vitest'
import { signPublicOffer, signRenewalAgreement, type SignDeps } from '@/lib/offers/sign-public-offer'

function world(opts: {
  status?: string
  contractType?: string
  pdfExists?: boolean
  insertFails?: boolean
  flipFails?: boolean
  flipLoses?: boolean
  followUpThrows?: boolean
  contracts?: number
} = {}) {
  const log: string[] = []
  let contracts = opts.contracts ?? 0
  const offer = {
    token: 'mario-2026',
    status: opts.status ?? 'viewed',
    contract_type: opts.contractType ?? 'formation',
    currency: 'EUR',
    services: [{ name: 'Company Formation', price: '€2,500' }],
    cost_summary: [],
    bank_details: { iban: 'DK89' },
    selected_services: ['Company Formation'],
  }
  const deps: SignDeps = {
    storageObjectExists: async (b, p) => { log.push(`exists ${b} ${p}`); return opts.pdfExists ?? true },
    insertContract: async (row) => {
      log.push(`insert ${row.offer_token} ${row.pdf_path}`)
      if (opts.insertFails) return { id: null, error: 'boom' }
      contracts++
      return { id: `c${contracts}`, error: null }
    },
    deleteContract: async (id) => { log.push(`delete ${id}`); contracts-- },
    contractCount: async () => contracts,
    flipOfferSigned: async (token, update, from) => {
      log.push(`flip ${token} ${JSON.stringify(update)} from ${from.join(',')}`)
      if (opts.flipFails) return { changed: 0, error: 'db down' }
      return { changed: opts.flipLoses ? 0 : 1, error: null }
    },
    processOfferSigned: async (t) => {
      log.push(`followup ${t}`)
      if (opts.followUpThrows) throw new Error('timeout')
      return { status: 200, body: { ok: true } }
    },
    processAgreementSigned: async (t) => { log.push(`agreement-followup ${t}`); return { status: 200, body: { ok: true, invoice_number: 'INV-000123' } } },
    now: () => new Date('2026-09-30T12:00:00Z'),
  }
  return { offer, deps, log, contracts: () => contracts }
}

const PDF = 'mario-2026/contract-signed-1.pdf'

describe('signing an offer on the server', () => {
  it('runs artifact → record → conditional flip → follow-up, in that order', async () => {
    const w = world()
    const r = await signPublicOffer({ offer: w.offer, fields: { client_name: 'Mario' }, pdfPath: PDF }, w.deps)
    expect(r.error).toBeNull()
    expect(r.alreadySigned).toBe(false)
    expect(w.log.map((l) => l.split(' ')[0])).toEqual(['exists', 'insert', 'flip', 'followup'])
    expect(w.log[2]).toContain('"status":"signed"')
    expect(w.log[2]).toContain('"payment_links":null')
    expect(w.log[2]).toContain('from draft,sent,published,viewed')
    expect(r.bankAmount).toBe('€2,500')
  })

  it('records the contract version the client signed on the contracts row', async () => {
    const w = world()
    let row: Record<string, unknown> | null = null
    const deps = { ...w.deps, insertContract: async (r: Record<string, unknown>) => { row = r; return { id: 'c1', error: null } } }
    await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, deps)
    expect(row).toMatchObject({ contract_version: '2026-09-30', status: 'signed' })
  })

  it('an onboarding / standalone contract only flips the status', async () => {
    for (const ct of ['onboarding', 'tax_return', 'itin', 'closure']) {
      const w = world({ contractType: ct })
      await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
      expect(w.log.find((l) => l.startsWith('flip'))).toContain('{"status":"signed"}')
    }
  })

  it('refuses when the PDF is missing or is not a path the server issued — nothing is written', async () => {
    const w = world({ pdfExists: false })
    expect((await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)).error).toBe('document_upload')
    expect((await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: 'other-2026/contract-signed-1.pdf' }, w.deps)).error).toBe('document_upload')
    expect(w.log.some((l) => l.startsWith('insert') || l.startsWith('flip'))).toBe(false)
  })

  it('a failed record insert stops before the status moves', async () => {
    const w = world({ insertFails: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBe('record')
    expect(w.log.some((l) => l.startsWith('flip'))).toBe(false)
  })

  it('a failed status flip reports it, drops its own record (no duplicate on retry) and runs no follow-up', async () => {
    const w = world({ flipFails: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBe('status')
    expect(w.log).toContain('delete c1')
    expect(w.contracts()).toBe(0)
    expect(w.log.some((l) => l.startsWith('followup'))).toBe(false)
  })

  it('RETRY on a signed offer whose plan disagrees with it still quotes no wire figure', async () => {
    const w = world({ status: 'signed', contracts: 1 })
    const offer = {
      ...w.offer,
      bank_details: { iban: 'DK89', amount: '€2,500' },
      payment_plan: [
        { seq: 1, amount: 1250, currency: 'EUR', trigger: { kind: 'signing' } },
        { seq: 2, amount: 900, currency: 'EUR', trigger: { kind: 'manual' } },
      ],
    }
    const r = await signPublicOffer({ offer, fields: {}, pdfPath: undefined }, w.deps)
    expect(r.error).toBeNull()
    expect(r.planRefusal).toBeTruthy()
  })

  it('two concurrent signs: the loser drops its duplicate row and still answers success', async () => {
    const w = world({ flipLoses: true, contracts: 1 })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBeNull()
    expect(r.alreadySigned).toBe(true)
    expect(w.log).toContain('delete c2')
    expect(w.contracts()).toBe(1)
  })

  it('a follow-up that times out does not undo the signature', async () => {
    const w = world({ followUpThrows: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBeNull()
  })

  it('RETRY after a lost response: already signed + record present → follow-up re-run, same success', async () => {
    const w = world({ status: 'signed', contracts: 1 })
    w.offer.bank_details = { iban: 'DK89', amount: '€2,500' } as typeof w.offer.bank_details
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: undefined }, w.deps)
    expect(r.error).toBeNull()
    expect(r.alreadySigned).toBe(true)
    expect(r.bankAmount).toBe('€2,500')
    expect(w.log).toEqual(['followup mario-2026'])
  })

  it('RETRY when the record is missing on a signed offer: it is written from the uploaded PDF', async () => {
    const w = world({ status: 'signed', contracts: 0 })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBeNull()
    expect(w.log.map((l) => l.split(' ')[0])).toEqual(['exists', 'insert', 'followup'])
  })

  it('refuses expired or superseded offers without writing anything', async () => {
    for (const status of ['expired', 'superseded']) {
      const w = world({ status })
      const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
      expect(r.status).toBe(409)
      expect(w.log).toEqual([])
    }
  })
})

describe('signing a renewal agreement on the server', () => {
  const agreement = { id: 'ag', token: 'renewal-mario-2027', status: 'draft' }
  const RPDF = 'renewal-mario-2027/annual-agreement-signed-1.pdf'

  it('records the contract then runs the renewal follow-up (which flips the agreement and invoices)', async () => {
    const w = world()
    const r = await signRenewalAgreement({ agreement, fields: { client_name: 'Mario', client_email: 'm@x.com' }, pdfPath: RPDF }, w.deps)
    expect(r.error).toBeNull()
    expect(r.invoiceNumber).toBe('INV-000123')
    expect(w.log.map((l) => l.split(' ')[0])).toEqual(['exists', 'insert', 'agreement-followup'])
    expect(w.log.some((l) => l.startsWith('flip'))).toBe(false)
  })

  it('a retry on an already-signed agreement with its record just re-runs the follow-up', async () => {
    const w = world({ contracts: 1 })
    const r = await signRenewalAgreement({ agreement: { ...agreement, status: 'signed' }, fields: {}, pdfPath: undefined }, w.deps)
    expect(r.error).toBeNull()
    expect(r.alreadySigned).toBe(true)
    expect(w.log).toEqual(['agreement-followup renewal-mario-2027'])
  })

  it('refuses without an uploaded PDF', async () => {
    const w = world({ pdfExists: false })
    const r = await signRenewalAgreement({ agreement, fields: {}, pdfPath: RPDF }, w.deps)
    expect(r.error).toBe('document_upload')
  })
})
