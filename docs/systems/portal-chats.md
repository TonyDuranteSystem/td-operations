# Portal Chats (staff composer)

_Last verified against code: 2026-09-02 — Claude (removed the Issues tab)_

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

## How it's built

- **Key file:** `app/(dashboard)/portal-chats/page.tsx` — a single ~4,700-line client
  component. Everything (state, effects, handlers, JSX) lives in this one file; there
  is no sub-component split for the Chats/Team panels.
- **API routes:** `app/api/portal/chat/*` for the client composer (`route.ts` = send,
  plus `suggest`, `polish`, `read`, `upload`, `attachment`, `audience`, `threads`, …).
  `app/api/internal/threads/*` for the internal Team composer (`[id]/messages`,
  `[id]/upload`).
- **Tables:** `portal_messages` (client conversation messages) vs. `internal_threads` +
  `internal_messages` (staff Team threads) — two entirely separate tables/models behind
  a visually similar UI. Don't assume a helper that touches one also covers the other.
- **No catalog/config drives this page** — behavior is hardcoded in the component.

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
