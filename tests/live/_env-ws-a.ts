/**
 * WS-A money-path harness env (dev job c0a61e44).
 *
 * Composes the shared live-test setup rather than re-implementing it: that one
 * loads the cloud sandbox credentials ahead of the per-worktree local stack and,
 * importantly, forces email-blocking so a live test can never fire a real message
 * at a client. A private env loader would have silently lacked that.
 *
 * Adds one guarantee on top, because this harness writes MONEY rows: it refuses
 * to run anywhere but the sandbox project. The shared setup cannot assert this
 * itself — other live harnesses legitimately run against a local stack that has
 * no cloud ref at all.
 */
import "./_env"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const PROD_REF = "ydzipybqeebtpcvsbtvs"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
if (!url) throw new Error("⛔ WS-A harness: no Supabase URL loaded — expected .env.sandbox.local or .env.local.")
if (url.includes(PROD_REF)) throw new Error("⛔ WS-A harness REFUSES to run: this points at PRODUCTION.")
if (!url.includes(SANDBOX_REF)) throw new Error(`⛔ WS-A harness REFUSES to run: not the sandbox project (${url}).`)
