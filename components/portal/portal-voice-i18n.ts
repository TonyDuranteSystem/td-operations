import { fillSlots, STATIC_SNIPPETS, type TalkI18n } from '@/components/talk/talk-i18n'

/**
 * Italian for the voice-note player and the recorder's own messages in the client portal (dev job 753b2909). The player (components/team-chat/voice-note.tsx)
 * and the recorder hook write plain English through `t("English text")`; TD Talk shows them as written, the marketing chat translates them with its own provider.
 * The portal does the same: English is the default, Italian replaces a line only when it is in this list — a missing line shows the English, never a blank.
 */
const IT: Record<string, string> = {
  // the player
  'Show text': 'Mostra il testo',
  'Hide text': 'Nascondi il testo',
  Download: 'Scarica',
  Text: 'Testo',
  'Reading the voice note…': 'Sto leggendo il messaggio vocale…',
  'Machine text — it can be wrong.': 'Testo automatico: può contenere errori.',
  'Could not turn this voice note into text. Please try again.': 'Non è stato possibile trasformare il messaggio vocale in testo. Riprova.',
  English: 'Inglese',
  Original: 'Originale',
  Italian: 'Italiano',
  Spanish: 'Spagnolo',
  French: 'Francese',
  German: 'Tedesco',
  Portuguese: 'Portoghese',
  // what the "Show text" route can answer
  'That is not a voice note.': 'Questo non è un messaggio vocale.',
  'Too many requests. Please wait a moment.': 'Troppe richieste. Attendi un momento.',
  'Voice-to-text is not configured here.': 'La trascrizione vocale non è attiva qui.',
  'Could not load the audio.': 'Non è stato possibile caricare l\'audio.',
  'This audio cannot be transcribed.': 'Questo audio non può essere trascritto.',
  'This voice note is too long to transcribe (over 25 MB).': 'Questo messaggio vocale è troppo lungo da trascrivere (oltre 25 MB).',
  'This voice note is empty.': 'Questo messaggio vocale è vuoto.',
  'No speech was found in this voice note.': 'Nel messaggio vocale non è stato trovato nessun parlato.',
  'Access denied': 'Accesso negato',
  'Message not found.': 'Messaggio non trovato.',
  Unauthorized: 'Non autorizzato',
  // the recorder
  'Recording too short — hold the mic button a bit longer.': 'Registrazione troppo breve: tieni premuto il microfono un po\' più a lungo.',
  'The phone cut the recording short (the screen went dark or another app took the microphone). What was recorded so far is kept.': 'Il telefono ha interrotto la registrazione (lo schermo si è spento o un\'altra app ha preso il microfono). Quanto registrato finora è stato conservato.',
  'The microphone is blocked for this app. On iPhone: Settings → Safari → Microphone → set this site to Allow (or Ask), then close and reopen the app. On a computer: click the lock icon next to the address, then allow the microphone.': 'Il microfono è bloccato per questa app. Su iPhone: Impostazioni → Safari → Microfono → imposta questo sito su Consenti (o Chiedi), poi chiudi e riapri l\'app. Su computer: clicca sul lucchetto accanto all\'indirizzo e consenti il microfono.',
  'No microphone was found. Check that a microphone is connected and not used by another app.': 'Nessun microfono trovato. Controlla che sia collegato e non usato da un\'altra app.',
  'The microphone is busy (another app or call is using it). Close it and try again.': 'Il microfono è occupato (un\'altra app o una chiamata lo sta usando). Chiudila e riprova.',
  'Could not start recording. Check your microphone connection and browser permissions.': 'Impossibile avviare la registrazione. Controlla il microfono e i permessi del browser.',
}

/** The translator the portal hands to the player and to the recorder's messages. English (and anything unknown) stays exactly as written. */
export function portalVoiceI18n(locale: string | undefined | null): TalkI18n {
  const it = (locale || '').toLowerCase().startsWith('it')
  const t: TalkI18n['t'] = (text, vars) => fillSlots(it ? (IT[text] ?? text) : text, vars)
  return { t, ts: text => (it && STATIC_SNIPPETS.has(text) ? (IT[text] ?? text) : text), day: label => label }
}
