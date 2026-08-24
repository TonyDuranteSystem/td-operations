'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Shield, ArrowLeft, Download, PenLine, Loader2, CheckCircle2, History, ScrollText, Send, AlertTriangle, Check, X } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import DistributionResolutionTemplate from '@/components/portal/distribution-resolution-template'
import TaxStatementTemplate from '@/components/portal/tax-statement-template'
import OperatingAgreementTemplate from '@/components/portal/operating-agreement-template'
import {
  type GeneratedDocumentType,
  type DocumentFormData,
  type MemberInfo,
  type DocumentCompanyData,
  type EntityCategory,
  getEntityCategory,
  getFiscalYearOptions,
  formatDocumentAmount,
} from '@/lib/portal/document-templates'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { interpolateString } from '@/lib/template-interpolation'

interface HistoryItem {
  id: string
  document_type: string
  fiscal_year: number
  amount: number | null
  currency: string | null
  distribution_date: string | null
  status: string
  created_at: string
}

interface ExtendedMemberInfo extends MemberInfo {
  address?: string | null
  isPrimary?: boolean
  // The flag the server actually resolves the document's Manager from —
  // see lib/portal/queries.ts::getPortalMembers. Dev job 9ad76300-6181-4250-a1de-c77f37933f82.
  isSigner?: boolean
  contact_id?: string | null
  email?: string | null
  member_id?: string
}

interface Props {
  account: {
    id: string
    companyName: string
    ein: string | null
    stateOfFormation: string | null
    formationDate: string | null
    physicalAddress: string | null
    logoUrl: string | null
    entityType: string | null
    registeredAgentAddress?: string | null
    memberCount?: number | null
  }
  members: ExtendedMemberInfo[]
  history: HistoryItem[]
}

type Stage = 'selection' | 'form' | 'preview' | 'signing' | 'done'

// Canonical English document-type names — used ONLY for the value sent to the
// server (a stored field, never displayed), never for on-screen text. Display
// labels come from the shared translation dictionary via docTypeLabel() below.
const DOCUMENT_TYPE_EN: Record<string, string> = {
  distribution_resolution: 'Distribution Resolution',
  tax_statement: 'Tax Statement',
  operating_agreement: 'Operating Agreement',
}

function docTypeLabel(type: string, t: (key: string) => string): string {
  if (type === 'distribution_resolution') return t('documentGenerate.distributionResolution')
  if (type === 'tax_statement') return t('documentGenerate.taxStatement')
  if (type === 'operating_agreement') return t('documentGenerate.operatingAgreement')
  return type
}

