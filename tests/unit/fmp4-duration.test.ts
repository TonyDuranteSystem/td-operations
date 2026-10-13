/**
 * Voice notes recorded on an iPhone are fragmented MP4s with the total length left at 0 (dev job c1e326dd): the listener's
 * phone can stop early. patchFragmentedMp4Duration writes the real length into the header, in place. A synthetic file
 * with known sample durations proves the arithmetic; the audio bytes and every box size must stay identical.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { patchFragmentedMp4Duration } from '@/lib/media/fmp4-duration'

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b }
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
const box = (type: string, ...payload: Uint8Array[]) => { const body = cat(...payload); return cat(u32(8 + body.length), new TextEncoder().encode(type), body) }

const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }
let v1 = false // build the 64-bit (version 1) headers Chrome writes
let mdhdLeftover = 0 // Chrome leaves a small non-zero length in mdhd
/** mvhd/mdhd v0: version+flags, created, modified, timescale, duration. v1: 64-bit times and duration. */
const hdr = (timescale: number, duration = 0) => v1
  ? cat(u32(0x01000000), u64(0), u64(0), u32(timescale), u64(duration))
  : cat(u32(0), u32(0), u32(0), u32(timescale), u32(duration))
const tkhd = (duration = 0) => v1
  ? cat(u32(0x01000000), u64(0), u64(0), u32(1), u32(0), u64(duration))
  : cat(u32(0), u32(0), u32(0), u32(1), u32(0), u32(duration)) // flags, created, modified, track id, reserved, duration
const trex = (defaultDuration: number) => cat(u32(0), u32(1), u32(1), u32(defaultDuration), u32(0), u32(0))

function trunWithDurations(durations: number[]) {
  // flags 0x000301: data-offset + sample-duration + sample-size
  return box('trun', u32(0x000301), u32(durations.length), u32(0), ...durations.flatMap(d => [u32(d), u32(100)]))
}
function trunNoDurations(count: number) {
  return box('trun', u32(0x000201), u32(count), u32(0), ...Array.from({ length: count }, () => u32(100))) // data-offset + size only
}
const tfhd = (flags: number, ...extra: Uint8Array[]) => box('tfhd', u32(flags), u32(1), ...extra)
const moof = (traf: Uint8Array) => box('moof', box('mfhd', u32(0), u32(1)), traf)

function build(opts: { mdTimescale?: number; mvTimescale?: number; mvDuration?: number; fragments?: Uint8Array[]; trexDefault?: number; tracks?: number }) {
  const trak = box('trak', box('tkhd', tkhd()), box('mdia', box('mdhd', hdr(opts.mdTimescale ?? 48000, mdhdLeftover))))
  const moov = box('moov', box('mvhd', hdr(opts.mvTimescale ?? 600, opts.mvDuration ?? 0)), trak, ...(opts.tracks === 2 ? [trak] : []), box('mvex', box('trex', trex(opts.trexDefault ?? 0))))
  const frags = opts.fragments ?? [cat(moof(box('traf', tfhd(0), trunWithDurations([1024, 1024]))), box('mdat', new Uint8Array(8)))]
  return cat(box('ftyp', new TextEncoder().encode('M4A '), u32(0)), moov, ...frags)
}

function durations(data: Uint8Array) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const find = (type: string) => { for (let i = 0; i + 8 < data.length; i++) if (String.fromCharCode(data[i], data[i + 1], data[i + 2], data[i + 3]) === type) return i; return -1 }
  const mvhd = find('mvhd'), mdhd = find('mdhd'), tkhd = find('tkhd')
  const read = (at: number, o0: number, o1: number) => (v.getUint8(at + 4) === 0 ? v.getUint32(at + 4 + o0) : Number(v.getBigUint64(at + 4 + o1)))
  return { mv: read(mvhd, 16, 24), md: read(mdhd, 16, 24), tk: read(tkhd, 20, 28) }
}

