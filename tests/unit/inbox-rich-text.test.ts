import { describe, it, expect } from "vitest"
import {
  RICH_FONTS,
  RICH_COLORS,
  DEFAULT_RICH_STYLE,
  parseRichStyle,
  isDefaultRichStyle,
  checkLinkHref,
  decodeEntities,
  textToHtml,
  richHtmlToText,
  hasRichFormatting,
  shouldSendRich,
  restyleRichHtml,
  richBodyOpenTag,
  tokenizeRichHtml,
} from "../../lib/inbox/rich-text"

describe("parseRichStyle", () => {
  it("accepts every valid value", () => {
    for (const font of RICH_FONTS) expect(parseRichStyle({ font }).font).toBe(font)
    expect(parseRichStyle({ font: "Georgia", size: "huge", line: "double", para: "wide" })).toEqual({
      font: "Georgia", size: "huge", line: "double", para: "wide",
    })
  })
  it("falls back to the default PER FIELD for anything unknown (no CSS can be smuggled through a style field)", () => {
    expect(parseRichStyle({ font: "Comic Sans", size: "20px; background:url(x)", line: 9, para: null })).toEqual(DEFAULT_RICH_STYLE)
    expect(parseRichStyle({ font: "Georgia", size: "nope" })).toEqual({ ...DEFAULT_RICH_STYLE, font: "Georgia" })
    for (const junk of [undefined, null, "x", 5, [], true]) expect(parseRichStyle(junk)).toEqual(DEFAULT_RICH_STYLE)
  })
  it("knows what the default is", () => {
    expect(isDefaultRichStyle(DEFAULT_RICH_STYLE)).toBe(true)
    expect(isDefaultRichStyle({ ...DEFAULT_RICH_STYLE, line: "airy" })).toBe(false)
    expect(isDefaultRichStyle({ ...DEFAULT_RICH_STYLE, font: "Verdana" })).toBe(false)
  })
})

describe("checkLinkHref — the single link rule", () => {
  it("accepts ordinary web and email links", () => {
    expect(checkLinkHref("https://example.com/a?b=1")).toEqual({ ok: true, href: "https://example.com/a?b=1" })
    expect(checkLinkHref("http://example.org")).toMatchObject({ ok: true })
    expect(checkLinkHref("mailto:tony@tonydurante.us")).toEqual({ ok: true, href: "mailto:tony@tonydurante.us" })
    expect(checkLinkHref("  https://app.tonydurante.us/x  ")).toMatchObject({ ok: true })
  })
  it("rejects anything that is not absolute http/https/mailto", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd",
      "//evil.com/x", "/relative/path", "example.com", "ftp://x.com", "", "   ", null, undefined, 5, {}]) {
      expect(checkLinkHref(bad)).toMatchObject({ ok: false })
    }
  })
  it("rejects our internal addresses (R005) — a client must never be sent one", () => {
    for (const bad of ["https://td-operations.vercel.app/x", "https://td-operations-sandbox.vercel.app", "https://td-inbox-sandbox.vercel.app/inbox",
      "http://localhost:3000", "http://127.0.0.1/x", "https://foo.local", "http://192.168.1.5/x", "https://10.0.0.1"]) {
      const r = checkLinkHref(bad)
      expect(r.ok).toBe(false)
    }
  })
  it("rejects a login embedded in the link and bad mailto addresses", () => {
    expect(checkLinkHref("https://user:pass@example.com")).toMatchObject({ ok: false })
    expect(checkLinkHref("mailto:not-an-address")).toMatchObject({ ok: false })
    expect(checkLinkHref("mailto:")).toMatchObject({ ok: false })
  })
})

describe("decodeEntities — exactly once", () => {
  it("decodes the common entities and numeric references", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39; &#x41;")).toBe("Tom & Jerry <3 \"x\" 'y' A")
  })
  it("never double-decodes", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;")
    expect(decodeEntities("&amp;amp;")).toBe("&amp;")
  })
  it("turns nbsp into a plain space and leaves unknown entities alone", () => {
    expect(decodeEntities("a&nbsp;b&#160;c")).toBe("a b c")
    expect(decodeEntities("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;")
  })
})

