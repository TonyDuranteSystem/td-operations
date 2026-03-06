# Storage Migration Report — Aggiornato 2026-03-03

## Situazione attuale: 3 fonti di documenti

### 1. Zoho WorkDrive (FONTE STORICA)
- Usato per ANNI come fonte ufficiale
- Contiene i documenti con i nomi ORIGINALI
- Accesso API: RICHIEDE NUOVO OAuth flow (scope WorkDrive.files.READ, WorkDrive.workspace.READ)
- Account: support@tonydurante.us

### 2. Box (PERIODO INTERMEDIO)
- Box root TD Clients: 366841283277
- MCP API: ATTIVO e funzionante
- Contiene file migrati da GDrive (via box_migration.py con AI rename — MOLTI NOMI SBAGLIATI)
- Contiene anche file caricati direttamente (clienti nuovi)
- box_migration.py ha salvato nel campo description il path originale GDrive: "Migrated from Google Drive: [path]"
- Script file: /Users/tonydurante/Library/CloudStorage/Box-Box/box_migration.py

### 3. Google Drive (DESTINAZIONE FINALE)
- Shared Drive "Tony Durante LLC" (account support@tonydurante.us)
- GDrive TD Clients: 1mbz_bUDwC4K259RcC-tDKihjlvdAVXno
- API: FUNZIONANTE — Service Account con Domain-Wide Delegation, scope Drive completo
- JSON Key: /Users/tonydurante/Desktop/td-operations/[STORED LOCALLY]
- Impersonate user: support@tonydurante.us

## Inventari completati

### GDrive (inventario completo via API — 2026-03-03)
- File: gdrive-inventory.json
- 9,941 entries (2,584 folders + 7,357 files)
- 6,290.6 MB totali
- 312 client in Companies/ (4 stati)
- 297 file non-Companies
- Tutti i file con MD5 checksum

### Box (inventario client-level + campionamento file)
- File: client-comparison-report.json
- 311 client in Companies/ (4 stati: DE 21, FL 39, NM 14, WY 237)
- Struttura standard: 5 subfolder (1. Company, 2. Contacts, 3. Tax, 4. Banking, 5. Correspondence)
- File-level completo solo per campione (Delaware "1. Company", B&P tutti)
- Inventario file-level completo impraticabile via MCP (>1500 chiamate)

## Cross-Matching Results (2026-03-03)

### Client-Level Match: 308/311 Box client matchati su GDrive (99%)
| Stato | Box | GDrive | Exact Match | Fuzzy Match | Box-Only | GD-Only |
|-------|-----|--------|-------------|-------------|----------|---------|
| Delaware | 21 | 21 | 15 | 6 | 0 | 0 |
| Florida | 39 | 39 | 21 | 18 | 0 | 0 |
| New Mexico | 14 | 15 | 12 | 1 | 1 | 2 |
| Wyoming | 237 | 235 | 172 | 63 | 2 | 0 |
| **TOTALE** | **311** | **310** | **220** | **88** | **3** | **2** |

### 3 Client Box-Only (da migrare)
1. **Datavora LLC** (NM) — 9 file (Articles, passaporti, offerta, ricevute) — folder 367966825739
2. **PTBT Holding LLC** (WY) — 10 file (Articles, SS4, passaporti, offerta) — folder 368815053274
3. **PlayLover International LLC** (WY) — 1 file (PDF) — folder 369045472291

### 2 Client GDrive-Only (già su GDrive, non su Box)
1. Mark Eke - New Company (NM) — probabilmente = PTBT Holding (Mark Eke)
2. Massimo Grilletta (NM) — probabilmente = Datavora LLC (Massimo Grilletta & Andrea Maravalle)

### 88 Name Mismatches (fuzzy matched)
Pattern: Box usa parentesi "(Owner Name)", GDrive usa trattino "- Owner Name"
Tutti con similarity 1.0 dopo normalizzazione — match affidabili.

## File Migration Pattern (analisi da campione B&P)
La migrazione precedente (Claude AI) ha:
- Rinominato file: parentesi→trattini, "Unclassified"→tipo specifico
- Riclassificato: file da "5. Correspondence" spostati in cartelle appropriate
- Nessun file perso (67 Box = 67 GDrive per B&P)
- Ma struttura completamente riorganizzata

## GDrive Structure Analysis
| Subfolder | Files | Size MB | Clients |
|-----------|-------|---------|---------|
| 1. Company | 2,970 | 2,006 | 304 |
| 2. Contacts | 1,261 | 1,891 | 271 |
| 3. Tax | 1,009 | 317 | 177 |
| 4. Banking | 318 | 582 | 87 |
| 5. Correspondence | 1,499 | 1,278 | 281 |

- 60 client con struttura completa 5-folder
- 242 client con struttura incompleta (normale: molti hanno pochi file)
- Top client per file: Diendei (275), Beril (254), Degasper (173)

