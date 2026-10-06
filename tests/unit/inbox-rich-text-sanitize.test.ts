import { describe, it, expect } from "vitest"
import { sanitizeRichHtml, resolveReplyBody, RICH_HTML_MAX_CHARS } from "../../lib/inbox/rich-text-sanitize"
import { richHtmlToText, tokenizeRichHtml } from "../../lib/inbox/rich-text"

const ALLOWED_TAGS = new Set(["p", "br", "strong", "em", "u", "ul", "ol", "li", "a", "span"])

/** Every tag in the output must be on the allow-list, and no attribute outside the allowed few may appear. */
function assertStrictShape(html: string) {
  for (const t of tokenizeRichHtml(html)) {
    if (t.kind === "open") {
      expect(ALLOWED_TAGS.has(t.tag)).toBe(true)
      const names = Object.keys(t.attrs)
      if (t.tag === "a") {
        expect(names.every((n) => n === "href")).toBe(true)
        expect(t.attrs.href).toMatch(/^(https?:\/\/|mailto:)/i)
      } else if (t.tag === "p" || t.tag === "span") {
        expect(names.every((n) => n === "style")).toBe(true)
        // The style VALUES are checked too, not just the attribute name: a span may carry exactly one of the four
        // colours, a paragraph exactly a left/centre alignment, and nothing else.
        if (t.attrs.style !== undefined) {
          const decls = t.attrs.style.split(";").map((d) => d.trim()).filter(Boolean)
          for (const d of decls) {
            const [prop, ...rest] = d.split(":")
            const value = rest.join(":").trim()
            if (t.tag === "span") {
              expect(prop.trim()).toBe("color")
              expect(value).toMatch(/^#(1f2937|2563eb|b91c1c|15803d)$/i)
            } else {
              expect(prop.trim()).toBe("text-align")
              expect(value).toMatch(/^(left|center)$/i)
            }
          }
        }
      } else expect(names).toEqual([])
    }
  }
  expect(html).not.toMatch(/on\w+\s*=/i)
  expect(html.toLowerCase()).not.toContain("javascript:")
  expect(html.toLowerCase()).not.toContain("<script")
}

describe("sanitizeRichHtml — what the editor emits passes through", () => {
  const golden = [
    "<p>Hi Michael,</p>",
    "<p><strong>bold</strong> <em>italic</em> <u>underline</u></p>",
    "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    "<ol><li><p>one</p></li></ol>",
    '<p style="text-align:center">centred</p>',
    '<p><span style="color:#2563eb">blue</span></p>',
    '<p>Please <a href="https://example.com/sign">sign here</a></p>',
    '<p><a href="mailto:tony@tonydurante.us">email</a></p>',
    "<p>a<br />b</p>",
    "<p></p>",
  ]
  for (const html of golden) {
    it(`keeps ${html.slice(0, 50)}`, () => {
      const out = sanitizeRichHtml(html)
      assertStrictShape(out)
      expect(richHtmlToText(out)).toBe(richHtmlToText(html))
    })
  }
  it("accepts Tiptap's real attribute spelling (spaces after colons, target/rel on links)", () => {
    const out = sanitizeRichHtml('<p style="text-align: center">c</p><p><span style="color: #2563eb">x</span> <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">y</a></p>')
    expect(out).toContain("text-align:center")
    expect(out).toMatch(/color:#2563eb/i)
    expect(out).toContain('href="https://example.com/"')
    expect(out).not.toContain("target=")
    expect(out).not.toContain("rel=")
  })
  it("maps b and i to strong and em", () => {
    expect(sanitizeRichHtml("<p><b>x</b><i>y</i></p>")).toBe("<p><strong>x</strong><em>y</em></p>")
  })
})

describe("sanitizeRichHtml — attacks", () => {
  const attacks: Array<[string, string]> = [
    ["script tag", "<p>a</p><script>alert(1)</script>"],
    ["script with upper case + attrs", '<SCRIPT SRC="http://evil/x.js"></SCRIPT>'],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["svg onload", '<svg onload="alert(1)"></svg>'],
    ["iframe", '<iframe src="https://evil.com"></iframe>'],
    ["event handler on allowed tag", '<p onclick="alert(1)">x</p>'],
    ["event handler on link", '<a href="https://example.com" onmouseover="alert(1)">x</a>'],
    ["javascript: link", '<a href="javascript:alert(1)">x</a>'],
    ["mixed-case javascript: link", '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ["entity-encoded javascript: link", '<a href="&#106;avascript:alert(1)">x</a>'],
    ["tab-split javascript: link", '<a href="java\tscript:alert(1)">x</a>'],
    ["data: link", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
    ["vbscript link", '<a href="vbscript:msgbox(1)">x</a>'],
    ["protocol-relative link", '<a href="//evil.com/x">x</a>'],
    ["relative link", '<a href="/internal/path">x</a>'],
    ["style: background url", '<p style="background:url(javascript:alert(1))">x</p>'],
    ["style: expression", '<p style="width:expression(alert(1))">x</p>'],
    ["span style smuggling", '<span style="color:#2563eb;position:fixed;top:0;left:0;width:9999px">x</span>'],
    ["span with a colour NOT on the list", '<span style="color:red">x</span>'],
    ["span with rgb colour", '<span style="color:rgb(1,2,3)">x</span>'],
    ["p with font-size", '<p style="font-size:80px">x</p>'],
    ["p with right alignment", '<p style="text-align:right">x</p>'],
    ["p with justify alignment", '<p style="text-align:justify">x</p>'],
    ["p with alignment plus other styles", '<p style="text-align:center;direction:rtl;float:right">x</p>'],
    ["class / id / data attributes", '<p class="x" id="y" data-a="1">x</p>'],
    ["style tag", "<style>p{display:none}</style><p>x</p>"],
    ["form + input", '<form action="https://evil"><input name=x></form>'],
    ["object/embed", '<object data="x"></object><embed src="x">'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.com">'],
    ["html comment tricks", "<p>a</p><!--[if IE]><script>alert(1)</script><![endif]-->"],
    ["nested/malformed", "<p><<script>script>alert(1)<</script>/script></p>"],
    ["unclosed tags", '<p><a href="https://example.com">x<strong>y'],
    ["math/mXSS style", '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">'],
    ["null byte in tag", "<scr\u0000ipt>alert(1)</scr\u0000ipt>"],
    ["srcdoc iframe", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["base tag", '<base href="https://evil.com/"><a href="x">y</a>'],
    ["link to our internal address", '<a href="https://td-operations.vercel.app/portal">x</a>'],
    ["link with login", '<a href="https://user:pass@example.com">x</a>'],
  ]
  for (const [name, html] of attacks) {
    it(`neutralises: ${name}`, () => {
      const out = sanitizeRichHtml(html)
      assertStrictShape(out)
    })
  }
  it("keeps the WORDS of a stripped link, loses the link", () => {
    const out = sanitizeRichHtml('<p>See <a href="https://td-operations.vercel.app/x">our page</a> now</p>')
    expect(richHtmlToText(out)).toBe("See our page now")
    expect(out).not.toContain("href")
  })
  it("drops script CONTENT too, not just the tag", () => {
    expect(richHtmlToText(sanitizeRichHtml("<p>hi</p><script>steal()</script>"))).toBe("hi")
  })
})

describe("resolveReplyBody — the one place a route decides what to send", () => {
  it("no html -> today's behaviour: the text is the typed message and nothing else changes", () => {
    expect(resolveReplyBody({ message: "Hello\nworld" })).toEqual({ ok: true, text: "Hello\nworld", rich: null })
    expect(resolveReplyBody({ message: 5 })).toEqual({ ok: true, text: "", rich: null })
    expect(resolveReplyBody({})).toEqual({ ok: true, text: "", rich: null })
  })

  it("derives the text FROM the sanitized html and ignores the client's own message (the halves cannot disagree)", () => {
    const r = resolveReplyBody({ message: "TOTALLY DIFFERENT TEXT", messageHtml: "<p>Real</p><ul><li><p>one</p></li></ul>" })
    expect(r).toMatchObject({ ok: true, text: "Real\n• one" })
    if (r.ok) expect(r.rich).not.toBeNull()
  })

  it("takes the PLAIN path when the sanitized result has no formatting and the style is default", () => {
    const r = resolveReplyBody({ messageHtml: "<p>Hi</p><p></p><p>there</p>", style: {} })
    expect(r).toEqual({ ok: true, text: "Hi\n\nthere", rich: null })
  })
  it("a non-default style makes even plain paragraphs formatted — and the server applies it", () => {
    const r = resolveReplyBody({ messageHtml: "<p>Hi</p>", style: { font: "Georgia", size: "large", line: "airy", para: "wide" } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rich?.style).toEqual({ font: "Georgia", size: "large", line: "airy", para: "wide" })
      expect(r.rich?.html).toContain("margin:0 0 18px 0")
      expect(r.rich?.html).toContain("line-height:1.8")
    }
  })
  it("client-supplied spacing inside the html is IGNORED — the server applies its own", () => {
    const r = resolveReplyBody({ messageHtml: '<p style="margin:0 0 500px 0;line-height:99;text-align:center">x</p>', style: {} })
    if (r.ok && r.rich) {
      expect(r.rich.html).not.toContain("500px")
      expect(r.rich.html).not.toContain("99")
      expect(r.rich.html).toContain("text-align:center")
    }
    expect(r.ok).toBe(true)
  })

  it("refuses an empty result: nothing but a script, empty paragraphs, empty list items, or invisible characters", () => {
    for (const html of ["<script>x</script>", "<p></p>", "<p></p><p></p>", "<ul><li><p></p></li></ul>", "<p>​</p>", "", "   "]) {
      expect(resolveReplyBody({ message: "x", messageHtml: html })).toEqual({ ok: false, error: "The message is empty." })
    }
  })
  it("refuses a non-string messageHtml and an oversize one", () => {
    expect(resolveReplyBody({ messageHtml: { a: 1 } })).toMatchObject({ ok: false })
    expect(resolveReplyBody({ messageHtml: 12 })).toMatchObject({ ok: false })
    expect(resolveReplyBody({ messageHtml: "<p>" + "a".repeat(RICH_HTML_MAX_CHARS) + "</p>" })).toMatchObject({ ok: false })
  })

  it("a [blank] split across tags is still visible to the guard (the text joins the pieces)", () => {
    const r = resolveReplyBody({ messageHtml: "<p>The fee is [pri<strong>c</strong>e].</p>" })
    expect(r).toMatchObject({ ok: true, text: "The fee is [price]." })
  })

  it("keeps the words of a link and writes its address into the plain half", () => {
    const r = resolveReplyBody({ messageHtml: '<p>Please <a href="https://example.com/sign">click here</a>.</p>' })
    expect(r).toMatchObject({ ok: true, text: "Please click here (https://example.com/sign)." })
    if (r.ok) expect(r.rich?.html).toContain('<a href="https://example.com/sign" target="_blank" rel="noopener noreferrer">click here</a>')
  })

  it("the output of the whole pipeline contains only allowed shapes", () => {
    const r = resolveReplyBody({
      messageHtml: '<p onclick="x">a<script>b</script></p><ul><li><a href="javascript:x">c</a></li></ul><p style="text-align:center;color:red">d</p>',
      style: { font: "Verdana", size: "huge" },
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.rich) {
      expect(r.rich.html).not.toMatch(/script|onclick|javascript|color:red/i)
    }
  })
})
