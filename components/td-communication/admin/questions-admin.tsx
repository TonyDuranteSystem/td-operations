'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Pencil, ArchiveX, Loader2, X, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TdCommQuestion, TdCommOption, QuestionFieldType, QuestionAudience } from '@/lib/td-communication/types'

const TYPES: QuestionFieldType[] = ['text', 'textarea', 'select', 'number', 'file']
const AUDIENCES: { value: QuestionAudience; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'new_brand', label: 'New brand' },
  { value: 'rebrand', label: 'Rebrand' },
]
const AUDIENCE_BADGE: Record<QuestionAudience, string> = {
  both: 'bg-zinc-100 text-zinc-700',
  new_brand: 'bg-blue-100 text-blue-800',
  rebrand: 'bg-purple-100 text-purple-800',
}

/** Editable row in the option repeater. Empty strings render as blanks. */
interface OptionRow {
  value: string
  label_en: string
  label_it: string
  description_en: string
  description_it: string
}

interface FormState {
  key: string
  label_en: string
  label_it: string
  type: QuestionFieldType
  required: boolean
  step: string
  audience: QuestionAudience
  options: OptionRow[]
  ai_assist: boolean
  active: boolean
  sort_order: string
}

const EMPTY_OPTION: OptionRow = { value: '', label_en: '', label_it: '', description_en: '', description_it: '' }

function optionToRow(o: TdCommOption): OptionRow {
  return {
    value: o.value,
    label_en: o.label_en,
    label_it: o.label_it ?? '',
    description_en: o.description_en ?? '',
    description_it: o.description_it ?? '',
  }
}

function toForm(q: TdCommQuestion): FormState {
  return {
    key: q.key, label_en: q.label_en, label_it: q.label_it ?? '', type: q.type,
    required: q.required, step: String(q.step), audience: q.audience,
    options: q.options.map(optionToRow), ai_assist: q.ai_assist, active: q.active, sort_order: String(q.sort_order),
  }
}
const EMPTY_FORM: FormState = {
  key: '', label_en: '', label_it: '', type: 'text', required: false,
  step: '1', audience: 'both', options: [], ai_assist: false, active: true, sort_order: '0',
}

/** A repeater row → clean TdCommOption; drops rows with no value AND no label. */
function rowToOption(r: OptionRow): TdCommOption | null {
  const value = r.value.trim() || r.label_en.trim()
  const label_en = r.label_en.trim() || r.value.trim()
  if (!value && !label_en) return null
  const s = (v: string) => (v.trim() ? v.trim() : null)
  return {
    value,
    label_en: label_en || value,
    label_it: s(r.label_it),
    description_en: s(r.description_en),
    description_it: s(r.description_it),
  }
}

function toPayload(f: FormState, _isCreate: boolean) {
  const options = f.type === 'select'
    ? f.options.map(rowToOption).filter((o): o is TdCommOption => o !== null)
    : []
  return {
    key: f.key.trim(),
    label_en: f.label_en.trim(),
    label_it: f.label_it.trim() || null,
    type: f.type,
    required: f.required,
    step: Number(f.step || '1'),
    audience: f.audience,
    options,
    // AI assist only applies to textareas; force false otherwise so a flag can't
    // linger on a field type that changed away from textarea.
    ai_assist: f.type === 'textarea' ? f.ai_assist : false,
    active: f.active,
    sort_order: Number(f.sort_order || '0'),
  }
}

