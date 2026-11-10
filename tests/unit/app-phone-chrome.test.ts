/**
 * TD Social phone app — the Portal chat conversation's phone layout (dev job 2072bc3e, 5 Nov 2026; the approved mockup's "A client's chat").
 * The pieces are pure arrangement (every action is the page's own handler), so these tests pin: what each piece says, that they are safe to
 * render on the server (no document), and — by reading the page source, as the other app-mode guards do — that the phone pieces appear ONLY
 * under the app-mode check while the computer layout keeps every control it had (Send as, Replying in, the tab row, the header).
 */
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "fs"
import { join } from "path"
import {
  PhoneConvNav, PhoneViewStrip, PhoneReplyToLine, PhoneMoreSheet, PhoneReplyToSheet, PhonePlusSheet, PHONE_VIEW_LABELS,
} from "@/components/portal-chats/app-phone-chrome"
import { AppThreadActions } from "@/components/inbox/app-thread-actions"
import { appThreadPlan } from "@/lib/inbox/app-thread-actions"

const noop = () => undefined
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe("PhoneConvNav", () => {
  it("shows the name, the subtitle and what is waiting under the menu", () => {
    const out = html(createElement(PhoneConvNav, { title: "Acme Sample LLC", subtitle: "Monica Sample", badge: 3, onBack: noop, onMore: noop }))
    expect(out).toContain("Acme Sample LLC")
    expect(out).toContain("Monica Sample")
    expect(out).toContain(">3<")
    expect(out).toContain("Conversation menu, 3 new")
    expect(out).toContain("Back to the list")
  })

  it("shows no number when nothing is waiting, and links the name only when told to", () => {
    const plain = html(createElement(PhoneConvNav, { title: "Acme", badge: 0, onBack: noop, onMore: noop }))
    expect(plain).not.toContain("new")
    expect(plain).not.toContain("<a ")
    const linked = html(createElement(PhoneConvNav, { title: "Acme", titleHref: "/accounts/1", badge: 0, onBack: noop, onMore: noop }))
    expect(linked).toContain('href="/accounts/1"')
  })

  it("caps a huge count", () => {
    expect(html(createElement(PhoneConvNav, { title: "A", badge: 250, onBack: noop, onMore: noop }))).toContain("99+")
  })
})

describe("PhoneViewStrip", () => {
  it("is empty on Messages and names the open view otherwise, leading back", () => {
    expect(html(createElement(PhoneViewStrip, { view: "messages", onMessages: noop }))).toBe("")
    for (const v of ["whatsnew", "ideas", "todo", "email", "worker"] as const) {
      const out = html(createElement(PhoneViewStrip, { view: v, onMessages: noop }))
      expect(out).toContain("Messages")
      expect(out).toContain(PHONE_VIEW_LABELS[v].replace("'", "&#x27;"))
    }
  })

  it("has a label for every view the old tab row had", () => {
    expect(Object.values(PHONE_VIEW_LABELS)).toEqual(["Messages", "What's New", "Idea request", "To Do", "Email", "Worker"])
  })
})

describe("PhoneReplyToLine: who the reply goes to, in which topic", () => {
  it("says the target and the topic", () => {
    const out = html(createElement(PhoneReplyToLine, { target: "Acme Sample LLC", topic: "Invoices", closed: false, onChange: noop }))
    expect(out).toContain("Acme Sample LLC")
    expect(out).toContain("Invoices")
    expect(out).toContain("Change")
    expect(out).toContain("Reply to Acme Sample LLC, topic Invoices. Tap to change.")
  })

  it("a closed company is marked in words AND colour (the client cannot see messages sent there)", () => {
    const out = html(createElement(PhoneReplyToLine, { target: "Old Co", topic: "General", closed: true, onChange: noop }))
    expect(out).toContain("closed")
    expect(out).toContain("bg-red-50")
  })

  it("Personal is a normal target", () => {
    expect(html(createElement(PhoneReplyToLine, { target: "Personal", topic: "General", closed: false, onChange: noop }))).toContain("Personal")
  })
})

describe("the sheets are safe on the server (no document there)", () => {
  it("render nothing, and never throw", () => {
    const more = html(createElement(PhoneMoreSheet, {
      open: true, onClose: noop, view: "messages", counts: { whatsnew: 1, ideas: 0, email: 0 }, onView: noop, canMarkUnread: true,
      onMarkUnread: noop, onRefresh: noop, onAi: noop,
    }))
    const reply = html(createElement(PhoneReplyToSheet, {
      open: true, onClose: noop, companies: null, selectedCompanyId: null, onCompany: noop, topics: [], activeTopic: "", onTopic: noop, onCreateTopic: noop,
    }))
    const plus = html(createElement(PhonePlusSheet, { open: true, onClose: noop, onEmoji: noop, onAttach: noop, onAi: noop, aiBusy: false, attachBusy: false }))
    expect([more, reply, plus]).toEqual(["", "", ""])
  })
})

const root = join(__dirname, "..", "..")
const page = readFileSync(join(root, "app/(dashboard)/portal-chats/page.tsx"), "utf8")

