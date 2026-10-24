'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { contactChips, type ContactState } from '@/lib/marketing/contact-state'
import { fillTemplate, firstName, unfillTemplate, whatsappLink, type TemplateView } from '@/lib/marketing/templates'
import { formatWhen } from '@/lib/marketing/lead-view'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'

interface Props {
  leadId: string
  /** whether this person may record anything on the lead (marked + not someone else's) */
  canAct: boolean
  contact: ContactState
  leadName: string | null
  /** null when the person may not see phone numbers or the lead has none */
  phone: string | null
  setterName: string
  templates: TemplateView[]
  /** the team owner may save the text in the box as a template (everyone may use the templates) */
  canEditTemplates?: boolean
}

const btn = 'rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50'
const TONE = { ok: 'bg-emerald-50 text-emerald-800 border-emerald-200', warn: 'bg-amber-50 text-amber-800 border-amber-200', info: 'bg-sky-50 text-sky-800 border-sky-200' } as const

/** The daily reaching-out: the WhatsApp with the message typed in, "sent / no WhatsApp / no answer", and the booked call. Every server answer is shown as the server wrote it. */
export function ContactPanel({ leadId, canAct, contact, leadName, phone, setterName, templates, canEditTemplates }: Props) {
  const router = useRouter()
  const t = useT()
  const lang = useLang()
  const loc = localeFor(lang)
  const fw = (iso: string) => formatWhen(iso, 'Europe/Rome', loc)
  const firstKey = contact.whatsapp === 'sent' || contact.attempts > 0 ? 'no_answer' : 'first_contact'
  const [tplKey, setTplKey] = useState(templates.some(t => t.key === firstKey) ? firstKey : templates[0]?.key ?? '')
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // saving the text in the box as a template (owner only): 'new' asks for a name, 'update' replaces the wording of the template picked, in this language
  const [saving, setSaving] = useState<{ mode: 'new' | 'update'; name: string } | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const tpl = templates.find(t => t.key === tplKey)
  const whenText = contact.appointmentAt ? fw(contact.appointmentAt) : ''
  const message = edited ?? (tpl ? fillTemplate(tpl.text, { name: firstName(leadName), setter: setterName, when: whenText }) : '')
  const link = whatsappLink(phone, message)
  const chips = contactChips(contact, fw, t)

  // the text as a template: this lead's name, this setter's name and this call time go back to {name} {setter} {when}
  const asTemplate = unfillTemplate(message, { name: firstName(leadName), setter: setterName, when: whenText })
  async function saveTemplate() {
    if (!saving) return
    setBusy(true); setError(null)
    try {
      const field = lang === 'it' ? 'it' : 'en'
      const body = saving.mode === 'update' && tpl ? { action: 'save', key: tpl.key, [field]: asTemplate } : { action: 'save', label: saving.name, [field]: asTemplate }
      const res = await fetch('/api/marketing/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('Could not save. Please try again.')) }
      setSaving(null); setSavedNote(t('Template saved. Everyone on the team can use it now.')); setTimeout(() => setSavedNote(null), 4000)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally { setBusy(false) }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(message); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError(t('Could not copy. Select the text and copy it by hand.')) }
  }

  async function send(body: Record<string, unknown>) {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/leads/${leadId}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('Could not save. Please try again.')) }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not save. Please try again.'))
    } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border bg-white p-4" data-testid="contact-panel">
      <h2 className="text-sm font-semibold text-slate-600">{t('Reaching out')}</h2>
      <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('What has been done')}>
        {chips.length === 0 ? <span className="text-sm text-slate-500">{t('Not contacted yet.')}</span> : chips.map(c => <span key={c.key} className={`rounded-full border px-2.5 py-0.5 text-xs ${TONE[c.tone]}`}>{c.text}</span>)}
      </div>

      {canAct && (
        <>
          <div className="mt-4 space-y-2 text-sm">
            <label className="block">
              <span className="text-slate-500">{t('Message')}</span>
              <select className="mt-1 w-full rounded-lg border px-3 py-2" value={tplKey} onChange={e => { setTplKey(e.target.value); setEdited(null) }} data-testid="template-select">
                {templates.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <textarea className="w-full rounded-lg border px-3 py-2" rows={6} value={message} onChange={e => setEdited(e.target.value)} aria-label={t('Message text')} data-testid="message-text" />
            {edited !== null && <button type="button" className="text-xs text-slate-500 underline" onClick={() => setEdited(null)}>{t('Back to the saved wording')}</button>}
            {canEditTemplates && message.trim() !== '' && (
              <div className="space-y-2 rounded-lg border border-dashed p-2.5" data-testid="save-template-box">
                {saving === null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={btn} data-testid="save-as-template" onClick={() => { setError(null); setSaving({ mode: 'new', name: '' }) }}>{t('Save as template')}</button>
                    {tpl && edited !== null && <button type="button" className={btn} data-testid="update-template" onClick={() => { setError(null); setSaving({ mode: 'update', name: tpl.label }) }}>{t('Update "{name}"', { name: tpl.label })}</button>}
                    <span className="text-xs text-slate-500">{t('As the team owner you can keep this wording as a template for everyone.')}</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {saving.mode === 'new' && <input value={saving.name} onChange={e => setSaving({ mode: 'new', name: e.target.value })} maxLength={80} placeholder={t('Name of the template')} aria-label={t('Name of the template')} data-testid="template-name" className="w-full rounded-lg border px-3 py-1.5 text-sm" />}
                    <p className="text-xs text-slate-500">{t('It will be saved as:')} <span className="whitespace-pre-wrap text-slate-700" data-testid="template-as-saved">{asTemplate}</span></p>
                    <div className="flex gap-2">
                      <button type="button" className={`${btn} bg-slate-900 text-white`} disabled={busy || (saving.mode === 'new' && saving.name.trim() === '')} data-testid="confirm-save-template" onClick={saveTemplate}>{busy ? t('Saving…') : t('Save template')}</button>
                      <button type="button" className={btn} onClick={() => setSaving(null)}>{t('Cancel')}</button>
                    </div>
                  </div>
                )}
                {savedNote && <p role="status" className="text-xs text-emerald-700" data-testid="template-saved">{savedNote}</p>}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {link
              ? <a className={`${btn} bg-emerald-600 text-white`} href={link} target="_blank" rel="noopener noreferrer" data-testid="open-whatsapp">{t('Open WhatsApp with this message')}</a>
              : <span className="self-center text-xs text-slate-500">{phone ? t('This number cannot be used for WhatsApp.') : t('No phone number to write to.')}</span>}
            <button type="button" className={btn} onClick={copy} data-testid="copy-message">{copied ? t('Copied') : t('Copy message')}</button>
            <button className={btn} disabled={busy} onClick={() => send({ action: 'whatsapp', state: 'sent', template: tplKey || undefined })}>{t('I sent it')}</button>
            <button className={btn} disabled={busy} onClick={() => send({ action: 'whatsapp', state: 'no_wa' })}>{t('No WhatsApp')}</button>
            <button className={btn} disabled={busy} onClick={() => send({ action: 'no_answer', via: 'call' })}>{t('No answer')}</button>
          </div>
          <p className="mt-1 text-xs text-slate-400">{t('WhatsApp opens with the message typed in — you press Send there, then "I sent it" here.')}</p>

        </>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </section>
  )
}
