/**
 * End-to-end SCENARIO SIMULATION for the offer-narrative generator.
 *
 * The AI's final prose is non-deterministic and human-reviewed, so what we can
 * (and must) verify deterministically is the PROMPT the writer is actually given
 * for every scenario: the correct business rules injected, the right management
 * gating, the right entity/tax wording, the real service descriptions, and the
 * name-grounding rule. This harness assembles the real system+user prompt exactly
 * as the route does (minus the AI call + DB fetch) and asserts each scenario.
 */
import { describe, it, expect } from 'vitest'
import { normalizeEntityType } from '@/lib/offer-narrative'
import {
  renderServiceLines,
  resolveBusinessRules,
  offerIncludesManagement,
  buildSystemPrompt,
  buildUserPrompt,
  FALLBACK_BUSINESS_RULES,
  type NarrativeServiceInput,
} from '@/lib/offers/narrative-business-rules'

// A representative copy of the editable KB article content (the real source at
// runtime). Used for the "article present" scenarios.
const KB_RULES = `SERVICES TONY DURANTE DOES NOT OFFER — never mention bookkeeping, accounting-system setup, financial reporting, personal tax return preparation, or tax planning.
U.S. TAX FILING BY COMPANY TYPE:
- Single-Member LLC (foreign-owned): information return — pro-forma Form 1120 plus Form 5472. No bookkeeping.
- Multi-Member LLC: partnership return (Form 1065) with a Profit & Loss statement and Balance Sheet where required.
- Corporation (C-Corp): Form 1120. S-corporations are generally unavailable to non-U.S.-resident owners.
CLIENT PORTAL: document vault, deadline calendar, Portal Chat, installable app.
STANDARD MANAGEMENT SERVICES (only when the offer includes ongoing management): registered agent; annual report; mail handling; Operating Agreement.`

/** Assemble the two prompts exactly like the route, for one scenario. */
function simulate(opts: {
  clientName: string
  language?: 'en' | 'it'
  services: NarrativeServiceInput[]
  contractType: string
  entityType?: string | null
  includesManagement?: boolean
  hasMultipleOptions?: boolean
  notes?: string
  kbArticle?: { content?: string | null } | null // null → article missing → floor
}) {
  const lang = opts.language ?? 'en'
  const { rules, source } = resolveBusinessRules(
    opts.kbArticle === undefined ? { content: KB_RULES } : opts.kbArticle,
  )
  const includesManagement =
    typeof opts.includesManagement === 'boolean'
      ? opts.includesManagement
      : offerIncludesManagement(opts.contractType)
  const serviceLines = renderServiceLines(opts.services)
  const systemPrompt = buildSystemPrompt(lang, rules, includesManagement, opts.hasMultipleOptions ?? false)
  const userPrompt = buildUserPrompt(
    opts.clientName,
    lang,
    serviceLines,
    opts.notes ?? '',
    opts.contractType,
    normalizeEntityType(opts.entityType),
  )
  return { systemPrompt, userPrompt, rulesSource: source, includesManagement, serviceLines }
}

// Every scenario must satisfy these invariants no matter what.
function assertUniversalGuards(systemPrompt: string) {
  // Name-grounding rule always present.
  expect(systemPrompt).toContain('NEVER greet or address the client by a name found in the notes')
  // Never states the client's tax as a promise.
  expect(systemPrompt).toContain("Never state the client's specific tax liability as a promise")
  // The rules block header is present.
  expect(systemPrompt).toContain('BUSINESS RULES — AUTHORITATIVE')
}

