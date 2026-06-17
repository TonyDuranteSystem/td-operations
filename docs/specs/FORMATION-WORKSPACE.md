# Company Formation Workspace — Design Spec

**Status:** Plan approved by Antonio (June 17, 2026). Ready to build on a NEW branch from main.
**Previous branch:** `feat/formation-progress-redesign` has partial/conflicting work — do NOT reuse it.

## Overview

A full-page stage-driven workspace for Company Formation service deliveries. Same architecture as ITIN/Tax Return workspaces: `pipeline_stages.stage_layout` JSONB defines what components render per stage. The workspace replaces the old task-card-driven formation flow.

## The 7 Stages

### 1. Payment Confirmed (stage_order 1)
- **What happens:** SD created after client signs + pays. Waiting for client to fill the formation wizard.
- **Components:** info_panel, waiting_notice ("Waiting for client to complete the formation wizard."), chat
- **Client label EN:** "Payment confirmed"
- **Client label IT:** "Pagamento confermato"

### 2. Wizard Submitted (stage_order 2) — THE WORKING STAGE
- **What happens:** Client filled the formation wizard. Staff reviews the data, checks name availability on SOS, chats with client to confirm which name to use.
- **Components:** data_viewer (MUST read from `wizard_progress` table — shows 3 LLC name choices prominently, owner details, passport, business purpose), external_link (SOS name check, dynamic per state), chat, action_buttons
- **Action:** "Name Chosen — File with State" → advances to stage 3
- **Client label EN:** "We're reviewing your details"
- **Client label IT:** "Stiamo verificando i tuoi dati"
- **IMPORTANT:** The data_viewer currently reads from tax submissions. For formation, it must read from `wizard_progress` where `wizard_type = 'formation'` and match the SD's `contact_id`.

### 3. Filed with State (stage_order 3) — LOOP STAGE
- **What happens:** Staff filed the chosen name on the SOS website AND activated the Registered Agent on Harbor Compliance. Now waiting for SOS to confirm (can take ~1 week). Two outcomes: approved (Articles arrive) or rejected (pick new name, refile).
- **Components:** info_panel (shows chosen name), external_link (SOS filing page, per state), "Activate RA on Harbor Compliance" button (calls `hc_sync_company` API), document_upload ("Upload filing receipt"), document_upload ("Upload Articles of Organization"), chat, action_buttons
- **Two actions:**
  - "Articles Received — Company Created" → advances to stage 4
  - "Name Rejected — Choose New Name" → stays at stage 3, allows changing the name and refiling
- **CRITICAL:** The CRM account is NOT created at this stage. The name is not confirmed yet. Account creation happens only at stage 4 when Articles are uploaded.
- **Client label EN:** "Filing with the state"
- **Client label IT:** "Registrazione presso lo stato"

### 4. Articles Received (stage_order 4) — THE MILESTONE
- **What happens:** SOS approved the company. Articles of Organization received and uploaded. This is when the company becomes real.
- **Components:** document_upload ("Upload Articles of Organization" — if not already), document_viewer, info_panel, chat, action_buttons
- **Action:** "Articles Uploaded — Prepare SS-4" → advances to stage 5
- **TRIGGERS at this stage:**
  - CRM account creation (company_name from the confirmed name)
  - Compliance dates set (annual_report_due_date, ra_renewal_date)
  - Welcome package sent
  - Harbor Compliance sync (`hc_sync_company`)
- **Client label EN:** "Articles received"
- **Client label IT:** "Atto costitutivo ricevuto"

### 5. SS-4 Prepared (stage_order 5)
- **What happens:** SS-4 (IRS EIN application form) generated and waiting for client to sign.
- **Components:** document_viewer, waiting_notice ("Waiting for client to sign the SS-4 form."), info_panel, chat, action_buttons
- **Action:** "Client Signed SS-4" → advances to stage 6
- **Client label EN:** "Sign your SS-4"
- **Client label IT:** "Firma il modulo SS-4"

### 6. SS-4 Signed (stage_order 6)
- **What happens:** Client signed the SS-4. Staff faxes to IRS and waits for EIN.
- **Components:** document_viewer, fax_irs, document_upload ("Upload fax confirmation/tracking"), chat, action_buttons
- **Action:** "EIN Received" → advances to stage 7
- **NOTE:** The fax tool does NOT auto-advance. Staff manually advances when the EIN arrives.
- **Client label EN:** "SS-4 sent to IRS"
- **Client label IT:** "SS-4 inviato all'IRS"

