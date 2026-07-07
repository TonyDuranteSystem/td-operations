'use client'

import { useState, useRef, useCallback } from 'react'
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
  locale: string
}

type Stage = 'selection' | 'form' | 'preview' | 'signing' | 'done'

const LABELS: Record<string, Record<string, string>> = {
  pageTitle: { en: 'Generate Documents', it: 'Genera Documenti' },
  pageDesc: {
    en: 'Generate formal documents for your company distributions.',
    it: 'Genera documenti formali per le distribuzioni della tua azienda.',
  },
  distributionResolution: { en: 'Distribution Resolution', it: 'Verbale di Distribuzione' },
  distributionResolutionDesc: {
    en: 'A formal resolution authorizing the distribution of profits from the company to its members.',
    it: 'Un verbale formale che autorizza la distribuzione degli utili dalla società ai suoi membri.',
  },
  taxStatement: { en: 'Tax Statement', it: 'Certificato Fiscale' },
  taxStatementDesc: {
    en: 'A certificate documenting the distribution and confirming the US tax status for foreign tax authorities.',
    it: 'Un certificato che documenta la distribuzione e conferma lo status fiscale USA per le autorità fiscali estere.',
  },
  operatingAgreement: { en: 'Operating Agreement', it: 'Atto Costitutivo' },
  operatingAgreementDesc: {
    en: 'The founding document of your LLC establishing ownership, management, and operating rules.',
    it: 'Il documento costitutivo della tua LLC che stabilisce proprietà, gestione e regole operative.',
  },
  effectiveDate: { en: 'Effective Date', it: 'Data di Efficacia' },
  memberAddresses: { en: 'Member Addresses', it: 'Indirizzi dei Soci' },
  addressHint: {
    en: 'Enter each member\'s full address to include in the Operating Agreement.',
    it: 'Inserisci l\'indirizzo completo di ciascun socio da includere nell\'Atto Costitutivo.',
  },
  address: { en: 'Address', it: 'Indirizzo' },
  amount: { en: 'Distribution Amount', it: 'Importo Distribuzione' },
  fiscalYear: { en: 'Fiscal Year', it: 'Anno Fiscale' },
  distributionDate: { en: 'Distribution Date', it: 'Data Distribuzione' },
  currency: { en: 'Currency', it: 'Valuta' },
  companyName: { en: 'Company', it: 'Azienda' },
  ein: { en: 'EIN', it: 'EIN' },
  state: { en: 'State', it: 'Stato' },
  entityType: { en: 'Entity Type', it: 'Tipo Entità' },
  preview: { en: 'Preview', it: 'Anteprima' },
  back: { en: 'Back', it: 'Indietro' },
  downloadPdf: { en: 'Download PDF', it: 'Scarica PDF' },
  signAndDownload: { en: 'Sign & Download', it: 'Firma e Scarica' },
  generating: { en: 'Generating PDF...', it: 'Generazione PDF...' },
  success: { en: 'Document generated successfully!', it: 'Documento generato con successo!' },
  generateAnother: { en: 'Generate Another', it: 'Genera Un Altro' },
  history: { en: 'Document History', it: 'Storico Documenti' },
  noHistory: { en: 'No documents generated yet.', it: 'Nessun documento generato.' },
  clearSignature: { en: 'Clear Signature', it: 'Cancella Firma' },
  signBelow: { en: 'Sign below to complete the document', it: 'Firma qui sotto per completare il documento' },
  confirmSign: { en: 'Confirm & Download', it: 'Conferma e Scarica' },
  selectDocType: { en: 'Select a document to generate', it: 'Seleziona un documento da generare' },
}

function l(key: string, locale: string): string {
  return LABELS[key]?.[locale] || LABELS[key]?.['en'] || key
}

function docTypeLabel(type: string, lang: string): string {
  if (type === 'distribution_resolution') return l('distributionResolution', lang)
  if (type === 'tax_statement') return l('taxStatement', lang)
  if (type === 'operating_agreement') return l('operatingAgreement', lang)
  return type
}

