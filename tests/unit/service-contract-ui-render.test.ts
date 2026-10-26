import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContractPreview, CONTRACT_PREVIEW_CSS, previewFee } from '@/components/service-contracts/contract-preview'
import { ContractEditor } from '@/components/service-contracts/contract-editor'
import { InlineText } from '@/components/contracts/agreement-body'
import { OfferBlockedDialog } from '@/components/offers/offer-blocked-dialog'
import { toEditable, editableToWording, validateContractWording, type ContractWording } from '@/lib/contracts/contract-wording'

const wording = (validateContractWording({
  title: 'Apostille Service Agreement', shortTitle: 'Apostille Service Agreement', pdfPrefix: 'Apostille_Agreement',
  scope: { intro: 'The Service Provider agrees to obtain an apostille. This includes:', items: ['Checking the document;', 'Submitting it to the **competent authority**.'], closing: 'This Agreement covers one (1) apostille only.' },
  procedure: { intro: 'Steps:', steps: [{ title: 'Request', desc: 'The Client sends the document.' }] },
  commitments: ['Submit the document promptly.'],
  clientDuties: { intro: 'The Client agrees to:', items: [{ bold: 'Send a complete and legible document', rest: '; and answer questions within five (5) business days.' }] },
  signatureText: 'By signing below, I agree to this Apostille Service Agreement.', successNote: 'Once payment is received, we will begin.',
  workPhrase: 'the apostille', liabilityPhrase: 'delays by any authority',
}) as { ok: true; wording: ContractWording }).wording

describe('InlineText — **bold** becomes <strong>, and nothing else becomes markup', () => {
  const r = (text: string) => renderToStaticMarkup(createElement(InlineText, { text }))
  it('plain text is unchanged', () => expect(r('Plain text.')).toBe('Plain text.'))
  it('paired marks become strong without the stars', () => expect(r('a **b** c')).toBe('a <strong>b</strong> c'))
  it('markup in the text is escaped, never rendered', () => {
    expect(r('<script>x</script> **b**')).toContain('&lt;script&gt;')
    expect(r('<script>x</script> **b**')).not.toContain('<script>')
  })
})

