import { describe, it, expect } from "vitest"
import {
  DROP_MAX_BYTES, DROP_KEY_PREFIX, checkDropName, checkDropSubfolder, decodeDropContent, checkDropContent,
  csvFormulaCell, inspectOoxml, dropCallerKey, dropRateRefusal, sha256Of,
} from "@/lib/crm-store/my-files-drop-rules"

/** A tiny zip writer (stored entries) so the OOXML inspection can be tested with real bytes. */
function zip(entries: Array<{ name: string; data?: Buffer; usize?: number; csize?: number; flags?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const data = e.data ?? Buffer.from("x")
    const name = Buffer.from(e.name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6)
    lh.writeUInt32LE(e.csize ?? data.length, 18); lh.writeUInt32LE(e.usize ?? data.length, 22); lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8)
    ch.writeUInt32LE(e.csize ?? data.length, 20); ch.writeUInt32LE(e.usize ?? data.length, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(off, 42)
    centrals.push(ch, name)
    off += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, eocd])
}
const goodDocx = () => zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }])

describe("checkDropName", () => {
  it("accepts a normal name and derives the type from the extension", () => {
    const r = checkDropName("TD Marketing plan.DOCX")
    expect(r).toMatchObject({ ok: true, name: "TD Marketing plan.DOCX", ext: "docx" })
  })
  it.each(["a.html", "a.svg", "a.js", "a.exe", "a.doc", "a.xls", "a.ppt", "a.rtf", "a.zip", "noextension", "a.pdf.exe", "x."])("refuses %s", (n) => {
    expect(checkDropName(n).ok).toBe(false)
  })
  it("refuses slashes, dots-only, leading dot, trailing dot/space, direction-changing characters", () => {
    for (const n of ["a/b.pdf", "a\\b.pdf", "..", ".hidden.pdf", "plan.pdf.", "x‮gnp.pdf", "a​b.pdf", "line\nbreak.pdf", ""]) {
      expect(checkDropName(n).ok, JSON.stringify(n)).toBe(false)
    }
    expect(checkDropName(42).ok).toBe(false)
    expect(checkDropName("  plan.pdf  ")).toMatchObject({ ok: true, name: "plan.pdf" }) // surrounding spaces are trimmed
    expect(checkDropName("a".repeat(256) + ".pdf").ok).toBe(false)
  })
})

describe("checkDropSubfolder", () => {
  it("is optional", () => {
    expect(checkDropSubfolder(undefined)).toEqual({ ok: true, segments: [] })
    expect(checkDropSubfolder("")).toEqual({ ok: true, segments: [] })
  })
  it("splits up to 3 clean names", () => {
    expect(checkDropSubfolder("TD Marketing/Plans/ 2026 ")).toEqual({ ok: true, segments: ["TD Marketing", "Plans", "2026"] })
  })
  it("refuses traversal, backslashes, too deep, hidden characters, non-strings", () => {
    for (const s of ["..", "a/../b", "./a", "a\\b", "a/b/c/d", ".hidden", "a‮", "dir."]) expect(checkDropSubfolder(s).ok, s).toBe(false)
    expect(checkDropSubfolder(5).ok).toBe(false)
  })
})

describe("decodeDropContent", () => {
  it("needs exactly one of text / base64 (empty string counts as given)", () => {
    expect(decodeDropContent(undefined, undefined).ok).toBe(false)
    expect(decodeDropContent("a", "YQ==").ok).toBe(false)
    expect(decodeDropContent("", undefined).ok).toBe(false) // given but empty → empty file
  })
  it("decodes text and measures UTF-8 bytes", () => {
    const r = decodeDropContent("héllo", undefined)
    expect(r.ok && r.bytes.length).toBe(6)
    const big = decodeDropContent("é".repeat(DROP_MAX_BYTES / 2 + 1), undefined)
    expect(big.ok).toBe(false)
  })
  it("decodes strict base64, tolerates wrapping and a data: prefix, refuses junk", () => {
    const b64 = Buffer.from("hello world, hello world").toString("base64")
    expect(decodeDropContent(undefined, b64.replace(/(.{8})/g, "$1\n")).ok).toBe(true)
    expect(decodeDropContent(undefined, `data:text/plain;base64,${b64}`).ok).toBe(true)
    expect(decodeDropContent(undefined, "not base64!!").ok).toBe(false)
    expect(decodeDropContent(undefined, "a-b_").ok).toBe(false) // url-safe alphabet is not standard base64
    expect(decodeDropContent(undefined, "").ok).toBe(false)
  })
  it("refuses over the size limit before decoding, with the real size in the message", () => {
    const r = decodeDropContent(undefined, "A".repeat(Math.ceil(((DROP_MAX_BYTES + 100000) * 4) / 3)))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/MB; the limit is 3 MB/)
  })
})

