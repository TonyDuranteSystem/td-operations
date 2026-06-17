# Workflow / Catalog Engine
_Last verified against code: 2026-06-17 — Claude (`formation_progress` task-workflow remapped to the new 8-stage Company Formation pipeline — migration `20260617-formation-workspace.sql` rewrote `catalog_entries.metadata->actions` (`visible_when.sd_stage` + `handler_params.target_stage`) to the new stage names: Wizard Submitted → Name Check → Filing with State → Articles Received → SS-4 Prepared → SS-4 Signed → EIN Received. `confirm_ein_received` now fires at "SS-4 Signed" (records EIN, advances to "EIN Received"); `mark_complete` at "EIN Received" still spawns RA Renewal + Annual Report SDs + sends the review request. In-flight formation tasks keep their pinned snapshot. The old confirm_oa_lease (Post-Formation → Closing) and the separate fax-advance action were dropped — OA/Lease are portal post-EIN CTAs and the fax tool lives on the SS-4 Signed workspace stage.)_
_Earlier 2026-06-16 — Claude (ITIN approve-and-send handler (`lib/tasks/workflow-handlers/itin-approve-and-send.ts`) mailing instructions — both the email block and the EN/IT portal chat messages — now point clients to TD's document-receiving office **Seminole, 11125 Park Blvd Suite 104-153, FL 33772** (was the old Largo address). The CMRA business address used in client legal docs is intentionally unchanged.)_
_Earlier 2026-05-29 — Claude (read framework.ts, dispatch-workflow-for-event.ts, trigger/snapshot schemas, catalog-validity.ts)_

## What it is
The catalog-driven engine that powers most service operations. Two layers:
1. **Catalog framework** — a generic store for every enumerated business concept (services, SD types, pipeline stages, doc types, action-board columns, **workflows**). Adding/changing a concept is data, not code.
2. **Workflow engine** — workflows themselves live as catalog rows; when an event happens (a form is submitted, an SD is created) a dispatcher finds the matching workflow and spawns a task. The big payoff: **adding a new workflow variant is pure SQL/catalog — zero code change, zero risk to siblings.**

## Catalog framework
- **Tables:** `catalog_definitions` (the catalogs) → `catalog_entries` (the rows) → `catalog_decision_log` (every mutation logged) → `catalog_pending_review` (unrecognized external values land here for triage).
- **Entry status:** `active` / `deprecated` / `exception_only` / `draft`. Actor kinds: `chat` / `ui` / `migration` / `admin_api`.
- **API** (`lib/catalog/framework.ts`): `getCatalog`, `listEntries`, `getEntry(ById)`, `addEntry`, `renameEntry`, `deprecateEntry`, `restoreEntry`, `tagEntry`, `addTranslation`, **`updateMetadata`** (the canonical metadata write path — writes a decision-log row, supports optimistic-concurrency via `expectedUpdatedAt`, and a `status` param for publish), `labelFor`/`slugFor`, `resolveExternalValue`, `listPendingReview`/`resolvePendingReview`.
- **MCP tools:** `catalog_add`, `catalog_list`, `catalog_pending`, `catalog_update`. CRM page: `/catalog`. (R106: services are a catalog — code imports from `lib/services/index.ts`, never hardcodes types.)

## Workflow engine
### Triggers (how an event finds its workflow)
`lib/tasks/workflow-trigger-schema.ts` defines a **discriminated union** on `source`:
- `form_submission` (with a `filter`, e.g. `service_type`),
- `sd_created` (with `filter.service_type`).
Extensible (future: payment_received, signature_signed…). `parseTriggeredBy` safe-parses — a malformed catalog row is **skipped with a warn, never crashes**. `matchesFilter` is strict exact-match.

### Dispatch
`lib/tasks/dispatch-workflow-for-event.ts`: `dispatchWorkflowForFormCompletion()` and `dispatchWorkflowForSdCreated()` scan `task_workflows` catalog rows, find the one whose `triggered_by` matches the event, build the task meta (via a caller-supplied `buildTaskMeta` callback — meta-building is form-specific), and spawn the workflow task. `createSD` fires `dispatchWorkflowForSdCreated` automatically (fire-and-forget).
**Defense-in-depth outcomes** (each falls back to legacy, never silently wrong): `no_trigger_match`, `ambiguous` (two active workflows match the same event = a catalog DATA error, must be fixed in catalog), `snapshot_invalid`, `meta_invalid`, `spawn_failed`.

### Snapshot pinned at task creation
`lib/tasks/workflow-snapshot-schema.ts`: when a workflow task is created, the workflow definition is **pinned as a snapshot** on the task. Catalog edits never affect in-flight tasks. `parseWorkflowSnapshot` validates it; **`buildSnapshotForStorage({slug, metadata})`** merges the catalog `slug` into metadata so the snapshot parses at render time. To retro-update in-flight tasks, write a `jsonb_set` migration.

### Validity gate (deploy/publish safety)
`lib/tasks/catalog-validity.ts` → `validateWorkflowCatalog()`: a pure-function gate asserting every active workflow's `handler` / `attachment_template` / `task_meta_schema` resolve to registered code, the snapshot parses, each action's `handler_params` parse against the handler's Zod schema, and **no two active workflows share a trigger fingerprint**. DI'd registries keep tests DB-free. The Publish action runs this before flipping a workflow to `active`.

### The editor + other pieces
- **Editor** (`/workflows`, admin): author/edit/publish workflows from the UI without SQL. `handler_params` Zod schemas live in `lib/tasks/handler-param-schemas.ts` (client-safe). Save Draft → `status='draft'` (dispatcher ignores); Publish → runs the validity gate, then `status='active'`. Stale-edit detection via `expectedUpdatedAt`.
- **Chained workflows** (`chain-transitions.ts`): `chain.spawn_next_workflow` (ITIN pattern), `chain.advance_sd_stage`.
- **SLA** (`sla-eligibility.ts`): catalog-driven escalation (`sla.auto_reassign`, `sla.notify_email_to`); import `SLA_STATE`/`SLA_META_KEYS` constants — never string-literal `"warn"`/`"escalated"`. `WORKFLOW_SLA_DRY_RUN` disables writes during rollout.
- **Default assignee** (`default-assignee.ts`): `defaultTaskAssignee()` → env `DEFAULT_TASK_ASSIGNEE`, fallback "Luca".
- **Templates:** `task_title_template` + `description_template` (token `{name}` via `lib/template-interpolation.ts`, `interpolateStringStrict`).

## How it's built — key files & tables
- Files: `lib/catalog/framework.ts`, `lib/tasks/{dispatch-workflow-for-event,workflow-trigger-schema,workflow-snapshot-schema,catalog-validity,handler-param-schemas,workflow-registry,workflow-handler-params,chain-transitions,sla-eligibility,default-assignee}.ts`, `lib/tasks/workflow-handlers/`, `app/(dashboard)/workflows/*`, `lib/mcp/tools/catalog.ts`.
- Tables: `catalog_definitions`, `catalog_entries` (incl. `catalog_id='task_workflows'`), `catalog_decision_log`, `catalog_pending_review`, `tasks` (carry `workflow_snapshot` + `task_meta`).

## Gotchas, invariants & past bugs
- **ALWAYS build a stored snapshot via `buildSnapshotForStorage({slug, metadata})`** — never hand-roll `{...metadata, slug}`. (Carved in stone after the `cf0cb867` bugfix: the slug must come from the catalog row's `slug` column or `parseWorkflowSnapshot` rejects it at render.)
- **Snapshots are pinned** — editing a workflow in the catalog does NOT change in-flight tasks; use a `jsonb_set` migration to retro-update.
- **Ambiguous trigger = catalog data error** — if two active workflows match one event, the dispatcher falls back and logs loud; fix the overlapping trigger, don't let it pick randomly.
- **Use `updateMetadata` for catalog writes** — it logs the decision and supports stale-edit detection; don't raw-`update` catalog rows.
- **PostgREST JSONB nested paths use UNQUOTED keys** (e.g. `metadata->triggered_by->filter->>service_type`).
- **Import SLA constants**, never string-literal them — a typo should be a TS error, not a silent UI bug.

## How to verify current state
- Read `lib/catalog/framework.ts` (the generic API + tables), `lib/tasks/dispatch-workflow-for-event.ts` (the two dispatchers + fallback outcomes), `lib/tasks/catalog-validity.ts` (the publish gate).
- Active workflows: `SELECT slug, status, metadata->'triggered_by' FROM catalog_entries WHERE catalog_id='task_workflows' AND status='active';`
- Run the gate locally: `scripts/check-catalog-validity.ts` (one-shot runner).
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
