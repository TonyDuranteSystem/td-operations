'use client'

import { useMemo, useState } from 'react'
import { Building2, CheckCircle2, ExternalLink, Loader2, AlertCircle, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { mergeNames, type AdminAddedName, type UnifiedNameOption } from '@/lib/llc-name-helpers'

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

  // Already-selected detection: account exists with a name that matches chosen_name
  const alreadySet = chosenName && accounts.some(a =>
    a.company_name.toLowerCase().includes(chosenName.toLowerCase()),
  )

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
      {alreadySet && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-lg border border-emerald-200">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <div className="text-sm font-medium text-emerald-800">{chosenName}</div>
            <div className="text-xs text-emerald-600">Name confirmed and account created</div>
          </div>
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
                      <button
                        onClick={() => handleRemoveName(option.name)}
                        disabled={removingName === option.name}
                        className="p-1 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 shrink-0 disabled:opacity-50"
                        title="Remove this name"
                      >
                        {removingName === option.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
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
                <li>Account will be created/updated with this name</li>
                <li>Service delivery name will be updated</li>
                <li>Google Drive company folder will be created</li>
                <li>This cannot be easily undone</li>
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