describe("checkDropContent", () => {
  it("checks the signature of pdf and images", () => {
    expect(checkDropContent("pdf", Buffer.from("%PDF-1.7 ...")).ok).toBe(true)
    expect(checkDropContent("pdf", Buffer.from("<html>")).ok).toBe(false)
    expect(checkDropContent("png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).ok).toBe(true)
    expect(checkDropContent("png", Buffer.from("GIF89a")).ok).toBe(false)
    expect(checkDropContent("jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ok).toBe(true)
  })
  it("text types must be UTF-8 text without NUL", () => {
    expect(checkDropContent("md", Buffer.from("# Plan\n- one")).ok).toBe(true)
    expect(checkDropContent("txt", Buffer.from([0x61, 0x00, 0x62])).ok).toBe(false)
    expect(checkDropContent("json", Buffer.from([0xff, 0xfe, 0xfd])).ok).toBe(false)
  })
  it("csv: formulas refused, negative numbers and text fine", () => {
    expect(checkDropContent("csv", Buffer.from("a,b\n1,-5\n-3.2,hello")).ok).toBe(true)
    expect(checkDropContent("csv", Buffer.from("a,b\n=HYPERLINK(\"x\"),1")).ok).toBe(false)
    expect(checkDropContent("csv", Buffer.from("a,@SUM(A1)")).ok).toBe(false)
    expect(checkDropContent("csv", Buffer.from("a,+cmd|' /C calc'!A0")).ok).toBe(false)
    expect(csvFormulaCell("x,-(1+1)")).not.toBeNull()
    expect(csvFormulaCell("a,b\n1,-2+3+cmd|' /C calc'!A0")).not.toBeNull() // digit-first DDE payload
    expect(csvFormulaCell("x\r=HYPERLINK(\"u\")")).not.toBeNull() // a bare CR row separator
    expect(csvFormulaCell("a,-12.5,+3,50%")).toBeNull()
  })
})

describe("inspectOoxml", () => {
  it("accepts a plain Office zip", () => {
    expect(inspectOoxml(goodDocx())).toBeNull()
    expect(checkDropContent("docx", goodDocx()).ok).toBe(true)
  })
  it("refuses a non-zip, a zip without [Content_Types].xml, a damaged directory", () => {
    expect(inspectOoxml(Buffer.from("PK\x03\x04 nonsense but long enough to look at")) ).not.toBeNull()
    expect(inspectOoxml(zip([{ name: "a.txt" }]))).toMatch(/not a real Office/)
    expect(inspectOoxml(Buffer.from("hello world, this is not a zip file at all"))).not.toBeNull()
  })
  it("refuses macros, external links, embeddings, activeX, nested archives, encryption", () => {
    for (const bad of ["word/vbaProject.bin", "xl/externalLinks/externalLink1.xml", "word/embeddings/o.bin", "xl/activeX/a.xml", "inner.zip", "x/inner.docx"]) {
      expect(inspectOoxml(zip([{ name: "[Content_Types].xml" }, { name: bad }])), bad).not.toBeNull()
    }
    expect(inspectOoxml(zip([{ name: "[Content_Types].xml", flags: 1 }]))).toMatch(/encrypted/)
  })
  it("refuses a zip bomb by total size and by ratio", () => {
    expect(inspectOoxml(zip([{ name: "[Content_Types].xml" }, { name: "big.xml", usize: 200 * 1024 * 1024, csize: 200 * 1024 * 1024 }]))).toMatch(/150 MB/)
    expect(inspectOoxml(zip([{ name: "[Content_Types].xml" }, { name: "big.xml", usize: 50 * 1024 * 1024, csize: 1000 }]))).toMatch(/ratio/)
  })
  it("refuses a directory that does not end where the end-record says, and a trailing-comment trick", () => {
    const z = goodDocx()
    expect(inspectOoxml(Buffer.concat([z, Buffer.from("PK\x05\x06 hidden second end record")]))).toMatch(/damaged/)
    const extra = Buffer.from(z); extra.writeUInt16LE(1, extra.length - 22 + 10); extra.writeUInt16LE(1, extra.length - 22 + 8)
    expect(inspectOoxml(extra)).toMatch(/damaged/) // fewer entries declared than the directory holds
  })
  it("refuses declared 0 compressed bytes with data, and a chart's embedded sheet (clear message)", () => {
    expect(inspectOoxml(zip([{ name: "[Content_Types].xml" }, { name: "big.xml", usize: 5000, csize: 0 }]))).toMatch(/ratio/)
    expect(inspectOoxml(zip([{ name: "[Content_Types].xml" }, { name: "word/embeddings/Microsoft_Excel_Sheet1.xlsx" }]))).toMatch(/PDF/)
  })
  it("refuses more than 1000 parts", () => {
    const many = [{ name: "[Content_Types].xml" }, ...Array.from({ length: 1001 }, (_, i) => ({ name: `p${i}.xml` }))]
    expect(inspectOoxml(zip(many))).toMatch(/1000/)
  })
})

describe("dropCallerKey", () => {
  const sha = sha256Of(Buffer.from("x"))
  it("derives a stable key when none is given, different per content and per place", () => {
    const a = dropCallerKey(undefined, [], "a.md", sha)
    const b = dropCallerKey(undefined, [], "a.md", sha)
    const c = dropCallerKey(undefined, ["sub"], "a.md", sha)
    const d = dropCallerKey(undefined, [], "a.md", sha256Of(Buffer.from("y")))
    expect(a.ok && b.ok && c.ok && d.ok).toBe(true)
    if (a.ok && b.ok && c.ok && d.ok) {
      expect(a.key).toBe(b.key)
      expect(new Set([a.key, c.key, d.key]).size).toBe(3)
      expect(a.key.startsWith(DROP_KEY_PREFIX)).toBe(true)
    }
  })
  it("prefixes a caller key (so it can never collide with another flow's key) and refuses spoofing the prefix", () => {
    const k = dropCallerKey("plan-2026", [], "a.md", sha)
    expect(k.ok && k.key).toBe(`${DROP_KEY_PREFIX}plan-2026`)
    expect(dropCallerKey(`${DROP_KEY_PREFIX}x`, [], "a.md", sha).ok).toBe(false)
    expect(dropCallerKey("auto:abc", [], "a.md", sha).ok).toBe(false)
    expect(dropCallerKey("formation-summary:123:0 ", [], "a.md", sha).ok).toBe(false) // space not allowed
    expect(dropCallerKey("x".repeat(101), [], "a.md", sha).ok).toBe(false)
  })
})

describe("dropRateRefusal", () => {
  it("allows normal use and refuses each limit with a fixed message", () => {
    expect(dropRateRefusal({ lastHour: 0, lastDay: 0, bytesLastDay: 0 }, 1000)).toBeNull()
    expect(dropRateRefusal({ lastHour: 30, lastDay: 30, bytesLastDay: 0 }, 1)).toMatch(/last hour/)
    expect(dropRateRefusal({ lastHour: 1, lastDay: 200, bytesLastDay: 0 }, 1)).toMatch(/24 hours/)
    expect(dropRateRefusal({ lastHour: 1, lastDay: 1, bytesLastDay: 200 * 1024 * 1024 }, 1)).toMatch(/data/)
  })
})
