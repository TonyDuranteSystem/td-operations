/**
 * Voice notes (dev job c1e326dd): Safari plays an iPhone/Chrome fragmented MP4 badly — cut short, or (after our earlier header
 * patch) DOUBLE the length. fragmentedMp4ToFlat writes an ordinary MP4 with the same audio bytes. Proven on real Safari and
 * ffmpeg (bit-identical decode); here a synthetic file with known samples proves the structure and the edge cases.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fragmentedMp4ToFlat } from '@/lib/media/fmp4-to-flat'

import { build, cat, type Frag } from './helpers-fmp4'

function find(d: Uint8Array, type: string, from = 0): number {
  const t = new TextEncoder().encode(type)
  outer: for (let i = from; i + 4 <= d.length; i++) { for (let k = 0; k < 4; k++) if (d[i + k] !== t[k]) continue outer; return i }
  return -1
}
const rd32 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at)

describe('fragmentedMp4ToFlat', () => {
  const frags: Frag[] = [
    { sizes: [100, 120, 90], durations: [1024, 1024, 1024], seed: 1 },
    { sizes: [80, 110], durations: [1024, 1024], seed: 2 },
    { sizes: [70], durations: [512], seed: 3 },
  ]
  it('writes an ordinary MP4: index first, no fragments, real lengths, same audio bytes in the same order', () => {
    const { file, expected } = build({ frags })
    const r = fragmentedMp4ToFlat(file)!
    expect(r).not.toBeNull()
    const d = r.data
    expect(find(d, 'moof')).toBe(-1) // not fragmented any more
    expect(find(d, 'mvex')).toBe(-1)
    expect(find(d, 'moov')).toBeLessThan(find(d, 'mdat')) // index before the audio ("faststart")
    const totalTicks = 1024 * 5 + 512
    expect(r.seconds).toBeCloseTo(totalTicks / 48000, 8)
    // sample table
    const stsz = find(d, 'stsz'); expect(rd32(d, stsz + 12)).toBe(6)
    expect([0, 1, 2, 3, 4, 5].map(i => rd32(d, stsz + 16 + i * 4))).toEqual([100, 120, 90, 80, 110, 70])
    const stts = find(d, 'stts'); expect(rd32(d, stts + 8)).toBe(2) // two runs: 5 x 1024, 1 x 512
    expect([rd32(d, stts + 12), rd32(d, stts + 16), rd32(d, stts + 20), rd32(d, stts + 24)]).toEqual([5, 1024, 1, 512])
    const mdhd = find(d, 'mdhd'); expect(rd32(d, mdhd + 16)).toBe(48000); expect(rd32(d, mdhd + 20)).toBe(totalTicks)
    const mvhd = find(d, 'mvhd'); expect(rd32(d, mvhd + 20)).toBe(totalTicks)
    // the chunk offset points at the first audio byte, and every sample is where the table says
    const stco = find(d, 'stco'); const first = rd32(d, stco + 12)
    const mdat = find(d, 'mdat'); expect(first).toBe(mdat + 4)
    expect(d.length - first).toBe(expected.reduce((a, e) => a + e.length, 0))
    expect(Array.from(d.subarray(first))).toEqual(Array.from(cat(...expected)))
    // the codec description is carried over untouched
    expect(find(d, 'esds')).toBeGreaterThan(0)
  })
  it('reads sample sizes and durations from every place a muxer may put them (tfhd default, trex default, 64-bit header, base offset)', () => {
    const viaTfhd = build({ frags: [{ sizes: [60, 60, 60, 60], defaultDuration: 960, seed: 4 }] })
    expect(fragmentedMp4ToFlat(viaTfhd.file)!.seconds).toBeCloseTo(4 * 960 / 48000, 8)
    const viaTrex = build({ trexDuration: 1024, frags: [{ sizes: [50, 50, 50], seed: 5 }] })
    expect(fragmentedMp4ToFlat(viaTrex.file)!.seconds).toBeCloseTo(3 * 1024 / 48000, 8)
    const v1 = build({ v1: true, frags })
    const r1 = fragmentedMp4ToFlat(v1.file)!
    expect(r1.seconds).toBeCloseTo((1024 * 5 + 512) / 48000, 8)
    const baseOff = build({ frags: [{ sizes: [90, 91], durations: [1024, 1024], baseDataOffset: true, seed: 6 }] })
    const rb = fragmentedMp4ToFlat(baseOff.file)!
    const stco = find(rb.data, 'stco'); const first = rd32(rb.data, stco + 12)
    expect(Array.from(rb.data.subarray(first))).toEqual(Array.from(cat(...baseOff.expected)))
  })
  it('does not modify the caller\'s buffer', () => {
    const { file } = build({ frags })
    const copy = new Uint8Array(file)
    fragmentedMp4ToFlat(file)
    expect(Array.from(file)).toEqual(Array.from(copy))
  })
  it('returns null (the caller uploads the original) for anything it should not touch', () => {
    expect(fragmentedMp4ToFlat(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(fragmentedMp4ToFlat(new Uint8Array(0))).toBeNull()
    expect(fragmentedMp4ToFlat(build({ frags: [] }).file)).toBeNull() // already an ordinary file / nothing fragmented
    expect(fragmentedMp4ToFlat(build({ frags, tracks: 2 }).file)).toBeNull() // two tracks
    expect(fragmentedMp4ToFlat(build({ frags, handler: 'vide' }).file)).toBeNull() // not audio
    expect(fragmentedMp4ToFlat(build({ frags: [{ sizes: [60], seed: 7 }] }).file)).toBeNull() // no duration anywhere
    const f = build({ frags }).file
    expect(fragmentedMp4ToFlat(f.slice(0, f.length - 40))).toBeNull() // truncated audio
    expect(fragmentedMp4ToFlat(f.slice(0, 90))).toBeNull() // truncated index
  })
  it('the recorder: TD Talk only — 48 kbps and the conversion; the old header patch is gone', () => {
    const s = readFileSync(join(__dirname, '../../lib/hooks/use-audio-note-recorder.ts'), 'utf8')
    expect(s).toContain('audioBitsPerSecond: VOICE_BITS_PER_SECOND')
    expect(s).toContain('if (!mp4Wanted) { finish(audioBlob); return }')
    expect(s).toContain('fragmentedMp4ToFlat')
    expect(s).not.toContain('patchFragmentedMp4Duration')
  })
})
