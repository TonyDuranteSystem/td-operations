'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { isInternalNavHref } from '@/lib/nav/nav-link'
import {
  evaluateFrame,
  summarize,
  type FrameSnapshot,
  type FrameVerdict,
} from '@/lib/embed/spike-evaluate'

const DEFAULT_PAGES = ['/inbox', '/accounts', '/tasks']

/** Reads one frame's document (same site, so allowed) into a plain snapshot. */
function snapshotFrame(frame: HTMLIFrameElement | null, src: string): FrameSnapshot {
  const empty: FrameSnapshot = {
    src,
    pathname: '',
    embeddedAttr: null,
    hasSidebar: false,
    hasMain: false,
    alertPolls: 0,
  }
  try {
    const w = frame?.contentWindow
    const d = frame?.contentDocument
    if (!w || !d) return { ...empty, error: 'the frame is not available' }
    const marker = d.querySelector('[data-embedded]')
    const alertPolls = w.performance
      .getEntriesByType('resource')
      .filter(e => e.name.includes('/api/team/threads')).length
    return {
      src,
      pathname: w.location.pathname,
      embeddedAttr: marker ? marker.getAttribute('data-embedded') : null,
      hasSidebar: !!d.querySelector('aside'),
      hasMain: !!d.querySelector('main'),
      alertPolls,
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : 'the frame could not be read' }
  }
}

export default function WindowSpike({ flagOn }: { flagOn: boolean }) {
  const [pages, setPages] = useState<string[]>(DEFAULT_PAGES)
  const [reloadKey, setReloadKey] = useState(0)
  const [custom, setCustom] = useState('')
  const [verdicts, setVerdicts] = useState<FrameVerdict[] | null>(null)
  const [stamp, setStamp] = useState('')
  const frames = useRef<(HTMLIFrameElement | null)[]>([])

  const check = useCallback(
    (label: string) => {
      const vs = pages.map((src, i) => evaluateFrame(snapshotFrame(frames.current[i] ?? null, src)))
      setVerdicts(vs)
      setStamp(`${label} · ${new Date().toLocaleTimeString()}`)
    },
    [pages],
  )

  const reloadAll = () => {
    setVerdicts(null)
    setStamp('')
    setReloadKey(k => k + 1)
  }

  const refreshInside = () => {
    frames.current.forEach(f => f?.contentWindow?.postMessage({ type: 'td-spike-refresh' }, window.location.origin))
    // Give the refresh a moment to land, then check again.
    window.setTimeout(() => check('after a refresh inside each window'), 2500)
  }

  const addPage = () => {
    const p = custom.trim()
    if (!isInternalNavHref(p)) {
      toast.error('Enter a normal CRM page address that starts with a single "/".')
      return
    }
    if (pages.length >= 3) {
      toast.error('The test uses at most 3 windows. Remove one first.')
      return
    }
    setPages(prev => [...prev, p])
    setCustom('')
    setVerdicts(null)
  }

  const summary = verdicts ? summarize(verdicts) : null

  const copyResults = () => {
    if (!verdicts || !summary) return
    const lines = [
      `Window test ${stamp}`,
      summary.text,
      ...verdicts.map(v => `${v.pass ? 'PASS' : 'FAIL'} ${v.src}: ` + v.checks.map(c => `${c.pass ? 'ok' : 'NO'} ${c.label} (${c.detail})`).join(' | ')),
    ].join('\n')
    navigator.clipboard
      ?.writeText(lines)
      .then(() => toast.success('Results copied.'))
      .catch(() => toast.error('Could not copy. Select the results and copy them by hand.'))
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Floating window test</h1>
        <p className="text-sm text-zinc-600 mt-1">
          Throwaway test for the floating-window project (dev job f3f3e237, step 3). It loads real CRM pages
          inside frames, the way floating windows would, and checks that each one is a bare page: no left menu,
          no alert sounds, and that it survives a refresh.
        </p>
      </div>

      {flagOn ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Window mode is ON for this address. Frames below should load as bare pages.
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Window mode is OFF on this address, so every frame will load as the full CRM and the checks will FAIL.
          That is the normal state everywhere except the private test address.
        </div>
      )}

      <ol className="list-decimal pl-5 text-sm text-zinc-700 space-y-1">
        <li>Wait for the three frames to finish loading, then press <b>Check now</b>.</li>
        <li>Press <b>Refresh inside each window</b>. Nothing should come back as a full CRM.</li>
        <li>Press <b>Reload all three at once</b> and then <b>Check now</b>. This is the login-token test: three windows
          asking for the same login at the same moment. Do it again after you have been signed in for about an hour,
          which is when the login token runs out.</li>
        <li>Press <b>Copy results</b> and paste them to Claude.</li>
      </ol>

      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={() => check('check')} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Check now</button>
        <button onClick={refreshInside} className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 hover:bg-zinc-50">Refresh inside each window</button>
        <button onClick={reloadAll} className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 hover:bg-zinc-50">Reload all three at once</button>
        <button onClick={copyResults} disabled={!verdicts} className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 hover:bg-zinc-50 disabled:opacity-40">Copy results</button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={custom}
          onChange={e => setCustom(e.target.value)}
          placeholder="Another page, e.g. /leads"
          className="px-2 py-1.5 text-sm border border-zinc-300 rounded-md w-56"
          aria-label="Another CRM page address"
        />
        <button onClick={addPage} className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 hover:bg-zinc-50">Add page</button>
        <button onClick={() => { setPages(DEFAULT_PAGES); setVerdicts(null) }} className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 hover:bg-zinc-50">Back to the 3 default pages</button>
      </div>

      {summary && (
        <div className={`rounded-md border px-3 py-2 text-sm ${summary.pass ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'}`}>
          <div className="font-semibold">{summary.text}</div>
          <div className="text-xs opacity-70">{stamp}</div>
          <ul className="mt-2 space-y-2">
            {verdicts!.map(v => (
              <li key={v.src}>
                <div className="font-medium">{v.pass ? '✔' : '✘'} {v.src}</div>
                <ul className="ml-4 text-xs">
                  {v.checks.map(c => (
                    <li key={c.id}>{c.pass ? '✔' : '✘'} {c.label} — {c.detail}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* One column on purpose: a frame under ~1024px wide makes pages switch to their phone
          layout, which would test the wrong thing. Each frame gets the full page width. */}
      <div className="grid gap-3">
        {pages.map((src, i) => (
          <div key={`${src}-${reloadKey}`} className="rounded-md border border-zinc-300 bg-white overflow-hidden">
            <div className="bg-zinc-800 text-white text-xs px-2 py-1">{src}</div>
            <iframe
              ref={el => { frames.current[i] = el }}
              src={src}
              title={`Window test ${src}`}
              className="w-full h-[420px] border-0"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
