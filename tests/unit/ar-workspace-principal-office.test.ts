import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePrincipalOfficeDecision } from '@/lib/operations/principal-office'
import { principalOfficeAnswer, EMPTY_PRINCIPAL_OFFICE_DRAFT } from '@/lib/principal-office-draft'

// Found by the 2026-10-01 production QA: uploading the filing receipt in the State Annual Report WORKSPACE advanced the
// case without ever asking whether the principal address changed (only the Calendar / To-Do "Mark filed" path asked).
describe('State Annual Report workspace upload asks the principal-address question', () => {
  const route = readFileSync('app/api/flows/[id]/upload-document/route.ts', 'utf8')
  const component = readFileSync('components/flows/document-upload.tsx', 'utf8')
  const renderer = readFileSync('components/flows/stage-renderer.tsx', 'utf8')

  it('the route refuses a State Annual Report receipt without the answer, before saving anything', () => {
    const gate = route.indexOf("sd.service_type === 'State Annual Report'")
    const parse = route.indexOf('parsePrincipalOfficeDecision(body.principal_office)')
    const download = route.indexOf(".download(storagePath)")
    expect(gate).toBeGreaterThan(-1)
    expect(parse).toBeGreaterThan(gate)
    expect(download).toBeGreaterThan(parse)
    expect(route).toContain('{ status: 400 }')
  })
  it('the route records the answer and surfaces a failure to record it as a warning, never silently', () => {
    expect(route).toContain('applyPrincipalOfficeDecision(')
    expect(route).toContain('principal_office_warning')
  })
  it('the upload box is switched on for State Annual Report and holds the button until answered', () => {
    expect(renderer).toContain("requirePrincipalOffice={serviceDelivery.service_type === 'State Annual Report'}")
    expect(component).toContain('!principalOfficeReady')
    expect(component).toContain('principal_office: principalOfficeAnswer(principalOffice)')
  })
  it('no answer = no upload; an answer of "unchanged" or a full new address is accepted', () => {
    expect(parsePrincipalOfficeDecision(undefined).ok).toBe(false)
    expect(principalOfficeAnswer(EMPTY_PRINCIPAL_OFFICE_DRAFT)).toBeNull()
    expect(parsePrincipalOfficeDecision({ changed: false }).ok).toBe(true)
    expect(parsePrincipalOfficeDecision({ changed: true, address_line1: '1 A St', city: 'X', state: 'WY', zip: '82001' }).ok).toBe(true)
  })
})
