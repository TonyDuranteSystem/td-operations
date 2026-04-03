/**
 * Offer Tools — Manage client offers/proposals in Supabase
 *
 * Offers are stored in the `offers` table (columns in English).
 * Live at: app.tonydurante.us/offer/{token}/{access_code}
 * Contract signing at: app.tonydurante.us/offer/{token}/contract
 *
 * Workflow: create (draft) → review → send (Gmail send) → client views → signs → pays
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"
import { getGreeting } from "@/lib/greeting"
import { safeSend } from "@/lib/mcp/safe-send"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"
import { autoCreatePortalUser } from "@/lib/portal/auto-create"

// ─── JSONB Validation Helpers ───────────────────────────────

function validateIssues(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.title || !item.description) {
      return `issues[${i}] must have {title, description}`
    }
  }
  return null
}

function validateStrategy(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (item.step_number == null || !item.title || !item.description) {
      return `strategy[${i}] must have {step_number, title, description}`
    }
  }
  return null
}

function validateServices(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.name || !item.price) {
      return `services[${i}] must have {name, price} (description, price_label, includes, recommended optional)`
    }
  }
  return null
}

function validateCostSummary(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label) {
      return `cost_summary[${i}] must have {label} (items, total, total_label, rate optional)`
    }
  }
  return null
}

function validateRecurringCosts(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.label || !item.price) {
      return `recurring_costs[${i}] must have {label, price}`
    }
  }
  return null
}

function validateFutureDevelopments(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.text) {
      return `future_developments[${i}] must have {text}`
    }
  }
  return null
}

function validateNextSteps(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (item.step_number == null || !item.title || !item.description) {
      return `next_steps[${i}] must have {step_number, title, description}`
    }
  }
  return null
}

function validateImmediateActions(items: unknown[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>
    if (!item.title) {
      return `immediate_actions[${i}] must have {title} (text or description optional)`
    }
  }
  return null
}

/** Validate all JSONB fields, return first error or null */
function validateOfferJsonb(params: Record<string, unknown>): string | null {
  const validators: [string, (items: unknown[]) => string | null][] = [
    ["issues", validateIssues],
    ["strategy", validateStrategy],
    ["services", validateServices],
    ["additional_services", validateServices],
    ["cost_summary", validateCostSummary],
    ["recurring_costs", validateRecurringCosts],
    ["future_developments", validateFutureDevelopments],
    ["next_steps", validateNextSteps],
    ["immediate_actions", validateImmediateActions],
  ]

  for (const [field, validator] of validators) {
    const value = params[field]
    if (value && Array.isArray(value) && value.length > 0) {
      const error = validator(value)
      if (error) return error
    }
  }
  return null
}

// ─── Gmail Draft Helper ─────────────────────────────────────

function _buildOfferEmail(
  clientEmail: string,
  clientName: string,
  token: string,
  accessCode: string,
  language: string,
  trackingPixelUrl?: string,
  gender?: string | null,
  lastName?: string | null,
) {
  const offerUrl = `${APP_BASE_URL}/offer/${encodeURIComponent(token)}/${accessCode}`
  const greeting = getGreeting({ firstName: clientName, lastName, gender, language })

  const subject = language === "en"
    ? `Your Proposal from Tony Durante LLC`
    : `La Tua Proposta da Tony Durante LLC`

  const htmlBody = language === "en"
    ? `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>${greeting},</p>
  <p>Thank you for your time during our consultation.</p>
  <p>Please find your personalized proposal at the following link:</p>
  <p style="margin: 24px 0;">
    <a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      View Your Proposal
    </a>
  </p>
  <p>To view the proposal, you will be asked to verify your email address.</p>
  <p>If you have any questions, please don't hesitate to reach out.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none" alt="" />` : ""}`
    : `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>${greeting},</p>
  <p>Grazie per il tempo dedicato durante la nostra consulenza.</p>
  <p>Puoi consultare la tua proposta personalizzata al seguente link:</p>
  <p style="margin: 24px 0;">
    <a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
      Visualizza la Proposta
    </a>
  </p>
  <p>Per visualizzare la proposta, ti verrà chiesto di verificare il tuo indirizzo email.</p>
  <p>Per qualsiasi domanda, non esitare a contattarci.</p>
  <p style="margin-top: 24px;">Cordiali saluti,<br/><strong>Tony Durante LLC</strong><br/>support@tonydurante.us</p>
</div>${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none" alt="" />` : ""}`

  const plainText = language === "en"
    ? `${greeting},\n\nThank you for your time during our consultation.\n\nPlease find your personalized proposal at the following link:\n${offerUrl}\n\nTo view the proposal, you will be asked to verify your email address.\n\nIf you have any questions, please don't hesitate to reach out.\n\nBest regards,\nTony Durante LLC\nsupport@tonydurante.us`
    : `${greeting},\n\nGrazie per il tempo dedicato durante la nostra consulenza.\n\nPuoi consultare la tua proposta personalizzata al seguente link:\n${offerUrl}\n\nPer visualizzare la proposta, ti verrà chiesto di verificare il tuo indirizzo email.\n\nPer qualsiasi domanda, non esitare a contattarci.\n\nCordiali saluti,\nTony Durante LLC\nsupport@tonydurante.us`

  return { subject, htmlBody, plainText }
}

// ─── Portal Welcome Email (new client → portal credentials) ──

