/**
 * The message the company owner copies and sends to a new team member (or after a password reset) — by WhatsApp, text or
 * email, himself. No email is ever sent by us for a team member (dev job e5d5400d, Antonio 2026-10-22).
 *
 * Pure and client-safe. English and Italian (the owner of an Italian company writes to Italian colleagues).
 */
export type HandoverLang = 'en' | 'it'

export interface HandoverInput {
  lang: HandoverLang
  kind: 'new' | 'reset'
  displayName: string
  companyName: string
  loginUrl: string
  username: string
  password: string
}

export function buildHandoverMessage(i: HandoverInput): string {
  const first = (i.displayName || '').trim().split(/\s+/)[0] || ''
  if (i.lang === 'it') {
    const intro = i.kind === 'new'
      ? `Ciao${first ? ` ${first}` : ''},\necco il tuo accesso al portale di ${i.companyName}.`
      : `Ciao${first ? ` ${first}` : ''},\nla tua password del portale è stata reimpostata.`
    const notif = i.kind === 'new'
      ? `\n\nNotifiche: per ricevere gli avvisi dei nuovi messaggi sul telefono, apri il link dal telefono e aggiungilo alla schermata Home (iPhone: Condividi → Aggiungi a Home; Android: menu → Installa app). Poi apri l'app, accedi e tocca "Enable notifications". Senza questo passaggio non riceverai gli avvisi.`
      : ''
    return `${intro}\n\nLink: ${i.loginUrl}\nNome utente: ${i.username}\nPassword temporanea: ${i.password}\n\nAl primo accesso ti verrà chiesto di scegliere una tua password.${notif}`
  }
  const intro = i.kind === 'new'
    ? `Hi${first ? ` ${first}` : ''},\nhere is your access to the ${i.companyName} portal.`
    : `Hi${first ? ` ${first}` : ''},\nyour portal password has been reset.`
  const notif = i.kind === 'new'
    ? `\n\nNotifications: to get alerts for new messages on your phone, open the link on your phone and add it to your Home Screen (iPhone: Share → Add to Home Screen; Android: menu → Install app). Then open the app, sign in and tap "Enable notifications". Without this you will not receive alerts.`
    : ''
  return `${intro}\n\nLink: ${i.loginUrl}\nUsername: ${i.username}\nTemporary password: ${i.password}\n\nThe first time you sign in you will be asked to choose your own password.${notif}`
}
