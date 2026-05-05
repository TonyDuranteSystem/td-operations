'use client'

import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, Download, PenLine, Loader2, CheckCircle2, History, ScrollText } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import OperatingAgreementTemplate from '@/components/portal/operating-agreement-template'

interface OAMemberInput {
  fullName: string
  ownershipPct: number
  isPrimary: boolean
  address: string | null
}

interface HistoryItem {
  id: string
  document_type: string
  status: string
  created_at: string
}

interface Props {
  account: {
    id: string
    companyName: string
    ein: string | null
    stateOfFormation: string | null
    formationDate: string | null
    physicalAddress: string | null
    entityType: string | null
    registeredAgentAddress: string | null
  }
  members: OAMemberInput[]
  history: HistoryItem[]
  locale: string
}

type Stage = 'form' | 'preview' | 'signing' | 'done'

const LABELS: Record<string, Record<string, string>> = {
  pageTitle: { en: 'Operating Agreement', it: 'Atto Costitutivo' },
  pageDesc: {
    en: 'Generate and sign your Operating Agreement.',
    it: 'Genera e firma il tuo Atto Costitutivo.',
  },
  effectiveDate: { en: 'Effective Date', it: 'Data di Efficacia' },
  memberAddresses: { en: 'Member Addresses', it: 'Indirizzi dei Soci' },
  addressHint: {
    en: 'Some member addresses are missing. Please fill them in before generating the OA.',
    it: 'Mancano alcuni indirizzi dei soci. Compilali prima di generare l\'Atto Costitutivo.',
  },
  address: { en: 'Address', it: 'Indirizzo' },
  preview: { en: 'Preview', it: 'Anteprima' },
  back: { en: 'Back', it: 'Indietro' },
  downloadPdf: { en: 'Download PDF', it: 'Scarica PDF' },
  signAndDownload: { en: 'Sign & Download', it: 'Firma e Scarica' },
  generating: { en: 'Generating PDF...', it: 'Generazione PDF...' },
  success: { en: 'Operating Agreement downloaded!', it: 'Atto Costitutivo scaricato!' },
  generateAnother: { en: 'Generate Another', it: 'Genera Un Altro' },
  history: { en: 'Document History', it: 'Storico Documenti' },
  clearSignature: { en: 'Clear Signature', it: 'Cancella Firma' },
  signBelow: { en: 'Sign below to complete the document', it: 'Firma qui sotto per completare il documento' },
  confirmSign: { en: 'Confirm & Download', it: 'Conferma e Scarica' },
  generate: { en: 'Generate', it: 'Genera' },
  noHistory: { en: 'No documents generated yet.', it: 'Nessun documento generato.' },
  unsupportedState: {
    en: 'Operating Agreement generation is supported for FL, NM, WY, and DE. Your company is registered in another state.',
    it: 'La generazione dell\'Atto Costitutivo è supportata per FL, NM, WY e DE. La tua azienda è registrata in un altro stato.',
  },
}

const SUPPORTED_STATES = ['FL', 'NM', 'WY', 'DE', 'FLORIDA', 'NEW MEXICO', 'WYOMING', 'DELAWARE']

function l(key: string, locale: string): string {
  return LABELS[key]?.[locale] || LABELS[key]?.['en'] || key
}