export function QuestionsAdmin({ isAdmin }: { isAdmin: boolean }) {
  const [questions, setQuestions] = useState<TdCommQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<TdCommQuestion | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/td-communication/admin/questions')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load questions.')
      }
      const data = await res.json()
      setQuestions(Array.isArray(data.questions) ? data.questions : [])
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load questions.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Group active+inactive by step for display.
  const byStep = useMemo(() => {
    const map = new Map<number, TdCommQuestion[]>()
    for (const q of questions) {
      const arr = map.get(q.step) ?? []
      arr.push(q)
      map.set(q.step, arr)
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0])
  }, [questions])

  async function softDelete(q: TdCommQuestion) {
    if (!confirm(`Remove question "${q.label_en}"?`)) return
    try {
      const res = await fetch(`/api/td-communication/admin/questions/${q.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to remove question.')
      }
      toast.success('Question removed.')
      void load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to remove question.')
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <p className="text-sm text-zinc-500">Brand-audit questions shown to clients during enrollment. Grouped by step.</p>
        {isAdmin && (
          <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium px-3 py-1.5">
            <Plus className="w-4 h-4" /> Add question
          </button>
        )}
      </div>

      {questions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center">
          <div><HelpCircle className="h-10 w-10 text-zinc-300 mx-auto mb-3" /><p className="text-sm text-zinc-500">No questions yet.</p></div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-0.5">
          {byStep.map(([step, items]) => (
            <div key={step}>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">Step {step}</h4>
              <div className="border rounded-lg bg-white divide-y divide-gray-100">
                {items.map((q) => (
                  <div key={q.id} className={cn('flex items-center justify-between gap-3 px-3 py-2', !q.active && 'opacity-50')}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-zinc-900">{q.label_en}</span>
                        {q.required && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">Required</span>}
                        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', AUDIENCE_BADGE[q.audience])}>
                          {AUDIENCES.find((a) => a.value === q.audience)?.label}
                        </span>
                        {!q.active && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">Inactive</span>}
                      </div>
                      <span className="text-xs text-zinc-400">{q.key} · {q.type}</span>
                    </div>
                    {isAdmin && (
                      <div className="shrink-0 whitespace-nowrap">
                        <button onClick={() => setEditing(q)} className="text-zinc-500 hover:text-blue-700 p-1" title="Edit"><Pencil className="w-4 h-4" /></button>
                        {q.active && <button onClick={() => softDelete(q)} className="text-zinc-500 hover:text-red-700 p-1" title="Remove"><ArchiveX className="w-4 h-4" /></button>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <QuestionModal title="Add question" initial={EMPTY_FORM} isCreate onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load() }} />
      )}
      {editing && (
        <QuestionModal title={`Edit “${editing.label_en}”`} initial={toForm(editing)} isCreate={false} id={editing.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />
      )}
    </div>
  )
}

function QuestionModal({
  title, initial, isCreate, id, onClose, onSaved,
}: {
  title: string
  initial: FormState
  isCreate: boolean
  id?: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(initial)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof FormState>(k: K, v: FormState[K]) { setForm((f) => ({ ...f, [k]: v })) }

  function setOption<K extends keyof OptionRow>(idx: number, k: K, v: OptionRow[K]) {
    setForm((f) => ({ ...f, options: f.options.map((o, i) => (i === idx ? { ...o, [k]: v } : o)) }))
  }
  function addOption() { setForm((f) => ({ ...f, options: [...f.options, { ...EMPTY_OPTION }] })) }
  function removeOption(idx: number) { setForm((f) => ({ ...f, options: f.options.filter((_, i) => i !== idx) })) }

  async function submit() {
    setBusy(true)
    try {
      const url = isCreate
        ? '/api/td-communication/admin/questions'
        : `/api/td-communication/admin/questions/${id}`
      const res = await fetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload(form, isCreate)),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save question.')
      }
      toast.success(isCreate ? 'Question created.' : 'Question updated.')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to save question.')
    } finally {
      setBusy(false)
    }
  }

  const label = 'block text-xs font-medium text-gray-700 mb-1'
  const input = 'w-full border rounded px-2 py-1.5 text-sm'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-white">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block"><span className={label}>Key *</span>
            <input className={input} value={form.key} onChange={(e) => set('key', e.target.value)} placeholder="business_name" />
            <span className="text-[11px] text-zinc-400">Stored answer key (lowercase, _ or -).</span></label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={label}>Label (EN) *</span>
              <input className={input} value={form.label_en} onChange={(e) => set('label_en', e.target.value)} /></label>
            <label className="block"><span className={label}>Label (IT)</span>
              <input className={input} value={form.label_it} onChange={(e) => set('label_it', e.target.value)} /></label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block"><span className={label}>Type</span>
              <select className={input} value={form.type} onChange={(e) => set('type', e.target.value as QuestionFieldType)}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label className="block"><span className={label}>Audience</span>
              <select className={input} value={form.audience} onChange={(e) => set('audience', e.target.value as QuestionAudience)}>
                {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select></label>
            <label className="block"><span className={label}>Step</span>
              <input className={input} type="number" min="1" value={form.step} onChange={(e) => set('step', e.target.value)} /></label>
          </div>

          {form.type === 'select' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className={label}>Options</span>
                <button type="button" onClick={addOption} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
                  <Plus className="w-3.5 h-3.5" /> Add option
                </button>
              </div>
              {form.options.length === 0 ? (
                <p className="text-[11px] text-zinc-400 border rounded px-2 py-2">No options yet — add at least one.</p>
              ) : (
                <div className="space-y-2">
                  {form.options.map((o, idx) => (
                    <div key={idx} className="border rounded p-2 bg-zinc-50/60 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <input className={input} value={o.value} onChange={(e) => setOption(idx, 'value', e.target.value)} placeholder="value (stored)" />
                        <button type="button" onClick={() => removeOption(idx)} className="shrink-0 text-zinc-400 hover:text-red-600 p-1" title="Remove option"><X className="w-4 h-4" /></button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input className={input} value={o.label_en} onChange={(e) => setOption(idx, 'label_en', e.target.value)} placeholder="Label (EN)" />
                        <input className={input} value={o.label_it} onChange={(e) => setOption(idx, 'label_it', e.target.value)} placeholder="Label (IT)" />
                        <input className={input} value={o.description_en} onChange={(e) => setOption(idx, 'description_en', e.target.value)} placeholder="Description (EN)" />
                        <input className={input} value={o.description_it} onChange={(e) => setOption(idx, 'description_it', e.target.value)} placeholder="Description (IT)" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <span className="text-[11px] text-zinc-400">Value is stored in the answer; the label (EN/IT) is shown to the client, with the description folded in.</span>
            </div>
          )}

          <div className="flex items-center gap-4">
            <label className="block flex-1"><span className={label}>Sort order</span>
              <input className={input} type="number" value={form.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></label>
            <label className="flex items-center gap-2 text-sm text-gray-700 pt-5">
              <input type="checkbox" checked={form.required} onChange={(e) => set('required', e.target.checked)} /> Required
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 pt-5">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active
            </label>
          </div>

          {/* AI assist — only meaningful on a textarea (the ✨ Generate button). */}
          {form.type === 'textarea' && (
            <label className="flex items-start gap-2 text-sm text-gray-700 border rounded-lg px-3 py-2 bg-zinc-50/60">
              <input type="checkbox" className="mt-0.5" checked={form.ai_assist} onChange={(e) => set('ai_assist', e.target.checked)} />
              <span>
                <span className="block font-medium">✨ AI assist</span>
                <span className="block text-xs text-zinc-500">Show the “Generate with AI” button on this question so clients can draft an answer they then edit.</span>
              </span>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t sticky bottom-0 bg-white">
          <button onClick={onClose} className="border text-gray-700 hover:bg-gray-50 text-sm rounded font-medium px-3 py-1.5">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded font-medium px-3 py-1.5">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  )
}
