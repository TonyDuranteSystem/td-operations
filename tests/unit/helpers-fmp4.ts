/** Synthetic fragmented-MP4 builder shared by the voice-note tests (dev job c1e326dd). */
export const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b }
const i32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b }
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }
export const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
export const box = (type: string, ...payload: Uint8Array[]) => { const body = cat(...payload); return cat(u32(8 + body.length), new TextEncoder().encode(type), body) }
export const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 0xff)

export interface Frag { sizes: number[]; durations?: number[]; defaultDuration?: number; defaultSize?: boolean; baseDataOffset?: boolean; dataOffsetInTrun?: boolean; seed: number }

export function build(opts: { frags: Frag[]; handler?: string; tracks?: number; timescale?: number; v1?: boolean; trexDuration?: number }) {
  const ts = opts.timescale ?? 48000
  const mdhd = opts.v1
    ? box('mdhd', u32(0x01000000), u64(0), u64(0), u32(ts), u64(0), u32(0))
    : box('mdhd', u32(0), u32(0), u32(0), u32(ts), u32(0), u32(0))
  const hdlr = box('hdlr', u32(0), u32(0), new TextEncoder().encode(opts.handler ?? 'soun'), new Uint8Array(12), new TextEncoder().encode('Sound\0'))
  const stsd = box('stsd', u32(0), u32(1), box('mp4a', new Uint8Array(28), box('esds', new Uint8Array([1, 2, 3, 4, 5, 6]))))
  const trak = box('trak', box('tkhd', u32(7), new Uint8Array(80)), box('mdia', mdhd, hdlr, box('minf', box('smhd', u32(0), u32(0)), box('dinf', box('dref', u32(0), u32(0))), box('stbl', stsd))))
  const moov = box('moov', box('mvhd', new Uint8Array(100)), trak, ...(opts.tracks === 2 ? [trak] : []), box('mvex', box('trex', u32(0), u32(1), u32(1), u32(opts.trexDuration ?? 0), u32(0), u32(0))))
  const parts: Uint8Array[] = [box('ftyp', new TextEncoder().encode('iso5'), u32(1), new TextEncoder().encode('iso5'))]
  parts.push(moov)
  const expected: Uint8Array[] = []
  for (const f of opts.frags) {
    const data = cat(...f.sizes.map((s, i) => bytes(s, f.seed + i)))
    expected.push(...f.sizes.map((s, i) => bytes(s, f.seed + i)))
    const flags = 0x200 | (f.durations ? 0x100 : 0) | (f.dataOffsetInTrun === false ? 0 : 0x1)
    const trunBody = (off: number) => cat(u32(flags), u32(f.sizes.length), ...(flags & 0x1 ? [i32(off)] : []), ...f.sizes.flatMap((s, i) => [...(f.durations ? [u32(f.durations[i])] : []), u32(s)]))
    const tfhdFlags = (f.baseDataOffset ? 0x1 : 0x20000) | (f.defaultDuration !== undefined ? 0x8 : 0)
    const tfhdPre = (base: number) => cat(u32(tfhdFlags), u32(1), ...(f.baseDataOffset ? [u64(base)] : []), ...(f.defaultDuration !== undefined ? [u32(f.defaultDuration)] : []))
    // moof size is independent of the numbers inside
    const probe = box('moof', box('mfhd', u32(0), u32(1)), box('traf', box('tfhd', tfhdPre(0)), box('trun', trunBody(0))))
    const moofStart = parts.reduce((a, p) => a + p.length, 0)
    const mdatStart = moofStart + probe.length
    const dataStart = mdatStart + 8
    const off = f.baseDataOffset ? dataStart - 0 : dataStart - moofStart
    const moof = box('moof', box('mfhd', u32(0), u32(1)), box('traf', box('tfhd', tfhdPre(f.baseDataOffset ? 0 : moofStart)), box('trun', trunBody(f.baseDataOffset ? dataStart : off))))
    parts.push(moof, box('mdat', data))
  }
  return { file: cat(...parts), expected }
}

