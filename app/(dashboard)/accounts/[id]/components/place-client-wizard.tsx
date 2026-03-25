'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  X, Loader2, CheckCircle2, AlertCircle, FolderOpen,
  FileText, Building2, CreditCard, Landmark, Shield,
  ChevronRight, SkipForward,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ─── Types ───

interface PlaceClientWizardProps {
  open: boolean
  onClose: () => void
  accountId: string
  companyName: string
  state: string | null
  entityType: string | null
  contactName: string
  ein: string | null
  formationDate: string | null
}

interface ExistingData {
  drive_folder: boolean
  service_deliveries: { service_type: string; stage: string; stage_order: number }[]
  oa: { token: string; status: string } | null
  lease: { token: string; status: string; suite_number: string } | null
  banking_relay: { token: string; status: string } | null
  banking_payset: { token: string; status: string } | null
  tax_return: { tax_year: number; status: string } | null
  portal_tier: string | null
}

interface StepResult {
  name: string
  status: 'ok' | 'skipped' | 'error'
  detail: string
}

// ─── Stage Presets ───

const FORMATION_STAGES = [
  { key: 'just_paid', label: 'Just paid, needs data collection', description: 'Stage 1 — Data Collection', icon: '1' },
  { key: 'data_collected', label: 'Data collected, LLC being filed', description: 'Stage 2 — State Filing', icon: '2' },
  { key: 'llc_formed', label: 'LLC formed, waiting for EIN', description: 'Stage 3 — EIN Application', icon: '3' },
  { key: 'ein_received', label: 'EIN received, needs welcome package', description: 'Stage 4 — Post-Formation + Banking', icon: '4' },
  { key: 'everything_done', label: 'Everything done, just needs portal access', description: 'Stage 5 — Closing', icon: '5' },
]

const ONBOARDING_STAGES = [
  { key: 'onboarding_data_collection', label: 'Just paid, needs data collection', description: 'Stage 1 — Data Collection', icon: '1' },
  { key: 'onboarding_review', label: 'Data collected, needs CRM setup', description: 'Stage 2 — Review & CRM Setup', icon: '2' },
  { key: 'onboarding_complete', label: 'Review done, wrapping up', description: 'Stage 3 — Post-Review & Closing', icon: '3' },
]

// ─── Component ───