export function OperatingAgreementClient({ account, members, history: initialHistory, locale }: Props) {
  const { locale: ctxLocale } = useLocale()
  const lang = ctxLocale || locale || 'en'

  const [stage, setStage] = useState<Stage>('form')
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split('T')[0])
  const [memberAddresses, setMemberAddresses] = useState<Record<number, string>>(
    Object.fromEntries(members.map((m, i) => [i, m.address || '']))
  )
  const [isGenerating, setIsGenerating] = useState(false)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory)

  const documentRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigPadRef = useRef<any>(null)

  const stateRaw = account.stateOfFormation?.toUpperCase() || ''
  const isSupported = SUPPORTED_STATES.some(s => stateRaw.includes(s))

  const hasMissingAddresses = members.some((_, i) => !memberAddresses[i]?.trim())

  const resolvedMembers = members.map((m, i) => ({
    fullName: m.fullName,
    ownershipPct: m.ownershipPct,
    address: memberAddresses[i]?.trim() || 'As on file with the Company',
  }))

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

  const clearSignature = () => sigPadRef.current?.clear()

  const handlePreview = () => {
    setStage('preview')
  }

  const saveToHistory = async (status: string) => {
    try {
      const res = await fetch('/api/portal/generated-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: account.id,
          document_type: 'operating_agreement',
          fiscal_year: new Date().getFullYear(),
          status,
          metadata: {
            company_name: account.companyName,
            state_of_formation: account.stateOfFormation,
            effective_date: effectiveDate,
            member_count: members.length,
          },
        }),
      })
      if (res.ok) {
        const newDoc = await res.json()
        setHistory(prev => [newDoc, ...prev])
      }
    } catch {
      // Non-blocking
    }
  }

  const handleDownloadPdf = async () => {
    if (!documentRef.current) return
    setIsGenerating(true)
    try {
      const html2pdf = (await import('html2pdf.js')).default
      const filename = `Operating_Agreement_${account.companyName.replace(/\s+/g, '_')}_${effectiveDate}.pdf`
      await html2pdf()
        .set({
          margin: [0.5, 0.6, 0.7, 0.6],
          filename,
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
        const filename = `Operating_Agreement_SIGNED_${account.companyName.replace(/\s+/g, '_')}_${effectiveDate}.pdf`
        await html2pdf()
          .set({
            margin: [0.5, 0.6, 0.7, 0.6],
            filename,
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

  const handleReset = () => {
    setStage('form')
    setSignatureImage(null)
  }

  if (!isSupported) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold text-zinc-100 mb-4">{l('pageTitle', lang)}</h1>
        <div className="p-6 rounded-lg border border-amber-700 bg-amber-900/20 text-amber-300">
          {l('unsupportedState', lang)}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <ScrollText size={24} />
          {l('pageTitle', lang)}
        </h1>
        <p className="text-zinc-400 mt-1">{l('pageDesc', lang)}</p>
      </div>

      {/* === FORM STAGE === */}
      {stage === 'form' && (
        <div className="space-y-6">
          {/* Effective Date */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">{l('effectiveDate', lang)} *</label>
            <input
              type="date"
              value={effectiveDate}
              onChange={e => setEffectiveDate(e.target.value)}
              className="w-full max-w-xs px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Member Addresses (only show if any are missing) */}
          {hasMissingAddresses && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg border border-amber-700 bg-amber-900/20 text-amber-300 text-sm">
                {l('addressHint', lang)}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-300 mb-3">{l('memberAddresses', lang)}</h3>
                <div className="space-y-3">
                  {members.map((m, i) => (
                    <div key={i}>
                      <label className="block text-xs text-zinc-500 mb-1">
                        {m.fullName} — {l('address', lang)} *
                      </label>
                      <input
                        type="text"
                        value={memberAddresses[i] || ''}
                        onChange={e => setMemberAddresses(prev => ({ ...prev, [i]: e.target.value }))}
                        placeholder="123 Main St, City, State, Country"
                        className="w-full px-3 py-2 bg-zinc-800 rounded border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Member addresses already present — show them read-only */}
          {!hasMissingAddresses && members.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-300 mb-2">{l('memberAddresses', lang)}</h3>
              <div className="space-y-2">
                {members.map((m, i) => (
                  <div key={i} className="px-3 py-2 bg-zinc-800/50 rounded border border-zinc-700 text-sm">
                    <span className="text-zinc-400">{m.fullName}: </span>
                    <span className="text-zinc-200">{memberAddresses[i]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handlePreview}
              disabled={hasMissingAddresses}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium text-sm transition"
            >
              {l('preview', lang)}
            </button>
          </div>

          {/* History */}
          {history.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-zinc-200 flex items-center gap-2 mb-4">
                <History size={18} />
                {l('history', lang)}
              </h2>
              <div className="space-y-2">
                {history.map(h => (
                  <div key={h.id} className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 rounded border border-zinc-800 text-sm">
                    <span className="text-zinc-300">Operating Agreement</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      h.status === 'signed' ? 'bg-green-500/10 text-green-400' : 'bg-blue-500/10 text-blue-400'
                    }`}>
                      {h.status}
                    </span>
                    <span className="text-zinc-500">{new Date(h.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* === PREVIEW + SIGNING STAGES === */}
      {(stage === 'preview' || stage === 'signing') && (
        <div className="space-y-4">
          <button
            onClick={() => { setStage('form'); setSignatureImage(null) }}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition"
          >
            <ArrowLeft size={16} /> {l('back', lang)}
          </button>

          {/* Document Preview */}
          <div className="border border-zinc-700 rounded-lg overflow-hidden bg-white">
            <OperatingAgreementTemplate
              ref={documentRef}
              account={account}
              members={resolvedMembers}
              effectiveDate={effectiveDate}
              signatureImage={signatureImage}
            />
          </div>

          {/* Signature Pad */}
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

          {/* Preview action buttons */}
          {stage === 'preview' && (
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={handleDownloadPdf}
                disabled={isGenerating}
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
              >
                {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                {isGenerating ? l('generating', lang) : l('downloadPdf', lang)}
              </button>
              <button
                onClick={handleSignAndDownload}
                className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium text-sm transition flex items-center gap-2"
              >
                <PenLine size={16} />
                {l('signAndDownload', lang)}
              </button>
            </div>
          )}
        </div>
      )}

      {/* === DONE STAGE === */}
      {stage === 'done' && (
        <div className="flex flex-col items-center justify-center py-16 space-y-4">
          <CheckCircle2 size={48} className="text-green-400" />
          <h2 className="text-xl font-semibold text-zinc-100">{l('success', lang)}</h2>
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