## Folder IDs Reference

### Box
- Root: 366841283277
- Companies: 366841379731
- Delaware: 366864983612
- Florida: 366863166682
- New Mexico: 366865350874
- Wyoming: 366864646819
- Leads: 366840935896
- Partner CMRA: 366840488981
- Templates: 367172663450
- _TEMPLATE: 366865031740
- India Team: 367950606204

### Google Drive
- TD Clients: 1mbz_bUDwC4K259RcC-tDKihjlvdAVXno
- Companies: 1Z32I4pDzX4enwqJQzolbFw7fK94ISuCb
- Wyoming: 110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x
- Delaware: 1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-
- Florida: 1XToxqPl-t6z10raeal_frSpvBBBRY8nG
- New Mexico: 1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4
- _Review Loose Files: 1UoDpmpB9iUmKMXD6JzoXzmrfYkALZvK4

## Audit Qualità File — COMPLETATO 2026-03-04

### ⚠️ ISTRUZIONI PER PROSSIMA SESSIONE
Quando Antonio chiede "audit report" o "mostrami risultati audit":
1. **LEGGI QUESTO FILE:** `/Users/tonydurante/Desktop/td-operations/gdrive-audit-summary.md`
2. **Report JSON completo:** `/Users/tonydurante/Desktop/td-operations/gdrive-audit-report.json`
3. **Log esecuzione:** `/Users/tonydurante/Desktop/td-operations/gdrive-audit.log`
4. **Script usato:** `/Users/tonydurante/Desktop/td-operations/gdrive-content-audit.py`

### Risultati Run V2 (con pattern migliorati)
- Script: gdrive-content-audit.py — scarica PDF da GDrive, estrae testo con PyPDF2, confronta con nome
- 6.598 file processati, 0 errori
- I risultati V1 avevano troppi falsi positivi (EIN Letter matchava dentro ogni form fiscale)
- V2 ha pattern migliorati: Form 5472, W-7, 1040-NR, 1120 aggiunti; EIN Letter reso più specifico; sinonimi Office Lease=Rent Agreement

### Contesto importante
- I file su GDrive sono stati rinominati da una sessione Claude precedente (box_migration.py su Box)
- Alcuni errori di naming esistono GIÀ SU BOX — non introdotti dalla migrazione
- ~34% dei file sono scan/immagini senza testo estraibile (servrebbe OCR)
- I client con più errori sono quelli con più file: Diendei, Beril, Lucky Pama, Degasper

## Correzioni GDrive eseguite (2026-03-03)
1. ✅ Rinominato "Massimo Grilletta" → "Datavora LLC - Massimo Grilletta & Andrea Maravalle" (NM) — folder 1twklnWpsm26BbFBOF7fmR5yYgGI4XSIS
2. ✅ Spostato "Mark Eke - New Company" da NM → WY + rinominato "PTBT Holding LLC - Mark Eke" — folder 1WusLK-gLsFSMu4hEI1JCH6BRN2HVRNhq
3. ✅ Creato "PlayLover International LLC - Christian Poza" in WY — folder 1DcawDSNE8yM1dRjRX3ELWUhhu6Whx_SW (con 5 subfolder standard)

## Piano di azione (aggiornato)
1. ~~Abilitare Google Drive API scope~~ ✅ FATTO
2. ~~JSON key Service Account~~ ✅ FATTO
3. ~~Inventario GDrive completo~~ ✅ FATTO (7,357 file)
4. ~~Client-level comparison Box vs GDrive~~ ✅ FATTO (308/311 match)
5. ~~Correzioni cartelle GDrive~~ ✅ FATTO (Datavora, PTBT, PlayLover)
6. **NEXT: Script Python audit contenuto file GDrive** ← IN CORSO
7. Migrare 3 client Box-only (20 file) → serve Box access token
8. Creare 4 Lead vuoti + 2 Partner CMRA su GDrive
9. Zoho WorkDrive: nuovo OAuth flow (fase 2, bassa priorità)
10. Aggiornamento link Airtable/Supabase

## Script creati
- `/Users/tonydurante/Desktop/td-operations/gdrive-inventory.py` — inventario GDrive via API
- `/Users/tonydurante/Desktop/td-operations/gdrive-inventory.json` — risultato inventario
- `/Users/tonydurante/Desktop/td-operations/client-comparison.py` — confronto client-level Box vs GDrive
- `/Users/tonydurante/Desktop/td-operations/client-comparison-report.json` — risultato confronto
- `/Users/tonydurante/Desktop/td-operations/migration-analysis.py` — analisi migrazione completa
- `/Users/tonydurante/Desktop/td-operations/migration-status-report.json` — report stato migrazione
- `/Users/tonydurante/Desktop/td-operations/cross-match.py` — cross-match file-level (richiede inventario Box completo)
