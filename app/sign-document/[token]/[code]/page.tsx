/**
 * Generic Document Signing Page
 *
 * Shows any PDF and allows the client to e-sign.
 * Embeddable in the portal via iframe (?portal=true).
 * Admin preview via ?preview=td (skips email gate).
 *
 * Flow:
 * 1. Verify access code (or portal/admin mode)
 * 2. Display PDF from /api/signature-request/[token]/pdf
 * 3. Client draws signature on canvas
 * 4. On sign: overlay signature on PDF via pdf-lib
 * 5. Upload signed PDF to Supabase Storage
 * 6. Update signature_requests status to "signed"
 * 7. Call /api/signature-request-signed for notifications + Drive upload
 * 8. postMessage to portal parent if in portal mode
 */

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { supabasePublic } from "@/lib/supabase/public-client"
import { PDFDocument } from "pdf-lib"

interface SignatureRequest {
  id: string
  token: string
  access_code: string
  document_name: string
  description: string | null
  signature_coords: { x: number; y: number; page: number }
  status: string
  signed_at: string | null
  view_count?: number
}

export default function SignDocumentPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params?.token as string
  const code = params?.code as string
  const isPortal = searchParams.get("portal") === "true"
  const isAdmin = searchParams.get("preview") === "td"

  const [loading, setLoading] = useState(true)
  const [sigReq, setSigReq] = useState<SignatureRequest | null>(null)
  const [error, setError] = useState("")
  const [signed, setSigned] = useState(false)
  const [signing, setSigning] = useState(false)
  const [pdfUrl, setPdfUrl] = useState("")
  const [sigEmpty, setSigEmpty] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<InstanceType<typeof import("signature_pad").default> | null>(null)

  // Load signature request
  useEffect(() => {
    async function load() {
      try {
        const { data, error: err } = await supabasePublic
          .from("signature_requests")
          .select("*")
          .eq("token", token)
          .maybeSingle()

        if (err || !data) {
          setError("Document not found.")
          setLoading(false)
          return
        }

        if (!isAdmin && !isPortal && data.access_code !== code) {
          setError("Invalid access code.")
          setLoading(false)
          return
        }

        setSigReq(data as SignatureRequest)
        setSigned(data.status === "signed")
        setPdfUrl(`/api/signature-request/${token}/pdf`)

        if (!isAdmin) {
          await supabasePublic
            .from("signature_requests")
            .update({
              status: data.status === "draft" ? "awaiting_signature" : data.status,
              updated_at: new Date().toISOString(),
            })
            .eq("id", data.id)
        }
      } catch {
        setError("Failed to load document.")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [token, code, isAdmin, isPortal])

  // Initialize signature pad
  useEffect(() => {
    if (!canvasRef.current || signed || loading) return

    async function initSigPad() {
      const SignaturePad = (await import("signature_pad")).default
      const canvas = canvasRef.current!
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.scale(ratio, ratio)

      const pad = new SignaturePad(canvas, {
        penColor: "rgb(0, 0, 100)",
        minWidth: 0.5,
        maxWidth: 2.5,
      })

      pad.addEventListener("endStroke", () => {
        setSigEmpty(pad.isEmpty())
      })

      sigPadRef.current = pad
    }

    const timer = setTimeout(initSigPad, 100)
    return () => clearTimeout(timer)
  }, [signed, loading])

  const clearSig = useCallback(() => {
    sigPadRef.current?.clear()
    setSigEmpty(true)
  }, [])

  const handleSign = useCallback(async () => {
    if (!sigReq || !sigPadRef.current || sigPadRef.current.isEmpty()) return
    setSigning(true)

    try {
      const sigDataUrl = sigPadRef.current.toDataURL("image/png")

      // 1. Fetch the source PDF
      const pdfRes = await fetch(pdfUrl)
      if (!pdfRes.ok) throw new Error("Failed to fetch PDF")
      const pdfBytes = await pdfRes.arrayBuffer()

      // 2. Overlay signature using pdf-lib
      const pdf = await PDFDocument.load(pdfBytes)
      const coords = sigReq.signature_coords || { x: 150, y: 80, page: 0 }
      const targetPage = pdf.getPage(Math.min(coords.page, pdf.getPageCount() - 1))

      const sigImageBytes = Uint8Array.from(
        atob(sigDataUrl.split(",")[1]),
        c => c.charCodeAt(0)
      )
      const sigImage = await pdf.embedPng(sigImageBytes)

      targetPage.drawImage(sigImage, {
        x: coords.x,
        y: coords.y,
        width: 200,
        height: 20,
      })

      const signedPdfBytes = await pdf.save()

      // 3. Upload signed PDF via API
      const uploadForm = new FormData()
      uploadForm.append("pdf", new Blob([new Uint8Array(signedPdfBytes)], { type: "application/pdf" }), "signed.pdf")
      uploadForm.append("code", code || "")
      if (isAdmin) uploadForm.append("preview", "td")

      const uploadRes = await fetch(`/api/signature-request/${token}/upload-signed`, {
        method: "POST",
        body: uploadForm,
      })

      let signedPdfPath = ""
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json()
        signedPdfPath = uploadData.path || ""
      }

      // 4. Update signature_requests in DB
      const signedAt = new Date().toISOString()
      await supabasePublic
        .from("signature_requests")
        .update({
          status: "signed",
          signed_at: signedAt,
          signed_pdf_path: signedPdfPath,
          signature_data: { signedAt },
          updated_at: signedAt,
        })
        .eq("id", sigReq.id)

      // 5. Call post-signing webhook
      await fetch("/api/signature-request-signed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature_request_id: sigReq.id, token }),
      })

      setSigned(true)

      // 6. Notify portal parent if embedded
      if (isPortal && window.parent !== window) {
        window.parent.postMessage({ type: "document-signed", token }, "*")
      }
    } catch (err) {
      console.error("Sign error:", err)
      setError("Failed to sign. Please try again.")
    } finally {
      setSigning(false)
    }
  }, [sigReq, pdfUrl, token, code, isPortal, isAdmin])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    )
  }

  if (error && !sigReq) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <p className="text-red-500">{error}</p>
      </div>
    )
  }

  return (
    <div className={`min-h-screen bg-gray-50 ${isPortal ? "p-0" : "p-4 sm:p-8"}`}>
      <div className={`mx-auto ${isPortal ? "max-w-none" : "max-w-4xl"}`}>
        {isAdmin && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-center">
            <span className="text-amber-700 font-semibold text-sm">ADMIN PREVIEW</span>
          </div>
        )}

        {!isPortal && (
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-gray-900">
              {sigReq?.document_name}
            </h1>
            {sigReq?.description && (
              <p className="text-gray-500 mt-1">{sigReq.description}</p>
            )}
          </div>
        )}

        {/* PDF Viewer */}
        <div className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${isPortal ? "rounded-none border-0 shadow-none" : ""}`}>
          {pdfUrl && (
            <iframe
              src={pdfUrl}
              className="w-full border-0"
              style={{ height: isPortal ? "calc(100vh - 260px)" : "700px" }}
              title={sigReq?.document_name || "Document"}
            />
          )}
        </div>

        {/* Signature Section */}
        {!signed ? (
          <div className={`mt-6 bg-white rounded-xl shadow-sm border border-gray-200 p-6 ${isPortal ? "mx-4 mb-4" : ""}`}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              Sign Below
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              By signing, you confirm that you have reviewed this document and authorize its submission.
            </p>

            {error && (
              <div className="mb-4 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 relative">
              <canvas
                ref={canvasRef}
                className="w-full touch-none"
                style={{ height: 120 }}
              />
              <div className="absolute bottom-2 left-3 text-xs text-gray-300 pointer-events-none select-none">
                Sign here
              </div>
            </div>

            <div className="flex items-center justify-between mt-4">
              <button
                onClick={clearSig}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
                disabled={signing}
              >
                Clear signature
              </button>
              <button
                onClick={handleSign}
                disabled={sigEmpty || signing}
                className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {signing ? "Signing..." : "Sign & Submit"}
              </button>
            </div>
          </div>
        ) : (
          <div className={`mt-6 bg-green-50 border border-green-200 rounded-xl p-8 text-center ${isPortal ? "mx-4 mb-4" : ""}`}>
            <div className="text-4xl mb-3">&#10003;</div>
            <h2 className="text-xl font-semibold text-green-800">
              Document Signed Successfully
            </h2>
            <p className="text-green-600 mt-2">
              Your signed document has been submitted. Our team will process it shortly.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
