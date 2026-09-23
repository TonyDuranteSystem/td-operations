# Portal Translation (any-language AI translation)
_Last verified against code: 2026-09-23 — Claude (dev job 1b374ffc)_

## What it is
A client can pick ANY language in the portal. English and Italian are hand-written; every other language is machine-translated by Claude in the background and stored per string in `portal_translations`. Three content sources are translated, always in this order: the central dictionary, the wizard text, and the help-article library ("guide"). A daily cron keeps already-used languages current when new text is added. Narrative history of how it was built lives in `docs/systems/portal.md` (the "Prior" entries, dev jobs 12cab351 and 4fa1d8e5); this file is the current-state reference.

## Business rules
- Only languages a real client account currently has selected are topped up daily (`getEstablishedLanguageCodes`), capped per run (`MAX_LANGUAGES_PER_TOPUP_RUN`) and per day for brand-new languages (`lib/portal/language-cap.ts`) — every translation is a paid AI call.
- Legally sensitive text is excluded BEFORE it reaches the engine (`lib/portal/translation-exclusions.ts`); the engine translates whatever it is given.
- Staff are alerted ONCE per (language, source) when the retry ladder is spent (`translation_chain_exhausted` in `action_log`); the daily top-up then stops re-enqueuing that scope until a human clears the row (`hasUnresolvedExhaustion`).

## How it's built
- **Table:** `portal_translations` — one row per `(language_code, key)`; `status` is `pending` → `generating` → `done`; `source_text`, `translated_text`, `generating_started_at`. For wizard and guide sources the row `key` IS the English sentence; for the dictionary it is a dot-path (`nav.chat`).
- **Engine:** `lib/portal/translation-generator.ts` — `generateTranslationsForLanguage` claims rows per batch (`BATCH_SIZE` 150) with per-key `.eq` updates (NEVER an `.in()` list — a quote character in a key corrupts it), calls Claude once per batch, saves `done` rows. `seedPendingTranslations` (AI-free) and `kickoffMissingTranslationWork` (seed + enqueue) are shared by the language-picker route and the daily cron.
- **Job:** `lib/jobs/handlers/translate-language.ts` — one chunk of one source of one language; chains `continue` → next chunk, `done`/`halt` → next source (`NEXT_SOURCE`). Decision brain is `decideChunkFollowup` in `lib/jobs/chain-state.ts` (shared with `recategorize_ai`).
- **Watchdog:** `lib/jobs/translation-watchdog.ts`, run by the 5-minute `process-jobs` cron. Reacts ONLY to a scope whose last job ended terminally (`completed`/`failed`) with untranslated rows left and NO live pending/processing job; retries on the ladder 15m → 1h → 3h → 6h → 12h (`auto_retry` in the payload), then alerts.
- **Runners:** `app/api/cron/process-jobs/route.ts` and `app/api/jobs/process/route.ts` both honour `result.terminal`.

## Gotchas, invariants & past bugs
- **Answers are matched by opaque id, never by the English sentence (2026-09-23).** `translateBatch` sends `k0..kN` and maps back by id (exact-key fallback only, unrequested ids ignored). The old exact-sentence key lookup silently failed for one wizard sentence containing curly apostrophes — the model returned the key with straight ones — so `de`/`hu` (from 2026-08-24) and `es` (from 2026-09-19) looped ~576 paid jobs/day and turned the `process-jobs` cron red (≈60% of runs from 2026-08-25, 100% from 2026-09-20) with no alert. Do NOT add fuzzy/normalized key matching: it can merge two sources that differ only by an apostrophe.
- **`translationLooksValid`** rejects an answer whose `{placeholder}` set differs from the source or whose length ratio is absurd (<0.1 or >8 for sources ≥30 chars). Keep it conservative: CJK translations are legitimately 0.2–0.5 of the English length, and a false rejection recreates a no-progress loop.
- **An answer that isn't saved is released straight back to `pending`** (`releaseClaims`). Leaving it `generating` made the retry lose its claim, look like a harmless deadline stop, and re-queue a fresh chunk — the job never failed terminally, so the watchdog never saw it. A batch whose AI call THROWS (API down/overloaded) still leaves rows `generating` on purpose: the 5-minute `recoverStuckRows` is the natural backoff.
- **`halt_no_progress` is TERMINAL** (`result.terminal = true`): the queue does not burn immediate retries and the watchdog ladder owns the retry. Do not remove it — the immediate retry is exactly what disguised the failure.
- **Continuations carry `auto_retry` forward** and reset it to 0 only when the chunk generated something. Hard-coding 0 wiped the ladder on every hop, so it could never reach "exhausted". (`recategorize-ai.ts` still hard-codes 0 — latent, tracked separately.)
- The `process-jobs` cron is marked `error` when ANY job result is `failed`, so a red cron is not by itself a translation alert — check `cron_log.details` for which job type failed.
- A new wizard/guide string containing curly quotes/em-dashes is safe now (id matching), but a source-text edit is still never re-translated: `source_text_hash` is written at insert and never read back.

## How to verify current state
- Run health: `select date_trunc('day', executed_at) d, status, count(*) from cron_log where endpoint='/api/cron/process-jobs' group by 1,2 order by 1 desc` — should be mostly `success`.
- Loop check: `select date_trunc('day', created_at), count(*) from job_queue where job_type='translate_language' group by 1 order by 1 desc` — a steady ~576/day means a stuck scope.
- Stuck rows: `select language_code, status, count(*) from portal_translations where status<>'done' group by 1,2` — rows persisting in `generating`/`pending` across days are a stuck key; `select key from portal_translations where status<>'done'` shows which.
- Alerts ever fired: `select * from action_log where action_type='translation_chain_exhausted'`.
- Tests: `tests/unit/translation-generator.test.ts`, `tests/unit/translate-language-handler.test.ts`, `tests/unit/translation-watchdog.test.ts`, `tests/unit/chain-state.test.ts`.
