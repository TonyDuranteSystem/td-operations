import { describe, it, expect } from "vitest"
import { mediaKindFor, MEDIA_LINK_SECONDS, BIG_DOWNLOAD_BYTES } from "@/lib/crm-store/media"
import { viewKindFor, looksLikeText, renderZipView, formatBytes, zipToViewHtml, ZIP_MAX_LISTED } from "@/lib/crm-store/view-html"

describe("mediaKindFor — which files get a player", () => {
  it("knows video and audio by name, in any letter case", () => {
    expect(mediaKindFor("Zoom call.MP4", null)).toBe("video")
    expect(mediaKindFor("clip.mov", "application/octet-stream")).toBe("video")
    expect(mediaKindFor("audio_only.m4a", null)).toBe("audio")
    expect(mediaKindFor("note.mp3", null)).toBe("audio")
  })
  it("knows video and audio by the stored type when the name says nothing", () => {
    expect(mediaKindFor("recording", "video/mp4; codecs=avc1")).toBe("video")
    expect(mediaKindFor("recording", "audio/mpeg")).toBe("audio")
  })
  it("leaves everything else alone", () => {
    expect(mediaKindFor("a.pdf", "application/pdf")).toBeNull()
    expect(mediaKindFor("a.zoom", null)).toBeNull()
    expect(mediaKindFor("mp4", null)).toBeNull() // no ending
    expect(mediaKindFor("", null)).toBeNull()
  })
  it("keeps the link valid long enough for a long call, and sends big files straight from storage", () => {
    expect(MEDIA_LINK_SECONDS).toBeGreaterThanOrEqual(3600)
    expect(BIG_DOWNLOAD_BYTES).toBeGreaterThan(1024 * 1024)
  })
})

describe("viewKindFor — the new kinds", () => {
  it("shows the small Zoom and settings files as text", () => {
    for (const n of ["meeting.conf", "x.zoom", "x.tag", "a.cfg", "pyproject.toml", "app.properties"]) expect(viewKindFor(n, null)).toBe("text")
  })
  it("shows a zip's contents", () => {
    expect(viewKindFor("docs.ZIP", null)).toBe("zip")
    expect(viewKindFor("x", "application/zip")).toBe("zip")
  })
  it("still leaves videos and Numbers files to the other paths", () => {
    expect(viewKindFor("a.mp4", null)).toBeNull()
    expect(viewKindFor("book.numbers", null)).toBeNull()
  })
})

describe("looksLikeText", () => {
  const b = (s: string) => new TextEncoder().encode(s)
  it("accepts plain text, accents and tabs / newlines", () => {
    expect(looksLikeText(b("hello\tworld\nçà ü\r\n"))).toBe(true)
    expect(looksLikeText(new Uint8Array(0))).toBe(true)
  })
  it("refuses a file with a NUL byte or mostly control bytes", () => {
    expect(looksLikeText(new Uint8Array([104, 105, 0, 1, 2]))).toBe(false)
    expect(looksLikeText(new Uint8Array(100).fill(3))).toBe(false)
  })
  it("only looks at the start of a big file", () => {
    const big = new Uint8Array(20000).fill(65)
    big[15000] = 0
    expect(looksLikeText(big)).toBe(true)
  })
})

describe("zip view", () => {
  it("lists names and sizes, escaped, and says when it was cut", () => {
    const html = renderZipView("a.zip", [{ name: "<b>x</b>.txt", dir: false, size: 2048 }, { name: "sub/", dir: true, size: null }], 600)
    expect(html).not.toContain("<b>x</b>")
    expect(html).toContain("2 KB")
    expect(html).toContain("folder")
    expect(html).toContain("first 2 of 600")
  })
  it("says so for an empty zip", () => {
    expect(renderZipView("a.zip", [], 0)).toContain("empty")
  })
  it("formats sizes", () => {
    expect(formatBytes(10)).toBe("10 B")
    expect(formatBytes(2048)).toBe("2 KB")
    expect(formatBytes(5 * 1048576)).toBe("5.0 MB")
  })
  it("reads a real zip's contents without unpacking anything", async () => {
    const JSZip = (await import("jszip")).default
    const z = new JSZip()
    z.file("hello.txt", "hi there")
    z.folder("inner")?.file("deep.txt", "x")
    const bytes = Buffer.from(await z.generateAsync({ type: "uint8array" }))
    const html = await zipToViewHtml("t.zip", bytes)
    expect(html).toContain("hello.txt")
    expect(html).toContain("inner/deep.txt")
  })
  it("lists at most the first ZIP_MAX_LISTED items", async () => {
    const JSZip = (await import("jszip")).default
    const z = new JSZip()
    for (let i = 0; i < ZIP_MAX_LISTED + 5; i++) z.file(`f${i}.txt`, "x")
    const html = await zipToViewHtml("t.zip", Buffer.from(await z.generateAsync({ type: "uint8array" })))
    expect(html).toContain(`first ${ZIP_MAX_LISTED} of ${ZIP_MAX_LISTED + 5}`)
  })
})
