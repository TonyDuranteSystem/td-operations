import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * New Calendar (dev job 40235e3c) — structural guarantees, pinned as source checks (the repo's unit tests run in plain node:
 * no browser rendering). Each rule exists because the Open services page it is built on needed it.
 */

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const importsOf = (src: string) => Array.from(src.matchAll(/from\s+['"]([^'"]+)['"]/g)).map(m => m[1])

const PAGE = "app/(dashboard)/new-calendar/page.tsx"
const LIB = readdirSync(join(root, "lib/new-calendar")).map(f => `lib/new-calendar/${f}`)
const COMPONENTS = readdirSync(join(root, "components/new-calendar")).map(f => `components/new-calendar/${f}`)
const ROUTE_DIR = readdirSync(join(root, "app/(dashboard)/new-calendar"))

describe("the page", () => {
  const page = read(PAGE)
  const code = stripComments(page)

  it("is dynamic, so nothing is cached between requests", () => {
    expect(page).toContain("export const dynamic = 'force-dynamic'")
  })

  it("runs the SAME guard as Open services FIRST, before anything is loaded; a denied visitor gets notFound() outside the try block", () => {
    const guard = code.indexOf("requireOpenServicesAccess()")
    const notFound = code.indexOf("if (!access.ok) notFound()")
    const load = code.indexOf("loadNewCalendarInputs(")
    const tryAt = code.indexOf("try {")
    expect(guard).toBeGreaterThan(-1)
    expect(notFound).toBeGreaterThan(guard)
    expect(load).toBeGreaterThan(notFound)
    expect(tryAt).toBeGreaterThan(notFound)
  })

  it("passes the access proof to the loader and shows 'Could not load' instead of an empty list when a read fails, and reports it to Sentry", () => {
    expect(code).toContain("loadNewCalendarInputs(access")
    expect(page).toContain("Could not load the Calendar.")
    expect(code).toContain("Sentry.captureException(err")
  })

  it("has its own loading and error screens, and nothing else in its folder (no route handler, no layout)", () => {
    expect(ROUTE_DIR.sort()).toEqual(["error.tsx", "loading.tsx", "page.tsx"])
    expect(read("app/(dashboard)/new-calendar/error.tsx")).toContain("Nothing was changed")
  })
})

