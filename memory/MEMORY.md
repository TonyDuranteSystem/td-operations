# TD Operations — Memoria Persistente

## 🔴 TASK IN CORSO — Leggere prima di tutto
Se Antonio chiede "audit report", "risultati audit", "mostrami il report", "come è andato lo script":
1. LEGGI il file `/Users/tonydurante/Desktop/td-operations/gdrive-audit-summary.md` — è il report leggibile
2. Se serve dettaglio, il JSON completo è in `/Users/tonydurante/Desktop/td-operations/gdrive-audit-report.json`
3. Lo script è `/Users/tonydurante/Desktop/td-operations/gdrive-content-audit.py`
4. Il log è `/Users/tonydurante/Desktop/td-operations/gdrive-audit.log`
5. Per contesto completo sulla migrazione, leggi [storage-migration.md](storage-migration.md)

## Link a file dettagliati
- [Storage Migration Report](storage-migration.md) — Stato completo migrazione Box/GDrive/Zoho + audit qualità
- [API Access Status](api-access-status.md) — Stato credenziali e accessi API
- [Offer-Contract System](offer-contract-system.md) — Documentazione completa del sistema offerte→contratto→firma→pagamento

## Fatti chiave
- Supabase project attivo: ydzipybqeebtpcvsbtvs (td-crm)
- Supabase OLD (dlwzcxrdkxkwjblgfxtj) è PAUSATO — da eliminare
- Airtable base: apppWyKkOSZXQE6s8
- HubSpot Hub: 245272631 (trial scade 6 marzo 2026)
- Google Service Account: claude-gmail@claude-gmail-connector-488713.iam.gserviceaccount.com
- Box root TD Clients: 366841283277
- GDrive TD Clients: 1mbz_bUDwC4K259RcC-tDKihjlvdAVXno
- GDrive Shared Drive: "Tony Durante LLC" (account support@tonydurante.us)
- Google SA Key: `[STORED LOCALLY — see local MEMORY.md]`

## 🟢 COMPLETATO — Flusso Offerta→Contratto→Firma→Pagamento
**Stato**: Live su Vercel, testato end-to-end
**Ultimo deploy**: 6 marzo 2026
**Documentazione dettagliata**: Vedi [offer-contract-system.md](offer-contract-system.md)

### Architettura rapida
1. Cliente riceve `offerte.tonydurante.us/?t={token}` → vede offerta
2. Clicca "✍️ Accetta e Firma Contratto" → apre `contract.html?t={token}`
3. Contratto MSA+SOW auto-compilato (fee, rate, servizi, nome cliente)
4. Cliente compila campi (indirizzo, telefono con validazione +prefisso, ZIP numerico, passaporto)
5. Firma digitale con Signature Pad JS v4.2.0 (2 firme: MSA + SOW)
6. PDF generato con html2pdf.js → upload su Supabase Storage (`signed-contracts` bucket)
7. Record salvato nella tabella `contracts` + status offerta aggiornato a `signed`
8. Post-firma: checkout → redirect Whop | bonifico → mostra IBAN sulla stessa pagina | none → messaggio WhatsApp

### File sorgente
- **Offerta**: `/Users/tonydurante/Desktop/TD Operations/td-offers/index.html`
- **Contratto (signing)**: `/Users/tonydurante/Desktop/TD Operations/td-offers/contract.html`
- **Contratto (template read-only)**: `/Users/tonydurante/Desktop/TD Operations/td-offers/contract-v2.html`
- **Template originale**: Zoho WorkDrive → Tony-Luca → Templates → Tony_Durante_MSA_SOW_BRANDED_correct.docx
- **Template HTML su GDrive**: folder `1c_DxnWuiZprGOMFiIUMHVnLR7q5eM-IR`

### URL live
- Offerta: `https://offerte.tonydurante.us/?t={token}`
- Contratto: `https://offerte.tonydurante.us/contract.html?t={token}`
- Template: `https://offerte.tonydurante.us/contract-v2.html`

### Deploy
- **Vercel Project**: prj_uF6p5dhRAGOQYWys671Vp6ZOoXGf
- **Vercel Token**: `[STORED LOCALLY — see local MEMORY.md]`
- **Deploy**: auto via GitHub push (repo collegato a Vercel)

