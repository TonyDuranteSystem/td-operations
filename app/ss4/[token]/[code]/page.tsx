/**
 * SS-4 (EIN Application) — External Signing Page
 *
 * Shows the pre-filled SS-4 PDF and allows the client to e-sign.
 * Embeddable in the portal via iframe (?portal=true).
 * Admin preview via ?preview=td (skips email gate).
 *
 * Flow:
 * 1. Verify access code (or portal/admin mode)
 * 2. Display the PDF from /api/ss4/[token]/pdf
 * 3. Client draws signature on canvas
 * 4. On sign: overlay signature on PDF via pdf-lib (client-side)
 * 5. Upload signed PDF to Supabase Storage
 * 6. Update ss4_applications status to "signed"
 * 7. Call /api/ss4-signed for notifications + Drive upload
 * 8. postMessage to portal parent if in portal mode
 */

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { PDFDocument } from "pdf-lib"

// Signature position on SS-4 form (PDF coordinates, bottom-up origin)
// Measured from form layout: signature line is near bottom of page 1
const SIG_X = 55
const SIG_Y = 42 // from bottom
const SIG_W = 200
const SIG_H = 28

export default function SS4SignPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params?.token as string
  const code = params?.code as string
  const isPortal = searchParams.get("portal") === "true"
  const isAdmin = searchParams.get("preview") === "td"

  // State
  const [loading, setLoading] = useState(true)
  const [ss4, setSs4] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState("")
  const [signed, setSigned] = useState(false)
  const [signing, setSigning] = useState(false)
  const [pdfUrl, setPdfUrl] = useState("")
  const [sigEmpty, setSigEmpty] = useState(true)

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<InstanceType<typeof import("signature_pad").default> | null>(null)

  // Load SS-4 data
  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data, error: err } = await supabase
          .from("ss4_applications")
          .select("*")
          .eq("token", token)
          .maybeSingle()

        if (err || !data) {
          setError("SS-4 application not found.")
          setLoading(false)
          return
        }

        // Verify access code (skip for admin/portal)
        if (!isAdmin && !isPortal && data.access_code !== code) {
          setError("Invalid access code.")
          setLoading(false)
          return
        }

        setSs4(data)
        setSigned(data.status === "signed")

        // Build PDF URL
        const pdfEndpoint = `/api/ss4/${token}/pdf?code=${encodeURIComponent(data.access_code || code)}${isAdmin ? "&preview=td" : ""}`
        setPdfUrl(pdfEndpoint)

        // Track view (not for admin)
        if (!isAdmin) {
          await supabase
            .from("ss4_applications")
            .update({
              view_count: (data.view_count || 0) + 1,
              viewed_at: new Date().toISOString(),
              status: data.status === "draft" ? "awaiting_signature" : data.status,
            })
            .eq("id", data.id)
        }
      } catch {
        setError("Failed to load SS-4 data.")
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

  // Clear signature
  const clearSig = useCallback(() => {
    sigPadRef.current?.clear()
    setSigEmpty(true)
  }, [])

  // Sign handler
  const handleSign = useCallback(async () => {
    if (!ss4 || !sigPadRef.current || sigPadRef.current.isEmpty()) return
    setSigning(true)

    try {
      const supabase = createClient()
      const sigDataUrl = sigPadRef.current.toDataURL("image/png")

      // 1. Fetch the filled (unsigned) PDF bytes from our API
      const pdfRes = await fetch(pdfUrl)
      if (!pdfRes.ok) throw new Error("Failed to fetch PDF")
      const pdfBytes = await pdfRes.arrayBuffer()

      // 2. Load PDF with pdf-lib and overlay signature
      const pdf = await PDFDocument.load(pdfBytes)
      const page = pdf.getPage(0) // SS-4 form is page 1

      // Convert signature data URL to embeddable image
      const sigImageBytes = Uint8Array.from(
        atob(sigDataUrl.split(",")[1]),
        c => c.charCodeAt(0)
      )
      const sigImage = await pdf.embedPng(sigImageBytes)

      // Draw signature at the signature line position
      page.drawImage(sigImage, {
        x: SIG_X,
        y: SIG_Y,
        width: SIG_W,
        height: SIG_H,
      })

      const signedPdfBytes = await pdf.save()

      // 3. Upload signed PDF to Supabase Storage
      const fileName = `${token}/Form-SS4-${(ss4.company_name as string).replace(/[^a-zA-Z0-9]/g, "-")}-Signed.pdf`
      const { error: uploadErr } = await supabase.storage
        .from("signed-ss4")
        .upload(fileName, new Blob([new Uint8Array(signedPdfBytes)], { type: "application/pdf" }), {
          upsert: true,
        })

      if (uploadErr) {
        console.error("Storage upload error:", uploadErr)
        // Continue even if storage fails — we still want to mark as signed
      }

      // 4. Update ss4_applications in DB
      const signedAt = new Date().toISOString()
      await supabase
        .from("ss4_applications")
        .update({
          status: "signed",
          signed_at: signedAt,
          signature_data: {
            dataUrl: sigDataUrl,
            signedName: ss4.responsible_party_name,
            signedAt,
          },
        })
        .eq("id", ss4.id)

      // 5. Call /api/ss4-signed for notifications + Drive upload
      await fetch("/api/ss4-signed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ss4_id: ss4.id, token }),
      })

      setSigned(true)

      // 6. Notify portal parent (if embedded)
      if (isPortal && window.parent !== window) {
        window.parent.postMessage({ type: "ss4-signed", token }, "*")
      }
    } catch (err) {
      console.error("Sign error:", err)
      setError("Failed to sign. Please try again.")
    } finally {
      setSigning(false)
    }
  }, [ss4, pdfUrl, token, isPortal])

  // ─── RENDER ───

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    )
  }

  if (error && !ss4) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <p className="text-red-500">{error}</p>
      </div>
    )
  }

  return (
    <div className={`min-h-screen bg-gray-50 ${isPortal ? "p-0" : "p-4 sm:p-8"}`}>
      <div className={`mx-auto ${isPortal ? "max-w-none" : "max-w-4xl"}`}>
        {/* Admin preview badge */}
        {isAdmin && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-center">
            <span className="text-amber-700 font-semibold text-sm">ADMIN PREVIEW</span>
          </div>
        )}

        {/* Header (hidden in portal mode) */}
        {!isPortal && (
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-gray-900">
              Form SS-4 — EIN Application
            </h1>
            <p className="text-gray-500 mt-1">
              {ss4?.company_name as string}
            </p>
          </div>
        )}

        {/* PDF Viewer */}
        <div className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${isPortal ? "rounded-none border-0 shadow-none" : ""}`}>
          {pdfUrl && (
            <iframe
              src={pdfUrl}
              className="w-full border-0"
              style={{ height: isPortal ? "calc(100vh - 260px)" : "700px" }}
              title={`Form SS-4 for ${ss4?.company_name as string}`}
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
              Under penalties of perjury, I declare that I have examined this application, and to the best of my knowledge and belief, it is true, correct, and complete.
            </p>

            {/* Error display */}
            {error && (
              <div className="mb-4 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Signature canvas */}
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

            {/* Actions */}
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
          /* Signed success state */
          <div className={`mt-6 bg-green-50 border border-green-200 rounded-xl p-8 text-center ${isPortal ? "mx-4 mb-4" : ""}`}>
            <div className="text-4xl mb-3">&#10003;</div>
            <h2 className="text-xl font-semibold text-green-800">
              SS-4 Signed Successfully
            </h2>
            <p className="text-green-600 mt-2">
              Your EIN application has been signed. We will fax it to the IRS and you will receive your EIN within 4-7 business days.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