describe("the Portal chats page: phone pieces only in the app, the computer layout keeps everything", () => {
  it("every phone piece is rendered behind the app-mode check", () => {
    for (const piece of ["<PhoneConvNav", "<PhoneViewStrip", "<PhoneMoreSheet", "<PhoneReplyToSheet", "<PhonePlusSheet", "<PhoneReplyToLine", "<PhonePlusButton"]) {
      const at = page.indexOf(piece)
      expect(at, piece).toBeGreaterThan(-1)
      // the nearest guard before the piece must be an app-mode check (the sheets share one guarded block with the view strip)
      const before = page.slice(Math.max(0, at - 3000), at)
      expect(before, piece).toMatch(/appMode &&/)
    }
  })

  it("the old header and the old tab row stay in the page (hidden in the app, never removed)", () => {
    expect(page).toMatch(/className="app-conv-header app-hide /)
    expect(page).toMatch(/className="app-tabs-scroll app-hide flex /)
  })

  it("the computer 'Send as' row and 'Replying in' bar still exist and only step aside in the app", () => {
    expect(page).toMatch(/selectedThreadCompanies\.length > 0 && !selectedAccountId && !appMode && \(/)
    expect(page).toMatch(/!sendingToClosedAccount && \(!appMode \|\| selectMode\) && \(/)
    expect(page).toContain("Send as</span>")
    expect(page).toContain("Replying in: ")
  })

  it("the phone 'Reply to' line reads the SAME state the send uses (a closed company stays flagged)", () => {
    expect(page).toMatch(/const phoneReplyTarget = selectedAccountId\s*\?\s*\(currentThreadForGuard\?\.company_name/)
    expect(page).toMatch(/selectedCompanyId \? \(selectedThreadCompanies\.find\(c => c\.id === selectedCompanyId\)\?\.name/)
    expect(page).toMatch(/closed=\{sendingToClosedAccount\}/)
  })

  it("the closed-company warning stays, and points at 'Change' in the app instead of a row that is not there", () => {
    expect(page).toContain("Tap Change to pick an active company")
    expect(page).toContain("Pick an active company above, or")
  })

  it("the three composer buttons the '＋' menu replaces are hidden in the app, not removed", () => {
    expect(page).toMatch(/className="app-hide p-2 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"/)
    expect(page).toMatch(/'app-hide p-2 rounded-full transition-colors shrink-0'/)
    expect(page).toMatch(/className="app-hide p-2 rounded-full text-violet-500/)
  })

  it("both the computer Back button and the phone back arrow leave through ONE function", () => {
    expect(page).toContain("const leaveConversation = () => {")
    expect(page.match(/onBack=\{leaveConversation\}/g)?.length).toBe(1)
    expect(page).toMatch(/onClick=\{leaveConversation\}/)
  })
})

describe("round two (5 Nov 2026, after the first real-phone look)", () => {
  const waPlan = appThreadPlan({ channel: "whatsapp", isTrash: false, hasWhatsAppGroup: true })
  const emailPlan = appThreadPlan({ channel: "gmail", isTrash: false, hasWhatsAppGroup: false })
  const handlers = { reply: noop, archive: noop, toggleRead: noop, delete: noop, worker: noop, copyLink: noop, task: noop }
  const render = (plan: typeof waPlan, compact: boolean) => html(createElement(AppThreadActions, { plan, unread: false, starred: false, busy: false, handlers, compact }))

  it("a WhatsApp chat shows ONLY the menu button in the title row: no Reply row (it only scrolled to the box already on screen)", () => {
    const out = render(waPlan, true)
    expect(out).toContain("More actions")
    expect(out).not.toContain("Reply")
    expect(out).toContain("ml-auto")
  })

  it("an email keeps its full action row with Reply (there it opens the full reply screen)", () => {
    const out = render(emailPlan, false)
    for (const word of ["Reply", "Archive", "Unread", "Delete", "More actions"]) expect(out).toContain(word)
    expect(out).toContain("basis-full")
  })

  const src = (p: string) => readFileSync(join(root, p), "utf8")
  it("the Inbox shell asks for the compact menu on WhatsApp only", () => {
    expect(src("components/inbox/inbox-shell.tsx")).toContain("compact={selected.channel === 'whatsapp'}")
  })

  it("the 'no ID or tax documents over WhatsApp' reminder is GONE (Antonio 2026-11-10: remove the limit for ID and passport) — on the computer and in the app; the phone sheet can still show a note for other uses", () => {
    const wa = src("components/inbox/whatsapp-thread.tsx")
    expect(wa).not.toMatch(/ID or tax documents/)
    expect(wa).not.toContain("attachNote=")
    expect(src("components/portal-chats/app-phone-chrome.tsx")).toContain('data-testid="attach-note"')
  })

  it("the Portal list's Chats / Actions / Team switch is hidden in the app, never removed (the computer keeps it)", () => {
    expect(page).toMatch(/<div className="app-hide flex rounded-lg bg-zinc-100 p-0\.5">/)
    expect(page).toContain("setSidebarView('internal'); setSelectedAccountId(null)")
    expect(page).toContain("setSidebarView('actions')")
    // the 8 px gap that belonged to that row goes with it, in the app only (the computer keeps it)
    expect(page).toContain("cn('flex items-center justify-between', !appMode && 'mb-2')")
  })
})
