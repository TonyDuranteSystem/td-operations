# Tony Durante LLC — Claude Code Context
## Last Updated: 2026-03-08

## Who You Are
You are working for Antonio Durante, owner of Tony Durante LLC — a Wyoming-based consulting firm helping international entrepreneurs (primarily European/Italian) set up and manage LLCs in the United States.

## 🚀 CLOUD MEMORY — Read at Session Start
Complete project memory is stored in Google Drive. At session start, use the Remote MCP `drive_search` tool to find and read it:
1. `drive_search("Claude Memory")` → find the folder in Shared Drive → TD Operations → Claude Memory
2. Read all 7 files (MEMORY.md first, then credentials.md, infrastructure.md, codebase.md, milestones.md)
3. These files contain ALL credentials, architecture, tools, decisions, and roadmap

**Shared Drive folder**: TD Operations / Claude Memory (ID: `1IKz0ZoDAQDOUL57jxrwP7EQhVXwMJxws`)
**Backup**: support@tonydurante.us My Drive / Claude Memory (ID: `1Np2moTTIRx4nDoyAiJIrJcuXSv-yX9IF`)

## Key Documents (Read Before Any Task)
All operational documents are stored in **Google Drive** (Shared Drive: Tony Durante LLC) and locally in `~/Desktop/td-operations/`.

1. **Cloud Memory (Google Drive)** — 7 files with complete project state, credentials, architecture. READ AT SESSION START.
2. **CRM-Data-Schema.md** — All tables, fields, enums, relationships, migration rules. READ THIS FIRST for any database work.
3. **SOP-Business-Rules.md** — How the business operates. Rules for payments, services, escalations, SLAs.
4. **Technical-Roadmap.md** — Infrastructure projects, deployment procedures, automations, API details.
5. **platform-credentials.md** — All API keys, tokens, login credentials. NEVER commit to git.

## System Architecture

### Primary Data Source — Supabase (td-crm)
- **Project ID:** `ydzipybqeebtpcvsbtvs`
- **API URL:** `https://ydzipybqeebtpcvsbtvs.supabase.co`
- **REST API:** `https://ydzipybqeebtpcvsbtvs.supabase.co/rest/v1`
- **Region:** US East (North Virginia)
- **Organization:** Tony Durante LLC (org ID: `czdbhugdtuygnbsbumsv`)
- **Status:** PRODUCTION — 32 tables, 308+ accounts, 608+ payments, 1800+ services
- **Access:** REST API with Service Role Key (see supabase.md for keys and patterns)

⚠ **IMPORTANT — Two Supabase Projects Exist:**
| Project ID | Status | Notes |
|---|---|---|
| `ydzipybqeebtpcvsbtvs` | **PRODUCTION** — USE THIS | Org: `czdbhugdtuygnbsbumsv`. All real data. |
| `dlwzcxrdkxkwjblgfxtj` | **OLD/DEPRECATED** — DO NOT USE | Org: `gfolalkmhqsjmuxxxzun`. Stale data. Will be deleted. |

### Cloud Storage — Google Drive
- **Shared Drive:** Tony Durante LLC (ID: `0AOLZHXSfKUMHUk9PVA`)
- **TD Operations Folder:** `1EdxwvqFTlmMbO9lVRwlV9tKklqbXcMy0`
- **References Folder:** `1z1FrM170XG7dWyf8IwpqK4z1mujYY6-i`
- **Access:** Service Account with Domain-Wide Delegation (see google-drive.md)

### QuickBooks Online — ✅ OPERATIONAL (Invoicing & Payments)
- **Company:** Tony Durante LLC (Realm: `13845050572680403`)
- **Status:** Production, OAuth2 tokens in Supabase `qb_tokens` table, auto-refresh on demand
- **API Base:** `https://quickbooks.api.intuit.com/v3/company/13845050572680403`
- **API Routes (live):**
  - `POST /api/qb/create-invoice` → creates QB invoice, links to CRM
  - `GET /api/qb/invoice-pdf?invoice_id=X` → branded PDF from QB invoice
  - `POST /api/qb/invoice-pdf` → branded PDF from custom JSON
  - `GET /api/qb/status` → health check
- **Invoice PDF:** Full TD logo, US flag colors, certifications. Uses pdf-lib (pure JS).
- **Phone on invoices:** +1 (727) 452-1093

### Other Platforms
- **Airtable** — Base ID: `apppWyKkOSZXQE6s8` — Backup/safety net. 17 tables. DO NOT DELETE.
- **HubSpot** — Hub ID: `245272631` — CRM mirror for pipelines and reporting.
- **Vercel** — td-offers (`offerte.tonydurante.us`) + td-operations (dashboard).

## MCP Connectors

