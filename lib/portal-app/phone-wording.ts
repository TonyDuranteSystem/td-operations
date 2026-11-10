/**
 * Client iPhone app — what a lock screen may show, per kind of client alert (pure; dev job 056a70d0, Step 4).
 *
 * THE RULE (the same as TD Social's): who and what KIND, never what. A lock screen is visible to anyone near the phone, so every alert shows FIXED words
 * written here: who wrote ("Tony Durante LLC") and the kind of thing that happened. Never the text of a message, never a document or file name, never a
 * service or stage name, never an amount or a company name. The kind comes ONLY from the closed list below, mapped from the notification's own `type`
 * (a word our code picks), never read from a title, a body or a link. A type that is not on the list shows the generic words.
 * English, or Italian for a client whose language is Italian (`localeFromLanguage`).
 */
export type ClientAlertKind = 'chat' | 'reaction' | 'service' | 'document' | 'sign' | 'invoice' | 'decision' | 'reminder' | 'generic' | 'test'

/** The notification `type` words our code uses today (portal_notifications.type and the service-delivery push), mapped to a kind. Anything else is `generic`. */
const KIND_BY_TYPE: Readonly<Record<string, ClientAlertKind>> = {
  chat: 'chat',
  reaction: 'reaction',
  service: 'service',
  formation: 'service',
  new_document: 'document',
  document_uploaded: 'document',
  document: 'document',
  sign_document: 'sign',
  signature_request: 'sign',
  invoice: 'invoice',
  decision: 'decision',
  wizard_reminder: 'reminder',
  test: 'test',
}

export function clientAlertKind(type: unknown): ClientAlertKind {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(KIND_BY_TYPE, type) ? KIND_BY_TYPE[type] : 'generic'
}

export interface ClientPhoneText { title: string; body: string }

const WORDS: Readonly<Record<'en' | 'it', Readonly<Record<ClientAlertKind, ClientPhoneText>>>> = {
  en: {
    chat: { title: 'New message from Tony Durante LLC', body: '' },
    reaction: { title: 'Tony Durante LLC reacted to your message', body: '' },
    service: { title: 'Update on your service', body: '' },
    document: { title: 'A new document is ready', body: '' },
    sign: { title: 'A document needs your signature', body: '' },
    invoice: { title: 'New invoice from Tony Durante LLC', body: '' },
    decision: { title: 'We need a decision from you', body: '' },
    reminder: { title: 'Please finish your set-up', body: '' },
    generic: { title: 'New notification from Tony Durante LLC', body: '' },
    test: { title: 'Test notification', body: 'Alerts are working.' },
  },
  it: {
    chat: { title: 'Nuovo messaggio da Tony Durante LLC', body: '' },
    reaction: { title: 'Tony Durante LLC ha reagito al tuo messaggio', body: '' },
    service: { title: 'Aggiornamento sul tuo servizio', body: '' },
    document: { title: 'Nuovo documento disponibile', body: '' },
    sign: { title: 'Un documento richiede la tua firma', body: '' },
    invoice: { title: 'Nuova fattura da Tony Durante LLC', body: '' },
    decision: { title: 'Serve una tua decisione', body: '' },
    reminder: { title: 'Completa la configurazione', body: '' },
    generic: { title: 'Nuova notifica da Tony Durante LLC', body: '' },
    test: { title: 'Notifica di prova', body: 'Le notifiche funzionano.' },
  },
}

export function clientPhoneWording(kind: ClientAlertKind, locale: 'en' | 'it'): ClientPhoneText {
  return WORDS[locale]?.[kind] ?? WORDS.en.generic
}
