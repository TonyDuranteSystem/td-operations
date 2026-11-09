import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import {
  VOICE_PREVIEW,
  chatPreviewText,
  decideMessageVoiceAccess,
  fillVoiceListPreviews,
  hasVoiceAttachment,
  heldVoiceGoesOut,
  isVoiceAttachment,
  leavingHref,
  stripSenderTranscripts,
  voiceUrls,
} from '@/lib/portal/chat-voice'
import { portalVoiceI18n } from '@/components/portal/portal-voice-i18n'
import { t as portalT } from '@/lib/portal/i18n'
import { micErrorMessage } from '@/lib/media/mic-session'

describe('isVoiceAttachment', () => {
  it('trusts the mime type when there is one', () => {
    expect(isVoiceAttachment({ url: 'https://x/a.bin', mime_type: 'audio/mp4' })).toBe(true)
    expect(isVoiceAttachment({ url: 'https://x/a.m4a', mime_type: 'application/pdf' })).toBe(false)
    expect(isVoiceAttachment({ url: 'https://x/clip.mp4', mime_type: 'video/mp4' })).toBe(false)
  })
  it('falls back to the extension only for audio-only extensions', () => {
    expect(isVoiceAttachment({ url: 'https://x/voice-note.m4a' })).toBe(true)
    expect(isVoiceAttachment({ url: 'https://x/a', name: 'memo.MP3' })).toBe(true)
    expect(isVoiceAttachment({ url: 'https://x/a.m4a?v=1' })).toBe(true)
  })
  it('does not call an extension-less .mp4 / .webm a voice note (it could be a video)', () => {
    expect(isVoiceAttachment({ url: 'https://x/clip.mp4' })).toBe(false)
    expect(isVoiceAttachment({ url: 'https://x/clip.webm', name: 'clip.webm' })).toBe(false)
  })
  it('handles empty and missing input', () => {
    expect(isVoiceAttachment(null)).toBe(false)
    expect(isVoiceAttachment(undefined)).toBe(false)
    expect(isVoiceAttachment({ url: '' , mime_type: 'audio/mp4' })).toBe(false)
  })
})

describe('hasVoiceAttachment', () => {
  it('is true when any attachment is audio', () => {
    expect(hasVoiceAttachment([{ url: 'https://x/a.pdf', mime_type: 'application/pdf' }, { url: 'https://x/v', mime_type: 'audio/webm' }])).toBe(true)
  })
  it('is false for none, non-arrays and null', () => {
    expect(hasVoiceAttachment([])).toBe(false)
    expect(hasVoiceAttachment(null)).toBe(false)
    expect(hasVoiceAttachment('x')).toBe(false)
  })
})

describe('chatPreviewText', () => {
  const voice = [{ url: 'https://x/v.m4a', mime_type: 'audio/mp4' }]
  it('shows the words when there are words', () => {
    expect(chatPreviewText('  hello  ', voice)).toBe('hello')
  })
  it('says it is a voice note when there are no words', () => {
    expect(chatPreviewText('', voice)).toBe(VOICE_PREVIEW)
    expect(chatPreviewText(null, voice)).toBe(VOICE_PREVIEW)
    expect(chatPreviewText('   ', voice)).toBe(VOICE_PREVIEW)
  })
  it('returns empty for a plain file so the caller keeps its own "[Attachment]" fallback', () => {
    expect(chatPreviewText('', [{ url: 'https://x/a.pdf', mime_type: 'application/pdf' }])).toBe('')
    expect(chatPreviewText(undefined, undefined)).toBe('')
  })
})

describe('stripSenderTranscripts', () => {
  it('drops transcript and flattened_at, keeps everything else', () => {
    const out = stripSenderTranscripts([{ url: 'u', name: 'n', mime_type: 'audio/mp4', size: 5, flat: true, transcript: { text: 'forged' }, flattened_at: 'now' }])
    expect(out).toEqual([{ url: 'u', name: 'n', mime_type: 'audio/mp4', size: 5, flat: true }])
  })
  it('does not change the input array and tolerates odd entries', () => {
    const input = [{ url: 'u', transcript: { text: 'x' } }]
    stripSenderTranscripts(input)
    expect(input[0]).toHaveProperty('transcript')
    expect(stripSenderTranscripts([null as unknown as object, 'str' as unknown as object])).toEqual([null, 'str'])
    expect(stripSenderTranscripts([])).toEqual([])
  })
})

