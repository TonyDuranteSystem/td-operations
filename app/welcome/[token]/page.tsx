import type { Metadata } from "next"
import {
  getWelcomeToken,
  isWelcomeTokenExpired,
  decryptPassword,
  markWelcomeTokenViewed,
} from "@/lib/portal/welcome-token"
import { PORTAL_BASE_URL } from "@/lib/config"

export const metadata: Metadata = {
  title: "Your Portal Access — Tony Durante LLC",
  robots: { index: false, follow: false },
}

// Avoid static optimization — we read from the DB on every request.
export const dynamic = "force-dynamic"

type Lang = "en" | "it"

function t(lang: Lang) {
  if (lang === "it") {
    return {
      headerTitle: "Il tuo portale è pronto",
      headerSubtitle: "Tony Durante LLC",
      intro: "Accedi al portale clienti per consultare la tua offerta, firmare il contratto e gestire i tuoi servizi.",
      portalLabel: "Portale",
      emailLabel: "Email",
      passwordLabel: "Password",
      cta: "Accedi al Portale",
      changeNote: "Al primo accesso ti verrà chiesto di cambiare la password.",
      help: "Per qualsiasi domanda, scrivi a support@tonydurante.us o usa la chat nel portale.",
      expiredTitle: "Link scaduto",
      expiredBody: "Questo link non è più valido. Controlla la tua email per le credenziali del portale, oppure scrivi a support@tonydurante.us.",
      invalidTitle: "Link non valido",
      invalidBody: "Questo link non è valido o è stato rimosso. Controlla la tua email o scrivi a support@tonydurante.us.",
      errorTitle: "Errore",
      errorBody: "Si è verificato un errore durante il caricamento delle credenziali. Controlla la tua email per accedere al portale.",
    }
  }
  return {
    headerTitle: "Your portal is ready",
    headerSubtitle: "Tony Durante LLC",
    intro: "Log in to your client portal to review your proposal, sign the contract, and manage your services.",
    portalLabel: "Portal",
    emailLabel: "Email",
    passwordLabel: "Password",
    cta: "Go to Portal",
    changeNote: "On first login you'll be asked to change your password.",
    help: "For any questions, email support@tonydurante.us or use the chat in your portal.",
    expiredTitle: "Link expired",
    expiredBody: "This link is no longer valid. Check your email for portal credentials, or contact support@tonydurante.us.",
    invalidTitle: "Invalid link",
    invalidBody: "This link is invalid or has been removed. Check your email or contact support@tonydurante.us.",
    errorTitle: "Error",
    errorBody: "We couldn't load your credentials. Please check your email to access the portal.",
  }
}

const FOOTER = "Tony Durante LLC · 10225 Ulmerton Rd, STE 3D, Largo FL 33771"

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f3f4f6", padding: "32px 16px", fontFamily: "Arial, sans-serif", color: "#333" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {children}
      </div>
    </div>
  )
}

function StateCard({
  title,
  body,
  tone,
}: {
  title: string
  body: string
  tone: "neutral" | "warn" | "error"
}) {
  const headerBg = tone === "error" ? "#991b1b" : tone === "warn" ? "#b45309" : "#1e3a5f"
  return (
    <Shell>
      <div style={{ background: headerBg, padding: 24, borderRadius: "12px 12px 0 0", textAlign: "center" }}>
        <h1 style={{ color: "white", margin: 0, fontSize: 22 }}>{title}</h1>
        <p style={{ color: "#dbeafe", margin: "4px 0 0" }}>Tony Durante LLC</p>
      </div>
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderTop: "none", padding: 24, borderRadius: "0 0 12px 12px" }}>
        <p style={{ lineHeight: 1.5 }}>{body}</p>
        <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 24, paddingTop: 16, fontSize: 11, color: "#9ca3af" }}>
          {FOOTER}
        </div>
      </div>
    </Shell>
  )
}

export default async function WelcomePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Quick syntactic sanity check — bail before DB if the path isn't a UUID.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    const copy = t("en")
    return <StateCard title={copy.invalidTitle} body={copy.invalidBody} tone="error" />
  }

  let row: Awaited<ReturnType<typeof getWelcomeToken>> = null
  try {
    row = await getWelcomeToken(token)
  } catch {
    const copy = t("en")
    return <StateCard title={copy.errorTitle} body={copy.errorBody} tone="error" />
  }

  if (!row) {
    const copy = t("en")
    return <StateCard title={copy.invalidTitle} body={copy.invalidBody} tone="error" />
  }

  const lang: Lang = row.language === "it" ? "it" : "en"
  const copy = t(lang)

  if (isWelcomeTokenExpired(row)) {
    return <StateCard title={copy.expiredTitle} body={copy.expiredBody} tone="warn" />
  }

  let password: string
  try {
    password = decryptPassword(token, row.encrypted_password)
  } catch {
    return <StateCard title={copy.errorTitle} body={copy.errorBody} tone="error" />
  }

  // Record first open (best effort — never block the render).
  try {
    if (!row.first_viewed_at) {
      await markWelcomeTokenViewed(token)
    }
  } catch {
    // swallow — view tracking must not break the page
  }

  const portalLoginUrl = `${PORTAL_BASE_URL}/portal/login`

  return (
    <Shell>
      <div style={{ background: "#1e3a5f", padding: 24, borderRadius: "12px 12px 0 0", textAlign: "center" }}>
        <h1 style={{ color: "white", margin: 0, fontSize: 22 }}>{copy.headerTitle}</h1>
        <p style={{ color: "#93c5fd", margin: "4px 0 0" }}>{copy.headerSubtitle}</p>
      </div>
      <div style={{ background: "white", border: "1px solid #e5e7eb", borderTop: "none", padding: 24, borderRadius: "0 0 12px 12px" }}>
        <p style={{ lineHeight: 1.5 }}>{copy.intro}</p>

        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 16, margin: "20px 0" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ padding: "4px 8px", color: "#6b7280", fontSize: 13 }}>{copy.portalLabel}</td>
                <td style={{ padding: "4px 8px", fontWeight: "bold" }}>
                  <a href={portalLoginUrl} style={{ color: "#2563eb" }}>
                    {portalLoginUrl.replace(/^https?:\/\//, "")}
                  </a>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "4px 8px", color: "#6b7280", fontSize: 13 }}>{copy.emailLabel}</td>
                <td style={{ padding: "4px 8px", fontWeight: "bold", wordBreak: "break-all" }}>{row.email}</td>
              </tr>
              <tr>
                <td style={{ padding: "4px 8px", color: "#6b7280", fontSize: 13 }}>{copy.passwordLabel}</td>
                <td style={{ padding: "4px 8px", fontWeight: "bold", fontFamily: "monospace", letterSpacing: 1 }}>{password}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p style={{ margin: "24px 0", textAlign: "center" }}>
          <a
            href={portalLoginUrl}
            style={{
              display: "inline-block",
              background: "#1e3a5f",
              color: "#fff",
              padding: "14px 32px",
              borderRadius: 8,
              textDecoration: "none",
              fontWeight: "bold",
              fontSize: 16,
            }}
          >
            {copy.cta}
          </a>
        </p>

        <p style={{ color: "#6b7280", fontSize: 13 }}>{copy.changeNote}</p>
        <p style={{ color: "#6b7280", fontSize: 13 }}>{copy.help}</p>

        <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 24, paddingTop: 16, fontSize: 11, color: "#9ca3af" }}>
          {FOOTER}
        </div>
      </div>
    </Shell>
  )
}
