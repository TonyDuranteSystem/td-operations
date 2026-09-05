# Capture / Share (screenshot tool)
_Last verified against code: 2026-09-05 — Claude (**Second bug-hunt pass, specifically re-verifying the first pass's own fixes** — end-to-end QA combining live simulation on a real deployed copy with a fresh adversarial review of the fix commit itself. Confirmed by ACTUALLY DOING IT (not just reading code) that the touch-cancel fix, the non-image rejection, the mutual-exclusion guard, and all four error-vs-empty screens genuinely work. Also found, live, that firing two sends of the same picture a fraction of a second apart both went through — the first pass's idempotency check only closed the sequential case. The re-review separately found a second, more serious gap in the SAME area: closing the tool while a picture is still uploading never invalidated that upload, so it could resolve later and silently jump a freshly-reopened session straight to "choose a destination" for a picture with no preview to show. Both fixed this round, along with three smaller ones. See Gotchas below.)_
_Prior: 2026-09-04e — Claude (**Full bug-hunt pass on the whole feature** — two independent adversarial reviews (server/security + client/React), 11 real findings, all fixed same-day: a mutual-exclusion guard + an upload generation-token + a `key` on the markup editor close off a real "wrong picture gets sent" race between an in-progress capture and a dropped file; both share routes gained an idempotency guard (no more double-send on a slow click) and the client-facing one also re-checks the account's status right before sending and forwards the caller's IP so its rate limit isn't shared across every staff member; the capture endpoint now validates the declared file name/type instead of trusting it blindly; the phone/tablet Cancel button during area-selection actually cancels now instead of registering a stray tap; a non-image drop no longer hangs silently or lets a blank picture through; four "no results" screens now tell the difference between "nothing here" and "the request failed"; the My Captures popup's saved position gets re-clamped against the real screen size instead of only once, before it ever had anything to measure. See Gotchas below for the exact mechanism of each.)_

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

### Second pass (2026-09-05)
- **Closing the tool must invalidate whatever upload was in flight — not just hide it.** The
  generation-token guard from the first bug-hunt pass (below) only got bumped when a NEW file
  started its journey; it was never bumped by simply closing/resetting the tool. Found in the
  second pass: close the tool while "Saving..." is showing (a normal thing to do on a bad
  connection), reopen it fresh, and leave it sitting on the picker — the abandoned upload could
  resolve later, find its token still current, and silently jump the FRESH session straight to
  "choose a destination" for the picture that was supposedly discarded, with no picture left to
  preview (it had already been cleared) yet Send still worked. Fixed by bumping the token inside
  `reset()` itself, so closing OR reopening always invalidates anything still in flight.
- **A file's own name+size+lastModified is not a safe React `key` for "is this actually a new
  picture" — two loads of the literal same file collide.** The `MarkupEditor` `key` from the first
  pass used exactly those three fields; dropping or pasting the SAME unmodified file twice in a
  row produces an identical key, so React reused the same editor instance and its Undo history
  carried over from the first attempt. Fixed by keying on the same monotonic load-counter the
  upload-generation guard already uses — a counter can't collide no matter how identical two files
  are.
- **An idempotency check-then-write is NOT the same as an atomic claim — confirmed by actually
  reproducing it.** The first pass's fix (check `destination` is null, act, then write it
  conditionally) closes the common, sequential case, but live-firing two sends of the same capture
  roughly 30ms apart proved both requests still passed the upfront check before either had written
  anything — both downloaded, both uploaded, both sent, and two separate messages landed in the
  real chat. All three destinations now CLAIM the capture with a single conditional `UPDATE ...
  WHERE destination IS NULL` BEFORE doing any of the real work (download/upload/send), checking
  whether that update actually affected a row — Postgres itself makes that one step atomic, so at
  most one concurrent request can ever win it. A failed send after a successful claim rolls the
  claim back to `NULL` so the capture stays retriable rather than getting permanently stuck
  "already shared." This is the correct fix; the earlier "check first, write conditionally at the
  end" shape only ever protected the label from being clobbered, not the send itself from
  happening twice — a real gap between what the code's own comment claimed and what it actually
  did, worth remembering as a pattern: a plain check before an action is never enough against a
  genuine race, only a single atomic conditional write is.
- **The re-check right before sending only covered the company branch — a personal send had no
  equivalent freshness check at all.** Fixed by adding the same last-second re-check of the
  contact's own portal-access fields, mirroring the account-status re-check.