describe('decideMessageVoiceAccess', () => {
  const base = { isStaff: false, isClient: true, accountAllowed: false, authContactId: 'c1' as string | null, message: { account_id: 'a1' as string | null, contact_id: 'c1' as string | null } }
  it('lets staff open any message', () => {
    expect(decideMessageVoiceAccess({ ...base, isStaff: true, isClient: false })).toBe(true)
  })
  it('lets a client open a message of a company they may chat for', () => {
    expect(decideMessageVoiceAccess({ ...base, accountAllowed: true })).toBe(true)
  })
  it('refuses a client for a company they may not use', () => {
    expect(decideMessageVoiceAccess({ ...base, accountAllowed: false })).toBe(false)
  })
  it('for a message with no company, only the contact whose thread it is', () => {
    const noCompany = { account_id: null, contact_id: 'c1' }
    expect(decideMessageVoiceAccess({ ...base, message: noCompany })).toBe(true)
    expect(decideMessageVoiceAccess({ ...base, message: { account_id: null, contact_id: 'other' } })).toBe(false)
    expect(decideMessageVoiceAccess({ ...base, authContactId: null, message: noCompany })).toBe(false)
    // the company answer must not leak into a no-company message
    expect(decideMessageVoiceAccess({ ...base, accountAllowed: true, message: { account_id: null, contact_id: 'other' } })).toBe(false)
  })
  it('refuses anyone who is neither staff nor a client, whatever the company answer says', () => {
    expect(decideMessageVoiceAccess({ ...base, isClient: false, accountAllowed: true })).toBe(false)
    expect(decideMessageVoiceAccess({ ...base, isClient: false, accountAllowed: true, authContactId: 'c1', message: { account_id: null, contact_id: 'c1' } })).toBe(false)
  })
})

describe('portalVoiceI18n', () => {
  it('English stays exactly as written, with slots filled', () => {
    const { t } = portalVoiceI18n('en')
    expect(t('Show text')).toBe('Show text')
    expect(t('Hello {name}', { name: 'Ann' })).toBe('Hello Ann')
  })
  it('Italian translates the player, the route answers and the recorder messages; unknown lines stay English', () => {
    const { t } = portalVoiceI18n('it')
    expect(t('Show text')).toBe('Mostra il testo')
    expect(t('No speech was found in this voice note.')).toContain('messaggio vocale')
    expect(t('Recording too short — hold the mic button a bit longer.')).toContain('troppo breve')
    expect(t('Something we never translated')).toBe('Something we never translated')
  })
  it('every message the microphone code can raise has an Italian line', () => {
    const { t } = portalVoiceI18n('it')
    const errors = [
      micErrorMessage({ name: 'NotAllowedError' }).message,
      micErrorMessage({ name: 'NotFoundError' }).message,
      micErrorMessage({ name: 'NotReadableError' }).message,
      micErrorMessage({ name: 'SomethingElse' }).message,
    ]
    for (const e of errors) expect(t(e), e).not.toBe(e)
  })
  it('a missing or odd locale falls back to English', () => {
    expect(portalVoiceI18n(undefined).t('Show text')).toBe('Show text')
    expect(portalVoiceI18n('fr').t('Show text')).toBe('Show text')
  })
})

describe('portal wording for voice notes', () => {
  const keys = [
    'portalChat.micConsent', 'portalChat.voice.record', 'portalChat.voice.discard', 'portalChat.voice.send', 'portalChat.voice.recording',
    'portalChat.voice.waiting', 'portalChat.voice.note', 'portalChat.voice.failed', 'portalChat.voice.finishFirst',
    'portalChat.voice.leaveTitleRecording', 'portalChat.voice.leaveTitleHeld', 'portalChat.voice.leaveBody', 'portalChat.voice.leaveSend',
    'portalChat.voice.leaveDiscard', 'portalChat.voice.leaveKeepRecording', 'portalChat.voice.leaveStay', 'portalChat.voice.leaveSending',
  ]
  it.each(keys)('%s exists in English and Italian and the two differ', key => {
    const en = portalT(key, 'en')
    const it = portalT(key, 'it')
    expect(en).not.toBe(key)
    expect(it).not.toBe(key)
    expect(it).not.toBe(en)
  })
  it('the consent no longer promises the recording is deleted', () => {
    expect(portalT('portalChat.micConsent', 'en')).not.toMatch(/deleted/i)
    expect(portalT('portalChat.micConsent', 'it')).not.toMatch(/eliminat/i)
  })
})

