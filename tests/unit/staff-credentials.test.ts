import { describe, it, expect } from 'vitest'
import { generateTempPassword, buildStaffCredentialsEmail } from '@/lib/auth/staff-credentials'
import { tooltipPosition } from '@/lib/ui/tooltip-position'

describe('generateTempPassword', () => {
  it('has the TD prefix, ! suffix and the requested random length', () => {
    const pw = generateTempPassword()
    expect(pw).toMatch(/^TD[a-z2-9]{10}!$/)
    expect(generateTempPassword(14)).toMatch(/^TD[a-z2-9]{14}!$/)
  })

  it('never uses look-alike characters (0 O 1 l I)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTempPassword().slice(2, -1)).not.toMatch(/[01lIO]/)
    }
  })

  it('always contains at least one digit and one lowercase letter (strict password policies)', () => {
    for (let i = 0; i < 2000; i++) {
      const body = generateTempPassword().slice(2, -1)
      expect(body).toMatch(/[2-9]/)
      expect(body).toMatch(/[a-z]/)
    }
  })

  it('is not repeated across calls', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()))
    expect(seen.size).toBe(200)
  })
})

describe('buildStaffCredentialsEmail', () => {
  const base = { fullName: 'Luca Degsper', email: 'luca@tonydurante.us', tempPassword: 'TDabc234xyz!' }

  it('create email: subject, password, login link, role', () => {
    const { subject, html } = buildStaffCredentialsEmail({ ...base, kind: 'created', role: 'team' })
    expect(subject).toBe('Your Tony Durante CRM Account')
    expect(html).toContain('TDabc234xyz!')
    expect(html).toContain('/login')
    expect(html).toContain('Team Member')
  })

  it('reset email has its own subject and says the password was reset', () => {
    const { subject, html } = buildStaffCredentialsEmail({ ...base, kind: 'reset', role: 'admin' })
    expect(subject).toBe('Your Tony Durante CRM password was reset')
    expect(html).toContain('was reset by an administrator')
    expect(html).toContain('Administrator')
  })

  it('does not promise a forced change on first login (staff are not forced)', () => {
    const { html } = buildStaffCredentialsEmail({ ...base, kind: 'created' })
    expect(html).not.toContain('will be asked to change')
    expect(html).toContain('key icon')
  })

  it('omits the role line when no role is given', () => {
    const { html } = buildStaffCredentialsEmail({ ...base, kind: 'reset' })
    expect(html).not.toContain('Role:')
  })

  it('escapes HTML in the name so it cannot inject markup', () => {
    const { html } = buildStaffCredentialsEmail({ ...base, fullName: '<script>x</script>', kind: 'created' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('tooltipPosition', () => {
  const rect = { left: 100, right: 130, top: 30, bottom: 50, width: 30 }

  it('right-aligned label hangs off the right edge, 4px below', () => {
    expect(tooltipPosition(rect, 'right')).toEqual({ top: 54, left: 130, translateX: '-100%', translateY: '0' })
  })

  it('left-aligned label starts at the left edge', () => {
    expect(tooltipPosition(rect, 'left')).toEqual({ top: 54, left: 100, translateX: '0', translateY: '0' })
  })

  it('center-aligned label centres on the anchor', () => {
    expect(tooltipPosition(rect, 'center')).toEqual({ top: 54, left: 115, translateX: '-50%', translateY: '0' })
  })

  it('flips ABOVE the anchor when there is no room below in the viewport', () => {
    expect(tooltipPosition(rect, 'right', 70)).toEqual({ top: 26, left: 130, translateX: '-100%', translateY: '-100%' })
  })

  it('stays below when there is room', () => {
    expect(tooltipPosition(rect, 'right', 900).translateY).toBe('0')
  })
})
