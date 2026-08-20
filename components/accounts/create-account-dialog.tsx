'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus, Search, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { ACCOUNT_STATUS, COMPANY_TYPE, CREATABLE_ACCOUNT_TYPE } from '@/lib/constants'
import { createAccount, searchContacts } from '@/app/(dashboard)/accounts/actions'
import type { CreateAccountInput, PrimaryContactInput } from '@/lib/schemas/account-create'
import { useRouter } from 'next/navigation'

interface ExistingContactResult {
  id: string
  full_name: string
  email: string | null
}

interface CreateAccountDialogProps {
  open: boolean
  onClose: () => void
}

const US_STATES = ['Wyoming', 'Delaware', 'Florida', 'New Mexico', 'Texas', 'California', 'New York']

const inputCls = 'w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500'
const labelCls = 'block text-sm font-medium mb-1'
const errorCls = 'text-xs text-red-600 mt-1'

export function CreateAccountDialog({ open, onClose }: CreateAccountDialogProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [companyName, setCompanyName] = useState('')
  const [entityType, setEntityType] = useState('')
  const [memberStructure, setMemberStructure] = useState('')
  const [stateOfFormation, setStateOfFormation] = useState('')
  const [status, setStatus] = useState('Pending Formation')
  const [accountType, setAccountType] = useState('Client')
  const [einNumber, setEinNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [firstName, setFirstName] = useState('')
  const [middleName, setMiddleName] = useState('')
  const [lastName, setLastName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [addressCity, setAddressCity] = useState('')
  const [addressState, setAddressState] = useState('')
  const [addressZip, setAddressZip] = useState('')
  const [addressCountry, setAddressCountry] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [existingContactQuery, setExistingContactQuery] = useState('')
  const [existingContactResults, setExistingContactResults] = useState<ExistingContactResult[]>([])
  const [searchingExisting, setSearchingExisting] = useState(false)
  const [selectedExistingContact, setSelectedExistingContact] = useState<ExistingContactResult | null>(null)
  const [memberSetupReminder, setMemberSetupReminder] = useState<{ accountId: string } | null>(null)

  if (!open) return null

  const resetForm = () => {
    setCompanyName('')
    setEntityType('')
    setMemberStructure('')
    setStateOfFormation('')
    setStatus('Pending Formation')
    setAccountType('Client')
    setEinNumber('')
    setNotes('')
    setFirstName('')
    setMiddleName('')
    setLastName('')
    setContactEmail('')
    setAddressLine1('')
    setAddressCity('')
    setAddressState('')
    setAddressZip('')
    setAddressCountry('')
    setErrors({})
    setExistingContactQuery('')
    setExistingContactResults([])
    setSelectedExistingContact(null)
  }

  const handleSearchExisting = async (query: string) => {
    setExistingContactQuery(query)
    if (query.length < 2) { setExistingContactResults([]); return }
    setSearchingExisting(true)
    try {
      const results = await searchContacts(query)
      setExistingContactResults(results)
    } catch {
      setExistingContactResults([])
    } finally {
      setSearchingExisting(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const nextErrors: Record<string, string> = {}
    if (!companyName.trim()) nextErrors.company_name = 'Company name is required'
    if (!entityType) nextErrors.entity_type = 'Entity type is required'
    if (!memberStructure) nextErrors.member_structure = 'Member structure is required'
    if (!stateOfFormation.trim()) nextErrors.state_of_formation = 'State of formation is required'
    if (!selectedExistingContact) {
      if (!firstName.trim()) nextErrors.first_name = 'First name is required'
      if (!lastName.trim()) nextErrors.last_name = 'Last name is required'
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    startTransition(async () => {
      const input: CreateAccountInput = {
        company_name: companyName.trim(),
        entity_type: entityType as CreateAccountInput['entity_type'],
        member_structure: memberStructure as CreateAccountInput['member_structure'],
        state_of_formation: stateOfFormation.trim(),
        status: status as CreateAccountInput['status'],
        account_type: accountType as CreateAccountInput['account_type'],
        ein_number: einNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      }

      const result = selectedExistingContact
        ? await createAccount(input, null, selectedExistingContact.id)
        : await createAccount(input, {
            first_name: firstName.trim(),
            middle_name: middleName.trim() || undefined,
            last_name: lastName.trim(),
            email: contactEmail.trim() || undefined,
            address_line1: addressLine1.trim() || undefined,
            address_city: addressCity.trim() || undefined,
            address_state: addressState.trim() || undefined,
            address_zip: addressZip.trim() || undefined,
            address_country: addressCountry.trim() || undefined,
          } satisfies PrimaryContactInput)

      if (result.success) {
        if (result.warning) {
          toast.warning(result.warning)
        } else {
          toast.success('Account created')
        }
        // Multi-Member accounts created from THIS dialog are never covered
        // by the client formation workflow's own member/signer collection —
        // this dialog is a manual/staff path only. Block on a real
        // acknowledgment instead of a toast that could be missed (Antonio,
        // 2026-08-19, dev_task 693273fd).
        if (result.data?.id && result.needsMemberSetup) {
          setMemberSetupReminder({ accountId: result.data.id })
          resetForm()
          return
        }
        resetForm()
        onClose()
        if (result.data?.id) {
          router.push(`/accounts/${result.data.id}`)
        }
      } else {
        toast.error(result.error ?? 'Failed to create account')
      }
    })
  }

  const handleMemberSetupAcknowledge = () => {
    if (!memberSetupReminder) return
    const accountId = memberSetupReminder.accountId
    setMemberSetupReminder(null)
    onClose()
    router.push(`/accounts/${accountId}`)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  return (
    <>
      {/* Backdrop — not click-to-dismiss while the member-setup reminder is
          showing, so it can't be missed by an accidental click outside it. */}
      <div className="fixed inset-0 z-50 bg-black/50" onClick={memberSetupReminder ? undefined : handleClose} />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {memberSetupReminder ? (
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4"
          onClick={e => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold">Multi-Member company created</h2>
          <p className="text-sm text-zinc-600">
            This account was created outside the client formation process, so its member roster wasn&apos;t collected. Go to the company page now to add the other members and confirm who the primary contact is and who signs documents.
          </p>
          <div className="flex justify-end">
            <button
              onClick={handleMemberSetupAcknowledge}
              className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800"
            >
              Go set up members
            </button>
          </div>
        </div>
        ) : (
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">New Account</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Company Name */}
            <div>
              <label className={labelCls}>Company Name *</label>
              <input
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                autoFocus
                placeholder="e.g. Smith Holdings LLC"
                className={inputCls}
              />
              {errors.company_name && <p className={errorCls}>{errors.company_name}</p>}
            </div>

            {/* Entity Type + Member Structure (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Entity Type *</label>
                <select
                  value={entityType}
                  onChange={e => setEntityType(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select...</option>
                  {COMPANY_TYPE.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                {errors.entity_type && <p className={errorCls}>{errors.entity_type}</p>}
              </div>
              <div>
                <label className={labelCls}>Member Structure *</label>
                <select
                  value={memberStructure}
                  onChange={e => setMemberStructure(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select...</option>
                  <option value="single_member">Single Member</option>
                  <option value="multi_member">Multi Member</option>
                </select>
                {errors.member_structure && <p className={errorCls}>{errors.member_structure}</p>}
                {memberStructure === 'multi_member' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Add the other members on the account page after creating it.
                  </p>
                )}
              </div>
            </div>

            {/* Status + State of Formation (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className={inputCls}
                >
                  {ACCOUNT_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>State of Formation *</label>
                <input
                  type="text"
                  value={stateOfFormation}
                  onChange={e => setStateOfFormation(e.target.value)}
                  list="us-states"
                  placeholder="e.g. Wyoming"
                  className={inputCls}
                />
                <datalist id="us-states">
                  {US_STATES.map(s => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                {errors.state_of_formation && <p className={errorCls}>{errors.state_of_formation}</p>}
              </div>
            </div>

            {/* Role. Defaults to Client, the vast majority case, but is
                always an explicit, visible choice. 'Partner' is NOT offered
                here on purpose — it's an unrelated, narrower tag (exempts a
                company from the data-completeness audit) that looks like it
                registers a referral partner but doesn't. Registering an
                actual partner (commission tracking, payouts) is the
                Partners page's own "New Partner" flow. */}
            <div>
              <label className={labelCls}>Role</label>
              <select
                value={accountType}
                onChange={e => setAccountType(e.target.value)}
                className={inputCls}
              >
                {CREATABLE_ACCOUNT_TYPE.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* EIN Number */}
            <div>
              <label className={labelCls}>EIN Number</label>
              <input
                type="text"
                value={einNumber}
                onChange={e => setEinNumber(e.target.value)}
                placeholder="XX-XXXXXXX"
                className={inputCls}
              />
            </div>

            {/* Primary Contact — the account's owner/signer for a single-member LLC.
                For a multi-member LLC, add the remaining members from the account
                page once it's created (Members section, handles ownership %/signer). */}
            <div className="border-t pt-4 space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Primary Contact</h3>

              {/* Search for an existing person already in the system, so
                  staff can deliberately reuse that record instead of typing
                  a new one that might collide with them (dev_task 693273fd). */}
              {selectedExistingContact ? (
                <div className="flex items-center justify-between px-3 py-2 border rounded-md bg-blue-50 border-blue-200">
                  <div className="flex items-center gap-2 text-sm">
                    <UserCheck className="h-4 w-4 text-blue-600" />
                    <span className="font-medium">{selectedExistingContact.full_name}</span>
                    {selectedExistingContact.email && (
                      <span className="text-xs text-zinc-500">{selectedExistingContact.email}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedExistingContact(null)}
                    className="text-xs text-zinc-500 hover:text-zinc-700"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                    <input
                      type="text"
                      value={existingContactQuery}
                      onChange={e => handleSearchExisting(e.target.value)}
                      placeholder="Search for an existing contact (optional)..."
                      className={`${inputCls} pl-8`}
                    />
                  </div>
                  {searchingExisting && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400 py-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Searching...
                    </div>
                  )}
                  {existingContactResults.length > 0 && (
                    <div className="divide-y border rounded-md bg-white max-h-32 overflow-y-auto">
                      {existingContactResults.map(r => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setSelectedExistingContact(r)
                            setExistingContactQuery('')
                            setExistingContactResults([])
                          }}
                          className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-blue-50 transition-colors"
                        >
                          <div>
                            <span className="font-medium">{r.full_name}</span>
                            {r.email && <span className="text-xs text-zinc-400 ml-2">{r.email}</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!selectedExistingContact && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className={labelCls}>First Name *</label>
                      <input
                        type="text"
                        value={firstName}
                        onChange={e => setFirstName(e.target.value)}
                        placeholder="Jane"
                        className={inputCls}
                      />
                      {errors.first_name && <p className={errorCls}>{errors.first_name}</p>}
                    </div>
                    <div>
                      <label className={labelCls}>Middle Name</label>
                      <input
                        type="text"
                        value={middleName}
                        onChange={e => setMiddleName(e.target.value)}
                        placeholder="(if any)"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Last Name *</label>
                      <input
                        type="text"
                        value={lastName}
                        onChange={e => setLastName(e.target.value)}
                        placeholder="Smith"
                        className={inputCls}
                      />
                      {errors.last_name && <p className={errorCls}>{errors.last_name}</p>}
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Email</label>
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={e => setContactEmail(e.target.value)}
                      placeholder="jane@example.com"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Address</label>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        placeholder="Street address"
                        className={`${inputCls} col-span-2`}
                        value={addressLine1}
                        onChange={e => setAddressLine1(e.target.value)}
                      />
                      <input
                        placeholder="City"
                        className={inputCls}
                        value={addressCity}
                        onChange={e => setAddressCity(e.target.value)}
                      />
                      <input
                        placeholder="State / Province"
                        className={inputCls}
                        value={addressState}
                        onChange={e => setAddressState(e.target.value)}
                      />
                      <input
                        placeholder="ZIP / Postal code"
                        className={inputCls}
                        value={addressZip}
                        onChange={e => setAddressZip(e.target.value)}
                      />
                      <input
                        placeholder="Country"
                        className={inputCls}
                        value={addressCountry}
                        onChange={e => setAddressCountry(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Notes */}
            <div>
              <label className={labelCls}>Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Additional notes..."
                className={`${inputCls} resize-none`}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
            </div>
          </form>
        </div>
        )}
      </div>
    </>
  )
}