describe('ContractPreview — the contract as the client reads it', () => {
  const html = renderToStaticMarkup(createElement(ContractPreview, { wording, serviceName: 'Apostille', serviceDescription: 'One document', price: 150, currency: 'USD' }))
  it('shows the title, the parties with a sample client, the fee and all eight sections', () => {
    expect(html).toContain('Apostille Service Agreement')
    expect(html).toContain('Mario Rossi')
    expect(html).toContain('$150')
    for (const h of ['1. Scope of Service', '2. Client Responsibilities', '3. Service Procedure', '4. Service Provider Commitments', '5. Payment', '6. Limitation of Liability', '7. Governing Law', '8. Electronic Signatures']) expect(html).toContain(h)
  })
  it('uses the stored phrases, never the tax-return sentence', () => {
    expect(html).toContain('before the apostille begins')
    expect(html).toContain('delays by any authority')
    expect(html).not.toContain('tax return')
  })
  it('bold marks show as bold and the stars are gone', () => {
    expect(html).toContain('<strong>competent authority</strong>')
    expect(html).not.toContain('**')
  })
  it('ends with the acceptance sentence and a signature placeholder (the real box is the client page’s)', () => {
    expect(html).toContain('By signing below, I agree to this Apostille Service Agreement.')
    expect(html).toContain('signature box appear here')
  })
  it('a service with no price shows a visible placeholder, EUR uses its symbol, big numbers get commas', () => {
    expect(previewFee(null, 'USD')).toBe('[price]')
    expect(previewFee(99.5, 'EUR')).toBe('€99.50')
    expect(previewFee(1500, 'USD')).toBe('$1,500')
  })
  it('its styles are scoped to the preview, so they cannot restyle the dashboard', () => {
    for (const line of CONTRACT_PREVIEW_CSS.split('\n').filter((l) => l.includes('{'))) expect(line.trimStart().startsWith('.contract-preview'), line).toBe(true)
    expect(CONTRACT_PREVIEW_CSS).not.toMatch(/(^|\n)\s*(body|html|:root)\b/)
  })
  it('has a rule for every contract class the agreement body uses', () => {
    const src = readFileSync(join(process.cwd(), 'components/contracts/agreement-body.tsx'), 'utf8')
    const used = Array.from(new Set(Array.from(src.matchAll(/className="([^"]+)"/g)).flatMap((m) => m[1].split(/\s+/))))
    expect(used.length).toBeGreaterThan(0)
    for (const c of used) expect(CONTRACT_PREVIEW_CSS, c).toContain(`.${c}`)
  })
})

describe('ContractEditor — every line is a box, errors sit under their line', () => {
  const editable = toEditable(wording)
  const html = renderToStaticMarkup(createElement(ContractEditor, { value: editable, onChange: () => {}, fieldErrors: {} }))
  it('has a box for each editable part, with its text', () => {
    for (const label of ['Title', 'Scope introduction', 'Scope item 1', 'Scope item 2', 'Scope closing sentence', 'Client responsibility 1', 'Step 1 title', 'Step 1 description', 'Commitment 1', 'Work phrase', 'Liability phrase', 'Acceptance sentence', 'Message after signing']) {
      expect(html, label).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('**Send a complete and legible document**')
    expect(html).toContain('standard text and are not edited here')
  })
  it('every list line has a visible placeholder that is NOT valid wording (an empty new line cannot be saved or approved by accident)', () => {
    expect(html).toContain('placeholder="Type the line here"')
    expect(html).toContain('placeholder="Start with the heading between stars, then the sentence: **Heading** and the rest;"')
    const e = toEditable(wording)
    e.clientDuties.items = [...e.clientDuties.items, '']
    expect(editableToWording(e).ok).toBe(false) // a new, empty client-responsibility line is refused until it is written
  })
  it('offers add and remove for every list', () => {
    expect(html).toContain('Add a line')
    expect(html).toContain('Add a step')
    expect(html).toContain('aria-label="Remove scope item 1"')
  })
  it('shows each problem right under its own line, in red', () => {
    const bad = renderToStaticMarkup(createElement(ContractEditor, { value: editable, onChange: () => {}, fieldErrors: { 'scope.items.1': ['Scope items #2 cannot contain < or > (plain text only)'], 'commitments': ['Service Provider commitments needs at least one entry'] } }))
    expect(bad).toContain('Scope items #2 cannot contain')
    expect(bad).toContain('needs at least one entry')
    expect((bad.match(/data-field-error/g) ?? []).length).toBe(2)
    expect(bad).toContain('aria-invalid="true"')
  })
  it('read-only when disabled', () => {
    const off = renderToStaticMarkup(createElement(ContractEditor, { value: editable, onChange: () => {}, fieldErrors: {}, disabled: true }))
    expect(off).toContain('disabled=""')
  })
})

describe('OfferBlockedDialog (screen 4)', () => {
  const html = renderToStaticMarkup(createElement(OfferBlockedDialog, {
    onClose: () => {},
    blockers: [
      { kind: 'contract', serviceName: 'Apostille', href: '/service-catalog/apostille/edit#contract', message: '"Apostille" has a contract draft that still needs the owner\'s approval — approve it in the Service Catalog (Contract), then send the offer again.' },
      { kind: 'steps', serviceName: 'Notary plus', href: '/service-catalog/notary_plus/edit#contract', message: '"Notary plus" has no steps yet.' },
      { kind: 'not_in_catalog', message: '"Nope" is not in the Service Catalog.' },
    ],
  }))
  it('says nothing was sent and the client sees nothing', () => {
    expect(html).toContain('This offer can’t be sent yet')
    expect(html).toContain('Nothing was sent. The client sees nothing.')
    expect(html).toContain('Once this is fixed, send the offer again.')
  })
  it('the "build the offer again" reason has NO link (opening the contract would not fix it)', () => {
    const h = renderToStaticMarkup(createElement(OfferBlockedDialog, { onClose: () => {}, blockers: [{ kind: 'offer_type', serviceName: 'Apostille', message: 'set up with the "formation" contract … delete this draft offer and create it again.' }] }))
    expect(h).toContain('delete this draft offer and create it again')
    expect(h).not.toContain('<a ')
  })
  it('lists each reason; a contract reason says "Open contract", other reasons "Open service", an unlinkable one has no link', () => {
    expect(html).toContain('Open contract')
    expect(html).toContain('Open service')
    expect(html).toContain('href="/service-catalog/apostille/edit#contract"')
    expect((html.match(/<a /g) ?? []).length).toBe(2)
    expect(html).toContain('&quot;Nope&quot; is not in the Service Catalog.')
    expect(html).toContain('target="_blank"')
  })
})
