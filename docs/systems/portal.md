# Client Portal
_Last verified against code: 2026-05-29 — Claude (read tier-config.ts, sync-tier.ts, auto-create.ts, queries.ts, notifications.ts)_

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
- `lib/mcp/tools/portal.ts` — `portal_create_user`, `portal_chat_*`, `portal_invoice_create/send`, `portal_messages`, `portal_team_send`, `portal_transition_*`.
- `app/portal/*` — the pages (login/auth, dashboard, wizard, documents, billing/invoices, chat, deadlines, services, members, settings, …).
- Wizards: `wizard-map.ts`, `wizard-scope.ts`, `wizard-visibility.ts`. Multi-company: `select-entity.ts`, `getPortalAccounts` (a contact can hold several accounts).

### Tables
`accounts`/`contacts` (`portal_tier`), `account_contacts`, `portal_messages` (`deleted_at`, `deleted_by`, pin fields), `portal_notifications`, portal auth users (`auth.users`), `payments`/`client_invoices`/`client_expenses`, `service_deliveries`, `deadlines`.

## Gotchas, invariants & past bugs
- **A failed downgrade looks like success** — `syncTier` silently no-ops a downgrade and returns `success:true`. Intentional (protects clients); don't "fix" it into an error.
- **Never set a contact's tier directly** — it's computed as the max across linked accounts.
- **Tier gate AND data presence** both required to show a feature — a tier change won't reveal a section that has no data.
- **One-Time accounts stay limited even at `active`** (no billing/invoicing/customers/deadlines).
- **ITIN-at-client-signing is allowed at every tier** — the data (an active ITIN SD at "Client Signing") is the real gate, not the tier.
- Two related multi-tenant projects are in flight (per-company chat isolation, portal team access) — verify current chat/team behaviour against code before assuming.

## How to verify current state
- Read `lib/portal/tier-config.ts` (the 4 tiers + features), `lib/operations/sync-tier.ts` (`syncTier` + downgrade guard + `computeContactTier`), `lib/portal/queries.ts` (`getPortalNavVisibility`, `getPortalTier`).
- A client's tier: `SELECT portal_tier FROM accounts WHERE id='<id>';` and `SELECT portal_tier FROM contacts WHERE id='<id>';` (contact should equal the max of their accounts).
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
