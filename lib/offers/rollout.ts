/**
 * How a NEW offer-builder piece is rolled out (offer builder, dev job d2971d11). There is NO screen and NO button for
 * this: Claude sets the stored value when Antonio says so (his rule of 2026-11-04). Every new piece has three states:
 *
 *   off  — nobody sees it (the default; a missing row, a failed read, or anything unknown means off — fails CLOSED)
 *   test — it shows ONLY on records marked as test (leads / companies / contacts with is_test = true, e.g. Uxio Test LLC);
 *          a real client's offer looks exactly as it always did, for every staff member
 *   on   — everyone sees it
 *
 * Stored in app_settings under the piece's own key: the boolean `true` = on, the text "test" = test, anything else = off.
 *
 * Client-safe on purpose (no server imports): the screens never read the stored value themselves; they ask the staff
 * route /api/crm/admin-actions/offer-builder-features, which decides on the server (lib/offers/rollout-server.ts) and
 * answers with plain yes/no per piece. This file holds the rules both sides share.
 */

export const SEND_CHECK_BOX_KEY = 'offer_send_check_box_enabled' as const

/** The pieces, and the app_settings key each one is stored under. Add a new piece here and nowhere else. */
export const OFFER_BUILDER_FEATURE_KEYS = {
  sendCheckBox: SEND_CHECK_BOX_KEY, // Part 1: the box "Before this offer can be sent"
} as const

export type OfferBuilderFeature = keyof typeof OFFER_BUILDER_FEATURE_KEYS
export type RolloutMode = 'off' | 'test' | 'on'
export type OfferBuilderFeatures = Record<OfferBuilderFeature, boolean>

/** Everything hidden — what any untrusted answer turns into. */
export const NO_FEATURES: OfferBuilderFeatures = { sendCheckBox: false }

/**
 * A stored value → its mode. Only the boolean `true` means on and only the exact text "test" means test. The text
 * "true", "on", "TEST", the number 1, null (no row), objects, arrays: all off.
 */
export function parseRolloutValue(value: unknown): RolloutMode {
  if (value === true) return 'on'
  if (value === 'test') return 'test'
  return 'off'
}

/**
 * Can this piece be seen for this record? `subjectIsTest` is true / false when the record was found, null when it is
 * unknown (no record given, not found, a failed read) — and unknown never counts as test.
 */
export function featureVisible(mode: RolloutMode, subjectIsTest: boolean | null): boolean {
  if (mode === 'on') return true
  if (mode === 'test') return subjectIsTest === true
  return false
}

/**
 * The reply of GET /api/crm/admin-actions/offer-builder-features → what to show. Only a successful reply carrying the
 * boolean `true` for a piece shows that piece; an expired login, an error page or a malformed body hides everything.
 */
export function parseFeaturesReply(ok: boolean, body: unknown): OfferBuilderFeatures {
  if (!ok || !body || typeof body !== 'object') return { ...NO_FEATURES }
  const b = body as Record<string, unknown>
  return {
    sendCheckBox: b.sendCheckBox === true,
  }
}
