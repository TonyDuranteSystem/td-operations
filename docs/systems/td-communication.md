# TD Communication
_Last verified against code: 2026-06-27 — Claude (FOUNDATION, branch `feat/td-communication-foundation` rebased on origin/main, SANDBOX — migration applied to sandbox only, NOT production; partner auth user for Cris NOT yet provisioned)_

## What it is
A direct, realtime messaging channel between TD staff and an external managed **partner** (first user: Cris). Staff use it from inside the CRM; the partner uses a confined standalone page. It is a generic conversation model (conversations → participants → messages), not tied to a specific client/account.

## Business rules
- A partner reaches the channel only if authenticated as `role='partner'` **and** their `client_partners.partner_scope` array contains `td_communication`. Default-deny otherwise.
- A `role='partner'` user is **confined by middleware** to `/collab` + `/api/conversations` — they can never reach the CRM dashboard.
- Staff (any dashboard user) see and post to **all** conversations. A partner sees and posts to **only their own** (`partner_id = their client_partners.id`).
- Messages are soft-deleted, never hard-deleted (R100). The server never returns soft-deleted bodies; the realtime UPDATE event drops the row live.

## How it's built
- **Tables** (migration `scripts/migrations/20260627-1400-comm-conversations-foundation.sql`):
  - `comm_conversations` — `subject`, `status`, `partner_id` → `client_partners`, `created_by_*`, `last_message_at`.
  - `comm_participants` — membership + per-participant `last_read_at`; unique `(conversation_id, participant_type, participant_id)`. Staff `participant_id` = `auth.uid()`; partner `participant_id` = `client_partners.id`.
  - `comm_messages` — `sender_type` (staff/partner), `sender_id/name`, `body`, `deleted_at/by`.
  - `client_partners.partner_scope text[]`.
  - Namespaced `comm_*` because the generic `conversations` table is the legacy Airtable/Fireflies comms log.
- **RLS / realtime:** `comm_messages` has **RLS ON** + a **participant-scoped SELECT policy** (`comm_messages_participant_select`) and is in the `supabase_realtime` publication, so postgres_changes deliver a row only to its participants (a partner sees only their own threads). `comm_conversations` / `comm_participants` are RLS-on with no policy (not in the publication). All authoritative reads/writes use the service role (bypasses RLS) after an explicit auth check in the API. **Staff are joined as a participant when they OPEN a thread** (`ensureParticipant` on GET messages) — that is what makes realtime deliver to them under the strict policy.
- **The policy calls a `SECURITY DEFINER` helper `public.comm_can_read(conv, uid, contact)`** — NOT an inline subquery. The participation check reads `comm_participants` + `client_partners`, which are RLS-protected; an inline subquery in the USING clause runs as the `authenticated` role, sees zero rows, and denies EVERYONE — including realtime delivery. Caught in sandbox QA (2026-06-27): Cris received none of his own messages until the policy was switched to the SECURITY DEFINER helper (runs as owner, bypasses RLS on those two tables). EXECUTE granted to `authenticated` only. Verified end-to-end on the sandbox deploy: partner + staff realtime delivery PASS, cross-conversation isolation PASS, middleware confinement PASS.
- **Middleware confinement:** `middleware.ts` has a `role==='partner'` branch that allows only `/collab`, `/collab/*`, and `/api/conversations*`, redirecting everything else to `/collab`. Without it, `role='partner'` (≠ 'client') would pass the dashboard guard and expose the whole CRM.
- **Auth helpers:** `lib/partner-auth.ts` (`isPartner`, `getPartnerForUser`, `getCommPartner`). `lib/td-communication/queries.ts::resolveCommParticipant` maps a user → `{ type:'staff'|'partner', id, name }`.
- **Pure logic (unit-tested):** `lib/td-communication/helpers.ts` — `tests/unit/td-communication.test.ts`.
- **API:** `app/api/conversations/route.ts` (GET list / POST create), `app/api/conversations/messages/route.ts` (GET list+join+mark-read / POST send). Server errors surfaced per R099.
- **UI:** `components/td-communication/conversation-chat.tsx` (shared realtime chat, subscribes to `comm_messages`), `components/td-communication/td-communication-client.tsx` (CRM list+create shell). CRM page `app/(dashboard)/dashboard/td-communication/page.tsx` → `/dashboard/td-communication`. Partner page `app/collab/page.tsx` → `/collab`. Sidebar entry in `components/dashboard/sidebar.tsx` (`id: 'td-communication'`).

## Chat feature parity (with the portal chat)
Migration `20260627-1800-comm-chat-parity.sql` adds the portal-chat columns to `comm_messages` (`attachments` jsonb, `read_at`, `reply_to_id`, `edited_at`, `original_body`, `pinned_at/by/by_type`, `kept_unread`, plus the pre-existing `deleted_at/by`). The `conversation-chat.tsx` component now matches the portal chat: **attachments** (multi-file, images+docs, drag/drop, signed-URL upload to the public `assets` bucket under `comm-attachments/<conversation_id>/` via `/api/conversations/upload-url` + `lib/td-communication/upload-attachment.ts`, image grid + lightbox), **emoji** picker, **voice-to-text** (`useVoiceInput`), **reply/quote**, **edit** (sender-only, preserves `original_body`, shows "edited"), **soft-delete** (sender or any staff; partner never receives deleted rows, staff see a tombstone), **pin** (any participant; pinned tray), **keep-unread**, **read receipts** (✓✓ via `read_at`, stamped on GET by `markMessagesRead`), drafts, date headers, jump-to-latest, link rendering. Endpoints: `message/[id]` PATCH+DELETE, `message/[id]/pin`, `message/[id]/keep-unread`, `badge` (staff sidebar unread = unread partner messages, wired through `getBadgeCounts` → sidebar item `td-communication`). **Deliberately NOT ported** (don't map to this model): portal *topic tabs* (conversations already organize threads) and *per-company entity scoping* (a partner has one identity).

## Gotchas, invariants & past bugs
- **`role='partner'` is load-bearing AND dangerous.** It lets the partner past the middleware dashboard guard (good) but, without the confinement branch, would expose the entire CRM (bad). Both behaviours live in `middleware.ts`. Existing partners that log in as `role='client'` are unaffected.
- **RLS-gated realtime is a NEW pattern here.** Unlike `portal_messages` (RLS off), `comm_messages` relies on the SELECT policy for delivery. If the policy is wrong, postgres_changes silently deliver nothing — must be browser-verified. The policy resolves a partner via `auth.jwt()->'app_metadata'->>'contact_id'`, so the partner's auth user MUST carry `contact_id` in app_metadata.
- **Provisioning is separate from code.** Creating Cris's `role='partner'` auth user (with `contact_id`), his `client_partners` row, and `partner_scope = '{td_communication}'`, plus promoting the migration to production, are pending Antonio's approval.

## How to verify current state
- Tables/pub/RLS: `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename LIKE 'comm_%'`; `SELECT relrowsecurity FROM pg_class WHERE relname='comm_messages'`; `SELECT policyname FROM pg_policies WHERE tablename='comm_messages'`.
- Partner scope: `SELECT data_type FROM information_schema.columns WHERE table_name='client_partners' AND column_name='partner_scope'`.
- Confinement: read the `role === 'partner'` branch in `middleware.ts`.
- Routes: `app/(dashboard)/dashboard/td-communication/page.tsx` (`/dashboard/td-communication`) and `app/collab/page.tsx` (`/collab`); API under `app/api/conversations/`.
- Tests: `npx vitest run tests/unit/td-communication.test.ts`.
