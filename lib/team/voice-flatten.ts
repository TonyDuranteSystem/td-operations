/**
 * Repair of voice notes that are ALREADY STORED as the fragmented MP4 Safari plays badly (dev job c1e326dd). New TD Talk
 * recordings are converted before upload (lib/media/fmp4-to-flat.ts); this converts the old ones, once, on the server, the
 * first time anyone opens the note. Pure helpers here; the route does the storage work.
 */

/** The bucket path of one of OUR team-chat audio files, taken from its public URL — null for anything else (never touch a path we did not create). */
export function teamChatAudioPath(url: string, supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null
  const prefix = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/assets/`
  if (!url.startsWith(prefix)) return null
  const path = decodeURIComponent(url.slice(prefix.length).split('?')[0])
  return /^team-chat\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(m4a|mp4)$/i.test(path) ? path : null
}

/** Where the untouched original is kept before it is replaced. */
export function backupPathFor(path: string): string {
  return path.replace(/^team-chat\//, 'team-chat-originals/')
}

export interface FlattenMark { flat: true; flattened_at: string }
