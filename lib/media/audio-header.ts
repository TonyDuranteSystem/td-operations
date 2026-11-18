/**
 * Is a recording damaged — does it have no audio header at all? (pure; TD Talk, 18 Nov 2026: a voice note that was only the tail of a longer
 * recording was sent. Its first bytes were a bare `moof` piece, no `ftyp`/`moov`, so no player could open it.)
 * Only files that CLAIM to be MP4/M4A or WebM are judged; any other kind is never called damaged (fail open).
 */

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]

function ascii(b: Uint8Array, from: number, len: number): string {
  let s = ''
  for (let i = from; i < from + len && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

/** What the file says it is: 'mp4' | 'webm' | null (anything else is left alone). */
export function claimedAudioKind(nameOrMime: string | null | undefined): 'mp4' | 'webm' | null {
  const s = (nameOrMime ?? '').toLowerCase()
  if (!s) return null
  if (s.includes('webm') || /\.webm$/.test(s)) return 'webm'
  if (s.includes('mp4') || s.includes('m4a') || /\.(m4a|mp4)$/.test(s)) return 'mp4'
  return null
}

/** True when the first bytes of a file that claims to be MP4/WebM are NOT a real header — i.e. a player cannot open it. */
export function isDamagedAudioHead(head: Uint8Array, nameOrMime: string | null | undefined): boolean {
  const kind = claimedAudioKind(nameOrMime)
  if (!kind) return false
  if (head.length < 12) return true // an MP4/WebM with not even a header's worth of bytes is not a recording
  if (kind === 'webm') return !EBML_MAGIC.every((v, i) => head[i] === v)
  const first = ascii(head, 4, 4)
  return first !== 'ftyp' && first !== 'moov'
}
