import { parseNotesJson } from '@/lib/release/release-notes'

/**
 * The release notes compiled into THIS deployment (server side only — the browser asks /api/release/notes instead of carrying the
 * history). next.config.js reads content/releases/*.json at build time and puts the text in RELEASE_NOTES_JSON; Next.js inlines it
 * where it is written LITERALLY below. In unit tests and in a build with no notes folder it is empty → [].
 */
export const BUNDLED_NOTES = parseNotesJson(process.env.RELEASE_NOTES_JSON)
