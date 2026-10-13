/**
 * Write the real length into a "fragmented" MP4/M4A voice note (dev job c1e326dd, TD Talk).
 *
 * Why: an iPhone's MediaRecorder writes the recording as many tiny fragments and leaves the total length in the header
 * at 0 ("unknown"). Some phones then guess the length from the first part they download and stop playing early (Luca
 * heard Antonio's 3-minute note cut off until he closed and reopened the app). Filling the header's length — mvhd, tkhd
 * and mdhd — in place fixes that without touching one byte of audio, so it is instant and can run on the phone before
 * upload. Nothing here changes any box size or offset, so every fragment stays valid.
 *
 * Pure and fail-safe: anything unexpected (not fragmented, not a single audio track, a length already present, a
 * malformed box) returns null and the caller uploads the original recording unchanged.
 */

export interface PatchedAudio {
  data: Uint8Array
  /** Total length in seconds, summed from the fragments. */
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

function child(view: DataView, parent: Box, type: string): Box | null {
  return readBoxes(view, parent.start + parent.header, parent.start + parent.size).find(b => b.type === type) ?? null
}

/** Sum the sample durations of every fragment (in the track's own timescale). Null if any fragment cannot be read. */
function totalTicks(view: DataView, boxes: Box[], trexDefaultDuration: number): number | null {
  let total = 0
  for (const moof of boxes.filter(b => b.type === 'moof')) {
    for (const traf of readBoxes(view, moof.start + moof.header, moof.start + moof.size).filter(b => b.type === 'traf')) {
      const inner = readBoxes(view, traf.start + traf.header, traf.start + traf.size)
      const tfhd = inner.find(b => b.type === 'tfhd')
      if (!tfhd) return null
      const tfFlags = view.getUint32(tfhd.start + tfhd.header) & 0xffffff
      let p = tfhd.start + tfhd.header + 8 // version+flags, track id
      if (tfFlags & 0x1) p += 8 // base data offset
      if (tfFlags & 0x2) p += 4 // sample description index
      const defaultDuration = tfFlags & 0x8 ? view.getUint32(p) : trexDefaultDuration
      for (const trun of inner.filter(b => b.type === 'trun')) {
        const flags = view.getUint32(trun.start + trun.header) & 0xffffff
        const count = view.getUint32(trun.start + trun.header + 4)
        let q = trun.start + trun.header + 8
        if (flags & 0x1) q += 4 // data offset
        if (flags & 0x4) q += 4 // first sample flags
        const perSample = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0)
        if (!(flags & 0x100)) {
          total += defaultDuration * count
          continue
        }
        if (q + count * perSample > trun.start + trun.size) return null
        for (let s = 0; s < count; s++) total += view.getUint32(q + s * perSample)
      }
    }
  }
  return total
}

/** Set a 32- or 64-bit duration field at `offset` (version-dependent). Returns false if it does not fit. */
function setDuration(view: DataView, box: Box, durationOffsetV0: number, durationOffsetV1: number, value: number): boolean {
  const version = view.getUint8(box.start + box.header)
  if (version === 0) {
    const at = box.start + box.header + durationOffsetV0
    if (at + 4 > box.start + box.size || value > 0xffffffff) return false
    view.setUint32(at, value)
    return true
  }
  const at = box.start + box.header + durationOffsetV1
  if (at + 8 > box.start + box.size) return false
  view.setBigUint64(at, BigInt(value))
  return true
}

function currentDuration(view: DataView, box: Box, v0: number, v1: number): number {
  const version = view.getUint8(box.start + box.header)
  return version === 0 ? view.getUint32(box.start + box.header + v0) : Number(view.getBigUint64(box.start + box.header + v1))
}

export function patchFragmentedMp4Duration(input: Uint8Array): PatchedAudio | null {
  try {
    const data = new Uint8Array(input) // a copy: the caller's recording is never modified
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const top = readBoxes(view, 0, data.byteLength)
    const moov = top.find(b => b.type === 'moov')
    if (!moov || !top.some(b => b.type === 'moof')) return null // not a fragmented file: nothing to fix

    const moovKids = readBoxes(view, moov.start + moov.header, moov.start + moov.size)
    const traks = moovKids.filter(b => b.type === 'trak')
    const mvhd = moovKids.find(b => b.type === 'mvhd')
    const mvex = moovKids.find(b => b.type === 'mvex')
    if (!mvhd || traks.length !== 1) return null // one audio track only

    const trak = traks[0]
    const tkhd = child(view, trak, 'tkhd')
    const mdia = child(view, trak, 'mdia')
    const mdhd = mdia ? child(view, mdia, 'mdhd') : null
    if (!tkhd || !mdhd) return null

    // mvhd: v0 timescale@12 duration@16 · v1 timescale@20 duration@24. mdhd the same. tkhd: v0 duration@20 · v1 duration@28.
    const mvhdVersion = view.getUint8(mvhd.start + mvhd.header)
    const mdhdVersion = view.getUint8(mdhd.start + mdhd.header)
    const mvTimescale = view.getUint32(mvhd.start + mvhd.header + (mvhdVersion === 0 ? 12 : 20))
    const mdTimescale = view.getUint32(mdhd.start + mdhd.header + (mdhdVersion === 0 ? 12 : 20))
    if (!mvTimescale || !mdTimescale) return null
    // The MOVIE length (mvhd) is the one players read. Chrome leaves a small leftover in mdhd, so only mvhd decides.
    if (currentDuration(view, mvhd, 16, 24) !== 0) return null // already has a length

    let trexDefault = 0
    if (mvex) {
      const trex = child(view, mvex, 'trex')
      if (trex) trexDefault = view.getUint32(trex.start + trex.header + 12) // v+flags, track id, default desc index, default duration
    }
    const ticks = totalTicks(view, top, trexDefault)
    if (!ticks || ticks <= 0) return null

    const movieTicks = Math.round((ticks * mvTimescale) / mdTimescale)
    if (!setDuration(view, mdhd, 16, 24, ticks)) return null
    if (!setDuration(view, mvhd, 16, 24, movieTicks)) return null
    if (!setDuration(view, tkhd, 20, 28, movieTicks)) return null

    return { data, seconds: ticks / mdTimescale }
  } catch {
    return null
  }
}