### Supabase
- **Project ID**: ydzipybqeebtpcvsbtvs
- **Anon Key**: `[STORED LOCALLY — see local MEMORY.md]`
- **Tabella `offers`**: token, client_name, offer_date, status (draft/sent/viewed/signed/completed/expired), expires_at, payment_type (checkout/bank_transfer/none), bank_details (JSON), payment_links (JSON array), servizi, riepilogo_costi, intro_en, intro_it, criticita, azioni_immediate, strategia, prossimi_passi, sviluppi_futuri, servizi_aggiuntivi, costi_annuali, view_count, viewed_at, effective_date
- **Tabella `contracts`**: offer_token FK, client_name, client_email, client_phone, client_address, client_city, client_state, client_zip, client_country, client_nationality, client_passport, client_passport_exp, signed_at, pdf_path, status (pending/signed/completed)
- **Tabella `whop_events`**: webhook events da Whop
- **Storage `signed-contracts`**: bucket privato, path: `{token}/contract-signed-{timestamp}.pdf`
- **Storage `assets`**: bucket pubblico, logo: `tony-logos.jpg`
- **Logo URL**: `https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/tony-logos.jpg`

### Whop (pagamenti)
- **API Key**: `[STORED LOCALLY — see local MEMORY.md]`
- **Company ID**: biz_rssyD9YyMnXd7P
- **Product**: prod_nzrLiGLomSYZT (LLC Formation)
- **Piano 1/2 €1250**: plan_bvOJCKYMMjok8
- **Piano 2/2 €1250**: plan_mR9Z6sIvIJSFi
- **Piano temp $1000** (da eliminare): plan_TxwBsi3n7QJO5
- **⚠️ In attesa**: verifica business Whop per piano unico €2.500

### Offerte di test in Supabase
- `test-demo-2026` — Marco Bianchi, checkout mode (2×€1.250 Whop)
- `test-bonifico-2026` — Luca Rossi, bank transfer mode (IBAN Mercury)
- `alex-vitucci-2026` — Alex Vitucci, WhatsApp only mode
- `james-drury-2026` — James Drury, checkout mode (2×€1.250)

### Clausole contratto (confermate da Antonio)
- Orari: Lun-Ven 8:00-15:00 ET, festivi USA esclusi
- Comunicazioni: Email, WhatsApp, Telegram. Risposta entro 2 gg lavorativi. Call solo se necessario, $197/call
- Late Payment: 1.5%/mese + sospensione servizi dopo 30 giorni
- Refund: NO REFUND in nessun caso
- Firma digitale: clausola ESIGN/UETA
- Arbitrato: Pinellas County FL, AAA rules
- Contract Year: sempre 01/01-12/31, rinnovo automatico ogni 01/01
- Data Protection: GDPR per clienti UE
- Notices: email + indirizzo fisico. WhatsApp/Telegram NON validi per notifiche legali
- SOW: timeline stimata LLC + clausola no-garanzia tempi (dipende da enti gov)

### Validazioni form contratto
- **Telefono**: deve iniziare con `+` prefisso internazionale (regex: `/^\+\d[\d\s\-()]{6,20}$/`)
- **ZIP Code**: solo numeri, 3-10 cifre (regex: `/^\d{3,10}$/`)
- Feedback visivo: cella rossa + hint text se formato sbagliato

### Stack tecnico
- Signature Pad JS v4.2.0 (CDN) — firma digitale canvas
- html2pdf.js v0.10.2 (CDN) — generazione PDF client-side
- Supabase REST API — database + storage
- Vercel — hosting statico
- Whop — pagamenti (checkout links)
- Nessun servizio esterno per firme (no DocuSign, no HelloSign)

### Indirizzo aziendale
**10225 Ulmerton Road, Suite 3D, Largo, FL 33771** (usato nel contratto in 3 punti + footer)

## Preferenze Antonio
- Comunica in italiano, diretto e efficiente
- Non vuole automazione esterna (no Make/Zapier/n8n)
- Vuole Google Drive come storage definitivo
- Zoho WorkDrive era la fonte storica ufficiale per anni
- Box usato per periodo intermedio + clienti nuovi
- **Supabase è la fonte primaria per cercare dati CRM** — cercare SEMPRE prima lì, poi Airtable/HubSpot/email

## TODO / Prossimi passi
- [ ] Whop: dopo verifica business → creare piano unico €2.500 + eliminare piano temp $1000
- [ ] Test end-to-end completo firma + PDF + storage (parzialmente fatto, da completare)
- [ ] Supabase OLD (dlwzcxrdkxkwjblgfxtj) — da eliminare
