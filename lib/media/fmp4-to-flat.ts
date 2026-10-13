/**
 * Turn an iPhone/Chrome "fragmented" MP4 voice note into an ordinary (non-fragmented) MP4/M4A (dev job c1e326dd, TD Talk).
 *
 * WHY (proved on real Safari, 2026-10-13): MediaRecorder writes the recording as hundreds of tiny fragments. Safari plays
 * such a file badly — over HTTP it works out the length from what it has loaded so far (a note could be cut short until the app
 * was reopened) and, worse, if the header's length is filled in (our earlier "length patch") it counts every fragment twice:
 * a 42.9 s note was reported as 85.7 s and stopped halfway. A normal MP4 with the index up front (moov before mdat, "faststart")
 * is read exactly right by Safari (42.8 s) and plays progressively from the first second.
 *
 * It copies the compressed audio bytes untouched — nothing is re-encoded — and writes a standard sample table (stts/stsc/stsz/stco)
 * plus real durations. Pure and fail-safe: anything unexpected (not fragmented, not one audio track, malformed or truncated boxes)
 * returns null and the caller uploads the original recording unchanged.
 */

export interface FlatAudio {
  data: Uint8Array
  /** Total length in seconds, summed from the samples. */
  seconds: number
}

interface Box { type: string; start: number; size: number; header: number }

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let i = start
  while (i + 8 <= end) {
    let size = view.getUint32(i)
    const type = String.fromCharCode(view.getUint8(i + 4), view.getUint8(i + 5), view.getUint8(i + 6), view.getUint8(i + 7))
    let header = 8
    if (size === 1) {
      if (i + 16 > end) break
      size = Number(view.getBigUint64(i + 8))
      header = 16
    } else if (size === 0) {
      size = end - i
    }
    if (size < header || i + size > end) break
    out.push({ type, start: i, size, header })
    i += size
  }
  return out
}

const child = (view: DataView, parent: Box, type: string): Box | null =>
  readBoxes(view, parent.start + parent.header, parent.start + parent.size).find(b => b.type === type) ?? null

const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b }
const u16 = (n: number): Uint8Array => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b }
const ascii = (s: string): Uint8Array => Uint8Array.from(s, c => c.charCodeAt(0))
const zeros = (n: number): Uint8Array => new Uint8Array(n)

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}

const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = cat(...payload)
  return cat(u32(8 + body.length), ascii(type), body)
}

const MATRIX = cat(u32(0x00010000), zeros(12), u32(0x00010000), zeros(12), u32(0x40000000))

interface Sample { offset: number; size: number; duration: number }

/** Every sample of every fragment, in order, with where its bytes sit in the input. Null on any inconsistency. */
function collectSamples(view: DataView, top: Box[], trexDuration: number, trexSize: number): Sample[] | null {
  const samples: Sample[] = []
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of readBoxes(view, moof.start + moof.header, moof.start + moof.size).filter(b => b.type === 'traf')) {
      const inner = readBoxes(view, traf.start + traf.header, traf.start + traf.size)
      const tfhd = inner.find(b => b.type === 'tfhd')
      if (!tfhd) return null
      const tfFlags = view.getUint32(tfhd.start + tfhd.header) & 0xffffff
      let p = tfhd.start + tfhd.header + 8 // version+flags, track id
      let base = moof.start // default: the start of the enclosing moof (also what default-base-is-moof says)
      if (tfFlags & 0x1) { base = Number(view.getBigUint64(p)); p += 8 }
      if (tfFlags & 0x2) p += 4
      let defDuration = trexDuration
      let defSize = trexSize
      if (tfFlags & 0x8) { defDuration = view.getUint32(p); p += 4 }
      if (tfFlags & 0x10) { defSize = view.getUint32(p); p += 4 }
      let cursor = base
      for (const trun of inner.filter(b => b.type === 'trun')) {
        const flags = view.getUint32(trun.start + trun.header) & 0xffffff
        const count = view.getUint32(trun.start + trun.header + 4)
        let q = trun.start + trun.header + 8
        if (flags & 0x1) { cursor = base + view.getInt32(q); q += 4 }
        if (flags & 0x4) q += 4
        const per = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0)
        if (q + count * per > trun.start + trun.size) return null
        for (let s = 0; s < count; s++) {
          let r = q + s * per
          let duration = defDuration
          let size = defSize
          if (flags & 0x100) { duration = view.getUint32(r); r += 4 }
          if (flags & 0x200) { size = view.getUint32(r); r += 4 }
          if (!(size > 0) || !(duration > 0)) return null
          if (cursor < 0 || cursor + size > view.byteLength) return null
          samples.push({ offset: cursor, size, duration })
          cursor += size
        }
      }
    }
  }
  return samples
}

