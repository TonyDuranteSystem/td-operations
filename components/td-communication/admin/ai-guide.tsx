'use client'

import { useState } from 'react'
import { Sparkles, Loader2, Wand2, LayoutList, Palette, Power, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * TD Communication → AI tab. A plain-English guide to the branding AI (what it
 * does, how it works, how to use it) plus a live "Try it" playground that calls
 * the same staff preview endpoint the Questions editor uses. Static content +
 * one fetch; no new backend.
 */

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-blue-600">{icon}</span>
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      </div>
      <div className="text-sm leading-relaxed text-zinc-600 space-y-2">{children}</div>
    </div>
  )
}

function Playground() {
  const [question, setQuestion] = useState('Tell us about your business. What do you do?')
  const [context, setContext] = useState(
    'We roast and sell specialty coffee beans online to home baristas across Italy. A small team focused on quality, sustainability, and personal service.',
  )
  const [lang, setLang] = useState<'en' | 'it'>('en')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/td-communication/admin/ai-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionLabel: question.trim(), sampleContext: context, locale: lang }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not generate. Please try again.')
      }
      const data = await res.json()
      setOut(typeof data.text === 'string' ? data.text : '')
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'Could not generate. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200'

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-zinc-900">Try it yourself</h3>
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-zinc-200 text-[11px]">
          {(['en', 'it'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={cn('px-2 py-0.5 font-medium', lang === l ? 'bg-blue-600 text-white' : 'bg-white text-zinc-600 hover:bg-zinc-50')}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        This is exactly what a client sees when they press ✨ Generate. Type a question and a sample business, then generate. Nothing is saved.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-600">Question</span>
        <input className={inputCls} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-600">Sample business description</span>
        <textarea className={cn(inputCls, 'resize-none')} rows={3} value={context} onChange={(e) => setContext(e.target.value)} />
      </label>

      <button
        type="button"
        onClick={run}
        disabled={busy || !question.trim() || !context.trim()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {out !== null ? 'Regenerate' : 'Generate a sample'}
      </button>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {out !== null && !err && (
        <div className="rounded-lg border border-blue-200 bg-white p-3">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-blue-600">Sample draft ({lang.toUpperCase()})</p>
          <p className="whitespace-pre-wrap text-sm text-zinc-800">{out}</p>
        </div>
      )}
    </div>
  )
}

export function AiGuide() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl space-y-5 pb-8">
        {/* Intro */}
        <div className="rounded-xl border border-zinc-200 bg-gradient-to-br from-blue-50 to-white p-5">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-bold text-zinc-900">TD Communication AI</h2>
          </div>
          <p className="text-sm leading-relaxed text-zinc-600">
            The branding service has a built-in AI assistant that helps in two places: it helps <strong>clients write</strong> their
            brand-audit answers, and it gives <strong>Cris a head start</strong> by summarizing each client into a creative brief.
            It uses Anthropic&rsquo;s Claude and is always optional — a helper, never an automatic decision-maker.
          </p>
        </div>

        {/* What it does */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">What it does</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card icon={<Wand2 className="h-4 w-4" />} title="Helps the client write">
              <p>
                On the brand-audit questionnaire, writing questions get a <strong>&ldquo;Generate with AI&rdquo;</strong> button.
                It drafts an answer based on what the client has already told us. They can use it, add it to what they wrote, rewrite it, or ignore it.
              </p>
              <p className="text-zinc-500">Their own words are never overwritten — it only fills the box if they choose to.</p>
            </Card>
            <Card icon={<Palette className="h-4 w-4" />} title="Summarizes for Cris">
              <p>
                At the top of each project brief, Cris can generate an <strong>AI Brand Profile</strong>: a suggested colour palette,
                a short read on the brand&rsquo;s personality, a style direction, and a mood.
              </p>
              <p className="text-zinc-500">It&rsquo;s a starting point to react to — not a final design.</p>
            </Card>
          </div>
        </div>

        {/* How it works */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">How it works</h3>
          <Card icon={<Info className="h-4 w-4" />} title="In plain English">
            <ul className="list-disc space-y-1.5 pl-4">
              <li>It reads the client&rsquo;s <strong>other answers</strong> as context, so the draft fits their business — it doesn&rsquo;t invent a company.</li>
              <li>The client&rsquo;s language is respected: an Italian client gets an Italian draft, an English client gets English.</li>
              <li>The brand profile is <strong>saved</strong> the first time it&rsquo;s generated. If the client later changes their answers, Cris sees a note to regenerate.</li>
              <li>Nothing is sent anywhere or shown to the client automatically — the AI only runs when someone presses a button.</li>
            </ul>
          </Card>
        </div>

        {/* How to use it */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">How to use it</h3>
          <div className="space-y-3">
            <Card icon={<Wand2 className="h-4 w-4" />} title="Clients — automatic">
              <p>Nothing to set up. When a client fills the brand audit, the ✨ button appears on the writing questions on its own.</p>
            </Card>
            <Card icon={<Palette className="h-4 w-4" />} title="Cris & staff — on the brief">
              <p>
                Open any project (Projects or Enrollments tab) → the <strong>AI Brand Profile</strong> card is at the top of the brief.
                Press <strong>Generate</strong>. Press <strong>Regenerate</strong> anytime to get a fresh take.
              </p>
            </Card>
            <Card icon={<LayoutList className="h-4 w-4" />} title="You — turn it on or off per question">
              <p>
                Go to the <strong>Questions</strong> tab → edit a writing question → tick <strong>✨ AI assist</strong> to show or hide the button for that question.
                Right there in the editor you can also <strong>preview</strong> what the AI would produce.
              </p>
            </Card>
          </div>
        </div>

        {/* Controls */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Controls &amp; cost</h3>
          <Card icon={<Power className="h-4 w-4" />} title="Master on/off switch">
            <p>
              The <strong>Settings</strong> tab has an <strong>AI features</strong> switch. Turn it off and every AI button stops working
              instantly across the whole service — no developer or deploy needed. Each generation is a paid AI call, so the switch is
              there if you ever want to pause it.
            </p>
          </Card>
        </div>

        {/* Playground */}
        <Playground />
      </div>
    </div>
  )
}
