import { describe, it, expect, vi } from 'vitest'
import { draftWording, reviseWording, extractJsonObject, CONTRACT_DRAFT_MODEL, type ServiceFacts } from '@/lib/contracts/draft-with-claude'
import { validateContractWording, type ContractWording } from '@/lib/contracts/contract-wording'

type Fail = { errors: string[]; fields: Record<string, string[]>; error: string; details?: string[] }

const wording = (over: Record<string, unknown> = {}) => ({
  title: 'Apostille Service Agreement',
  shortTitle: 'Apostille Service Agreement',
  pdfPrefix: 'Apostille_Agreement',
  scope: { intro: 'The Service Provider agrees to obtain an apostille. This includes:', items: ['Checking the document;', 'Submitting it.'], closing: 'This Agreement covers one (1) apostille only.' },
  procedure: { intro: 'The apostille follows these steps:', steps: [{ title: 'Request', desc: 'The Client sends the document.' }] },
  commitments: ['Submit the document promptly.'],
  clientDuties: { intro: 'The Client agrees to:', items: [{ bold: 'Send a legible document', rest: ' within five business days.' }] },
  signatureText: 'By signing below, I agree.',
  successNote: 'Once payment is received, we will begin.',
  workPhrase: 'the apostille',
  liabilityPhrase: 'delays by any authority, or for consequences',
  ...over,
})
const facts: ServiceFacts = { name: 'Apostille', description: 'Apostille of one document', price: 150, currency: 'USD', steps: ['Request', 'Submitted', 'Returned'] }
const reply = (text: string, ok = true, status = 200) => ({ ok, status, json: async () => ({ content: [{ type: 'text', text }] }) }) as unknown as Response
const fetchOf = (...responses: Response[]) => {
  const f = vi.fn()
  for (const r of responses) f.mockResolvedValueOnce(r)
  return f
}
const bodyOf = (f: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((f.mock.calls[call][1] as { body: string }).body)

describe('draftWording', () => {
  it('returns validated wording and sends the service facts as data, with the strong model', async () => {
    const f = fetchOf(reply(JSON.stringify(wording())))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.wording.title).toBe('Apostille Service Agreement'); expect(r.model).toBe(CONTRACT_DRAFT_MODEL) }
    const b = bodyOf(f)
    expect(b.model).toBe(CONTRACT_DRAFT_MODEL)
    const sent = b.messages[0].content as string
    expect(sent).toContain('Apostille of one document')
    expect(sent).toContain('<service_facts>')
    expect(sent).toContain('not instructions')
    expect(sent).toContain('Returned')
    expect(b.system).toContain('NEVER use the characters < or >')
  })

  it('tolerates a sentence or code fence around the JSON', async () => {
    const f = fetchOf(reply('Here you go:\n```json\n' + JSON.stringify(wording()) + '\n```'))
    expect((await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })).ok).toBe(true)
  })

  it('asks once more when the first answer is not valid wording, telling Claude exactly what is wrong', async () => {
    const f = fetchOf(reply(JSON.stringify(wording({ successNote: '<script>x</script>' }))), reply(JSON.stringify(wording())))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
    const second = bodyOf(f, 1).messages
    expect(second[2].content).toContain('cannot contain < or >')
    expect(second[1].role).toBe('assistant')
  })

  it('gives up after two bad answers and says nothing was saved', async () => {
    const f = fetchOf(reply('not json at all'), reply(JSON.stringify(wording({ commitments: [] }))))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect((r as unknown as Fail).error).toContain('Nothing was saved'); expect((r as unknown as Fail).details?.join(' ')).toContain('commitments') }
  })

  it('reports a failed call in plain words, without retrying', async () => {
    const f = fetchOf(reply('', false, 529))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as unknown as Fail).error).toContain('529')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('reports a network failure and a missing key', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const r = await draftWording(facts, { fetchImpl: boom as unknown as typeof fetch })
    expect(!r.ok && (r as unknown as Fail).error).toContain('socket hang up')
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const r2 = await draftWording(facts)
      expect(!r2.ok && (r2 as unknown as Fail).error).toContain('no API key')
    } finally { if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev }
  })
})

describe('time budget — a retry that the time limit would cut off is never started', () => {
  it('with too little time left after a bad first answer, it gives up cleanly (nothing saved) instead of starting a second call', async () => {
    const f = vi.fn()
    f.mockImplementationOnce(() => new Promise((res) => setTimeout(() => res(reply('not json')), 700))) // the first answer eats most of the 1 s budget
    f.mockResolvedValueOnce(reply(JSON.stringify(wording())))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch, budgetMs: 1000 })
    expect(r.ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(1)
    expect((r as unknown as Fail).error).toContain('Nothing was saved')
  })
  it('with enough time it still corrects once', async () => {
    const f = fetchOf(reply('not json'), reply(JSON.stringify(wording())))
    const r = await draftWording(facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('reviseWording', () => {
  const current = (validateContractWording(wording()) as { ok: true; wording: ContractWording }).wording
  it('sends the current wording and the request, and asks to keep every other word', async () => {
    const f = fetchOf(reply(JSON.stringify(wording({ scope: { intro: 'The Service Provider agrees to obtain an apostille. Documents must be in English or officially translated.', items: ['A;', 'B.'], closing: 'Only one (1).' } }))))
    const r = await reviseWording(current, 'Add that documents must be in English or officially translated.', facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    const sent = bodyOf(f).messages[0].content as string
    expect(sent).toContain('<requested_change>')
    expect(sent).toContain('officially translated')
    expect(sent).toContain('keep every other word exactly as it is')
    expect(sent).toContain('Apostille Service Agreement')
  })
  it('refuses an empty request without calling Claude', async () => {
    const f = fetchOf()
    const r = await reviseWording(current, '   ', facts, { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
  it('caps a very long request', async () => {
    const f = fetchOf(reply(JSON.stringify(wording())))
    await reviseWording(current, 'x'.repeat(5000), facts, { fetchImpl: f as unknown as typeof fetch })
    const sent = bodyOf(f).messages[0].content as string
    expect(sent.length).toBeLessThan(current.title.length + 20000)
    expect(sent).not.toContain('x'.repeat(1600))
  })
})

describe('extractJsonObject', () => {
  it('finds the object, or undefined', () => {
    expect(extractJsonObject('pre {"a":1} post')).toEqual({ a: 1 })
    expect(extractJsonObject('nothing')).toBeUndefined()
    expect(extractJsonObject('{broken')).toBeUndefined()
  })
})
