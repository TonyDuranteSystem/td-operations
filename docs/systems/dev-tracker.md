# Dev-Tracker Board

_Last verified against code: 2026-07-11 — Claude (initial doc; feature built this session, SANDBOX-only, NOT yet on production)._

## What it is
A per-channel board for **development work** — the single place a Claude Code session records what it's doing so nothing is lost across compaction and any later session continues cold. It is a **view over `dev_tasks`** (the existing durable tracker), NOT a second store. Staff-only, internal — distinct from the "TO DO — FROM CHATS" action board (that's client-message actions; see `todo-board.md`) and from the Team Chat kanban of chat threads (see `team-workspace.md`).

Lives at **`/dev-board`** (level 1) and **`/dev-board/[id]`** (level 2, the per-job stage board). A sidebar item "Dev Board" links to it. The old raw dev-tasks table under `/config` now banners to this board (kept as a low-level row editor).

## The model
- **One job = one card = the complete record.** Each `dev_tasks` row is a job. Everything about it — request, findings, approved plan, decisions, status, milestones, spun-off bugs, a plain-English summary — lives on that one row.
- **Two audiences per job:** `summary_plain` (plain English, for Antonio, shown on top) and the technical detail (`description`/`findings`/`plan`/`decisions`, for the coding session). Keep them in sync (R112).
- **Milestones are a lifecycle, non-linear.** A job climbs stages; a stage can move BACKWARD (QA fail → building). `milestones` is `{ current, history:[{stage,at,by,note}] }`. The board **lane** (`status`) is DERIVED from the current stage's declared lane (+ blocked/postponed) — one knob, never two to sync.
- **Stage sets are catalog-driven per job type.** `catalog_id='dev_stage_sets'` holds a stage set per work type (`default` 7-stage lifecycle: requested→investigated→plan_approved→building→qa_passed→shipped→verified; `bugfix`: reported→reproduced→root_cause→fixing→qa_passed→shipped→verified). Built-in fallbacks live in `lib/dev-tracker/stage-sets.ts`; the catalog overrides/adds. A job's set is chosen by its `type`.
- **The trail.** Each `progress_log` entry can carry a `stage` tag, so the back-and-forth (what we tried / ruled out) lands under the right milestone column, topped by that stage's settled result.
- **Child jobs.** A bug that surfaces mid-session becomes a CHILD (`parent_task_id`) in the right channel — visible on the parent's board.

## How it's built
- **Table:** `dev_tasks`. Tracker columns added this session: `channel` (board slug, validated app-side against real `internal_threads` channels — no drift), `findings`, `plan`, `summary_plain`, `milestones` (jsonb). Migrations `scripts/migrations/20260711-0959-dev-tasks-tracker-fields.sql` + `20260711-1129-dev-tasks-summary-plain.sql`. Existing columns reused: `description` (request), `decisions`, `blockers`, `progress_log`, `parent_task_id`, `status`, `type`, `priority`.
- **Pure logic (unit-tested):** `lib/dev-tracker/milestones.ts` (StageSet/StageDef types, `DEFAULT_STAGE_SET`, `advanceMilestone`, `deriveStatusForSet`, `isKeyInSet`, `labelForStage`, `notesForStage`, `parseMilestones` — lenient on stage keys), `lib/dev-tracker/board.ts` (`BOARD_LANES`, `laneForStatus`, `groupJobsByLane`), `lib/dev-tracker/stage-sets.ts` (built-in sets, `resolveStageSet`, `stageSetFromMetadata`, `mergeStageSets`). Tests: `tests/unit/dev-tracker-milestones.test.ts`, `tests/unit/dev-tracker-board.test.ts`.
- **Server stage-set loader:** `lib/dev-tracker/load-stage-set.ts` (catalog read merged over built-ins), used by the tools + the board API.
- **MCP tools:** `lib/mcp/tools/dev-tasks.ts` — `dev_task_create` (channel/summary_plain/parent_id, seeds the first stage of the type's set), `dev_task_list` (channel filter, shows milestone), `dev_task_update` (channel/summary_plain/findings/plan, `milestone` advance validated against the set, stage-tagged `progress_entry`, `postponed`). Runs on the PRODUCTION MCP (R096) — so it needs the prod migration to be live before the new params work.
- **UI:** `app/(dashboard)/dev-board/page.tsx` (level 1) + `components/dev-board/dev-board.tsx` (lanes, drag-to-lane, card → drill-in). `app/(dashboard)/dev-board/[id]/page.tsx` (level 2, resolves the job's stage set) + `components/dev-board/job-stage-board.tsx` (plain-English top, milestone columns on desktop / stacked on mobile, each stage shows settled result + trail + "Set current", cross-cutting decisions/blockers, child jobs). Shared type in `components/dev-board/types.ts`.
- **Board API:** `app/api/dev-board/[id]/route.ts` PATCH — staff-only; `{status}` (drag), `{milestone,note,postponed}` (advance, lane derived from the set), `{channel,priority}`.
- **Discipline (R112):** SessionStart print `.claude/hooks/dev-board-index.sh` + the SessionStart prompt + the PreCompact reminder in `.claude/hooks/pre-compact-save.sh`. The rule text is R112 in `CLAUDE.md`.

## Business rules / invariants
- **`dev_tasks` is the single source of truth.** The board is a view. Never build a parallel tracker.
- **Channel is validated against the real channel list** (`internal_threads` where `thread_type='channel'`), never a free string — so the tag can't drift.
- **One knob:** the lane is derived from the milestone (+ blocked/postponed). The advance path (tool + API) is the single writer that keeps `status` in lockstep. An explicit `status` (a human drag or `cancelled`) wins.
- **Postponed** reuses the existing `backlog` status (no new enum value).
- **`dev_task_*` always writes to PRODUCTION** (R096) — dev work tracking must persist regardless of session type.

## How to verify current state
- Columns: `SELECT column_name FROM information_schema.columns WHERE table_name='dev_tasks'` — expect channel/findings/plan/summary_plain/milestones present (sandbox now; production after the migration is promoted).
- Stage sets: `SELECT slug, metadata FROM catalog_entries WHERE catalog_id='dev_stage_sets' AND status='active'` (parent row in `catalog_definitions`).
- Board: open `/dev-board`, click a job → its stage board; open a `bugfix`-type child to see the different lifecycle.
- Note (R096): use the **sandbox** MCP / `psql` for sandbox; `execute_sql` on the production MCP hits production.

## Not yet done
- **Production:** the migrations + tool code + UI are SANDBOX-only. Production ship needs the two migrations run in the Supabase dashboard (prod DDL via `execute_sql` is blocked) + a prod deploy, on Antonio's explicit word. Until then R112's extra fields don't work on the production MCP.
- **Seed the backlog (Phase 5):** import Luca's Slack td-dev requests + the loose internal Team Chat threads (BUGS / Issues with the CRM / …) as jobs; re-anchor loose client-named threads; archive the dead Approval Rail thread.
- Custom per-type stage editing has no dedicated UI yet (edit the catalog rows directly).