describe("read-only", () => {
  const WRITES = [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", "use server", "fetch(", "method: \"POST\"", "method: 'POST'"]
  for (const f of [...LIB, ...COMPONENTS, PAGE]) {
    it(`${f} writes nothing and calls no server action or API`, () => {
      const code = stripComments(read(f))
      for (const w of WRITES) expect(code, `${f} contains ${w}`).not.toContain(w)
    })
  }
})

describe("no service or step name in the code (every service and step on the page comes from the settings)", () => {
  const NAMES = [
    "Banking", "ITIN", "CMRA", "Tax Return", "State RA", "Annual Report", "Annual Renewal", "Company Formation",
    "Company Closure", "Client Onboarding", "EIN", "Consulting", "Notary", "Shipping", "TD Communication", "DBA", "Wrap-up",
  ]
  for (const f of [...LIB, ...COMPONENTS, PAGE]) {
    it(`${f} names no service`, () => {
      const code = stripComments(read(f))
      for (const n of NAMES) expect(code, `${f} contains "${n}"`).not.toContain(n)
    })
  }
})

describe("client/server boundary", () => {
  it("the page body imports only the client-safe modules and its own two small client pieces", () => {
    const imports = importsOf(read("components/new-calendar/new-calendar-view.tsx"))
    const mine = imports.filter(i => i.includes("new-calendar") || i.includes("open-services"))
    expect(mine.sort()).toEqual([
      "@/components/new-calendar/live-refresh",
      "@/components/new-calendar/refresh-button",
      "@/components/new-calendar/row-action",
      "@/lib/new-calendar/greeting",
      "@/lib/new-calendar/params",
      "@/lib/new-calendar/types",
      // the kind's behaviour type (the dot colour follows it): the client-safe types file, nothing else from open-services
      "@/lib/open-services/types",
    ].sort())
    expect(imports.join(" ")).not.toMatch(/supabase|lib\/services|settings|audience|\/load|\/build/)
  })

  it("the row action imports only the Wrap-up pop-up and the row type", () => {
    const imports = importsOf(read("components/new-calendar/row-action.tsx"))
    expect(imports.filter(i => i.includes("new-calendar") || i.includes("open-services")).sort()).toEqual([
      "@/components/open-services/closure-wrapup-dialog",
      "@/lib/new-calendar/types",
    ].sort())
    expect(imports.join(" ")).not.toMatch(/supabase|audience|\/load|\/build/)
  })

  it("types.ts, params.ts and greeting.ts import nothing from the server side", () => {
    for (const f of ["types", "params", "greeting"]) {
      const imports = importsOf(read(`lib/new-calendar/${f}.ts`))
      for (const i of imports) expect(["@/lib/new-calendar/types", "@/lib/open-services/types"], `${f} imports ${i}`).toContain(i)
    }
  })

  it("the two client pieces are marked 'use client'; the page body is a server component", () => {
    expect(read("components/new-calendar/row-action.tsx").startsWith("'use client'")).toBe(true)
    expect(read("components/new-calendar/refresh-button.tsx").startsWith("'use client'")).toBe(true)
    expect(read("components/new-calendar/new-calendar-view.tsx")).not.toContain("'use client'")
  })
})

describe("the loader", () => {
  const code = stripComments(read("lib/new-calendar/load.ts"))

  it("demands the access proof, checks it at run time, and reuses the Open services read for the open jobs", () => {
    expect(code).toContain("access: OpenServicesAccessGranted")
    expect(code).toContain("access not granted")
    expect(code).toContain("loadOpenServicesInputs(access)")
  })

  it("reads the finished jobs by keyset (not offset), only status completed, and throws on any read error", () => {
    expect(code).toContain(".ilike(\"status\", \"completed\")")
    expect(code).toContain(".gt(\"id\", after)")
    expect(code).not.toContain(".range(")
    expect((code.match(/throw new Error\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

describe("the What's New tab", () => {
  const view = read("components/new-calendar/new-calendar-view.tsx")
  const route = stripComments(read("app/api/crm/admin-actions/whats-new/route.ts"))
  const panel = read("components/portal-chats/thread-whats-new-panel.tsx")

  it("is a tab next to Open services and Renewals, with the live count, and shows the same panel as Portal Chats", () => {
    expect(view).toContain("What&apos;s New <WhatsNewCount />")
    expect(view).toContain("withTab(params, 'news')")
    expect(view).toContain("params.tab === 'news' ? (")
    expect(view).toContain("<WhatsNewTab />")
  })

  it("its fetching lives outside lib/new-calendar and components/new-calendar (those stay free of fetch)", () => {
    expect(existsSync(join(root, "components/whats-new/whats-new-tab.tsx"))).toBe(true)
    expect(read("components/whats-new/use-whats-new-summary.ts")).toContain("/api/crm/admin-actions/whats-new?summary=true")
    expect(stripComments(read("components/whats-new/whats-new-tab.tsx"))).toContain("ThreadWhatsNewPanel")
  })

  it("reuses the Portal Chats panel with the To-Do card button and the money actions OFF (the Calendar is the to-do)", () => {
    const tab = read("components/whats-new/whats-new-tab.tsx")
    expect(tab).toContain("showMoneyActions={false}")
    expect(tab).not.toContain("onOpenCard")
    expect(tab).not.toContain("NewCardDialog")
  })

  it("Portal Chats is unchanged by that: the panel's new props default to the old behaviour", () => {
    expect(panel).toContain("showMoneyActions = true")
    expect(panel).toContain("onOpenCard?: (note: { noteId: string; label: string }) => void")
    const page = read("app/(dashboard)/portal-chats/page.tsx")
    expect(page).toContain("onOpenCard={({ noteId, label }) => {")
  })

  it("the summary is staff-only like every other mode of the route, reads only (no write in the summary branch) and shares the visibility rule", () => {
    const summary = route.slice(route.indexOf('if (sp.get("summary") === "true") {'), route.indexOf("if (wantNotes) {"))
    expect(route.indexOf("isDashboardUser(user)")).toBeLessThan(route.indexOf('sp.get("summary")'))
    expect(summary).toContain("config.get(key)?.visible === false")
    for (const w of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) expect(summary, `summary contains ${w}`).not.toContain(w)
    expect(summary).toContain('.is("handled_at", null)')
    expect(summary).toContain('.is("deleted_at", null)')
  })

  it("the news tab does not load the Open services data, and a failed jobs read still leaves a way to the news", () => {
    const page = stripComments(read(PAGE))
    expect(page).toContain("const wantsJobs = params.tab !== 'news'")
    expect(page).toContain("if (wantsJobs) {")
    expect(page).toContain("/new-calendar?tab=news")
    expect(view).toContain("model: CalendarModel | null")
    expect(view).toContain("<JobsBody model={model} params={params} />")
  })

  it("the cross-client list is staff-only (the partner role passes isDashboardUser) and is read in honest pages of 1000", () => {
    const at = route.indexOf('sp.get("summary") === "true"')
    expect(at).toBeGreaterThan(0)
    const branch = route.slice(at, at + 2500)
    expect(branch).toContain("isStaffUser(user)")
    expect(branch).toContain("PAGE_SIZE = 1000")
    expect(branch).toContain(".range(")
    expect(branch).toContain("readTruncated")
    expect(branch).not.toContain("READ_LIMIT")
  })

  it("the panel shows a failed read and a failed Mark handled instead of 'Nothing new' or silence (R099)", () => {
    expect(panel).toContain("if (!r.ok) throw new Error(d.error")
    expect(panel).toContain("notesError && !notes")
    expect(panel).toContain("toast.error(")
  })
})

describe("the menu item and the old Calendar", () => {
  const sidebar = read("components/dashboard/sidebar.tsx")
  const layout = read("app/(dashboard)/layout.tsx")

  it("the menu has ONE Calendar item: it opens the New Calendar only for people who may see it (flag), else the existing one; the separate 'New Calendar' item is gone", () => {
    const code = stripComments(sidebar)
    expect(code).not.toContain("id: 'new-calendar'")
    expect(code).toContain("{ id: 'calendar', name: 'Calendar', href: '/calendar'")
    // the id stays 'calendar' so everyone's saved menu order holds; the href only changes behind the flag
    expect(code).toContain("item.id === 'calendar' && enabledFeatures.includes('new-calendar')")
    expect(code).toContain("href: '/new-calendar'")
    // lit on both calendar pages
    expect(code).toContain("item.id === 'calendar' && (pathname === '/calendar'")
    expect(code).toContain("pathname === '/new-calendar'")
  })

  it("the layout shows the item only to people the page itself would let in (same switch, same rule), never inside a floating window", () => {
    const code = stripComments(layout)
    expect(code).toContain("const showNewCalendar = embedded ? false : canViewOpenServices(user, await openServicesAudiencePromise)")
    expect(code).toContain("enabledFeatures={showNewCalendar ? ['new-calendar'] : []}")
  })

  it("the existing Calendar (page and components) does not mention the new one: it stays exactly as it is until Antonio says to close it", () => {
    const files = [
      "app/(dashboard)/calendar/page.tsx",
      ...readdirSync(join(root, "components/calendar")).map(f => `components/calendar/${f}`),
    ]
    for (const f of files) expect(read(f), f).not.toMatch(/new-calendar|NewCalendar/)
    expect(existsSync(join(root, "app/(dashboard)/calendar/layout.tsx"))).toBe(false)
  })

  it("the Renewals tab is a plain link to the existing Calendar, so Mark Filed is exactly as it is", () => {
    const view = read("components/new-calendar/new-calendar-view.tsx")
    expect(view).toContain("href=\"/calendar\"")
    expect(view).toContain("Renewals &amp; annual reports")
  })
})

describe("the workspace opens in a floating window, and the page updates by itself", () => {
  const rowAction = read("components/new-calendar/row-action.tsx")
  const live = read("components/new-calendar/live-refresh.tsx")
  const view = read("components/new-calendar/new-calendar-view.tsx")

  it("a row's 'Open workspace' is the window link (a real link that falls back to a normal page)", () => {
    expect(rowAction).toContain("<OpenInWindowLink")
    expect(rowAction).toContain("href={row.href}")
    const link = read("components/windows/open-in-window-link.tsx")
    expect(link).toContain("canOpenWindowNow(windowsAvailable)")
    expect(link).toContain("requestOpenWindow(href, title)")
    expect(link).toContain("isWindowLinkClick(e)")
  })

  it("the What's New tab opts in to the workspace window; Portal Chats does not", () => {
    expect(read("components/whats-new/whats-new-tab.tsx")).toContain("openWorkspaceInWindow")
    expect(read("components/portal-chats/thread-whats-new-panel.tsx")).toContain("openWorkspaceInWindow = false")
    expect(read("app/(dashboard)/portal-chats/page.tsx")).not.toContain("openWorkspaceInWindow")
  })

  it("the job lookup is opt-in (the Calendar's tab asks for it), staff-only and best-effort, so Portal Chats and a failed read are untouched", () => {
    const route = stripComments(read("app/api/crm/admin-actions/whats-new/route.ts"))
    expect(route).toContain('sp.get("want_job") === "true" && isStaffUser(user)')
    expect(route).toContain("job lookup failed (Open falls back to the client page)")
    expect(route).not.toMatch(/if \(jobsErr\) throw/)
    expect(route).toContain("!n.handled_at && WORKSPACE_SRC_TABLES.has(")
    expect(read("components/portal-chats/thread-whats-new-panel.tsx")).toContain("'&want_job=true'")
  })

  it("the failed-load screens keep the retry and the way to renewals (the menu's only door to Mark Filed is this page)", () => {
    const page = stripComments(read(PAGE))
    expect(page).toContain("<LiveRefresh />")
    expect(page).toContain('href="/calendar"')
    expect(read("app/(dashboard)/new-calendar/error.tsx")).toContain('href="/calendar"')
  })

  it("the live pieces are import-pure: the rules file imports nothing; the component imports only the rules, react and next/navigation", () => {
    expect(importsOf(read("lib/new-calendar/live.ts"))).toEqual([])
    expect(importsOf(read("components/new-calendar/live-refresh.tsx")).sort()).toEqual(["@/lib/new-calendar/live", "next/navigation", "react"].sort())
    expect(read("components/new-calendar/live-refresh.tsx").startsWith("'use client'")).toBe(true)
  })

  it("the Calendar listens for the job-change event, debounces, and has a safety poll; it never subscribes to a table itself", () => {
    expect(view).toContain("<LiveRefresh />")
    expect(live).toContain("'td-ui-event'")
    expect(live).toContain("isJobsEvent(")
    expect(live).toContain("refreshDelay(")
    expect(live).toContain("LIVE_POLL_MS")
    expect(live).not.toMatch(/supabase|postgres_changes|channel\(/)
  })

  it("the live-event trigger migration is wrapped so it can never block a job write, and is statement-level with an undo", () => {
    const up = read("scripts/migrations/20261016-1500-jobs-live-event.sql")
    expect(up).toMatch(/EXCEPTION WHEN OTHERS THEN\s+NULL/)
    expect(up).toMatch(/FOR EACH STATEMENT/)
    expect(up).toMatch(/AFTER DELETE ON public.service_deliveries/)
    expect(up).not.toMatch(/FOR EACH ROW/)
    expect(up).toMatch(/SECURITY DEFINER SET search_path = public/)
    expect(up).toContain("VALUES ('jobs', NULL)")
    expect(up).toMatch(/AFTER UPDATE OF stage, status, stage_entered_at, end_date, is_test, account_id, contact_id/)
    const undo = read("scripts/migrations/20261016-1500-jobs-live-event.UNDO.sql")
    expect(undo).toMatch(/DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_upd/)
    expect(undo).toMatch(/DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_del/)
    expect(undo).toMatch(/DROP FUNCTION IF EXISTS public.emit_jobs_ui_event/)
  })
})