describe('patchFragmentedMp4Duration', () => {
  it('writes the summed fragment length into mvhd, tkhd and mdhd — leaving every byte of audio and every box size alone', () => {
    const src = build({ fragments: [
      cat(moof(box('traf', tfhd(0), trunWithDurations([1024, 1024, 1024]))), box('mdat', new Uint8Array([1, 2, 3, 4]))),
      cat(moof(box('traf', tfhd(0), trunWithDurations([1024, 512]))), box('mdat', new Uint8Array([5, 6]))),
    ] })
    const r = patchFragmentedMp4Duration(src)!
    expect(r).not.toBeNull()
    const ticks = 1024 * 3 + 1024 + 512
    expect(r.seconds).toBeCloseTo(ticks / 48000, 6)
    expect(durations(r.data)).toEqual({ md: ticks, mv: Math.round(ticks * 600 / 48000), tk: Math.round(ticks * 600 / 48000) })
    expect(r.data.length).toBe(src.length)
    // only the three duration fields differ
    let diff = 0
    for (let i = 0; i < src.length; i++) if (src[i] !== r.data[i]) diff++
    expect(diff).toBeLessThanOrEqual(12)
  })
  it('handles the 64-bit headers and the leftover mdhd length Chrome writes', () => {
    v1 = true; mdhdLeftover = 277
    try {
      const src = build({ fragments: [cat(moof(box('traf', tfhd(0), trunWithDurations([1024, 1024, 1024]))), box('mdat', new Uint8Array(4)))] })
      const r = patchFragmentedMp4Duration(src)!
      expect(r).not.toBeNull()
      expect(r.seconds).toBeCloseTo(3072 / 48000, 6)
      expect(durations(r.data)).toEqual({ md: 3072, mv: Math.round(3072 * 600 / 48000), tk: Math.round(3072 * 600 / 48000) })
      expect(r.data.length).toBe(src.length)
    } finally { v1 = false; mdhdLeftover = 0 }
  })
  it('does not modify the caller\'s buffer', () => {
    const src = build({})
    const copy = new Uint8Array(src)
    patchFragmentedMp4Duration(src)
    expect(Array.from(src)).toEqual(Array.from(copy))
  })
  it('uses the default sample duration when the fragment lists none (tfhd or trex)', () => {
    const viaTfhd = build({ fragments: [cat(moof(box('traf', tfhd(0x8, u32(960)), trunNoDurations(4))), box('mdat', new Uint8Array(4)))] })
    expect(patchFragmentedMp4Duration(viaTfhd)!.seconds).toBeCloseTo((960 * 4) / 48000, 6)
    const viaTrex = build({ trexDefault: 1024, fragments: [cat(moof(box('traf', tfhd(0), trunNoDurations(3))), box('mdat', new Uint8Array(4)))] })
    expect(patchFragmentedMp4Duration(viaTrex)!.seconds).toBeCloseTo((1024 * 3) / 48000, 6)
  })
  it('returns null (caller uploads the original) for anything it should not touch', () => {
    expect(patchFragmentedMp4Duration(new Uint8Array([1, 2, 3]))).toBeNull() // garbage
    expect(patchFragmentedMp4Duration(new Uint8Array(0))).toBeNull()
    expect(patchFragmentedMp4Duration(build({ fragments: [] }))).toBeNull() // not fragmented
    expect(patchFragmentedMp4Duration(build({ mvDuration: 600 }))).toBeNull() // length already present
    expect(patchFragmentedMp4Duration(build({ tracks: 2 }))).toBeNull() // not a single audio track
    expect(patchFragmentedMp4Duration(build({ fragments: [cat(moof(box('traf', tfhd(0), trunNoDurations(2))), box('mdat', new Uint8Array(2)))] }))).toBeNull() // no duration anywhere
    const truncated = build({}).slice(0, 70)
    expect(patchFragmentedMp4Duration(truncated)).toBeNull()
  })
  it('the recorder: TD Talk only — 48 kbps and the length fix; the WhatsApp composer path is unchanged', () => {
    const s = readFileSync(join(__dirname, '../../lib/hooks/use-audio-note-recorder.ts'), 'utf8')
    expect(s).toContain('audioBitsPerSecond: VOICE_BITS_PER_SECOND')
    expect(s).toContain('mp4Wanted ? {')
    expect(s).toContain('if (!mp4Wanted) { finish(audioBlob); return }')
    expect(s).toContain('patchFragmentedMp4Duration')
  })
})