export function fragmentedMp4ToFlat(input: Uint8Array): FlatAudio | null {
  try {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const top = readBoxes(view, 0, input.byteLength)
    const moov = top.find(b => b.type === 'moov')
    if (!moov || !top.some(b => b.type === 'moof')) return null // not fragmented: nothing to convert

    const moovKids = readBoxes(view, moov.start + moov.header, moov.start + moov.size)
    const traks = moovKids.filter(b => b.type === 'trak')
    if (traks.length !== 1) return null // one audio track only
    const trak = traks[0]
    const mdia = child(view, trak, 'mdia')
    const mdhd = mdia ? child(view, mdia, 'mdhd') : null
    const hdlr = mdia ? child(view, mdia, 'hdlr') : null
    const minf = mdia ? child(view, mdia, 'minf') : null
    if (!mdia || !mdhd || !hdlr || !minf) return null
    const handler = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(hdlr.start + hdlr.header + 8 + i)))
    if (handler !== 'soun') return null
    const smhd = child(view, minf, 'smhd')
    const dinf = child(view, minf, 'dinf')
    const stbl = child(view, minf, 'stbl')
    const stsd = stbl ? child(view, stbl, 'stsd') : null
    if (!smhd || !dinf || !stsd) return null

    const mdhdV = view.getUint8(mdhd.start + mdhd.header)
    const timescale = view.getUint32(mdhd.start + mdhd.header + (mdhdV === 0 ? 12 : 20))
    if (!timescale) return null

    let trexDuration = 0
    let trexSize = 0
    const mvex = moovKids.find(b => b.type === 'mvex')
    const trex = mvex ? child(view, mvex, 'trex') : null
    if (trex) {
      trexDuration = view.getUint32(trex.start + trex.header + 12)
      trexSize = view.getUint32(trex.start + trex.header + 16)
    }

    const samples = collectSamples(view, top, trexDuration, trexSize)
    if (!samples || samples.length === 0) return null

    let totalTicks = 0
    let totalBytes = 0
    for (const s of samples) { totalTicks += s.duration; totalBytes += s.size }
    if (totalTicks > 0xffffffff || totalBytes > 0xfffffff0) return null

    // stts: runs of equal durations
    const runs: Array<[number, number]> = []
    for (const s of samples) {
      const last = runs[runs.length - 1]
      if (last && last[1] === s.duration) last[0]++
      else runs.push([1, s.duration])
    }
    const stts = box('stts', u32(0), u32(runs.length), ...runs.map(([n, d]) => cat(u32(n), u32(d))))
    const stsc = box('stsc', u32(0), u32(1), u32(1), u32(samples.length), u32(1)) // one chunk holding every sample
    const stsz = box('stsz', u32(0), u32(0), u32(samples.length), ...samples.map(s => u32(s.size)))
    const stcoFor = (offset: number) => box('stco', u32(0), u32(1), u32(offset))
    const stsdBytes = input.subarray(stsd.start, stsd.start + stsd.size)
    const hdlrBytes = input.subarray(hdlr.start, hdlr.start + hdlr.size)
    const smhdBytes = input.subarray(smhd.start, smhd.start + smhd.size)
    const dinfBytes = input.subarray(dinf.start, dinf.start + dinf.size)

    const mdhdNew = box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(totalTicks), u16(0x55c4), u16(0))
    const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(totalTicks), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2))
    const tkhd = box('tkhd', u32(0x00000007), u32(0), u32(0), u32(1), u32(0), u32(totalTicks), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0))

    const build = (chunkOffset: number): Uint8Array => {
      const stbl2 = box('stbl', stsdBytes, stts, stsc, stsz, stcoFor(chunkOffset))
      const minf2 = box('minf', smhdBytes, dinfBytes, stbl2)
      const mdia2 = box('mdia', mdhdNew, hdlrBytes, minf2)
      const trak2 = box('trak', tkhd, mdia2)
      return box('moov', mvhd, trak2)
    }
    const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'))
    const moovSize = build(0).length // the size does not depend on the offset value
    const mdatHeader = 8
    const moovNew = build(ftyp.length + moovSize + mdatHeader)

    const out = new Uint8Array(ftyp.length + moovNew.length + mdatHeader + totalBytes)
    let w = 0
    out.set(ftyp, w); w += ftyp.length
    out.set(moovNew, w); w += moovNew.length
    out.set(u32(mdatHeader + totalBytes), w); out.set(ascii('mdat'), w + 4); w += mdatHeader
    for (const s of samples) { out.set(input.subarray(s.offset, s.offset + s.size), w); w += s.size }
    return { data: out, seconds: totalTicks / timescale }
  } catch {
    return null
  }
}
