# Capture / Share (screenshot tool)
_Last verified against code: 2026-09-04 — Claude (**Built end to end, Phase 1 (internal destinations) + Phase 2 (client-facing portal chat), council-reviewed before Phase 2, sandbox-verified live for every destination.** Antonio's ask: select part of the CRM page or the whole page, mark it up, attach a note, and send it to exactly ONE destination at a time — never a broadcast. One top-bar button ("Capture", next to the notification bell) offers "New capture" or "My captures".)_

## What it is
A screenshot tool built into the CRM dashboard: select a region or capture the whole page, draw
on it (pen/arrow/highlighter/text), attach a short note, then send the result to exactly one
place — a personal sticky note, an internal Team Chat thread, or a specific real client's portal
chat. The tool survives page navigation (mounted outside `<main>`, no full-screen backdrop past
the initial selection step) so a capture-in-progress doesn't block using the rest of the CRM
while deciding where to send it.

## Business rules
- **Exactly one destination per send, never a broadcast** (Antonio, explicit, repeated). There is
  no multi-select and no "send everywhere" option.
- **Sticky-note attachment is author-only** — the SAME rule that already governs editing a note's
  text (`mayEditBody`), not a new permission concept. One attachment per note, not a gallery.
- **The client-facing destination (portal chat) always requires an explicit confirmation step**
  showing the actual picture, even from the "send to the same place again" one-tap shortcut —
  the two internal destinations send immediately on pick/tap; portal chat never does. This
  asymmetry is intentional and enforced by a data-driven map (`REQUIRES_CONFIRMATION`), not a
  hardcoded branch, so a future 4th destination doesn't have to rediscover the rule.
- **A candidate destination for portal chat must actually be reachable by the client**: a
  Closed/Cancelled/Delinquent/Pending-Formation company is never offered (the client's own
  account list already hides those — sending there would succeed with no error while being
  permanently invisible), and a contact who was never actually sent a portal invite
  (`portal_email_sent_at IS NULL`) is never offered either.
- **Every portal-chat send pings staff instantly** (`sendPushToStaff`) — a deliberate safety net
  from the Phase 2 council review: even a caught mistake can't recall the push/email the send
  route already fired, so the goal is catching a wrong-target send in minutes, not months (see
  the 2026-08-07 cross-company leak this mirrors, `lib/portal/admin-send-scope.ts`).

## How it's built
- **Table `staff_captures`** (migration `20260904-1500-staff-captures.sql`): one row per capture,
  regardless of destination. `image_url` + light metadata (name/mime/size), `title`, `note`,
  `destination` (jsonb, NULL until the share step completes — polymorphic: `{type, id, ...}`).
  RLS enabled, NO policy (same posture as `staff_notes`) — access via `capturesTable()`
  (`lib/captures/db.ts`, an any-cast: the table postdates the last `gen:types` run, and a direct
  typed `.from('staff_captures')` fails the build). `destination.type` CHECK started as
  `('sticky_note','team_chat')` and was widened to add `'portal_chat'` in
  `20260904-1900-staff-captures-portal-chat-destination.sql` (Phase 2).
- **Image bytes live in the PRIVATE `worker-attachments` bucket** (`captures/<uuid>.<ext>`,
  `lib/captures/storage.ts`'s `isValidCapturePath()` rejects anything else) — deliberately, not
  the public `assets` bucket: a capture routinely shows client SSNs/bank/tax data on screen, so
  it gets the same no-public-URL treatment as a pasted passport. Path validation prevents one
  feature's routes from being used to read a DIFFERENT feature's private file in the same bucket.
- **Capture pipeline:** `lib/captures/render.ts` (`captureWholePage`/`captureRegion`, html2canvas
  — `ignoreElements` + a `data-capture-tool-ui` marker keep the tool's OWN panel out of a
  "whole page" capture) → `components/captures/markup-editor.tsx` (two-canvas destructive
  drawing: a permanent base canvas + a transient preview canvas, undo via `toDataURL()`
  snapshots) → `lib/captures/upload.ts` (signed-URL mint → PUT → finalize, mirrors
  `lib/team/attachment.ts`'s pattern) → `components/captures/capture-layer.tsx` (the stage
  machine: mode → selecting → capturing → markup → uploading → destination → done/error).
- **Three destination pickers**, one per type, sharing the same "finish sharing" functions
  (`lib/captures/share-actions.ts` — `attachCaptureToNote`, `sendCaptureToTeamChat`,
  `sendCaptureToPortalChat`) so a one-tap "recent" shortcut and the full picker can never drift
  into two slightly-different requests:
  - `components/captures/note-destination-picker.tsx` → `PATCH /api/crm/staff-notes`
    (`action=attach_capture`), lists only the caller's OWN notes (`?scope=mine`,
    `listMyNotesForUser`).
  - `components/captures/team-chat-destination-picker.tsx` → `POST
    /api/captures/[id]/share-team-chat` → delivers via the real human send route
    (`POST /api/team/threads/[id]/messages`, forwarding the session cookie) so identity/push/
    mentions are all real — deliberately NOT `postTeamMessage()`, which always stamps the sender
    as the Claude sentinel identity.
  - `components/captures/portal-chat-destination-picker.tsx` (Phase 2) → search
    (`GET /api/captures/portal-destinations`, `lib/captures/portal-destinations.ts`) → mandatory
    confirmation screen (shows the actual picture + an honest "who's notified vs who could see it
    if they check" line) → `POST /api/captures/[id]/share-portal-chat`.
- **The portal-chat send route** (`app/api/captures/[id]/share-portal-chat/route.ts`) validates
  the contact/company/link/status LOCALLY, before touching Storage at all (mirrors the
  team-chat route's own validate-then-copy order — a bug-hunter finding on the Phase 2 plan:
  copying bytes to public storage BEFORE the real validation runs would leave a picture sitting
  at a live public path even on a request that then gets correctly rejected). It then copies the
  capture's bytes into the public `assets` bucket, but under the SAME `chat-attachments/<accountId
  |contactId>/<uuid>.<ext>` path convention (and the SAME access-controlled proxy,
  `app/api/portal/chat/attachment/route.ts`) the `portal_chat_attach_file` MCP tool already uses
  — so `portal_messages.attachment_url` gets a URL that re-checks access on every view, not a
  permanent `getPublicUrl()` link (see `docs/systems/portal.md`'s 2026-09-04d entry for the one
  small, deliberate widening this needed in the reused send route's own URL validation). Delivery
  itself goes through the real `POST /api/portal/chat` (internal same-origin fetch, forwarding the
  session cookie, using `request.nextUrl.origin` — NEVER `APP_BASE_URL`/`PORTAL_BASE_URL` for this
  internal call, both default to production) so `decideAdminSendScope`/`isContactLinkedToAccount`
  (`lib/portal/admin-send-scope.ts`), client notifications, and the audit log all apply exactly as
  they do for a normal staff reply — explicitly passing `sender_context: 'company'` alongside
  `account_id`+`contact_id` for a company-scoped send (without it, the very invariant this route
  relies on rejects the send outright).
- **`lib/captures/recent-destinations.ts`** — localStorage, capped at 3, most-recent-first,
  deduped by identity (`type`+`id` for the two internal shapes; `contactId`+`accountId` for
  portal_chat, kept as explicit fields rather than one opaque id so a re-used "recent" can't lose
  which specific company member it was addressed to). `REQUIRES_CONFIRMATION` is the map every
  quick-send caller must consult — see Business rules above.
- **Recipient search for portal chat** (`lib/captures/portal-destinations.ts`) returns, per
  matched contact, one "personal" candidate plus one "company" candidate per company they're
  linked to via `account_contacts` — sourced from ALL contacts (not just ones with an existing
  conversation; `GET /api/portal/chat/threads` was considered and rejected as the source for
  exactly that reason). Every candidate carries the contact's email as a distinguishing detail —
  two real clients can share a name.

## Gotchas, invariants & past bugs
- **The tool's own panel is deliberately NOT a full-screen backdrop** past the initial selection
  step. A full backdrop sits above the sidebar and silently swallows a click meant to navigate —
  found live, 2026-09-04: a tap meant to go to a different page just closed the tool instead,
  defeating Antonio's explicit "must stay open if I move to a different page" requirement even
  though the component never technically unmounted. The panel is bottom-docked, closable only via
  its own X button.
- **A blob-URL image preview must be created AND revoked inside the SAME effect**, never a
  `useMemo`'d URL paired with a separate cleanup effect. Under React 18 Strict Mode's dev-only
  double-invoke, the memoized URL survives the simulated unmount/remount but the blob it points to
  gets revoked by a same-deps cleanup effect that already ran — `img.complete=true`,
  `naturalWidth=0`, a syntactically valid but dead link. Hit live building the Phase 2
  confirmation screen's picture preview; only caught by actually loading the page, not by the
  build or the test suite.
- **`notifyClientOfAdminMessage` (`lib/portal/notifications.ts`) proactively emails exactly ONE
  person for a company-scoped send**, not everyone `accountAudience()` counts as linked — it takes
  its single-recipient branch whenever ANY `contact_id` is present, which a company-scoped admin
  send always carries in practice (either explicit, or resolved via `resolveAdminReplyContact`,
  which returns null only when the account has zero linked contacts at all). The portal-chat
  confirmation screen's copy is written to match this reality ("they'll be notified directly; N
  others could see it if they check") rather than implying everyone linked gets pinged.
- **The `assets` bucket portal-chat attachments live in is a known, separately-tracked public
  exposure** (dev_tasks `023c7d06`, `3e0578d9`) — not introduced by this feature (the internal
  team-chat destination already writes there, and so does every client-uploaded chat attachment),
  but this feature is a second, riskier kind of writer into it: a raw screen capture can easily
  contain more than the intended subject (another client's name in a sidebar, a background tab),
  unlike deliberately-authored content. The proxy-URL delivery above (rather than a permanent
  public link) is the mitigation actually taken; it does not close the underlying bucket-level
  gap, which is separate, pre-existing, overdue work.
- **Whole-page capture silently fails on the Dashboard specifically** — found live during Phase 2
  QA, works cleanly on every other page tried (Notes, etc.). Not investigated further; filed as
  its own follow-up rather than mixed into this change (see dev-tracker, "Fix whole-page
  screenshot capture failing on the Dashboard").

## How to verify current state
- Destination-candidate filtering (closed accounts, never-onboarded contacts, dedup):
  `npx vitest run tests/unit/capture-portal-destinations.test.ts`.
- Recent-destinations shape + confirmation-required map:
  `npx vitest run tests/unit/capture-recent-destinations.test.ts`.
- Capture/markup/upload pure logic: `npx vitest run tests/unit/capture-{markup,selection,storage,title,upload}.test.ts`.
- Live gate: an unauthenticated `GET /api/captures/portal-destinations?q=x` must return 403 and
  return no candidates.
- Live end-to-end (sandbox): capture something, search a QA fixture contact with a real portal
  invite (`portal_email_sent_at` set) linked to an Active company, confirm the picture renders on
  the confirmation screen, send, then check `portal_messages` for the new row (`sender_context`,
  `account_id`, `contact_id`) and the `assets` bucket for the copied object under
  `chat-attachments/<accountId>/`. Clean up the test row + object afterward.
