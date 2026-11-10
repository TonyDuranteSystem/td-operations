/**
 * Scan document: where it is hooked in, and what it must never do (dev job 26947ea3).
 * Source guards — the project has no jsdom — next to the real-browser proof recorded in docs/systems/talk.md.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { IT } from '@/lib/marketing/i18n-it'

const read = (p: string) => readFileSync(p, 'utf8')
const scanFiles = [...readdirSync('components/scan').filter(f => /\.tsx?$/.test(f)).map(f => `components/scan/${f}`), ...readdirSync('lib/scan').map(f => `lib/scan/${f}`)]

describe('where Scan document is hooked in', () => {
  it('TD Talk (and the Marketing lead chat, which uses the same box): the paperclip opens the menu; Photo or file still opens the picker; a scan joins the files like any pick', () => {
    const s = read('components/talk/talk-composer.tsx')
    expect(s).toContain('<AttachChoiceMenu')
    expect(s).toContain('setAttachMenu(o => !o)')
    expect(s).toContain("onFile={() => { setAttachMenu(false); fileRef.current?.click() }}")
    expect(s).toContain('onDone={file => { setScanning(false); pick([file]) }}')
    expect(s).toContain('const pick = (list: ArrayLike<File> | null)')
    expect(read('components/marketing/lead-chat.tsx')).toContain('TalkComposer')
  })

  it('WhatsApp: the computer paperclip has the menu, the phone "+" sheet has the Scan row, a scan goes through the normal upload', () => {
    const s = read('components/inbox/whatsapp-thread.tsx')
    expect(s).toContain('<AttachChoiceMenu')
    expect(s).toContain('onScan={() => setScanning(true)}')
    expect(s).toContain('onDone={file => { setScanning(false); void uploadAndStageFile(file) }}')
    expect(s).toContain("onFile={() => { setAttachMenu(false); handlePickFile() }}")
  })

  it('staff Portal Chats: the paperclip has the menu, the phone sheet has the Scan row, a scan goes through the normal file check', () => {
    const s = read('app/(dashboard)/portal-chats/page.tsx')
    expect(s).toContain('<AttachChoiceMenu')
    expect(s).toContain('onScan={() => setScanning(true)}')
    expect(s).toContain('onDone={file => { setScanning(false); handleAdminFileSelect(file) }}')
    expect(s).toContain("onFile={() => { setAttachMenu(false); adminFileRef.current?.click() }}")
  })

  it('Inbox email: the reply / forward composer and the New Email dialog have the menu; a scan joins the attachments like a picked file; "Photo or file" still opens the picker', () => {
    const reply = read('components/inbox/compose-reply.tsx')
    expect(reply).toContain('<AttachChoiceMenu')
    expect(reply).toContain('onDone={file => { setScanning(false); void attachments.add([file]) }}')
    expect(reply).toContain("onFile={() => { setAttachMenu(false); fileInputRef.current?.click() }}")
    const dialog = read('components/inbox/compose-dialog.tsx')
    expect(dialog).toContain('<AttachChoiceMenu')
    expect(dialog).toContain('placement="below"') // the Files row is near the top of the dialog: the menu opens downwards
    expect(dialog).toContain('onDone={file => { setScanning(false); void attachments.add([file]) }}')
    expect(dialog).toContain("onFile={() => { setAttachMenu(false); fileInputRef.current?.click() }}")
    // the Portal Chats email panel embeds the same reply composer, so it gets it too
    expect(read('components/portal-chats/thread-email-panel.tsx')).toContain('<ComposeReply')
    // the Marketing mailbox's own Attach button is NOT part of this
    expect(read('components/marketing/inbox/composer.tsx')).not.toMatch(/DocumentScanner|AttachChoiceMenu/)
  })

  it('the menu can open below its button (placement) and defaults to above', () => {
    const m = read('components/scan/attach-choice-menu.tsx')
    expect(m).toContain("placement = 'above'")
    expect(m).toContain("placement === 'below' ? 'top-full mt-2' : 'bottom-full mb-2'")
  })

  it('the phone sheet shows Scan document only when asked, and then calls the file row "Photo or file"', () => {
    const s = read('components/portal-chats/app-phone-chrome.tsx')
    expect(s).toContain('{onScan && <SheetRow label="Scan document"')
    expect(s).toContain("label={onScan ? 'Photo or file' : 'Attach a file'}")
  })

  it("the client's own portal chat does not get the scanner (staff screens only in this version)", () => {
    expect(read('components/portal/portal-chat.tsx')).not.toMatch(/DocumentScanner|AttachChoiceMenu/)
  })
})

describe('what Scan document must never do', () => {
  it('nothing leaves the phone before Send: no network call anywhere in the scanner', () => {
    for (const f of scanFiles) {
      const s = read(f)
      expect(s, f).not.toMatch(/\bfetch\s*\(/)
      expect(s, f).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/)
    }
  })

  it('asks for the back camera only — never the microphone', () => {
    const b = read('lib/scan/browser.ts')
    expect(b).toContain("facingMode: { ideal: 'environment' }")
    expect(b).toContain('audio: false')
    expect(b).not.toMatch(/audio:\s*true/)
  })

  it('stops at the page limit and cleans up its pictures and camera', () => {
    const s = read('components/scan/document-scanner.tsx')
    expect(s).toContain('canAddPage(')
    expect(s).toContain('URL.revokeObjectURL')
    expect(read('components/scan/scan-camera.tsx')).toContain('getTracks().forEach(tr => tr.stop())')
  })

  it('every new page is measured again at a higher resolution so the corners sit on the real page edge', () => {
    const s = read('components/scan/document-scanner.tsx')
    expect(s).toContain('refineQuad(')
  })
})

describe('Italian (the marketing chat shows the scanner in Italian)', () => {
  it('every English text the scanner passes to t() has an Italian version with the same {slots}', () => {
    const seen = new Set<string>()
    for (const f of scanFiles.filter(x => x.startsWith('components/scan/') && x.endsWith('.tsx'))) {
      const s = read(f)
      for (const m of Array.from(s.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g))) seen.add(m[1].replace(/\\'/g, "'"))
      for (const m of Array.from(s.matchAll(/label: '([^']+)'/g))) seen.add(m[1]) // the three looks
    }
    expect(seen.size).toBeGreaterThan(30)
    const missing = Array.from(seen).filter(k => !(k in IT))
    expect(missing).toEqual([])
    const slots = (x: string) => (x.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const k of Array.from(seen)) expect(slots(IT[k]), k).toBe(slots(k))
  })
})
