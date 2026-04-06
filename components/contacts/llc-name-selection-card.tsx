'use client'

import { useState } from 'react'
import { Building2, CheckCircle2, ExternalLink, Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'

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

  // Find formation wizard that's been submitted
  const formationWizard = wizardProgress.find(
    wp => wp.wizard_type === 'formation' && wp.status === 'submitted',
  )
  if (!formationWizard) return null

  const data = formationWizard.data || {}
  const name1 = (data.llc_name_1 as string) || ''
  const name2 = (data.llc_name_2 as string) || ''
  const name3 = (data.llc_name_3 as string) || ''
  const chosenName = data.chosen_name as string | undefined
  const businessPurpose = (data.business_purpose as string) || ''

  // If no names collected, don't show
  if (!name1 && !name2 && !name3) return null

  // Determine state for SOS link
  const state = (data.owner_state_province as string) || accounts[0]?.state_of_formation || ''
  const sosLink = SOS_LINKS[state]

  const names = [name1, name2, name3].filter(Boolean)

  // If already selected and account exists with that name
  const alreadySet = chosenName && accounts.some(a =>
    a.company_name.toLowerCase().includes(chosenName.toLowerCase()),
  )

  const handleSelect = async () => {
    if (!selected) return
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
      const result = await res.json()
      if (result.success) {
        toast.success(result.detail)
        if (result.side_effects?.length) {
          toast.info(result.side_effects.join(' | '))
        }
        setConfirmOpen(false)
        // Refresh page to get updated data
        window.location.reload()
      } else {
        toast.error(result.detail || 'Failed to set name')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

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
            <div className="text-sm font-medium text-emerald-800">{chosenName} LLC</div>
            <div className="text-xs text-emerald-600">Name confirmed and account created</div>
          </div>
        </div>
      )}

      {/* Name selection */}
      {!alreadySet && (
        <>
          <div className="space-y-2">
            {names.map((name, i) => (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  selected === name
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                    : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{name} LLC</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({i === 0 ? '1st' : i === 1 ? '2nd' : '3rd'} choice)
                    </span>
                  </div>
                  <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                    selected === name ? 'border-blue-500 bg-blue-500' : 'border-zinc-300'
                  }`}>
                    {selected === name && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Select button */}
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
      {confirmOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">Confirm LLC Name</h3>

            <div className="text-sm space-y-2">
              <p>You are setting the official LLC name to:</p>
              <p className="font-semibold text-base">{selected} LLC</p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">What happens:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Account will be created/updated with this name</li>
                <li>Service delivery name will be updated</li>
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
                  `Set "${selected} LLC"`
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
