# New Calendar (the day-by-day work list, built on the Open services data)
_Last verified against code: 2026-10-16 — Claude (dev job `40235e3c`, child of `be7da01a`; SANDBOX — Antonio ships). v1 is READ-ONLY. Built from Antonio's October 1 mockup. Not on production yet._

## What it is
`/new-calendar` (left menu: **New Calendar**, right after the existing Calendar). Antonio, 2026-10-15/16: "I want a place to work day by day — that is the calendar. When we open the CRM in the morning we see what we have to do, what is left, what the clients must do, what is on us" and "ship the October 1 calendar mockup in the sidebar, named New Calendar, so we can test it; then we close the old calendar". It shows the SAME jobs as `/calendar/open-services` (which nothing linked to — it was invisible) sorted into four lists:

- **To work on** — a step that is ours; a follow-up that ran late (whoever it was waiting for); a job on the last step (nobody is waiting: close it). The header says "Good morning, <first name> — N jobs to work on today" (N = this list, never moved by search or filters).
- **Pending** — steps waiting on the client, an outside office (IRS, state, bank) or a date; also PAUSED jobs (blocked, on hold, company not operating — never counted late).
- **Not sorted yet** — the step has no "waiting on" setting (or the step is not in the settings). The page does not guess. (On production at the time of writing these were the 226 mailing-address jobs.)
- **Closed · last 30 days** — jobs with status `completed` whose finish date is in the last 30 days.

Under the lists: **service chips** (services present in the chosen list, biggest first, "All services"), and after choosing a service **that service's own steps as chips** (from the step settings, in order, dot colour = whose turn; the number = open jobs on that step). Choosing a step shows EVERY open job on that step whichever list it is in (no list is highlighted; "Clear" goes back). A search box (company or person name, plain text, never a database filter) and "Show more" (50 rows at a time, ceiling 5000, stated not hidden). A table: Client / Service / Step now (+ pill) / Days (red + "(Nd late)" when late; the finish day on Closed) / Next step / action.

**The action cell.** A step whose layout lists a Calendar pop-up component (data: `CALENDAR_POPUPS` in `lib/open-services/types.ts`, today `closure_wrapup`) opens that pop-up ON the row (the Wrap-up of a Company Closure, `components/open-services/closure-wrapup-dialog.tsx`; see `formation.md`), no link out. Every other row says "Open workspace →" (the job page) in v1.

**Tabs.** "Open services" (this page) and "Renewals & annual reports →", a plain link to the EXISTING `/calendar`, so Mark Filed and the renewals work are exactly as they were. The existing Calendar and the Open services page are NOT edited (a test pins that the Calendar files never mention this page).

**NOT in v1 (by design, said to Antonio):** the "What's New (portal)" feed, the side panel with history, "Done: step" buttons that move a job from inside the Calendar, decision pop-ups other than the Wrap-up. Those are the next slices.

## Business rules
- **Same switch and same guard as Open services**: `app_settings.open_services_audience` = `off | owners | all` (see `open-services.md`). The page calls `requireOpenServicesAccess()` FIRST on every request; a denied visitor gets the ordinary not-found page. The left-menu item shows only when `canViewOpenServices(user, audience)` is true (the layout reads the setting once and passes `enabledFeatures=['new-calendar']`; inside a floating window the menu is not drawn at all), so the item can never be a dead link. **When this ships to production the switch is already `all`, so every staff member will see the item at once; set it to `owners` first if only Antonio should.**
- **Every open job is in exactly one list** (`bucketOf` in `lib/new-calendar/build.ts`): paused → Pending; late → To work on; ours or last step → To work on; waiting-on not set → Not sorted yet; otherwise Pending. "Open", "late", "paused", test/internal exclusions and the jobs that live on other pages (renewals, tax returns: the two service-card flags) are decided by the Open services classifier, unchanged — see `open-services.md`.
- **Closed** = `service_deliveries.status` ILIKE `completed`; finish date = the recorded `end_date` if there is one, else `stage_entered_at` (the day it reached its last step); listed if that date is within 30 days (and not more than one day in the future). A job with neither date is left out, not guessed. There is no `completed_at` column (verified 2026-10-16); `updated_at` is NOT used because bulk edits touch it (163 EIN jobs all read "updated in the last 30 days"). Same people rules as the open list (test job / test or internal company / test person) and jobs that live on other pages are left out.
- **READ-ONLY.** No writes, no server actions, no API route; a test pins that the code contains none. The only entry to the data is the page route behind the guard.
- No service or step name is written in the code (a test pins it): every service, step and pop-up comes from the data.

## How it's built
- Files: `lib/new-calendar/{types,params,greeting}.ts` (pure, client-safe), `build.ts` (pure builder on top of `classify()` from `lib/open-services/build.ts`), `load.ts` (server loader: `loadOpenServicesInputs()` + the finished-jobs read, throws on any read error), `app/(dashboard)/new-calendar/{page,loading,error}.tsx`, `components/new-calendar/new-calendar-view.tsx` (SERVER component: every chip is a link to a new web address, the server re-renders) + two tiny client pieces (`row-action.tsx`, `refresh-button.tsx`).
- All page state is in the web address: `b` (list), `s` (service), `st` (step), `q` (search), `n` (rows). Parsed defensively (`params.ts`).
- Small additions to Open services code: `normalizeName` (build.ts) and `readAll`/`chunk`/`unique`/`PAGE`/`CHUNK` (load.ts) are now exported; nothing else about them changed.
- Left menu: `components/dashboard/sidebar.tsx` (item `new-calendar`, `featureFlag: 'new-calendar'`), `app/(dashboard)/layout.tsx` (passes the flag), and `new-calendar` is in `WINDOW_PAGE_ROOTS` (`lib/windows/window-model.ts`; a test requires every dashboard folder to be listed).
- Tables read (service client, after the guard): `service_deliveries`, `pipeline_stages`, `catalog_entries`, `accounts`, `contacts`. No new tables or columns, no migration.

## Gotchas, invariants & past bugs
- The greeting hour must be read with `hourCycle: 'h23'`: with `hour12: false` midnight comes back as "24" and 00:30 would say "Good evening" (caught by a test).
- A returning user's saved left-menu order is reset to the default once whenever a new menu item is added (existing behaviour of the sidebar: it only keeps a saved order that already contains every item). Not specific to this page.
- The Closed list's date is "when the job reached its last step" unless an end date was recorded — an approximation Antonio has not reviewed. Company Formation has end dates on only 18 of 191 completed jobs.
- "Not sorted yet" is large on day one on purpose (mailing-address jobs have no waiting-on setting). Filling the setting on the step moves them; the page never guesses.
- The step chips count open jobs by the step NAME (case/space-insensitive); a job sitting on a name that is not in the settings shows under its service but on no step chip.

## How to verify current state
1. `select value from app_settings where key='open_services_audience'` → who can open it (`off` = nobody, and the menu item is hidden).
2. Header number vs a direct count: open jobs (not completed/cancelled/inactive, not test/internal, not renewal/tax) whose step is waiting_on `us` or is the done step, plus the late follow-ups. Compare with `/calendar/open-services` "Waiting on us" + "Nobody is waiting" + late jobs in the other groups.
3. `npx vitest run tests/unit/new-calendar-*.test.ts` (lists, chips, Closed window, params, greeting, wiring, no-write, no-service-name).
4. Browser: sign in as staff → left menu → New Calendar; click a list, a service, a step; a Company Closure on its Wrap-up step shows "Wrap up…" and opens the pop-up on the row.
