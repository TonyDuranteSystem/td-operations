/**
 * What a file REALLY is, from its first bytes — not from the name or the declared type
 * (N0, dev job f907220c). Used after a client uploads the signed contract or a wire
 * receipt through a one-time link, so a file that is not a PDF/image is removed rather
 * than filed as a signed contract or a proof of payment.
 */

export type SniffedKind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | null

export function sniffFileKind(head: Uint8Array): SniffedKind {
  const b = head
  const at = (i: number) => (i < b.length ? b[i] : -1)
  const ascii = (from: number, len: number) => {
    let s = ''
    for (let i = from; i < from + len && i < b.length; i++) s += String.fromCharCode(b[i])
    return s
  }
  if (ascii(0, 5) === '%PDF-') return 'pdf'
  if (at(0) === 0x89 && ascii(1, 3) === 'PNG') return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (ascii(0, 4) === 'GIF8') return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  if (ascii(4, 4) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis|avif)$/.test(ascii(8, 4))) return 'heic'
  return null
}

export const MAX_SIGNED_PDF_BYTES = 30 * 1024 * 1024
export const MAX_WIRE_RECEIPT_BYTES = 25 * 1024 * 1024
