# Service Flow Workspaces

_Last verified against code: 2026-06-14 — Claude (Tax Return workspace: built `DataViewer` (schema-agnostic submitted_data renderer) + `/api/flows/[id]/submission`, extended `ActionButtons` to the 5 Tax Return transitions, made info-panel treat "Completed" as terminal, seeded all 15 Tax Return stage_layouts in sandbox.)_

## What it is
A per-service-delivery **Workspace** page (`/flows/[id]`, `[id]` = `service_delivery_id`) that drives the staff UI for a recurring service from a **catalog-stored layout descriptor** — no per-stage React. Each `pipeline_stages` row carries a `stage_layout` (JSONB) listing the components to render for that stage. The page reads the SD's current stage, looks up that stage's layout, and renders it. Built for the four recurring flows (`Tax Return`, `State Annual Report`, `State RA Renewal`, `CMRA Mailing Address`); Tax Return is the fully-built reference flow (15 stages).

## How it works
- **Page** `app/(dashboard)/flows/[id]/page.tsx` (server component): loads the SD, its account, and ALL `pipeline_stages` for the SD's `service_type`. Matches the current stage by **NAME** (`sd.stage` — `stage_order` on the SD is frequently NULL/stale). Renders `StageStepper` + `StageRenderer` + `GoBackButton` (hidden on the first stage).
- **Layout schema** `lib/flows/stage-layout.ts`: `parseStageLayout()` narrows the JSONB into `{ components: [{type, label?, url?, actions?}], description? }`. Unknown/missing layouts degrade gracefully (default Overview panel).
- **Renderer** `components/flows/stage-renderer.tsx`: maps each component `type` → a React component. Every component receives the same `serviceDelivery` + `account` context and uses what it needs.

### Component types (`STAGE_COMPONENT_TYPES`)
| type | component | purpose |
|------|-----------|---------|
| `info_panel` | `info-panel.tsx` | Overview card (company, stage, time-in-stage, deadline, assignee). On the terminal stage (`Closed` for AR/RA, `Completed` for Tax Return) shows a green "Completed" banner + completed-on; "Next renewal" row only for AR/RA. |
| `document_upload` | `document-upload.tsx` | Signed-URL upload → `POST /api/flows/[id]/upload-document` → stamps a `documents` row with `service_delivery_id` + `flow_stage`, then **auto-advances** the SD to the next stage. |
| `document_viewer` | `document-viewer.tsx` | Lists the SD's documents (`GET /api/flows/[id]/documents`), newest first, with View links. |
| `data_viewer` | `data-viewer.tsx` | Renders the account's latest tax-wizard submission (`GET /api/flows/[id]/submission`) as grouped, readable cards. **Schema-agnostic** — see below. |
| `action_buttons` | `action-buttons.tsx` | Renders a button per action key in the layout; each POSTs to `/api/flows/[id]/advance` with a target stage. |
| `external_link` | `external-link.tsx` | Static/state-resolved external link (e.g. Secretary of State). |
| `chat` / `notes` | stub | Placeholder panels (not yet built). |

### DataViewer + submitted_data (schema-agnostic)
`lib/flows/submitted-data.ts::groupSubmittedData()` turns a flat tax-wizard `submitted_data` blob into ordered display groups **without assuming a fixed schema** (keys vary by entity type — SMLLC / MMLLC / Corp):
- Keys shaped `<base>_<index>_<field>` (e.g. `member_0_member_first_name`, `bank_accounts_1_bank_name`) regroup into per-index entity cards ("Member 1", "Bank Account 1"); a redundant repeated base prefix in the field is stripped.
- Remaining flat keys bucket by leading token: `owner_` → Owner, `comp_` → Tax Questions, `us_` → US Activity, else → Company.
- `formatValue()` normalizes for display: boolean → Yes/No, number → string, file-path arrays → "N files", empty/null → omitted.
- Group order: Company, Owner, entity cards, US Activity, Tax Questions. Pure + unit-tested (`tests/unit/submitted-data.test.ts`).

The submission is fetched per-account (newest `tax_return_submissions` by `created_at`) by `/api/flows/[id]/submission`, which resolves the SD → `account_id` first.

