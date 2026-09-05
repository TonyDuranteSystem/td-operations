/**
 * MCP per-request auth context (AsyncLocalStorage).
 *
 * The MCP handler is built ONCE at module scope, so tool callbacks cannot
 * receive per-request auth via closures. withAuth (app/api/[transport]/route.ts)
 * runs the handler inside this store so a tool can ask HOW the request
 * authenticated, AND — as of the multi-key change below — WHO as:
 *
 *   - method "static": a Bearer token from the TD_MCP_API_KEY /
 *     TD_MCP_ADDITIONAL_KEYS set. Each key names exactly one person; the route
 *     resolves which key matched and stamps email accordingly BEFORE this
 *     context is ever created, so by the time a tool sees method "static" it
 *     already carries a real identity, the same as "oauth" does.
 *   - method "oauth": a Claude.ai connector token — the token's oauth user
 *     email IS the person. Tools must use it (or null), NEVER the env default:
 *     defaulting an identified session to Antonio would misattribute Luca's
 *     dictated messages and silence Antonio's notifications (council blocker,
 *     2026-07-29, dev job 8537adf9).
 *
 * PRE-MULTI-KEY HISTORY: until 2026-09-04 every static key was implicitly
 * Antonio — there was only ever one. That collapsed two different questions
 * ("was a shared key used" vs "whose key was it") into one check, which was
 * fine while they had the same answer. The moment a second key exists for a
 * second person, they diverge, and anything gating on "was it static" instead
 * of "whose static key was it" silently grants that second person Antonio's
 * own access — this is what dev job 3c8780fd found and fixed. See
 * docs/systems/mcp-tools.md for the current key roster.
 *
 * Absent context (unit tests, unexpected paths) reads as null = unknown.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface McpAuthContext {
  method: 'static' | 'oauth'
  /** The resolved person for THIS request, whichever method authenticated it.
   *  For "static", set by the route from which configured key matched — never
   *  assume "static" alone means Antonio. For "oauth", the token's user email
   *  when it could be resolved. */
  email?: string | null
}

const store = new AsyncLocalStorage<McpAuthContext>()

export function runWithMcpAuthContext<T>(ctx: McpAuthContext, fn: () => T): T {
  return store.run(ctx, fn)
}

export function getMcpAuthContext(): McpAuthContext | null {
  return store.getStore() ?? null
}

/** The owner — the only identity allowed to reach his own private Drive folder. */
const OWNER_EMAIL = 'antonio.durante@tonydurante.us'

/**
 * Who Antonio's OWN static key (TD_MCP_API_KEY) resolves to. Kept as its own
 * function — rather than inlined where the route checks that key — so the
 * MCP_TEAM_CHAT_ACTOR_EMAIL rotation escape hatch (documented since before the
 * multi-key change: rotate the assumed operator if the key ever stops being
 * his) stays unit-testable the same way the rest of this file is, instead of
 * only reachable through a live request.
 */
export function resolvePrimaryStaticKeyEmail(): string {
  return process.env.MCP_TEAM_CHAT_ACTOR_EMAIL || OWNER_EMAIL
}

/**
 * Parses TD_MCP_ADDITIONAL_KEYS — an optional JSON object mapping each
 * additional static-key holder's email to their own secret key, e.g.
 *   {"luca@tonydurante.us": "<a long random secret, not Antonio's key>"}
 * Empty/unset (today's actual state — nobody else has a key yet) returns {}.
 * A malformed value is treated as "no additional keys" (logged, not thrown)
 * so a typo here can never take down the server Antonio's own key depends on.
 * Exported as its own pure function (input in, map out) so this parsing can
 * be unit-tested directly rather than only through a live request.
 */
export function parseAdditionalStaticKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    console.warn('[MCP] TD_MCP_ADDITIONAL_KEYS is not a JSON object — ignoring it')
  } catch (e) {
    console.warn('[MCP] TD_MCP_ADDITIONAL_KEYS is not valid JSON — ignoring it:', e instanceof Error ? e.message : e)
  }
  return {}
}

/** Which additional-key holder (if any) this Bearer token belongs to. Never
 *  Antonio's own key — that one is checked separately in the route, on its
 *  own dedicated env var, so his access never depends on this map parsing
 *  cleanly. */
export function resolveAdditionalStaticKeyEmail(token: string): string | null {
  const keys = parseAdditionalStaticKeys(process.env.TD_MCP_ADDITIONAL_KEYS)
  for (const [email, key] of Object.entries(keys)) {
    if (key && token === key) return email
  }
  return null
}

/**
 * The identity to stamp as "dictated by" on a team-chat send from this MCP
 * request, per the council rule (unknown → null → notify everyone). As of the
 * multi-key change, "static" and "oauth" resolve THE SAME WAY — both read the
 * real person the route already attached to this request — so there is no
 * per-method branch left to get out of sync: static, oauth → ctx.email, or
 * null when unresolved; no context → null.
 */
export function actingEmailForTeamChat(): string | null {
  const ctx = getMcpAuthContext()
  if (!ctx) return null
  return ctx.email?.trim() || null
}

/**
 * Whether THIS request may reach the owner's private accounting Drive folder.
 *
 * FAILS CLOSED — unlike actingEmailForTeamChat(), which resolves "unknown" to
 * null and then notifies everyone, an unknown caller here must get NOTHING.
 * The downside of guessing wrong is exposing Antonio's personal financial
 * documents, so absent context OR absent email is a denial, never a default.
 *
 * Deliberately the SAME check for both methods — static and oauth — because
 * the route now resolves a real, specific person for a static key exactly
 * like it always has for oauth. The two methods used to need separate branches
 * here ONLY because "static" alone couldn't yet tell one key-holder from
 * another; now that it can, treating them differently would be the bug, not
 * a safeguard. support@ (a registered oauth user) still correctly fails this
 * check — it is the shared operational identity, not Antonio, under either
 * method.
 */
export function callerIsOwner(): boolean {
  const ctx = getMcpAuthContext()
  if (!ctx) return false
  return (ctx.email?.trim().toLowerCase() ?? '') === OWNER_EMAIL
}