describe('the Italian lines the player and the route need', () => {
  it.each(['Download', 'Text', 'Message not found.', 'Unauthorized'])('%s is translated', line => {
    expect(portalVoiceI18n('it').t(line)).not.toBe(line)
    expect(portalVoiceI18n('en').t(line)).toBe(line)
  })
})

describe('voiceUrls (spots a send that is being tried a second time)', () => {
  it('lists the voice notes only, in order', () => {
    const atts = [
      { url: 'https://x/a.pdf', mime_type: 'application/pdf' },
      { url: 'https://x/n1.m4a', mime_type: 'audio/mp4' },
      { url: 'https://x/n2.webm', mime_type: 'audio/webm' },
    ]
    expect(voiceUrls(atts)).toEqual(['https://x/n1.m4a', 'https://x/n2.webm'])
  })
  it('is empty for no attachments, junk, or nothing audio', () => {
    expect(voiceUrls(undefined)).toEqual([])
    expect(voiceUrls('x')).toEqual([])
    expect(voiceUrls([null, { url: 'https://x/a.pdf', mime_type: 'application/pdf' }])).toEqual([])
  })
})

describe('heldVoiceGoesOut (a held note is never sent to another company by a switch)', () => {
  it('a note with no company yet goes to whichever company is picked', () => {
    expect(heldVoiceGoesOut(null, 'B')).toBe(true)
  })
  it('a note that failed for company A goes out when A is picked again', () => {
    expect(heldVoiceGoesOut('A', 'A')).toBe(true)
  })
  it('a note that failed for company A does NOT go out when B is picked', () => {
    expect(heldVoiceGoesOut('A', 'B')).toBe(false)
  })
})

describe('leavingHref (which clicks ask "leave and lose the note?")', () => {
  const here = { origin: 'https://portal.example', pathname: '/portal/chat', search: '' }
  it('a menu link to another page asks, and gives the in-app address', () => {
    expect(leavingHref({ href: 'https://portal.example/portal/chat?view=log' }, here)).toBe('/portal/chat?view=log')
    expect(leavingHref({ href: 'https://portal.example/portal/invoices' }, here)).toBe('/portal/invoices')
    expect(leavingHref({ href: '/portal/invoices#top' }, here)).toBe('/portal/invoices#top')
  })
  it('does not ask for the page the client is already on or a #fragment of it', () => {
    expect(leavingHref({ href: 'https://portal.example/portal/chat' }, here)).toBeNull()
    expect(leavingHref({ href: 'https://portal.example/portal/chat#bottom' }, here)).toBeNull()
  })
  it('does not ask for a new tab, a download, another site, or an unreadable address', () => {
    expect(leavingHref({ href: '/portal/invoices', target: '_blank' }, here)).toBeNull()
    expect(leavingHref({ href: '/files/a.pdf', download: true }, here)).toBeNull()
    expect(leavingHref({ href: 'https://example.com/x' }, here)).toBeNull()
    expect(leavingHref({ href: 'mailto:a@b.c' }, here)).toBeNull()
    expect(leavingHref({ href: 'http://[bad' }, here)).toBeNull()
  })
  it('a link that stays in this tab (target _self) still asks', () => {
    expect(leavingHref({ href: '/portal/invoices', target: '_self' }, here)).toBe('/portal/invoices')
  })
})

