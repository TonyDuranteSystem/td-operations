/**
 * TD Social phone app, round two (6 Nov 2026): pinch-zoom is allowed inside the app only, the WhatsApp "Replies from the CRM" bar steps aside
 * while replies really go out, and the WhatsApp list names its second section correctly. The computer keeps its page settings untouched.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { allowPinchZoom, applyPinchZoom, APP_MAX_ZOOM, APP_MIN_ZOOM } from "@/lib/app-mode/zoom"

const root = join(__dirname, "..", "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")

describe("allowPinchZoom: only the zoom words change", () => {
  it("lifts the lock the CRM pages set (maximum-scale=1, user-scalable=no)", () => {
    expect(allowPinchZoom("width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"))
      .toBe(`width=device-width, initial-scale=1, minimum-scale=${APP_MIN_ZOOM}, maximum-scale=${APP_MAX_ZOOM}, user-scalable=yes`)
  })

  it("keeps every other word exactly (the notch setting must survive)", () => {
    const out = allowPinchZoom("width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover")
    expect(out).toContain("viewport-fit=cover")
    expect(out).toContain("initial-scale=1")
    expect(out).not.toContain("user-scalable=no")
    expect(out).not.toContain("maximum-scale=1,")
  })

  it("handles the Marketing page, which has no lock at all", () => {
    expect(allowPinchZoom("width=device-width, initial-scale=1, viewport-fit=cover"))
      .toBe(`width=device-width, initial-scale=1, viewport-fit=cover, minimum-scale=${APP_MIN_ZOOM}, maximum-scale=${APP_MAX_ZOOM}, user-scalable=yes`)
  })

  it("replaces a page's own minimum-scale, ignores capitals and spaces around '=', and never leaves two zoom words", () => {
    const out = allowPinchZoom("width=device-width, Minimum-Scale = 0.5, MAXIMUM-SCALE=1, User-Scalable=no")
    expect(out).toBe(`width=device-width, minimum-scale=${APP_MIN_ZOOM}, maximum-scale=${APP_MAX_ZOOM}, user-scalable=yes`)
    expect(out.match(/minimum-scale/g)).toHaveLength(1)
    expect(out.match(/maximum-scale/g)).toHaveLength(1)
    expect(out.match(/user-scalable/g)).toHaveLength(1)
  })

  it("the page can never be shrunk below the screen (a pinch-in stops at normal size, no blank margins)", () => {
    expect(APP_MIN_ZOOM).toBe(1)
    expect(allowPinchZoom("width=device-width, initial-scale=1")).toContain("minimum-scale=1")
  })

  it("a missing or empty setting still gets a width, so the page keeps fitting the phone", () => {
    for (const empty of [null, undefined, "", "  ,  "]) {
      expect(allowPinchZoom(empty)).toBe(`width=device-width, minimum-scale=${APP_MIN_ZOOM}, maximum-scale=${APP_MAX_ZOOM}, user-scalable=yes`)
    }
  })

  it("is idempotent: applying it to its own result changes nothing (the watcher in the provider cannot loop)", () => {
    const once = allowPinchZoom("width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover")
    expect(allowPinchZoom(once)).toBe(once)
  })
})

describe("applyPinchZoom on a page", () => {
  const fakeDoc = (content: string | null) => {
    const attrs: Record<string, string> = content === null ? {} : { content }
    let tag: { name: string; getAttribute: (k: string) => string | null; setAttribute: (k: string, v: string) => void } | null =
      content === null ? null : { name: "viewport", getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v } }
    const doc = {
      querySelector: () => tag,
      createElement: () => ({ name: "", getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v } }),
      head: { appendChild: (el: typeof tag) => { tag = el } },
    }
    return { doc: doc as unknown as Document, attrs }
  }

  it("changes the locked setting once and reports it", () => {
    const { doc, attrs } = fakeDoc("width=device-width, maximum-scale=1, user-scalable=no")
    expect(applyPinchZoom(doc)).toBe(true)
    expect(attrs.content).toContain("user-scalable=yes")
    expect(applyPinchZoom(doc)).toBe(false) // second time: nothing to do
  })

  it("adds a setting when the page has none", () => {
    const { doc, attrs } = fakeDoc(null)
    expect(applyPinchZoom(doc)).toBe(true)
    expect(attrs.content).toBe(`width=device-width, minimum-scale=${APP_MIN_ZOOM}, maximum-scale=${APP_MAX_ZOOM}, user-scalable=yes`)
  })
})

describe("wiring: the app lifts the lock, the computer does not", () => {
  it("the provider applies it only when the app marker is on, watches the head, and stops watching on exit", () => {
    const p = src("components/app-mode/app-mode-provider.tsx")
    expect(p).toContain("applyPinchZoom")
    expect(p).toMatch(/useEffect\(\(\) => \{\s*if \(!appMode\) return\s*applyPinchZoom\(document\)/)
    expect(p).toContain("new MutationObserver")
    expect(p).toContain("watcher.disconnect()")
  })

  it("the pages' own zoom lock is still written for the computer and the normal phone browser", () => {
    expect(src("app/layout.tsx")).toMatch(/maximumScale: 1,\s*userScalable: false/)
    expect(src("app/talk/layout.tsx")).toMatch(/maximumScale: 1,\s*userScalable: false/)
  })

  it("typing boxes are 16 px in the app (so the iPhone does not jump-zoom on a tap) and double-tap zoom is off, all behind the app marker", () => {
    const css = src("app/globals.css")
    expect(css).toMatch(/\[data-app-mode="true"\] textarea \{ font-size: 16px !important; \}/)
    expect(css).toMatch(/\[data-app-mode="true"\] select \{ font-size: 16px !important; \}/)
    expect(css).toMatch(/\[data-app-mode="true"\] input:not\(\[type="checkbox"\]\)[^{]*\{ font-size: 16px !important; \}/)
    expect(css).toMatch(/\[data-app-mode="true"\] \{ touch-action: manipulation; \}/)
  })
})

describe("WhatsApp: the CRM-replies bar and the list title", () => {
  const sw = src("components/inbox/whatsapp-send-switch.tsx")

  it("the bar steps aside in the app only while replies really go out (Live); Test mode and Paused still show it", () => {
    expect(sw).toContain("const appMode = useAppMode()")
    expect(sw).toContain("if (appMode && state.mode === 'live') return null")
    // the hide is the ONLY app-mode branch: no other mode is ever hidden
    expect(sw.match(/appMode/g)?.length).toBe(2)
  })

  it("the bar is still drawn by the Inbox for the computer, unchanged", () => {
    expect(src("components/inbox/inbox-shell.tsx")).toContain("{isWhatsApp && !(appMode && selected) && <WhatsAppSendSwitch />}")
  })

  it("the second section of the WhatsApp list is 'All chats', the email list keeps 'All email'", () => {
    const list = src("components/inbox/conversation-list.tsx")
    expect(list).toContain("isWhatsApp ? sectionHeader('All chats', 'chat') : sectionHeader('All email', 'mail')")
    expect(list).toContain("icon === 'chat' ? <MessageSquare")
  })
})
