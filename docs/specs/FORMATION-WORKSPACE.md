# Company Formation Workspace — Design Spec

**Status:** v2 (7-stage) workspace built + live on `feat/formation-workspace-v2` (migration `20260617-formation-workspace-v2.sql`, applied to sandbox). This revision (June 18, 2026) updates **Stage 2 "Wizard Submitted"** into the full name-process command center and simplifies **Stage 3**. The name-status tracking + decision-request automation described here is a DESIGN update — not yet built.
**Related:** Client Decision Requests (docs/specs/CLIENT-DECISION-REQUESTS.md) — the structured-response engine the name flow runs on.

## Overview

A full-page stage-driven workspace for Company Formation service deliveries. Same architecture as ITIN/Tax Return workspaces: `pipeline_stages.stage_layout` JSONB defines which components render per stage. The workspace replaces the old task-card-driven formation flow.

## The 7 Stages

1. **Payment Confirmed** (stage_order 1) — SD created after client signs + pays. Waiting for the client to complete the formation wizard. Components: info_panel, waiting_notice, chat. Client label EN: "Payment confirmed" / IT: "Pagamento confermato".
2. **Wizard Submitted** (stage_order 2) — **THE NAME COMMAND CENTER** (see below). Client label EN: "We're reviewing your details" / IT: "Stiamo verificando i tuoi dati".
3. **Filed with State** (stage_order 3) — waiting for Articles + SOS-rejection handling (see below). Client label EN: "Filing with the state" / IT: "Registrazione presso lo stato".
4. **Articles Received** (stage_order 4) — THE MILESTONE. Articles uploaded; CRM account created; RA activated on Harbor Compliance; compliance dates set; welcome package sent. Action: "Articles Uploaded — Prepare SS-4" → stage 5. Client label EN: "Articles received" / IT: "Atto costitutivo ricevuto".
5. **SS-4 Prepared** (stage_order 5) — SS-4 generated, waiting for client signature. Action: "Client Signed SS-4" → stage 6. Client label EN: "Sign your SS-4" / IT: "Firma il modulo SS-4".
6. **SS-4 Signed** (stage_order 6) — staff faxes to IRS, waits for EIN. Fax does NOT auto-advance. Action: "EIN Received" → stage 7. Client label EN: "SS-4 sent to IRS" / IT: "SS-4 inviato all'IRS".
7. **EIN Received** (stage_order 7) — FINAL. Staff enters EIN + uploads CP 575. On completion: SD marked complete; spawns RA Renewal + Annual Report SDs. Client label EN: "EIN received — all set!" / IT: "EIN ricevuto — tutto fatto!".

> **"Name Check" is removed as a separate stage/concept.** Everything about choosing, checking, approving, and filing the name happens inside **Wizard Submitted**. Staff leave that stage only when a name is **confirmed by the client AND filed on the SOS**.

## Stage 2 "Wizard Submitted" — the name command center

This stage owns the **entire** name process: checking availability, communicating with the client, handling SOS rejections, requesting new names. Staff do not advance until one name reaches status **"Filed"**.

The stage shows:

1. **All names** the client has submitted (from the wizard, and any later-proposed ones), each with a **status badge**:
   - `Checking` — not yet evaluated (default for newly arrived names)
   - `Available` — staff confirmed it's free on SOS
   - `Not Available` — staff confirmed it's taken on SOS
   - `Approved by Client` — client approved an `Available` name via a decision request
   - `Rejected by SOS` — SOS rejected it at/after filing
   - `Filed` — staff filed this (client-approved) name on the SOS site
2. **SOS link** to check availability (dynamic per state, default New Mexico).
3. Staff can **mark each name's status** (Available / Not Available) after checking SOS.
4. When staff marks a name **`Available`** → the system **auto-creates an `approval` decision request** to the client: *"[Name] LLC is available in [State]. Approve filing with this name?"* (badge → effectively "awaiting client" until answered).
5. **Client approves** → the name's badge becomes **`Approved by Client`** → staff file it on the SOS site (link on the same page) and mark it **`Filed`**.
6. If **none of the submitted names are available** → the system **auto-creates a `text_input` decision request**: *"None of your names are available. Please propose 3 new names."* When the client submits, the **new names append** to the name list with fresh `Checking` badges (no new stage — same command center).
7. After filing, if **SOS rejects** the name → staff mark it **`Rejected by SOS`** → the system **auto-creates a `text_input` request** asking for new names → loop continues.
8. **Action button: "Name Confirmed & Filed — Waiting for Articles"** — only **clickable when at least one name has status `Filed`** → advances to **Articles Received**.

