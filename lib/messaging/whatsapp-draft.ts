/**
 * Shared draft persistence for both WhatsApp composers — the "start a new
 * conversation" popup and the reply box inside an already-open conversation.
 * Originally only the popup had this (a crashed tab must not lose a draft);
 * the reply box got the identical upgraded composer (attach/AI-suggest/
 * confirm) but not this, until Antonio caught the gap (2026-09-18). One
 * module now, so the two composers can't drift on TTL or key shape again.
 */

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const draftKey = (namespace: "new" | "reply", id: string) => `td_whatsapp_draft_v1_${namespace}_${id}`

export function loadWhatsAppDraft(namespace: "new" | "reply", id: string): string {
  try {
    const raw = localStorage.getItem(draftKey(namespace, id))
    if (!raw) return ""
    const { text, savedAt } = JSON.parse(raw) as { text: string; savedAt: number }
    if (Date.now() - savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftKey(namespace, id))
      return ""
    }
    return text ?? ""
  } catch {
    return ""
  }
}

export function saveWhatsAppDraft(namespace: "new" | "reply", id: string, text: string): void {
  try {
    if (!text.trim()) {
      localStorage.removeItem(draftKey(namespace, id))
      return
    }
    localStorage.setItem(draftKey(namespace, id), JSON.stringify({ text, savedAt: Date.now() }))
  } catch {
    // Storage can be full or unavailable (private browsing) — losing a draft
    // save is not worth surfacing an error for.
  }
}