describe('fillVoiceListPreviews (the staff list row for a voice-only last message)', () => {
  const t1 = '2026-11-08T10:00:00.123456+00:00'
  const t2 = '2026-11-08T11:00:00+00:00'
  const rows = [
    { id: 1, last_message: '', last_message_at: t1 },
    { id: 2, last_message: 'Hello', last_message_at: t2 },
    { id: 3, last_message: '', last_message_at: '2026-11-08T12:00:00+00:00' },
  ]
  it('says Voice note on a wordless row whose last message is a voice note, and leaves the rest alone', () => {
    const out = fillVoiceListPreviews(rows, [{ created_at: t1, attachments: [{ url: 'https://x/n.m4a', mime_type: 'audio/mp4' }] }])
    expect(out[0].last_message).toBe(VOICE_PREVIEW)
    expect(out[1].last_message).toBe('Hello')
    expect(out[2].last_message).toBe('')
  })
  it('does not touch a wordless row whose last message is a file, not a voice note', () => {
    const out = fillVoiceListPreviews(rows, [{ created_at: t1, attachments: [{ url: 'https://x/a.pdf', mime_type: 'application/pdf' }] }])
    expect(out).toBe(rows)
  })
  it('a row with words never changes even if a voice note shares its moment', () => {
    const out = fillVoiceListPreviews(rows, [{ created_at: t2, attachments: [{ url: 'https://x/n.m4a', mime_type: 'audio/mp4' }] }])
    expect(out[1].last_message).toBe('Hello')
  })
})

// The client may listen to a voice note but is given no way to save it (Antonio 2026-11-08). The project has no jsdom to render the
// player, so these guard the source: the portal chat asks for "no download", the staff screens keep the Download link.
describe('voice note download: staff only', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  const player = read('components/team-chat/voice-note.tsx')
  const usage = (src: string) => src.match(/<VoiceNote[^>]*?\/>/gs) ?? []

  it('the client portal chat switches the download off and shows no Download link', () => {
    const calls = usage(read('components/portal/portal-chat.tsx'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('hideDownload')
    expect(calls[0]).not.toContain('downloadable')
  })

  it('the player turns the browser download item off only when asked (TD Talk and the marketing chat keep it)', () => {
    expect(player).toContain("controlsList={hideDownload ? 'nodownload' : undefined}")
    expect(player).toContain('hideDownload = false')
    expect(player).toContain('downloadable = false')
  })

  it.each(['app/(dashboard)/portal-chats/page.tsx', 'components/contacts/contact-detail.tsx'])('%s (staff) still shows the Download link', file => {
    const calls = usage(read(file)).filter(c => c.includes('apiBase="/api/portal/chat/message"'))
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c).toContain('downloadable')
      expect(c).not.toContain('hideDownload')
    }
  })
})

// The staff Portal Chats mic records a real voice note (Antonio 2026-11-09; it used to be dictation: the words were typed into the box and the audio thrown
// away). The project has no jsdom to render the page, so these guard the source for the rules that must not slip back.
describe('staff Portal Chats mic: a real voice note, not dictation', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  const page = read('app/(dashboard)/portal-chats/page.tsx')

  it('the client-chat mic uses the voice-note recorder with MP4 preferred (an iPhone cannot play WebM)', () => {
    expect(page).toMatch(/useAudioNoteRecorder\(\{[^}]*preferMp4: true/s)
  })

  it('dictation stays only on the internal Team composer — one useVoiceInput call left, feeding the Team box', () => {
    expect(page.match(/useVoiceInput\(/g) ?? []).toHaveLength(1)
    expect(page).toContain('onTranscript: handleInternalTranscript')
    expect(page).not.toContain('onTranscript: handleTranscript')
  })

  it('a recorded note is staged as an attachment, so it goes out through the Send → Confirm & Send pop-up like any file', () => {
    expect(page).toMatch(/onRecorded: file =>[\s\S]*?handleAdminFileSelect\(file\)/)
  })

  it('a recording is only cancelled while one is in progress (cancelling while idle would swallow the next real note)', () => {
    expect(page).toMatch(/if \(!isRecordingRef\.current\) return\s+cancelRecording\(\)/)
  })

  it('Send is refused while a note is still being recorded, and the stop button wins over Send', () => {
    expect(page).toContain('Finish the voice note first')
    expect(page.indexOf('data-testid="staff-voice-stop"')).toBeLessThan(page.indexOf('data-testid="staff-voice-start"'))
    // the stop branch comes before the Send branch of the action button
    expect(page.indexOf(') : isRecording ? (')).toBeLessThan(page.indexOf(') : (replyText.trim() || pendingAdminFiles.length > 0) ? ('))
  })

  it('the staff reply alert and email say "Voice note" for a voice-only message instead of an empty preview', () => {
    const route = read('app/api/portal/chat/route.ts')
    expect(route).toContain('body: chatPreviewText(message, attachments).slice(0, 100)')
    expect(route).toContain('messagePreview: chatPreviewText(message, attachments)')
  })
})
