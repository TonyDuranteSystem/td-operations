'use client'

import { useMemo, useRef, useState } from 'react'
import { Building2, CheckCircle2, ExternalLink, Loader2, AlertCircle, Plus, X, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { mergeNames, type AdminAddedName, type UnifiedNameOption } from '@/lib/llc-name-helpers'
import { FastTooltip } from '@/components/ui/fast-tooltip'

// ─── State SOS search portals ─────────────────────────────────────────────
const SOS_LINKS: Record<string, { url: string; label: string }> = {
  NM: { url: 'https://portal.sos.state.nm.us/BFS/online/CorporationBusinessSearch', label: 'NM SOS' },
  'New Mexico': { url: 'https://portal.sos.state.nm.us/BFS/online/CorporationBusinessSearch', label: 'NM SOS' },
  WY: { url: 'https://wyobiz.wyo.gov/Business/FilingSearch.aspx', label: 'WY SOS' },
  Wyoming: { url: 'https://wyobiz.wyo.gov/Business/FilingSearch.aspx', label: 'WY SOS' },
  DE: { url: 'https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx', label: 'DE SOS' },
  Delaware: { url: 'https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx', label: 'DE SOS' },
  FL: { url: 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName', label: 'FL Sunbiz' },
  Florida: { url: 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName', label: 'FL Sunbiz' },
}

interface WizardProgressRecord {
  id: string
  wizard_type: string
  status: string
  data: Record<string, unknown> | null
}

interface LinkedAccount {
  id: string
  company_name: string
  state_of_formation: string | null
}

// Display format for a name option. Wizard-original names are rendered with
// the legacy " LLC" suffix (matches how the server persists them); admin-added
// names are rendered verbatim (per Antonio — no auto-append).
function displayName(option: UnifiedNameOption): string {
  if (option.source === 'admin_added') return option.name
  // wizard: show "{name} LLC" unless name already ends with LLC
  return /\bllc\b\s*$/i.test(option.name) ? option.name : `${option.name} LLC`
}

function rankLabel(option: UnifiedNameOption): string {
  if (option.source === 'admin_added') return 'added by staff'
  if (option.rank === 1) return '1st choice'
  if (option.rank === 2) return '2nd choice'
  if (option.rank === 3) return '3rd choice'
  return 'wizard'
}

export function LlcNameSelectionCard({
  wizardProgress,
  accounts,
  contactId,
}: {
  wizardProgress: WizardProgressRecord[]
  accounts: LinkedAccount[]
  contactId: string
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [formationDate, setFormationDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [filingId, setFilingId] = useState('')
  const [formationState, setFormationState] = useState<'' | 'NM' | 'WY' | 'FL' | 'DE'>('')
  // Optional LLC-type override. Blank = resolve automatically (signed contract
  // → formation form → wizard). Needed when none of those carry the type —
  // older contracts often lack it (Covelli/DoctorGut, 2026-07-28); without an
  // override the materializer refuses rather than guessing.
  const [entityType, setEntityType] = useState<'' | 'SMLLC' | 'MMLLC'>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Find formation wizard that's been submitted
  const formationWizard = wizardProgress.find(
    wp => wp.wizard_type === 'formation' && wp.status === 'submitted',
  )

  const data = useMemo(() => formationWizard?.data || {}, [formationWizard])
  const name1 = (data.llc_name_1 as string) || ''
  const name2 = (data.llc_name_2 as string) || ''
  const name3 = (data.llc_name_3 as string) || ''
  const chosenName = data.chosen_name as string | undefined
  const businessPurpose = (data.business_purpose as string) || ''
  const additionalNames = useMemo<AdminAddedName[]>(
    () => (Array.isArray(data.additional_names) ? (data.additional_names as AdminAddedName[]) : []),
    [data.additional_names],
  )

  const options = useMemo(
    () => mergeNames({ name1, name2, name3 }, additionalNames),
    [name1, name2, name3, additionalNames],
  )

  if (!formationWizard) return null
  // Even with no wizard-supplied names, show the card so staff can add names
  // manually if needed — but don't render if the formation wizard hasn't been
  // submitted (handled above).
  const hasAnyNames = options.length > 0

  // Determine state for SOS link
  const state = (data.owner_state_province as string) || accounts[0]?.state_of_formation || ''
  const sosLink = SOS_LINKS[state]

  // Already-selected detection: chosen_name has been recorded on the wizard.
  // (Antonio's model: name confirmation is a marker; the account is created
  // later when Articles of Organization are uploaded.)
  const alreadySet = !!chosenName

  // Materialization detection: a real account whose name matches the chosen
  // name now exists, meaning Articles have been uploaded and the company is
  // live in the CRM.
  const materializedAccount = chosenName
    ? accounts.find(a => a.company_name.toLowerCase().includes(chosenName.toLowerCase()))
    : null

  const handleUploadArticles = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      toast.error('Pick a PDF first')
      return
    }
    if (!formationDate) {
      toast.error('Set the formation date')
      return
    }
    if (!formationState) {
      toast.error('Pick the formation state')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('contact_id', contactId)
      fd.append('formation_date', formationDate)
      fd.append('formation_state', formationState)
      if (filingId.trim()) fd.append('filing_id', filingId.trim())
      if (entityType) fd.append('entity_type', entityType)
      const res = await fetch('/api/crm/admin-actions/upload-articles', {
        method: 'POST',
        body: fd,
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok && result.success) {
        toast.success(`Company created: ${result.account_id ? 'account ' + result.account_id.slice(0, 8) : 'see details'}`)
        setUploadOpen(false)
        window.location.reload()
      } else {
        const detail = result.error || 'Upload failed'
        toast.error(detail)
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Network error')
    } finally {
      setUploading(false)
    }
  }

  const handleAddName = async () => {
    const trimmed = newName.trim()
    if (!trimmed || !formationWizard) return
    setAdding(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: 'add_llc_name',
          params: { name: trimmed, wizard_progress_id: formationWizard.id },
        }),
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok && result.success) {
        toast.success(result.detail || `Added "${trimmed}"`)
        setNewName('')
        window.location.reload()
      } else {
        toast.error(result.detail || result.error || 'Failed to add name')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setAdding(false)
    }
  }

  const handleRemoveName = async (name: string) => {
    if (!formationWizard) return
    setRemovingName(name)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: 'remove_llc_name',
          params: { name, wizard_progress_id: formationWizard.id },
        }),
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok && result.success) {
        toast.success(result.detail || `Removed "${name}"`)
        if (selected === name) setSelected(null)
        window.location.reload()
      } else {
        toast.error(result.detail || result.error || 'Failed to remove name')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setRemovingName(null)
    }
  }

  const handleSelect = async () => {
    if (!selected || !formationWizard) return
    setLoading(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          action: 'select_llc_name',
          params: {
            selected_name: selected,
            wizard_progress_id: formationWizard.id,
          },
        }),
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok && result.success) {
        toast.success(result.detail)
        if (result.side_effects?.length) {
          toast.info(result.side_effects.join(' | '))
        }
        setConfirmOpen(false)
        window.location.reload()
      } else {
        toast.error(result.detail || result.error || 'Failed to set name')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  const selectedOption = options.find(o => o.name === selected) || null
  const finalDisplayName = selectedOption ? displayName(selectedOption) : ''

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          LLC Name Selection
        </h3>
        <div className="flex items-center gap-2">
          {alreadySet ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Selected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
              <AlertCircle className="h-3 w-3" /> Awaiting Selection
            </span>
          )}
          {sosLink && (
            <a
              href={sosLink.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
            >
              Check {sosLink.label} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {/* Already selected state */}
      {alreadySet && !materializedAccount && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-emerald-800">{chosenName}</div>
              <div className="text-xs text-emerald-600">Name recorded. Upload the Articles of Organization to create the company.</div>
            </div>
          </div>
          <button
            onClick={() => setUploadOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload Articles of Organization
          </button>
        </div>
      )}

      {/* Materialized state — company exists */}
      {alreadySet && materializedAccount && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-medium text-emerald-800">{materializedAccount.company_name}</div>
            <div className="text-xs text-emerald-600">Company created from Articles of Organization.</div>
          </div>
          <a
            href={`/accounts/${materializedAccount.id}`}
            className="text-xs text-emerald-700 hover:text-emerald-900 underline shrink-0"
          >
            Open
          </a>
        </div>
      )}

      {/* Name selection */}
      {!alreadySet && (
        <>
          {hasAnyNames && (
            <div className="space-y-2">
              {options.map(option => {
                const display = displayName(option)
                const isSelected = selected === option.name
                const isAdmin = option.source === 'admin_added'
                return (
                  <div
                    key={`${option.source}-${option.name}`}
                    className={`w-full p-3 rounded-lg border transition-all flex items-center gap-2 ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                        : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'
                    }`}
                  >
                    <button
                      onClick={() => setSelected(option.name)}
                      className="flex-1 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium">{display}</span>
                          <span className="ml-2 text-xs text-muted-foreground">({rankLabel(option)})</span>
                        </div>
                        <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          isSelected ? 'border-blue-500 bg-blue-500' : 'border-zinc-300'
                        }`}>
                          {isSelected && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </div>
                      </div>
                    </button>
                    {isAdmin && (
                      <FastTooltip label="Remove this name">
                        <button
                          onClick={() => handleRemoveName(option.name)}
                          disabled={removingName === option.name}
                          className="p-1 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 shrink-0 disabled:opacity-50"
                          aria-label="Remove this name"
                        >
                          {removingName === option.name ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <X className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </FastTooltip>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Add another name */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim() && !adding) {
                  e.preventDefault()
                  handleAddName()
                }
              }}
              placeholder="Type another name (saved exactly as written)…"
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-zinc-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={adding}
              maxLength={200}
            />
            <button
              onClick={handleAddName}
              disabled={!newName.trim() || adding}
              className="px-3 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add
            </button>
          </div>

          {/* Select button */}
          {hasAnyNames && (
            <button
              onClick={() => selected && setConfirmOpen(true)}
              disabled={!selected}
              className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                selected
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
              }`}
            >
              Confirm Selected Name
            </button>
          )}
        </>
      )}

      {/* Business purpose context */}
      {businessPurpose && (
        <div className="border-t pt-2 mt-2">
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Business purpose:</span>{' '}
            {businessPurpose.length > 150
              ? businessPurpose.slice(0, 150) + '...'
              : businessPurpose}
          </div>
        </div>
      )}

      {/* Upload Articles Dialog */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">Upload Articles of Organization</h3>
            <p className="text-sm text-zinc-600">
              Uploading the Articles will create the CRM account for{' '}
              <span className="font-semibold">{chosenName}</span> and migrate the contact&apos;s
              Drive folder to the company folder. Members and service deliveries are linked
              automatically. SS-4 is created in a follow-up step (set Registered Agent first).
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Articles PDF</label>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="application/pdf,image/*"
                  className="w-full text-sm border border-zinc-200 rounded-lg p-2 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1 file:text-sm file:font-medium hover:file:bg-zinc-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Formation date (per state filing)</label>
                <input
                  type="date"
                  value={formationDate}
                  onChange={e => setFormationDate(e.target.value)}
                  className="w-full text-sm border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Formation state</label>
                <select
                  value={formationState}
                  onChange={e => setFormationState(e.target.value as '' | 'NM' | 'WY' | 'FL' | 'DE')}
                  className="w-full text-sm border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select state…</option>
                  <option value="NM">New Mexico (NM)</option>
                  <option value="WY">Wyoming (WY)</option>
                  <option value="FL">Florida (FL)</option>
                  <option value="DE">Delaware (DE)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">SOS filing ID (optional)</label>
                <input
                  type="text"
                  value={filingId}
                  onChange={e => setFilingId(e.target.value)}
                  placeholder="e.g. 7234567"
                  className="w-full text-sm border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">LLC type (optional override)</label>
                <select
                  value={entityType}
                  onChange={e => setEntityType(e.target.value as '' | 'SMLLC' | 'MMLLC')}
                  className="w-full text-sm border border-zinc-200 rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Automatic (from contract / forms)</option>
                  <option value="SMLLC">Single-Member LLC</option>
                  <option value="MMLLC">Multi-Member LLC</option>
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Set this when the signed contract and the client&apos;s forms don&apos;t carry the
                  type (older contracts) — the company can&apos;t be created without it.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setUploadOpen(false)}
                disabled={uploading}
                className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUploadArticles}
                disabled={uploading}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {uploading ? 'Creating company…' : 'Upload and create company'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmOpen && selected && selectedOption && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">Confirm LLC Name</h3>

            <div className="text-sm space-y-2">
              <p>You are setting the official LLC name to:</p>
              <p className="font-semibold text-base">{finalDisplayName}</p>
              {selectedOption.source === 'admin_added' && (
                <p className="text-xs text-muted-foreground italic">
                  This is a staff-added name — saved exactly as written (no &quot; LLC&quot; auto-append).
                </p>
              )}
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">What happens:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>The chosen name is recorded on this contact for filing.</li>
                <li>The Company Formation service delivery name is updated.</li>
                <li><strong>The company itself is NOT created yet.</strong> File the LLC with the state, then upload the Articles of Organization here to create the company.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSelect}
                disabled={loading}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Setting...
                  </span>
                ) : (
                  `Set "${finalDisplayName}"`
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
