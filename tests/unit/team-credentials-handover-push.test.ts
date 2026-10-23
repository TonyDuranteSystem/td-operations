import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { generatePassword, usernameFromName, suggestUsername } from '@/lib/portal/team/credentials'
import { buildHandoverMessage } from '@/lib/portal/team/handover'
import { pushSubscriptionScope } from '@/lib/portal/team/push-scope'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

describe('generatePassword', () => {
  it('is 3 groups of 4 from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword()
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/)
      expect(p).not.toMatch(/[01OIl]/)
    }
  })
  it('is not the same twice and uses every byte fairly (rejects the biased tail)', () => {
    expect(generatePassword()).not.toBe(generatePassword())
    // bytes 255.. are above the unbiased limit and must be skipped, so a run of 255s still terminates once real bytes arrive
    let n = 0
    const p = generatePassword((len) => { n++; return new Uint8Array(len).map((_, i) => (n === 1 ? 255 : i)) })
    expect(p.replace(/-/g, '')).toHaveLength(12)
  })
})

describe('usernameFromName / suggestUsername', () => {
  it('lowercases, drops accents and odd characters', () => {
    expect(usernameFromName('Marco Rossi')).toBe('marco.rossi')
    expect(usernameFromName('  José  Álvarez-Núñez ')).toBe('jose.alvarez.nunez')
    expect(usernameFromName("D'Angelo")).toBe('d.angelo')
  })
  it('always satisfies the username rule, even for short or empty names', () => {
    for (const n of ['Al', '', '★', 'Wu']) expect(usernameFromName(n)).toMatch(/^[a-z0-9._-]{3,30}$/)
  })
  it('numbers the name when taken', async () => {
    const taken = new Set(['marco.rossi', 'marco.rossi2'])
    expect(await suggestUsername('Marco Rossi', async (u) => taken.has(u))).toBe('marco.rossi3')
  })
})

describe('handover message', () => {
  const base = { displayName: 'Marco Rossi', companyName: 'Lead Lift LLC', loginUrl: 'https://portal.tonydurante.us/portal/login', username: 'marco.rossi', password: 'Abcd-Efgh-Jkmn' }
  it('English, new: link, username, password, first-login change, and how to get alerts', () => {
    const m = buildHandoverMessage({ ...base, lang: 'en', kind: 'new' })
    for (const x of ['Hi Marco,', 'Lead Lift LLC', 'https://portal.tonydurante.us/portal/login', 'Username: marco.rossi', 'Temporary password: Abcd-Efgh-Jkmn', 'choose your own password', 'Home Screen', 'Enable notifications']) expect(m).toContain(x)
  })
  it('Italian, new', () => {
    const m = buildHandoverMessage({ ...base, lang: 'it', kind: 'new' })
    for (const x of ['Ciao Marco,', 'Nome utente: marco.rossi', 'Password temporanea: Abcd-Efgh-Jkmn', 'scegliere una tua password', 'schermata Home', 'Enable notifications']) expect(m).toContain(x)
  })
  it('reset: says so and leaves out the app-install steps', () => {
    const m = buildHandoverMessage({ ...base, lang: 'en', kind: 'reset' })
    expect(m).toContain('has been reset')
    expect(m).not.toContain('Home Screen')
  })
})

describe('pushSubscriptionScope: a team member may subscribe only to their own company, with chat', () => {
  const mate = (caps: Record<string, boolean>): PortalIdentity => ({ kind: 'teammate', teamMemberId: 't', accountId: 'A', displayName: 'V', email: null, capabilities: caps })
  it('own company with chat: allowed, stored under their company even if none was sent', () => {
    expect(pushSubscriptionScope(mate({ chat: true }), 'A')).toMatchObject({ allowed: true, accountId: 'A' })
    expect(pushSubscriptionScope(mate({ chat: true }), null)).toMatchObject({ allowed: true, accountId: 'A' })
  })
  it("another company's alerts: refused", () => {
    expect(pushSubscriptionScope(mate({ chat: true }), 'B')).toMatchObject({ allowed: false, error: 'Access denied' })
  })
  it('without the chat permission: refused', () => {
    expect(pushSubscriptionScope(mate({ documents: true }), 'A').allowed).toBe(false)
  })
  it('clients and staff are unchanged here', () => {
    expect(pushSubscriptionScope({ kind: 'contact', contactId: 'C', accountIds: ['A'] }, 'B')).toMatchObject({ allowed: true, accountId: null })
    expect(pushSubscriptionScope({ kind: 'none' }, 'B').allowed).toBe(true)
  })
})

describe('wiring (read from the source)', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('team member shell: password gate, push switch and install prompts, only with chat', () => {
    const l = read('app/portal/layout.tsx')
    const tm = l.slice(l.indexOf("kind === 'team_member'"), l.indexOf('const contactId = getClientContactId(user)'))
    expect(tm).toContain('<PasswordGate')
    expect(tm).toContain('<PushToggle')
    expect(tm).toContain('<EnablePushCard')
    expect(tm).toContain('<PwaInstallPrompt')
    expect(tm).toContain('tmCanChat')
  })
  it("the sidebar shows a team member's own name, never the hidden internal address", () => {
    expect(read('components/portal/portal-sidebar.tsx')).toContain('meta.display_name')
  })
  it('push route checks a team member as one', () => {
    const r = read('app/api/portal/push/route.ts')
    expect(r).toContain('pushSubscriptionScope(')
    expect(r).toContain('resolvePortalIdentity(')
  })
  it('API: create returns the credentials once and takes no email/password; reset generates one', () => {
    const c = read('app/api/portal/team/route.ts')
    expect(c).toContain('password: result.password')
    expect(c).not.toContain('body.email')
    expect(c).not.toContain('body.password')
    const r = read('app/api/portal/team/[id]/reset-password/route.ts')
    expect(r).toContain('resetTeammatePassword(params.id, accountId)')
    expect(r).not.toContain('body.password')
  })
  it('Team page: no email or password fields, handover pop-up, the notice for Nicholas and the members rule', () => {
    const t = read('components/portal/team-manager.tsx')
    expect(t).not.toContain('Email (optional)')
    expect(t).not.toContain('placeholder="min 8 characters"')
    expect(t).not.toContain("prompt(`New password")
    expect(t).toContain('data-testid="team-handover"')
    expect(t).toContain('only through the app on their phone')
    expect(t).toContain('must not be added here')
  })
})