Components (conceptual): `name_checks` panel (the badge list + mark-status controls + SOS link + per-name actions), `decision_requests` panel (history of approval/text_input requests for this SD), `data_viewer` (owner/passport/business-purpose, secondary/collapsed), `chat`, `action_buttons` (the gated advance).

## Stage 3 "Filed with State" — simplified

Staff **already filed** from Wizard Submitted, so this stage is intentionally light: it's **waiting for the Articles of Organization** to arrive, plus **SOS-rejection handling**.

- Upload filing receipt / Articles of Organization.
- If **SOS rejects** at this point: the name flips back to **`Rejected by SOS`**, the system auto-creates a `text_input` request for new names, and staff can **refile from here** (or move the SD back to Wizard Submitted to re-run the full name loop).
- Two actions: "Articles Received — Company Created" → stage 4; "Name Rejected — Choose New Name" (stays / loops).

## Name-status data model

Names need per-name status tracking. **Decision: a `name_checks` JSONB column on `service_deliveries`** (flexible — new names from `text_input` responses append to the same array; no extra table/joins).

```json
name_checks: [
  {
    "name": "Automatiko LLC",
    "source": "wizard",                // "wizard" | "client_proposed"
    "status": "available",             // checking | available | not_available | approved_by_client | rejected_by_sos | filed
    "checked_at": "2026-06-18T...",
    "sos_result": "free text note from the SOS check",
    "decision_request_id": "uuid|null" // the approval request created when marked available
  }
]
```

- Seeded from the wizard's `llc_name_1/2/3` at first render (status `checking`).
- A `text_input` response (new names) parses + appends entries with `source: "client_proposed"`, status `checking`.
- Marking `available` stamps `checked_at` + creates the approval request (stores `decision_request_id`).
- Client approval flips the entry to `approved_by_client`; filing flips it to `filed`; SOS rejection flips it to `rejected_by_sos`.
- The Stage-2 advance gate checks `name_checks` for any entry with status `filed`.

## Harbor Compliance API Integration

Available as MCP tools: `hc_sync_company` (push account to HC, activate RA), `hc_list_companies`, `hc_submit_ra_change`, `hc_list_deliveries`, `hc_download_delivery`, `hc_list_licenses`, `hc_sync_license_deadlines`. RA activation happens at **Articles Received** (the company is confirmed), never at filing time — via the `activate_ra` workspace button → `hc_sync_company`.

## SOS Links (per state)

| State | URL |
|-------|-----|
| New Mexico | https://enterprise.sos.nm.gov/ (the old portal.sos.state.nm.us/BFS/online/ is dead) |
| Wyoming | https://wyobiz.wyo.gov/Business/FilingSearch.aspx |
| Florida | https://dos.fl.gov/sunbiz/start-business/efile/fl-llc/ |
| Delaware | https://icis.corp.delaware.gov/ecorp/logintax.aspx |

Dynamic on the account's `state_of_formation`; default New Mexico. In-flight formations are contact-scoped (no account yet), so the state is read from the formation wizard. Implemented as `resolveFormationFilingLink` in `lib/flows/state-links.ts`.

## Code Paths (built in v2)

Compliance dates + welcome package fire on advance into "Articles Received" (`lib/service-delivery.ts`); SS-4 fax no longer auto-advances (`lib/pipeline-utils.ts`); all EIN-advance paths target "EIN Received" (`formation-confirm-ein-received.ts`, `record-ein-received` route, `ein-received.ts`, `enter_ein` contact-action); `place-client` presets + `audit-chain` thresholds remapped; `data_viewer` reads `wizard_progress` for formation SDs (shows the 3 name candidates, no "chosen"). See `docs/systems/formation.md` + `flows.md`.

## Portal Tracker

Reads the SD pipeline stages + `client_label`/`client_label_it`; amber "Action required" glow on client-action steps (Payment Confirmed → wizard, SS-4 Prepared → sign). The name approval / new-name requests reach the client as **Client Decision Request cards** on `/portal/flows/[id]` (the portal tracker itself stays stage-driven). EN/IT.

## What's New Integration

The formation card in What's New links to `/flows/[sd_id]`. Client responses to name decision requests surface as a `decision_responded` What's New event.

## Rules

- **Stage 2 owns the whole name process.** Staff advance only when a name is `filed`.
- **Account creation ONLY at Articles Received** — never before.
- **Verify, don't assume** — check data exists before claiming it does.
- Sandbox first; feature branch → "ship it" → merge to main.
