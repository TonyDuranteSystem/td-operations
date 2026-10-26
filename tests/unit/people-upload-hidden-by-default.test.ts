import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const route = readFileSync('app/api/crm/admin-actions/upload-document/route.ts', 'utf8')
const page = readFileSync('components/contacts/contact-detail.tsx', 'utf8')

describe('People "Upload Document" is hidden and silent unless the staff member chooses otherwise', () => {
  it('shows the file to the client only when asked, never by default', () => {
    expect(route).toContain('const wantVisible = body.visible === true')
    expect(route).not.toMatch(/portalVisible: true/)
    expect(route).not.toMatch(/portal_visible: true/)
  })
  it('sends nothing to the client (alert, notification, chat, email) unless visible was chosen', () => {
    expect(route).toMatch(/if \(wantVisible\) \{\s*const \{ notifyClientsOfNewDocument \}/)
    expect(route).toMatch(/newDoc\?\.id && wantVisible/)
    expect((route.match(/if \(wantVisible\) try \{/g) ?? []).length).toBe(3)
  })
  it('hands the new document id back so the page can ask the usual "show / tell the client?" question', () => {
    expect(route).toContain('documentId: stored.documentRowId')
    expect(page).toContain('if (data.documentId)')
    expect(page).toMatch(/await handleToggleVisibility\(\{\s*id: data\.documentId/)
  })
})