### Remote MCP — td-hub (configured in `.mcp.json`)
- **Endpoint**: `https://td-operations.vercel.app/api/mcp`
- **Auth**: `Authorization: Bearer ${TD_MCP_API_KEY}`
- **30 tools**: CRM (7) + QB (6) + Email (5) + Drive (7) + Gmail (5)
- All credentials in Cloud Memory → credentials.md

### Local MCP — Supabase (configured in `.mcp.json`)
- **supabase** — Local MCP server via `npx @supabase/mcp-server-supabase@0.7.0`. Connects directly to production project `ydzipybqeebtpcvsbtvs`. Used for SQL/DDL only.

### Marketplace MCP (complementari)
- **Fireflies** — Meeting AI transcripts (specializzato, tenere)
- **Circleback** — Meeting notes (specializzato, tenere)
- **Airtable** — Backup reference only (congelato)
- ~~Box~~ — IN DISMISSIONE, da rimuovere
- ~~Gmail marketplace~~ — Sostituito da gmail_* nel Remote MCP
- ~~HubSpot~~ — Trial scaduto 2026-03-06

## Critical Rules
1. **Supabase is the SOT** — Project `ydzipybqeebtpcvsbtvs` is the single source of truth for all CRM data.
2. **Airtable is backup** — Never delete data from Airtable. It stays as safety net.
3. **Google Drive is definitive storage** — All documents, client folders, SOPs live on the Shared Drive.
4. **No external automation tools** — No Make, Zapier, n8n. Build with Supabase Edge Functions.
5. **All enum values are defined in CRM-Data-Schema.md** — Use only canonical values.
6. **airtable_id field** — Always save the Airtable record ID (recXXX) when migrating data.
7. **Foreign key resolution** — When migrating linked records from Airtable, look up the target record's airtable_id in Supabase to get the UUID.
8. **Log everything** — Migration errors go to `airtable_migration_log` table.
9. **Credentials are in platform-credentials.md** — Read from file, never hardcode in committed code.
10. **Write Buffer** — All Supabase writes MUST go through the `write_buffer` table pattern (see supabase.md).

## Common Tasks
- **Database queries:** Use Supabase REST API with Service Role Key. See supabase.md for patterns.
- **Migration:** Read CRM-Data-Schema.md Section 7 for order and Section 2 for enum mappings.
- **Schema changes:** Read CRM-Data-Schema.md Section 8 for pending corrections.
- **Offer creation:** Read Technical-Roadmap.md Section 7 for API details.
- **Deployment:** Read Technical-Roadmap.md Section 7 for Vercel deployment steps.
- **File operations:** Use Google Drive API via service account. See google-drive.md for patterns.

## Startup Health Check (MANDATORY — Run at every session start)
At the beginning of EVERY new session, before doing anything else, run these checks silently and report a summary to Antonio:

### 1. MCP Connector Check
- Call `mcp__supabase__list_tables` — if it fails, the connector is broken
- Verify accounts table exists and has >300 rows (production data)

### 2. PAT Validity Check
- Run: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer sbp_27a65ff5665e524b1dad50ecd0ba0e1b8c019a23" "https://api.supabase.com/v1/projects"`
- If HTTP 200 → PAT valid. If 401/403 → PAT expired, alert Antonio immediately.

### 3. MCP Package Version Check
- Run: `npm view @supabase/mcp-server-supabase version`
- Compare with version in `.mcp.json` (currently `0.7.0`)
- If newer version exists, note it but do NOT auto-update

### 4. Node.js Check
- Run: `node --version`
- If fails → Node.js not installed. Show this message:
  ```
  ❌ Node.js non è installato su questa macchina.
  Il connettore Supabase MCP richiede Node.js per funzionare.
  Scaricalo da: https://nodejs.org/en/download
  Installa la versione LTS, poi riavvia Claude Code.
  ```

## New Machine Setup
When opening Claude Code from this folder on a NEW machine for the first time:
1. **Node.js** — Must be installed. Download LTS from https://nodejs.org/en/download
2. **`.mcp.json`** — Already in the folder, works automatically. No action needed.
3. **`CLAUDE.md`** — Already in the folder, read automatically. No action needed.
4. **Marketplace connectors** (Gmail, HubSpot, Fireflies, Circleback) — Must be added manually from Claude Code connector settings on each machine. They are account-based, not folder-based.
5. **Airtable connector** — Currently marketplace, planned migration to local `.mcp.json` (same pattern as Supabase).

### Report Format
```
🔧 Health Check [YYYY-MM-DD]
• MCP Connector: ✅ OK (X tables, Y accounts)
• PAT Supabase: ✅ Valid
• MCP Package: ✅ v0.7.0 (latest: v0.X.X)
• Node.js: ✅ vXX.XX.X
```
If any check fails, show ❌ and explain what Antonio needs to do.

## Communication
Antonio communicates in Italian and English. Match his language. Be direct and efficient — he knows the business.
