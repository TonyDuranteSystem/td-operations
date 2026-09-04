# Portal Chats (staff composer)

_Last verified against code: 2026-09-04 — Claude (**"Addressed to" member label for multi-member account threads** — dev job 08a8be62, Antonio's request, taken through a full council pass (7 reviewers) then a dedicated 3-reviewer re-check against the final narrowed plan before any code was written. Antonio's original ask (a pop-up before every send covering personal-vs-company, which member, which company, which topic) turned out to already be THREE-QUARTERS built and live: the personal/company chip row, the which-company chip row, and the topic tabs/banner all already existed as sticky, always-visible controls — none were rebuilt. The one genuine gap was addressing one specific member of a multi-member company, which the composer had NO way to do at all (the entire chip row is structurally hidden — `!selectedAccountId` — whenever a multi-member account thread is open). Antonio's two decisions, in order: (1) label only — the message stays visible to the whole company thread, matching the system's own existing documented design (KB `439e1d3f`: "Chat is ONE thread per account — all members share the same conversation") rather than a genuinely private 1:1 (which would have been a considered departure from that design, and doesn't work out of the box for the ~31% of real members with no portal access — system-counselor, live production data); (2) staff-only for now — the matching client-visible badge (so a co-member can actually SEE who a message is addressed to, not just staff internally) is a deliberate, tracked fast-follow, NOT built in this pass. **Read that as a real limitation, not a footnote:** today this feature only helps staff internally; it does not yet solve the original "co-member misreads who a message is for" scenario, because nothing renders the label on the client's own side of the chat (`components/portal/portal-chat.tsx` — every admin message still renders as "TD Team" to every client, unchanged). New column `portal_messages.addressed_to_contact_id` (migration `20260904-1900-portal-messages-addressed-to.sql`) is DELIBERATELY isolated from `sender_context`/`decideAdminSendScope` — two independent reviewers (senior-engineer, bug-hunter) found that routing it through the existing company-link check would wrongly reject real members (company-type members never get an `account_contacts` row; some individual members' `account_contacts` upsert can silently fail — a separate, unrelated, NOT-fixed-here bug in `lib/operations/formation-materialize.ts`). The picker is sourced from the real `members` table (`lib/portal/addressed-to.ts::resolveAccountMembersForChat`, new endpoint `GET /api/portal/chat/members`), never from `account_contacts`/`selectedThreadMembers` — those undercount real rosters (Master Rules MM1: `members` is canonical, `account_contacts` is contact-linking only). A member with no resolvable contact (no `contact_id`, no email, or an ambiguous email match) renders disabled with a tooltip — never silently tappable-but-inert. Pre-filled from a guess (`pickAddressedToGuess`, same reply-to-author → last-client-sender → primary → first cascade as the existing `resolveAdminReplyContact`, but against the FULL members-resolved list instead of only `account_contacts`-linked contacts). Placed as a second, separate sentence inside the EXISTING amber audience-warning band, not a new strip (Erika Hall: the member-count sentence and this picker's options come from two different tables that are documented elsewhere as routinely disagreeing — never merge them into one sentence). That band's own trigger was widened (`audienceTotal > 1 || selectedThreadMembers.length > 1`) so the picker stays reachable for a real multi-member account whose `account_contacts` mirror is thin — the same undercount gap, applied to the band's own visibility. No pop-up was built: every reviewer, independently, came back against a hard confirmation on every send (it would reverse the deliberately-sticky design that already fixed the 2026-08-07 leak, and risks training staff to stop reading it — a safety regression, not an improvement). Also fixed in the same pass, both pre-existing and directly relevant to this feature's safety: `sendMutation` had no `onError` at all — a rejected send failed completely silently, no toast, nothing; and the "New Chat" search-result click and the New-Chat-dialog result click did not reset the previous conversation's company/member selection before switching accounts, the same stale-state shape as the 2026-08-07 incident. Unit-tested (`tests/unit/portal-addressed-to.test.ts`, 14 tests) — full suite 10,386 tests green, no regressions. STILL OPEN, tracked, not silently dropped: the client-visible badge (fast-follow); the `formation-materialize.ts` swallowed-upsert-error bug (separate, unrelated, flagged not fixed); a `HelpDot` popover key (`chat.addressedTo`) is wired into the UI but has no catalog content yet — the dot stays invisible until someone adds it via the help-content catalog admin tool.)_
_Prior: 2026-09-02b — Claude (**message deep links (`?message=<id>`) now reliably land on the target** — four compounding bugs fixed, found by live reproduction, not by reading the code alone: (1) a separate "jump to newest message on thread open" effect could fire after the deep-link's own scroll and silently overwrite it on ANY later `messages` update, not just a genuinely new message — a background refetch lands within the same second on a fresh load. Fixed by making a pending deep link own the scroll position for the WHOLE page view, not just "until resolved" — also the right product call: someone who followed a link to one historical message is reading history, not asking to be snapped to "latest". (2) the effect marked itself resolved the instant its fixed-delay timer fired, before confirming the element existed, so a transient miss gave up forever with no retry. (3) the element genuinely isn't in the DOM at a single fixed delay on a fresh load (fetch + hydration + the topic-switch re-render compete for that window) — swapped for a bounded poll. (4) even once found, a raw `scrollIntoView` could land on a transient/duplicate DOM node mid-reconciliation right after the topic switch, discarded a moment later with nothing visibly scrolled — the poll now verifies the target is actually on screen one frame later before declaring success. Reported by Antonio, dev job acb315af, after the sibling staff-notes fix made the link itself clickable and surfaced this deeper bug.)_
_Prior: 2026-09-02 — Claude (removed the Issues tab)_

_2026-09-02 — the per-thread "Issues" tab (and the ⚠️ warning badges next to each
conversation in the list) were REMOVED — Antonio's call, not a bug fix. Both read
from the diagnose-account engine (also behind the account/contact page "Diagnose" /
"Health" panels), which had near-zero real usage, confirmed correctness bugs, and
one-click fixes that wrote money/portal-tier fields bypassing the canonical writers.
The whole engine — diagnose-account, diagnose-contact, the two diagnostic dialogs,
this Issues tab, the list badges, the `client_issue_counts` cache table, and its
daily refresh cron — was deleted in the same change. The panel tab list here is now
Messages / What's New / To Do / Email / Worker._

## What it is

The staff-facing inbox at `/portal-chats` where Antonio/Luca message clients through
the client portal, one page with three sub-panels sharing the same sidebar:

- **Chats** — the actual client conversation (per account or per contact), with AI
  "Suggest a reply" / "Polish" assist, file attachments, quoted replies, and topic tabs.
- **Actions** — a queue view over the same underlying data (not covered in depth here).
- **Team** — an internal staff-to-staff thread system, cosmetically similar to Chats
  but a fully separate data model (see below).

This is distinct from `docs/systems/portal.md` (the client-facing portal itself) and
from `docs/systems/client-threads.md` (the older, now-archived Slack-based thread
system). It is also distinct from `docs/systems/portal-chat-unread.md`, which covers
only the read/unread badge logic, not the composer.

## Business rules

- Sending a message to a client fires an email notification to them, throttled to one
  per conversation per 2 hours (R103, `lib/portal/notifications.ts`).
- A person-scoped thread (no account chip picked) defaults to **personal** visibility —
  never auto-selects a company, because that previously leaked a personal reply into a
  company-visible thread (2026-08-07, dev job 4bad3094). Sending "as" a company requires
  an explicit chip click every time.
- Staff cannot send to a closed/cancelled/delinquent account — the client can't see it
  there anyway (closed-account send guard, same file).
- No canonical KB article exists yet for this page's day-to-day usage rules; ask Antonio
  before assuming one.
- **"Addressed to" member label (2026-09-04, dev job 08a8be62) is a LABEL, not a privacy
  boundary.** In a multi-member account thread, staff can tag which member a message is
  addressed to (`portal_messages.addressed_to_contact_id`) — the message still goes to
  the whole shared account thread; picking a member never restricts who can read it.
  Genuinely private 1:1 messaging to one member is a separate, NOT-built feature (the
  existing contact-scoped "person" thread does this today, just not reachable from
  inside the account view) — parked, not decided against, if it's ever wanted.
  Staff-side only so far: nothing shows this label to the client yet (fast-follow).

## How it's built

- **Key file:** `app/(dashboard)/portal-chats/page.tsx` — a single ~4,700-line client
  component. Everything (state, effects, handlers, JSX) lives in this one file; there
  is no sub-component split for the Chats/Team panels.
- **API routes:** `app/api/portal/chat/*` for the client composer (`route.ts` = send,
  plus `suggest`, `polish`, `read`, `upload`, `attachment`, `audience`, `threads`,
  `members` — the last one new, 2026-09-04, GET-only, real member roster + a pre-fill
  guess for the "Addressed to" picker, see `lib/portal/addressed-to.ts`).
  `app/api/internal/threads/*` for the internal Team composer (`[id]/messages`,
  `[id]/upload`).
- **Tables:** `portal_messages` (client conversation messages) vs. `internal_threads` +
  `internal_messages` (staff Team threads) — two entirely separate tables/models behind
  a visually similar UI. Don't assume a helper that touches one also covers the other.
- **No catalog/config drives this page** — behavior is hardcoded in the component.
- **`lib/portal/addressed-to.ts`** (2026-09-04) — resolves a multi-member account's real
  roster from the `members` table (never `account_contacts` — that undercounts real
  members, Master Rules MM1) into addressable contacts, reusing the same email-lookup
  fallback `lib/members/resolve-signer.ts` already proved for the SS-4/signer case.
  `pickAddressedToGuess` is the pure decision function (same shape as
  `decideAdminSendScope`) — unit-tested in `tests/unit/portal-addressed-to.test.ts`.
  Deliberately does NOT touch `lib/portal/admin-send-scope.ts` — see Gotchas below.

## Gotchas, invariants & past bugs

- **Per-conversation draft memory (added 2026-08-29, dev job c3bb4abc; extended
  2026-08-30).** The reply text, quoted-reply pointer, and staged attachments used to
  be one shared piece of page-wide state — switching the selected client left a draft
  addressed to the wrong one. Fixed with an in-memory `Map` per conversation id
  (`clientDraftsRef` / `internalDraftsRef`), saved on switch-away / restored on
  switch-back via a `useEffect` keyed on the conversation id, using its **cleanup**
  function (not a ref) to capture the outgoing key — that part relies on normal JS
  closure-per-effect-instance semantics and is correct.
  **`clientDraftsRef` (client-conversation drafts only, NOT the internal Team
  composer) is no longer in-memory-only as of 2026-08-30** — Antonio reported the
  text disappearing whenever he left the Portal Chats page entirely and came back
  (a full component unmount, same as closing the tab), which the in-memory-only
  design couldn't survive. Reply text + the quoted-reply pointer (never staged
  attachments — a `File` object can't round-trip through `localStorage`) now also
  persist to `localStorage`, **one key per conversation**
  (`td_portal_chat_draft_v1_<accountOrContactId>`, 7-day expiry), not one shared
  blob — an earlier version used a single aggregate key and a council review (AI
  Architect + Bug Hunter) caught that it let two browser tabs on *different* clients
  silently overwrite each other's saved draft; per-key storage makes that
  structurally impossible. A `beforeunload` listener persists the currently-open
  conversation's draft as a safety net for a real tab close/hard refresh (React
  effect cleanups aren't guaranteed to run in time for that), on top of the
  switch-away save. `internalDraftsRef` (Team composer) is unchanged — still
  in-memory-only for the open tab.

- **The stale-closure trap — read this before touching any async handler in this file.**
  Any `.then()`/`.catch()`/`async` continuation that reads `selectedAccountId`,
  `selectedContactId`, or `selectedThreadId` directly is reading a value **frozen at
  the moment that specific function was invoked** — comparing it against another value
  captured in the same invocation (e.g. "has the user switched since I started?")
  **always evaluates true**, because both sides come from the same frozen snapshot.
  This silently defeats any "is this still the right conversation" guard. Real
  instance: the first-pass fix for the AI-suggest/AI-polish/internal-failed-send race
  guards used exactly this broken pattern and shipped locally passing manual smoke
  tests — it was only caught by simulating a real network race with logged
  request-start/resolve timestamps. **Fix:** compare against `liveSelectionRef.current`
  (a ref mirrored every render via a no-deps `useEffect`), never against a closure-read
  of the state variable, inside any code that runs after an `await`/`.then()`.

- **Two effects on the same dependency array can silently cancel each other.** A
  pre-existing "mark thread read on open" effect used to also null the quoted-reply
  pointer on every switch (`setReplyToMsg(null)`), running *after* the new
  draft-restore effect in the same commit (later declaration order = later execution)
  — so the restore always got immediately overwritten back to empty. The quote pill
  could never survive a switch, 100% reproducible, not a race. Removed the duplicate
  reset from the older effect; the draft-restore effect is now the single owner of
  that field.

- **`sendMutation`'s `onSuccess` reads live state correctly, unlike a plain closure** —
  TanStack Query calls the *latest* render's `onSuccess`/`mutationFn`, not the one
  captured when `.mutate()` was called, so reading `selectedAccountId`/`selectedContactId`
  directly inside `onSuccess` is safe. The mutation *variables* (not the closure) are
  still what should carry the send's actual target account/contact id through to
  completion — passed explicitly, not re-derived.

- **CRITICAL, found in council review 2026-08-30 (Bug Hunter): `mutationFn` used to
  ignore its own captured target variables and silently re-derive the request from
  LIVE state — a real cross-client leak.** `handleSend` correctly captures
  `targetAccountId`/`targetContactId`/`targetCompanyId`/`targetTopic` before any
  `await` (an attachment upload is a real multi-second network call, and nothing
  disables the sidebar or topic tabs while it's in flight — verified, no such guard
  exists). Those captured values were passed into `sendMutation.mutate({...})` and
  are typed as required fields on `mutationFn`'s parameter — but the body of
  `mutationFn` never destructured or used them, instead rebuilding the POST body from
  live `selectedAccountId`/`selectedContactId`/`selectedCompanyId`/`adminActiveTopic`.
  Repro that was actually possible before the fix: attach a file to a reply for
  Client A, hit send, then tap a different client (or a different topic tab, or
  toggle the company chip) while the upload is still running — the message (with A's
  attachment) would post under whatever was on screen when the upload resolved, not
  what was on screen when send was clicked. No server-side guard could catch this
  (a transmitted account/contact pair is internally valid either way). **Fixed:**
  `mutationFn` now destructures and uses the captured
  `targetAccountId`/`targetContactId`/`targetCompanyId`/`targetTopic` throughout —
  never reads the live `selected*`/`adminActiveTopic` state itself. The client
  portal's own composer (`components/portal/portal-chat.tsx`) had the identical
  pattern for `activeTopic` specifically (not account/contact — a client only ever
  has one thread scope) — same fix applied there.
  **Any future edit to the send path in either file must keep every value the
  request body needs flowing through as an explicit captured argument — never add a
  live state read back into `mutationFn`/`doSend` for anything used after an
  `await`.**

- **A sent reply must clear its OWN draft even when still viewing that conversation**
  (found in council review 2026-08-30, Senior Engineer). The send-success handler used
  to only clear the live text box when still on the same conversation, leaving the
  underlying draft map/storage entry untouched — reopening that conversation later
  *without switching away first* could restore the already-sent text as an apparent
  unsent draft, risking an accidental duplicate resend. Fixed: send-success now always
  clears both the in-memory map entry and the persisted `localStorage` entry for the
  conversation that was actually sent to, regardless of whether it's still on screen.

- **Deliberately NOT fixed in the 2026-08-29 pass** (flagged, not silently dropped):
  `clientDraftsRef`/`internalDraftsRef` have no in-tab-session eviction — a
  conversation touched once this tab-session stays in the Map for the life of the
  tab, and a staged image attachment is stored as a full base64 string. Low risk
  (session-scoped, no client data exposure), worth capping if a long-session memory
  complaint ever surfaces. (The 2026-08-30 `localStorage` layer is a *separate*
  concern with its own 7-day expiry, already handled — see above.) Separately,
  `sendMutation` has no `onError`/`isError` handling at all — a failed client-facing
  send is currently silent to staff, which is a pre-existing, unrelated gap (violates
  the house R099 pattern) that predates this fix and needs its own pass.

## How to verify current state

```bash
# Confirm the draft-memory effects still exist and are the sole owner of replyToMsg:
grep -n "clientDraftsRef\|internalDraftsRef\|liveSelectionRef" "app/(dashboard)/portal-chats/page.tsx"
grep -n "setReplyToMsg(null)" "app/(dashboard)/portal-chats/page.tsx"   # should be exactly 2 hits: the send-success clear and the explicit "X" dismiss button — NOT inside the "mark as read" effect (that effect must not touch replyToMsg at all)

# Confirm no async handler reads selected*Id directly after an await/.then():
grep -n "\.then(data =>" "app/(dashboard)/portal-chats/page.tsx"

# Confirm mutationFn uses the captured targets, not live state (must show
# targetAccountId/targetContactId/targetCompanyId/targetTopic being destructured
# and used in the fetch body — NOT selectedAccountId/selectedCompanyId/
# adminActiveTopic read directly inside mutationFn):
grep -n "mutationFn: async" "app/(dashboard)/portal-chats/page.tsx"

# Confirm draft storage is per-conversation-key, not one shared blob:
grep -n "portalChatDraftStorageKey\|PORTAL_CHAT_DRAFT_KEY_PREFIX" "app/(dashboard)/portal-chats/page.tsx"
```

Functional checks (no code needed):
- Open two different client conversations in this panel, type a draft in the first,
  switch to the second (box must be empty), switch back (draft must reappear).
  Repeat for the Team tab.
- Type a draft, leave `/portal-chats` for another CRM page (or reload the browser
  entirely), come back, reopen the same conversation — the draft must still be there.
- Send a reply while staying on that same conversation, then reload without switching
  away — the box must be empty, not showing the just-sent text.
- Type two different conversations' drafts, confirm both survive independently (e.g.
  via devtools: `Object.keys(localStorage).filter(k =>
  k.startsWith('td_portal_chat_draft_v1_'))` should show one key per conversation
  touched, each with its own text).
