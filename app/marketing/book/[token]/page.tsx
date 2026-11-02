'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'

/**
 * The client's page for a booking link WITH Antonio (dev job 0b916784, 1 Nov 2026; mockup approved by Antonio). No login: the link is the key. Before booking it shows the free times in the CLIENT's own time zone
 * (the browser's); after booking the same link is the page where the client moves or cancels that call. It never shows what makes a time unavailable, and every refusal is the server's own plain sentence.
 */
type Lang = 'it' | 'en'
interface View {
  state: 'open' | 'unavailable' | 'booked' | 'cancelled' | 'unusable'
  lang?: Lang; firstName?: string; sellerLabel?: string; minutes?: number; starts?: string[]; startIso?: string; endIso?: string; joinUrl?: string | null
}

const TXT = {
  it: {
    call: 'Chiamata con Antonio Durante', zoom: 'Videochiamata Zoom', tz: 'Orari nel tuo fuso orario', pickDay: 'Scegli un giorno', pickTime: 'Scegli un orario', next: 'Continua', none: 'Non ci sono orari liberi in questo periodo. Chiedi un nuovo link.',
    name: 'Il tuo nome', email: 'La tua email', confirm: 'Conferma prenotazione', change: 'Cambia orario', zoomLink: 'Il link Zoom arriva per email dopo la conferma.', saving: 'Un momento…',
    booked: 'Prenotazione confermata.', yours: 'La tua chiamata con Antonio Durante', join: 'Entra su Zoom', resched: 'Cambia orario', cancel: 'Annulla chiamata', save: 'Sposta la chiamata', keep: 'Mantieni l’orario attuale',
    sure: 'Annullare questa chiamata?', sureMsg: 'Antonio e Rocco vengono avvisati e l’orario viene liberato.', yes: 'Sì, annulla', no: 'No, mantieni', moved: 'La chiamata è stata spostata.',
    gone: 'La chiamata è stata annullata.', goneMsg: 'Se hai ancora bisogno di parlarci, chiedi un nuovo link a chi te lo ha inviato.', unusable: 'Questo link non è più valido. Chiedi un nuovo link a chi te lo ha inviato.',
    unavailable: 'Gli orari non sono disponibili in questo momento. Riprova tra qualche minuto.', emailSent: 'Ti abbiamo inviato una email di conferma con il link Zoom.', emailNot: 'Non siamo riusciti a inviare la email: salva questa pagina, contiene il link Zoom.',
  },
  en: {
    call: 'Call with Antonio Durante', zoom: 'Zoom video call', tz: 'Times shown in your time zone', pickDay: 'Choose a day', pickTime: 'Choose a time', next: 'Continue', none: 'There are no free times in this period. Ask for a new link.',
    name: 'Your name', email: 'Your email', confirm: 'Confirm booking', change: 'Change time', zoomLink: 'The Zoom link arrives by email after you confirm.', saving: 'One moment…',
    booked: 'You are booked.', yours: 'Your call with Antonio Durante', join: 'Join on Zoom', resched: 'Change time', cancel: 'Cancel call', save: 'Move my call', keep: 'Keep current time',
    sure: 'Cancel this call?', sureMsg: 'Antonio and Rocco are told, and the time is released.', yes: 'Yes, cancel', no: 'No, keep it', moved: 'Your call was moved.',
    gone: 'Your call was cancelled.', goneMsg: 'If you still need to talk, ask the person who sent you the link for a new one.', unusable: 'This link cannot be used any more. Ask the person who sent it for a new one.',
    unavailable: 'Times are not available right now. Please try again in a few minutes.', emailSent: 'We emailed you a confirmation with the Zoom link.', emailNot: 'We could not send the email: keep this page, it holds the Zoom link.',
  },
} as const

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome' } catch { return 'Europe/Rome' } }
const dayKey = (iso: string, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const hm = (iso: string, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
const longDay = (iso: string, zone: string, lang: Lang) => new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso))
const shortDay = (iso: string, zone: string, lang: Lang) => {
  const p = new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', { timeZone: zone, weekday: 'short', day: 'numeric' }).formatToParts(new Date(iso))
  return { dn: p.find(x => x.type === 'weekday')?.value ?? '', dd: p.find(x => x.type === 'day')?.value ?? '' }
}
const whenText = (start: string, end: string, zone: string, lang: Lang) => `${longDay(start, zone, lang)}, ${hm(start, zone)} – ${hm(end, zone)}`