export function GenerateDocumentsClient({ account, members, history: initialHistory, locale }: Props) {
  const { locale: ctxLocale } = useLocale()
  const lang = ctxLocale || locale || 'en'

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
  const [oaMemberAddresses, setOaMemberAddresses] = useState<Record<number, string>>(
    Object.fromEntries(members.map((m, i) => [i, m.address || '']))
  )
  const [isGenerating, setIsGenerating] = useState(false)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory)
  const [oaCreateStatus, setOaCreateStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [oaCreateError, setOaCreateError] = useState<string | null>(null)

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
  const oaMembers = members.map((m, i) => ({
    fullName: m.fullName,
    address: oaMemberAddresses[i] || m.address || '',
    ownershipPct: m.ownershipPct ?? 100 / members.length,
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
    if (!isOA && formData.amount <= 0) return
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

  const handleConfirmSign = async () => {
    if (!sigPadRef.current || sigPadRef.current.isEmpty()) return
    const sigDataUrl = sigPadRef.current.toDataURL('image/png')
    setSignatureImage(sigDataUrl)

    setTimeout(async () => {
      if (!documentRef.current) return
      setIsGenerating(true)
      try {
        const html2pdf = (await import('html2pdf.js')).default
        await html2pdf()
          .set({
            margin: [0.5, 0.6, 0.7, 0.6],
            filename: getPdfFilename(true),
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
          })
          .from(documentRef.current)
          .save()

        await saveToHistory('signed')
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
    try {
      const memberAddresses = members.map((_, i) => oaMemberAddresses[i] || '')
      const res = await fetch('/api/portal/operating-agreement/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: account.id,
          effective_date: oaEffectiveDate,
          member_addresses: memberAddresses,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to create Operating Agreement')
      setOaCreateStatus('sent')
      await saveToHistory('pending_signatures')
      setStage('done')
    } catch (err) {
      setOaCreateStatus('error')
      setOaCreateError(err instanceof Error ? err.message : 'Something went wrong')
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
    setOaMemberAddresses(Object.fromEntries(members.map((m, i) => [i, m.address || ''])))
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">{l('pageTitle', lang)}</h1>
        <p className="text-zinc-400 mt-1">{l('pageDesc', lang)}</p>
      </div>

      {/* === SELECTION STAGE === */}
      {stage === 'selection' && (
        <>
          <p className="text-sm text-zinc-500">{l('selectDocType', lang)}</p>
          <div className="grid md:grid-cols-2 gap-4">
            {/* Distribution Resolution Card */}
            <button
              onClick={() => handleSelectType('distribution_resolution')}
              className="text-left p-6 rounded-lg border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-blue-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 transition">
                  <FileText size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-100 group-hover:text-blue-400 transition">
                    {l('distributionResolution', lang)}
                  </h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    {l('distributionResolutionDesc', lang)}
                  </p>
                </div>
              </div>
            </button>

            {/* Tax Statement Card */}
            <button
              onClick={() => handleSelectType('tax_statement')}
              className="text-left p-6 rounded-lg border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-emerald-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition">
                  <Shield size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-100 group-hover:text-emerald-400 transition">
                    {l('taxStatement', lang)}
                  </h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    {l('taxStatementDesc', lang)}
                  </p>
                </div>
              </div>
            </button>

            {/* Operating Agreement Card */}
            <button
              onClick={() => handleSelectType('operating_agreement')}
              className="text-left p-6 rounded-lg border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-violet-500/50 transition-all group"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-violet-500/10 text-violet-400 group-hover:bg-violet-500/20 transition">
                  <ScrollText size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-100 group-hover:text-violet-400 transition">
                    {l('operatingAgreement', lang)}
                  </h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    {l('operatingAgreementDesc', lang)}
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* History */}
          {history.length > 0 && (
            <div className="mt-8">
              <h2 className="text-lg font-semibold text-zinc-200 flex items-center gap-2 mb-4">
                <History size={18} />
                {l('history', lang)}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-700 text-zinc-400">
                      <th className="text-left py-2 px-3">Document</th>
                      <th className="text-left py-2 px-3">{l('fiscalYear', lang)}</th>
                      <th className="text-right py-2 px-3">{l('amount', lang)}</th>
                      <th className="text-center py-2 px-3">Status</th>
                      <th className="text-left py-2 px-3">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id} className="border-b border-zinc-800 text-zinc-300">
                        <td className="py-2 px-3">{docTypeLabel(h.document_type, lang)}</td>
                        <td className="py-2 px-3">{h.fiscal_year}</td>
                        <td className="py-2 px-3 text-right">
                          {h.amount ? formatDocumentAmount(h.amount, h.currency || 'USD') : '-'}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            h.status === 'signed'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-blue-500/10 text-blue-400'
                          }`}>
                            {h.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-zinc-400">
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
          <button onClick={handleReset} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition">
            <ArrowLeft size={16} /> {l('back', lang)}
          </button>

          <h2 className="text-xl font-semibold text-zinc-100">
            {docTypeLabel(selectedType || '', lang)}
          </h2>

          {/* Read-only company fields */}
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{l('companyName', lang)}</label>
              <div className="px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-300 text-sm">
                {account.companyName}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{l('ein', lang)}</label>
              <div className="px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-300 text-sm">
                {account.ein || 'N/A'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{l('state', lang)}</label>
              <div className="px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-300 text-sm">
                {account.stateOfFormation || 'N/A'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">{l('entityType', lang)}</label>
              <div className="px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-300 text-sm">
                {account.entityType || 'N/A'}
              </div>
            </div>
          </div>

          {/* OA-specific fields */}
          {isOA ? (
            <div className="space-y-4">
              {/* Pre-flight validation panel — MMLLC only */}
              {isMMLC && oaPreflight && (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-4 space-y-2">
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Pre-flight Check</p>
                  {/* Member count */}
                  {account.memberCount != null ? (
                    <div className="flex items-center gap-2 text-sm">
                      {oaPreflight.memberCountOk
                        ? <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                        : <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />}
                      <span className={oaPreflight.memberCountOk ? 'text-zinc-300' : 'text-amber-300'}>
                        {members.length} member{members.length !== 1 ? 's' : ''} in system
                        {!oaPreflight.memberCountOk && ` (SS-4 says ${account.memberCount})`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4 text-zinc-500 shrink-0" />
                      <span className="text-zinc-500">Member count not confirmed — contact your advisor if unsure</span>
                    </div>
                  )}
                  {/* Portal access */}
                  <div className="flex items-start gap-2 text-sm">
                    {oaPreflight.allHavePortal
                      ? <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                      : <X className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />}
                    <span className={oaPreflight.allHavePortal ? 'text-zinc-300' : 'text-red-300'}>
                      {oaPreflight.allHavePortal
                        ? 'All members have portal accounts'
                        : `Cannot send — ${oaPreflight.missingPortal.join(', ')} ${oaPreflight.missingPortal.length === 1 ? 'has' : 'have'} no portal account. Contact support.`}
                    </span>
                  </div>
                  {/* Ownership */}
                  <div className="flex items-center gap-2 text-sm">
                    {oaPreflight.ownershipOk
                      ? <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                      : <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />}
                    <span className={oaPreflight.ownershipOk ? 'text-zinc-300' : 'text-amber-300'}>
                      Ownership: {members.map(m => `${m.ownershipPct ?? '?'}%`).join(' + ')} = {oaPreflight.ownershipTotal.toFixed(0)}%
                      {!oaPreflight.ownershipOk && ' (should be 100%)'}
                    </span>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{l('effectiveDate', lang)} *</label>
                <input
                  type="date"
                  value={oaEffectiveDate}
                  onChange={e => setOaEffectiveDate(e.target.value)}
                  className="w-full md:w-1/2 px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">{l('memberAddresses', lang)}</label>
                <p className="text-xs text-zinc-500 mb-3">{l('addressHint', lang)}</p>
                <div className="space-y-3">
                  {members.map((m, i) => (
                    <div key={i}>
                      <label className="block text-xs text-zinc-400 mb-1">
                        {m.fullName} — {l('address', lang)}
                      </label>
                      <input
                        type="text"
                        value={oaMemberAddresses[i] || ''}
                        onChange={e => setOaMemberAddresses(prev => ({ ...prev, [i]: e.target.value }))}
                        placeholder="123 Main St, City, State, Country"
                        className="w-full px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-violet-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Distribution/Tax fields */
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{l('amount', lang)} *</label>
                <div className="flex">
                  <select
                    value={formData.currency}
                    onChange={e => setFormData(p => ({ ...p, currency: e.target.value }))}
                    className="px-2 py-2 bg-zinc-800 rounded-l border border-r-0 border-zinc-700 text-zinc-300 text-sm"
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
                    className="flex-1 px-3 py-2 bg-zinc-800 rounded-r border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{l('fiscalYear', lang)} *</label>
                <select
                  value={formData.fiscalYear}
                  onChange={e => setFormData(p => ({ ...p, fiscalYear: parseInt(e.target.value) }))}
                  className="w-full px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-blue-500"
                >
                  {fiscalYearOptions.map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">{l('distributionDate', lang)} *</label>
                <input
                  type="date"
                  value={formData.distributionDate}
                  onChange={e => setFormData(p => ({ ...p, distributionDate: e.target.value }))}
                  className="w-full px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {/* Preview button */}
          <div className="flex justify-end">
            <button
              onClick={handlePreview}
              disabled={(!isOA && formData.amount <= 0) || (isOA && !oaCanProceed)}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium text-sm transition"
              title={isOA && !oaCanProceed ? 'All members must have portal accounts to proceed' : undefined}
            >
              {l('preview', lang)}
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
              className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition"
            >
              <ArrowLeft size={16} /> {l('back', lang)}
            </button>
          </div>

          {/* Document Preview */}
          <div className="border border-zinc-700 rounded-lg overflow-hidden bg-white">
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
              <p className="text-sm text-zinc-400">{l('signBelow', lang)}</p>
              <div className="border border-zinc-600 rounded-lg overflow-hidden bg-white">
                <canvas
                  ref={initSignaturePad}
                  style={{ width: '100%', height: '150px', touchAction: 'none' }}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={clearSignature}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition"
                >
                  {l('clearSignature', lang)}
                </button>
                <button
                  onClick={handleConfirmSign}
                  disabled={isGenerating}
                  className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                >
                  {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <PenLine size={16} />}
                  {isGenerating ? l('generating', lang) : l('confirmSign', lang)}
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
                {isGenerating ? l('generating', lang) : l('downloadPdf', lang)}
              </button>
              {isOA ? (
                <div className="space-y-1">
                  <button
                    onClick={handleCreateAndSend}
                    disabled={oaCreateStatus === 'sending'}
                    className="px-6 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                  >
                    {oaCreateStatus === 'sending' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    {oaCreateStatus === 'sending' ? 'Sending...' : (lang === 'it' ? 'Crea e Invia per Firma' : 'Create & Send for Signing')}
                  </button>
                  {oaCreateError && (
                    <p className="text-xs text-red-400 text-right">{oaCreateError}</p>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleSignAndDownload}
                  className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
                >
                  <PenLine size={16} />
                  {l('signAndDownload', lang)}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* === DONE STAGE === */}
      {stage === 'done' && (
        <div className="flex flex-col items-center justify-center py-16 space-y-4 text-center">
          <CheckCircle2 size={48} className="text-green-400" />
          <h2 className="text-xl font-semibold text-zinc-100">
            {oaCreateStatus === 'sent'
              ? (lang === 'it' ? 'Firma avviata!' : 'Signing process started!')
              : l('success', lang)}
          </h2>
          {oaCreateStatus === 'sent' && (
            <p className="text-sm text-zinc-400 max-w-sm">
              {isMMLC
                ? (lang === 'it'
                  ? 'Ogni socio ha ricevuto il link personale per firmare l\'Atto Costitutivo nel portale.'
                  : 'Each member has received their personal signing link in the portal. You will be notified once all members have signed.')
                : (lang === 'it'
                  ? 'Il tuo Atto Costitutivo è pronto per la firma. Vai alla sezione Firma per completare il processo.'
                  : 'Your Operating Agreement is ready to sign. Go to the Sign section to complete the process.')}
            </p>
          )}
          <button
            onClick={handleReset}
            className="mt-4 px-6 py-2.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg font-medium text-sm transition"
          >
            {l('generateAnother', lang)}
          </button>
        </div>
      )}
    </div>
  )
}