describe("textToHtml / richHtmlToText round trip — the plain path must match the old textarea", () => {
  const samples = [
    "",
    "one line",
    "Hi Michael,\n\nThanks for signing.\n\nBest,\nTony",
    "trailing newline\n",
    "\nleading blank",
    "a\n\n\nb",
    "Form 5472 <Form> & friends \"quoted\" 'single'",
    "[price] and {name}",
    "Ciao, è già fatto — grazie! €1.500",
    "tab\tinside",
  ]
  for (const s of samples) {
    it(`round-trips ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(richHtmlToText(textToHtml(s))).toBe(s)
    })
  }
  it("normalises CRLF to LF", () => {
    expect(richHtmlToText(textToHtml("a\r\nb\rc"))).toBe("a\nb\nc")
  })
  it("escapes markup-looking text so it can never become a tag", () => {
    const html = textToHtml("<script>alert(1)</script> <b>x</b>")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })
})

describe("richHtmlToText — the plain half of a formatted email", () => {
  it("one line per paragraph; an empty paragraph is a blank line", () => {
    expect(richHtmlToText("<p>a</p><p></p><p>b</p>")).toBe("a\n\nb")
  })
  it("line breaks inside a paragraph", () => {
    expect(richHtmlToText("<p>a<br>b<br />c</p>")).toBe("a\nb\nc")
  })
  it("bullets and numbered lists, including Tiptap's <li><p> shape", () => {
    expect(richHtmlToText("<ul><li><p>one</p></li><li><p>two</p></li></ul>")).toBe("• one\n• two")
    expect(richHtmlToText("<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>")).toBe("1. one\n2. two\n3. three")
    expect(richHtmlToText("<p>Next steps:</p><ul><li>sign</li><li>return</li></ul><p>Best</p>")).toBe("Next steps:\n• sign\n• return\nBest")
  })
  it("indents nested lists by two spaces per level and restarts numbering", () => {
    expect(richHtmlToText("<ol><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ol>")).toBe("1. a\n  • b\n2. c")
    expect(richHtmlToText("<ol><li>x</li></ol><ol><li>y</li></ol>")).toBe("1. x\n1. y")
  })
  it("drops an EMPTY list item so it can never make a blank email look non-empty", () => {
    expect(richHtmlToText("<ul><li><p></p></li></ul>")).toBe("")
    expect(richHtmlToText("<ul><li><p>a</p></li><li><p></p></li></ul>")).toBe("• a")
    expect(richHtmlToText("<ul><li>  </li></ul>").trim()).toBe("")
  })
  it("writes a link as 'words (address)' so 'click here' keeps its address", () => {
    expect(richHtmlToText('<p>Please <a href="https://example.com/sign">click here</a> today</p>')).toBe("Please click here (https://example.com/sign) today")
    expect(richHtmlToText('<p><a href="mailto:tony@tonydurante.us">Tony</a></p>')).toBe("Tony (tony@tonydurante.us)")
  })
  it("does not repeat the address when the words ARE the address", () => {
    expect(richHtmlToText('<p><a href="https://example.com">https://example.com</a></p>')).toBe("https://example.com")
    expect(richHtmlToText('<p><a href="https://example.com/">https://example.com</a></p>')).toBe("https://example.com")
    expect(richHtmlToText('<p><a href="mailto:a@b.com">a@b.com</a></p>')).toBe("a@b.com")
  })
  it("ignores inline formatting tags and colours — the words are what the plain half carries", () => {
    expect(richHtmlToText('<p><strong>Bold</strong> <em>it</em> <u>un</u> <span style="color:#b91c1c">red</span></p>')).toBe("Bold it un red")
  })
  it("decodes entities exactly once and turns nbsp into a space", () => {
    expect(richHtmlToText("<p>Terms &amp;amp; Conditions &lt;b&gt; a&nbsp;b</p>")).toBe("Terms &amp; Conditions <b> a b")
  })
  it("removes zero-width and other invisible characters", () => {
    expect(richHtmlToText("<p>a​b﻿c</p>")).toBe("abc")
    expect(richHtmlToText("<p>​</p>").trim()).toBe("")
  })
  it("joins words split across inline tags WITHOUT a gap, so the [blank] guard still sees '[price]'", () => {
    expect(richHtmlToText("<p>[pri<strong>c</strong>e]</p>")).toBe("[price]")
    expect(richHtmlToText("<p>[pri<strong></strong>ce]</p>")).toBe("[price]")
  })
  it("survives attribute values containing '>' and odd quoting", () => {
    expect(richHtmlToText('<p><a href="https://example.com/?a=1&gt;2" title=\'x>y\'>hi</a></p>')).toBe("hi (https://example.com/?a=1>2)")
  })
  it("ignores HTML comments and handles text outside any block", () => {
    expect(richHtmlToText("<!-- hidden --><p>a</p>")).toBe("a")
    expect(richHtmlToText("loose text")).toBe("loose text")
  })
})

describe("hasRichFormatting / shouldSendRich", () => {
  it("plain paragraphs and breaks are NOT formatting (they take the byte-identical old path)", () => {
    expect(hasRichFormatting("<p>a</p><p></p><p>b<br>c</p>")).toBe(false)
    expect(hasRichFormatting(textToHtml("Hi,\n\nThanks"))).toBe(false)
    expect(hasRichFormatting("")).toBe(false)
  })
  it("anything beyond that IS formatting — a list, link, mark, colour or alignment can never be dropped silently", () => {
    for (const html of [
      "<p><strong>b</strong></p>", "<p><em>i</em></p>", "<p><u>u</u></p>", "<ul><li>x</li></ul>", "<ol><li>x</li></ol>",
      '<p><a href="https://example.com">x</a></p>', '<p><span style="color:#2563eb">x</span></p>', '<p style="text-align: center">x</p>',
    ]) expect(hasRichFormatting(html)).toBe(true)
  })
  it("a non-default message style counts even with plain paragraphs", () => {
    expect(shouldSendRich("<p>a</p>", DEFAULT_RICH_STYLE)).toBe(false)
    expect(shouldSendRich("<p>a</p>", { ...DEFAULT_RICH_STYLE, line: "airy" })).toBe(true)
    expect(shouldSendRich("<p><strong>a</strong></p>", DEFAULT_RICH_STYLE)).toBe(true)
  })
})

describe("restyleRichHtml — the server applies the spacing", () => {
  const S = { ...DEFAULT_RICH_STYLE }
  it("puts ONE style attribute on a paragraph (margin + line-height)", () => {
    expect(restyleRichHtml("<p>a</p>", S)).toBe('<p style="margin:0 0 10px 0;line-height:1.5">a</p>')
  })
  it("merges a centre alignment into the SAME attribute (no duplicate style attribute that a browser would ignore)", () => {
    const out = restyleRichHtml('<p style="text-align:center">a</p>', S)
    expect(out).toBe('<p style="text-align:center;margin:0 0 10px 0;line-height:1.5">a</p>')
    expect((out.match(/style=/g) ?? []).length).toBe(1)
  })
  it("keeps left alignment implicit", () => {
    expect(restyleRichHtml('<p style="text-align:left">a</p>', S)).not.toContain("text-align")
  })
  it("uses the chosen spacing presets", () => {
    const out = restyleRichHtml("<p>a</p>", { ...DEFAULT_RICH_STYLE, line: "double", para: "wide" })
    expect(out).toContain("margin:0 0 18px 0")
    expect(out).toContain("line-height:2.1")
  })
  it("turns an EMPTY paragraph into <p><br /></p> so a blank line survives in mail apps", () => {
    expect(restyleRichHtml("<p></p>", S)).toBe('<p style="margin:0 0 10px 0;line-height:1.5"><br /></p>')
    expect(restyleRichHtml("<p>a</p><p></p><p>b</p>", S).match(/<br \/>/g)?.length).toBe(1)
  })
  it("a paragraph inside a list item gets NO bottom margin (it would double-space every item)", () => {
    const out = restyleRichHtml("<ul><li><p>one</p></li></ul>", S)
    expect(out).toContain('<li style="line-height:1.5"><p style="margin:0 0 0px 0;line-height:1.5">one</p></li>')
    expect(out).toContain('<ul style="margin:0 0 10px 0;padding-left:24px">')
  })
  it("re-emits links with target and rel, escaped, and colours from the allowlist only", () => {
    const out = restyleRichHtml('<p><a href="https://example.com/?a=1&amp;b=2">x</a><span style="color:#2563EB">y</span><span style="color:red;background:url(x)">z</span></p>', S)
    expect(out).toContain('<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">x</a>')
    expect(out).toContain('<span style="color:#2563eb">y</span>')
    expect(out).toContain("<span>z</span>")
    expect(out).not.toContain("background")
  })
  it("drops invisible characters and tags it does not know", () => {
    expect(restyleRichHtml("<p>a​b<script>x</script></p>", S)).not.toContain("​")
  })
  it("every font's wrapper is a WELL-FORMED double-quoted style attribute (no stray double quote inside it)", () => {
    for (const font of RICH_FONTS) {
      const tag = richBodyOpenTag({ ...DEFAULT_RICH_STYLE, font })
      const m = /^<div style="([^"]*)">$/.exec(tag)
      expect(m, tag).not.toBeNull()
      expect(m![1]).toContain("font-family:")
    }
  })
  it("builds the body wrapper from the font/size enums only", () => {
    const tag = richBodyOpenTag({ ...DEFAULT_RICH_STYLE, font: "Georgia", size: "large", line: "airy" })
    expect(tag).toBe('<div style="font-family:Georgia,serif;font-size:18px;line-height:1.8">')
  })
})

describe("the four colours the editor and server agree on", () => {
  it("are lower-case 6-digit hex", () => {
    for (const c of RICH_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    expect(RICH_COLORS).toHaveLength(4)
  })
})

describe("tokenizeRichHtml", () => {
  it("separates text, open, close and self-closing tags", () => {
    const t = tokenizeRichHtml('<p class="x">hi<br/></p>')
    expect(t.map((x) => x.kind)).toEqual(["open", "text", "open", "close"])
    expect(t[0]).toMatchObject({ kind: "open", tag: "p", attrs: { class: "x" } })
    expect(t[2]).toMatchObject({ kind: "open", tag: "br", selfClosing: true })
  })
})
