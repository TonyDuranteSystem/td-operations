# Sistema Offerte → Contratto → Firma → Pagamento

## Panoramica
Sistema end-to-end per gestire il flusso commerciale di Tony Durante LLC:
- Cliente riceve link offerta personalizzata
- Rivede e accetta → firma contratto MSA+SOW digitalmente
- Pagamento tramite Whop (carta) o bonifico bancario

## Flusso completo

```
[Offerta] ──→ [Accetta] ──→ [Contratto] ──→ [Firma] ──→ [Pagamento]
index.html     click btn    contract.html   Sig Pad    Whop / IBAN
     ↓                          ↓               ↓
  Supabase                  Auto-fill        PDF gen
  offers                    from offer       → Storage
  table                     data             → contracts table
```

### Step 1: Offerta (`index.html`)
- URL: `offerte.tonydurante.us/?t={token}`
- Carica dati da Supabase tabella `offers` via token
- Mostra: intro EN/IT, criticità, azioni, strategia, servizi, riepilogo costi, prossimi passi
- CTA box con 2 stati:
  - **Non firmato**: bottone "✍️ Accetta e Firma Contratto" → link a `contract.html?t={token}`
  - **Firmato** (status=signed/completed): mostra bottoni pagamento in base a `payment_type`
    - `checkout`: bottoni Whop con link da `payment_links[]`
    - `bank_transfer`: box con coordinate bancarie da `bank_details{}`
    - `none`: messaggio WhatsApp
- Tracking: incrementa `view_count`, setta `viewed_at`, aggiorna status da `draft` a `viewed`

### Step 2: Contratto (`contract.html`)
- URL: `offerte.tonydurante.us/contract.html?t={token}`
- Carica stessi dati offerta da Supabase
- Auto-compila:
  - Effective Date (oggi)
  - Contract Year (anno corrente, Jan 1 - Dec 31)
  - LLC Type (da `servizi[]` cercando "llc" nel nome)
  - Annual Service Fee (da `riepilogo_costi[0].total` o `servizi[0].price`)
  - Payment Schedule (da `riepilogo_costi[0].rate` o derivato da `payment_links.length`)
  - Client Name (da `client_name`)
  - Services List (da `servizi[]`)
- Campi compilabili dal cliente:
  - Full Legal Name (pre-compilato), Email, Phone (+prefix validato), Address, City, State, ZIP (numerico), Country, Nationality, Passport, Passport Exp
- Allegato: upload passaporto (Exhibit A)
- 2 firme richieste: MSA signature + SOW signature (Signature Pad JS canvas)

### Step 3: Firma e Post-firma
Quando il cliente clicca "Sign & Submit Contract":
1. Freeze dei campi form (input → span per PDF)
2. Canvas firma → immagine PNG per PDF
3. Genera PDF con html2pdf.js (letter format, scale 2x)
4. Upload PDF su Supabase Storage `signed-contracts/{token}/contract-signed-{timestamp}.pdf`
5. Insert record nella tabella `contracts` con tutti i dati form
6. PATCH offerta status → `signed` (con 3 retry)
7. Post-firma in base a `payment_type`:
   - **checkout**: redirect a primo link Whop dopo 2.5s
   - **bank_transfer**: mostra pannello successo con coordinate bancarie sulla stessa pagina (no redirect)
   - **none**: messaggio "Tony will contact you via WhatsApp"

## Struttura dati Supabase

### Tabella `offers`
| Campo | Tipo | Note |
|-------|------|------|
| id | uuid | PK |
| token | text | UNIQUE, usato come URL param |
| client_name | text | Nome cliente |
| client_email | text | Email cliente (opz.) |
| offer_date | date | Data offerta |
| status | text | draft/sent/viewed/signed/completed/expired |
| expires_at | timestamptz | Scadenza automatica |
| payment_type | text | checkout/bank_transfer/none |
| bank_details | jsonb | {beneficiary, iban, bic, bank_name, amount, reference} |
| payment_links | jsonb | [{url, label, amount}] array di link Whop |
| effective_date | date | Data inizio contratto |
| servizi | jsonb | [{name, price, price_label, description, includes[], recommended}] |
| riepilogo_costi | jsonb | [{label, total, total_label, items[{name, price}], rate}] |
| intro_en, intro_it | text | Testi introduttivi |
| criticita | jsonb | [{title, description}] |
| azioni_immediate | jsonb | [{title, text/description}] |
| strategia | jsonb | [{step_number, title, description}] |
| prossimi_passi | jsonb | [{step_number, title, description}] |
| sviluppi_futuri | jsonb | [{text}] |
| servizi_aggiuntivi | jsonb | Come servizi, per add-on |
| costi_annuali | jsonb | [{label, price}] |
| view_count | int | Contatore visualizzazioni |
| viewed_at | timestamptz | Ultimo view |

### Tabella `contracts`
| Campo | Tipo | Note |
|-------|------|------|
| id | uuid | PK |
| offer_token | text | FK verso offers.token |
| client_name | text | |
| client_email | text | |
| client_phone | text | Validato +prefisso |
| client_address | text | |
| client_city | text | |
| client_state | text | |
| client_zip | text | Validato numerico |
| client_country | text | |
| client_nationality | text | |
| client_passport | text | |
| client_passport_exp | text | MM/YYYY |
| signed_at | timestamptz | |
| pdf_path | text | Path nel bucket Storage |
| status | text | pending/signed/completed |

### RLS Policies
- `offers`: SELECT public, UPDATE public (con with_check)
- `contracts`: SELECT public, INSERT public, UPDATE public

## Creare una nuova offerta
Per creare una nuova offerta per un cliente, inserire un record nella tabella `offers` con:
1. `token` univoco (es. `nome-cognome-2026`)
2. `client_name`
3. `offer_date`
4. `status: 'sent'`
5. `payment_type` (checkout/bank_transfer/none)
6. `servizi` array con i servizi proposti
7. `riepilogo_costi` array con totali
8. Se checkout: `payment_links` con URL Whop
9. Se bank_transfer: `bank_details` con IBAN
10. Sezioni opzionali: intro, criticita, strategia, ecc.

Il link da mandare al cliente sarà: `https://offerte.tonydurante.us/?t={token}`

## Note tecniche
- Tutto client-side, nessun backend custom
- Signature Pad JS v4.2.0 da CDN jsdelivr
- html2pdf.js v0.10.2 da CDN cloudflare
- Font: Inter + Source Serif 4 (contratto), Playfair Display + Source Sans 3 (offerta)
- Logo dal bucket Supabase `assets/tony-logos.jpg`
- Contratto è 24 sezioni legali MSA + SOW con timeline, payment schedule, exclusions
- Indirizzo: 10225 Ulmerton Road, Suite 3D, Largo, FL 33771
