# Client Portal
_Last verified against code: 2026-06-06 — Claude (notifications.ts chat-email push-skip + app/api/portal/push contact_id capture; prior 2026-06-01 read of tier-config.ts, sync-tier.ts, auto-create.ts, queries.ts, notifications.ts, portal/team/*, resolve-portal-identity.ts, app/portal/layout.tsx, wizard-map.ts, wizard-visibility.ts, app/portal/wizard/page.tsx, app/portal/page.tsx, components/portal/formation-dashboard.tsx)_

> Formation-tier render path note: formation-tier clients without a materialized account go straight to `FormationDashboard` (skipping `ActionItems`). `FormationDashboard` has hard-coded CTAs for wizard/SS-4/OA/Lease, plus an optional `closureData` prop that surfaces a Closure CTA when a contact-scoped active Company Closure SD exists alongside the formation. Pattern shipped 2026-06-01 for Patrick Covelli (new NM formation + external DE LLC closure).

## What it is
The client-facing app at **portal.tonydurante.us** where clients log in to see their services, documents, invoices, deadlines, chat with the team, and complete data-collection wizards. This is NOT the internal CRM dashboard — "portal" always means the client app.

## Tiers — the master access control (R102)
A client's portal experience is gated by their **tier**. There are exactly **4** (`lib/portal/tier-config.ts`, ordered):
| Tier | When | Sees |
|---|---|---|
| `lead` (0) | Offer sent, not paid | View/sign/pay offer, chat, profile, guide |
| `formation` (1) | Paid for formation (no EIN yet) | + data wizard, documents, signatures |
| `onboarding` (2) | Existing LLC going through onboarding | + upload docs, fill wizard |
| `active` (3) | Data reviewed / company live | + services, invoices, deadlines |

- Each tier **includes** the previous tiers' features (`TIER_FEATURES`).
- **A feature shows only if BOTH gates pass:** the tier allows it AND the data exists (`getPortalNavVisibility`). Tier alone is not enough.
- **Account type** is a second axis: **Client** (annual management — full feature set per tier) vs **One-Time** (standalone service — limited; no billing/invoicing/customers/deadlines).
- The value `full` is **removed** — never use it (R102).

### How tier is set — `syncTier()` only
- **ALL tier writes go through `syncTier()`** (`lib/operations/sync-tier.ts`). Never write `accounts.portal_tier` / `contacts.portal_tier` directly (R102).
- **Downgrade guard:** `syncTier` refuses to lower a tier unless `allowDowngrade=true` — it returns **success as a silent no-op**. This stops offer-publish (which runs at `lead`) from clobbering an existing `active` client.
- **Contact tier is computed, not set:** a contact's tier = the **highest** tier across all their linked accounts (`computeContactTier` / `maxTier`). Setting an account tier propagates to its contacts.
- `tierForContract(contractType)`: `formation`→`formation`, `onboarding`→`onboarding`, everything else→`active` (`lib/portal/auto-create.ts`).

## Chat, notifications, documents
- **Chat** lives in `portal_messages`. Admin sends (dashboard or `portal_chat_send`) → the client gets an **automatic email** (`notifyClientOfAdminMessage`, throttled **1 email/conversation/2h**, bilingual — R103). Messages are **soft-deleted** (`deleted_at`/`deleted_by`, R100) and update over realtime. Tools: `portal_chat_inbox/read/mark_read/send`.
- **Email is skipped when the client has active push** (PWA installed + notifications on) — they get the Web Push instead, so the email would be redundant. Per recipient, `notifyClientOfAdminMessage` checks `push_subscriptions` first by `contact_id`, then by `account_id` (account-level fallback covers teammates and any subscription not keyed to a contact); if either has ≥1 row, the email is suppressed for that recipient. The portal "Enable notifications" endpoint (`app/api/portal/push`) now records `contact_id` (from `getClientContactId`) alongside `user_id`/`account_id` so the per-contact check has data — **pre-existing subscriptions have a null `contact_id` until the client re-subscribes**, but they're still caught by the account-level check (they carry `account_id`). Caveat: the account-level fallback is coarse — in a multi-member LLC where only one member installed the PWA, members **without** push can have their email suppressed too until subscriptions carry `contact_id`.
- **Chat attachments** upload **directly to Storage via a signed URL** (`app/api/portal/chat/upload-url` + `lib/portal/chat-attachment.ts`), NOT through a serverless function — this bypasses the platform request-body limit that silently failed large passport photos / PDF scans ("Upload failed try again"). Shared helper `uploadChatAttachment`/`validateChatAttachment` is the single source of truth used by all three senders (client `portal-chat.tsx`, staff CRM inbox `portal-chats/page.tsx`, staff `contact-detail.tsx`). Policy: any normal file, **block-list** for active-content/executables (HTML, SVG, JS, exe, …); **100 MB** cap enforced client-side AND at the `assets` bucket `file_size_limit`. Files land in the **public** `assets` bucket under `chat-attachments/<accountId|contactId>/`. The old streaming route `app/api/portal/chat/upload` was removed.
- **Notifications:** `createPortalNotification`, `notifyClientOfStageAdvance`, `getUnreadNotificationCount` (`lib/portal/notifications.ts`); `/portal/notifications` page.
- **Home announcement banners** are client components rendered on the active-tier home dashboard (`app/portal/page.tsx`), each dismissed per-device via a versioned `localStorage` key read in a `useEffect` (no hydration mismatch): `GuideAnnouncementBanner`, `TeamAccessAnnouncementBanner` (key `td-team-access-announce-v1`, also drives the sidebar "new" badge), and `WhatsNewBanner` (key `td-whats-new-v1`, bilingual "What's New / Novità" feature announcement). Bump the key's version suffix to re-show after a major change. Lead/onboarding/formation tiers render different dashboard components and do not show these.
- **Documents:** auto-saved (`auto-save-document.ts`), templated (`document-templates.ts`); pages for general docs, `tax-documents`, `itin-documents`. Legal docs are view-only for non-signers.
- **Invoices/payments:** `/portal/billing`, `/portal/invoices`; the **Pay modal is the only payment entry point** (R092) — invoice emails point here, never embed Stripe/wire. The expense list shows the **net amount due** (`client_expenses.amount_due`, the original `total` struck through when a credit was applied) and the Pay modal charges `amount_due`, so a credited invoice (e.g. a referral credit reconciled in — see `billing-invoicing.md` / `referrals-circleback.md`) shows the client the true balance. `getPortalExpenses` selects `amount_due`/`amount_paid` (added 2026-06-01).

## Team Access — teammates (Option B, independent identity)
An **active client's account-admin** can invite their employees ("teammates") into that **one company's** portal, choosing per-section what each may see.
- **Identity model (Option B):** a teammate is an **independent identity** — its own row in `portal_team_members`, **NOT** a contact and **NOT** in `account_contacts` (so billing/ops flows never target a teammate). Auth lives in `auth.users` with `app_metadata.role='client'` + `kind='team_member'` + `account_id` + `team_member_id` markers, and a synthetic email (`tm-<token>@teammate.portal.tonydurante.us`). Login is **username + password** (`app/portal/login`).
- **Who can manage:** only the **account-admin** ("main person"). Resolver precedence (`lib/portal/team/account-admin.ts`): persisted override (`accounts.portal_admin_contact_id`) → MMLLC SS-4 signer → signer name-match → owner-role `account_contact` → sole contact. SMLLC = the stored owner.
- **Capabilities are owner-chosen, server-enforced, default-deny** (`lib/portal/team/capabilities.ts`): `documents`, `invoices_billing`, `chat`, `company_services`, `bank_applications`, `sales_customers`, `company_data_form`, `announcements`. Empty = see nothing beyond always-on (overview/guide). Owner-only/non-delegable sections (team, sign, request service, referrals, profile, offer) are **never** delegable.
- **Chat notifications include teammates** — `notifyClientOfAdminMessage` (the single admin→client chat-email chokepoint) emails account contacts AND active teammates who have the `chat` capability + a real email on file (placeholder emails live only on auth.users, so they're skipped). Revoked teammates and no-chat-cap teammates are excluded; recipients are deduped by email. Teammates have no language column, so they **follow the owner's language** (the `role='owner'` account contact, else any contact, else English).
- **The gate** (`lib/portal/team/gate.ts`): `canAccessAccount(user, accountId, capability)` is **default-deny** — it replaces the leaky `if (contactId) { check }` pattern that silently skipped the check for a null-contact (teammate) user. Staff (non-`client` role) bypass. Pages use `getTeammateScopeOrNull(cap)`; the identity seam is `resolvePortalIdentity` (`contact | teammate | none`).
- **Production safety:** prod RLS denies a teammate every **direct/realtime** read (their JWT has no `contact_id`, so `get_client_account_ids()`/`get_client_contact_id()` return empty). Granted sections still work because pages fetch **server-side** via `supabaseAdmin`. Owner accepts a **responsibility disclaimer** at invite time.
- **Manage:** `/portal/team` (admin-only tab) — invite/edit/revoke/reset-password; revoke also bans the auth user. Optional teammate email enables notifications + self-serve password reset. The invite dialog explains email is optional (only for notifications).
- **Feature announcement** — account-admins see a one-time dismissible violet banner on the portal home (`TeamAccessAnnouncementBanner`, gated by `canManageTeam` computed via `isAccountAdmin`) + a "NEW" badge on the Team nav item; both clear via the shared `localStorage` key `td-team-access-announce-v1` (on banner dismiss/click or first Team-page visit). The "Invite Your Team" guide article (id `team-access`, EN+IT) lives in `app/portal/guide/page.tsx`. A broader broadcast can be posted to all clients via the existing `portal_announcements` system (CRM Config → Announcements).
- **Teammate chat attribution** — a teammate has no contact, so their chat messages stamp `portal_messages.sender_name` with the teammate's **display name** at send time (chat route teammate branch). The read route resolves the display name via `pickChatSenderName(contactName, storedSenderName)` (`lib/portal/chat-sender-name.ts`): contact name for client/owner messages, stored display name for teammates, null → UI's generic label. So staff/owner see *which* teammate wrote. Admin/system messages still render "Tony Durante Team".
- **Teammate chat threading** — the chat page (`app/portal/chat/page.tsx`) and `usePortalChat` thread by `contact_id` for normal clients but by `account_id` for teammates (no contact_id; their messages are stored by account with `contact_id` NULL). The page resolves the teammate's account via `getTeammateScopeOrNull('chat')` instead of the old `if (!contactId) redirect('/portal')` that silently bounced teammates out of Chat. The Journey Log tab is hidden for teammates (contact-oriented).

## Business rules
- **R102** — 4 tiers; `syncTier()` is the only writer; `formation` = no EIN; never advance tier manually; `full` is forbidden.
- **R103** — admin portal message auto-emails the client (throttled 2h, bilingual).
- **R100** — client-visible content (chat, notifications, docs) uses soft-delete; clients never see deleted rows, staff see a tombstone.
- **R092** — clients pay via the portal Pay button only.
- **R099** — client-side fetches must surface the server's real error, not a generic toast.
- **No support@ fallback** — the portal IS the channel; don't tell clients to email support@ as an alternative.

## How it's built
### Key files
- `lib/portal/tier-config.ts` — canonical tiers + `TIER_FEATURES` + `maxTier`.
- `lib/operations/sync-tier.ts` — `syncTier()`, `computeContactTier()`, `syncContactTiersForAccount()`.
- `lib/portal/auto-create.ts` — `tierForContract()`, `autoCreatePortalUser()`, `ensureMinimalAccount()`.
- `lib/portal/queries.ts` — everything the portal reads (`getPortalAccounts`, `getPortalNavVisibility`, `getPortalTier`, services/payments/expenses/deadlines, ITIN-at-signing).
- `lib/portal/notifications.ts` — client notifications + email.
- `lib/portal/team/*` — Team Access: `capabilities.ts` (per-section flags + nav map), `account-admin.ts` (admin resolver), `provision.ts` (create teammate auth + row), `server.ts` (list/update/revoke/reset), `gate.ts` (`canAccessAccount` default-deny + `getTeammateScopeOrNull`). `lib/portal/resolve-portal-identity.ts` — `contact | teammate | none` seam.
- `lib/mcp/tools/portal.ts` — `portal_create_user`, `portal_chat_*`, `portal_invoice_create/send`, `portal_messages`, `portal_team_send`, `portal_transition_*`.
- `app/portal/*` — the pages (login/auth, dashboard, wizard, documents, billing/invoices, chat, deadlines, services, members, settings, …).
- Wizards: `wizard-map.ts`, `wizard-scope.ts`, `wizard-visibility.ts`. Multi-company: `select-entity.ts`, `getPortalAccounts` (a contact can hold several accounts).
  - Wizard types fall into three categories: **contact-scoped** (`formation` — lives on the contact until the LLC materializes), **account-scoped** (everything else by default — onboarding, banking, tax, company_info), and **flexible** (`closure` today — can run contact-scoped for an external LLC OR account-scoped for an existing managed LLC). Discovery (`wizard-visibility.ts`, `app/portal/wizard/page.tsx`) unions contact + account queries for flexible types so a managed-account holder can still see a contact-scoped Closure.
  - Action items (`getPortalActionItems` / `getPortalActionItemsByContact`) surface a `Start ⟨Wizard⟩ Form` card per active wizard-eligible SD that has no `wizard_progress` row yet, deep-linked to `/portal/wizard?type=⟨wt⟩`. In-progress wizard cards also deep-link so refreshes return the client to the same wizard.

### Tables
`accounts`/`contacts` (`portal_tier`; `accounts.portal_admin_contact_id` = team-admin pointer), `account_contacts`, `portal_messages` (`deleted_at`, `deleted_by`, pin fields), `portal_notifications`, `portal_team_members` (teammate identity + `capabilities` JSONB, RLS-on/service-role-only), portal auth users (`auth.users`), `payments`/`client_invoices`/`client_expenses`, `service_deliveries`, `deadlines`.

## Gotchas, invariants & past bugs
- **A failed downgrade looks like success** — `syncTier` silently no-ops a downgrade and returns `success:true`. Intentional (protects clients); don't "fix" it into an error.
- **Never set a contact's tier directly** — it's computed as the max across linked accounts.
- **Tier gate AND data presence** both required to show a feature — a tier change won't reveal a section that has no data.
- **One-Time accounts stay limited even at `active`** (no billing/invoicing/customers/deadlines).
- **ITIN-at-client-signing is allowed at every tier** — the data (an active ITIN SD at "Client Signing") is the real gate, not the tier.
- **Teammates have no `contact_id`** — never gate portal access on `if (contactId)`; that silently skips the check for a teammate and leaks the resource. Use `canAccessAccount` / `getTeammateScopeOrNull` (default-deny). Teammates are never in `account_contacts` and must never be targeted by billing/ops flows.
- Per-company chat isolation is the other in-flight multi-tenant project — verify current chat behaviour against code before assuming.

## How to verify current state
- Read `lib/portal/tier-config.ts` (the 4 tiers + features), `lib/operations/sync-tier.ts` (`syncTier` + downgrade guard + `computeContactTier`), `lib/portal/queries.ts` (`getPortalNavVisibility`, `getPortalTier`).
- A client's tier: `SELECT portal_tier FROM accounts WHERE id='<id>';` and `SELECT portal_tier FROM contacts WHERE id='<id>';` (contact should equal the max of their accounts).
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
