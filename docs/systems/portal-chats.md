# Portal Chats (staff composer)

_Last verified against code: 2026-08-29 — Claude (dev job c3bb4abc)_

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

- **Per-conversation draft memory (added 2026-08-29, dev job c3bb4abc).** The reply
  text, quoted-reply pointer, and staged attachments used to be one shared piece of
  page-wide state — switching the selected client left a draft addressed to the wrong
  one. Fixed with an in-memory `Map` per conversation id (`clientDraftsRef` /
  `internalDraftsRef`), saved on switch-away / restored on switch-back via a
  `useEffect` keyed on the conversation id, using its **cleanup** function (not a ref)
  to capture the outgoing key — that part relies on normal JS closure-per-effect-
  instance semantics and is correct. Drafts are in-memory only for the open tab; never
  persisted server-side or to browser storage.

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

- **Deliberately NOT fixed in the 2026-08-29 pass** (flagged, not silently dropped):
  `clientDraftsRef`/`internalDraftsRef` have no eviction — they grow for the life of
  the tab, and a staged image attachment is stored as a full base64 string. Low risk
  (session-scoped, no client data exposure), worth capping if a long-session memory
  complaint ever surfaces. Separately, `sendMutation` has no `onError`/`isError`
  handling at all — a failed client-facing send is currently silent to staff, which is
  a pre-existing, unrelated gap (violates the house R099 pattern) that predates this
  fix and needs its own pass.

## How to verify current state

```bash
# Confirm the draft-memory effects still exist and are the sole owner of replyToMsg:
grep -n "clientDraftsRef\|internalDraftsRef\|liveSelectionRef" "app/(dashboard)/portal-chats/page.tsx"
grep -n "setReplyToMsg(null)" "app/(dashboard)/portal-chats/page.tsx"   # should be exactly 2 hits: the send-success clear and the explicit "X" dismiss button — NOT inside the "mark as read" effect (that effect must not touch replyToMsg at all)

# Confirm no async handler reads selected*Id directly after an await/.then():
grep -n "\.then(data =>" "app/(dashboard)/portal-chats/page.tsx"
```

Functional check (no code needed): open two different client conversations in this
panel, type a draft in the first, switch to the second (box must be empty), switch
back (draft must reappear). Repeat for the Team tab.