const btn = 'rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50'
const primary = `${btn} border-[#b32236] bg-[#b32236] text-white`

function Picker({ starts, zone, lang, onPick, picked }: { starts: string[]; zone: string; lang: Lang; onPick: (iso: string) => void; picked: string | null }) {
  const t = TXT[lang]
  const days = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of starts) { const k = dayKey(s, zone); m.set(k, [...(m.get(k) ?? []), s]) }
    return Array.from(m, ([key, list]) => ({ key, list }))
  }, [starts, zone])
  const [sel, setSel] = useState<string | null>(null)
  const wanted = sel ?? (picked ? dayKey(picked, zone) : null)
  const active = days.find(d => d.key === wanted) ?? days[0]
  if (days.length === 0) return <p className="text-sm text-slate-600" data-testid="book-none">{t.none}</p>
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t.pickDay}</h3>
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t.pickDay}>
        {days.map(d => { const s = shortDay(d.list[0], zone, lang); const on = active?.key === d.key
          return <button key={d.key} type="button" aria-pressed={on} onClick={() => setSel(d.key)} data-testid="book-day" className={`min-w-[64px] flex-none rounded-xl border px-2 py-2 text-center ${on ? 'border-[#b32236] bg-rose-50' : 'bg-white'}`}><span className="block text-[11px] uppercase tracking-wide text-slate-500">{s.dn}</span><span className="block text-lg font-bold">{s.dd}</span></button> })}
      </div>
      <h3 className="text-sm font-semibold">{t.pickTime}</h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
        {(active?.list ?? []).map(iso => <button key={iso} type="button" aria-pressed={picked === iso} onClick={() => onPick(iso)} data-testid="book-time" className={`rounded-lg border px-2 py-2 text-sm font-semibold tabular-nums ${picked === iso ? 'border-[#b32236] bg-[#b32236] text-white' : 'border-[#b32236] bg-white text-[#b32236]'}`}>{hm(iso, zone)}</button>)}
      </div>
    </div>
  )
}

