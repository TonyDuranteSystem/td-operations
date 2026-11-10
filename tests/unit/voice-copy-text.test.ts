/**
 * "Copy text" on voice notes (dev job 26947ea3, Antonio 2026-11-10: "I can't copy a transcript from a voice message").
 * The TD Talk / marketing-chat bubble blocks selecting text and its long-press Copy only copies typed words, so the
 * words of a voice note get their own button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { transcriptCopyText, type VoiceTranscript } from '@/lib/team/voice-text'
import { copyTextToClipboard } from '@/lib/ui/copy-to-clipboard'

const t = (over: Partial<VoiceTranscript> = {}): VoiceTranscript => ({ text: 'Ciao, come stai?', language: 'italian', english: null, at: '2026-11-10T10:00:00Z', ...over })

describe('transcriptCopyText', () => {
  it('copies just the words when there is one version', () => {
    expect(transcriptCopyText(t({ language: 'english', text: 'Hello there' }))).toBe('Hello there')
    expect(transcriptCopyText(t())).toBe('Ciao, come stai?')
  })

  it('copies both versions, English first, each under its language, when there are two', () => {
    expect(transcriptCopyText(t({ english: 'Hi, how are you?' }))).toBe('English:\nHi, how are you?\n\nItalian:\nCiao, come stai?')
  })

  it('keeps line breaks inside the words', () => {
    expect(transcriptCopyText(t({ language: 'english', text: 'One\nTwo' }))).toBe('One\nTwo')
  })
})

describe('copyTextToClipboard', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('uses the browser clipboard when it is there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyTextToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to the hidden-box copy when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } })
    const box = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() }
    const execCommand = vi.fn().mockReturnValue(true)
    const appendChild = vi.fn(); const removeChild = vi.fn()
    vi.stubGlobal('document', { createElement: () => box, body: { appendChild, removeChild }, execCommand })
    await expect(copyTextToClipboard('hello')).resolves.toBe(true)
    expect(box.value).toBe('hello')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(removeChild).toHaveBeenCalled() // the hidden box never stays on the page
  })

  it('falls back when there is no clipboard at all (in-app web view)', async () => {
    vi.stubGlobal('navigator', {})
    const box = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() }
    vi.stubGlobal('document', { createElement: () => box, body: { appendChild: vi.fn(), removeChild: vi.fn() }, execCommand: vi.fn().mockReturnValue(true) })
    await expect(copyTextToClipboard('x')).resolves.toBe(true)
  })

  it('says false (never throws) when nothing can copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } })
    vi.stubGlobal('document', { createElement: () => { throw new Error('no DOM') }, body: {} })
    await expect(copyTextToClipboard('x')).resolves.toBe(false)
  })

  it('says false on a page with no document at all', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)
    await expect(copyTextToClipboard('x')).resolves.toBe(false)
  })
})

describe('wiring (source guards — the project has no jsdom)', () => {
  const player = readFileSync('components/team-chat/voice-note.tsx', 'utf8')
  const client = readFileSync('components/portal/portal-chat.tsx', 'utf8')
  const wa = readFileSync('components/inbox/whatsapp-voice-note.tsx', 'utf8')
  const it_ = readFileSync('lib/marketing/i18n-it.ts', 'utf8')

  it('the shared player shows Copy text beside Show text, only once the words are on screen, and copies the shared text', () => {
    expect(player).toContain('data-testid="voice-copy-text"')
    expect(player).toContain('copyable && transcript && open')
    expect(player).toContain('copyTextToClipboard(transcriptCopyText(transcript))')
    expect(player).toContain('copyable = true')
  })

  it('the client-portal chat does not get the button (staff screens only for now)', () => {
    expect(client).toMatch(/<VoiceNote[\s\S]*?hideDownload\s+copyable=\{false\}/)
  })

  it('WhatsApp\'s own player has the button too', () => {
    expect(wa).toContain('data-testid="voice-copy-text"')
    expect(wa).toContain('copyTextToClipboard(voice.transcript)')
  })

  it('the marketing chat (Italian) has the words for the button', () => {
    expect(it_).toContain('"Copy text": "Copia il testo"')
    expect(it_).toContain('"Copied": "Copiato"')
    expect(it_).toContain('"Could not copy.":')
  })
})
