/**
 * Single source of truth for PWA install copy (EN/IT).
 *
 * Consumed by:
 * - app/(portal-install)/portal/install — the public smart install page
 * - components/portal/install-nudge-banner.tsx — THE in-portal nudge
 *   (Phase 3 consolidated the old floating prompt / dashboard banner /
 *   enable-push card into this one surface)
 * - components/portal/portal-sidebar.tsx — desktop "Get the app" entry
 *
 * Positioning rule (Antonio, 2026-08-06): sell the private professional
 * channel POSITIVELY — "your company's private area, on your phone". Never
 * "install our PWA", never anti-WhatsApp messaging.
 */

import type { InstallLanguage } from './install-page-mode'

/** Copy for the fixed in-portal nudge banner + the desktop sidebar entry. */
export const INSTALL_NUDGE_COPY: Record<InstallLanguage, {
  installLine: string
  installCta: string
  pushLine: string
  pushCta: string
  pushEnabled: string
  pushDenied: string
  pushFailed: string
  sidebarGetApp: string
}> = {
  en: {
    installLine: 'Get our replies instantly — put the portal on your phone.',
    installCta: 'Install',
    pushLine: 'One step left: turn on notifications to hear from us instantly.',
    pushCta: 'Turn on',
    pushEnabled: 'Notifications enabled — you’re all set',
    pushDenied: 'Notification permission denied',
    pushFailed: 'Could not enable notifications',
    sidebarGetApp: 'Get the app',
  },
  it: {
    installLine: 'Ricevi le nostre risposte all’istante — porta il portale sul tuo telefono.',
    installCta: 'Installa',
    pushLine: 'Ultimo passo: attiva le notifiche per sentirci all’istante.',
    pushCta: 'Attiva',
    pushEnabled: 'Notifiche attivate — tutto pronto',
    pushDenied: 'Permesso per le notifiche negato',
    pushFailed: 'Impossibile attivare le notifiche',
    sidebarGetApp: 'Scarica l’app',
  },
}

/** Copy for the public /portal/install smart page. */
export const INSTALL_PAGE_COPY: Record<InstallLanguage, {
  headline: string
  subline: string
  androidInstall: string
  androidWaiting: string
  androidManualTitle: string
  androidManualSteps: readonly string[]
  iosTitle: string
  iosStep1Before: string
  iosStep1Bold: string
  iosStep1After: string
  iosStep2Before: string
  iosStep2Bold: string
  loginNote: string
  iosHatchTitle: string
  iosHatchBody: string
  iosInAppWarning: string
  copyLink: string
  copied: string
  desktopTitle: string
  desktopBody: string
  desktopAlt: string
  installedTitle: string
  installedBody: string
  installedCta: string
  installedPushNote: string
}> = {
  en: {
    headline: "Your company's private area, on your phone",
    subline:
      'Get our replies the moment they arrive — everything about your business in one place, separate from your personal chats.',
    androidInstall: 'Install the app',
    androidWaiting: 'Preparing install…',
    androidManualTitle: 'Install from the browser menu:',
    androidManualSteps: [
      'Open this page in Chrome',
      'Tap the ⋮ menu (top right)',
      'Choose "Add to Home screen" or "Install app"',
    ],
    iosTitle: 'Install on your iPhone or iPad:',
    iosStep1Before: 'Tap the',
    iosStep1Bold: 'Share',
    iosStep1After: 'button in the Safari bar',
    iosStep2Before: 'Choose',
    iosStep2Bold: '"Add to Home Screen"',
    loginNote:
      "Then open the app and log in once — use “Forgot password” if you don't remember it.",
    iosHatchTitle: "Don't see “Add to Home Screen”?",
    iosHatchBody:
      'You may be inside another app’s browser (Gmail, Instagram…). Open this page in Safari, then follow the steps above.',
    iosInAppWarning:
      'This app’s built-in browser cannot install the portal. Open this page in Safari to continue.',
    copyLink: 'Copy link',
    copied: 'Link copied — paste it in Safari',
    desktopTitle: 'Put the portal on your phone',
    desktopBody: 'Scan this code with your phone camera to install the app.',
    desktopAlt: 'QR code for the install page',
    installedTitle: "You're all set",
    installedBody: 'The portal app is installed on this device.',
    installedCta: 'Open the portal',
    installedPushNote:
      'Tip: make sure notifications are ON inside the app, so our replies reach you instantly.',
  },
  it: {
    headline: "L'area privata della tua azienda, sul tuo telefono",
    subline:
      'Ricevi le nostre risposte appena arrivano — tutto ciò che riguarda la tua azienda in un unico posto, separato dalle chat personali.',
    androidInstall: "Installa l'app",
    androidWaiting: 'Preparazione installazione…',
    androidManualTitle: 'Installa dal menu del browser:',
    androidManualSteps: [
      'Apri questa pagina in Chrome',
      'Tocca il menu ⋮ (in alto a destra)',
      'Scegli "Aggiungi a schermata Home" o "Installa app"',
    ],
    iosTitle: 'Installa sul tuo iPhone o iPad:',
    iosStep1Before: 'Tocca il pulsante',
    iosStep1Bold: 'Condividi',
    iosStep1After: 'nella barra di Safari',
    iosStep2Before: 'Scegli',
    iosStep2Bold: '"Aggiungi alla schermata Home"',
    loginNote:
      'Poi apri l’app e accedi una volta — usa “Password dimenticata” se non la ricordi.',
    iosHatchTitle: 'Non vedi “Aggiungi alla schermata Home”?',
    iosHatchBody:
      'Forse sei nel browser interno di un’altra app (Gmail, Instagram…). Apri questa pagina in Safari e segui i passaggi sopra.',
    iosInAppWarning:
      'Il browser interno di questa app non può installare il portale. Apri questa pagina in Safari per continuare.',
    copyLink: 'Copia link',
    copied: 'Link copiato — incollalo in Safari',
    desktopTitle: 'Porta il portale sul tuo telefono',
    desktopBody: 'Inquadra questo codice con la fotocamera del telefono per installare l’app.',
    desktopAlt: 'Codice QR per la pagina di installazione',
    installedTitle: 'Tutto pronto',
    installedBody: 'L’app del portale è installata su questo dispositivo.',
    installedCta: 'Apri il portale',
    installedPushNote:
      'Consiglio: verifica che le notifiche siano ATTIVE nell’app, così le nostre risposte ti arrivano subito.',
  },
}