export function GenerateDocumentsClient({ account, members, history: initialHistory }: Props) {
  const { t } = useLocale()
  const router = useRouter()

  const [stage, setStage] = useState<Stage>('selection')
  const [selectedType, setSelectedType] = useState<GeneratedDocumentType | null>(null)
  const [formData, setFormData] = useState<DocumentFormData>({
    amount: 0,
    fiscalYear: new Date().getFullYear() - 1,
    distributionDate: new Date().toISOString().split('T')[0],
    currency: 'USD',
  })
  // OA-specific state
  const [oaEffectiveDate, setOaEffectiveDate] = useState(new Date().toISOString().split('T')[0])
  const [isGenerating, setIsGenerating] = useState(false)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [portalSaveWarning, setPortalSaveWarning] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory)
  const [oaCreateStatus, setOaCreateStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [oaNotified, setOaNotified] = useState(true)
  const [oaCanSignNow, setOaCanSignNow] = useState(false)
  const [oaCreateError, setOaCreateError] = useState<string | null>(null)
  // "Is this wrong?" never lets the client pick a different name at generation
  // time — it sends them to correct the actual member records instead
  // (Antonio, dev job 9ad76300-6181-4250-a1de-c77f37933f82 / 9ad76300-6181-4250-a1de-c77f37933f82).
  const [memberInfoRequestStatus, setMemberInfoRequestStatus] = useState<'idle' | 'opening' | 'error'>('idle')
  // Surfaces the SERVER's real reason (e.g. "no primary member set — contact
  // support"), not a fixed generic string — R099, and the specific gap
  // caught in dev job 9ad76300-6181-4250-a1de-c77f37933f82 where this screen was the one place that
  // still swallowed it.
  const [memberInfoRequestError, setMemberInfoRequestError] = useState<string | null>(null)

  const documentRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigPadRef = useRef<any>(null)

  const entityCategory: EntityCategory = getEntityCategory(account.entityType)
  const companyData: DocumentCompanyData = {
    companyName: account.companyName,
    ein: account.ein,
    stateOfFormation: account.stateOfFormation,
    formationDate: account.formationDate,
    physicalAddress: account.physicalAddress,
    logoUrl: account.logoUrl,
    entityType: account.entityType,
  }

  const fiscalYearOptions = getFiscalYearOptions()

  const isOA = selectedType === 'operating_agreement'
  // DB stores "Multi Member LLC" (long form) — normalize before comparing
  const isMMLC = normalizeEntityType(account.entityType) === 'MMLLC'

  // Pre-flight validation for MMLLC OA — runs whenever OA is selected
  const oaPreflight = isMMLC ? (() => {
    const memberCountOk = account.memberCount != null
      ? members.length === account.memberCount
      : null // null = not configured, can't check
    const allHavePortal = members.every(m => m.contact_id != null)
    const ownershipTotal = members.reduce((s, m) => s + (m.ownershipPct ?? 0), 0)
    const ownershipOk = Math.abs(ownershipTotal - 100) < 0.01
    const missingPortal = members.filter(m => !m.contact_id).map(m => m.fullName)
    return { memberCountOk, allHavePortal, ownershipOk, ownershipTotal, missingPortal }
  })() : null

  const oaCanProceed = !isMMLC || (oaPreflight?.allHavePortal === true)

  // Members with addresses resolved from OA state (for OA template)
  const oaMembers = members.map(m => ({
    fullName: m.fullName,
    // The record verbatim — the same value the create route stores, so the document
    // on screen and the document that gets signed cannot differ.
    address: m.address || '',
    ownershipPct: m.ownershipPct ?? 100 / members.length,
    // Who the template picks as Manager — is_signer first, matching the
    // server. Dev job 9ad76300-6181-4250-a1de-c77f37933f82 (the "Download PDF" path never reaches the
    // server at all, so this is the ONLY place that decides its Manager).
    isPrimary: m.isPrimary ?? false,
    isSigner: m.isSigner ?? false,
  }))

  // Initialize signature pad (non-async ref callback)
  const initSignaturePad = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return
    canvasRef.current = canvas
    import('signature_pad').then(({ default: SignaturePad }) => {
      const ratio = Math.max(window.devicePixelRatio || 1, 2)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      const ctx = canvas.getContext('2d')
      ctx?.scale(ratio, ratio)
      sigPadRef.current = new SignaturePad(canvas, {
        backgroundColor: 'rgb(255, 255, 255)',
        penColor: 'rgb(0, 0, 100)',
      })
    })
  }, [])

  const clearSignature = () => {
    sigPadRef.current?.clear()
  }

  const handleSelectType = (type: GeneratedDocumentType) => {
    setSelectedType(type)
    setSignatureImage(null)
    setStage('form')
  }

  const handlePreview = () => {
    if (!isOA && (formData.amount <= 0 || members.length === 0)) return
    setStage('preview')
  }

  const getPdfFilename = (signed: boolean) => {
    const company = account.companyName.replace(/\s+/g, '_')
    if (isOA) {
      return signed
        ? `Operating_Agreement_SIGNED_${company}_${oaEffectiveDate}.pdf`
        : `Operating_Agreement_${company}_${oaEffectiveDate}.pdf`
    }
    const prefix = selectedType === 'distribution_resolution' ? 'Distribution_Resolution' : 'Tax_Statement'
    return signed
      ? `${prefix}_SIGNED_${company}_${formData.fiscalYear}.pdf`
      : `${prefix}_${company}_${formData.fiscalYear}.pdf`
  }

  const handleDownloadPdf = async () => {
    if (!documentRef.current) return
    setIsGenerating(true)
    try {
      const html2pdf = (await import('html2pdf.js')).default
      await html2pdf()
        .set({
          margin: [0.5, 0.6, 0.7, 0.6],
          filename: getPdfFilename(false),
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        })
        .from(documentRef.current)
        .save()

      await saveToHistory('downloaded')
      setStage('done')
    } catch (err) {
      console.error('PDF generation failed:', err)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSignAndDownload = () => {
    setStage('signing')
  }

  // Save the signed file into the client's portal Documents folder. Surfaces it
  // as "new" for co-owners; never alerts the person who just signed it (server
  // pre-marks the maker as having seen it). Throws on failure so the caller can
  // log it — the user already has their download, so it's best-effort.
  const uploadSignedToPortal = async (blob: Blob, filename: string) => {
    const fd = new FormData()
    fd.append('file', blob, filename)
    fd.append('account_id', account.id)
    fd.append('document_type', selectedType ? (DOCUMENT_TYPE_EN[selectedType] ?? 'Generated Document') : 'Generated Document')
    fd.append('document_type_key', selectedType ?? '')
    fd.append('file_name', filename)
    const res = await fetch('/api/portal/generated-documents/save-signed', { method: 'POST', body: fd })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || t('documentGenerate.portalSaveFailed'))
    }
  }

  const handleConfirmSign = async () => {
    if (!sigPadRef.current || sigPadRef.current.isEmpty()) return
    const sigDataUrl = sigPadRef.current.toDataURL('image/png')
    setSignatureImage(sigDataUrl)

    setTimeout(async () => {
      if (!documentRef.current) return
      setIsGenerating(true)
      try {
        const html2pdf = (await import('html2pdf.js')).default
        const pdfOpts = {
          margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
          filename: getPdfFilename(true),
          image: { type: 'jpeg' as const, quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        }
        await html2pdf().set(pdfOpts).from(documentRef.current).save()

        await saveToHistory('signed')

        // Also save the signed file into the client's portal Documents folder so
        // it's findable/downloadable later. Self-signed docs only — the OA has
        // its own multi-signer flow. Best-effort: the user already has their
        // download, so a portal-save hiccup must not block completion.
        if (!isOA) {
          try {
            const pdfBlob: Blob = await html2pdf().set(pdfOpts).from(documentRef.current).outputPdf('blob')
            await uploadSignedToPortal(pdfBlob, getPdfFilename(true))
          } catch (saveErr) {
            console.error('Portal Documents save failed (download still succeeded):', saveErr)
            setPortalSaveWarning(true)
          }
        }
        setStage('done')
      } catch (err) {
        console.error('Signed PDF generation failed:', err)
      } finally {
        setIsGenerating(false)
      }
    }, 300)
  }

  const saveToHistory = async (status: string) => {
    try {
      const body = isOA
        ? {
            account_id: account.id,
            document_type: selectedType,
            fiscal_year: new Date().getFullYear(),
            amount: null,
            distribution_date: oaEffectiveDate,
            currency: null,
            status,
            metadata: {
              company_name: account.companyName,
              ein: account.ein,
              entity_type: account.entityType,
              effective_date: oaEffectiveDate,
            },
          }
        : {
            account_id: account.id,
            document_type: selectedType,
            fiscal_year: formData.fiscalYear,
            amount: formData.amount,
            distribution_date: formData.distributionDate,
            currency: formData.currency,
            status,
            metadata: {
              company_name: account.companyName,
              ein: account.ein,
              entity_type: account.entityType,
              entity_category: entityCategory,
            },
          }

      const res = await fetch('/api/portal/generated-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const newDoc = await res.json()
        setHistory(prev => [newDoc, ...prev])
      }
    } catch {
      // Non-blocking
    }
  }

  const handleCreateAndSend = async () => {
    setOaCreateStatus('sending')
    setOaCreateError(null)
    let succeeded = false
    try {
      const res = await fetch('/api/portal/operating-agreement/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: account.id,
          effective_date: oaEffectiveDate,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('documentGenerate.oaCreateFailed'))
      // The route tells us whether anyone was actually reached, and whether the
      // signer identified by THIS login can sign. Ignoring either produced a
      // confident green screen that was sometimes untrue.
      setOaNotified(data.notified !== false)
      setOaCanSignNow(data.canSignNow === true)
      setOaCreateStatus('sent')
      await saveToHistory('pending_signatures')
      setStage('done')
      succeeded = true
    } catch (err) {
      setOaCreateStatus('error')
      setOaCreateError(err instanceof Error ? err.message : t('documentGenerate.somethingWrong'))
    }

    // COMPLETION IS THE REFRESH SIGNAL (Antonio, 2026-07-22). The portal shell
    // is server-rendered once per full page load, so generating a document
    // in-session left the sidebar — including "Sign Documents" — frozen at its
    // old state. The fix is deliberately NOT a timer or a broadcast: refreshing
    // a document screen on a schedule would wipe a client's half-filled form.
    // Instead the client's own explicit "Create & Send for Signing" is what
    // triggers it, at the one moment nothing is half-typed.
    //
    // Placed OUTSIDE the try on purpose: a throw from refresh() inside it would
    // flip the UI to red AFTER the agreement was created and the signing links
    // were already sent, and the client's natural retry re-runs create — which
    // deletes and recreates the agreement.
    if (succeeded) router.refresh()
  }

  const handleUpdateMemberInfo = async () => {
    setMemberInfoRequestStatus('opening')
    setMemberInfoRequestError(null)
    try {
      const res = await fetch('/api/portal/member-info-form/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('documentGenerate.memberFormFailed'))
      setMemberInfoRequestStatus('idle')
      window.location.href = data.form_url
    } catch (err) {
      setMemberInfoRequestStatus('error')
      setMemberInfoRequestError(err instanceof Error && err.message ? err.message : t('documentGenerate.memberFormFailedRetry'))
    }
  }

  const handleReset = () => {
    setStage('selection')
    setSelectedType(null)
    setSignatureImage(null)
    setOaCreateStatus('idle')
    setOaCreateError(null)
    setFormData({
      amount: 0,
      fiscalYear: new Date().getFullYear() - 1,
      distributionDate: new Date().toISOString().split('T')[0],
      currency: 'USD',
    })
    setOaEffectiveDate(new Date().toISOString().split('T')[0])
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">{t('documentGenerate.pageTitle')}</h1>
        <p className="text-zinc-500 mt-1">{t('documentGenerate.pageDesc')}</p>
      </div>

      {/* === SELECTION STAGE === */}
      {stage === 'selection' && (
        <>
          <p className="text-sm text-zinc-500">{t('documentGenerate.selectDocType')}</p>
          <div className="grid md:grid-cols-2 gap-4">
            {/* Distribution Resolution Card */}
            <button
              onClick={() => handleSelectType('distribution_resolution')}
              className="text-left p-6 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-blue-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-700 group-hover:bg-blue-500/20 transition">
                  <FileText size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-900 group-hover:text-blue-600 transition">
                    {t('documentGenerate.distributionResolution')}
                  </h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {t('documentGenerate.distributionResolutionDesc')}
                  </p>
                </div>
              </div>
            </button>

            {/* Tax Statement Card */}
            <button
              onClick={() => handleSelectType('tax_statement')}
              className="text-left p-6 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-emerald-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-700 group-hover:bg-emerald-500/20 transition">
                  <Shield size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-900 group-hover:text-emerald-600 transition">
                    {t('documentGenerate.taxStatement')}
                  </h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {t('documentGenerate.taxStatementDesc')}
                  </p>
                </div>
              </div>
            </button>

            {/* Operating Agreement Card */}
            <button
              onClick={() => handleSelectType('operating_agreement')}
              className="text-left p-6 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 hover:border-violet-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-violet-500/10 text-violet-700 group-hover:bg-violet-500/20 transition">
                  <ScrollText size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-900 group-hover:text-violet-600 transition">
                    {t('documentGenerate.operatingAgreement')}
                  </h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {t('documentGenerate.operatingAgreementDesc')}
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* History */}
          {history.length > 0 && (
            <div className="mt-8">
              <h2 className="text-lg font-semibold text-zinc-900 flex items-center gap-2 mb-4">
                <History size={18} />
                {t('documentGenerate.history')}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-zinc-500">
                      <th className="text-left py-2 px-3">{t('documentGenerate.tableDocument')}</th>
                      <th className="text-left py-2 px-3">{t('documentGenerate.fiscalYear')}</th>
                      <th className="text-right py-2 px-3">{t('documentGenerate.amount')}</th>
                      <th className="text-center py-2 px-3">{t('documentGenerate.tableStatus')}</th>
                      <th className="text-left py-2 px-3">{t('documentGenerate.tableDate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id} className="border-b border-zinc-200 text-zinc-700">
                        <td className="py-2 px-3">{docTypeLabel(h.document_type, t)}</td>
                        <td className="py-2 px-3">{h.fiscal_year}</td>
                        <td className="py-2 px-3 text-right">
                          {h.amount ? formatDocumentAmount(h.amount, h.currency || 'USD') : '-'}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            h.status === 'signed'
                              ? 'bg-green-500/10 text-green-700'
                              : 'bg-blue-500/10 text-blue-700'
                          }`}>
                            {h.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-zinc-500">
                          {new Date(h.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* === FORM STAGE === */}
      {stage === 'form' && (
        <div className="space-y-6">
          <button onClick={handleReset} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 transition">
            <ArrowLeft size={16} /> {t('documentGenerate.back')}
          </button>

          <h2 className="text-xl font-semibold text-zinc-900">
            {docTypeLabel(selectedType || '', t)}
          </h2>

          {/* Read-only company fields */}
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.companyName')}</label>
              <div className="px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-700 text-sm">
                {account.companyName}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.ein')}</label>
              <div className="px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-700 text-sm">
                {account.ein || 'N/A'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.state')}</label>
              <div className="px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-700 text-sm">
                {account.stateOfFormation || 'N/A'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.entityType')}</label>
              <div className="px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-700 text-sm">
                {account.entityType || 'N/A'}
              </div>
            </div>
          </div>

          {/* OA-specific fields */}
          {isOA ? (
            <div className="space-y-4">
              {/* Pre-flight validation panel — MMLLC only */}
              {isMMLC && oaPreflight && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 space-y-2">
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{t('documentGenerate.preflightCheck')}</p>
                  {/* Member count */}
                  {account.memberCount != null ? (
                    <div className="flex items-center gap-2 text-sm">
                      {oaPreflight.memberCountOk
                        ? <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                        : <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />}
                      <span className={oaPreflight.memberCountOk ? 'text-zinc-700' : 'text-amber-600'}>
                        {interpolateString(
                          t(members.length === 1 ? 'documentGenerate.memberCountSingular' : 'documentGenerate.memberCountPlural'),
                          { count: members.length },
                        )}
                        {!oaPreflight.memberCountOk && ` ${interpolateString(t('documentGenerate.memberCountMismatch'), { count: account.memberCount })}`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4 text-zinc-500 shrink-0" />
                      <span className="text-zinc-500">{t('documentGenerate.memberCountUnconfirmed')}</span>
                    </div>
                  )}
                  {/* Portal access */}
                  <div className="flex items-start gap-2 text-sm">
                    {oaPreflight.allHavePortal
                      ? <Check className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      : <X className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />}
                    <span className={oaPreflight.allHavePortal ? 'text-zinc-700' : 'text-red-600'}>
                      {oaPreflight.allHavePortal
                        ? t('documentGenerate.allHavePortal')
                        : interpolateString(
                          t(oaPreflight.missingPortal.length === 1 ? 'documentGenerate.missingPortalSingular' : 'documentGenerate.missingPortalPlural'),
                          { names: oaPreflight.missingPortal.join(', ') },
                        )}
                    </span>
                  </div>
                  {/* Ownership */}
                  <div className="flex items-center gap-2 text-sm">
                    {oaPreflight.ownershipOk
                      ? <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                      : <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />}
                    <span className={oaPreflight.ownershipOk ? 'text-zinc-700' : 'text-amber-600'}>
                      {interpolateString(t('documentGenerate.ownershipLine'), {
                        breakdown: members.map(m => `${m.ownershipPct ?? '?'}%`).join(' + '),
                        total: oaPreflight.ownershipTotal.toFixed(0),
                      })}
                      {!oaPreflight.ownershipOk && ` ${t('documentGenerate.ownershipWarning')}`}
                    </span>
                  </div>
                  {/* Manager — who the agreement will name, resolved from the
                      member records, never from whoever is currently logged
                      in and clicking Generate. */}
                  {(() => {
                    // is_signer first — the same flag the server actually
                    // resolves the Manager from; is_primary is a fallback
                    // display only for the (currently unseen in production)
                    // case where an account has no is_signer flag set at
                    // all. Dev job 9ad76300-6181-4250-a1de-c77f37933f82.
                    const resolvedManager = members.find(m => m.isSigner) ?? members.find(m => m.isPrimary) ?? members[0]
                    return resolvedManager ? (
                      <div className="pt-2 mt-1 border-t border-zinc-200 flex items-start justify-between gap-3 flex-wrap">
                        <span className="text-sm text-zinc-700">
                          {t('documentGenerate.managerLabel')} <strong>{resolvedManager.fullName}</strong>
                        </span>
                        <button
                          type="button"
                          onClick={handleUpdateMemberInfo}
                          disabled={memberInfoRequestStatus === 'opening'}
                          className="text-xs text-violet-600 hover:text-violet-500 disabled:opacity-50 underline underline-offset-2"
                        >
                          {memberInfoRequestStatus === 'opening' ? t('documentGenerate.opening') : t('documentGenerate.notRightUpdateInfo')}
                        </button>
                      </div>
                    ) : null
                  })()}
                  {memberInfoRequestStatus === 'error' && memberInfoRequestError && (
                    <p className="text-xs text-red-600">{memberInfoRequestError}</p>
                  )}
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.effectiveDate')} *</label>
                <input
                  type="date"
                  value={oaEffectiveDate}
                  onChange={e => setOaEffectiveDate(e.target.value)}
                  className="w-full md:w-1/2 px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-900 text-sm focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.memberAddresses')}</label>
                <p className="text-xs text-zinc-500 mb-3">{t('documentGenerate.addressFromRecord')}</p>
                {/* READ-ONLY, for every company shape. These addresses go into a
                    legal document verbatim, so the screen shows the record and
                    offers no way to type over it; the route refuses a posted
                    address outright. */}
                <div className="space-y-2">
                  {members.map((m, i) => (
                    <div key={i} className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <p className="text-xs text-zinc-500">{m.fullName}</p>
                      {m.address ? (
                        <p className="text-sm text-zinc-900">{m.address}</p>
                      ) : (
                        /* Never blank and never a placeholder that could read as an
                           address — an absent record says so in words. */
                        <p className="text-sm text-amber-700">{t('documentGenerate.addressMissing')}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Distribution/Tax fields */
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.amount')} *</label>
                <div className="flex">
                  <select
                    value={formData.currency}
                    onChange={e => setFormData(p => ({ ...p, currency: e.target.value }))}
                    className="px-2 py-2 bg-zinc-50 rounded-l border border-r-0 border-zinc-200 text-zinc-700 text-sm"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.amount || ''}
                    onChange={e => setFormData(p => ({ ...p, amount: parseFloat(e.target.value) || 0 }))}
                    placeholder="0.00"
                    className="flex-1 px-3 py-2 bg-zinc-50 rounded-r border border-zinc-200 text-zinc-900 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.fiscalYear')} *</label>
                <select
                  value={formData.fiscalYear}
                  onChange={e => setFormData(p => ({ ...p, fiscalYear: parseInt(e.target.value) }))}
                  className="w-full px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-900 text-sm focus:outline-none focus:border-blue-500"
                >
                  {fiscalYearOptions.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{t('documentGenerate.distributionDate')} *</label>
                <input
                  type="date"
                  value={formData.distributionDate}
                  onChange={e => setFormData(p => ({ ...p, distributionDate: e.target.value }))}
                  className="w-full px-3 py-2 bg-zinc-50 rounded border border-zinc-200 text-zinc-900 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {/* An empty members list would make the document templates silently
              skip their body (the "two-line document" bug) — block instead. */}
          {!isOA && members.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {t('documentGenerate.noMembersError')}
              </span>
            </div>
          )}

          {/* Preview button */}
          <div className="flex justify-end">
            <button
              onClick={handlePreview}
              disabled={(!isOA && (formData.amount <= 0 || members.length === 0)) || (isOA && !oaCanProceed)}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 disabled:text-zinc-500 text-white rounded-lg font-medium text-sm transition"
              title={isOA && !oaCanProceed ? t('documentGenerate.portalOnlyTooltip') : undefined}
            >
              {t('documentGenerate.preview')}
            </button>
          </div>
        </div>
      )}

      {/* === PREVIEW STAGE === */}
      {(stage === 'preview' || stage === 'signing') && (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <button
              onClick={() => { setStage('form'); setSignatureImage(null) }}
              className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 transition"
            >
              <ArrowLeft size={16} /> {t('documentGenerate.back')}
            </button>
          </div>

          {/* Document Preview */}
          <div className="border border-zinc-200 rounded-lg overflow-hidden bg-white">
            {selectedType === 'distribution_resolution' ? (
              <DistributionResolutionTemplate
                ref={documentRef}
                company={companyData}
                members={members}
                form={formData}
                entityCategory={entityCategory}
                signatureImage={signatureImage}
              />
            ) : selectedType === 'tax_statement' ? (
              <TaxStatementTemplate
                ref={documentRef}
                company={companyData}
                members={members}
                form={formData}
                entityCategory={entityCategory}
                signatureImage={signatureImage}
              />
            ) : (
              <OperatingAgreementTemplate
                ref={documentRef}
                account={{
                  companyName: account.companyName,
                  ein: account.ein,
                  stateOfFormation: account.stateOfFormation,
                  formationDate: account.formationDate,
                  physicalAddress: account.physicalAddress,
                  entityType: account.entityType,
                  registeredAgentAddress: account.registeredAgentAddress || null,
                }}
                members={oaMembers}
                effectiveDate={oaEffectiveDate}
                signatureImage={signatureImage}
              />
            )}
          </div>

          {/* Signature Pad (signing stage) */}
          {stage === 'signing' && !signatureImage && (
            <div className="space-y-3">
              <p className="text-sm text-zinc-500">{t('documentGenerate.signBelow')}</p>
              <div className="border border-zinc-600 rounded-lg overflow-hidden bg-white">
                <canvas
                  ref={initSignaturePad}
                  style={{ width: '100%', height: '150px', touchAction: 'none' }}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={clearSignature}
                  className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-900 border border-zinc-200 rounded-lg transition"
                >
                  {t('documentGenerate.clearSignature')}
                </button>
                <button
                  onClick={handleConfirmSign}
                  disabled={isGenerating}
                  className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-zinc-300 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                >
                  {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <PenLine size={16} />}
                  {isGenerating ? t('documentGenerate.generating') : t('documentGenerate.confirmSign')}
                </button>
              </div>
            </div>
          )}

          {/* Action buttons (preview stage) */}
          {stage === 'preview' && (
            <div className="flex items-center gap-3 justify-end flex-wrap">
              <button
                onClick={handleDownloadPdf}
                disabled={isGenerating}
                className="px-6 py-2.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
              >
                {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {isGenerating ? t('documentGenerate.generating') : t('documentGenerate.downloadPdf')}
              </button>
              {isOA ? (
                <div className="space-y-1">
                  <button
                    onClick={handleCreateAndSend}
                    disabled={oaCreateStatus === 'sending'}
                    className="px-6 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-300 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                  >
                    {oaCreateStatus === 'sending' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    {oaCreateStatus === 'sending' ? t('documentGenerate.sending') : t('documentGenerate.createAndSend')}
                  </button>
                  {/* Sized to be readable, not decorative. This now carries the
                      blocking reason when an owner cannot be sent a signature
                      request (a named member, and what to do about it) — the
                      rule requires that reason to be VISIBLE to the client, and
                      a multi-sentence explanation in tiny right-aligned text
                      beside a button is not visible in any useful sense. */}
                  {oaCreateError && (
                    <p className="max-w-sm text-sm text-red-600 text-left leading-snug">{oaCreateError}</p>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleSignAndDownload}
                  className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                >
                  <PenLine size={16} />
                  {t('documentGenerate.signAndDownload')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* === DONE STAGE === */}
      {stage === 'done' && (
        <div className="flex flex-col items-center justify-center py-16 space-y-4 text-center">
          <CheckCircle2 size={48} className="text-green-600" />
          <h2 className="text-xl font-semibold text-zinc-900">
            {oaCreateStatus === 'sent'
              ? t('documentGenerate.signingStarted')
              : t('documentGenerate.success')}
          </h2>
          {oaCreateStatus === 'sent' && (
            <p className="text-sm text-zinc-500 max-w-sm">
              {/* Only point at the button when there IS one — this message can
                  fire for someone who is not a signer, and telling them to press
                  a button that does not render is its own dead end. */}
              {!oaNotified
                ? oaCanSignNow
                  ? t('documentGenerate.oaCreatedNoNotifyCanSign')
                  : t('documentGenerate.oaCreatedNoNotifyCantSign')
                : isMMLC
                ? t('documentGenerate.oaReadyMMLC')
                : t('documentGenerate.oaReadySingle')}
            </p>
          )}
          {portalSaveWarning && (
            <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-4 py-2 max-w-sm">
              {t('documentGenerate.portalSaveWarning')}
            </p>
          )}
          {/* THE fix for the incident this flow caused: a client who had just
              built their agreement landed here with only "Generate another" and
              had to ask where to sign. The notification we now send is the
              fallback for someone who closes the tab — it is not a substitute
              for letting them finish in the moment they are already here. The
              company is carried in the link so a client with more than one
              lands on the right one. */}
          {/* Only when the person looking at this screen is actually a signer.
              In a multi-member company the creator is not always one of the
              members — showing them this button sent them to a read-only page
              with nothing to click, which is the very problem this button was
              added to solve, recreated somewhere new. */}
          {oaCreateStatus === 'sent' && oaCanSignNow && (
            <a
              href={`/portal/sign/oa?account=${account.id}`}
              className="mt-4 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold text-sm transition"
            >
              {t('documentGenerate.signNow')}
            </a>
          )}
          <button
            onClick={handleReset}
            className={`${oaCreateStatus === 'sent' ? 'mt-2' : 'mt-4'} px-6 py-2.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg font-medium text-sm transition`}
          >
            {t('documentGenerate.generateAnother')}
          </button>
        </div>
      )}
    </div>
  )
}
