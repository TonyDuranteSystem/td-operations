import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('every ITIN document is saved in the person\'s ITIN folder (Antonio 2026-10-21)', () => {
  it('the ITIN workspace upload passes the itin folder for an ITIN case', () => {
    const src = read('app/api/flows/[id]/upload-document/route.ts')
    expect(src).toMatch(/folderKind:\s*sd\.service_type === 'ITIN' \? 'itin' : undefined/)
  })
  it('the staff upload of an ITIN document type goes to ITIN, a passport stays in Personal documents', () => {
    const src = read('app/api/crm/admin-actions/upload-document/route.ts')
    expect(src).toMatch(/!dt\.includes\('passport'\) && dt\.includes\('itin'\) \? 'itin' : undefined/)
    expect(src).toMatch(/folderKind: itinFolder/)
  })
  it('the generated W-7 / 1040-NR / Schedule OI are saved in the ITIN folder (already so)', () => {
    expect(read('app/api/itin-form-completed/route.ts')).toMatch(/documentType: doc\.type, folderKind: "itin"/)
  })
  it('the MCP generator keeps the passport rule (passport -> personal, the rest -> itin)', () => {
    expect(read('lib/mcp/tools/itin-form.ts')).toMatch(/folderKind: documentType === "passport" \? "personal" : "itin"/)
  })
})