describe('offer-narrative scenario simulation', () => {
  it('SMLLC onboarding (the original bug) — management ON, correct filing, no bookkeeping directive', () => {
    const { systemPrompt, userPrompt, rulesSource, includesManagement } = simulate({
      clientName: 'Joan Roque',
      services: [{ name: 'Onboarding', description: 'TD takes over management of an existing LLC the client already owns.' }],
      contractType: 'onboarding',
      entityType: 'SMLLC',
      notes: "Julio: Nathan set up my Wyoming LLC. I want full management.",
    })
    expect(rulesSource).toBe('kb')
    expect(includesManagement).toBe(true)
    assertUniversalGuards(systemPrompt)
    // The prompt no longer instructs accounting-system setup (the original bug).
    expect(systemPrompt).not.toContain('setting up accounting systems')
    // Management scope is enabled.
    expect(systemPrompt).toContain('this offer INCLUDES ongoing management')
    // Entity + correct filing reach the writer.
    expect(userPrompt).toContain('ENTITY TYPE: Single-Member LLC')
    expect(systemPrompt).toContain('Form 5472')
    // Client-of-record name is what's provided; the notes name is NOT the CLIENT field.
    expect(userPrompt).toContain('CLIENT: Joan Roque')
    expect(userPrompt).not.toContain('CLIENT: Julio')
    // Real service description reached the writer.
    expect(userPrompt).toContain('Onboarding — TD takes over management')
  })

  it('MMLLC onboarding — partnership return wording available, management ON', () => {
    const { systemPrompt, userPrompt } = simulate({
      clientName: 'Acme Partners LLC',
      services: [{ name: 'Onboarding', description: 'Take over management.' }],
      contractType: 'onboarding',
      entityType: 'MMLLC',
    })
    expect(userPrompt).toContain('ENTITY TYPE: Multi-Member LLC')
    expect(systemPrompt).toContain('Form 1065')
    expect(systemPrompt).toContain('this offer INCLUDES ongoing management')
  })

  it('Formation SMLLC — formation is allowed, management ON', () => {
    const { systemPrompt, userPrompt, includesManagement } = simulate({
      clientName: 'New Co',
      services: [{ name: 'LLC Formation', description: 'Form a new US LLC.' }],
      contractType: 'formation',
      entityType: 'SMLLC',
    })
    expect(includesManagement).toBe(true)
    expect(systemPrompt).toContain('BRAND NEW company')
    expect(userPrompt).toContain('CONTRACT TYPE: formation')
  })

  it('Renewal — continuity, management ON', () => {
    const { includesManagement, systemPrompt } = simulate({
      clientName: 'Repeat Client',
      services: [{ name: 'Annual Renewal', description: 'Annual LLC renewal and compliance filing.' }],
      contractType: 'renewal',
      entityType: 'MMLLC',
    })
    expect(includesManagement).toBe(true)
    expect(systemPrompt).toContain('renewing an existing management agreement')
  })

  it('ITIN-only standalone — management OFF, no portal / RA over-promise', () => {
    const { systemPrompt, includesManagement } = simulate({
      clientName: 'Individual Person',
      services: [{ name: 'ITIN Application', description: 'W-7 preparation, IRS Certified Acceptance Agent.' }],
      contractType: 'itin',
    })
    expect(includesManagement).toBe(false)
    expect(systemPrompt).toContain('this offer does NOT include ongoing management')
    expect(systemPrompt).toContain('Do NOT mention registered agent')
  })

  it('Banking-only standalone — management OFF even though contract type is not a management type', () => {
    const { includesManagement, systemPrompt } = simulate({
      clientName: 'Bank Client',
      services: [{ name: 'Banking', description: 'Open a US business bank account.' }],
      contractType: 'banking',
      includesManagement: false, // dialog computes this from real services
    })
    expect(includesManagement).toBe(false)
    expect(systemPrompt).toContain('does NOT include ongoing management')
  })

  it('Unknown entity type — tax wording stays generic', () => {
    const { userPrompt } = simulate({
      clientName: 'Mystery',
      services: ['Onboarding'],
      contractType: 'onboarding',
      entityType: 'LLP', // not a known type
    })
    expect(userPrompt).toContain('ENTITY TYPE: Not specified')
  })

  it('KB article MISSING — degrades to the safe floor, still forbids bookkeeping', () => {
    const { systemPrompt, rulesSource } = simulate({
      clientName: 'Fallback Client',
      services: ['Onboarding'],
      contractType: 'onboarding',
      entityType: 'SMLLC',
      kbArticle: null, // simulate no tagged article
    })
    expect(rulesSource).toBe('fallback_missing')
    expect(systemPrompt).toContain(FALLBACK_BUSINESS_RULES)
    expect(systemPrompt.toLowerCase()).toContain('does not offer')
    expect(systemPrompt.toLowerCase()).toContain('bookkeeping')
  })

  it('Italian client — non-intro sections in Italian, only Italian intro filled', () => {
    const { systemPrompt } = simulate({
      clientName: 'Cliente Italiano',
      language: 'it',
      services: [{ name: 'Onboarding', description: 'Gestione.' }],
      contractType: 'onboarding',
      entityType: 'SMLLC',
    })
    expect(systemPrompt).toContain('"intro_en": MUST be an empty string')
    expect(systemPrompt).toContain('Generate ALL content in Italian only')
  })

  it('management ON vs OFF produce different scope instructions', () => {
    const on = simulate({ clientName: 'A', services: ['Onboarding'], contractType: 'onboarding' })
    const off = simulate({ clientName: 'B', services: ['ITIN Application'], contractType: 'itin' })
    expect(on.systemPrompt).toContain('INCLUDES ongoing management')
    expect(off.systemPrompt).toContain('does NOT include ongoing management')
    expect(on.systemPrompt).not.toEqual(off.systemPrompt)
  })

  it('multiple options (dev job 3c1bb5fa) — tells the writer to mention the picker without inventing option details', () => {
    const { systemPrompt } = simulate({
      clientName: 'Mattia Tedesco',
      services: [{ name: 'Company Formation', description: 'Form a new US LLC.' }],
      contractType: 'formation',
      entityType: 'SMLLC',
      hasMultipleOptions: true,
    })
    expect(systemPrompt).toContain('MULTIPLE OPTIONS')
    expect(systemPrompt).toContain('review each one on the offer page and select the one that fits them best')
    expect(systemPrompt).toContain('Do NOT describe what the specific options are')
  })

  it('single option (default) — no multiple-options instruction reaches the writer', () => {
    const { systemPrompt } = simulate({
      clientName: 'Solo Client',
      services: [{ name: 'Company Formation', description: 'Form a new US LLC.' }],
      contractType: 'formation',
      entityType: 'SMLLC',
    })
    expect(systemPrompt).not.toContain('MULTIPLE OPTIONS')
  })
})