export function PlaceClientWizard({
  open, onClose, accountId, companyName, state, entityType, contactName, ein, formationDate,
}: PlaceClientWizardProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [step, setStep] = useState(1) // 1: select stage, 2: review actions, 3: results
  const [loading, setLoading] = useState(false)

  // Step 1 state
  const [serviceCategory, setServiceCategory] = useState<'formation' | 'onboarding'>('formation')
  const [selectedStage, setSelectedStage] = useState('')

  // Step 2 state
  const [existing, setExisting] = useState<ExistingData | null>(null)
  const [actions, setActions] = useState({
    drive_folder: true,
    service_delivery: true,
    oa: true,
    lease: true,
    banking_relay: true,
    banking_payset: true,
    tax_return: false,
    portal_tier: true,
  })
  const [suiteNumber, setSuiteNumber] = useState('')
  const [reason, setReason] = useState('Legacy migration')

  // Step 3 state
  const [results, setResults] = useState<StepResult[]>([])
  const [summary, setSummary] = useState({ ok: 0, skipped: 0, errors: 0 })

  // Auto-detect when moving to step 2
  useEffect(() => {
    if (step === 2 && !existing) {
      setLoading(true)
      fetch(`/api/crm/admin-actions/place-client?account_id=${accountId}`)
        .then(res => res.json())
        .then(data => {
          if (data.existing) {
            setExisting(data.existing)
            // Pre-check/uncheck based on what exists
            const ex = data.existing as ExistingData
            setActions(prev => ({
              ...prev,
              drive_folder: !ex.drive_folder,
              service_delivery: ex.service_deliveries.length === 0,
              oa: !ex.oa,
              lease: !ex.lease,
              banking_relay: !ex.banking_relay,
              banking_payset: !ex.banking_payset,
              tax_return: !ex.tax_return,
              portal_tier: true,
            }))
            // If lease exists, grab its suite number
            if (ex.lease?.suite_number) {
              setSuiteNumber(ex.lease.suite_number)
            }
          }
        })
        .catch(() => toast.error('Failed to detect existing resources'))
        .finally(() => setLoading(false))
    }
  }, [step, existing, accountId])

  if (!open) return null

  const stages = serviceCategory === 'formation' ? FORMATION_STAGES : ONBOARDING_STAGES

  const handleExecute = () => {
    if (actions.lease && !suiteNumber.trim()) {
      toast.error('Suite number is required for lease creation')
      return
    }
    if (!reason.trim()) {
      toast.error('Please provide a reason')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/place-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_id: accountId,
            stage: selectedStage,
            service_type: serviceCategory === 'formation' ? 'Company Formation' : 'Client Onboarding',
            actions,
            suite_number: suiteNumber || undefined,
            reason,
          }),
        })
        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to place client')
          return
        }

        setResults(data.results || [])
        setSummary(data.summary || { ok: 0, skipped: 0, errors: 0 })
        setStep(3)
        toast.success(`Client placed: ${data.summary?.ok || 0} created, ${data.summary?.skipped || 0} skipped`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error')
      }
    })
  }

  const handleClose = () => {
    // Reset state
    setStep(1)
    setSelectedStage('')
    setExisting(null)
    setResults([])
    setSummary({ ok: 0, skipped: 0, errors: 0 })
    setReason('Legacy migration')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-semibold">Place Client — {companyName}</h2>
          </div>
          <div className="flex items-center gap-3">
            {/* Step indicator */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className={cn('px-2 py-0.5 rounded', step === 1 ? 'bg-indigo-100 text-indigo-700 font-medium' : step > 1 ? 'text-emerald-600' : '')}>
                {step > 1 ? '✓' : '1'} Stage
              </span>
              <ChevronRight className="h-3 w-3" />
              <span className={cn('px-2 py-0.5 rounded', step === 2 ? 'bg-indigo-100 text-indigo-700 font-medium' : step > 2 ? 'text-emerald-600' : '')}>
                {step > 2 ? '✓' : '2'} Actions
              </span>
              <ChevronRight className="h-3 w-3" />
              <span className={cn('px-2 py-0.5 rounded', step === 3 ? 'bg-indigo-100 text-indigo-700 font-medium' : '')}>
                3 Results
              </span>
            </div>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {/* ─── STEP 1: Select Stage ─── */}
          {step === 1 && (
            <>
              <p className="text-sm text-muted-foreground">
                Where is <strong>{companyName}</strong> in the journey? This determines the pipeline stage and which resources to create.
              </p>

              {/* Service category toggle */}
              <div className="flex gap-2">
                <button
                  onClick={() => { setServiceCategory('formation'); setSelectedStage('') }}
                  className={cn(
                    'px-3 py-1.5 text-sm rounded-lg border transition-colors',
                    serviceCategory === 'formation'
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-medium'
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
                  )}
                >
                  Formation (new LLC)
                </button>
                <button
                  onClick={() => { setServiceCategory('onboarding'); setSelectedStage('') }}
                  className={cn(
                    'px-3 py-1.5 text-sm rounded-lg border transition-colors',
                    serviceCategory === 'onboarding'
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-medium'
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50',
                  )}
                >
                  Onboarding (existing LLC)
                </button>
              </div>

              {/* Stage selection */}
              <div className="space-y-2">
                {stages.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setSelectedStage(s.key)}
                    className={cn(
                      'w-full text-left px-4 py-3 rounded-lg border transition-colors',
                      selectedStage === s.key
                        ? 'bg-indigo-50 border-indigo-300 ring-1 ring-indigo-300'
                        : 'border-zinc-200 hover:bg-zinc-50',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span className={cn(
                        'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
                        selectedStage === s.key ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-600',
                      )}>
                        {s.icon}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{s.label}</p>
                        <p className="text-xs text-muted-foreground">{s.description}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Account summary */}
              <div className="bg-zinc-50 rounded-lg p-3 text-xs space-y-1">
                <div className="flex gap-4">
                  <span className="text-muted-foreground">Contact:</span>
                  <span className="font-medium">{contactName || '—'}</span>
                </div>
                <div className="flex gap-4">
                  <span className="text-muted-foreground">State:</span>
                  <span className="font-medium">{state || '—'}</span>
                </div>
                <div className="flex gap-4">
                  <span className="text-muted-foreground">Entity:</span>
                  <span className="font-medium">{entityType || '—'}</span>
                </div>
                <div className="flex gap-4">
                  <span className="text-muted-foreground">EIN:</span>
                  <span className="font-medium">{ein || '—'}</span>
                </div>
                <div className="flex gap-4">
                  <span className="text-muted-foreground">Formation:</span>
                  <span className="font-medium">{formationDate || '—'}</span>
                </div>
              </div>
            </>
          )}

          {/* ─── STEP 2: Review & Confirm Actions ─── */}
          {step === 2 && (
            <>
              {loading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Detecting existing resources...
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Review what will be created. Existing resources are auto-detected and unchecked.
                  </p>

                  {/* Action checkboxes */}
                  <div className="space-y-2">
                    <ActionCheckbox
                      checked={actions.drive_folder}
                      onChange={v => setActions(a => ({ ...a, drive_folder: v }))}
                      icon={<FolderOpen className="h-4 w-4" />}
                      label="Google Drive folder"
                      exists={existing?.drive_folder}
                      existsLabel="Already exists"
                    />
                    <ActionCheckbox
                      checked={actions.service_delivery}
                      onChange={v => setActions(a => ({ ...a, service_delivery: v }))}
                      icon={<Building2 className="h-4 w-4" />}
                      label={`Service Delivery (${serviceCategory === 'formation' ? 'Company Formation' : 'Client Onboarding'})`}
                      exists={(existing?.service_deliveries?.length ?? 0) > 0}
                      existsLabel={existing?.service_deliveries?.[0] ? `${existing.service_deliveries[0].service_type} at "${existing.service_deliveries[0].stage}"` : undefined}
                    />
                    <ActionCheckbox
                      checked={actions.oa}
                      onChange={v => setActions(a => ({ ...a, oa: v }))}
                      icon={<FileText className="h-4 w-4" />}
                      label="Operating Agreement (draft)"
                      exists={!!existing?.oa}
                      existsLabel={existing?.oa ? `${existing.oa.token} (${existing.oa.status})` : undefined}
                    />

                    {/* Lease with suite number */}
                    <div className="space-y-1">
                      <ActionCheckbox
                        checked={actions.lease}
                        onChange={v => setActions(a => ({ ...a, lease: v }))}
                        icon={<Shield className="h-4 w-4" />}
                        label="Lease Agreement (draft)"
                        exists={!!existing?.lease}
                        existsLabel={existing?.lease ? `${existing.lease.token} (${existing.lease.status}), Suite ${existing.lease.suite_number}` : undefined}
                      />
                      {actions.lease && !existing?.lease && (
                        <div className="ml-9">
                          <label className="text-xs text-muted-foreground">Suite Number (required)</label>
                          <input
                            type="text"
                            value={suiteNumber}
                            onChange={e => setSuiteNumber(e.target.value)}
                            placeholder="e.g., 3D-107"
                            className="mt-0.5 w-48 text-sm px-3 py-1.5 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                        </div>
                      )}
                    </div>

                    <ActionCheckbox
                      checked={actions.banking_relay}
                      onChange={v => setActions(a => ({ ...a, banking_relay: v }))}
                      icon={<Landmark className="h-4 w-4" />}
                      label="Banking — Relay (USD)"
                      exists={!!existing?.banking_relay}
                      existsLabel={existing?.banking_relay ? `${existing.banking_relay.token} (${existing.banking_relay.status})` : undefined}
                    />
                    <ActionCheckbox
                      checked={actions.banking_payset}
                      onChange={v => setActions(a => ({ ...a, banking_payset: v }))}
                      icon={<CreditCard className="h-4 w-4" />}
                      label="Banking — Payset (EUR)"
                      exists={!!existing?.banking_payset}
                      existsLabel={existing?.banking_payset ? `${existing.banking_payset.token} (${existing.banking_payset.status})` : undefined}
                    />
                    <ActionCheckbox
                      checked={actions.tax_return}
                      onChange={v => setActions(a => ({ ...a, tax_return: v }))}
                      icon={<FileText className="h-4 w-4" />}
                      label={`Tax Return (${new Date().getFullYear() - 1})`}
                      exists={!!existing?.tax_return}
                      existsLabel={existing?.tax_return ? `${existing.tax_return.tax_year} (${existing.tax_return.status})` : undefined}
                    />
                    <ActionCheckbox
                      checked={actions.portal_tier}
                      onChange={v => setActions(a => ({ ...a, portal_tier: v }))}
                      icon={<Shield className="h-4 w-4" />}
                      label="Set portal tier"
                      exists={false}
                      existsLabel={existing?.portal_tier ? `Currently: ${existing.portal_tier}` : undefined}
                    />
                  </div>

                  <hr />

                  {/* Reason */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reason</label>
                    <input
                      type="text"
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder="e.g., Legacy migration, Exception, Client request"
                      className="mt-1 w-full text-sm px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  {/* Summary of what will happen */}
                  {Object.values(actions).some(Boolean) && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                      <strong>This will create:</strong>{' '}
                      {[
                        actions.drive_folder && 'Drive folder',
                        actions.service_delivery && 'Service Delivery',
                        actions.oa && 'OA (draft)',
                        actions.lease && `Lease (draft, Suite ${suiteNumber || '?'})`,
                        actions.banking_relay && 'Relay form',
                        actions.banking_payset && 'Payset form',
                        actions.tax_return && 'Tax Return record',
                        actions.portal_tier && 'Portal tier update',
                      ].filter(Boolean).join(', ')}
                      . OA and Lease will be in DRAFT status — send when ready.
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ─── STEP 3: Results ─── */}
          {step === 3 && (
            <>
              {/* Summary banner */}
              <div className={cn(
                'rounded-lg p-4 text-sm font-medium',
                summary.errors > 0
                  ? 'bg-amber-50 border border-amber-200 text-amber-800'
                  : 'bg-emerald-50 border border-emerald-200 text-emerald-800',
              )}>
                {summary.ok} created · {summary.skipped} skipped · {summary.errors} error{summary.errors !== 1 ? 's' : ''}
              </div>

              {/* Step-by-step results */}
              <div className="space-y-1.5">
                {results.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm py-1.5 px-3 rounded-lg bg-zinc-50">
                    {r.status === 'ok' && <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />}
                    {r.status === 'skipped' && <SkipForward className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />}
                    {r.status === 'error' && <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />}
                    <div>
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground ml-1.5">— {r.detail}</span>
                    </div>
                  </div>
                ))}
              </div>

              {results.some(r => r.status === 'ok' && (r.name === 'oa' || r.name === 'lease')) && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                  OA and Lease are in <strong>DRAFT</strong> status. Use the Documents panel above to send them to the client when ready.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t bg-zinc-50/50 rounded-b-xl shrink-0">
          <div>
            {step === 2 && (
              <button
                onClick={() => { setStep(1); setExisting(null) }}
                className="px-3 py-2 text-sm text-zinc-500 hover:text-zinc-700"
              >
                ← Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 1 && (
              <>
                <button onClick={handleClose} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                  Cancel
                </button>
                <button
                  onClick={() => setStep(2)}
                  disabled={!selectedStage}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
            {step === 2 && (
              <>
                <button onClick={handleClose} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-800">
                  Cancel
                </button>
                <button
                  onClick={handleExecute}
                  disabled={isPending || loading || !Object.values(actions).some(Boolean)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Execute
                </button>
              </>
            )}
            {step === 3 && (
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-component: Action checkbox row ───

function ActionCheckbox({
  checked, onChange, icon, label, exists, existsLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  icon: React.ReactNode
  label: string
  exists?: boolean
  existsLabel?: string
}) {
  return (
    <label className={cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors',
      checked ? 'bg-indigo-50/50 border-indigo-200' : 'border-zinc-100 hover:bg-zinc-50',
      exists ? 'opacity-70' : '',
    )}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
      />
      <span className="text-zinc-500">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium">{label}</span>
        {exists && existsLabel && (
          <span className="ml-2 text-xs text-emerald-600 font-medium">✓ {existsLabel}</span>
        )}
        {!exists && existsLabel && (
          <span className="ml-2 text-xs text-muted-foreground">{existsLabel}</span>
        )}
      </div>
    </label>
  )
}