### 7. EIN Received (stage_order 7) — FINAL
- **What happens:** EIN received from IRS. Staff enters the EIN number and uploads the CP 575 letter. Formation is complete.
- **Components:** document_upload ("Upload EIN Letter (CP 575)"), document_viewer, info_panel, chat
- **On completion:** SD marked as complete. Spawns RA Renewal + Annual Report SDs for the new account.
- **Client label EN:** "EIN received — all set!"
- **Client label IT:** "EIN ricevuto — tutto fatto!"

## Harbor Compliance API Integration

Already available as MCP tools:
- `hc_sync_company` — push CRM account to HC, activate RA
- `hc_list_companies` — verify company on HC
- `hc_submit_ra_change` — submit RA change order
- `hc_list_deliveries` — check RA mail/packages received
- `hc_download_delivery` — download delivery doc to Drive
- `hc_list_licenses` — see licenses and registration dates
- `hc_sync_license_deadlines` — pull expiration dates into CRM deadlines

In the workspace, the "Activate RA" button on the "Filed with State" stage should call `hc_sync_company` via an API route.

## SOS Links (per state)

| State | URL |
|-------|-----|
| New Mexico | https://portal.sos.state.nm.us/BFS/online/ |
| Wyoming | https://wyobiz.wyo.gov/Business/FilingSearch.aspx |
| Florida | https://dos.fl.gov/sunbiz/start-business/efile/fl-llc/ |
| Delaware | https://icis.corp.delaware.gov/ecorp/logintax.aspx |

The SOS link should be dynamic based on the account's `state_of_formation`. Default to New Mexico (current primary filing state).

## Code Paths to Rewire

These paths reference old stage names and must be updated:

1. **Compliance dates init** (`lib/service-delivery.ts`) — currently triggers at "Post-Formation + Banking". Move to "Articles Received".
2. **Welcome package** (`lib/service-delivery.ts`) — currently triggers at "Post-Formation + Banking". Move to "Articles Received".
3. **SS-4 fax → auto-advance** (`lib/pipeline-utils.ts`) — currently advances to "EIN Submitted". Remove auto-advance; SD stays at "SS-4 Signed".
4. **Record EIN handler** (`formation-confirm-ein-received.ts`) — currently expects "EIN Submitted" → "Post-Formation + Banking". Change to advance to "EIN Received" as the final stage.
5. **`place-client` admin action** (`app/api/crm/admin-actions/place-client/route.ts`) — references "State Filing". Update to new stage names.
6. **`formation_progress` task workflow** — all `visible_when.sd_stage` values reference old names. Remap to new stages.
7. **`data_viewer` component** — currently reads from tax submissions only. Must also read from `wizard_progress` for formation SDs.

## Portal Tracker

The portal formation progress tracker must:
- Read from the SD pipeline stages (NOT from separate signals like `wizardData.status`, `account.filing_id`, etc.)
- Use `client_label` / `client_label_it` from pipeline_stages
- Show amber glow + "Action required" on client-action steps (stage 2: wizard link, stage 5: signing link)
- Be clickable for action steps
- Support EN/IT

## What's New Integration

The formation card in What's New (Activity & To-Dos) should link to `/flows/[sd_id]` (the workspace page), not show inline advance buttons.

## SD Remap (existing data migration)

| Old Stage | New Stage |
|-----------|-----------|
| Data Collection (active) | Wizard Submitted |
| Data Collection (cancelled) | Payment Confirmed |
| State Filing | Filed with State |
| EIN Application | SS-4 Prepared |
| EIN Submitted | SS-4 Signed |
| Post-Formation + Banking | EIN Received |
| Closing | EIN Received |

## Rules

- **NEW branch from main** — do not reuse `feat/formation-progress-redesign`
- **Sandbox first** — apply DB migration to sandbox, test, then production
- **Never commit on main** — feature branch → sandbox → "ship it" → merge to main
- **Account creation ONLY at Articles Received** — never before
- **Verify, don't assume** — check data exists before claiming it does
