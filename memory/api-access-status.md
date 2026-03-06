# API Access Status — 2026-03-03

## Google Cloud (Project: claude-gmail-connector-488713)
- Service Account: claude-gmail@claude-gmail-connector-488713.iam.gserviceaccount.com
- Client ID: 111457141676575055340
- JSON Key: `[STORED LOCALLY — see local MEMORY.md for path]`
- Env Variable: TD_GMAIL_SERVICE_ACCOUNT_KEY → path to JSON key file
- Domain-Wide Delegation: Configurato
- API abilitate: Gmail API, Document AI API, Google Drive API
- Scope DWD: gmail.readonly, gmail.compose, gmail.modify, drive.readonly, spreadsheets.readonly, drive.file, drive
- Impersonate user per Drive: support@tonydurante.us
- Shared Drive: Tony Durante LLC (ID: 0AOLZHXSfKUMHUk9PVA)
- Document AI Processor: td-document-ocr (ID: 1c600f9361e28081, region: us)
- STATO: FUNZIONANTE — testato accesso Drive API con successo

### Domain-Wide Delegation — altri client configurati
- Data Migration (New): Client ID 117407010089399624546
- (unnamed): Client ID 112835070617082642707
- (unnamed): Client ID 106825700886255596882
- Box Migration: Client ID 102250989053252455858
- Google Workspace Data Migration Service: Client ID 955661971872-ie97v...

## Zoho (Legacy CRM + WorkDrive)
- Client ID: 1000.M1V6OTPQA4SCXADEXCQBCAQ3RDF4JU
- Client Secret: `[STORED LOCALLY]`
- Refresh Token: `[STORED LOCALLY]`
- WorkDrive API: Token refresha OK ma scope SBAGLIATI (solo ZohoCRM + ZohoBooks, no WorkDrive)
- Scopes necessari: WorkDrive.files.READ, WorkDrive.workspace.READ
- STATO: RICHIEDE nuovo OAuth flow per WorkDrive

## Box
- MCP: ATTIVO e funzionante (nessuna configurazione necessaria)
- Root folder: 366841283277
- STATO: FUNZIONANTE

## Airtable
- MCP: ATTIVO
- Base: apppWyKkOSZXQE6s8
- PAT: `[STORED LOCALLY]`
- STATO: FUNZIONANTE

## Supabase
- MCP: ATTIVO
- Project: ydzipybqeebtpcvsbtvs
- STATO: FUNZIONANTE
