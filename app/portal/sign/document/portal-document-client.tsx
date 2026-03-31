"use client"

import { useEffect, useState, useCallback } from "react"
import { FileSignature, CheckCircle, Clock, PenLine } from "lucide-react"
import { useRouter } from "next/navigation"

interface PortalDocumentClientProps {
  docUrl: string
  status: string
  documentName: string
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileSignature; color: string; bg: string }> = {
  draft: { en: "Ready for Signature", it: "Pronto per la Firma", icon: PenLine, color: "text-blue-600", bg: "bg-blue-50" },
  awaiting_signature: { en: "Awaiting Your Signature", it: "In Attesa della Tua Firma", icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
  signed: { en: "Signed", it: "Firmato", icon: CheckCircle, color: "text-green-600", bg: "bg-green-50" },
}

export function PortalDocumentClient({ docUrl, status, documentName }: PortalDocumentClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.draft
  const Icon = info.icon

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type === "document-signed") {
        setCurrentStatus("signed")
        setTimeout(() => router.refresh(), 1500)
      }
    },
    [router]
  )

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div>
          <p className={`text-sm font-semibold ${info.color}`}>{documentName}</p>
          <p className="text-xs text-zinc-500">{info.en}</p>
        </div>
      </div>

      <iframe src={docUrl} className="flex-1 w-full border-0" title={documentName} allow="clipboard-write" />
    </div>
  )
}
