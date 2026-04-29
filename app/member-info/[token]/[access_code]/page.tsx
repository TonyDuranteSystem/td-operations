'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic, LOGO_URL } from '@/lib/supabase/public-client'

// ─── Types ───────────────────────────────────────────────────

type MemberType = 'individual' | 'company'

interface MemberRow {
  id: string
  member_type: MemberType
  // Individual fields
  full_name: string
  email: string
  phone: string
  ownership_pct: string
  address_street: string
  address_city: string
  address_state: string
  address_zip: string
  address_country: string
  // Company fields
  company_name: string
  ein: string
  representative_name: string
  representative_email: string
  representative_phone: string
  representative_address_street: string
  representative_address_city: string
  representative_address_state: string
  representative_address_zip: string
  representative_address_country: string
}

interface MemberInfoRequest {
  id: string
  account_id: string
  token: string
  access_code: string
  status: 'pending' | 'submitted'
  company_name: string | null
  entity_type: string | null
  pre_populated_data: { members: (Partial<MemberRow> & { is_signer?: boolean })[] } | null
  submitted_at: string | null
}

// ─── Helpers ─────────────────────────────────────────────────

function newMember(type: MemberType = 'individual'): MemberRow {
  return {
    id: Math.random().toString(36).slice(2),
    member_type: type,
    full_name: '', email: '', phone: '', ownership_pct: '',
    address_street: '', address_city: '', address_state: '', address_zip: '', address_country: '',
    company_name: '', ein: '',
    representative_name: '', representative_email: '', representative_phone: '',
    representative_address_street: '', representative_address_city: '',
    representative_address_state: '', representative_address_zip: '', representative_address_country: '',
  }
}

function fromPrePopulated(data: Partial<MemberRow>): MemberRow {
  return { ...newMember(data.member_type || 'individual'), ...data, id: Math.random().toString(36).slice(2) }
}

function totalOwnership(members: MemberRow[]): number {
  return members.reduce((sum, m) => sum + (parseFloat(m.ownership_pct) || 0), 0)
}

// ─── Main Page ───────────────────────────────────────────────

export default function MemberInfoPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' }}>Loading...</div>}>
      <MemberInfoContent />
    </Suspense>
  )
}

function MemberInfoContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params.token as string
  const accessCode = params.access_code as string
  const isAdminPreview = searchParams.get('preview') === 'td'

  const [request, setRequest] = useState<MemberInfoRequest | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [signerMemberId, setSignerMemberId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const loadRequest = useCallback(async () => {
    try {
      const { data, error: err } = await supabasePublic
        .from('member_info_requests')
        .select('id, account_id, token, access_code, status, company_name, entity_type, pre_populated_data, submitted_at')
        .eq('token', token)
        .eq('access_code', accessCode)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      const req = data as MemberInfoRequest
      setRequest(req)

      if (req.status === 'submitted') {
        setSubmitted(true)
        setLoading(false)
        return
      }

      if (req.pre_populated_data?.members?.length) {
        const newMembers = req.pre_populated_data.members.map(fromPrePopulated)
        setMembers(newMembers)
        // Restore the signer from pre-populated data
        const signerIdx = req.pre_populated_data.members.findIndex(m => m.is_signer)
        setSignerMemberId(newMembers[signerIdx >= 0 ? signerIdx : 0]?.id || null)
      } else {
        const first = newMember('individual')
        setMembers([first])
        setSignerMemberId(first.id)
      }

      setLoading(false)
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, accessCode])

  useEffect(() => {
    if (!token || !accessCode) { setError('invalid_link'); setLoading(false); return }
    loadRequest()
  }, [token, accessCode, loadRequest])

  function updateMember(id: string, field: keyof MemberRow, value: string) {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m))
  }

  function changeMemberType(id: string, type: MemberType) {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, member_type: type } : m))
  }

  function addMember() {
    setMembers(prev => [...prev, newMember('individual')])
  }

  function removeMember(id: string) {
    setMembers(prev => {
      const next = prev.filter(m => m.id !== id)
      if (signerMemberId === id && next.length > 0) {
        setSignerMemberId(next[0].id)
      }
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!request) return

    if (!signerMemberId) {
      setSubmitError('Please select the SS-4 Responsible Party — the member who will sign to obtain the EIN.')
      return
    }

    const total = totalOwnership(members)
    if (Math.abs(total - 100) > 0.01) {
      setSubmitError(`Ownership percentages must total 100%. Current total: ${total.toFixed(2)}%`)
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    const payload = members.map(m => ({ ...m, is_signer: m.id === signerMemberId }))

    const res = await fetch(`/api/member-info/${token}/${accessCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: payload }),
    })

    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setSubmitError(d.error || 'Submission failed. Please try again.')
      setSubmitting(false)
      return
    }

    setSubmitted(true)
    setSubmitting(false)
  }

  // ─── Render States ────────────────────────────────────────

  if (loading) return (
    <>
      <MemberInfoStyles />
      <div className="mi-loading">
        <div className="mi-spinner" />
        <span>Loading...</span>
      </div>
    </>
  )

  if (error) return (
    <>
      <MemberInfoStyles />
      <div className="mi-error-page">
        <h1>Link not found</h1>
        <p>This link is invalid or has expired. Please contact your advisor.</p>
      </div>
    </>
  )

  if (submitted) return (
    <>
      <MemberInfoStyles />
      <div className="mi-success-page">
        <div className="mi-success-box">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Tony Durante LLC" className="mi-logo" />
          <div style={{ fontSize: 48, margin: '16px 0' }}>✅</div>
          <h1>Information Submitted</h1>
          <p>Thank you! We have received the member information for <strong>{request?.company_name}</strong>. We will process it and update your account shortly.</p>
        </div>
      </div>
    </>
  )

  const total = totalOwnership(members)
  const totalOk = Math.abs(total - 100) < 0.01

  return (
    <>
      <MemberInfoStyles />
      <div className="mi-container">
        {/* Header */}
        <div className="mi-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOGO_URL} alt="Tony Durante LLC" className="mi-logo" />
        </div>

        {isAdminPreview && (
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <span style={{ display: 'inline-block', background: '#f59e0b', color: '#fff', padding: '3px 12px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
              ADMIN PREVIEW
            </span>
          </div>
        )}

        {/* Hero */}
        <div className="mi-hero">
          <div className="mi-hero-label">{request?.company_name}</div>
          <h1>LLC Member Information</h1>
          <p>Please provide the complete information for all members of the LLC.</p>
        </div>

        {/* Instructions */}
        <div className="mi-instructions">
          <div className="mi-instructions-title">How to fill out this form</div>
          <ul className="mi-instructions-list">
            <li><strong>Individual member</strong> — fill out only the individual fields (name, email, address, ownership %).</li>
            <li><strong>Company member</strong> — fill out both the company details (company name, EIN, address) AND the representative fields (the individual person who acts on behalf of the company).</li>
            <li><strong>SS-4 Responsible Party</strong> — select one member as the responsible party. This is the person who will sign the SS-4 form to obtain the EIN (tax identification number) for the company. Only one member can be selected.</li>
          </ul>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Members */}
          <div className="mi-members">
            {members.map((member, idx) => (
              <MemberCard
                key={member.id}
                member={member}
                index={idx}
                total={members.length}
                isSigner={member.id === signerMemberId}
                onSelectSigner={() => setSignerMemberId(member.id)}
                onChange={updateMember}
                onTypeChange={changeMemberType}
                onRemove={removeMember}
              />
            ))}
          </div>

          {/* Ownership total indicator */}
          <div className={`mi-ownership-total ${totalOk ? 'mi-total-ok' : 'mi-total-err'}`}>
            <span>Total ownership: <strong>{total.toFixed(2)}%</strong></span>
            {!totalOk && <span className="mi-total-hint"> — must equal 100%</span>}
            {totalOk && <span> ✓</span>}
          </div>

          {/* Add member button */}
          <button type="button" className="mi-add-btn" onClick={addMember}>
            + Add Member
          </button>

          {/* Submit */}
          {submitError && <div className="mi-error-msg">{submitError}</div>}

          <button
            type="submit"
            className="mi-submit-btn"
            disabled={submitting || members.length === 0}
          >
            {submitting ? 'Submitting...' : 'Submit Member Information'}
          </button>
        </form>
      </div>
    </>
  )
}

// ─── Member Card Component ────────────────────────────────────

interface MemberCardProps {
  member: MemberRow
  index: number
  total: number
  isSigner: boolean
  onSelectSigner: () => void
  onChange: (id: string, field: keyof MemberRow, value: string) => void
  onTypeChange: (id: string, type: MemberType) => void
  onRemove: (id: string) => void
}

function MemberCard({ member, index, total, isSigner, onSelectSigner, onChange, onTypeChange, onRemove }: MemberCardProps) {
  const isIndividual = member.member_type === 'individual'

  return (
    <div className={`mi-member-card ${isSigner ? 'mi-member-signer' : ''}`}>
      <div className="mi-member-header">
        <h3>Member {index + 1}</h3>
        <div className="mi-member-actions">
          <div className="mi-type-toggle">
            <button
              type="button"
              className={`mi-type-btn ${isIndividual ? 'mi-type-active' : ''}`}
              onClick={() => onTypeChange(member.id, 'individual')}
            >
              Individual
            </button>
            <button
              type="button"
              className={`mi-type-btn ${!isIndividual ? 'mi-type-active' : ''}`}
              onClick={() => onTypeChange(member.id, 'company')}
            >
              Company
            </button>
          </div>
          {total > 1 && (
            <button type="button" className="mi-remove-btn" onClick={() => onRemove(member.id)}>
              Remove
            </button>
          )}
        </div>
      </div>

      {/* SS-4 Signer selector */}
      <div className="mi-signer-row" onClick={onSelectSigner}>
        <div className={`mi-signer-radio ${isSigner ? 'mi-signer-radio-active' : ''}`} />
        <span className="mi-signer-label">
          {isSigner ? '✓ SS-4 Responsible Party' : 'Select as SS-4 Responsible Party'}
        </span>
      </div>

      <div className="mi-fields">
        {isIndividual ? (
          <>
            <Field label="Full Name" required value={member.full_name} onChange={v => onChange(member.id, 'full_name', v)} />
            <Field label="Email" type="email" required value={member.email} onChange={v => onChange(member.id, 'email', v)} />
            <Field label="Phone" type="tel" value={member.phone} onChange={v => onChange(member.id, 'phone', v)} />
            <Field label="Ownership %" type="number" required value={member.ownership_pct} onChange={v => onChange(member.id, 'ownership_pct', v)} min="0" max="100" step="0.01" />
            <div className="mi-section-label">Address</div>
            <Field label="Street" value={member.address_street} onChange={v => onChange(member.id, 'address_street', v)} />
            <div className="mi-fields-row">
              <Field label="City" value={member.address_city} onChange={v => onChange(member.id, 'address_city', v)} />
              <Field label="State" value={member.address_state} onChange={v => onChange(member.id, 'address_state', v)} />
            </div>
            <div className="mi-fields-row">
              <Field label="ZIP" value={member.address_zip} onChange={v => onChange(member.id, 'address_zip', v)} />
              <Field label="Country" value={member.address_country} onChange={v => onChange(member.id, 'address_country', v)} />
            </div>
          </>
        ) : (
          <>
            <Field label="Company Name" required value={member.company_name} onChange={v => onChange(member.id, 'company_name', v)} />
            <Field label="EIN" value={member.ein} onChange={v => onChange(member.id, 'ein', v)} placeholder="XX-XXXXXXX" />
            <Field label="Ownership %" type="number" required value={member.ownership_pct} onChange={v => onChange(member.id, 'ownership_pct', v)} min="0" max="100" step="0.01" />
            <div className="mi-section-label">Company Address</div>
            <Field label="Street" required value={member.address_street} onChange={v => onChange(member.id, 'address_street', v)} />
            <div className="mi-fields-row">
              <Field label="City" required value={member.address_city} onChange={v => onChange(member.id, 'address_city', v)} />
              <Field label="State" required value={member.address_state} onChange={v => onChange(member.id, 'address_state', v)} />
            </div>
            <div className="mi-fields-row">
              <Field label="ZIP" required value={member.address_zip} onChange={v => onChange(member.id, 'address_zip', v)} />
              <Field label="Country" required value={member.address_country} onChange={v => onChange(member.id, 'address_country', v)} />
            </div>
            <div className="mi-section-label">Representative (person acting on behalf of the company)</div>
            <Field label="Representative Name" required value={member.representative_name} onChange={v => onChange(member.id, 'representative_name', v)} />
            <Field label="Representative Email" type="email" required value={member.representative_email} onChange={v => onChange(member.id, 'representative_email', v)} />
            <Field label="Representative Phone" type="tel" value={member.representative_phone} onChange={v => onChange(member.id, 'representative_phone', v)} />
            <div className="mi-section-label">Representative Address</div>
            <Field label="Street" required value={member.representative_address_street} onChange={v => onChange(member.id, 'representative_address_street', v)} />
            <div className="mi-fields-row">
              <Field label="City" required value={member.representative_address_city} onChange={v => onChange(member.id, 'representative_address_city', v)} />
              <Field label="State" required value={member.representative_address_state} onChange={v => onChange(member.id, 'representative_address_state', v)} />
            </div>
            <div className="mi-fields-row">
              <Field label="ZIP" required value={member.representative_address_zip} onChange={v => onChange(member.id, 'representative_address_zip', v)} />
              <Field label="Country" required value={member.representative_address_country} onChange={v => onChange(member.id, 'representative_address_country', v)} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Field Component ──────────────────────────────────────────

interface FieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  placeholder?: string
  min?: string
  max?: string
  step?: string
}

function Field({ label, value, onChange, type = 'text', required, placeholder, min, max, step }: FieldProps) {
  return (
    <div className="mi-field">
      <label className="mi-label">
        {label}{required && <span className="mi-required">*</span>}
      </label>
      <input
        type={type}
        className="mi-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
      />
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────

function MemberInfoStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;500;600;700&family=Playfair+Display:wght@700&display=swap');

      body { background: #f7f8fa !important; color: #374151 !important; font-family: 'Source Sans 3', -apple-system, sans-serif !important; line-height: 1.6 !important; -webkit-font-smoothing: antialiased; margin: 0; }

      :root {
        --mi-blue: #1e3a5f; --mi-blue-light: #e8eff7; --mi-blue-lighter: #f0f5fb;
        --mi-green: #059669; --mi-red: #b8292f;
        --mi-gray-100: #f7f8fa; --mi-gray-200: #edf0f4; --mi-gray-300: #d1d5db;
        --mi-gray-500: #6b7280; --mi-gray-700: #374151;
      }

      .mi-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-size: 18px; color: var(--mi-gray-500); gap: 16px; }
      .mi-spinner { width: 32px; height: 32px; border: 3px solid var(--mi-gray-200); border-top-color: var(--mi-blue); border-radius: 50%; animation: mi-spin 0.8s linear infinite; }
      @keyframes mi-spin { to { transform: rotate(360deg); } }

      .mi-error-page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; text-align: center; }
      .mi-error-page h1 { font-family: 'Playfair Display', serif; font-size: 28px; color: var(--mi-blue); margin-bottom: 12px; }
      .mi-error-page p { font-size: 16px; color: var(--mi-gray-500); }

      .mi-success-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .mi-success-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 520px; width: 100%; }
      .mi-success-box h1 { font-family: 'Playfair Display', serif; font-size: 28px; color: var(--mi-green); margin-bottom: 12px; }
      .mi-success-box p { font-size: 16px; color: var(--mi-gray-500); line-height: 1.6; }

      .mi-container { max-width: 760px; margin: 0 auto; padding: 24px 16px 80px; }
      .mi-header { display: flex; align-items: center; margin-bottom: 24px; }
      .mi-logo { height: 44px; display: block; }

      .mi-hero { text-align: center; padding: 24px 0 20px; }
      .mi-hero-label { display: inline-block; background: var(--mi-blue-light); color: var(--mi-blue); padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 12px; }
      .mi-hero h1 { font-family: 'Playfair Display', serif; font-size: 30px; color: var(--mi-blue); margin: 0 0 8px; }
      .mi-hero p { font-size: 15px; color: var(--mi-gray-500); max-width: 540px; margin: 0 auto; }

      .mi-instructions { background: var(--mi-blue-lighter); border: 1px solid #c9d8ea; border-radius: 12px; padding: 18px 22px; margin-bottom: 28px; }
      .mi-instructions-title { font-size: 13px; font-weight: 700; color: var(--mi-blue); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
      .mi-instructions-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
      .mi-instructions-list li { font-size: 14px; color: var(--mi-gray-700); line-height: 1.5; }

      .mi-members { display: flex; flex-direction: column; gap: 20px; margin-bottom: 16px; }

      .mi-member-card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.06); padding: 28px; border: 2px solid transparent; transition: border-color .2s; }
      .mi-member-signer { border-color: var(--mi-blue); }
      .mi-member-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
      .mi-member-header h3 { font-family: 'Playfair Display', serif; font-size: 20px; color: var(--mi-blue); margin: 0; }
      .mi-member-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

      .mi-signer-row { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 10px 14px; background: var(--mi-gray-100); border-radius: 8px; margin-bottom: 20px; user-select: none; transition: background .15s; }
      .mi-signer-row:hover { background: var(--mi-blue-light); }
      .mi-signer-radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--mi-gray-300); background: #fff; flex-shrink: 0; transition: all .15s; }
      .mi-signer-radio-active { border-color: var(--mi-blue); background: var(--mi-blue); box-shadow: inset 0 0 0 3px #fff; }
      .mi-signer-label { font-size: 13px; font-weight: 600; color: var(--mi-gray-700); }
      .mi-member-signer .mi-signer-label { color: var(--mi-blue); }

      .mi-type-toggle { display: flex; border: 2px solid var(--mi-gray-200); border-radius: 8px; overflow: hidden; }
      .mi-type-btn { padding: 6px 16px; border: none; background: #fff; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--mi-gray-500); transition: all .2s; }
      .mi-type-active { background: var(--mi-blue); color: #fff; }

      .mi-remove-btn { padding: 6px 14px; border: 2px solid #fecaca; border-radius: 8px; background: #fef2f2; color: var(--mi-red); font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s; }
      .mi-remove-btn:hover { background: #fee2e2; }

      .mi-section-label { font-size: 12px; font-weight: 700; color: var(--mi-blue); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 16px; margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid var(--mi-gray-200); }

      .mi-fields { display: flex; flex-direction: column; gap: 14px; }
      .mi-fields-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .mi-field { display: flex; flex-direction: column; gap: 4px; }
      .mi-label { font-size: 13px; font-weight: 600; color: var(--mi-gray-700); }
      .mi-required { color: var(--mi-red); margin-left: 2px; }
      .mi-input { padding: 10px 12px; border: 2px solid var(--mi-gray-200); border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; transition: border-color .2s; box-sizing: border-box; background: #fff; }
      .mi-input:focus { border-color: var(--mi-blue); }

      .mi-ownership-total { margin: 4px 0 12px; padding: 10px 16px; border-radius: 8px; font-size: 14px; }
      .mi-total-ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
      .mi-total-err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      .mi-total-hint { font-size: 12px; }

      .mi-add-btn { display: block; width: 100%; padding: 12px; background: var(--mi-blue-lighter); color: var(--mi-blue); border: 2px dashed #c9d8ea; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all .2s; margin-bottom: 24px; }
      .mi-add-btn:hover { background: var(--mi-blue-light); }

      .mi-error-msg { background: #fef2f2; border: 1px solid #fecaca; color: var(--mi-red); padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }

      .mi-submit-btn { display: block; width: 100%; padding: 16px; background: var(--mi-blue); color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background .2s; }
      .mi-submit-btn:hover:not(:disabled) { background: #162d4a; }
      .mi-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

      @media (max-width: 640px) {
        .mi-container { padding: 16px 12px 80px; }
        .mi-member-card { padding: 20px 16px; }
        .mi-hero h1 { font-size: 24px; }
        .mi-fields-row { grid-template-columns: 1fr; }
        .mi-member-header { flex-direction: column; align-items: flex-start; }
      }
    `}</style>
  )
}
