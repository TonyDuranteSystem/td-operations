/**
 * Source guards for the flexible left menu (dev job 45aa5872). The pure rules are tested in menu-layout.test.ts; these pin the
 * wiring that must not drift because there is no DOM test in this suite:
 *  - every page the standard groups name really exists in the menu's page list, and page ids never look like group ids;
 *  - WHO sees a page is decided per page (never by group), and a saved layout is read through the shape check;
 *  - the save route is staff-only and scoped to the caller's own row;
 *  - the Inbox is one channel per page and the red numbers are split (WhatsApp only, never Telegram).
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { STANDARD_GROUPS, GROUP_ID_PREFIX } from "@/lib/nav/menu-layout"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const sidebar = read("components/dashboard/sidebar.tsx")

const registry = sidebar.slice(sidebar.indexOf("const defaultNavigation"), sidebar.indexOf("const PAGE_IDS"))
const pageIds = [...registry.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map(m => m[1])

describe("the page list and the standard groups agree", () => {
  it("found the pages", () => {
    expect(pageIds.length).toBeGreaterThan(30)
    expect(new Set(pageIds).size).toBe(pageIds.length) // no repeats
  })
  it("every standard group member is a real page", () => {
    for (const g of STANDARD_GROUPS) for (const c of g.children) expect(pageIds, `${g.id} -> ${c}`).toContain(c)
  })
  it("no page id can be mistaken for a group id", () => {
    for (const id of pageIds) expect(id.startsWith(GROUP_ID_PREFIX)).toBe(false)
  })
  it("Antonio's two new rows exist, Marketing Chat for the owner's login only", () => {
    expect(registry).toContain("{ id: 'whatsapp', name: 'WhatsApp', href: '/inbox?channel=whatsapp'")
    expect(registry).toMatch(/\{ id: 'marketing-chat', name: 'Marketing Chat', href: '\/marketing\/chat', icon: MessageSquareText, ownerOnly: true/)
    // the existing Marketing row stays: it is the whole Marketing section, not only its chat
    expect(registry).toContain("{ id: 'marketing', name: 'Marketing', href: '/marketing-leads'")
  })
})

describe("who sees a page is decided per page, after the layout", () => {
  it("isVisible keeps the admin-only / owner-only / feature rules and the menu uses it for every row and the editor", () => {
    expect(sidebar).toContain("if (item.adminOnly && !isAdmin && !extraNavIds.includes(item.id)) return false")
    expect(sidebar).toContain("if (item.ownerOnly && !isOwner) return false")
    expect(sidebar).toContain("if (item.featureFlag && !enabledFeatures.includes(item.featureFlag)) return false")
    expect(sidebar).toContain("visibleRows(layout, isVisible, true)")
    expect(sidebar).toContain("isVisible={isVisible}")
  })
  it("a saved layout is shape-checked and made current before it is used (never trusted as is)", () => {
    const hook = read("components/dashboard/use-menu-layout.ts")
    expect(hook).toContain("resolveLayout(initial, pageIds)")
    expect(hook).toContain("parseLayout(")
    expect(hook).toContain("reconcileLayout(")
  })
})

describe("saving the layout", () => {
  const route = read("app/api/dashboard/menu-layout/route.ts")
  it("is staff only and only ever touches the caller's own row (the id comes from the session)", () => {
    expect(route).toContain("isDashboardUser(user)")
    expect(route).toMatch(/saveStaffMenuLayout\(userId, layout\)/)
    expect(route).toMatch(/resetStaffMenuLayout\(userId\)/)
    expect(route).not.toMatch(/request\.json\(\)[\s\S]*auth_user_id/)
  })
  it("refuses a layout that is not valid or is too big, with a plain reason (R099)", () => {
    expect(route).toContain("parseLayout(")
    expect(route).toContain("MAX_LAYOUT_BYTES")
    expect(route).toContain("not valid, so it was not saved")
  })
  it("the browser shows the server's own reason when a save fails, and keeps a local copy", () => {
    const hook = read("components/dashboard/use-menu-layout.ts")
    expect(hook).toContain("(d as { error?: string }).error")
    expect(hook).toContain("window.localStorage.setItem(localKey")
  })
  it("reading never throws and has three answers: saved / none (no row or no table yet) / unavailable (the read failed)", () => {
    const server = read("lib/nav/menu-layout-server.ts")
    expect(server).toContain("tableMissing(error) ? 'none' : 'unavailable'")
    expect(server).toMatch(/catch \{\s*return \{ status: 'unavailable' \}/)
    expect(server).toContain("42P01")
    expect(server).toContain("PGRST205")
  })
  it("when the saved layout could not be read, editing is switched off so nothing is saved over it", () => {
    expect(read("app/(dashboard)/layout.tsx")).toContain("menuLayoutStatus={menuRead.status}")
    const hook = read("components/dashboard/use-menu-layout.ts")
    expect(hook).toContain("const canEdit = status !== 'unavailable'")
    expect(hook).toMatch(/if \(!canEdit\) return\s*\n\s*latest\.current = next/)
    expect(sidebar).toContain("disabled={!canEdit}")
    expect(sidebar).toContain("if (!canEdit) return undefined")
  })
  it("an unsent edit is kept as 'unsynced' here and wins after a reload; a tab that was left open picks up the account's newer layout unless you are editing", () => {
    const hook = read("components/dashboard/use-menu-layout.ts")
    expect(hook).toContain("writeLocal(next, false)")
    expect(hook).toContain("pickLayoutOnLoad(")
    expect(hook).toContain("document.addEventListener('visibilitychange', refresh)")
    expect(hook).toMatch(/if \(busyRef\.current \|\| timer\.current \|\| inflight\.current\) return/)
    expect(read("app/api/dashboard/menu-layout/route.ts")).toMatch(/export async function GET\(\)/)
  })
  it("Reset is the standard layout after a reload too (it clears the old per-browser order), and a failed reset shows the old layout again", () => {
    const hook = read("components/dashboard/use-menu-layout.ts")
    expect(hook).toContain("for (const k of LEGACY_KEYS) window.localStorage.removeItem(k)")
    expect(hook).toContain("setLayout(previous)")
  })
  it("the table is server-only: RLS on, public roles revoked", () => {
    const sql = read("scripts/migrations/20261104-1900-staff-menu-layouts.sql")
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY")
    expect(sql).toContain("REVOKE ALL ON public.staff_menu_layouts FROM anon, authenticated")
    expect(sql).toContain("select public.marketing_lock_all_tables();".replace("select", "SELECT"))
  })
})

describe("Inbox and WhatsApp are two menu pages on one screen", () => {
  it("the page reads the address and remounts the shell per channel", () => {
    const page = read("app/(dashboard)/inbox/page.tsx")
    expect(page).toContain("inboxChannelFromParams(thread, channelParam)")
    expect(page).toContain("<InboxShell key={channel} channel={channel}")
  })
  it("a one-channel screen shows a title, not the Gmail/WhatsApp tabs, and ignores an address for the other channel", () => {
    const shell = read("components/inbox/inbox-shell.tsx")
    expect(shell).toContain("onlyChannel={lockedChannel}")
    expect(shell).toContain("if (lockedChannel && inboxChannelFromParams(thread, params.get('channel')) !== lockedChannel) return")
    expect(shell).toContain("if (lockedChannel) return")
  })
  it("the WhatsApp tour points at the page title now that the tab is gone", () => {
    expect(read("components/inbox/whatsapp-tour.tsx")).toContain('target: \'[data-tour="wa-title"]\'')
    expect(read("components/inbox/inbox-header.tsx")).toContain("'wa-title'")
  })
})

describe("the red numbers are split", () => {
  it("the WhatsApp number is WhatsApp only (never Telegram), from one helper used by the layout, the poll and the Inbox stats", () => {
    const helper = read("lib/inbox/whatsapp-unread.ts")
    expect(helper).toContain('.eq("platform", "whatsapp")')
    for (const f of ["app/(dashboard)/layout.tsx", "app/api/dashboard/badges/route.ts", "app/api/inbox/stats/route.ts"]) {
      expect(read(f), f).toContain("getWhatsappUnread()")
    }
  })
  it("the Inbox row is email only: the page-load seed no longer counts chat conversations", () => {
    const layout = read("app/(dashboard)/layout.tsx")
    expect(layout).not.toContain("v_messaging_inbox")
    expect(layout).toMatch(/return \{ inbox: 0, whatsapp: whatsappUnread/)
  })
  it("a new inbound chat message asks the server for the WhatsApp number instead of adding one (it could be Telegram) — the LIGHT question, at most once per 10 seconds per tab", () => {
    expect(sidebar).toContain("d.whatsapp")
    expect(sidebar).toContain("fetch('/api/dashboard/badges?only=whatsapp')")
    expect(sidebar).toContain("Math.max(1000, 10_000 - (Date.now() - lastRun))")
    const route = read("app/api/dashboard/badges/route.ts")
    const light = route.slice(route.indexOf("searchParams.get('only') === 'whatsapp'"), route.indexOf("try {\n    // Who is asking"))
    expect(light).toContain("isDashboardUser(user)")
    expect(light).toContain("getWhatsappUnread()")
    expect(light).not.toContain("gmailGet")
    expect(light).not.toContain("getDb()")
    expect(sidebar).not.toMatch(/setLiveInbox\(prev => prev \+ 1\)/)
    expect(sidebar).not.toMatch(/setLiveWhatsapp\(prev => prev \+ 1\)/)
  })
})

describe("bug-hunt fixes (2026-11-04) that must not drift", () => {
  const groups = read("components/dashboard/menu-groups.tsx")
  it("the chat dot shows NEXT TO the numbers (a number is almost always there and used to hide it)", () => {
    expect(groups).toContain("const dot = items.some(i => i.dotBadge)")
    expect(groups).not.toContain("dotBadge) && red === 0")
  })
  it("two rows that show the same number are counted once in a group's total", () => {
    expect(groups).toContain("const key = i.badgeKey ?? i.id")
    expect(sidebar).toContain("badgeKey: 'marketing'")
  })
  it("Esc inside a ⋯ menu closes that menu only, and scrolling does not close the panel under an open menu", () => {
    expect(groups).toContain("e.key === 'Escape' && panelRef.current?.contains(e.target as Node)")
    expect(groups).toMatch(/const scroll = \(e: Event\) => \{ if \(holds\.current === 0/)
    // the panel's Esc handler looks first (capture phase), before the open ⋯ menu handles the same key and releases its hold
    expect(groups).toContain("document.addEventListener('keydown', key, true)")
    // closing the last menu does not close a panel the pointer is still on
    expect(groups).toContain("!document.querySelector('[data-flyout]:hover')")
  })
  it("tabbing out of the panel closes it (unless a menu is open), and the panel lives inside the shell frame so it gets the sandbox colours", () => {
    expect(groups).toContain("ctl.closeIfIdle()")
    expect(groups).toContain("closest('[data-embedded]')")
  })
  it("Compose does the one thing that fits the screen: no menu on a one-channel screen", () => {
    const shell = read("components/inbox/inbox-shell.tsx")
    expect(shell).toContain("if (lockedChannel === 'gmail') { setForwardData(null); setComposeOpen(true) }")
    expect(shell).toContain("else if (lockedChannel === 'whatsapp') setWhatsappPickerOpen(true)")
    expect(shell).toContain("{composeMenuOpen && !lockedChannel && (")
  })
  it("the name box closes with Esc, and opening it shuts any panel", () => {
    expect(read("components/dashboard/menu-editor.tsx")).toContain("if (e.key === 'Escape') { e.stopPropagation(); onClose() }")
    expect(sidebar).toContain("[pathname, search, editMode, naming, closeFlyout]")
  })
  it("the numbers refresh when you switch between Inbox and WhatsApp (same path)", () => {
    expect(sidebar).toContain("}, [pathname, onWhatsapp])")
  })
  it("the Windows tour's fast-way step points at Network → Leads, and the ring takes the first target that exists", () => {
    expect(read("lib/windows/tour-steps.ts")).toContain("[data-testid=\"menu-group-g-network\"]")
    expect(read("components/ui/tour-ring.tsx")).toContain("selector.split(' || ')")
  })
})
