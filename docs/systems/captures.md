# Capture / Share (screenshot tool)
_Last verified against code: 2026-09-06b — Claude (**Download and Email added to an already-captured picture — Antonio: "I need also a button to save it local or send by email." Council-challenged before building (Bug Hunter + UX/Erika-Hall specialist, at Antonio's explicit request), which caught real problems in the first draft before any of it was built.** Email deliberately reuses the CRM's OWN compose-a-new-email window (`components/inbox/compose-dialog.tsx`) rather than a device share sheet or a second, separate way to send mail — Antonio's own words, "we have our inbox in the CRM." Fetches the capture's bytes the same way Copy already does, builds a real `File` from them, and hands it to a new `prefillFiles` prop on `ComposeDialog` — which stages it through the composer's existing generic upload path (`useEmailAttachments.add()`), the exact same one a manual paperclip/drag-drop attachment already goes through, so it inherits that path's validation, size limits, and (new, see below) thumbnail preview with zero new server code. Download is the same fetch, saved via a plain browser download instead. Both actions, plus Share and Copy, are now icon-only with a hover tooltip (`FastTooltip`) in the lightbox toolbar — four actions no longer fit as icon+label on the ~350px-wide lightbox Antonio's phone PWA renders this at. **What the two reviews caught, all fixed before this shipped:** (1) [bug hunter, blocker] `ComposeDialog` opened from inside the gallery's own overlay would render BEHIND it (its own z-50 vs the gallery's z-[65]/z-[70]) — invisible, appearing to do nothing; fixed with a new `zIndexClassName` prop, mirroring the exact z-[80] precedent `share-existing-modal.tsx` already set for stacking above this same lightbox — Email uses z-[85]. (2) [bug hunter, blocker] dragging a SECOND file onto the open compose window would bubble past it into the gallery's OWN drop handler (`WorkerDropZone`'s `onDrop` never called `stopPropagation()`), silently closing the whole gallery — draft and all — and opening a brand-new capture with the dropped file instead of attaching it; fixed at the shared `components/chat/worker-dropzone.tsx` source, a real, generally-correct fix (a claimed drop should never also reach an ancestor's own handler), not a capture-specific patch. (3) [bug hunter, major] a capture that started life as a dropped/pasted non-PNG image keeps that file's ORIGINAL name on its own row even though the bytes are always re-encoded to PNG — Download/Email now build the file name from the capture's own (always non-empty) title instead of trusting the nullable, possibly-mismatched `image_name`/`mime_type` columns. (4) [UX, blocker] the compose window would only ever show a generic file-icon chip for the attached picture, never the picture itself — the ONE destination with no recall (an email, once sent, can't be pulled back) would have had the LEAST protection against the exact risk this feature's own portal-chat destination was built to guard against ("the likelier mistake with a screenshot tool is the picture catching something it shouldn't"). Fixed by adding a real thumbnail to the shared `EmailAttachmentChips` component itself — any image attached to any email through this composer now shows a preview, not just a capture's; a client-side `URL.createObjectURL` on the real `File`, since the bytes are already in the browser the moment `add()` stages them, with no upload-completion dependency. (5) [UX, major] "Save" is the wrong word in THIS codebase specifically — it already always means "persist a record," never "export a copy" (multiple existing precedents cited, including one screen that puts a Download button and a "Save to..." button side by side as two different actions) — named "Download" instead, matching this codebase's own established word and icon for the concept. A genuine bug this session's own review of its FIRST draft caught in the draft's OWN new busy-state guards: gating a handler on `openIdRef.current !== captureId` to skip a stale response's side effect must never ALSO skip resetting the button's own busy/idle state, or a lightbox closing mid-fetch leaves that button refusing to ever fire again on a later, genuine reopen of the same capture — caught and fixed before shipping, not found live. See Gotchas.)_
_Prior: 2026-09-06 — Claude (**The portal-chat destination picker can now send to a company itself, not only to one named person on it — plus a claim in this same entry's first draft that live testing proved wrong before it ever reached production.** Antonio, right after the company-name search fix let him find a real two-person company for the first time: "it gives only the member for company but not the company itself to send the message... I want to have all options. the single member as in the screenshot and the company." A multi-member company now offers itself as its own candidate — kind `company_wide`, `contactId: null` — alongside the existing per-person ones, computed by a new pure `computeWholeCompanyCandidates` (one lookup per search, scoped to `account_contacts`, counting only ELIGIBLE — invited — linked contacts; a single-eligible-member company gets no separate candidate, since addressing "the company" and addressing "that one person" would be identical). Mirrors an already-shipped, unrelated feature rather than inventing a new rule: the main Portal Chats composer's own "Whole company" addressing choice (`portal_messages.addressed_to_company`, 2026-09-05) uses the exact same account-only send shape and the exact same multi-member gate (`audienceTotal > 1`) — verified fresh in that composer's own code before building this, not assumed from memory (the independent-verifier caught the first attempt at this exact claim as unconfirmed). **The wrong claim, caught by live-testing a real send rather than trusting the plan:** the first version of this feature told Antonio that picking "the company" would notify EVERYONE linked, not just one person. A real send to a genuine 2-member test company disproved it immediately — the stored message still carried one specific, non-null contact. The shared send route always resolves and notifies exactly one deterministically-picked person for an account-scoped admin send with none supplied (`resolveAdminReplyContact`, returns null only when the account has zero linked contacts — never true for a whole-company candidate, which requires more than one). `addressed_to_company` is exactly what its own original code comment already said it was — display/routing metadata, "never a privacy gate" — and this feature does not, and architecturally cannot as the shared route is written today, change who gets notified. The real, accurate value of this feature is correct LABELING: a send meant for the company no longer has to falsely claim one specific person's name to go out at all. Confirm-screen copy and this entry corrected to say so; nothing about the actual send mechanics needed to change, only the description of what it does. See Gotchas for the exact send-route branching (contact_id becomes optional) and what stayed deliberately out of scope.)_
_Prior: 2026-09-05c — Claude (**Searching for a client by their COMPANY name in the portal-chat destination picker never found anything — found live by Antonio the same day the feature shipped, and it was total, not an edge case.** He typed a real company's short name in the "Search a client's name or company..." box and got "No matches." Reproduced with a disposable test fixture before touching anything: a plain substring of a real, eligible company's own name — no special characters at all — also matched nothing, so this was never about the one company he tried, it was every company-name search since Phase 2 shipped; only searching by the PERSON's own name ever worked. Root cause: the company-name query's own select string carried the SAME embedded relation twice — once as the plain (outer) join the contact-name query also uses, once again immediately after as its own inner join — and that duplicate, ambiguously-shaped embed silently broke the filter sitting on top of it, without an error, without a warning, just zero rows every time. Fixed by giving each of the two search passes its own select string, so the company-name pass embeds the relation exactly once, joined the way its filter actually needs. New tests pin the exact shape of each pass's query, not just the eventual candidate list, specifically so a reintroduced duplicate embed fails loudly instead of shipping quietly again. Verified against the SAME disposable fixture, deleted after: the company-name search now finds it.)_
_Prior: 2026-09-05b — Claude (**Two new actions on a picture already sitting in My Captures — Share and Copy** (Antonio: "if i open it there is no way to share it anywhere, to copy it etc") **— plus one more real bug found live while building them.** The enlarged view of any past capture now has a Share button, opening the exact same "choose where to send it" screen the post-capture flow uses (recents and all) — that screen was extracted into its own shared piece specifically so both entry points are guaranteed to behave identically, not two copies that could quietly drift apart. Sending an already-shared capture again needed its OWN idempotency posture: the earlier "reject if this was already shared" guard is exactly backwards for a deliberate resend, so all three share routes now accept an explicit resend flag that skips that guard and preserves the prior send record on failure instead of erasing it (see Gotchas). Copy uses the clipboard's image-write to let a picture be pasted anywhere without going through any of the three built-in destinations. Also found and fixed, live, testing this against a development build specifically: the markup screen's image loader could show the correct picture while leaving Continue permanently disabled for a reason invisible to the user — a stale callback from React's dev-only double-invoke, unrelated to today's two new features but caught by the same rigor. See Gotchas.)_
_Prior: 2026-09-05 — Claude (**Second bug-hunt pass, specifically re-verifying the first pass's own fixes** — end-to-end QA combining live simulation on a real deployed copy with a fresh adversarial review of the fix commit itself. Confirmed by ACTUALLY DOING IT (not just reading code) that the touch-cancel fix, the non-image rejection, the mutual-exclusion guard, and all four error-vs-empty screens genuinely work. Also found, live, that firing two sends of the same picture a fraction of a second apart both went through — the first pass's idempotency check only closed the sequential case. The re-review separately found a second, more serious gap in the SAME area: closing the tool while a picture is still uploading never invalidated that upload, so it could resolve later and silently jump a freshly-reopened session straight to "choose a destination" for a picture with no preview to show. Both fixed this round, along with three smaller ones. See Gotchas below.)_
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
- **The "choose where to send it" screen is `components/captures/destination-flow.tsx`
  (2026-09-05b)** — recents + the three destination buttons + rendering whichever picker got
  picked, extracted out of `capture-layer.tsx` into its own piece with two callers: the stage
  machine above (right after a fresh upload, a real local file for the portal-chat preview, never
  a resend) and `components/captures/share-existing-modal.tsx` (a picture already in My Captures —
  Antonio's own "Share" button on an existing picture, 2026-09-05b — only that existing capture's
  image URL, always a resend). One piece, two callers, so neither can drift from the other's
  safety rules (the mandatory-confirmation-for-portal-chat map in particular).
- **Three destination pickers**, one per type, sharing the same "finish sharing" functions
  (`lib/captures/share-actions.ts` — `attachCaptureToNote`, `sendCaptureToTeamChat`,
  `sendCaptureToPortalChat`, each taking an optional `resend` flag as of 2026-09-05b) so a one-tap
  "recent" shortcut and the full picker can never drift into two slightly-different requests:
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

### Download and Email on an existing capture (2026-09-06b)
- **Email deliberately reuses `ComposeDialog` as a full component, not a stripped-down mini version** — Antonio explicitly asked for "our inbox in the CRM," and a lighter stand-in would be exactly the kind of second, slightly-different send path this whole feature's own header comment already warns against for its three built-in destinations. Any future change to how the Inbox composer validates, uploads, or sends an attachment applies here automatically, for free — there is no separate code path to remember to update.
- **A capture's file name for Download/Email is built from `title` + `.png`, never from the stored `image_name`/`mime_type` columns.** Those two columns can legitimately disagree with the actual bytes for a capture that started as a dropped/pasted non-PNG image (the markup editor always re-encodes to PNG but never touches the stored original filename) — invisible until this feature became the first thing to actually surface a file name to a human. `title` is DB-constrained non-empty; the two DB columns are nullable and, for this one case, can be actively wrong.
- **`ComposeDialog` needs an explicit higher stacking level (`zIndexClassName` prop) whenever it's opened from inside another full-screen overlay** — its own default (z-50) is correct for a normal page but renders invisibly behind anything with a higher z-index already on screen, exactly the trap `share-existing-modal.tsx` already had to solve once for this same lightbox (z-[80]). Email here uses z-[85]. Any FUTURE caller that opens Compose from inside another modal/overlay needs to do the same — check what it's stacking against, don't assume the default is high enough.
- **A drop-target component (like `WorkerDropZone`) that doesn't `stopPropagation()` on a claimed drop is a latent bug waiting for exactly this scenario**: two independently-built full-screen "accept a drop anywhere" surfaces, one nested inside the other. Fixed at the shared component itself (all four drag handlers now stop propagation) rather than special-cased here, since the same collision could happen anywhere else this pattern gets nested in the future.
- **The busy/idle state for a fetch-then-act button (Copy/Download/Email) must resolve on EVERY exit path, even a "this response is stale, skip the visible effect" one.** Skipping the effect but ALSO skipping the state reset leaves that button permanently refusing to fire again — a real bug this session's own review of its first draft caught before it shipped, not found live. The fix: gate only the actual side effect (the clipboard write, the file save, opening the email window) on freshness; let the busy→idle/error transition always happen regardless.
- **The Inbox's shared `EmailAttachmentChips` now shows a real thumbnail for any image attachment, not a capture-specific feature** — a client-side `URL.createObjectURL` set the instant a real `File` is staged (`useEmailAttachments.add()`), created and revoked entirely in the browser, never touching the server. Only files staged this way get one; `addFromSource` (Forward's copy-from-an-existing-Gmail-message path) has no local `File` to preview from and is unaffected, unchanged.

### Whole-company destination (2026-09-06)
- **`contact_id` is now genuinely OPTIONAL on the REQUEST this route sends** — the one place in this whole feature where that's true. Every validation step, the destination record's own `id` field (falls back to the account id when there's no contact), the re-check right before sending, and the actual request to the shared send route all branch on whether a contactId was given. Sending WITH a contactId always means "one specific attributed person" (`sender_context: 'company'`); sending WITHOUT one means "the account itself, no attributed sender named by US" (`addressed_to_company: true`, no `sender_context` at all) — the two REQUEST shapes must never blend, mirroring the main Portal Chats composer's own two distinct request shapes for this exact distinction.
- **⚠️ "No contactId in the request" is NOT "no contact_id in the stored message" — caught live, before this ever reached production, not assumed from reading the composer's code.** The shared send route (`app/api/portal/chat`) always resolves and stamps SOME real contact for an account-scoped admin send that omits one (`resolveAdminReplyContact` — null only when the account has ZERO linked contacts, never true here). `notifyClientOfAdminMessage` is then called with THAT resolved contact regardless of `addressed_to_company`, so it always takes its one-recipient branch, never an "everyone at the account" branch — there IS no such branch to take. A live send to a real 2-member test account proved this: the stored row's `contact_id` was NOT null. `addressed_to_company` changes the LABEL and nothing about who is notified — matching its own original code comment ("display/routing metadata... never a privacy gate"). The real value of this feature is that a company-addressed send no longer has to falsely borrow one specific person's name to go out at all — not a different notification audience.
- **The multi-member threshold is evaluated fresh, per search, scoped to THIS feature's own data source** (`account_contacts` + `contacts.portal_email_sent_at`) — deliberately NOT the separate `members` table the main Portal Chats composer additionally consults as a patch for known gaps between the two (documented there as real: roughly a third of members in roughly half of multi-member accounts have no `account_contacts` row at all). That reconciliation is real work but out of scope for this narrower picker; the accepted, current bound is that an account whose ONLY multi-member evidence lives in the `members` table (not `account_contacts`) won't offer a whole-company candidate here even though the main composer would.
- **The send-time eligibility check is deliberately looser than the search-time offer check** — search only offers "the company" when more than one person is eligible; the send route accepts it as long as AT LEAST one still is. A company that drops from two eligible members to one between opening the search and hitting send still succeeds — the option just wouldn't be offered again on a fresh search. Treated as an acceptable, narrow race, not a bug: the alternative (re-deriving and re-checking the exact ">1" condition at send time) would reject a send that's still perfectly safe, for a company whose composition changed in the seconds between search and confirm.
- **Not saved as a "recent" one-tap shortcut** — `RecentDestination`'s portal_chat shape keys on a real contactId, and portal_chat already never skips its confirm screen regardless of how it was reached, so a saved whole-company recent would only pre-fill a search that's just as fast to redo. Deliberately not built, not an oversight.

### Company-name search fix (2026-09-05c)
- **Two PostgREST-embed queries sharing the SAME base select string is a real, silent trap — a duplicate embed of the same relation doesn't error, it just makes the filter on top of it match nothing.** The company-name search used to build its select by taking the contact-name pass's own select string (which already embeds `account_contacts(accounts(...))` as a plain/outer join) and appending a SECOND, `!inner`-joined embed of the exact same relation on top of it, because the `.ilike("account_contacts.accounts.company_name", ...)` filter needs an inner-joined path to attach to. Two differently-joined embeds of one relation name in a single select is ambiguous, and PostgREST's response to that ambiguity here was to return zero rows with a normal 200 — no error, no warning, nothing in the logs to point at. Found live the same day the feature shipped: Antonio searched a real client by company name and got "No matches"; reproduced with a disposable fixture before assuming anything, and a plain substring with zero special characters failed identically, proving it was total, not specific to his search term. **The fix, and the rule going forward: every distinct join shape a query needs gets its OWN select string, never built by extending another pass's string with more embeds of the same relation.** New tests assert the exact embed count in each pass's own select string, not just the eventual result list, so a reintroduced duplicate fails the test even if some other row happens to still match.

### Share + Copy on an existing capture (2026-09-05b)
- **The destination-choice screen (recents + the three destination buttons + all three pickers) is ONE shared piece, not duplicated.** Extracted into its own component specifically so a capture's "Share" button (a later, deliberate resend) and the original post-capture flow are GUARANTEED to behave identically — same recents, same mandatory-confirmation-for-portal-chat rule, same everything — because they render the literal same code, not two hand-kept-in-sync copies. The only two differences between the two callers are passed as props: the ORIGINAL flow has a real local file for the portal-chat preview and never marks the request as a resend; the gallery's Share flow has only the existing capture's own URL (no local file survives) and always marks it as one.
- **"Already shared" is exactly the state a deliberate resend is trying to send FROM, so it needs its own idempotency shape, not the original one.** The original guard (reject outright if a destination is already set) is correct for "this exact capture has never been sent" and exactly backwards for "send this again, possibly somewhere else." All three share routes now accept an explicit resend flag: set, they skip the "must currently be unsent" gate entirely, and if the actual send fails afterward, they restore the PRIOR destination value instead of clearing it to nothing — there's a real previous send to protect, not a blank slate. Deliberately lighter than the original's atomic claim (see the first pass's entry below) for this one path: a resend is a slow, multi-step, freshly-reopened action, not the "one already-visible button, a network hiccup" pattern the atomic claim exists to close, and the picker's own busy-guard (already proven reliable for a real double-tap) is judged adequate here. The original post-capture flow never sends this flag, so its protection is completely unchanged.
- **Copy sends the actual picture to the clipboard, not a link to it** — the browser's image-write clipboard API, fed the same bytes the private image-proxy endpoint already serves. Every capture this tool produces is a PNG, so there's no image-format branch to get wrong. A failure (permission denied, an unsupported browser) shows a clear "Could not copy" instead of silently doing nothing.
- **A stale callback from React's dev-only Strict Mode double-invoke could leave the markup screen's Continue button disabled even though the correct picture was already visibly showing** — found live, 2026-09-05, testing against a LOCAL DEVELOPMENT build specifically (this exact class of bug is invisible against a real deployment, since Strict Mode's double-invoke never runs there). The image-load effect's cleanup revokes its blob URL immediately when Strict Mode tears down the first of its two deliberate invocations — normal and already handled for the URL itself — but the FIRST invocation's `<img>` can still fire a belated `onerror` off that now-revoked URL, arriving AFTER the second invocation's `<img>` already loaded correctly and enabled Continue. That late error overwrote the correct state with a failure, with nothing on screen to explain why. Fixed with a `cancelled` flag set the instant a run's own cleanup fires, checked in both `onload` and `onerror` — only the CURRENT attempt's callbacks can ever change state now, regardless of what a superseded one does later. Unrelated to the two new features that surfaced it; caught by the same standing rule that local-dev testing (not just checking a deployment) is what catches this specific class of race.

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
- Whole-company send (live, sandbox): search a fixture company with TWO eligible contacts, confirm
  a "Whole company" candidate appears alongside the two per-person ones, send it, then check
  `portal_messages` for the new row has `addressed_to_company = true` — its `contact_id` will be
  some real, non-null value (whichever contact `resolveAdminReplyContact` picked), NOT null; that
  is expected, see the Gotchas entry above, not a bug to chase. A fixture with only ONE eligible
  contact must NOT show the whole-company candidate at all.
- Download/Email (live, browser): open a capture, confirm all four toolbar actions render as
  icon-only buttons with a hover tooltip and fit on a narrow (~375px) viewport without overflowing.
  Click Download — a `.png` file matching the capture's title should save to disk. Click Email —
  the compose window must render ON TOP of the lightbox (not hidden behind it), already carrying
  the picture as an attachment with a real thumbnail (not a generic file icon), and Subject
  pre-filled with the capture's title. While it's open, drag a second file anywhere onto the
  screen — it must attach to the EMAIL, not close the gallery or start a new capture. Close
  without sending, reopen the SAME capture, click Email again — it must still work (not silently
  refuse), confirming the busy-state reset survives a mid-flight close.