function buildPortalWelcomeEmail(
  firstName: string,
  email: string,
  tempPassword: string,
  portalUrl: string,
  lang: "en" | "it",
  pixelUrl: string,
): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">La tua proposta è pronta</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Ciao ${firstName},</p>
    <p>Grazie per la nostra consulenza. La tua proposta personalizzata è pronta per la revisione.</p>
    <p>Accedi al tuo <strong>portale clienti</strong> per visualizzarla:</p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Portale</td><td style="padding: 4px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 4px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 4px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Accedi al Portale
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">Al primo accesso ti verrà chiesto di cambiare la password.</p>
    <p style="color: #6b7280; font-size: 13px;">Per qualsiasi domanda, rispondi direttamente a questa email o usa la chat nel portale.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">Your proposal is ready</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Hi ${firstName},</p>
    <p>Thank you for our consultation. Your personalized proposal is ready for review.</p>
    <p>Log in to your <strong>client portal</strong> to view it:</p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Portal</td><td style="padding: 4px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 4px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 4px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Log in to Portal
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">On your first login, you'll be asked to change your password.</p>
    <p style="color: #6b7280; font-size: 13px;">For any questions, reply to this email or use the chat in your portal.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
}

// Fallback: direct offer link if portal creation fails
function buildOfferLinkFallbackEmail(
  firstName: string,
  offerUrl: string,
  lang: "en" | "it",
  pixelUrl: string,
): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Ciao ${firstName},</p>
  <p>La tua proposta personalizzata è pronta. Puoi consultarla al seguente link:</p>
  <p style="margin: 24px 0;"><a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Visualizza la Proposta</a></p>
  <p>Per qualsiasi domanda, non esitare a contattarci.</p>
  <p style="margin-top: 24px;">Cordiali saluti,<br/><strong>Tony Durante LLC</strong></p>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Hi ${firstName},</p>
  <p>Your personalized proposal is ready. View it at the following link:</p>
  <p style="margin: 24px 0;"><a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Your Proposal</a></p>
  <p>For any questions, don't hesitate to reach out.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong></p>
