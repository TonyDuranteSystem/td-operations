# Service Flow Workspaces

_Last verified against code: 2026-06-14 — Claude (Clickable stepper fires FULL side effects: `stage-stepper.tsx` (client component) — clicking any stage (other than the current) moves the SD to it, forward OR backward, after a "Move to [stage]?" confirm, via `POST /api/flows/[id]/set-stage` → `moveServiceDeliveryToStage` (lib/operations/move-stage.ts). The stepper is a SHORTCUT for the action buttons + Go Back, NOT a silent move: FORWARD dispatches ONE `advanceServiceDelivery({target_stage})` (auto-tasks + client notification + completion incl. +1y renewal-date bump — single hop, one notification, never iterated); BACKWARD iterates `revertServiceDelivery` one stage at a time to the target (deletes each re-opened stage's documents + undoes the renewal bump leaving "Closed"; revert sends no client notification). Direction is decided by stage_order resolved by NAME. The earlier silent-move `setServiceDeliveryStage` helper was REMOVED. The "← Go Back" button visibility was verified already-correct: shown on every stage except the first.)_
_Earlier 2026-06-14 — Claude (Flow chat: replaced the `chat` stub with `flow-chat.tsx` — a per-SD, CLIENT-FACING message stream backed by `portal_messages` filtered by a new `portal_messages.service_delivery_id` column (migration `20260614-1700`); `GET`/`POST /api/flows/[id]/chat`. Staff send auto-stamps `service_delivery_id` + `topic` (the flow name, e.g. "Tax Return 2025") + `account_id` + `contact_id` + `sender_type='admin'`, so the message shows in the client's portal chat AND notifies them via the existing portal notification system. The portal chat POST inherits `service_delivery_id` from a replied-to flow message so client replies thread back here.)_
_Earlier 2026-06-14 — Claude (Tax Return e-signature: extended the existing portal signature system to the flow — `signature_send` (stage 80) + `signature_status` (stage 85) components, `lib/operations/signature.ts` shared helper, `/api/flows/[id]/send-for-signature` + `/signature` routes, `document_upload` auto-advance opt-out, webhook auto-advance 85→90 on sign, `signature_requests.service_delivery_id` column + sandbox `signature-requests`/`signed-documents` buckets.)_
_Earlier 2026-06-14 — Claude (Tax Return workspace: built `DataViewer` (schema-agnostic submitted_data renderer) + `/api/flows/[id]/submission`, extended `ActionButtons` to the 5 Tax Return transitions, made info-panel treat "Completed" as terminal, seeded all 15 Tax Return stage_layouts in sandbox.)_

## What it is
A per-service-delivery **Workspace** page (`/flows/[id]`, `[id]` = `service_delivery_id`) that drives the staff UI for a recurring service from a **catalog-stored layout descriptor** — no per-stage React. Each `pipeline_stages` row carries a `stage_layout` (JSONB) listing the components to render for that stage. The page reads the SD's current stage, looks up that stage's layout, and renders it. Built for the four recurring flows (`Tax Return`, `State Annual Report`, `State RA Renewal`, `CMRA Mailing Address`); Tax Return is the fully-built reference flow (15 stages).

## How it works
- **Page** `app/(dashboard)/flows/[id]/page.tsx` (server component): loads the SD, its account, and ALL `pipeline_stages` for the SD's `service_type`. Matches the current stage by **NAME** (`sd.stage` — `stage_order` on the SD is frequently NULL/stale). Renders `StageStepper` (clickable — jumps to any stage via `/set-stage`) + `StageRenderer` + `GoBackButton` (hidden on the first stage).
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
| `signature_send` | `signature-send.tsx` | "Send for Signature" action (Tax Return stage 80). Enabled once a doc is uploaded; POSTs `/api/flows/[id]/send-for-signature` → creates a `signature_requests` row linked to the SD, notifies the client, advances to "Sent for Signature". |
| `signature_status` | `signature-status.tsx` | Shows the SD's signature request status (Waiting / Signed on date) + a staff preview link. Reads `GET /api/flows/[id]/signature`. |
| `chat` | `flow-chat.tsx` | Per-SD CLIENT-FACING message stream backed by `portal_messages` filtered by `service_delivery_id`. Loads `GET /api/flows/[id]/chat` (oldest-first); staff send via `POST` auto-stamps `service_delivery_id` + `topic` (the flow name) + `account_id` + `contact_id` + `sender_type='admin'` + `sender_id` (the auth user), so the message appears in the client's portal chat and fires the existing admin-message client notification. Client replies to a flow message inherit its `service_delivery_id` (in the portal chat POST) and thread back here. |
| `notes` | stub | Placeholder panel (not yet built). |

`document_upload` takes an optional `autoAdvance` (default true). Stage 80 sets it **false** so uploading the prepared return does NOT advance — the `signature_send` action owns the advance instead. Every other upload stage keeps the default auto-advance.

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

Review actions live on the SD stage (`Data Submitted` → Start Review → `Under Review` → Approve/`Review Completed` or Request Changes/`Revision Requested`). Document uploads auto-advance (Extension Due→Filed, Filed with IRS→IRS Receipt Uploaded). **Exception:** the `Tax Return Prepared` upload does NOT auto-advance — the **e-signature** sub-flow below owns that transition.

### E-signature sub-flow (Tax Return Prepared → Sent for Signature → Signed)
Reuses the existing portal signature system (`signature_requests` + `/sign-document/[token]/[code]` + `/portal/sign/document`), NOT a new one.
1. **Stage 80 (`Tax Return Prepared`)** — staff uploads the return (`document_upload`, auto-advance off), then clicks **Send for Signature** (`signature_send`). `POST /api/flows/[id]/send-for-signature` fetches the latest SD document's PDF bytes (Drive in prod, `onboarding-uploads` storage in sandbox — `fetchFlowDocumentPdf`), calls `createSignatureRequest` (`lib/operations/signature.ts`) which stores the PDF in the `signature-requests` bucket and inserts a `signature_requests` row stamped with `service_delivery_id`, creates a portal notification ("Your tax return is ready to sign"), and advances the SD to `Sent for Signature` with `skip_notify:true` (one tailored notice, not the generic stage-move one).
2. **Client portal** — the request auto-appears on `/portal/sign` as a "Tax Return" card (the generic `signature_requests` path already lists these) → client signs at `/sign-document/[token]/[code]` (canvas → pdf-lib overlay → `signed-documents` bucket → status `signed` → `POST /api/signature-request-signed`).
3. **Stage 85 (`Sent for Signature`)** — `signature_status` shows Waiting / Signed-on-date. The signed webhook (`/api/signature-request-signed`), seeing the request's `service_delivery_id` and the SD at `Sent for Signature`, advances it to `Signed` and stamps the signed PDF document row with the SD (idempotent: guarded on the current stage).
4. **Stage 90 (`Signed`)** — `file_with_irs` action proceeds as before.

`createSignatureRequest` sets `drive_file_id=NULL` so `/api/signature-request/[token]/pdf` serves uniformly from the `signature-requests` bucket in both environments. The MCP `signature_request_create` tool (OA/8879 production signing) is unchanged. DB: `signature_requests.service_delivery_id` (nullable FK) + the two storage buckets — migration `20260614-1500-tax-return-esignature.sql` (production already had the buckets; the column needs promoting).

> **Important divergence from the production tax pipeline.** `docs/systems/tax-returns.md` documents the PRODUCTION pipeline (Data Submitted 45 / Under Review 46 / Approved 48 / Confirmed 49 with a `tax_return_submissions.review_status` sub-state machine, SD parked at "Data Submitted" through the whole loop). The flow-workspace sandbox pipeline above is a DIFFERENT model where the review states are REAL SD stages advanced directly by the action buttons. Verified against live sandbox `pipeline_stages` on 2026-06-14. Do not assume the two pipelines match.

## How it's built
- `lib/flows/` — `stage-layout.ts` (schema), `resolve-flows.ts` (which flows an account has), `submitted-data.ts` (DataViewer grouping), `state-links.ts`, `workspace-format.ts`.
- `components/flows/` — the renderer + one component per type.
- `app/api/flows/[id]/` — `advance` (target_stage, full side effects), `set-stage` (stepper clicks → `moveServiceDeliveryToStage`: forward via advance, backward via iterative revert — FULL side effects both ways), `revert` (go back one stage), `upload-document` (upload + optional auto-advance via `auto_advance` body flag), `documents` (list), `submission` (latest tax submission), `send-for-signature` (create signature request + notify + advance), `signature` (latest request status), `chat` (per-SD client-facing `portal_messages` stream: GET oldest-first + POST staff send auto-stamping `service_delivery_id` + `topic` (flow name) + `account_id`/`contact_id` + client notification).
- `lib/operations/signature.ts` — `createSignatureRequest` (shared sig-request core, Buffer-sourced), `fetchFlowDocumentPdf` (Drive/Storage dual source), `buildSignatureToken` (pure, unit-tested).
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
