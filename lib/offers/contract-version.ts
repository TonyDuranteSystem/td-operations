/**
 * Which version of the contract TEXT an offer was sent with / a client signed
 * (N0b, dev job f907220c, Antonio-approved plan v3; second version 2026-11-08, dev job 753b2909).
 *
 * The contract texts live in the signing components (formation MSA, onboarding,
 * standalone, renewal). Until N1a stores frozen texts as permanent rows, the page keeps the
 * wording of EACH version in code and picks it from the offer's own stamp:
 *
 *   offers.contract_version     stamped by the database DEFAULT on every new offer (all
 *                               insert paths, no code changes) — the version it was sent with.
 *   contracts.contract_version  written by the server at signing — the version the client
 *                               was actually shown (the offer's own stamp, see versionSignedFor).
 *   'pre-versioning'            offers already signed before this existed; their signed PDF
 *                               is the legal record.
 *
 * VERSIONS
 *   2026-09-30  the first stamped version. Portal Chat said "voice dictation".
 *   2026-11-08  the client's microphone records a real voice note, so the Portal Chat lines say
 *               "voice notes". ONLY offers created from then on carry it (the database default
 *               moved with it); every offer that already existed keeps '2026-09-30' and the old
 *               wording, exactly as it was sent or signed.
 *
 * ⛔ A new version is only ever added together with the wording it changes: keep the old
 * wording for the old version (see portalChatVoiceWording) and move the database default in a
 * migration. NEVER re-label an existing offer. Tests pin both values.
 */
export const LEGACY_CONTRACT_VERSION = '2026-09-30'

/** The version the database stamps on every new offer. The default in migration 20261108-1730 must equal it. */
export const CURRENT_CONTRACT_VERSION = '2026-11-08'

/** First version whose Portal Chat wording says "voice notes" instead of "voice dictation". */
export const VOICE_NOTE_WORDING_FROM = '2026-11-08'

export const PRE_VERSIONING = 'pre-versioning'

const DATED_VERSION = /^\d{4}-\d{2}-\d{2}$/

/** What the client-facing pages print, or null when nothing is stamped. */
export function contractVersionLabel(version: string | null | undefined): string | null {
  if (!version) return null
  if (version === PRE_VERSIONING) return null
  return `Contract version ${version}`
}

/** True for a dated version (e.g. '2026-11-08'); false for null, 'pre-versioning' or anything else. */
function isDatedVersion(version: unknown): version is string {
  return typeof version === 'string' && DATED_VERSION.test(version)
}

/**
 * Does this offer's contract say "voice notes" (true) or the old "voice dictation" (false)?
 * Decided ONLY from the offer's own stamp, so an offer that already exists never changes its wording.
 * An offer with no usable stamp (null, 'pre-versioning') was shown the old wording.
 */
export function usesVoiceNoteWording(version: string | null | undefined): boolean {
  return isDatedVersion(version) && version >= VOICE_NOTE_WORDING_FROM
}

/**
 * The version to record on the contract row when a client signs an OFFER contract: the one the offer
 * carries, because that is the text the page showed. No usable stamp = the old wording = the first version.
 */
export function versionSignedFor(offerVersion: string | null | undefined): string {
  return isDatedVersion(offerVersion) ? offerVersion : LEGACY_CONTRACT_VERSION
}

export type PortalChatVoiceWording = { bulletTitle: string; bulletBody: string; clauseSupport: string }

/**
 * The two Portal Chat lines of the contract that talk about the microphone — the bullet in the "Client Portal"
 * section and the end of clause 4.2. The OLD wording is kept byte for byte (offers created before 2026-11-08 must read
 * exactly as they were sent); the new wording is only for offers stamped 2026-11-08 or later.
 */
export function portalChatVoiceWording(version: string | null | undefined): PortalChatVoiceWording {
  if (usesVoiceNoteWording(version)) {
    return {
      bulletTitle: 'Voice notes',
      bulletBody: 'Press the microphone icon, record your message and send it. Tap "Show text" to read it.',
      clauseSupport: 'voice note support',
    }
  }
  return {
    bulletTitle: 'Voice dictation',
    bulletBody: 'Press the microphone icon, dictate your message. The portal transcribes automatically.',
    clauseSupport: 'voice dictation support',
  }
}
