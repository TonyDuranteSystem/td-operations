'use client'

import { useEffect, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { WORDING_LIMITS, type EditableWording, type FieldErrors } from '@/lib/contracts/contract-wording'
import { CONTRACT_PREVIEW_CSS } from './contract-preview'

/**
 * Editing a contract draft "on the contract itself": every sentence is a text box that looks like the printed line,
 * in the same order the client reads them. Lists have × and "+ Add a line". The standard sections (parties, fee table,
 * payment, liability cap, governing law, e-signatures) are not editable here and are said to be standard.
 * Problems from the validator arrive keyed by line (`fieldErrors`) and are shown right under that line.
 */

type Change = (next: EditableWording) => void

function AutoText({
  value,
  onChange,
  placeholder,
  errors,
  bold,
  center,
  title,
  label,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  errors?: string[]
  bold?: boolean
  center?: boolean
  title?: boolean
  label: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const fit = () => {
      const el = ref.current
      if (!el) return
      el.style.height = '0px'
      el.style.height = `${el.scrollHeight + 2}px`
    }
    fit()
    // a narrower window re-wraps the text: fit the box again, or the last line is clipped
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [value])
  const bad = !!errors && errors.length > 0
  return (
    <div>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={bad}
        placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} // one line per box: Enter must not move the cursor
        onChange={(e) => onChange(e.target.value.replace(/\n+/g, ' '))}
        className={`cpv-line${bad ? ' cpv-bad' : ''}${bold ? ' cpv-bold' : ''}${center ? ' cpv-center' : ''}${title ? ' cpv-title' : ''}`}
      />
      {bad && errors!.map((m, i) => <p key={i} className="cpv-error" data-field-error>{m}</p>)}
    </div>
  )
}

function ListBlock({
  items,
  onChange,
  errorsFor,
  listErrors,
  label,
  addLabel = 'Add a line',
  disabled,
  blank,
  placeholder = 'Type the line here',
}: {
  items: string[]
  onChange: (next: string[]) => void
  errorsFor: (i: number) => string[] | undefined
  listErrors?: string[]
  label: string
  addLabel?: string
  disabled?: boolean
  blank?: string
  placeholder?: string
}) {
  const full = items.length >= WORDING_LIMITS.items
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginBottom: 2 }}>
          <span style={{ marginTop: 3, color: '#a1a1aa', userSelect: 'none' }} aria-hidden>•</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AutoText label={`${label} ${i + 1}`} value={it} placeholder={placeholder} disabled={disabled} errors={errorsFor(i)} onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))} />
          </div>
          <button type="button" className="cpv-x" disabled={disabled} aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
        </div>
      ))}
      {listErrors?.map((m, i) => <p key={i} className="cpv-error" data-field-error>{m}</p>)}
      <button type="button" className="cpv-add" disabled={disabled || full} onClick={() => onChange([...items, blank ?? ''])}>
        <Plus className="h-3.5 w-3.5" />{addLabel}
      </button>
    </div>
  )
}

