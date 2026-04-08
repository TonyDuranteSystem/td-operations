'use client'

import { useState, useEffect, useRef } from 'react'
import {
  X, Loader2, CheckCircle2, AlertCircle, XCircle, Info,
  RefreshCw, Link2, ChevronDown, ChevronRight,
  ShieldAlert, ShieldCheck, Shield, Building2, Unlink, Upload, FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ─── Types ───

interface ChainFix {
  action: string
  label: string
  params: Record<string, unknown>
  description: string
  impact: string[]
  risk: 'safe' | 'moderate' | 'high'
}

interface ChainCheck {
  id: string
  category: string
  label: string
  status: 'ok' | 'warning' | 'error' | 'info'
  detail: string
  fix?: ChainFix
}

interface AccountAudit {
  account_id: string
  company_name: string
  entity_type: string | null
  status: string | null
  account_type: string | null
  role: string | null
  checks: ChainCheck[]
}

interface ChainAuditResult {
  contact: {
    id: string
    full_name: string
    email: string | null
    portal_tier: string | null
  }
  global_checks: ChainCheck[]
  account_audits: AccountAudit[]
  summary: { ok: number; warning: number; error: number; info: number; total: number }
}

interface Props {
  open: boolean
  onClose: () => void
  contactId: string
  contactName: string
}

// ─── Constants ───

const STATUS_ICON = {
  ok: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
  info: Info,
}

const STATUS_COLOR = {
  ok: 'text-green-600',
  warning: 'text-amber-500',
  error: 'text-red-600',
  info: 'text-blue-500',
}

const STATUS_BG = {
  ok: 'bg-green-50',
  warning: 'bg-amber-50',
  error: 'bg-red-50',
  info: 'bg-blue-50',
}

const RISK_CONFIG = {
  safe: { icon: ShieldCheck, color: 'text-green-600', bg: 'bg-green-50', label: 'Safe — internal data only' },
  moderate: { icon: Shield, color: 'text-amber-600', bg: 'bg-amber-50', label: 'Moderate — changes visible data' },
  high: { icon: ShieldAlert, color: 'text-red-600', bg: 'bg-red-50', label: 'High — affects client experience' },
}

const CATEGORY_ORDER = [
  'Lead → Contact', 'Offer', 'Activation', 'Payments', 'Missing Account',
  'Portal', 'Data Forms', 'Documents',
]

const ACCOUNT_CATEGORY_ORDER = [
  'Account', 'Services', 'EIN Pipeline', 'Portal', 'Agreements',
]

// ─── Component ───

// Actions that require a form before executing
const FORM_ACTIONS = new Set(['create_account_for_offer'])

export function ChainAuditDialog({ open, onClose, contactId, contactName }: Props) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ChainAuditResult | null>(null)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingFix, setConfirmingFix] = useState<string | null>(null)

  // Form state for create_account_for_offer
  const [accountForm, setAccountForm] = useState({
    company_name: '',
    entity_type: 'Single Member LLC',
    state_of_formation: 'New Mexico',
    formation_date: '',
  })

  // Upload state for Articles of Organization
  const [uploading, setUploading] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleArticlesUpload(file: File) {
    if (!file) return
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff']
    if (!allowed.includes(file.type)) {
      toast.error('Unsupported file type. Use PDF, JPG, PNG, or TIFF.')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error('File too large (max 15MB for OCR)')
      return
    }

    setUploading(true)
    try {
      // Step 1: Get signed upload URL from Supabase Storage
      const ext = file.name.split('.').pop() ?? 'pdf'
      const storagePath = `articles/${contactId}/${Date.now()}.${ext}`

      const urlRes = await fetch('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: 'onboarding-uploads', path: storagePath }),
      })
      const urlData = await urlRes.json()
      if (!urlRes.ok) throw new Error(urlData.error || 'Failed to get upload URL')

      // Step 2: Upload file directly to Supabase Storage
      const uploadRes = await fetch(urlData.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!uploadRes.ok) throw new Error('Failed to upload file to storage')

      // Step 3: Call OCR Articles endpoint
      const ocrRes = await fetch('/api/crm/admin-actions/ocr-articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type,
        }),
      })
      const ocrData = await ocrRes.json()

      if (!ocrRes.ok) {
        throw new Error(ocrData.error || 'OCR failed')
      }

      // Step 4: Auto-fill form from parsed data
      setAccountForm(prev => ({
        company_name: ocrData.company_name || prev.company_name,
        entity_type: ocrData.entity_type || prev.entity_type,
        state_of_formation: ocrData.state_of_formation || prev.state_of_formation,
        formation_date: ocrData.formation_date || prev.formation_date,
      }))

      setUploadedFile(file.name)

      const filled = [
        ocrData.company_name ? 'company name' : null,
        ocrData.entity_type ? 'entity type' : null,
        ocrData.state_of_formation ? 'state' : null,
        ocrData.formation_date ? 'formation date' : null,
        ocrData.filing_id ? `filing ID: ${ocrData.filing_id}` : null,
      ].filter(Boolean)

      toast.success(`OCR extracted: ${filled.join(', ')}. Review and edit if needed.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    if (open) {
      runAudit()
    } else {
      setResult(null)
      setError(null)
      setExpandedId(null)
      setConfirmingFix(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Prefill account form when expanding a create_account_for_offer fix
  useEffect(() => {
    if (!expandedId || !result) return
    const allChecks = [...result.global_checks, ...result.account_audits.flatMap(a => a.checks)]
    const check = allChecks.find(c => c.id === expandedId)
    if (check?.fix?.action === 'create_account_for_offer') {
      const p = check.fix.params
      // Derive company name from client_name (e.g., "Damy Mocellin - Oh My Creatives" → "Oh My Creatives")
      let name = (p.client_name as string) || ''
      if (name.includes(' - ')) {
        name = name.split(' - ').slice(1).join(' - ').trim()
      }
      if (!name.toLowerCase().includes('llc') && !name.toLowerCase().includes('corp') && !name.toLowerCase().includes('inc')) {
        name = name + ' LLC'
      }
      setAccountForm({
        company_name: name,
        entity_type: 'Single Member LLC',
        state_of_formation: 'New Mexico',
        formation_date: '',
      })
    }
  }, [expandedId, result])

  async function runAudit() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/admin-actions/audit-chain?contact_id=${contactId}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function executeFix(check: ChainCheck, overrideParams?: Record<string, unknown>) {
    if (!check.fix) return
    setFixingId(check.id)
    try {
      const params = overrideParams
        ? { ...check.fix.params, ...overrideParams }
        : check.fix.params

      const res = await fetch('/api/crm/admin-actions/audit-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: check.fix.action,
          params,
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        setExpandedId(null)
        setConfirmingFix(null)
        await runAudit()
      } else {
        toast.error(data.detail || data.error || 'Fix failed')
        if (data.redirect) {
          toast.info(`Navigate to: ${data.redirect}`)
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fix failed')
    } finally {
      setFixingId(null)
    }
  }

  if (!open) return null

  function renderCheck(check: ChainCheck) {
    const Icon = STATUS_ICON[check.status]
    const hasFix = !!check.fix
    const isExpanded = expandedId === check.id
    const isClickable = hasFix || check.status === 'error' || check.status === 'warning'
    const isConfirming = confirmingFix === check.id

    return (
      <div key={check.id}>
        <div
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg text-sm transition-colors',
            STATUS_BG[check.status],
            isClickable && 'cursor-pointer hover:opacity-80',
            isExpanded && 'rounded-b-none',
          )}
          onClick={() => isClickable ? setExpandedId(isExpanded ? null : check.id) : undefined}
        >
          {isClickable ? (
            <div className="mt-0.5 shrink-0">
              {isExpanded
                ? <ChevronDown className={cn('h-4 w-4', STATUS_COLOR[check.status])} />
                : <ChevronRight className={cn('h-4 w-4', STATUS_COLOR[check.status])} />
              }
            </div>
          ) : (
            <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', STATUS_COLOR[check.status])} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">{check.label}</span>
              {hasFix && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/60 text-zinc-500">
                  FIX AVAILABLE
                </span>
              )}
            </div>
            <p className="text-zinc-600 mt-0.5 break-words">{check.detail}</p>
          </div>
        </div>

        {/* Expanded fix panel */}
        {isExpanded && hasFix && check.fix && (
          <div className={cn('border-t p-4 rounded-b-lg', STATUS_BG[check.status])}>
            <div className="space-y-3">
              {/* Risk badge */}
              {(() => {
                const risk = RISK_CONFIG[check.fix.risk]
                const RiskIcon = risk.icon
                return (
                  <div className={cn('inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium', risk.bg, risk.color)}>
                    <RiskIcon className="h-3.5 w-3.5" />
                    {risk.label}
                  </div>
                )
              })()}

              {/* Description */}
              <p className="text-sm text-zinc-700">{check.fix.description}</p>

              {/* Impact list */}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-zinc-400 uppercase">Impact</p>
                <ul className="text-xs text-zinc-600 space-y-0.5">
                  {check.fix.impact.map((imp, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="text-zinc-400 mt-0.5">•</span>
                      {imp}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Form for create_account_for_offer */}
              {FORM_ACTIONS.has(check.fix.action) && (
                <div className="space-y-3 p-3 bg-white rounded-lg border border-zinc-200" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-zinc-500 uppercase">Enter company details from Articles of Organization</p>
                    <div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,.webp,.tiff"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (file) handleArticlesUpload(file)
                          e.target.value = ''
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors',
                          'bg-violet-100 text-violet-700 hover:bg-violet-200',
                          uploading && 'opacity-50 cursor-not-allowed',
                        )}
                      >
                        {uploading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        {uploading ? 'OCR processing...' : 'Upload Articles PDF'}
                      </button>
                    </div>
                  </div>
                  {uploadedFile && (
                    <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 px-2 py-1 rounded">
                      <FileText className="h-3.5 w-3.5" />
                      {uploadedFile} — fields auto-filled from OCR. Review below.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-zinc-600 mb-1">Company Name *</label>
                      <input
                        type="text"
                        value={accountForm.company_name}
                        onChange={e => setAccountForm(prev => ({ ...prev, company_name: e.target.value }))}
                        className="w-full px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                        placeholder="e.g. Oh My Creatives LLC"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-600 mb-1">Entity Type *</label>
                      <select
                        value={accountForm.entity_type}
                        onChange={e => setAccountForm(prev => ({ ...prev, entity_type: e.target.value }))}
                        className="w-full px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                      >
                        <option value="Single Member LLC">Single Member LLC</option>
                        <option value="Multi Member LLC">Multi Member LLC</option>
                        <option value="C-Corp Elected">C-Corp Elected</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-600 mb-1">State of Formation *</label>
                      <select
                        value={accountForm.state_of_formation}
                        onChange={e => setAccountForm(prev => ({ ...prev, state_of_formation: e.target.value }))}
                        className="w-full px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                      >
                        <option value="New Mexico">New Mexico</option>
                        <option value="Wyoming">Wyoming</option>
                        <option value="Delaware">Delaware</option>
                        <option value="Florida">Florida</option>
                        <option value="Texas">Texas</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-600 mb-1">Formation Date</label>
                      <input
                        type="date"
                        value={accountForm.formation_date}
                        onChange={e => setAccountForm(prev => ({ ...prev, formation_date: e.target.value }))}
                        className="w-full px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Confirm / Execute */}
              {!isConfirming ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    // For form actions, validate required fields
                    if (FORM_ACTIONS.has(check.fix!.action)) {
                      if (!accountForm.company_name.trim()) {
                        toast.error('Company name is required')
                        return
                      }
                    }
                    setConfirmingFix(check.id)
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white border border-zinc-200 hover:bg-zinc-50 transition-colors"
                >
                  {FORM_ACTIONS.has(check.fix.action)
                    ? `Create "${accountForm.company_name || '...'}" account`
                    : check.fix.label}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      // For form actions, pass form values as overrides
                      if (FORM_ACTIONS.has(check.fix!.action)) {
                        executeFix(check, {
                          company_name: accountForm.company_name.trim(),
                          entity_type: accountForm.entity_type,
                          state_of_formation: accountForm.state_of_formation,
                          formation_date: accountForm.formation_date || null,
                        })
                      } else {
                        executeFix(check)
                      }
                    }}
                    disabled={fixingId === check.id}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                      check.fix.risk === 'high'
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : check.fix.risk === 'moderate'
                          ? 'bg-amber-600 text-white hover:bg-amber-700'
                          : 'bg-green-600 text-white hover:bg-green-700',
                      fixingId === check.id && 'opacity-50 cursor-not-allowed',
                    )}
                  >
                    {fixingId === check.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Confirm: Create &quot;{accountForm.company_name}&quot;
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmingFix(null)
                    }}
                    className="px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-700"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link2 className="h-5 w-5 text-violet-600" />
            <div>
              <h2 className="text-lg font-semibold">Client Chain Audit</h2>
              <p className="text-sm text-zinc-500">{contactName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {result && !loading && (
              <button
                onClick={runAudit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-100 hover:bg-zinc-200 transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-run
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-100">
              <X className="h-5 w-5 text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
              <p className="text-sm text-zinc-500">Auditing client chain...</p>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-4 bg-red-50 rounded-lg text-sm text-red-700">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {result && !loading && (
            <>
              {/* Summary bar */}
              <div className="flex items-center gap-4 mb-6 p-3 bg-zinc-50 rounded-lg text-sm">
                <span className="flex items-center gap-1.5 text-green-700">
                  <CheckCircle2 className="h-4 w-4" /> {result.summary.ok} OK
                </span>
                <span className="flex items-center gap-1.5 text-amber-600">
                  <AlertCircle className="h-4 w-4" /> {result.summary.warning} Warning
                </span>
                <span className="flex items-center gap-1.5 text-red-600">
                  <XCircle className="h-4 w-4" /> {result.summary.error} Error
                </span>
                {result.summary.info > 0 && (
                  <span className="flex items-center gap-1.5 text-blue-500">
                    <Info className="h-4 w-4" /> {result.summary.info} Info
                  </span>
                )}
              </div>

              {/* Global checks by category */}
              {(() => {
                const grouped: Record<string, ChainCheck[]> = {}
                for (const check of result.global_checks) {
                  if (!grouped[check.category]) grouped[check.category] = []
                  grouped[check.category].push(check)
                }
                return (
                  <div className="space-y-6">
                    {CATEGORY_ORDER.filter(cat => grouped[cat]?.length).map(category => (
                      <div key={category}>
                        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                          {category}
                        </h3>
                        <div className="space-y-1.5">
                          {grouped[category].map(check => renderCheck(check))}
                        </div>
                      </div>
                    ))}

                    {/* Also render any categories not in the order */}
                    {Object.keys(grouped).filter(cat => !CATEGORY_ORDER.includes(cat)).map(category => (
                      <div key={category}>
                        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                          {category}
                        </h3>
                        <div className="space-y-1.5">
                          {grouped[category].map(check => renderCheck(check))}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* Per-account sections */}
              {result.account_audits.length > 0 && (
                <div className="mt-8 space-y-6">
                  <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Linked Accounts ({result.account_audits.length})
                  </h2>

                  {result.account_audits.map(acctAudit => {
                    const acctGrouped: Record<string, ChainCheck[]> = {}
                    for (const check of acctAudit.checks) {
                      if (!acctGrouped[check.category]) acctGrouped[check.category] = []
                      acctGrouped[check.category].push(check)
                    }

                    const acctSummary = { ok: 0, warning: 0, error: 0, info: 0 }
                    for (const c of acctAudit.checks) acctSummary[c.status]++

                    return (
                      <div key={acctAudit.account_id} className="border rounded-lg">
                        <div className="px-4 py-3 bg-zinc-50 rounded-t-lg flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-sm">{acctAudit.company_name}</h3>
                            <p className="text-xs text-zinc-500">
                              {acctAudit.entity_type ?? ''} · {acctAudit.status ?? ''} · {acctAudit.account_type ?? ''} · {acctAudit.role ?? ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            {acctSummary.error > 0 && (
                              <span className="text-red-600 font-medium">{acctSummary.error} errors</span>
                            )}
                            {acctSummary.warning > 0 && (
                              <span className="text-amber-600 font-medium">{acctSummary.warning} warnings</span>
                            )}
                            {acctSummary.error === 0 && acctSummary.warning === 0 && (
                              <span className="text-green-600 font-medium">All OK</span>
                            )}
                          </div>
                        </div>

                        <div className="p-4 space-y-4">
                          {ACCOUNT_CATEGORY_ORDER.filter(cat => acctGrouped[cat]?.length).map(category => (
                            <div key={category}>
                              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                                {category}
                              </h4>
                              <div className="space-y-1.5">
                                {acctGrouped[category].map(check => renderCheck(check))}
                              </div>
                            </div>
                          ))}

                          {Object.keys(acctGrouped).filter(cat => !ACCOUNT_CATEGORY_ORDER.includes(cat)).map(category => (
                            <div key={category}>
                              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                                {category}
                              </h4>
                              <div className="space-y-1.5">
                                {acctGrouped[category].map(check => renderCheck(check))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* No accounts warning */}
              {result.account_audits.length === 0 && (
                <div className="mt-6 flex items-center gap-2 p-4 bg-amber-50 rounded-lg text-sm text-amber-700">
                  <Unlink className="h-4 w-4 shrink-0" />
                  No linked accounts found. Check the global checks above for missing account fixes.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