### First pass (2026-09-04)
- **`isOpen` (the capture flow) and `isBrowseOpen` (the My Captures popup) are mutually
  exclusive, enforced in `CaptureProvider` itself** — `open()`/`openBrowse()` each force the OTHER
  closed, not just flip their own flag. Found via a full bug-hunt pass, 2026-09-04: the capture
  button's menu had no idea the other tool was open, so a staff member could have an
  unsaved, marked-up screenshot open, separately open My Captures from the same
  always-reachable top-bar menu, and drop a picture onto it — silently wiping the in-progress one,
  and (if its upload was still in flight) letting the confirm screen show the NEW picture while the
  OLD one's id is what actually gets sent (`portal-chat-destination-picker.tsx` shows a local
  `imageFile` prop but sends a separate `captureId` prop — nothing previously guaranteed those
  agreed). `capture-button.tsx` also disables "My captures" in the menu while a capture is open
  (with a tooltip), so the provider's force-close is never reachable with real unsaved work on the
  line. Belt-and-suspenders on top: `capture-layer.tsx` stamps every new file with a generation
  token (`uploadTokenRef`) that `handleMarkupDone` checks after its `await`, dropping a stale
  upload's result instead of applying it; `MarkupEditor` also gets a `key` tied to file identity so
  React can't reuse a stale canvas/undo-stack across two different pictures.
- **A hook's `dragging`-style getter-over-a-ref must be read as a live property access, never
  destructured into a local** — covered in the 2026-09-04d entry below; the bug-hunt pass
  specifically re-audited every ref in this feature for the same pattern and found no other
  instance.
- **`useDraggableFab`'s one-time position-restore effect needs the real element to measure** — a
  caller that's sometimes absent from the DOM (My Captures returns `null` while closed, unlike its
  two always-on-screen sibling callers) can have that effect's very first run land while
  `ref.current` is still `null`, which disables the clamp for that read (the "no measured box"
  fallback is deliberately the loosest possible bound). Since the effect's deps never change again
  afterward, a position restored that way is never re-clamped for the rest of the session — found
  live, 2026-09-04: a position saved on a wide desktop reopened mostly off-screen at a narrow
  phone-PWA width. Fixed with an optional `remeasureOn` hook parameter (My Captures passes
  `isBrowseOpen`) that re-runs the same restore-and-clamp logic once the popup is actually open and
  measurable; the two original callers don't pass it and are unaffected.
- **Both share routes now check `destination` before doing any work, and write it back
  conditionally (`.is('destination', null)`)** — there was no idempotency guard at all before
  2026-09-04's bug-hunt pass, so a slow request plus an impatient second click re-downloaded,
  re-uploaded, and re-sent the same screenshot, leaving two independent permanent copies in the
  public bucket. The client-facing route also re-checks the account's status immediately before
  the actual send (narrowing, not eliminating, the TOCTOU window against the one check that used to
  run only at the top of the request) and forwards the caller's own `x-forwarded-for`/`x-real-ip`
  to the internal `/api/portal/chat` call so that route's rate limit is scoped per staff member
  instead of shared across everyone using this feature.
- **`/api/captures` (the finalize step) now validates the caller-declared `image_name`/`mime_type`
  the same way `/api/captures/upload-url` already does**, instead of only type-checking them.
  Before 2026-09-04, a caller hitting this endpoint directly (not through the real screen, which
  always sends matching values) could set an arbitrary name/type that a share route later trusted
  verbatim as the Content-Type of a file copied into the public bucket.
- **The phone/tablet Cancel button during area-selection needs its own `onTouchStart` stopping
  propagation**, the same fix already applied to the My Captures popup's close button (see the
  2026-09-04d entry) — without it, a touch that starts on the button also reaches the parent
  overlay's own `onTouchStart`, which calls `preventDefault()` and registers a selection point at
  the button's location instead, suppressing the button's own synthetic click entirely.
- **A dropped/pasted file must be checked for an actual image MIME type before it reaches
  `MarkupEditor`** — the shared `validateChatAttachment` this pipeline reuses deliberately ALLOWS
  PDFs, Office docs, and other normal chat attachments too (it's built for chat). A non-image file
  used to sit forever on a silent "Loading..." screen (the `<img>` can never decode it, so its
  `onload` never fires) while Continue stayed clickable and exported the untouched, blank canvas as
  a real, sendable picture. `MarkupEditor` also gained an `img.onerror` backstop + a `ready`/
  `loadError` gate on Continue, for a file that claims to be an image but isn't a valid one.
- **A failed background load must never look identical to "there's genuinely nothing here."**
  Found across all four "search/browse a list" screens (My Captures' own grid, and all three
  destination pickers) during the 2026-09-04 bug-hunt pass — none checked `res.ok` before treating
  the response as data, an R099 violation. The two one-time-load pickers (team chat, notes) now
  escalate a load failure through the same `onError` they already use for send failures; My
  Captures' own grid gets a local error state with a retry button; the portal-chat search (which
  fires on every keystroke) gets a gentler inline message instead of the disruptive full error
  screen, so a transient blip while typing doesn't look like "No matches" — the case that matters
  most here, since that's the one that could make a real client look like they don't exist.
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
