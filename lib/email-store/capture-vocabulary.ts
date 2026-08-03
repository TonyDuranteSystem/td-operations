/**
 * Own-Inbox content capture — the `capture_status` vocabulary.
 *
 * Single code-side source of truth for the values `email_message_content.capture_status`
 * accepts, so the code↔database constraint gate (lib/db-contract.ts) can verify the code
 * and the CHECK constraint still agree. An unregistered constrained column is a place
 * where the code can write a value the database rejects — SILENTLY.
 *
 * Database side: `CHECK (capture_status IN ('pending', 'complete', 'error'))`
 * (scripts/migrations/20260801-0100-email-content-store.sql).
 *
 * Where each value is written today:
 *   pending  — column DEFAULT on insert; the row exists but capture is unfinished.
 *   complete — written LAST by lib/email-store/capture.ts, only after the raw MIME and
 *              every part have landed. This is the gate local-first reads trust.
 *   error    — written by lib/email-store/worker.ts on a durable failure, so the
 *              reconciler/backfill revisits it instead of silently skipping.
 *
 * Extracted 2026-08-02 while unblocking CI: the column shipped unregistered, which made
 * the contract gate fail on every branch that included it. Per this file's own history,
 * a permanently-red gate is worse than no gate — a real failure reads as "the usual one"
 * and gets waved through.
 */
export const CAPTURE_STATUSES = ["pending", "complete", "error"] as const

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number]
