# Auth & OAuth
_Last verified against code: 2026-05-29 — Claude (read middleware.ts, lib/auth.ts, lib/oauth.ts)_

## What it is
Two completely separate authentication systems — don't confuse them:
1. **Web app auth (Supabase session)** — gates the CRM dashboard and the client portal in the browser, via `middleware.ts` + RBAC roles.
2. **MCP server auth (dual: Bearer + OAuth 2.1)** — gates the MCP tool server (`app/api/[transport]/route.ts`): a static **Bearer token** for Claude Code, and **OAuth 2.1 + PKCE** for the Claude.ai custom connector.

## Web app auth & RBAC
- Roles live in `user.app_metadata.role`: **admin** / **team** / **client** (`lib/auth.ts`: `isAdmin`, `isTeam`, `isClient`, `isDashboardUser`, `getCrmRole`).
  - **admin** (Antonio, `antonio.durante@tonydurante.us`) — full access: financials, settings, all pages.
  - **team** (support@, staff) — operational only: tasks, services, accounts.
  - **client** — portal only.
- **`middleware.ts` route gating:**
  - **Public paths** (no auth): `/portal/login`, forgot/reset password, `/portal/auth/callback`, `/api/webhooks`, cron, the referral landing `/invitation`, the token+code contact-request form, `/api/portal/announcements`, the `/pay/<token>` redirect, `/.well-known`, `/oauth`, the PWA manifest.
  - No user → redirect to `/portal/login` (portal paths) or `/login` (dashboard).
  - **Portal paths** require role `client` (admins are allowed through for debugging).
  - **Dashboard paths**: a `client` is bounced to `/portal`; admin-only paths (`/dev-tools`, `/team-management`) require admin email/role, else redirected home with `?denied=admin_only`.
  - **Sandbox guard**: `SANDBOX_MODE=1` blocks all `/api/webhooks` (503) so external traffic can't mutate sandbox data.
- `isDashboardUser()` is the staff guard reused by API routes (e.g. `requireStaff()` in the message-actions route).

## MCP server auth (Claude Code + Claude.ai)
- `lib/oauth.ts` implements **OAuth 2.1 with PKCE** for the Claude.ai connector; **Bearer token stays active for Claude Code**.
- Tables: `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_users`.
- TTLs: access token **7 days**, refresh **90 days**, auth code **10 min**.
- Discovery endpoint: `/.well-known/oauth-authorization-server`. `OAUTH_ISSUER` = `NEXT_PUBLIC_APP_URL` (defaults to `td-operations.vercel.app`).
- Middleware **excludes** `/api/oauth/*` and `/.well-known/*` from session auth.

## Business rules
- **Never change `OAUTH_ISSUER`** off `td-operations.vercel.app` — it would break the Claude.ai connector (CLAUDE.md architecture note). (`QB_REDIRECT_URI` also points here, but QuickBooks is **DEAD/decommissioned since 2026-05-23** — that reason is moot.)
- The **public-path list in `middleware.ts` is security-sensitive** — adding a path there removes authentication from it. Change only deliberately.
- `SANDBOX_MODE=1` must never be set in production (it would 503 real webhooks); it exists to protect sandbox.

## How it's built
### Key files
- `middleware.ts` — the route gate (public paths, role routing, sandbox webhook block). Excludes `/api/oauth` + `/.well-known`.
- `lib/auth.ts` — RBAC helpers (`isAdmin`/`isTeam`/`isClient`/`isDashboardUser`/`getCrmRole`/`getUserDisplayName`), `ADMIN_EMAILS`, `ADMIN_ONLY_PATHS`.
- `lib/oauth.ts` — OAuth 2.1 + PKCE (token/codes/clients, `verifyCodeChallenge`, `registerClient`, `createAuthCode`, `exchangeAuthCode`), TTLs, `OAUTH_ISSUER`.
- `app/api/oauth/*`, `app/.well-known/oauth-authorization-server` — endpoints.
- `app/api/[transport]/route.ts` — the MCP entry point (Bearer + OAuth verification).

### Tables
`oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_users`, plus Supabase `auth.users` (role in `app_metadata`).

## Gotchas, invariants & past bugs
- **Two auth worlds**: a browser session (Supabase) vs an MCP token (Bearer/OAuth). A change to one does not affect the other.
- **Don't touch the OAuth issuer domain** — auth breaks silently for the Claude.ai connector. (The QB redirect points here too, but QuickBooks is decommissioned/DEAD — no longer a reason.)
- **The public-path allowlist is the attack surface** — anything listed there is unauthenticated. Audit additions.
- **Admins are NOT blocked from the portal** (intentional, for debugging) — so "admin can see the client view" is expected, not a bug.
- **MCP tool calls bypass the web sandbox guards entirely** (see `hooks-guardrails.md` / R096) — the `mcp__af7d85f2-*` connection hits production regardless of `SANDBOX_MODE`/`.env.local`.

## How to verify current state
- Read `middleware.ts` (public-path list + role routing), `lib/auth.ts` (RBAC), `lib/oauth.ts` (PKCE + TTLs), `app/api/[transport]/route.ts` (MCP auth).
- OAuth state: `SELECT count(*) FROM oauth_tokens WHERE expires_at > now();` and `SELECT client_id, name FROM oauth_clients;`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
