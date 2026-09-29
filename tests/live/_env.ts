// Loads sandbox env for live tests (run via vitest.esign-live.config.ts only).
import { config } from "dotenv"
import { existsSync } from "fs"
// Prefer the CLOUD sandbox creds (.env.sandbox.local). The auto-isolate hook
// rewrites .env.local to a per-worktree LOCAL Supabase stack that lacks the
// esign schema + CRM data this harness needs, so load the cloud sandbox first
// (dotenv does NOT override already-set vars, so .env.local stays a fallback).
if (existsSync(".env.sandbox.local")) config({ path: ".env.sandbox.local" })
config({ path: ".env.local" })
// Safety: force email-blocking so a live test can NEVER fire a real email.
process.env.SANDBOX_MODE = "1"
// The sandbox has Jodi as a second owner (production does not until Antonio says so).
process.env.NEXT_PUBLIC_EXTRA_OWNER_EMAILS = "jodi@tonydurante.us"