export function ContractEditor({ value, onChange, fieldErrors, disabled }: { value: EditableWording; onChange: Change; fieldErrors: FieldErrors; disabled?: boolean }) {
  const e = (key: string) => fieldErrors[key]
  const set = (patch: Partial<EditableWording>) => onChange({ ...value, ...patch })

  return (
    <div className="contract-preview" data-contract-editor>
      <style>{CONTRACT_PREVIEW_CSS}</style>

      <div className="contract-header">
        <AutoText label="Title" value={value.title} center title disabled={disabled} errors={e('title')} onChange={(v) => set({ title: v })} />
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, textAlign: 'left' }}>
          <div>
            <p className="cpv-muted">Name used in the first sentence (“This … is entered into”)</p>
            <AutoText label="Short title" value={value.shortTitle} disabled={disabled} errors={e('shortTitle')} onChange={(v) => set({ shortTitle: v })} />
          </div>
          <div>
            <p className="cpv-muted">Name of the signed PDF file (letters, numbers, _ only)</p>
            <AutoText label="PDF file name" value={value.pdfPrefix} disabled={disabled} errors={e('pdfPrefix')} onChange={(v) => set({ pdfPrefix: v })} />
          </div>
        </div>
      </div>

      <p className="cpv-note">
        The parties, the service summary table, the payment terms, the liability cap, the governing law and the e-signature clause are standard text and are not edited here.
      </p>

      <div className="contract-section">
        <h3>1. Scope of Service</h3>
        <AutoText label="Scope introduction" value={value.scope.intro} disabled={disabled} errors={e('scope.intro')} onChange={(v) => set({ scope: { ...value.scope, intro: v } })} />
        <ListBlock label="Scope item" items={[...value.scope.items]} disabled={disabled} listErrors={e('scope.items')} errorsFor={(i) => e(`scope.items.${i}`)} onChange={(items) => set({ scope: { ...value.scope, items } })} />
        <AutoText label="Scope closing sentence" bold value={value.scope.closing} disabled={disabled} errors={e('scope.closing')} onChange={(v) => set({ scope: { ...value.scope, closing: v } })} />
      </div>

      <div className="contract-section">
        <h3>2. Client Responsibilities</h3>
        <AutoText label="Client responsibilities introduction" value={value.clientDuties.intro} disabled={disabled} errors={e('clientDuties.intro')} onChange={(v) => set({ clientDuties: { ...value.clientDuties, intro: v } })} />
        <ListBlock label="Client responsibility" placeholder="Start with the heading between stars, then the sentence: **Heading** and the rest;" items={value.clientDuties.items} disabled={disabled} listErrors={e('clientDuties.items')} errorsFor={(i) => e(`clientDuties.items.${i}`)} onChange={(items) => set({ clientDuties: { ...value.clientDuties, items } })} />
      </div>

      <div className="contract-section">
        <h3>3. Service Procedure</h3>
        <AutoText label="Procedure introduction" value={value.procedure.intro} disabled={disabled} errors={e('procedure.intro')} onChange={(v) => set({ procedure: { ...value.procedure, intro: v } })} />
        <div style={{ marginTop: 4 }}>
          {value.procedure.steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginBottom: 6 }}>
              <span style={{ marginTop: 3, color: '#6b6b6b', userSelect: 'none', width: 20, textAlign: 'right' }} aria-hidden>{i + 1}.</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <AutoText label={`Step ${i + 1} title`} bold value={s.title} disabled={disabled} errors={e(`procedure.steps.${i}.title`)} onChange={(v) => set({ procedure: { ...value.procedure, steps: value.procedure.steps.map((x, j) => (j === i ? { ...x, title: v } : x)) } })} />
                <AutoText label={`Step ${i + 1} description`} value={s.desc} disabled={disabled} errors={e(`procedure.steps.${i}.desc`)} onChange={(v) => set({ procedure: { ...value.procedure, steps: value.procedure.steps.map((x, j) => (j === i ? { ...x, desc: v } : x)) } })} />
              </div>
              <button type="button" className="cpv-x" disabled={disabled} aria-label={`Remove step ${i + 1}`} onClick={() => set({ procedure: { ...value.procedure, steps: value.procedure.steps.filter((_, j) => j !== i) } })}><X className="h-4 w-4" /></button>
            </div>
          ))}
          {e('procedure.steps')?.map((m, i) => <p key={i} className="cpv-error" data-field-error>{m}</p>)}
          <button type="button" className="cpv-add" disabled={disabled || value.procedure.steps.length >= WORDING_LIMITS.items} onClick={() => set({ procedure: { ...value.procedure, steps: [...value.procedure.steps, { title: '', desc: '' }] } })}>
            <Plus className="h-3.5 w-3.5" />Add a step
          </button>
        </div>
      </div>

      <div className="contract-section">
        <h3>4. Service Provider Commitments</h3>
        <p>The Service Provider agrees to:</p>
        <ListBlock label="Commitment" items={[...value.commitments]} disabled={disabled} listErrors={e('commitments')} errorsFor={(i) => e(`commitments.${i}`)} onChange={(commitments) => set({ commitments })} />
      </div>

      <div className="contract-section">
        <h3>Words used in the Payment and Liability sections</h3>
        <div>
          <p className="cpv-muted">“…payable in full before <strong>this</strong> begins” and “…non-refundable once <strong>this</strong> has commenced” — for example: <em>the apostille</em></p>
          <AutoText label="Work phrase" value={value.workPhrase ?? ''} disabled={disabled} errors={e('workPhrase')} onChange={(v) => set({ workPhrase: v })} />
          <p className="cpv-muted" style={{ marginTop: 8 }}>“…not liable for <strong>this</strong> resulting from inaccurate, incomplete, or late information” — for example: <em>delays or rejections by any authority</em></p>
          <AutoText label="Liability phrase" value={value.liabilityPhrase ?? ''} disabled={disabled} errors={e('liabilityPhrase')} onChange={(v) => set({ liabilityPhrase: v })} />
        </div>
      </div>

      <div className="contract-sig-box">
        <h3>Acceptance &amp; Signature</h3>
        <AutoText label="Acceptance sentence" center value={value.signatureText} disabled={disabled} errors={e('signatureText')} onChange={(v) => set({ signatureText: v })} />
      </div>

      <div className="contract-section">
        <h3>Message after signing</h3>
        <AutoText label="Message after signing" value={value.successNote} disabled={disabled} errors={e('successNote')} onChange={(v) => set({ successNote: v })} />
      </div>
    </div>
  )
}
