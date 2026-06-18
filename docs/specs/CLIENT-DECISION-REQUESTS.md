# Client Decision Requests — Design Spec

**Status:** Design phase. Not yet approved for build.
**Related:** Formation Workspace (docs/specs/FORMATION-WORKSPACE.md) — first consumer of this system.

## Problem

Multiple workflows need structured responses from clients: name approval (formation), document approval (tax return), signature requests, bank choice, etc. Currently staff uses free-text chat, which means:
- No structured record of the client's decision
- No way for the system to react automatically
- Staff has to manually interpret chat messages
- No audit trail of "client approved X on date Y"

## Solution: Client Decision Requests

A flexible, reusable system where staff (or automation) creates a structured request, the client sees it in their portal with clear response options, the system records the response, and business logic can react.

## Data Model

### New table: `client_decision_requests`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid PK | |
| service_delivery_id | uuid FK → service_deliveries | Which flow this belongs to |
| contact_id | uuid FK → contacts | Who needs to respond |
| account_id | uuid FK → accounts (nullable) | If account-scoped |
| request_type | text | 'approval', 'choice', 'text_input' |
| title | text | What the client sees as the heading |
| message | text | Explanation / instructions for the client |
| message_it | text (nullable) | Italian translation |
| options | jsonb | Depends on type — see below |
| status | text | 'pending', 'approved', 'rejected', 'responded', 'expired', 'cancelled' |
| response | jsonb (nullable) | Client's answer — see below |
| responded_at | timestamptz (nullable) | When client responded |
| responded_by | uuid (nullable) | Which portal user responded |
| expires_at | timestamptz (nullable) | Optional deadline |
| created_by | text | Staff member or 'system' |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| stage_at_creation | text | Which stage the SD was at when this was created |
| auto_advance_on | text (nullable) | If set, auto-advance SD to this stage when client approves |
| notify_on_response | boolean default true | Send notification to staff when client responds |

### Request Types & Options/Response Shapes

**1. approval (yes/no)**
```json
// options
{ "approve_label": "Yes, I approve", "reject_label": "No, I don't approve" }
// response
{ "decision": "approved" | "rejected", "note": "optional client comment" }
```

**2. choice (multiple choice)**
```json
// options
{ "choices": [
    { "key": "name_1", "label": "Automatiko LLC", "description": "Available on NM SOS" },
    { "key": "name_2", "label": "Automatico LLC", "description": "Available on NM SOS" },
    { "key": "none", "label": "None of these — I'll propose new names" }
  ],
  "allow_multiple": false
}
// response
{ "selected": "name_1", "note": "optional comment" }
```

**3. text_input (free text response)**
```json
// options
{ "prompt": "Please provide 3 alternative LLC names", "placeholder": "Enter names...", "required": true }
// response
{ "text": "NewName1 LLC, NewName2 LLC, NewName3 LLC" }
```

These three types cover every scenario. Anything more specific (an LLC name proposal, a document sign-off) is just a *configured instance* of one of them — the business context lives in `title`, `message`, and `options`, never in a new type.

## Portal Experience (Client Side)

### Where it appears
- On the client's flow detail page (`/portal/flows/[id]`) — as a highlighted card at the current stage
- On the portal dashboard — as an action item ("You have a pending request")
- Optional: push notification / email when a new request is created

### Card rendering
- Title + message (bilingual based on client language)
- Response options based on type (buttons, radio, text field)
- Submit button
- After responding: shows their answer as read-only with a timestamp
- If expired: shows "This request has expired"

### Multiple pending requests
- A flow can have multiple requests (e.g., first name rejected, second name proposed)
- Only the most recent 'pending' one is actionable
- Previous ones show as historical (collapsed, read-only)

## Staff Workspace Experience (CRM Side)

### Creating a request
On any workspace stage, a "Request Client Decision" button (or specific buttons like "Propose Name" on the formation Wizard Submitted stage).

