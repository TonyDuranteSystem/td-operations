import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnouncementsTab, type AnnouncementRow } from '@/app/(dashboard)/config/announcement-manager'

// "App only" announcements (dev job 056a70d0): the database column, the CRM choice and badge, the API, and the rule that the website never draws them.

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const row = (over: Partial<AnnouncementRow> = {}): AnnouncementRow => ({
  id: 'r1', title: 'Welcome to the new TD App', message: 'Hello', title_en: 'Welcome to the new TD App', message_en: 'Hello', type: 'info',
  active: true, dismissible: true, app_only: false, active_from: null, active_until: null, created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z', ...over,
})

describe('migration', () => {
  const up = src('scripts/migrations/20261113-0010-portal-announcements-app-only.sql')
  const down = src('scripts/migrations/20261113-0010-portal-announcements-app-only.UNDO.sql')

  it('adds one plain boolean, off by default, so every existing announcement keeps showing everywhere', () => {
    expect(up).toContain('ALTER TABLE portal_announcements ADD COLUMN IF NOT EXISTS app_only boolean NOT NULL DEFAULT false;')
  })

  it('has no CHECK constraint (a new value-list CHECK on the shared sandbox turns every other session\'s CI red)', () => {
    const sql = up.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(sql.toUpperCase()).not.toContain('CHECK')
    expect(sql.toUpperCase()).not.toContain('CONSTRAINT')
  })

  it('can be undone', () => {
    expect(down).toContain('ALTER TABLE portal_announcements DROP COLUMN IF EXISTS app_only;')
  })
})

describe('CRM manager', () => {
  const html = (rows: AnnouncementRow[]) => renderToStaticMarkup(createElement(AnnouncementsTab, { initialRows: rows }))

  it('marks an app-only announcement with an "App only" badge and leaves the others plain', () => {
    const out = html([row({ id: 'a', app_only: true, title_en: 'Only in the app' }), row({ id: 'b', title_en: 'For everybody' })])
    expect((out.match(/data-testid="announcement-app-only-badge"/g) ?? []).length).toBe(1)
    expect(text(out)).toContain('Only in the app App only')
    expect(text(out)).not.toContain('For everybody App only')
  })

  it('the form has the "Show in" choice (Everywhere / App only), sends it on save, and starts on the row\'s own value', () => {
    const m = src('app/(dashboard)/config/announcement-manager.tsx')
    expect(m).toContain('data-testid="announcement-show-in"')
    expect(m).toContain('Everywhere')
    expect(m).toContain('App only')
    expect(m).toContain('useState(row?.app_only === true)')
    expect(m).toContain('app_only: appOnly,')
  })

  it('the Announcements tab now loads the date columns too, so editing a row no longer blanks its dates', () => {
    const page = src('app/(dashboard)/config/page.tsx')
    expect(page).toContain('active_from, active_until, app_only')
  })
})

describe('API', () => {
  it('create stores app_only only when it is exactly true, and the list and the answers carry the column', () => {
    const r = src('app/api/crm/portal-announcements/route.ts')
    expect(r).toContain('app_only: body.app_only === true,')
    expect((r.match(/active_until, app_only, created_at/g) ?? []).length).toBe(2)
  })

  it('update changes app_only only when a real true/false is sent', () => {
    const r = src('app/api/crm/portal-announcements/[id]/route.ts')
    expect(r).toContain("if (typeof body.app_only === 'boolean') patch.app_only = body.app_only")
    expect(r).toContain('active_until, app_only, created_at')
  })

  it('the public announcements route never hands an app-only announcement to a website caller', () => {
    expect(src('app/api/portal/announcements/route.ts')).toContain(".eq('app_only', false)")
  })
})

describe('portal home', () => {
  const page = src('app/portal/page.tsx')

  it('reads the column, hands the WEBSITE banners the filtered list and the app\'s News the full list', () => {
    expect(page).toContain('active_from, active_until, app_only')
    expect(page).toContain('<AnnouncementBanners announcements={visibleOnWebsite(portalAnnouncements)}')
    expect(page).toContain('buildNewsItems({ locale, canManageTeam, announcements: portalAnnouncements })')
  })

  it('the generated database types know the column (Row, Insert, Update)', () => {
    const types = src('lib/database.types.ts')
    const at = types.indexOf('portal_announcements: {')
    const block = types.slice(at, types.indexOf('Relationships:', at))
    expect((block.match(/app_only/g) ?? []).length).toBe(3)
  })
})
