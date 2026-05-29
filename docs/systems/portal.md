# Client Portal
_Last verified against code: 2026-05-29 — Claude (read tier-config.ts, sync-tier.ts, auto-create.ts, queries.ts, notifications.ts, portal/team/*, resolve-portal-identity.ts, app/portal/layout.tsx)_

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
- **Notifications:** `createPortalNotification`, `notifyClientOfStageAdvance`, `getUnreadNotificationCount` (`lib/portal/notifications.ts`); `/portal/notifications` page.
- **Documents:** auto-saved (`auto-save-document.ts`), templated (`document-templates.ts`); pages for general docs, `tax-documents`, `itin-documents`. Legal docs are view-only for non-signers.
- **Invoices/payments:** `/portal/billing`, `/portal/invoices`; the **Pay modal is the only payment entry point** (R092) — invoice emails point here, never embed Stripe/wire.

## Team Access — teammates (Option B, independent identity)
An **active client's account-admin** can invite their employees ("teammates") into that **one company's** portal, choosing per-section what each may see.
- **Identity model (Option B):** a teammate is an **independent identity** — its own row in `portal_team_members`, **NOT** a contact and **NOT** in `account_contacts` (so billing/ops flows never target a teammate). Auth lives in `auth.users` with `app_metadata.role='client'` + `kind='team_member'` + `account_id` + `team_member_id` markers, and a synthetic email (`tm-<token>@teammate.portal.tonydurante.us`). Login is **username + password** (`app/portal/login`).
- **Who can manage:** only the **account-admin** ("main person"). Resolver precedence (`lib/portal/team/account-admin.ts`): persisted override (`accounts.portal_admin_contact_id`) → MMLLC SS-4 signer → signer name-match → owner-role `account_contact` → sole contact. SMLLC = the stored owner.
- **Capabilities are owner-chosen, server-enforced, default-deny** (`lib/portal/team/capabilities.ts`): `documents`, `invoices_billing`, `chat`, `company_services`, `bank_applications`, `sales_customers`, `company_data_form`, `announcements`. Empty = see nothing beyond always-on (overview/guide). Owner-only/non-delegable sections (team, sign, request service, referrals, profile, offer) are **never** delegable.
- **The gate** (`lib/portal/team/gate.ts`): `canAccessAccount(user, accountId, capability)` is **default-deny** — it replaces the leaky `if (contactId) { check }` pattern that silently skipped the check for a null-contact (teammate) user. Staff (non-`client` role) bypass. Pages use `getTeammateScopeOrNull(cap)`; the identity seam is `resolvePortalIdentity` (`contact | teammate | none`).
- **Production safety:** prod RLS denies a teammate every **direct/realtime** read (their JWT has no `contact_id`, so `get_client_account_ids()`/`get_client_contact_id()` return empty). Granted sections still work because pages fetch **server-side** via `supabaseAdmin`. Owner accepts a **responsibility disclaimer** at invite time.
- **Manage:** `/portal/team` (admin-only tab) — invite/edit/revoke/reset-password; revoke also bans the auth user. Optional teammate email enables notifications + self-serve password reset.

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