</div>${pixel}`
}

/**
 * Portal Transition Welcome Email — for legacy clients getting portal access.
 * Matches approved response d70e5107 (Italian) and its English equivalent.
 * Single language per client (KB rule 66c1e6fa). Dynamic "Cosa devi fare" section.
 * Exported for use in the legacy migration flow.
 */
export function buildTransitionWelcomeEmail(
  firstName: string,
  email: string,
  tempPassword: string,
  portalUrl: string,
  companyName: string,
  lang: "en" | "it",
  pendingDocs?: string[],
): string {
  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #333; line-height: 1.7;">
  <div style="background: #1e3a5f; padding: 28px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Il tuo Portale Clienti &egrave; pronto</h1>
    <p style="color: #93c5fd; margin: 6px 0 0; font-size: 14px;">Tony Durante LLC &mdash; ${companyName}</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 28px; border-radius: 0 0 12px 12px;">
    <p>Ciao ${firstName},</p>
    <p>Siamo entusiasti di presentarti il <strong>Portale Clienti Tony Durante</strong> &mdash; un'area riservata dove puoi gestire tutti gli aspetti della tua LLC in un unico posto.</p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 15px; color: #1e3a5f;">Strumenti per il tuo Business:</h3>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px; line-height: 2;">
        <li><strong>Fatturare i tuoi clienti</strong> &mdash; Crea fatture professionali con il logo della tua LLC, inviale via email ai tuoi clienti e monitora lo stato di ogni pagamento (bozza, inviata, pagata, scaduta). Visualizza il totale fatturato e incassato in tempo reale</li>
        <li><strong>Gestire i tuoi clienti</strong> &mdash; Costruisci il tuo database clienti con tutti i dettagli (nome, email, azienda). Per ogni cliente puoi vedere lo storico completo delle fatture emesse</li>
        <li><strong>Conti bancari e Payment Gateway</strong> &mdash; Configura i dati bancari della tua LLC (IBAN, numero di conto) e i link del tuo payment gateway (Stripe, PayPal, ecc.). Questi dati vengono inseriti automaticamente nelle fatture che crei, cos&igrave; i tuoi clienti sanno esattamente come pagarti</li>
        <li><strong>Logo aziendale</strong> &mdash; Carica il logo della tua LLC per personalizzare le fatture che invii ai tuoi clienti</li>
      </ul>
      <h3 style="margin: 0 0 8px; font-size: 15px; color: #1e3a5f;">Gestione LLC e Compliance:</h3>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 2;">
        <li><strong>Firmare i documenti</strong> &mdash; Contratto annuale, Operating Agreement, Lease con firma elettronica</li>
        <li><strong>Consultare tutti i documenti</strong> &mdash; Articles, EIN, Passaporto, Tax Return sempre disponibili</li>
        <li><strong>Monitorare i servizi attivi</strong> &mdash; Tax Return, Registered Agent, Annual Report con stato in tempo reale</li>
        <li><strong>Scadenze e compliance</strong> &mdash; Calendario visivo con tutte le scadenze importanti</li>
        <li><strong>Pagamenti a Tony Durante</strong> &mdash; Storico pagamenti, fatture in sospeso e scadute</li>
        <li><strong>Comunicare con il team</strong> &mdash; Chat integrata per assistenza diretta. Puoi anche usare il microfono per dettare i messaggi vocalmente &mdash; il sistema trascrive automaticamente la tua voce in testo, senza bisogno di digitare</li>
        <li><strong>Caricare documenti fiscali</strong> &mdash; Carica i documenti per la dichiarazione dei redditi</li>
      </ul>
    </div>

    <h3 style="font-size: 15px; color: #1e3a5f; margin-top: 24px;">Le tue credenziali di accesso:</h3>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 12px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px; width: 80px;">Portale</td><td style="padding: 6px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 6px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 6px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="color: #6b7280; font-size: 13px;">Al primo accesso ti verr&agrave; chiesto di cambiare la password.</p>

    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #92400e;">Cosa Fare Adesso:</h3>
      <ol style="margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: #92400e; line-height: 1.8;">
        <li>Accedi al portale con le credenziali qui sopra</li>
        <li>Cambia la password temporanea</li>
        <li>Firma i documenti in attesa${pendingDocs?.length ? ": <strong>" + pendingDocs.join(", ") + "</strong>" : ""}</li>
        <li>Esplora le funzionalit&agrave;: documenti, fatturazione, chat</li>
      </ol>
    </div>

    <p style="margin: 28px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Accedi al Portale
      </a>
    </p>

    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #166534;">Un Regalo Per Te</h3>
      <p style="margin: 0; font-size: 14px; color: #166534;">Il Portale Clienti &egrave; incluso nel tuo contratto annuale, senza costi aggiuntivi. &Egrave; un investimento che abbiamo fatto per offrirti un servizio migliore, pi&ugrave; trasparente e con tutto centralizzato in un unico posto.</p>
    </div>

    <div style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #6b21a8;">Funziona Anche Sul Telefono</h3>
      <p style="margin: 0 0 12px; font-size: 14px; color: #6b21a8;">Il portale &egrave; ottimizzato per smartphone e tablet. Riceverai notifiche push quando ci sono aggiornamenti importanti (documenti da firmare, risposte dal team, scadenze in arrivo).</p>
      <p style="margin: 0 0 4px; font-size: 13px; color: #6b21a8;"><strong>Per aggiungerlo come app sul tuo iPhone:</strong><br/>Apri Safari &rarr; vai su portal.tonydurante.us &rarr; tocca il pulsante Condividi (quadrato con freccia in su) &rarr; scorri e tocca &ldquo;Aggiungi alla schermata Home&rdquo;</p>
      <p style="margin: 0; font-size: 13px; color: #6b21a8;"><strong>Per aggiungerlo come app su Android:</strong><br/>Apri Chrome &rarr; vai su portal.tonydurante.us &rarr; tocca il menu (tre puntini in alto a destra) &rarr; tocca &ldquo;Aggiungi alla schermata Home&rdquo;</p>
    </div>

    <p style="font-size: 14px;">Il portale &egrave; stato progettato per essere semplice e intuitivo. Se hai bisogno di funzionalit&agrave; specifiche per la tua attivit&agrave;, siamo pronti a svilupparle per te &mdash; basta chiedere.</p>
    <p style="font-size: 14px;">Il portale &egrave; in continua evoluzione. Se trovi qualcosa che non funziona come dovrebbe, ci scusiamo in anticipo &mdash; &egrave; un progetto grande quello che stiamo costruendo per voi. Faccelo sapere e ci aiuterai a migliorare il sistema per tutti i nostri clienti.</p>
    <p style="font-size: 14px;">Per qualsiasi domanda, scrivici direttamente dalla chat del portale. Siamo qui per aiutarti.</p>

    <p style="margin-top: 20px;">Un caro saluto,<br/><strong>Antonio Durante</strong><br/>Tony Durante LLC</p>

    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af; text-align: center;">
      Tony Durante LLC &middot; 10225 Ulmerton Road, Suite 3D &middot; Largo, FL 33771<br/>
      support@tonydurante.us &middot; www.tonydurante.us
    </div>
  </div>
</div>`
  }

  // English version
  return `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #333; line-height: 1.7;">
  <div style="background: #1e3a5f; padding: 28px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Your Client Portal is Ready</h1>
    <p style="color: #93c5fd; margin: 6px 0 0; font-size: 14px;">Tony Durante LLC &mdash; ${companyName}</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 28px; border-radius: 0 0 12px 12px;">
    <p>Hi ${firstName},</p>
    <p>We're excited to introduce the <strong>Tony Durante Client Portal</strong> &mdash; a dedicated area where you can manage everything about your LLC in one place.</p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 15px; color: #1e3a5f;">Business Tools for Your Operations:</h3>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px; line-height: 2;">
        <li><strong>Invoice your clients</strong> &mdash; Create professional invoices with your LLC logo, send them via email, and track every payment status (draft, sent, paid, overdue). View your total invoiced and collected amounts in real-time</li>
        <li><strong>Manage your customers</strong> &mdash; Build your customer database with all their details (name, email, company). For each customer, you can view the complete history of invoices you have issued</li>
        <li><strong>Bank accounts &amp; Payment Gateway</strong> &mdash; Set up your LLC bank details (IBAN, account number) and payment gateway links (Stripe, PayPal, etc.). These details are automatically included on every invoice you create, so your clients know exactly how to pay you</li>
        <li><strong>Company logo</strong> &mdash; Upload your LLC logo to personalize the invoices you send to your clients</li>
      </ul>
      <h3 style="margin: 0 0 8px; font-size: 15px; color: #1e3a5f;">LLC Management &amp; Compliance:</h3>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 2;">
        <li><strong>Sign documents</strong> &mdash; Annual Agreement, Operating Agreement, Lease with electronic signature</li>
        <li><strong>View all documents</strong> &mdash; Articles, EIN, Passport, Tax Returns always available</li>
        <li><strong>Track active services</strong> &mdash; Tax Return, Registered Agent, Annual Report with real-time status</li>
        <li><strong>Deadlines &amp; compliance</strong> &mdash; Visual calendar with all important deadlines</li>
        <li><strong>Payments to Tony Durante</strong> &mdash; Payment history, outstanding and overdue invoices</li>
        <li><strong>Communicate with the team</strong> &mdash; Integrated chat for direct support. You can also use the microphone to dictate your messages by voice &mdash; the system automatically transcribes your voice to text, no typing needed</li>
        <li><strong>Upload tax documents</strong> &mdash; Upload documents for tax return preparation</li>
      </ul>
    </div>

    <h3 style="font-size: 15px; color: #1e3a5f; margin-top: 24px;">Your login credentials:</h3>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 12px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px; width: 80px;">Portal</td><td style="padding: 6px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 6px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 6px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 6px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="color: #6b7280; font-size: 13px;">On your first login, you'll be asked to change your password.</p>

    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #92400e;">What To Do Now:</h3>
      <ol style="margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: #92400e; line-height: 1.8;">
        <li>Log in to the portal with the credentials above</li>
        <li>Change your temporary password</li>
        <li>Sign the pending documents${pendingDocs?.length ? ": <strong>" + pendingDocs.join(", ") + "</strong>" : ""}</li>
        <li>Explore the features: documents, invoicing, chat</li>
      </ol>
    </div>

    <p style="margin: 28px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Log in to Portal
      </a>
    </p>

    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #166534;">A Gift For You</h3>
      <p style="margin: 0; font-size: 14px; color: #166534;">The Client Portal is included in your annual contract at no additional cost. It is an investment we have made to provide you with a better, more transparent service with everything centralized in one place.</p>
    </div>

    <div style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <h3 style="margin: 0 0 8px; font-size: 14px; color: #6b21a8;">Works On Your Phone Too</h3>
      <p style="margin: 0 0 12px; font-size: 14px; color: #6b21a8;">The portal is fully optimized for smartphones and tablets. You will receive push notifications for important updates (documents to sign, team replies, upcoming deadlines).</p>
      <p style="margin: 0 0 4px; font-size: 13px; color: #6b21a8;"><strong>To add it as an app on iPhone:</strong><br/>Open Safari &rarr; go to portal.tonydurante.us &rarr; tap the Share button (square with arrow pointing up) &rarr; scroll down and tap &ldquo;Add to Home Screen&rdquo;</p>
      <p style="margin: 0; font-size: 13px; color: #6b21a8;"><strong>To add it as an app on Android:</strong><br/>Open Chrome &rarr; go to portal.tonydurante.us &rarr; tap the menu (three dots, top right) &rarr; tap &ldquo;Add to Home Screen&rdquo;</p>
    </div>

    <p style="font-size: 14px;">The portal is designed to be simple and user-friendly. If you need specific features for your business, we are ready to build them for you &mdash; just ask.</p>
    <p style="font-size: 14px;">The portal is continuously evolving. If you find anything that doesn't work as expected, we apologize in advance &mdash; it's a big project we are building for you. Let us know and you'll help us improve the system for all our clients.</p>
    <p style="font-size: 14px;">For any questions, contact us through the portal chat. We are here to help.</p>

    <p style="margin-top: 20px;">Best regards,<br/><strong>Antonio Durante</strong><br/>Tony Durante LLC</p>

    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af; text-align: center;">
      Tony Durante LLC &middot; 10225 Ulmerton Road, Suite 3D &middot; Largo, FL 33771<br/>
      support@tonydurante.us &middot; www.tonydurante.us
    </div>
  </div>
</div>`
}

