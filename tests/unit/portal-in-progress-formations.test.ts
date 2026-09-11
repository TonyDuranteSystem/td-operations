import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/portal/queries.ts::getInProgressFormations — the client-facing label for
 * an in-progress (not yet materialized) Company Formation. Zero coverage
 * before this file (2026-09-11, dev job cb771564) — a real gap: it let a
 * genuine production regression ship and go unnoticed. Retiring the old
 * contact-page name tool deleted the only writer of
 * wizard_progress.data.chosen_name_final/chosen_name, the field this label
 * used to read — with nothing reading the NEW Name Command Center's
 * confirmed name instead, every in-progress formation's label silently
 * collapsed to the generic "Company Formation" placeholder. Confirmed live in
 * production before the fix: exactly one real in-flight client (name "Salemark
 * llc", filed the day before) was already showing the placeholder.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { getInProgressFormations } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'

const CONTACT_ID = 'contact-1'

/** Minimal per-table mock: service_deliveries/leads/offers resolve directly
 *  (the real code never calls .single()/.maybeSingle() on them); wizard_progress
 *  uses .maybeSingle(). leads/offers are empty by default — this file is about
 *  the name label, not lead attribution. */
function installFrom(opts: { sd: Record<string, unknown>; wizardData?: Record<string, unknown> | null }) {
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'service_deliveries') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [opts.sd], error: null }).then(resolve),
      }
      return chain
    }
    if (table === 'leads' || table === 'offers') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        order: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      }
      return chain
    }
    if (table === 'wizard_progress') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: opts.wizardData === undefined ? null : opts.wizardData ? { data: opts.wizardData } : null, error: null }),
      }
      return chain
    }
    const fallback: Record<string, unknown> = {
      select: () => fallback,
      eq: () => fallback,
      is: () => fallback,
      or: () => fallback,
      order: () => fallback,
      limit: () => fallback,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    }
    return fallback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
}

const BASE_SD = {
  id: 'sd-1',
  service_name: 'Company Formation',
  notes: null,
  source_offer_token: null,
}

describe('getInProgressFormations — client-facing label', () => {
  beforeEach(() => {
    vi.mocked(supabaseAdmin.from).mockReset()
  })

  it('shows the name from the Name Command Center once it is sent to the client — the primary, current path', async () => {
    installFrom({
      sd: { ...BASE_SD, name_checks: [{ name: 'Salemark llc', source: 'client_resubmit', status: 'filed', updated_at: null }] },
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('Salemark llc')
  })

  it('REGRESSION PIN: does not silently fall back to the generic placeholder when name_checks has a confirmed name and wizard_progress has none', async () => {
    // Exact shape of the real production row this bug was found on: name_checks
    // has a filed name, but chosen_name/chosen_name_final are both null because
    // the retired contact-page tool never touched this formation.
    installFrom({
      sd: { ...BASE_SD, name_checks: [{ name: 'Salemark llc', source: 'client_resubmit', status: 'filed', updated_at: null }] },
      wizardData: { chosen_name: null, chosen_name_final: null },
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r[0].label).toBe('Salemark llc')
    expect(r[0].label).not.toBe('Company Formation')
  })

  it('falls back to the legacy wizard_progress field for a formation named through the now-retired tool before this fix existed', async () => {
    installFrom({
      sd: { ...BASE_SD, name_checks: [] },
      wizardData: { chosen_name_final: 'Legacy Named LLC' },
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r[0].label).toBe('Legacy Named LLC')
  })

  it('prefers the Name Command Center name over a stale legacy wizard_progress value when both exist', async () => {
    installFrom({
      sd: { ...BASE_SD, name_checks: [{ name: 'Current Real Name LLC', source: 'wizard', status: 'accepted', updated_at: null }] },
      wizardData: { chosen_name_final: 'Old Stale Name LLC' },
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r[0].label).toBe('Current Real Name LLC')
  })

  it('does not show a still-pending or dead candidate — falls through to the next label tier instead', async () => {
    installFrom({
      sd: {
        ...BASE_SD,
        name_checks: [
          { name: 'Not Available LLC', source: 'wizard', status: 'not_available', updated_at: null },
          { name: 'Still Pending LLC', source: 'wizard', status: 'pending', updated_at: null },
        ],
      },
      wizardData: null,
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r[0].label).not.toBe('Not Available LLC')
    expect(r[0].label).not.toBe('Still Pending LLC')
    // Neither candidate qualifies, so this falls to the SD's own generic
    // service_name (unchanged pre-existing behavior — BASE_SD's default).
    expect(r[0].label).toBe('Company Formation')
  })

  it('falls all the way to the generic placeholder when there is truly nothing — no confirmed name and no service_name either', async () => {
    installFrom({
      sd: { ...BASE_SD, service_name: null, name_checks: [] },
      wizardData: null,
    })
    const r = await getInProgressFormations(CONTACT_ID)
    expect(r[0].label).toBe('New company (in formation)')
  })
})
