/**
 * Welcome Package MCP Tool
 *
 * Orchestrates Stage 3.11 of the Formation workflow:
 * Creates all missing pieces (OA, Lease, Relay form, Payset form),
 * finds EIN letter + Articles on Drive, and generates the
 * welcome email from template dac9ce5f — ready for review before sending.
 *
 * Does NOT send the email. Returns the full email body for Antonio to review.
 * After confirmation, use gmail_send to send it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { logAction } from "@/lib/mcp/action-log"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"
import { APP_BASE_URL } from "@/lib/config"

const BASE_URL = APP_BASE_URL

export function registerWelcomePackageTools(server: McpServer) {
  server.tool(
    "welcome_package_prepare",
    `Prepare the complete welcome package for a client who just received their EIN (Stage 3.11 of Formation workflow).

Creates all missing pieces in one call:
- Operating Agreement (if not exists) — draft, needs admin preview
- Lease Agreement (if not exists) — needs suite_number
- Relay banking form (if not exists) — USD business account
- Payset banking form (if not exists) — EUR IBAN

Also finds the EIN letter and Articles of Organization on Google Drive.

Returns the full welcome email (template dac9ce5f, IT+EN bilingual) with all links filled in, ready for Antonio to review.

DOES NOT SEND THE EMAIL. After Antonio reviews, use gmail_send to send it with the EIN letter and Articles as attachments.

Prerequisites:
- Account must exist with EIN, formation_date, Drive folder
- Account must have a linked contact
- Lease requires suite_number (auto-assigns next available if not provided)`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      suite_number: z.string().optional().describe("Suite number for lease (e.g. '3D-107'). Auto-assigns next available if omitted."),
    },
    async ({ account_id, suite_number }) => {
      try {
        const steps: { step: string; status: "created" | "existing" | "skipped" | "error"; detail: string }[] = []

        // ─── 1. FETCH ACCOUNT ───
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, state_of_formation, formation_date, physical_address, registered_agent_address, registered_agent_provider, drive_folder_id")
          .eq("id", account_id)
          .single()

        if (accErr || !account) {
          return { content: [{ type: "text" as const, text: `❌ Account not found: ${accErr?.message || "no data"}` }] }
        }

        if (!account.ein_number) {
          return { content: [{ type: "text" as const, text: `❌ Account "${account.company_name}" has no EIN. EIN must be set before sending welcome package.` }] }
        }

        // ─── 2. FETCH PRIMARY CONTACT ───
        const { data: contactLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", account_id)
          .limit(1)

        if (!contactLinks?.length) {
          return { content: [{ type: "text" as const, text: `❌ No contacts linked to account "${account.company_name}".` }] }
        }

        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, first_name, last_name, email, phone, citizenship, residency, language")
          .eq("id", contactLinks[0].contact_id)
          .single()

        if (!contact) {
          return { content: [{ type: "text" as const, text: `❌ Contact not found.` }] }
        }

        const lang = contact.language === "Italian" || contact.language === "it" ? "it" : "en"
        const clientName = contact.first_name || contact.full_name
        const year = new Date().getFullYear()
        const today = new Date().toISOString().slice(0, 10)
        const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

        // ─── 3. OPERATING AGREEMENT ───
        let oaUrl = ""
        let oaAdminUrl = ""
        const { data: existingOa } = await supabaseAdmin
          .from("oa_agreements")
          .select("id, token, access_code, status")
          .eq("account_id", account_id)
          .limit(1)

        if (existingOa?.length) {
          oaUrl = `${BASE_URL}/operating-agreement/${existingOa[0].token}/${existingOa[0].access_code}`
          oaAdminUrl = `${BASE_URL}/operating-agreement/${existingOa[0].token}/${existingOa[0].access_code}?preview=td`
          steps.push({ step: "OA", status: "existing", detail: `${existingOa[0].token} (${existingOa[0].status})` })
        } else {
          const STATE_MAP: Record<string, string> = { "NEW MEXICO": "NM", "NM": "NM", "WYOMING": "WY", "WY": "WY", "FLORIDA": "FL", "FL": "FL", "DELAWARE": "DE", "DE": "DE" }
          const rawState = (account.state_of_formation || "").toUpperCase().trim()
          const state = STATE_MAP[rawState] || rawState
          if (!OA_SUPPORTED_STATES.includes(state as typeof OA_SUPPORTED_STATES[number])) {
            steps.push({ step: "OA", status: "skipped", detail: `State "${state}" not supported (${OA_SUPPORTED_STATES.join(", ")})` })
          } else {
            const oaToken = `${companySlug}-oa-${year}`

            // Determine entity type: check if account has multiple contacts
            const { data: allContacts } = await supabaseAdmin
              .from("account_contacts")
              .select("contact_id")
              .eq("account_id", account_id)

            const isMMLC = (allContacts?.length || 1) > 1
            const entityType = isMMLC ? "MMLLC" : "SMLLC"

            // Build members array for MMLLC
            let membersJson: Record<string, unknown>[] | null = null
            if (isMMLC && allContacts) {
              const { data: memberContacts } = await supabaseAdmin
                .from("contacts")
                .select("full_name, email")
                .in("id", allContacts.map(c => c.contact_id))

              if (memberContacts && memberContacts.length > 1) {
                const pct = Math.floor(100 / memberContacts.length)
                const remainder = 100 - pct * memberContacts.length
                membersJson = memberContacts.map((mc, i) => ({
                  name: mc.full_name,
                  email: mc.email || null,
                  ownership_pct: pct + (i === 0 ? remainder : 0),
                  initial_contribution: "$0 (No initial capital contribution required)",
                }))
              }
            }

            const { data: oa, error: oaErr } = await supabaseAdmin
              .from("oa_agreements")
              .insert({
                token: oaToken,
                account_id,
                contact_id: contact.id,
                company_name: account.company_name,
                state_of_formation: state,
                formation_date: account.formation_date || today,
                ein_number: account.ein_number,
                entity_type: entityType,
                manager_name: contact.full_name,
                member_name: contact.full_name,
                member_address: account.physical_address || null,
                member_email: contact.email || null,
                members: membersJson,
                effective_date: account.formation_date || today,
                business_purpose: "any and all lawful business activities",
                initial_contribution: "$0 (No initial capital contribution required)",
                fiscal_year_end: "December 31",
                accounting_method: "Cash",
                duration: "Perpetual",
                registered_agent_name: account.registered_agent_provider || null,
                registered_agent_address: account.registered_agent_address || null,
                principal_address: account.physical_address || "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
                language: "en",
                status: "draft",
              })
              .select("id, token, access_code")
              .single()

            if (oaErr || !oa) {
              steps.push({ step: "OA", status: "error", detail: oaErr?.message || "insert failed" })
            } else {
              oaUrl = `${BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}`
              oaAdminUrl = `${BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?preview=td`
              steps.push({ step: "OA", status: "created", detail: oa.token })
            }
          }
        }

        // ─── 4. LEASE AGREEMENT ───
        let leaseUrl = ""
        let leaseAdminUrl = ""
        const { data: existingLease } = await supabaseAdmin
          .from("lease_agreements")
          .select("id, token, access_code, status, suite_number")
          .eq("account_id", account_id)
          .order("created_at", { ascending: false })
          .limit(1)

        if (existingLease?.length) {
          leaseUrl = `${BASE_URL}/lease/${existingLease[0].token}/${existingLease[0].access_code}`
          leaseAdminUrl = `${BASE_URL}/lease/${existingLease[0].token}/${existingLease[0].access_code}?preview=td`
          steps.push({ step: "Lease", status: "existing", detail: `${existingLease[0].token} (suite ${existingLease[0].suite_number}, ${existingLease[0].status})` })
        } else {
          // Auto-assign suite if not provided
          let assignedSuite = suite_number
          if (!assignedSuite) {
            const { data: leases } = await supabaseAdmin
              .from("lease_agreements")
              .select("suite_number")
              .order("suite_number", { ascending: false })
              .limit(1)
            if (leases?.length) {
              const lastNum = parseInt(leases[0].suite_number.replace("3D-", ""), 10)
              assignedSuite = `3D-${(lastNum + 1).toString().padStart(3, "0")}`
            } else {
              assignedSuite = "3D-101"
            }
          }

          const leaseToken = `${companySlug}-${year}`
          const termEnd = `${year}-12-31`
          const { data: lease, error: leaseErr } = await supabaseAdmin
            .from("lease_agreements")
            .insert({
              token: leaseToken,
              account_id,
              contact_id: contact.id,
              tenant_company: account.company_name,
              tenant_contact_name: contact.full_name,
              tenant_email: contact.email,
              suite_number: assignedSuite,
              premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
              effective_date: today,
              term_start_date: today,
              term_end_date: termEnd,
              contract_year: year,
              term_months: 12,
              monthly_rent: 100,
              yearly_rent: 1200,
              security_deposit: 150,
              square_feet: 120,
              status: "draft",
              language: lang,
            })
            .select("id, token, access_code, suite_number")
            .single()

          if (leaseErr || !lease) {
            steps.push({ step: "Lease", status: "error", detail: leaseErr?.message || "insert failed" })
          } else {
            leaseUrl = `${BASE_URL}/lease/${lease.token}/${lease.access_code}`
            leaseAdminUrl = `${BASE_URL}/lease/${lease.token}/${lease.access_code}?preview=td`
            steps.push({ step: "Lease", status: "created", detail: `${lease.token} (suite ${lease.suite_number})` })
          }
        }

        // ─── 5. RELAY BANKING FORM ───
        let relayUrl = ""
        const relayToken = `relay-${companySlug.slice(0, 30)}-${year}`
        const { data: existingRelay } = await supabaseAdmin
          .from("banking_submissions")
          .select("id, token, status, access_code")
          .eq("token", relayToken)
          .maybeSingle()

        if (existingRelay) {
          relayUrl = `${BASE_URL}/banking-form/${existingRelay.token}/${existingRelay.access_code}`
          steps.push({ step: "Relay form", status: "existing", detail: `${existingRelay.token} (${existingRelay.status})` })
        } else {
          const relayPrefilled = {
            business_name: account.company_name || "",
            phone: contact.phone || "",
            email: contact.email || "",
            ein: account.ein_number || "",
            first_name: contact.first_name || "",
            last_name: contact.last_name || "",
            personal_phone: contact.phone || "",
            personal_email: contact.email || "",
          }
          const { data: relay, error: relayErr } = await supabaseAdmin
            .from("banking_submissions")
            .insert({
              token: relayToken,
              account_id,
              contact_id: contact.id,
              provider: "relay",
              language: lang,
              prefilled_data: relayPrefilled,
              status: "pending",
            })
            .select("id, token, access_code")
            .single()

          if (relayErr || !relay) {
            steps.push({ step: "Relay form", status: "error", detail: relayErr?.message || "insert failed" })
          } else {
            relayUrl = `${BASE_URL}/banking-form/${relay.token}/${relay.access_code}`
            steps.push({ step: "Relay form", status: "created", detail: relay.token })
          }
        }

        // ─── 6. PAYSET BANKING FORM ───
        let paysetUrl = ""
        const paysetToken = `bank-${companySlug.slice(0, 30)}-${year}`
        const { data: existingPayset } = await supabaseAdmin
          .from("banking_submissions")
          .select("id, token, status, access_code")
          .eq("token", paysetToken)
          .maybeSingle()

        if (existingPayset) {
          paysetUrl = `${BASE_URL}/banking-form/${existingPayset.token}/${existingPayset.access_code}`
          steps.push({ step: "Payset form", status: "existing", detail: `${existingPayset.token} (${existingPayset.status})` })
        } else {
          const paysetPrefilled = {
            first_name: contact.first_name || "",
            last_name: contact.last_name || "",
            personal_country: contact.citizenship || "",
            business_name: account.company_name || "",
            phone: contact.phone || "",
            email: contact.email || "",
          }
          const { data: payset, error: paysetErr } = await supabaseAdmin
            .from("banking_submissions")
            .insert({
              token: paysetToken,
              account_id,
              contact_id: contact.id,
              provider: "payset",
              language: lang,
              prefilled_data: paysetPrefilled,
              status: "pending",
            })
            .select("id, token, access_code")
            .single()

          if (paysetErr || !payset) {
            steps.push({ step: "Payset form", status: "error", detail: paysetErr?.message || "insert failed" })
          } else {
            paysetUrl = `${BASE_URL}/banking-form/${payset.token}/${payset.access_code}`
            steps.push({ step: "Payset form", status: "created", detail: payset.token })
          }
        }

        // ─── 7. FIND DRIVE DOCUMENTS ───
        let einFileId = ""
        let articlesFileId = ""
        if (account.drive_folder_id) {
          try {
            const { listFolder } = await import("@/lib/google-drive")
            // Search Company subfolder first
            const folderResult = await listFolder(account.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
            const folderContents = folderResult.files || []
            const companyFolder = folderContents.find(f =>
              (f.name === "1. Company" || f.name === "Company") && f.mimeType === "application/vnd.google-apps.folder"
            )

            const searchFolderId = companyFolder?.id || account.drive_folder_id
            const filesResult = await listFolder(searchFolderId) as { files?: { id: string; name: string }[] }
            const files = filesResult.files || []

            for (const f of files) {
              const name = (f.name || "").toLowerCase()
              if (name.includes("ein") && !einFileId) einFileId = f.id
              if (name.includes("articles") && !articlesFileId) articlesFileId = f.id
            }
          } catch {
            // Drive errors are non-fatal
          }
        }

        if (einFileId) {
          steps.push({ step: "EIN letter", status: "existing", detail: `Drive file ID: ${einFileId}` })
          await autoSaveDocument({ accountId: account_id, fileName: "EIN Letter (CP 575)", documentType: "EIN Letter", category: 1, driveFileId: einFileId })
        } else {
          steps.push({ step: "EIN letter", status: "skipped", detail: "Not found on Drive — attach manually" })
        }
        if (articlesFileId) {
          steps.push({ step: "Articles", status: "existing", detail: `Drive file ID: ${articlesFileId}` })
          await autoSaveDocument({ accountId: account_id, fileName: "Articles of Organization", documentType: "Articles of Organization", category: 1, driveFileId: articlesFileId })
        } else {
          steps.push({ step: "Articles", status: "skipped", detail: "Not found on Drive — attach manually" })
        }

        // ─── 8. GENERATE EMAIL ───
        const emailSubjectIT = `La tua società è pronta ad operare — documenti e prossimi passi`
        const emailSubjectEN = `Your company is ready to operate — documents and next steps`
        const emailSubject = lang === "it" ? emailSubjectIT : emailSubjectEN

        const emailBody = generateWelcomeEmail({
          nome: clientName,
          name: contact.first_name || contact.full_name,
          company_name: account.company_name,
          link_oa: oaUrl,
          link_lease: leaseUrl,
          link_relay: relayUrl,
          link_payset: paysetUrl,
          lang,
        })

        // ─── 9. UPDATE WELCOME PACKAGE STATUS ON ACCOUNT ───
        const hasErrors = steps.some(s => s.status === "error")
        const wpStatus = hasErrors ? "prepared_with_errors" : "prepared"
        await supabaseAdmin
          .from("accounts")
          .update({ welcome_package_status: wpStatus })
          .eq("id", account_id)

        // ─── 10. LOG ACTION ───
        logAction({
          action_type: "welcome_package_prepared",
          table_name: "accounts",
          record_id: account_id,
          account_id,
          summary: `Welcome package prepared for ${account.company_name}`,
          details: { steps, ein_file_id: einFileId, articles_file_id: articlesFileId },
        })

        // ─── 10. BUILD RESPONSE ───
        const created = steps.filter(s => s.status === "created").length
        const existing = steps.filter(s => s.status === "existing").length
        const errors = steps.filter(s => s.status === "error").length

        const lines = [
          `📦 **Welcome Package — ${account.company_name}**`,
          ``,
          `Steps: ${created} created, ${existing} existing, ${errors} errors`,
          ...steps.map(s => {
            const icon = s.status === "created" ? "🆕" : s.status === "existing" ? "✅" : s.status === "error" ? "❌" : "⏭️"
            return `  ${icon} ${s.step}: ${s.detail}`
          }),
          ``,
          `── Links ──`,
          oaUrl ? `OA: ${oaUrl}` : "OA: not available",
          leaseUrl ? `Lease: ${leaseUrl}` : "Lease: not available",
          relayUrl ? `Relay: ${relayUrl}` : "Relay: not available",
          paysetUrl ? `Payset: ${paysetUrl}` : "Payset: not available",
          ``,
          `── Admin Previews ──`,
          oaAdminUrl ? `OA: ${oaAdminUrl}` : null,
          leaseAdminUrl ? `Lease: ${leaseAdminUrl}` : null,
          relayUrl ? `Relay: ${relayUrl}?preview=td` : null,
          paysetUrl ? `Payset: ${paysetUrl}?preview=td` : null,
          ``,
          `── Drive Attachments ──`,
          einFileId ? `EIN letter: https://drive.google.com/file/d/${einFileId}/view` : "⚠️ EIN letter not found — attach manually",
          articlesFileId ? `Articles: https://drive.google.com/file/d/${articlesFileId}/view` : "⚠️ Articles not found — attach manually",
          ``,
          `── Email Draft ──`,
          `To: ${contact.email}`,
          `Subject: ${emailSubject}`,
          ``,
          emailBody,
          ``,
          `⚠️ Email NOT sent. The email body above is ready-to-use HTML. Pass it EXACTLY as-is to gmail_send(body_html=...) — do NOT rewrite, reformat, or modify ANY URLs. Attach EIN letter and Articles via drive_file_id params.`,
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}

// ─── Email Template (HTML — bilingual IT+EN) ───
// Returns ready-to-use HTML for gmail_send(body_html=...).
// All URLs are preserved as-is in href attributes — no conversion needed by Claude.ai.

function generateWelcomeEmail(vars: {
  nome: string
  name: string
  company_name: string
  link_oa: string
  link_lease: string
  link_relay: string
  link_payset: string
  lang: "it" | "en"
}): string {
  const linkStyle = 'style="color:#2563eb;text-decoration:underline"'
  const hrStyle = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />'

  function linkBlock(url: string, labelIt: string, labelEn: string): string {
    if (!url) return vars.lang === "it" ? "<p>[link non disponibile]</p>" : "<p>[link not available]</p>"
    const label = vars.lang === "it" ? labelIt : labelEn
    return `<p><a href="${url}" ${linkStyle}>${label}</a></p>`
  }

  if (vars.lang === "it") {
    return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
<p>Ciao ${vars.nome},</p>

<p>Siamo lieti di informarti che la tua società <strong>${vars.company_name}</strong> è ufficialmente pronta ad operare.</p>

<p>In allegato trovi:</p>
<ul>
<li>EIN Letter -- il tuo Employer Identification Number assegnato dall'IRS</li>
<li>Articles of Organization -- il documento ufficiale di costituzione della tua società</li>
</ul>

${hrStyle}

<p><strong>Firma l'Operating Agreement</strong></p>
<p>L'Operating Agreement è il documento che regola il funzionamento interno della tua società e conferma la tua posizione di unico titolare. Clicca il link qui sotto per visualizzare, firmare e scaricare il documento.</p>
${linkBlock(vars.link_oa, "Firma Operating Agreement", "Sign Operating Agreement")}

${hrStyle}

<p><strong>Firma il Lease Agreement</strong></p>
<p>Per avere un indirizzo fisico associato alla tua società, è necessario firmare il contratto di locazione. Clicca il link qui sotto per visualizzare e firmare il documento.</p>
${linkBlock(vars.link_lease, "Firma Lease Agreement", "Sign Lease Agreement")}

${hrStyle}

<p><strong>Conto bancario in dollari (Relay)</strong></p>
<p>Per il conto bancario americano in dollari (Relay), abbiamo bisogno di alcune informazioni per procedere con l'apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.</p>
<p>Una volta completata l'application da parte nostra, riceverai un'email direttamente da Relay per autenticare il tuo account. Controlla la tua casella email (anche lo spam) e completa la verifica cliccando il link che riceverai.</p>
${linkBlock(vars.link_relay, "Compila Form Relay", "Fill Out Relay Form")}

${hrStyle}

<p><strong>Conto con IBAN in euro (Payset)</strong></p>
<p>Per il conto con IBAN in euro (Payset), abbiamo bisogno di alcune informazioni per procedere con l'apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.</p>
<p>Una volta ricevuti i tuoi dati, ti contatteremo su Telegram per concordare un momento in cui procedere insieme con l'application. Durante il processo, riceverai un codice OTP via SMS sul tuo telefono che dovrai comunicarci in tempo reale per completare l'attivazione.</p>
${linkBlock(vars.link_payset, "Compila Form Payset", "Fill Out Payset Form")}

${hrStyle}

<p><strong>Conto alternativo IBAN (Wise)</strong></p>
<p>Ti consigliamo di aprire anche un conto su Wise (wise.com) per ricevere pagamenti in euro, in modo da avere un doppio account con IBAN. Abbiamo scelto Payset perché è il servizio più affidabile tra quelli disponibili, ma trattandosi di conti fintech è sempre meglio avere un'alternativa attiva. Puoi aprire il conto Wise in autonomia direttamente su wise.com.</p>

${hrStyle}

<p><strong>Regole importanti sull'utilizzo dei conti con IBAN</strong></p>
<p>Il conto con IBAN (Payset e/o Wise) va utilizzato solo ed esclusivamente per incassare pagamenti in euro. Una volta ricevuti i fondi, devono essere convertiti in dollari e trasferiti sul conto americano Relay. Non utilizzare il conto IBAN per effettuare pagamenti verso terzi.</p>

${hrStyle}

<p>Siamo a disposizione.</p>
<p><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>`
  }

  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
<p>Hi ${vars.name},</p>

<p>We are pleased to inform you that your company <strong>${vars.company_name}</strong> is officially ready to operate.</p>

<p>Please find attached:</p>
<ul>
<li>EIN Letter -- your Employer Identification Number assigned by the IRS</li>
<li>Articles of Organization -- your company's official formation document</li>
</ul>

${hrStyle}

<p><strong>Sign the Operating Agreement</strong></p>
<p>The Operating Agreement is the document that governs the internal operations of your company and confirms your position as sole owner. Click the link below to view, sign and download the document.</p>
${linkBlock(vars.link_oa, "Firma Operating Agreement", "Sign Operating Agreement")}

${hrStyle}

<p><strong>Sign the Lease Agreement</strong></p>
<p>To have a physical address associated with your company, you need to sign the lease agreement. Click the link below to view and sign the document.</p>
${linkBlock(vars.link_lease, "Firma Lease Agreement", "Sign Lease Agreement")}

${hrStyle}

<p><strong>US Dollar Bank Account (Relay)</strong></p>
<p>For your US dollar bank account (Relay), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.</p>
<p>Once we complete the application on your behalf, you will receive an email directly from Relay to authenticate your account. Please check your inbox (including spam) and complete the verification by clicking the link you receive.</p>
${linkBlock(vars.link_relay, "Compila Form Relay", "Fill Out Relay Form")}

${hrStyle}

<p><strong>EUR IBAN Account (Payset)</strong></p>
<p>For your EUR IBAN account (Payset), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.</p>
<p>Once we receive your data, we will contact you on Telegram to schedule a time to proceed together with the application. During the process, you will receive an OTP code via SMS on your phone that you will need to share with us in real time to complete the activation.</p>
${linkBlock(vars.link_payset, "Compila Form Payset", "Fill Out Payset Form")}

${hrStyle}

<p><strong>Alternative IBAN Account (Wise)</strong></p>
<p>We recommend also opening a Wise account (wise.com) to receive payments in euros, so you have two IBAN accounts available. We chose Payset because it is the most reliable service among those available, but since these are fintech accounts, it is always better to have a backup option. You can open the Wise account on your own directly at wise.com.</p>

${hrStyle}

<p><strong>Important Rules on IBAN Account Usage</strong></p>
<p>Your IBAN account (Payset and/or Wise) must be used exclusively to receive payments in euros. Once funds are received, they must be converted to USD and transferred to your US bank account on Relay. Do not use the IBAN account to make outgoing payments to third parties.</p>

${hrStyle}

<p>We are at your disposal.</p>
<p><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>`
}
