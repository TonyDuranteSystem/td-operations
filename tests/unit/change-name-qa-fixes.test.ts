/**
 * Company Change Name — the fixes that came out of the live production QA (2026-10-20, dev job bb64c417):
 *   names answers that vanished, the one-box names screen, the false "No matching workflow" alert, the card shown twice,
 *   the staff note the client could read, the stamped document the client could not open, the "Ask" button shown after the
 *   client was asked, and the Go back label. The step locks (signed form, applied name) are in change-name-advance-gate.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { namesAnswerProblem, namesAnswerProblemDetail, looksLikeSeveralNames, type NameCheck } from '@/lib/flows/name-checks'
import { checkNamesAnswerBeforeSaving } from '@/lib/operations/formation-name-checks'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const nc = (name: string, status: NameCheck['status']): NameCheck => ({ name, source: 'client_resubmit', status, updated_at: null })

describe('namesAnswerProblem — a useless "send us your names" answer is refused with a reason', () => {
  const ask = { separators: 'lines' as const, max: 3, existing: [] as NameCheck[] }

  it('accepts one, two or three names, one per line', () => {
    expect(namesAnswerProblem({ ...ask, text: 'Acme Holdings LLC' })).toBeNull()
    expect(namesAnswerProblem({ ...ask, text: 'Acme Holdings LLC\nAcme Group LLC\nAcme Capital LLC' })).toBeNull()
  })

  it('refuses nothing usable: empty, spaces, only separators', () => {
    for (const text of ['', '   ', ';', '\n\n', ' ; ; ', null, undefined, 42]) {
      expect(namesAnswerProblem({ ...ask, text }), String(text)).toMatch(/at least one company name/)
    }
  })

  it('refuses more names than the request allows (they used to be dropped silently)', () => {
    expect(namesAnswerProblem({ ...ask, text: 'A LLC\nB LLC\nC LLC\nD LLC' })).toMatch(/at most 3 names/)
    expect(namesAnswerProblem({ ...ask, max: 1, text: 'A LLC\nB LLC' })).toMatch(/at most 1 name, one per line/)
  })

  it('refuses several names run together on one line (a comma list used to become ONE name)', () => {
    expect(namesAnswerProblem({ ...ask, text: 'Acme Holdings LLC, Acme Group LLC, Acme Capital LLC' })).toMatch(/own line/)
    expect(namesAnswerProblem({ ...ask, text: 'Acme LLC; Acme Group LLC' })).toBeNull() // ";" already splits into two lines
    // but ONE name with a comma inside is fine
    expect(namesAnswerProblem({ ...ask, text: 'Acme Holdings, LLC' })).toBeNull()
    expect(looksLikeSeveralNames('Acme Holdings, LLC')).toBe(false)
    expect(looksLikeSeveralNames('Acme L.L.C., Beta LLC')).toBe(true)
    expect(looksLikeSeveralNames('Acme Group')).toBe(false)
  })

  it('refuses a name over the length limit', () => {
    expect(namesAnswerProblem({ ...ask, text: `${'A'.repeat(121)} LLC` })).toMatch(/too long/)
  })

  it('refuses an answer where NOTHING would be kept: re-typing a refused name or one already on the list', () => {
    const existing = [nc('Acme LLC', 'not_available'), nc('Beta LLC', 'rejected_by_client')]
    expect(namesAnswerProblem({ ...ask, existing, text: 'ACME' })).toMatch(/repeat/)
    expect(namesAnswerProblem({ ...ask, existing, text: 'Acme, LLC' })).toMatch(/repeat/) // same name by the dedupe key
    expect(namesAnswerProblem({ ...ask, existing, text: 'Acme LLC\nbeta llc' })).toMatch(/Those names are repeats/)
  })

  it('accepts an answer where AT LEAST ONE name is new (the repeats are simply not added twice)', () => {
    const existing = [nc('Acme LLC', 'not_available')]
    expect(namesAnswerProblem({ ...ask, existing, text: 'Acme LLC\nGamma LLC' })).toBeNull()
  })

  it('the refusal wording never contains "already"/"expired" — the route would answer 409 (a conflict) instead of 400', () => {
    const existing = [nc('Acme LLC', 'not_available')]
    for (const text of ['Acme LLC', 'Acme LLC\nacme']) {
      expect(namesAnswerProblem({ ...ask, existing, text }) ?? '').not.toMatch(/already|expired|no longer active/i)
    }
  })
})

describe('namesAnswerProblemDetail — every refusal carries a CODE the card translates', () => {
  const ask = { separators: 'lines' as const, max: 3, existing: [nc('Acme LLC', 'not_available')] }
  it.each([
    ['empty', { text: '  ' }],
    ['too_many', { text: 'A LLC\nB LLC\nC LLC\nD LLC' }],
    ['too_long', { text: `${'A'.repeat(121)} LLC` }],
    ['run_together', { text: 'Beta LLC, Gamma LLC' }],
    ['repeat', { text: 'acme' }],
  ])('%s', (code, extra) => {
    const d = namesAnswerProblemDetail({ ...ask, ...extra })
    expect(d?.code).toBe(code)
    expect(d?.message.length).toBeGreaterThan(10)
    expect(namesAnswerProblem({ ...ask, ...extra })).toBe(d?.message)
  })
  it('null when the answer can be used', () => {
    expect(namesAnswerProblemDetail({ ...ask, text: 'Gamma LLC' })).toBeNull()
  })
})

describe('checkNamesAnswerBeforeSaving — only the Company Change Name asks are checked', () => {
  const req = (name_check: unknown, sd: string | null = 'sd-1') => ({ options: { name_check }, service_delivery_id: sd }) as never

  it('does nothing for approvals, Formation\'s own new-names asks (comma split) or a request with no job', async () => {
    expect(await checkNamesAnswerBeforeSaving(req({ kind: 'approval' }), { text: 'x' })).toBeNull()
    expect(await checkNamesAnswerBeforeSaving(req({ kind: 'new_names' }), { text: '' })).toBeNull()
    expect(await checkNamesAnswerBeforeSaving(req({ kind: 'new_names', split: 'lines', max: 3 }, null), { text: '' })).toBeNull()
    expect(await checkNamesAnswerBeforeSaving({ options: {}, service_delivery_id: 'sd-1' } as never, { text: '' })).toBeNull()
  })
})

describe('wiring', () => {
  it('the answer route runs the check BEFORE the answer is saved, and a read failure never blocks an answer', () => {
    const s = read('lib/operations/decision-request.ts')
    const check = s.indexOf('checkNamesAnswerBeforeSaving')
    const save = s.indexOf('TOCTOU guard: only the first responder')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(save)
    expect(s).toMatch(/non-critical — save the answer as before/)
  })

  it('the client card shows three labelled boxes like the formation wizard (1st choice / 2nd and 3rd backup, "Must end with LLC") in both languages', () => {
    const card = read('components/portal/decision-card.tsx')
    expect(card).toContain("nameMarker?.kind === 'new_names' && nameMarker.split === 'lines'")
    expect(card).toContain("respond({ text: names.join('\\n') })")
    expect(card).toContain('namesMustDiffer')
    const i18n = read('lib/portal/i18n.ts')
    for (const key of ['nameChoice1', 'nameChoice2', 'nameChoice3', 'nameChoiceNew', 'nameHint1', 'nameHint2', 'needOneName', 'namesMustDiffer', 'errNamesEmpty', 'errNamesTooMany', 'errNamesTooLong', 'errNamesRunTogether', 'errNamesRepeat']) {
      expect(i18n.split(`'decisionCard.${key}'`).length - 1, key).toBe(2) // English + Italian
    }
    expect(i18n).toContain("'decisionCard.nameChoice1': '1st Choice Company Name'")
    expect(i18n).toContain("'decisionCard.nameChoice2': '2nd Choice (backup)'")
    expect(i18n).toContain("'decisionCard.nameHint1': 'Must end with LLC'")
    expect(i18n).toContain("'decisionCard.nameChoice1': 'Nome Società (1ª scelta)'")
    // the formation wizard keeps the same labels
    expect(read('components/portal/wizard/wizard-configs.ts')).toContain("label: '1st Choice Company Name'")
  })

  it('a new Company Change Name job does not ask the workflow dispatcher (no false "No matching workflow" alert); other services still do', () => {
    const s = read('lib/operations/service-delivery.ts')
    expect(s).toContain('const hasWorkflowCard = row.service_type !== "Company Change Name"')
    expect(s).toContain('if (hasWorkflowCard) {')
    expect(s.indexOf('if (hasWorkflowCard) {')).toBeLessThan(s.indexOf('dispatchWorkflowForSdCreated({'))
  })

  it('the portal strip does not repeat the card a flow page already shows', () => {
    const s = read('components/portal/pending-decisions.tsx')
    expect(s).toContain("usePathname")
    expect(s).toContain('r.service_delivery_id !== flowId')
    expect(s).toContain('onThisFlow.length === 1') // several open requests on one job keep showing here (Formation)
    expect(s).toContain('shown.map((req)')
  })

  it('Company Change Name posts NO "Client rejected ..." chat line (the client read it as their own message); Formation keeps it', () => {
    const s = read('lib/operations/formation-name-checks.ts')
    expect(s).toContain("if (row && nameLoopPolicyFor(row.service_type)?.key === 'change_name') return")
    // the staff still see the rejection: the names row shows the note, and the What's New note carries it
    expect(read('components/flows/formation-names.tsx')).toContain('Client note:')
    expect(read('lib/operations/decision-request.ts')).toContain('emitDecisionRespondedEvent')
  })

  it('the answer route passes the refusal CODE through, and the card shows a translated sentence for it', () => {
    expect(read('app/api/portal/decisions/[id]/respond/route.ts')).toContain('...(result.code ? { code: result.code } : {})')
    const card = read('components/portal/decision-card.tsx')
    expect(card).toContain('byCode[data.code]')
    expect(card).toContain('whitespace-pre-line') // an answered card keeps the line breaks of the names
  })

  it('the state\'s stamped document is stored with the generic client type, only for Company Change Name at the client-safe step', () => {
    const s = read('app/api/flows/[id]/upload-document/route.ts')
    expect(s).toContain("sd.service_type === 'Company Change Name' && isClientSafeFlowDoc(sd.service_type, flowStage, false) ? GENERIC_CLIENT_TYPE : null")
    expect(s).toContain("import { GENERIC_CLIENT_TYPE } from '@/lib/crm-store/save-for-account'")
  })

  it('the staff panel learns whether the client already has the form, and says so instead of offering to ask again', () => {
    expect(read('app/api/flows/[id]/name-check/route.ts')).toContain('names_ask_open')
    const panel = read('components/flows/formation-names.tsx')
    expect(panel).toContain('data.names_ask_open === true')
    expect(panel).toContain('The client has the names form in their portal.')
  })

  it('the staff "Go back" button names the step by its own name, not the client\'s wording', () => {
    expect(read('app/(dashboard)/flows/[id]/page.tsx')).toContain('previousStageLabel={previousStageRow.stage_name}')
  })
})