Staff fills in:
- Type (or pre-selected based on context)
- Message to client
- Options (pre-filled for common scenarios)
- Optional: auto-advance stage on approval

### Viewing responses
- The workspace stage shows pending/responded decision requests
- Pending: "Waiting for client response" with timestamp
- Responded: shows the client's answer with timestamp
- If rejected: staff can create a new request

### Formation-specific workflow
On the "Wizard Submitted" stage:
1. Staff sees 3 name choices from wizard
2. Staff checks names on SOS (link provided)
3. Staff proposes one name → an `approval` request with the name in the message ("We checked and [Name] LLC is available in [State]. Do you approve?")
4. Or, if several names are available, staff offers them → a `choice` request with the names as options
5. Client approves (or selects one) → staff can advance to "Filed with State"
6. Client rejects → staff proposes another name (`approval`/`choice`) or sends a `text_input` request asking for new names
7. If client sends new names → they appear as new data, staff repeats the check

On the "Filed with State" stage:
- If SOS rejects the name → staff creates a new `choice` or `text_input` request for alternative names
- The loop continues until a name is accepted

## API Routes

### POST /api/portal/decisions/create
Staff creates a decision request. Requires staff auth.
Body: `{ service_delivery_id, contact_id, request_type, title, message, message_it?, options, auto_advance_on?, expires_at? }`

### GET /api/portal/decisions/[id]
Get a decision request by ID. Used by both staff and portal.

### GET /api/portal/decisions?sd_id=xxx
List all decision requests for a service delivery. Used by the workspace to show history.

### POST /api/portal/decisions/[id]/respond
Client responds. Requires portal auth. Validates the response matches the request type.
Body: `{ response }` (shape depends on request_type)

### GET /api/portal/my-decisions
Client's pending decision requests across all flows. Used by the portal dashboard action items.

## Notifications

- **On creation:** portal notification to client ("You have a new request from Tony Durante LLC"). Optional email.
- **On response:** notification to staff (What's New / Slack). If `notify_on_response = true`.
- **On expiry:** optional reminder to client before deadline.

## Auto-advance

If `auto_advance_on` is set (e.g., "Filed with State") and the client approves, the system automatically advances the SD to that stage. This is optional — not all requests should auto-advance. For names, it probably shouldn't auto-advance (staff still needs to file manually). For a simple approval gate, it could.

## Audit Trail

Every response is immutable (new request created for new questions, old responses never edited). The combination of `client_decision_requests` rows for an SD is the full decision history: who asked what, when, what the client answered.

## Flexibility Principles

- **Type-agnostic:** the system doesn't know about LLC names or tax returns — it knows about approvals, choices, and text inputs. The business context comes from the caller.
- **Workspace-agnostic:** any workspace stage can create a decision request. Not tied to formation.
- **Extensible types:** new request_type values can be added without schema changes (options/response are JSONB).
- **Bilingual:** title + message have IT variants. Response options can include labels in both languages.
- **No hardcoded flows:** the decision request doesn't know what stage it's on or what happens next. The auto_advance_on is an optional hint, not a requirement.

## First Implementation (Formation Names)

The formation workspace "Wizard Submitted" stage gets:
- A "Propose Name to Client" button that creates an `approval` request (the proposed name in the message)
- A panel showing pending/historical decision requests for this SD
- The "Filed with State" stage also shows any name decisions for context

The portal flow page gets:
- A decision request card when one is pending
- The card shows: "We checked and [Name] LLC is available in [State]. Do you approve?" with Yes/No buttons
- After responding, shows the recorded decision

## Future Consumers

Any workflow can use the three generic types — `approval`, `choice`, `text_input` — with no new schema or types; the business context lives in the request's `title`, `message`, and `options`. For example: a tax-return sign-off or an Operating Agreement review (`approval`, referencing the document in the message), a bank-provider selection (`choice`), or a request for missing information (`text_input`).