export default function BookPage() {
  const token = String(useParams<{ token: string }>()?.token ?? '')
  const zone = useMemo(browserZone, [])
  const [view, setView] = useState<View | null>(null)
  const [lang, setLang] = useState<Lang>('it')
  const [picked, setPicked] = useState<string | null>(null)
  const [step, setStep] = useState<'pick' | 'confirm' | 'move' | 'ask'>('pick')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // the link's own language until the client picks one: a later reload of the page never undoes his choice
  const chose = useRef(false)
  const t = TXT[lang]

  const load = useCallback(async (move = false) => {
    try {
      const res = await fetch(`/api/marketing/book/${encodeURIComponent(token)}${move ? '?move=1' : ''}`, { cache: 'no-store' })
      const d = (await res.json().catch(() => ({ state: 'unusable' }))) as View
      setView(d); if (d.lang && !chose.current) setLang(d.lang)
      if (d.firstName) setName(n => n || d.firstName || '')
    } catch { setView({ state: 'unusable' }) }
  }, [token])
  useEffect(() => { load() }, [load])
  // a client reads this page in the light look whatever the workspace's own colour setting is
  useEffect(() => { document.getElementById('tdm-root')?.setAttribute('data-tdm-theme', 'light') }, [])

  async function post(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/marketing/book/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(typeof data.error === 'string' && data.error ? data.error : t.unavailable); return { ok: false, data } }
      return { ok: true, data }
    } catch { setError(t.unavailable); return { ok: false, data: {} } } finally { setBusy(false) }
  }

  const book = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!picked) return
    const r = await post({ action: 'book', startIso: picked, name, email, zone })
    if (r.ok) { setNotice(r.data.mailed ? t.emailSent : t.emailNot); setPicked(null); setStep('pick'); await load() } else await load()
  }
  const move = async () => {
    if (!picked) return
    const r = await post({ action: 'move', startIso: picked })
    if (r.ok) { setNotice(t.moved); setPicked(null); setStep('pick'); await load() } else await load(true)
  }
  const cancel = async () => { const r = await post({ action: 'cancel' }); if (r.ok) { setStep('pick'); await load() } }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-6">
      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
          <div role="img" aria-label="Tony Durante" className="aspect-[700/270] w-52 max-w-[60%] rounded bg-white bg-left bg-no-repeat" style={{ backgroundImage: 'url(/images/logo.jpg)', backgroundSize: 'auto 100%' }} />
          <div className="flex gap-1" role="group" aria-label="Language">
            {(['it', 'en'] as const).map(l => <button key={l} type="button" aria-pressed={lang === l} onClick={() => { chose.current = true; setLang(l) }} className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${lang === l ? 'bg-slate-900 text-white' : 'bg-white'}`}>{l.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="space-y-4 px-5 py-6" data-testid="book-body">
          {!view && <p className="text-sm text-slate-500">{t.saving}</p>}
          {view?.state === 'unusable' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="book-unusable">{t.unusable}</p>}
          {view?.state === 'unavailable' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="book-unavailable">{t.unavailable}</p>}
          {view?.state === 'cancelled' && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="book-cancelled"><p className="font-semibold">{t.gone}</p><p>{t.goneMsg}</p></div>}

          {view?.state === 'open' && (
            <>
              <div>
                <h1 className="text-lg font-bold">{t.call}</h1>
                <p className="mt-1 flex flex-wrap gap-x-4 text-sm text-slate-600"><span>{view.minutes} min</span><span>{t.zoom}</span><span>{t.tz}: {zone}</span></p>
              </div>
              {step !== 'confirm' && <Picker starts={view.starts ?? []} zone={zone} lang={lang} picked={picked} onPick={setPicked} />}
              {step !== 'confirm' && <button type="button" className={primary} disabled={!picked} onClick={() => setStep('confirm')} data-testid="book-continue">{t.next}</button>}
              {step === 'confirm' && picked && (
                <form onSubmit={book} className="space-y-3" data-testid="book-form">
                  <div className="rounded-lg bg-emerald-50 p-3 text-sm"><p className="font-semibold">{whenText(picked, new Date(Date.parse(picked) + (view.minutes ?? 30) * 60_000).toISOString(), zone, lang)}</p><p className="text-slate-600">{t.zoomLink}</p></div>
                  <label className="block text-sm font-semibold">{t.name}<input id="book-name" className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={100} required /></label>
                  <label className="block text-sm font-semibold">{t.email}<input id="book-email" type="email" className="mt-1 w-full rounded-lg border px-3 py-2 font-normal" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required /></label>
                  <div className="flex flex-wrap gap-2"><button type="submit" className={primary} disabled={busy} data-testid="book-confirm">{busy ? t.saving : t.confirm}</button><button type="button" className={btn} onClick={() => setStep('pick')}>{t.change}</button></div>
                </form>
              )}
            </>
          )}

          {view?.state === 'booked' && view.startIso && view.endIso && (
            <>
              {notice && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" role="status" data-testid="book-notice">{notice}</p>}
              <h1 className="text-lg font-bold">{t.yours}</h1>
              <div className="rounded-lg bg-emerald-50 p-3 text-sm" data-testid="book-booked"><p className="font-semibold">{whenText(view.startIso, view.endIso, zone, lang)}</p><p className="text-slate-600">Zoom · {zone}</p></div>
              {view.joinUrl && <a href={view.joinUrl} className={`${primary} inline-block`} data-testid="book-join" target="_blank" rel="noreferrer">{t.join}</a>}
              {step === 'pick' && <div className="flex flex-wrap gap-2"><button type="button" className={btn} onClick={async () => { setPicked(null); setStep('move'); await load(true) }} data-testid="book-resched">{t.resched}</button><button type="button" className={`${btn} border-[#b32236] text-[#b32236]`} onClick={() => setStep('ask')} data-testid="book-cancel">{t.cancel}</button></div>}
              {step === 'move' && (
                <div className="space-y-3">
                  <Picker starts={view.starts ?? []} zone={zone} lang={lang} picked={picked} onPick={setPicked} />
                  <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={!picked || busy} onClick={move} data-testid="book-save">{t.save}</button><button type="button" className={btn} onClick={() => { setPicked(null); setStep('pick') }}>{t.keep}</button></div>
                </div>
              )}
              {step === 'ask' && (
                <div className="space-y-3 rounded-lg bg-amber-50 p-3" data-testid="book-ask">
                  <p className="text-sm font-semibold">{t.sure}</p><p className="text-sm text-slate-700">{t.sureMsg}</p>
                  <div className="flex flex-wrap gap-2"><button type="button" className={`${btn} border-[#b32236] text-[#b32236]`} disabled={busy} onClick={cancel} data-testid="book-cancel-yes">{t.yes}</button><button type="button" className={btn} onClick={() => setStep('pick')}>{t.no}</button></div>
                </div>
              )}
            </>
          )}
          {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800" data-testid="book-error">{error}</p>}
        </div>
      </div>
    </main>
  )
}
