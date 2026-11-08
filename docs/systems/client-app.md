# Client iPhone App (MyLLC Manager 2.0)
_Last verified against code: 2026-11-08 — Claude (dev job `056a70d0`, SANDBOX; Step 1 built in the worktree, **not committed, not in production**). The client portal as an iPhone app for clients, built on the same pattern as TD Social. Only Step 1 exists in code; everything else is the approved design and plan._

## What it is
The client portal (portal.tonydurante.us) as an iPhone app. A thin native shell shows the portal's own pages inside the app (`TDSocial/`-style "app mode"), with a native bottom bar, a Menu, phone alerts and one sign-in. It ships as **version 2.0 of the existing App Store record "MyLLC Manager"** (bundle `com.tonydurante.myllcmanager`, Apple ID 6749905082), public, for **clients and the team members they added** (no partners). Paying Tony Durante invoices works inside the app, with a server switch that hides Pay if Apple objects.

## Where the project lives
- Plan page: https://claude.ai/artifact/Te2uQDRhNAZixSTUnew91j. Approved mockup page: https://claude.ai/artifact/DRrgoJeakLrwrGhiZtKPEF.
- My files › CRM Projects › **CLIENT APP**: build plan (.md + .pdf), approved mockup (PDF, 14 pages), mockup page source (.txt). My files › CRM Projects › **APPLE APPS**: the Apple apps reference (records, IDs, how each app ships).
- Sister doc: `social-app.md` (TD Social, the staff app; the pattern this reuses).

## The approved design (Antonio, 8 Nov 2026)
- **Overview** = the portal's real Overview page. **My Company is not in the app.** No in-app account deletion (staff do it from the CRM). The voice button is the record button built in another session.
- **Invoices** = the client's OWN invoicing (portal "Customers & Invoices": Setup, Customers, Sales, Vendors, Expenses), with a not-set-up card (bank account or payment link REQUIRED, first customer with an email REQUIRED, logo optional; no "Not now"). **TD Billing** is its own item (opens the portal's Expenses tab, shown only once TD has sent an invoice, carries the unpaid count).
- **Bottom bar:** Chat is the only fixed tab and the client picks four. **The Menu is a round button at the top right of every screen**; its red number counts waiting items that are not in the bar. A new client's standard set: Overview, Chat, Documents, Invoices, and a fifth = TD Billing if the client has an invoice from Tony Durante, otherwise Sign Documents. The choice is saved with the login (candidate store: `portal_user_preferences`, whose writer accepts only `tour.*` keys today).
- **Chat:** one "Topic" button next to the title (opens a short list, unread topics red and first, "Create a new topic"); no Journey Log; **Chat opens on the topic of the newest unread answer** (the website opens General first and, with several unread topics, the one with the most unread — the app uses Antonio's rule instead); the button's red number counts unread answers in the other topics.
- **Paying** = the portal's real "Pay Invoice" pop-up (card +5% fee, "Pay Now" opens the provider's page in a new tab; bank transfer with the required payment reference). **Not tried yet inside the phone app.**

## The steps (each waits for Antonio's word before production; live but switched off until the end)
0. Apple setup: reuse MyLLC Manager as 2.0. 1. **Menu rules moved to one shared place (built in the sandbox, below).** 2. Server pieces: "who am I and what can I open", save my bar, register my phone, a new fail-closed switch; clients are refused by TD Social's doors on purpose, so the client app needs its own. 3. Portal pages in app mode (menu button, Overview, Chat Topic + opening rule, Invoices areas + tappable set-up steps, TD Billing, Pay). 4. Client lock-screen alerts (a phone leg beside `sendPushToAccount` / `sendPushToContact`; wording shows who wrote and what kind, never words or amounts). 5. The iPhone app (second app from the `ios/TDSocial` generator). 6. Real-phone test (TestFlight, external testers need Apple's first-build review). 7. App Store page, review, launch.

## Step 1 — the portal menu's rules in one place (SANDBOX, 8 Nov 2026)
- **Files:** `lib/portal/nav-rules.ts` (lists, `isNavItemVisible`, `visibleMainItems` / `visibleTierTopItems` / `visiblePartnerItems`, `showCompaniesSection`, `navHubRule`); `components/portal/portal-sidebar.tsx` now only adds icons (`NAV_ICONS`, `withIcon`) and builds a `NavRuleContext` from its props.
- **Rule:** to change who sees a menu entry, or its order, edit `nav-rules.ts` only. The website's side menu and (from Step 2) the app's server answer both read it.
- **No behaviour change, proved:** `tests/unit/portal-nav-rules.test.ts` keeps a frozen copy of the old rule and lists and compares them with the module over ~450,000 login combinations (tier x role x account type x team-member capabilities x the six nav flags x company or not): identical every time; breaking the rule on purpose makes it fail. `portal-flat-menu-and-personal-cards.test.ts` and `portal-invoices-hub-banner.test.ts` now read the lists from the module (they still pin Antonio's order).
- **Left in the sidebar on purpose:** the `hubAccess(...)` block and `invoicesHubOn` (existing source-guard tests read them there); the item labels, hints, badges, pulses and the NEW tags.

## Rules and gotchas
1. App mode is a layout hint, never a security switch (see `social-app.md`). Every app-only style stays behind the app marker; `tests/unit/app-mode-css.test.ts` guards the stylesheet.
2. `/api/portal/` is open to client logins by the client API allow-list but also holds staff routes: every new route there needs its own client-or-team-member check.
3. TD Social's `lib/app/environment.ts` accepts ONE bundle id per server and its doors refuse clients. The client app needs its own accepted bundle id and its own door.
4. A TestFlight build stops working 90 days after upload. A change to the app itself needs a new build and Apple's review; web changes reach the app at once.
5. Not in production: nothing of this is on production. Production changes only on Antonio's explicit word, in the order: merge → (database file only if one turns out to be needed) → switch on, last.

## How to verify current state
- Step 1: `npx vitest run tests/unit/portal-nav-rules.test.ts` (11 tests) and open the portal in a browser: the side menu must list the same entries as before for each kind of login.
- Apple records: App Store Connect (Antonio's Chrome): MyLLC Manager, Apple ID 6749905082; see `My files › CRM Projects › APPLE APPS`.
- Dev job `056a70d0` holds the plan and the progress log.

## Not verified yet
"Pay Now" opening a new tab inside the phone app; signing by finger, uploads and camera in the phone web view; that the Apple alert key used for TD Social is set on production and works for a second app; whether the saved phones list and the saved bar need a database file; Apple's rules for replacing an app with a different one; what the old MyLLC Manager does today (its code is not in this project).
