// Env for the bank-feed E2E harness: the PER-WORKTREE ISOLATED LOCAL STACK ONLY.
//
// Deliberately does NOT load .env.sandbox.local (which tests/live/_env.ts prefers). This
// harness plants wrong-client mis-matches, reverses money and deletes rows — it must run on a
// disposable database, never on the shared cloud sandbox that Antonio QAs against, and never
// anywhere near production.
import { config } from "dotenv"
config({ path: ".env.local" })
process.env.SANDBOX_MODE = "1" // belt and braces: blocks outbound email

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!/127\.0\.0\.1|localhost/.test(url)) {
  throw new Error(
    `REFUSING TO RUN: this harness is destructive and only runs against a local stack. NEXT_PUBLIC_SUPABASE_URL is "${url}".`,
  )
}
