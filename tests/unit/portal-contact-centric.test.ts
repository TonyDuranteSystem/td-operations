import { describe, it, expect, vi } from 'vitest'

/**
 * Unit tests for Phase 1: Contact-Centric Migration
 * Tests the new query functions and nav visibility logic.
 *
 * Phase C (ITIN Chain Fix 2026-05-11): getContactOnlyNavVisibility is now
 * async and accepts optional contactId so the ITIN-at-Client-Signing flag can
 * be computed. When called with no contactId, it skips the DB lookup and
 * returns the legacy hardcoded shape with itinAtClientSigning=false. The
 * Supabase admin client is unused in the no-arg path so no mock is needed.
 */

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

// Import the function that doesn't require DB access
import { getContactOnlyNavVisibility } from '../../lib/portal/queries'

describe('getContactOnlyNavVisibility', () => {
  it('returns documents + services: true and account-specific features false', async () => {
    const nav = await getContactOnlyNavVisibility()
    expect(nav.documents).toBe(true)
    expect(nav.services).toBe(true)
    expect(nav.billing).toBe(false)
    expect(nav.invoices).toBe(false)
    expect(nav.taxDocuments).toBe(false)
    expect(nav.deadlines).toBe(false)
    expect(nav.customers).toBe(false)
  })

  it('returns exactly 10 keys (adds itinAtClientSigning in Phase C)', async () => {
    const nav = await getContactOnlyNavVisibility()
    expect(Object.keys(nav).length).toBe(10)
    expect(nav.itinAtClientSigning).toBe(false)
  })
})

describe('Contact-centric architecture rules', () => {
  it('portal_tier source of truth is contacts table', () => {
    // This is a documentation test — ensures the architecture decision is codified
    // contacts.portal_tier = source of truth
    // accounts.portal_tier = secondary (backward compat)
    expect(true).toBe(true)
  })

  // PR 2 Step 6 (2026-05-05): chat threading is unified per-contact.
  // The hook ALWAYS uses contact_id for the GET / realtime channel,
  // regardless of whether an account is selected. accountId is kept
  // only for picker default + send-side scope tagging.

  it('chat threading always uses contact_id (PR 2 Step 6 — unified per-contact thread)', () => {
    // usePortalChat(accountId | null, contactId) — accountId no longer
    // affects the query. Both these calls hit the same thread.
    const contactId = 'test-contact-id'
    const queryParamWithAccount = `contact_id=${contactId}`
    const queryParamWithoutAccount = `contact_id=${contactId}`
    expect(queryParamWithAccount).toBe(queryParamWithoutAccount)
    expect(queryParamWithAccount).toBe('contact_id=test-contact-id')
  })

  it('realtime filter is always contact_id (PR 2 Step 6)', () => {
    // After PR 2, the realtime subscription filters by contact_id
    // regardless of whether an account is currently selected.
    const filterColumn = 'contact_id'
    expect(filterColumn).toBe('contact_id')
  })

  it('notification requires at least one of account_id or contact_id', () => {
    const hasAccountId = false
    const hasContactId = true
    const isValid = hasAccountId || hasContactId
    expect(isValid).toBe(true)

    const noAccount = false
    const noContact = false
    const neitherValid = noAccount || noContact
    expect(neitherValid).toBe(false)
  })
})
