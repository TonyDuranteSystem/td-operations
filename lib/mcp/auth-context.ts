/**
 * MCP per-request auth context (AsyncLocalStorage).
 *
 * The MCP handler is built ONCE at module scope, so tool callbacks cannot
 * receive per-request auth via closures. withAuth (app/api/[transport]/route.ts)
 * runs the handler inside this store so a tool can ask HOW the request
 * authenticated:
 *
 *   - method "static": the shared TD_MCP_API_KEY — a Claude Code session. The
 *     key names no person; the operator is Antonio in practice (env-overridable
 *     via MCP_TEAM_CHAT_ACTOR_EMAIL where a tool needs a human identity).
 *   - method "oauth": a Claude.ai connector token — the token's oauth user
 *     email IS the person. Tools must use it (or null), NEVER the env default:
 *     defaulting an identified session to Antonio would misattribute Luca's
 *     dictated messages and silence Antonio's notifications (council blocker,
 *     2026-07-29, dev job 8537adf9).
 *
 * Absent context (unit tests, unexpected paths) reads as null = unknown.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface McpAuthContext {
  method: 'static' | 'oauth'
  /** The oauth user's email when method is "oauth" and it could be resolved. */
  email?: string | null
}

const store = new AsyncLocalStorage<McpAuthContext>()

export function runWithMcpAuthContext<T>(ctx: McpAuthContext, fn: () => T): T {
  return store.run(ctx, fn)
}

export function getMcpAuthContext(): McpAuthContext | null {
  return store.getStore() ?? null
}

/**
 * The identity to stamp as "dictated by" on a team-chat send from this MCP
 * request, per the council rule (unknown → null → notify everyone):
 *   static key → the configured operator email (default Antonio — the only
 *                Claude Code operator; rotate via MCP_TEAM_CHAT_ACTOR_EMAIL);
 *   oauth      → that token's user email, or null when unresolved;
 *   no context → null.
 */
export function actingEmailForTeamChat(): string | null {
  const ctx = getMcpAuthContext()
  if (!ctx) return null
  if (ctx.method === 'static') {
    return process.env.MCP_TEAM_CHAT_ACTOR_EMAIL || 'antonio.durante@tonydurante.us'
  }
  return ctx.email?.trim() || null
}

/** The owner — the only identity allowed to reach his own private Drive folder. */
const OWNER_EMAIL = 'antonio.durante@tonydurante.us'

/**
 * Whether THIS request may reach the owner's private accounting Drive folder.
 *
 * FAILS CLOSED — unlike actingEmailForTeamChat(), which resolves "unknown" to
 * null and then notifies everyone, an unknown caller here must get NOTHING.
 * The downside of guessing wrong is exposing Antonio's personal financial
 * documents, so absent context is a denial, never a default.
 *
 *   static key → allowed. The shared TD_MCP_API_KEY is a server-side secret whose
 *     holder ALREADY has execute_sql against production and can read the owner's
 *     books directly, so this grants no new reach — and Claude Code, the surface
 *     Antonio actually works in, authenticates this way. Rotate the assumed
 *     operator with MCP_TEAM_CHAT_ACTOR_EMAIL if the key ever stops being his.
 *   oauth      → allowed ONLY when the token's user IS the owner. support@ is a
 *     registered oauth user and must NOT pass: it is the shared operational
 *     identity, and in Drive it provably cannot see the folder anyway.
 *   no context → denied.
 */
export function callerIsOwner(): boolean {
  const ctx = getMcpAuthContext()
  if (!ctx) return false
  if (ctx.method === 'static') {
    const operator = process.env.MCP_TEAM_CHAT_ACTOR_EMAIL || OWNER_EMAIL
    return operator.trim().toLowerCase() === OWNER_EMAIL
  }
  return (ctx.email?.trim().toLowerCase() ?? '') === OWNER_EMAIL
}