// ─── Tool Registration ──────────────────────────────────────

export function registerOfferTools(server: McpServer) {

  // ═══════════════════════════════════════
  // offer_list
  // ═══════════════════════════════════════
  server.tool(
    "offer_list",
    "List client offers/proposals with optional filters by status (draft/sent/viewed/signed/completed/expired) and language. Returns token, client name, status, dates, payment type, view count, and referrer name. Use offer_get with a token to see full offer details.",
    {
      status: z.string().optional().describe("Filter by status: draft, sent, viewed, signed, completed, expired"),
      language: z.enum(["en", "it"]).optional().describe("Filter by language"),
      limit: z.number().optional().default(25).describe("Max results"),
    },
    async ({ status, language, limit }) => {
      try {
        let q = supabaseAdmin
          .from("offers")
          .select("token, client_name, client_email, status, language, offer_date, payment_type, view_count, viewed_at, created_at, effective_date, expires_at, referrer_name, lead_id")
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (status) q = q.eq("status", status)
        if (language) q = q.eq("language", language)

        const { data, error } = await q
        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ total: data?.length || 0, offers: data || [] }, null, 2),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_list error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_get
  // ═══════════════════════════════════════
  server.tool(
    "offer_get",
    "Get complete offer details by token (e.g. 'mario-rossi-2026'). Returns all fields including: services, cost_summary, recurring_costs, intro text, payment links, bank details, strategy, next_steps, referrer info, access_code, signed contract status, and bundled_pipelines (which service deliveries to create on activation). Also returns the public URL with access code.",
    {
      token: z.string().describe("Offer token (e.g. 'hamid-oumoumen-2026')"),
    },
    async ({ token }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("offers")
          .select("*")
          .eq("token", token)
          .single()

        if (error) throw error
        if (!data) return { content: [{ type: "text" as const, text: `❌ Offer not found: ${token}` }] }

        // Also check if there's a signed contract
        const { data: contract } = await supabaseAdmin
          .from("contracts")
          .select("id, client_name, client_email, signed_at, pdf_path, status, wire_receipt_path, payment_verified")
          .eq("offer_token", token)
          .maybeSingle()

        const accessCode = data.access_code || ""

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              offer: data,
              contract: contract || null,
              url: `${APP_BASE_URL}/offer/${token}/${accessCode}`,
            }, null, 2),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_get error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_create
  // ═══════════════════════════════════════
  server.tool(
    "offer_create",
    `Create a new client offer/proposal in Supabase. Works for ANY client type: new leads (pass lead_id), existing clients/accounts (pass account_id), or standalone (just client_name + client_email — no lead required). Token must be unique (format: firstname-lastname-year). IMPORTANT: Set language to match the client's language (en or it). Status starts as 'draft' — use offer_send to approve, create Gmail draft, and set status='sent'. JSONB fields are validated — use correct field names. Returns the public URL with access code. Workflow: create (draft) → review via offer_get → offer_send → client views → signs → pays. IMPORTANT: All offer content that appears in the contract (services, cost_summary, recurring_costs) MUST be in English, regardless of the offer language. The offer intro and UI follow the offer language, but contract content is always English. Contract types: 'formation' (default, LLC to create), 'onboarding' (LLC already exists), 'tax_return' (standalone tax filing), 'itin' (standalone ITIN application). IMPORTANT: Always set bundled_pipelines to list which service deliveries to create when the client pays. Each pipeline type becomes a separate tracked delivery. Example: formation + ITIN = ['Company Formation', 'ITIN'].`,
    {
      token: z.string().describe("Unique token (e.g. 'mario-rossi-2026')"),
      client_name: z.string().describe("Client full name"),
      client_email: z.string().optional().describe("Client email (required for email gate + Gmail draft)"),
      language: z.enum(["en", "it"]).describe("Offer language — MUST match client's language"),
      offer_date: z.string().optional().describe("Offer date (YYYY-MM-DD, defaults to today)"),
      payment_type: z.enum(["checkout", "bank_transfer", "none"]).describe("Payment method"),
      payment_gateway: z.enum(["whop", "stripe"]).optional().describe("Payment gateway for checkout links. Default: 'whop'. Use 'stripe' for Stripe Checkout. Only applies when payment_type='checkout'."),
      // Content fields (JSONB — validated)
      services: z.any().describe("Services: [{name, price, price_label?, description?, includes?[], recommended?}]"),
      cost_summary: z.any().describe("Cost summary: [{label, total?, total_label?, items?[{name, price}], rate?}]"),
      recurring_costs: z.any().optional().describe("Annual/recurring costs: [{label, price}]"),
      additional_services: z.any().optional().describe("Add-on services: same structure as services"),
      issues: z.any().optional().describe("Issues identified: [{title, description}]"),
      immediate_actions: z.any().optional().describe("Immediate actions: [{title, text?, description?}]"),
      strategy: z.any().optional().describe("Strategy steps: [{step_number, title, description}]"),
      next_steps: z.any().optional().describe("Next steps: [{step_number, title, description}]"),
      future_developments: z.any().optional().describe("Future developments: [{text}]"),
      intro_en: z.string().optional().describe("English intro (only if language=en)"),
      intro_it: z.string().optional().describe("Italian intro (only if language=it)"),
      payment_links: z.any().optional().describe("Payment checkout links: [{url, label, amount, gateway?}]. Auto-generated when payment_type='checkout'."),
      bank_details: z.any().optional().describe("Bank transfer details: {beneficiary, iban, bic, bank_name, amount, reference}"),
      effective_date: z.string().optional().describe("Contract effective date (YYYY-MM-DD)"),
      expires_at: z.string().optional().describe("Expiry timestamp (ISO 8601)"),
      // Contract type
      contract_type: z.enum(["formation", "onboarding", "tax_return", "itin", "renewal"]).optional().describe("Contract type: 'formation' (default, LLC to create — full MSA+SOW with formation timeline), 'onboarding' (LLC already exists, client new or existing — MSA+SOW without formation timeline), 'tax_return' (standalone tax filing — lightweight agreement), 'itin' (standalone ITIN application — lightweight agreement), 'renewal' (annual renewal — simple installment-based contract for existing annual clients)."),
      // Linking — use lead_id for new leads, account_id for existing CRM clients, or neither for standalone offers
      lead_id: z.string().optional().describe("Link to lead UUID (for new leads)"),
      account_id: z.string().optional().describe("Link to CRM account UUID (for existing clients — use this instead of lead_id when client is already in the CRM)"),
      deal_id: z.string().optional().describe("Link to deal UUID"),
      // Referrer tracking
      referrer_name: z.string().optional().describe("Referrer name (who referred this client)"),
      referrer_email: z.string().optional().describe("Referrer email"),
      referrer_type: z.enum(["client", "partner"]).optional().describe("Referrer type: 'client' (existing client) or 'partner'"),
      referrer_account_id: z.string().optional().describe("Referrer's CRM account UUID (if existing client)"),
      referrer_commission_type: z.enum(["percentage", "price_difference", "credit_note"]).optional().describe("Commission type"),
      referrer_commission_pct: z.number().optional().describe("Commission percentage (if type=percentage)"),
      referrer_agreed_price: z.number().optional().describe("Partner's agreed price (if type=price_difference)"),
      referrer_notes: z.string().optional().describe("Notes about referrer arrangement"),
      // Bundled pipelines — which service deliveries to create when client pays
      bundled_pipelines: z.array(z.string()).optional().describe("Pipeline types to create on activation. Each entry becomes a separate service_delivery. Values: 'Company Formation', 'ITIN', 'Tax Return', 'EIN', 'Company Closure', 'Banking Fintech', 'Annual Renewal', 'CMRA Mailing Address'. Example: ['Company Formation', 'ITIN'] for a formation + ITIN bundle."),
    },
    async (params) => {
      try {
        // Validate JSONB fields
        const validationError = validateOfferJsonb(params as unknown as Record<string, unknown>)
        if (validationError) {
          return { content: [{ type: "text" as const, text: `❌ Validation error: ${validationError}` }] }
        }

        // Auto-lookup referrer from lead if lead_id provided and no referrer_name set
        let refName = params.referrer_name || null
        const refEmail = params.referrer_email || null
        let refType = params.referrer_type || null
        let refAccountId = params.referrer_account_id || null
        let refCommissionType = params.referrer_commission_type || null
        let refCommissionPct = params.referrer_commission_pct ?? null
        const refAgreedPrice = params.referrer_agreed_price ?? null
        const refNotes = params.referrer_notes || null
        let referralAutoFilled = false

        if (params.lead_id && !params.referrer_name) {
          const { data: lead } = await supabaseAdmin
            .from("leads")
            .select("referrer_name, referrer_partner_id, source")
            .eq("id", params.lead_id)
            .maybeSingle()

          if (lead?.referrer_name) {
            refName = lead.referrer_name
            referralAutoFilled = true
            if (lead.referrer_partner_id) {
              refType = "partner"
              refAccountId = lead.referrer_partner_id
            } else {
              refType = "client"
              refCommissionType = "credit_note"
              refCommissionPct = 10
            }
          }
        }

        const { data, error } = await supabaseAdmin
          .from("offers")
          .insert({
            token: params.token,
            client_name: params.client_name,
            client_email: params.client_email,
            language: params.language,
            offer_date: params.offer_date || new Date().toISOString().split("T")[0],
            status: "draft",
            payment_type: params.payment_type,
            services: params.services,
            cost_summary: params.cost_summary,
            recurring_costs: params.recurring_costs,
            additional_services: params.additional_services,
            issues: params.issues,
            immediate_actions: params.immediate_actions,
            strategy: params.strategy,
            next_steps: params.next_steps,
            future_developments: params.future_developments,
            intro_en: params.intro_en,
            intro_it: params.intro_it,
            payment_links: params.payment_links,
            bank_details: params.bank_details || (() => {
              // Auto-select bank based on currency detected from cost_summary or services
              const costArr = Array.isArray(params.cost_summary) ? params.cost_summary : []
              const firstTotal = (costArr[0] as Record<string, unknown>)?.total as string || ""
              const servicesStr = JSON.stringify(params.services || [])
              const isEUR = firstTotal.includes("\u20ac") || firstTotal.toUpperCase().includes("EUR")
                || servicesStr.includes("\u20ac") || servicesStr.toUpperCase().includes("EUR")

              if (isEUR) {
                // Airwallex EUR account
                return {
                  beneficiary: "TONY DURANTE L.L.C.",
                  iban: "DK8989000023658198",
                  bic: "SXPYDKKK",
                  bank_name: "Banking Circle S.A. (via Airwallex)",
                  address: "10225 Ulmerton Rd, 3D, Largo, FL 33771",
                }
              } else {
                // Relay USD account
                return {
                  beneficiary: "TONY DURANTE L.L.C.",
                  account_number: "200000306770",
                  routing_number: "064209588",
                  bank_name: "Relay Financial",
                  address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
                }
              }
            })(),
            effective_date: params.effective_date,
            expires_at: params.expires_at,
            contract_type: params.contract_type || "formation",
            bundled_pipelines: params.bundled_pipelines || [],
            lead_id: params.lead_id,
            account_id: params.account_id,
            deal_id: params.deal_id,
            referrer_name: refName,
            referrer_email: refEmail,
            referrer_type: refType,
            referrer_account_id: refAccountId,
            referrer_commission_type: refCommissionType,
            referrer_commission_pct: refCommissionPct,
            referrer_agreed_price: refAgreedPrice,
            referrer_notes: refNotes,
            view_count: 0,
          })
          .select("token, access_code, status, client_name, language")
          .single()

        if (error) throw error

        const accessCode = data.access_code || ""

        // Auto-create checkout plan if payment_type is checkout and no payment_links provided
        let autoCheckoutLine = ""
        if (params.payment_type === "checkout" && (!params.payment_links || (params.payment_links as unknown[]).length === 0)) {
          try {
            // Extract total amount from cost_summary
            const costArr = Array.isArray(params.cost_summary) ? params.cost_summary : []
            const firstCost = costArr[0] as Record<string, unknown> | undefined
            const totalStr = (firstCost?.total as string) || ""
            const totalNum = parseFloat(totalStr.replace(/[^0-9.]/g, ""))
            const isEUR = totalStr.includes("\u20AC") || totalStr.toUpperCase().includes("EUR")

            if (totalNum > 0) {
              const servArr = Array.isArray(params.services) ? params.services : []
              const primaryService = (servArr[0] as Record<string, unknown>)?.name as string || undefined
              const gateway = params.payment_gateway || "whop"
              const currencyVal: "usd" | "eur" = isEUR ? "eur" : "usd"
              const cardAmount = Math.round(totalNum * 1.05)

              if (gateway === "stripe") {
                // Stripe Checkout
                const { createStripeCheckoutSession } = await import("@/lib/stripe-checkout")
                const stripeResult = await createStripeCheckoutSession({
                  clientName: params.client_name,
                  amount: totalNum,
                  currency: currencyVal,
                  contractType: params.contract_type || "formation",
                  serviceName: primaryService,
                  clientEmail: params.client_email,
                  offerToken: params.token,
                  leadId: params.lead_id,
                })

                if (stripeResult.success && stripeResult.checkoutUrl) {
                  await supabaseAdmin
                    .from("offers")
                    .update({
                      payment_links: [{
                        url: stripeResult.checkoutUrl,
                        label: `Pay ${isEUR ? "\u20AC" : "$"}${totalNum.toLocaleString()} by Card`,
                        amount: cardAmount,
                        gateway: "stripe",
                      }],
                    })
                    .eq("token", params.token)

                  autoCheckoutLine = `\n💳 Stripe session auto-created: ${stripeResult.sessionId}\n   Checkout: ${stripeResult.checkoutUrl}`
                }
              } else {
                // Whop (default)
                const { createWhopPlan } = await import("@/lib/whop-auto-plan")
                const whopResult = await createWhopPlan({
                  clientName: params.client_name,
                  amount: totalNum,
                  currency: currencyVal,
                  contractType: params.contract_type || "formation",
                  serviceName: primaryService,
                })

                if (whopResult.success && whopResult.checkoutUrl) {
                  await supabaseAdmin
                    .from("offers")
                    .update({
                      payment_links: [{
                        url: whopResult.checkoutUrl,
                        label: `Pay ${isEUR ? "\u20AC" : "$"}${totalNum.toLocaleString()} by Card`,
                        amount: cardAmount,
                        gateway: "whop",
                      }],
                    })
                    .eq("token", params.token)

                  autoCheckoutLine = `\n💳 Whop plan auto-created: ${whopResult.planId}\n   Checkout: ${whopResult.checkoutUrl}`
                }
              }
            }
          } catch (checkoutErr) {
            autoCheckoutLine = `\n⚠️ Checkout auto-plan failed: ${checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr)}`
          }
        }

        logAction({
          action_type: "create",
          table_name: "offers",
          record_id: params.token,
          summary: `Created offer: ${params.client_name} (${params.token})${refName ? ` — referral: ${refName}` : ""}`,
          details: { language: params.language, payment_type: params.payment_type, lead_id: params.lead_id, account_id: params.account_id, referrer: refName },
        })

        // If lead_id provided, update lead's offer status
        if (params.lead_id) {
          const offerUrl = `${APP_BASE_URL}/offer/${params.token}/${accessCode}`
          await supabaseAdmin
            .from("leads")
            .update({ offer_link: offerUrl, offer_status: "Draft" })
            .eq("id", params.lead_id)
        }

        const referralLine = referralAutoFilled
          ? `\n📎 Referral auto-filled from lead: ${refName} (${refType}, ${refCommissionType || "no commission type"}${refCommissionPct ? ` ${refCommissionPct}%` : ""})`
          : ""

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer created as DRAFT: ${params.token}\nURL: ${APP_BASE_URL}/offer/${params.token}/${accessCode}${referralLine}${autoCheckoutLine}\n\nReview with offer_get, then use offer_send to approve and send.`,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_create error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_update
  // ═══════════════════════════════════════
  server.tool(
    "offer_update",
    "Update one or more fields of an existing offer by token. Only provided fields are changed — all others remain untouched. Use English column names: services, cost_summary, recurring_costs, issues, immediate_actions, strategy, next_steps, future_developments, additional_services. Use offer_get first to review current values. For approving and sending, use offer_send instead.",
    {
      token: z.string().describe("Offer token to update"),
      updates: z.record(z.string(), z.any()).describe("Object with fields to update (e.g. {status: 'sent', client_email: 'new@email.com'})"),
    },
    async ({ token, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("offers")
          .update(updates)
          .eq("token", token)
          .select("token, client_name, status, language, payment_type")
          .single()

        if (error) throw error

        logAction({
          action_type: "update",
          table_name: "offers",
          record_id: token,
          summary: `Updated offer: ${data.client_name} (${token})`,
          details: { fields: Object.keys(updates) },
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Offer ${token} updated\n${JSON.stringify(data, null, 2)}`,
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_update error: ${msg}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // offer_send — Approve offer + send via Gmail (uses safeSend)
  // ═══════════════════════════════════════
  server.tool(
    "offer_send",
    `Approve an offer and send the link to the client via Gmail with open tracking. Sets status to 'sent'. Email is sent immediately (NOT a draft). Requires client_email to be set on the offer. Use offer_get to review content before calling this.`,
    {
      token: z.string().describe("Offer token to send"),
    },
    async ({ token }) => {
      try {
        // Get offer details
        const { data: offer, error: fetchError } = await supabaseAdmin
          .from("offers")
          .select("token, client_name, client_email, language, status, access_code, lead_id, account_id")
          .eq("token", token)
          .single()

        if (fetchError) throw fetchError
        if (!offer) return { content: [{ type: "text" as const, text: `❌ Offer not found: ${token}` }] }

        if (!offer.client_email) {
          return { content: [{ type: "text" as const, text: `❌ Cannot send: client_email is not set on this offer. Update it first with offer_update.` }] }
        }

        // ─── Step 1: Create portal user with 'lead' tier ───
        const portalResult = await autoCreatePortalUser({
          leadId: offer.lead_id || undefined,
          accountId: offer.account_id || undefined,
          tier: "lead",
        })

        const isNewUser = portalResult.success && !portalResult.alreadyExists
        const tempPassword = portalResult.tempPassword
        const portalLoginUrl = `${PORTAL_BASE_URL}/portal/login`

        // ─── Step 2: Build email with portal credentials ───
        const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
        const lang = (offer.language || "en") as "en" | "it"
        const firstName = offer.client_name.split(" ")[0]

        // Fallback: if portal creation failed, send old-style offer link
        const hasPortalCredentials = isNewUser && tempPassword
        const offerDirectUrl = `${APP_BASE_URL}/offer/${token}/${offer.access_code || ""}`

        const subject = lang === "it"
          ? `La tua proposta è pronta — Tony Durante LLC`
          : `Your proposal is ready — Tony Durante LLC`

        const htmlBody = hasPortalCredentials
          ? buildPortalWelcomeEmail(firstName, offer.client_email, tempPassword!, portalLoginUrl, lang, pixelUrl)
          : buildOfferLinkFallbackEmail(firstName, offerDirectUrl, lang, pixelUrl)

        const plainText = hasPortalCredentials
          ? lang === "it"
            ? `Ciao ${firstName}, la tua proposta è pronta. Accedi al portale: ${portalLoginUrl} — Email: ${offer.client_email} — Password temporanea: ${tempPassword}`
            : `Hi ${firstName}, your proposal is ready. Log in to your portal: ${portalLoginUrl} — Email: ${offer.client_email} — Temporary password: ${tempPassword}`
          : lang === "it"
            ? `Ciao ${firstName}, la tua proposta è pronta: ${offerDirectUrl}`
            : `Hi ${firstName}, your proposal is ready: ${offerDirectUrl}`

        // Build MIME
        const fromEmail = "support@tonydurante.us"
        const boundary = `boundary_${Date.now()}`
        const hasNonAscii = /[^\x00-\x7F]/.test(subject)
        const encodedSubject = hasNonAscii
          ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
          : subject

        const mimeParts = [
          [
            `From: Tony Durante LLC <${fromEmail}>`,
            `To: ${offer.client_email}`,
            `Subject: ${encodedSubject}`,
            "MIME-Version: 1.0",
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ].join("\r\n"),
          "",
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(plainText).toString("base64"),
          "",
          `--${boundary}`,
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(htmlBody).toString("base64"),
          "",
          `--${boundary}--`,
        ]
        const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

        // ─── Step 3: safeSend — email FIRST, status updates AFTER ───
        const result = await safeSend<{ id: string; threadId: string }>({
          idempotencyCheck: async () => {
            if (offer.status === "sent") {
              const { data: existing } = await supabaseAdmin
                .from("email_tracking")
                .select("tracking_id, created_at")
                .eq("recipient", offer.client_email!)
                .ilike("subject", `%Tony Durante%`)
                .limit(1)
              if (existing?.length) {
                return {
                  alreadySent: true,
                  message: [
                    `⚠️ Offer already sent for "${token}"`,
                    `Tracking: ${existing[0].tracking_id}`,
                    `Sent at: ${existing[0].created_at}`,
                    `To resend, first use offer_update to set status back to "draft".`,
                  ].join("\n"),
                }
              }
            }
            return null
          },

          sendFn: async () => {
            return await gmailPost("/messages/send", {
              raw: encodedRaw,
            }) as { id: string; threadId: string }
          },

          postSendSteps: [
            {
              name: "save_tracking",
              fn: async () => {
                await supabaseAdmin.from("email_tracking").insert({
                  tracking_id: trackingId,
                  recipient: offer.client_email,
                  subject,
                  from_email: fromEmail,
                })
              },
            },
            {
              name: "update_offer_status",
              fn: async () => {
                await supabaseAdmin
                  .from("offers")
                  .update({ status: "sent" })
                  .eq("token", token)
              },
            },
            {
              name: "update_lead_status",
              fn: async () => {
                if (offer.lead_id) {
                  await supabaseAdmin
                    .from("leads")
                    .update({ offer_status: "Sent" })
                    .eq("id", offer.lead_id)
                }
              },
            },
          ],
        })

        if (result.alreadySent) {
          return { content: [{ type: "text" as const, text: result.idempotencyMessage! }] }
        }

        logAction({
          action_type: "send",
          table_name: "offers",
          record_id: token,
          summary: `Sent offer: ${offer.client_name} (${token}) to ${offer.client_email}${hasPortalCredentials ? " [portal created]" : ""}`,
          details: {
            lead_id: offer.lead_id,
            language: offer.language,
            gmail_message_id: result.sendResult?.id,
            tracking_id: trackingId,
            portal_created: isNewUser,
          },
        })

        const statusLine = result.hasWarnings
          ? `⚠️ Email sent but some follow-up steps had issues`
          : `✅ Offer sent via Gmail`

        return {
          content: [{
            type: "text" as const,
            text: [
              statusLine,
              ``,
              `📧 To: ${offer.client_email}`,
              `📋 Subject: ${subject}`,
              `🆔 Message ID: ${result.sendResult?.id}`,
              `👁️ Open tracking: ${trackingId}`,
              ``,
              hasPortalCredentials
                ? `🔑 Portal credentials sent to ${offer.client_email} (check email for password)`
                : portalResult.alreadyExists
                  ? `👤 Portal user already exists — sent direct offer link`
                  : `⚠️ Portal creation failed: ${portalResult.error} — sent direct offer link`,
              `🔗 Portal: ${portalLoginUrl}`,
              ``,
              result.hasWarnings ? `⚠️ Steps: ${result.steps.map(s => `${s.step}=${s.status}`).join(", ")}` : "",
            ].filter(Boolean).join("\n"),
          }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: "text" as const, text: `❌ offer_send error: ${msg}` }] }
      }
    }
  )
}