### ActionButtons → stage transitions
`ACTION_CONFIG` in `components/flows/action-buttons.tsx` maps each layout action key to a target stage. Each button POSTs `{ target_stage }` to `/api/flows/[id]/advance`, which calls `advanceServiceDelivery` (the single source of truth for advance side effects: stage_history, status/completion, auto-tasks, portal notify). Unknown keys are ignored.

| action key | target stage |
|------------|--------------|
| `start_review` | Under Review |
| `approve` | Review Completed |
| `request_changes` | Revision Requested |
| `file_with_irs` | Filed with IRS |
| `mark_completed` | Completed |
| `complete` | Closed _(AR/RA recurring renewal — original behavior)_ |

## The Tax Return 15-stage flow (sandbox pipeline)
`Extension Due (10)` → `Extension Filed (20)` → `Awaiting 2nd Payment (30)` → `2nd Installment Paid (40)` → `Wizard Available (50)` → `Data Submitted (60)` → `Under Review (65)` → `Revision Requested (67)` → `Review Completed (70)` → `Tax Return Prepared (80)` → `Sent for Signature (85)` → `Signed (90)` → `Filed with IRS (95)` → `IRS Receipt Uploaded (98)` → `Completed (100)`.

Review actions live on the SD stage (`Data Submitted` → Start Review → `Under Review` → Approve/`Review Completed` or Request Changes/`Revision Requested`). Document uploads auto-advance (Extension Due→Filed, Tax Return Prepared→Sent for Signature, Filed with IRS→IRS Receipt Uploaded).

> **Important divergence from the production tax pipeline.** `docs/systems/tax-returns.md` documents the PRODUCTION pipeline (Data Submitted 45 / Under Review 46 / Approved 48 / Confirmed 49 with a `tax_return_submissions.review_status` sub-state machine, SD parked at "Data Submitted" through the whole loop). The flow-workspace sandbox pipeline above is a DIFFERENT model where the review states are REAL SD stages advanced directly by the action buttons. Verified against live sandbox `pipeline_stages` on 2026-06-14. Do not assume the two pipelines match.

## How it's built
- `lib/flows/` — `stage-layout.ts` (schema), `resolve-flows.ts` (which flows an account has), `submitted-data.ts` (DataViewer grouping), `state-links.ts`, `workspace-format.ts`.
- `components/flows/` — the renderer + one component per type.
- `app/api/flows/[id]/` — `advance` (target_stage), `revert` (go back one stage), `upload-document` (upload + auto-advance), `documents` (list), `submission` (latest tax submission).
- Layouts are stored in `pipeline_stages.stage_layout` per `(service_type, stage_name)`. Editing a layout = SQL/UPDATE on that row; no code change.

## Gotchas, invariants & past bugs
- **Match the stage by NAME, not stage_order** — SD `stage_order` is frequently NULL while `stage` is set.
- **`advanceServiceDelivery` is the single source of truth for advance side effects.** Action buttons and the upload route both go through it. It fires a portal notification on every advance unless `skip_notify` (the flow advance route does NOT skip — staff stage moves notify the client, consistent with the original AR/RA "complete" button).
- **`document_upload` auto-advances to the immediate next stage** (by `stage_order`). It works for Tax Return because each upload stage's next stage is the intended target. Do not add a `document_upload` to a stage whose "next" by order isn't the desired destination.
- **Terminal-stage detection is stage-name based:** AR/RA close at `Closed`; Tax Return closes at `Completed`. `info-panel.tsx` treats both as terminal; `advanceServiceDelivery` treats `Completed` / `TR Filed` / (`Closed` for AR/RA) as completion.
- **Sandbox document storage fallback:** with `SANDBOX_MODE=1` uploads stay in the `onboarding-uploads` bucket (signed URL) instead of Google Drive (many seeded accounts have no Drive folder).

## How to verify current state
- Layouts: `SELECT stage_order, stage_name, stage_layout FROM pipeline_stages WHERE service_type='Tax Return' ORDER BY stage_order` (sandbox MCP / psql — R096).
- Open `/flows/<service_delivery_id>` for a Tax Return SD and walk the stepper.
- Submission shape: `SELECT entity_type, jsonb_object_keys(submitted_data) FROM tax_return_submissions WHERE account_id='<id>' ORDER BY created_at DESC LIMIT 1`.
- Unit tests: `tests/unit/submitted-data.test.ts`, `tests/unit/resolve-flows.test.ts`.
