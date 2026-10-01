/**
 * Which version of the contract TEXT an offer was sent with / a client signed
 * (N0b, dev job f907220c, Antonio-approved plan v3).
 *
 * The contract texts live in the signing components (formation MSA, onboarding,
 * standalone, renewal). Until N1a stores frozen texts as permanent rows, there is ONE
 * version for all of them: today's texts.
 *
 *   offers.contract_version     stamped by the database DEFAULT on every new offer (all
 *                               insert paths, no code changes) — the version it was sent with.
 *   contracts.contract_version  written by the server at signing — the version the client
 *                               actually signed (the page renders today's text).
 *   'pre-versioning'            offers already signed before this existed; their signed PDF
 *                               is the legal record.
 *
 * ⛔ DO NOT CHANGE this value until N1a's frozen text rows exist. Bumping it today would
 * label old offers with a version whose text the page can no longer show. A unit test
 * pins it, and the DB default in migration 20260930-2330 must move with it.
 */
export const CURRENT_CONTRACT_VERSION = '2026-09-30'

export const PRE_VERSIONING = 'pre-versioning'

/** What the client-facing pages print, or null when nothing is stamped. */
export function contractVersionLabel(version: string | null | undefined): string | null {
  if (!version) return null
  if (version === PRE_VERSIONING) return null
  return `Contract version ${version}`
}
