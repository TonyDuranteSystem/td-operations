import { describe, it, expect } from "vitest"
import { mediaKindFor, MEDIA_LINK_SECONDS, BIG_DOWNLOAD_BYTES } from "@/lib/crm-store/media"
import {
  viewKindFor, looksLikeText, renderZipView, formatBytes, zipToViewHtml, ZIP_MAX_LISTED,
  extractStrings, hexDump, renderDetailsView, rtfToText, isHtmlFile, pptxToViewHtml, odfToViewHtml, iworkToViewHtml,
} from "@/lib/crm-store/view-html"
import { imageToViewHtml } from "@/lib/crm-store/view-image"

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
  it("leaves videos to the player", () => {
    expect(viewKindFor("a.mp4", null)).toBeNull()
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

import { viewPageFor } from "@/lib/crm-store/view-any"

const zipOf = async (files: Record<string, string | Uint8Array>) => {
  const JSZip = (await import("jszip")).default
  const z = new JSZip()
  for (const [n, c] of Object.entries(files)) z.file(n, c)
  return Buffer.from(await z.generateAsync({ type: "uint8array" }))
}

describe("every kind of file gets a page", () => {
  it("knows the new kinds by name", () => {
    expect(viewKindFor("deck.PPTX", null)).toBe("pptx")
    expect(viewKindFor("a.odt", null)).toBe("odf")
    expect(viewKindFor("book.numbers", null)).toBe("iwork")
    expect(viewKindFor("doc.pages", null)).toBe("iwork")
    expect(viewKindFor("talk.key", null)).toBe("iwork")
    expect(viewKindFor("memo.rtf", null)).toBe("rtf")
    expect(viewKindFor("logo.svg", null)).toBe("image")
    expect(viewKindFor("scan.tiff", null)).toBe("image")
  })
  it("a file nothing can draw gets the details page, with its readable text and first bytes", async () => {
    const head = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]), Buffer.from("Quarterly report draft text"), Buffer.from([0, 1, 2])])
    const r = await viewPageFor({ name: "old.doc", mimeType: "application/msword", size: head.length, head, full: async () => head })
    expect(r.kind).toBe("details")
    expect(r.html).toContain("Quarterly report draft text")
    expect(r.html).toContain("old.doc")
    expect(r.html).toContain("d0 cf 11 e0")
  })
  it("a file that is too big to read here gets the details page and is never fully read", async () => {
    let read = false
    const r = await viewPageFor({ name: "huge.xlsx", mimeType: null, size: 900 * 1048576, head: Buffer.from("PK"), full: async () => { read = true; return Buffer.alloc(1) } })
    expect(r.kind).toBe("details")
    expect(read).toBe(false)
    expect(r.html).toContain("too large")
  })
  it("a file that fails to convert falls back to the details page with the reason", async () => {
    const bad = Buffer.from("this is not a zip at all")
    const r = await viewPageFor({ name: "broken.pptx", mimeType: null, size: bad.length, head: bad, full: async () => bad })
    expect(r.kind).toBe("details")
    expect(r.html).toContain("could not be read")
  })
  it("a name with no ending but readable content shows as text", async () => {
    const b = Buffer.from("plain words here\n")
    expect((await viewPageFor({ name: "mystery", mimeType: "application/octet-stream", size: b.length, head: b, full: async () => b })).kind).toBe("text")
  })
  it("random bytes with no ending get the details page", async () => {
    const b = Buffer.from([0, 255, 0, 3, 1, 2, 0, 9])
    expect((await viewPageFor({ name: "blob", mimeType: null, size: b.length, head: b, full: async () => b })).kind).toBe("details")
  })
  it("extractStrings finds readable runs (accents too) and hexDump lines up", () => {
    expect(extractStrings(Buffer.concat([Buffer.from([0, 0]), Buffer.from("Hello world"), Buffer.from([0, 1]), Buffer.from("café ok!")]))).toEqual(["Hello world", "café ok!"])
    expect(hexDump(Buffer.from("ABCDEFGHIJKLMNOPQ"))).toContain("41 42 43")
    expect(hexDump(Buffer.alloc(0))).toBe("")
  })
  it("the details page escapes everything", () => {
    const h = renderDetailsView("<b>x</b>.bin", "<i>t</i>", 5, Buffer.from("<script>alert(1)</script>"))
    expect(h).not.toMatch(/<script>|<b>x|<i>t/)
  })
  it("RTF becomes plain text", () => {
    expect(rtfToText("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Hello \\b world\\b0\\par Second line caf\\'e9}")).toContain("Hello")
    expect(rtfToText("{\\rtf1\\ansi Hi\\par There}")).toBe("Hi\nThere")
  })
  it("knows an HTML file by name or type", () => {
    expect(isHtmlFile("mockup.HTML", null)).toBe(true)
    expect(isHtmlFile("x", "text/html; charset=utf-8")).toBe(true)
    expect(isHtmlFile("x.txt", "text/plain")).toBe(false)
  })
  it("PowerPoint: the text of each slide, escaped, in order", async () => {
    const zip = await zipOf({
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second &amp; last</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First <b>slide</b></a:t></a:r></a:p></p:sld>",
    })
    const html = await pptxToViewHtml("d.pptx", zip)
    expect(html.indexOf("Slide 1")).toBeLessThan(html.indexOf("Slide 2"))
    expect(html).toContain("Second &amp; last")
    expect(html).not.toContain("<b>slide</b>")
  })
  it("OpenOffice: the text out of content.xml", async () => {
    const zip = await zipOf({ "content.xml": "<office:text><text:p>Line one</text:p><text:p>Line two</text:p></office:text>" })
    const html = await odfToViewHtml("a.odt", zip)
    expect(html).toContain("Line one")
    expect(html).toContain("Line two")
  })
  it("Apple files: shows the preview picture inside, else says why", async () => {
    const ok = await iworkToViewHtml("b.numbers", await zipOf({ "preview.jpg": new Uint8Array([255, 216, 255, 1]) }))
    expect(ok).toContain("data:image/jpeg;base64,")
    await expect(iworkToViewHtml("b.numbers", await zipOf({ "Index/x.iwa": "x" }))).rejects.toThrow(/no preview/)
  })
  it("a picture a browser cannot draw becomes a PNG, and a script in an SVG is gone", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20" fill="red"/></svg>')
    const html = await imageToViewHtml("l.svg", svg)
    expect(html).toContain("data:image/png;base64,")
    expect(html).not.toMatch(/<script/i)
  })
})
