/**
 * Global application configuration — Single Source of Truth for domains and URLs.
 *
 * ## Domain Architecture (established 2026-03-17)
 *
 * FOUR domains point to the same Vercel deployment (td-operations):
 *
 * 1. app.tonydurante.us        — CLIENT-FACING: all forms, offers, leases, OA, tracking pixels
 * 2. crm.tonydurante.us        — CRM DASHBOARD: internal team login
 * 3. td-operations.vercel.app  — INTERNAL: OAuth issuer, QB callback only
 * 4. offerte.tonydurante.us    — LEGACY: old offer links still work, but new ones use app.*
 *
 * ## Rules
 *
 * - ALL client-facing URLs must use APP_BASE_URL (app.tonydurante.us)
 * - OAuth ISSUER stays on td-operations.vercel.app (changing would invalidate tokens)
 * - QB_REDIRECT_URI stays on td-operations.vercel.app (registered with Intuit)
 * - Old links on td-operations.vercel.app and offerte.tonydurante.us still work
 *   because all 3 domains are active on Vercel — NEVER remove them
 *
 * ## Enforcement
 *
 * The .husky/pre-push hook blocks any hardcoded td-operations.vercel.app or
 * offerte.tonydurante.us in client-facing code. Only this file and OAuth/QB
 * files are exempted. If pre-push fails, use APP_BASE_URL from this file.
 */

export const APP_BASE_URL = "https://app.tonydurante.us"
export const PORTAL_BASE_URL = "https://portal.tonydurante.us"
export const CRM_BASE_URL = "https://crm.tonydurante.us"
// Internal domain — OAuth issuer, QB callback, webhooks (exempt from domain check)
export const INTERNAL_BASE_URL = "https://td-operations.vercel.app"
