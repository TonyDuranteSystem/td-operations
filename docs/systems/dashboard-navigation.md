# Dashboard Navigation (the left menu, and opening pages without leaving the current one)
_Last verified against code: 2026-10-05 — Claude (dev job `f3f3e237`, step 1: the ⋯ menu on every left-menu item. Sandbox only — NOT in production. Seeded this doc because the left menu had none.)_

## What it is
The CRM's left menu (`components/dashboard/sidebar.tsx`) is the one list of pages Antonio and staff move between. This doc also records the multi-window project that grew out of it: Antonio wants to open **any page from any other page without leaving the one he is working on**, in floating windows he can resize, plus a working right-hand mouse button. The full project record (his requests in his words, three council rounds, the plan) is the Word document **"FLOATING WINDOWS — The Project"** in his My Drive → CRM Projects → FLOATING WINDOWS, and the dev board job `f3f3e237`.

## Business rules (Antonio's decisions, 2026-10-05)
- The ⋯ button goes on **every** left-menu item (not just the active one).
- The browser's own right-click is **left alone** — nothing in the CRM takes it over.
- Floating windows (later steps, NOT built): **at most 3**, desktop only, **resizable**.
- Nothing ships to production without his explicit "go" for that step. Steps 2–7 need their own go.

## How it's built
- **Page list:** one array (`id`, `name`, `href`, `icon`, optional badges, `adminOnly`/`ownerOnly`/`featureFlag`) in `components/dashboard/sidebar.tsx`. Every item is a real `<Link>`. **One** component, `SortableNavItem`, renders every item (a test pins "exactly one render site"), so anything added there reaches every page, including pages added later.
- **The ⋯ menu — `components/dashboard/nav-item-menu.tsx` (`NavItemMenu`):** a Radix dropdown (portalled to `<body>`, `z-[70]`, above the mobile drawer) with two actions: **Open in new tab** (a real `<a target="_blank" rel="noopener noreferrer">`) and **Copy link** (synchronous clipboard write with an honest `then/catch` toast — never a false "copied").
  - It is a **sibling** of the item's `<Link>` and is placed last in the row (after the red/violet count badges and the Team Chat dot). A button inside an anchor would navigate away when clicked.
  - Visible on hover and keyboard focus (`group-hover`, `group-focus-within`, `focus-visible`) and **always visible on touch** (`[@media(hover:none)]`). **Not rendered in reorder (edit) mode** — the drag grip owns the left edge.
  - The item name span has `min-w-0 truncate` so long names ("Pipeline Overview", "TD Communication") shorten instead of wrapping next to the button.
- **Helpers — `lib/nav/nav-link.ts`:** `isInternalNavHref` (only a normal CRM path: one leading slash, no scheme, no `//host`, no backslash, no control characters) and `absoluteNavUrl` (origin + path for "Copy link"; `null` for anything unsafe). The same gate is meant for the future window system's "never open an outside/`javascript:` address, and re-check on restore" rule.
- **Tests:** `tests/unit/nav-link.test.ts` (helpers) and `tests/unit/sidebar-nav-menu-wiring.test.ts` (structure: sibling not child, hidden in edit mode, one render site, truncate, touch/keyboard reveal, safe new-tab anchor, honest copy).
- **Items deliberately NOT in the menu:** the Tasks board (`/tasks`) — retired from the sidebar (comment above the array); its page still exists at its address.

## Gotchas, invariants & past reviews
- **Do not move the button inside the `<Link>`.** The Accounts and Leads *rows* are whole-row links; a nested button there navigates away. The Contacts row is a clickable box (`router.push` + Enter key) where a nested button's Enter would also open the contact. Row ⋯ buttons are **deferred** and need their own structure (overlay/sibling), not nesting.
- **Hover does not exist on phones/keyboards** — never make the reveal hover-only.
- **Installed-app behaviour is UNVERIFIED:** how a standalone (installed) app window treats a new tab or window (see `lib/inbox/attachment-open.ts` ~116-121 and `pwa.md`). Test "Open in new tab" in the real installed Mac app.
- **Menu-library focus return is unverified here:** Radix returns focus to the trigger on close. Harmless for these two actions; matters later if a menu item ever opens a form (the new-lead form auto-focuses its first field). Pass `onCloseAutoFocus` preventDefault for such items.
- **Per-page extra actions ("New lead", "New account") are deferred.** Three reviewers said not to mix "open a page" and "create a record" in one menu; the create dialogs are mounted only inside their own pages and navigate the mounting page after saving.
- **The window system (steps 2–7) has strict conditions from the council** — see the project record: same-origin dashboard paths only (re-checked on restore); remembered windows per signed-in person and cleared at sign-out; the launcher reuses the left menu's permission filter; a push-notification click must not wipe windows; chat marked read only when its window is focused; off-by-default runtime switch; one-day iframe spike before any window code; the shared layout decides "I am in a window" **once at first load and locks it** (refreshes use a different request label).
- **Known open gap, not part of this work:** `/code-tasks` is hidden from non-admins in the menu but has no page-level admin guard and is not in middleware's `ADMIN_ONLY_PATHS` (unverified whether a non-admin can open it by address).

## How to verify current state
- Every item has the button: open the CRM, hover any left-menu item (desktop) — a ⋯ appears at the right; on a phone width it is always visible; in "Reorder sidebar" mode it is hidden.
- "Open in new tab" opens that page in a new browser tab; "Copy link" copies `<origin><path>` and shows "Link copied."
- Code checks: `grep -c "<SortableNavItem" components/dashboard/sidebar.tsx` → 1; `npx vitest run tests/unit/nav-link.test.ts tests/unit/sidebar-nav-menu-wiring.test.ts` → green.
- Which build a sandbox address serves: `curl -s <address>/login?v=1 | grep -oE '[0-9a-f]{7,9} · [A-Z][a-z]{2} [0-9]{2}'`. This job's private address: `https://td-windows-sandbox.vercel.app` (same sandbox database as every other sandbox address; deploy from a clean clone with `--skip-domain`, never the standard deploy script, which takes the shared address).
