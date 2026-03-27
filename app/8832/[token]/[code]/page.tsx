/**
 * Form 8832 (Entity Classification Election) — External Signing Page
 *
 * Same pattern as SS-4 signing page.
 * Shows the pre-filled Form 8832 PDF and allows the client to e-sign.
 *
 * Flow:
 * 1. Verify access code (or portal/admin mode)
 * 2. Display PDF from /api/8832/[token]/pdf
 * 3. Client draws signature on canvas
 * 4. On sign: overlay signature on PDF page 2 (consent section)
 * 5. Upload signed PDF to Supabase Storage
 * 6. Update form_8832_applications status
 * 7. Call /api/8832-signed for notifications + Drive upload
 */

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { supabasePublic } from "@/lib/supabase/public-client"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

// Signature position on Form 8832 page 2 (consent section)
// The consent signature line is near the bottom of page 2
const SIG_X = 115
const SIG_Y = 540
const SIG_W = 200
const SIG_H = 20
const DATE_X = 380
const DATE_Y = 543

export default function Form8832SignPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params?.token as string
  const code = params?.code as string
  const isPortal = searchParams.get("portal") === "true"
  const isAdmin = searchParams.get("preview") === "td"

  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState("")
  const [signed, setSigned] = useState(false)
  const [signing, setSigning] = useState(false)
  const [pdfUrl, setPdfUrl] = useState("")
  const [sigEmpty, setSigEmpty] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<InstanceType<typeof import("signature_pad").default> | null>(null)

  // Load form data
  useEffect(() => {
    async function load() {
      try {
        const supabase = supabasePublic
        const { data, error: err } = await supabase
          .from("form_8832_applications")
          .select("*")
          .eq("token", token)
          .maybeSingle()

        if (err || !data) {
          setError("Form 8832 application not found.")
          setLoading(false)
          return
        }

        if (!isAdmin && !isPortal && data.access_code !== code) {
          setError("Invalid access code.")
          setLoading(false)
          return
        }

        setForm(data)
        setSigned(data.status === "signed")

        const pdfEndpoint = `/api/8832/${token}/pdf?code=${encodeURIComponent(data.access_code || code)}${isAdmin ? "&preview=td" : ""}`
        setPdfUrl(pdfEndpoint)

        if (!isAdmin) {
          await supabase
            .from("form_8832_applications")
            .update({
              view_count: (data.view_count || 0) + 1,
              viewed_at: new Date().toISOString(),
              status: data.status === "draft" ? "awaiting_signature" : data.status,
            })
            .eq("id", data.id)
        }
      } catch {
        setError("Failed to load Form 8832 data.")
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

  // Sign handler
  const handleSign = useCallback(async () => {
    if (!form || !sigPadRef.current || sigPadRef.current.isEmpty()) return
    setSigning(true)

    try {
      const supabase = supabasePublic
      const sigDataUrl = sigPadRef.current.toDataURL("image/png")

      // 1. Fetch unsigned PDF
      const pdfRes = await fetch(pdfUrl)
      if (!pdfRes.ok) throw new Error("Failed to fetch PDF")
      const pdfBytes = await pdfRes.arrayBuffer()

      // 2. Overlay signature on page 2 (consent section)
      const pdf = await PDFDocument.load(pdfBytes)
      const page = pdf.getPage(1) // Page 2 = consent + signature

      const sigImageBytes = Uint8Array.from(
        atob(sigDataUrl.split(",")[1]),
        c => c.charCodeAt(0)
      )
      const sigImage = await pdf.embedPng(sigImageBytes)

      page.drawImage(sigImage, {
        x: SIG_X,
        y: SIG_Y,
        width: SIG_W,
        height: SIG_H,
      })

      // Draw date
      const dateFont = await pdf.embedFont(StandardFonts.Helvetica)
      const today = new Date()
      const dateStr = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`
      page.drawText(dateStr, {
        x: DATE_X,
        y: DATE_Y,
        size: 10,
        font: dateFont,
        color: rgb(0, 0, 0),
      })

      const signedPdfBytes = await pdf.save()

      // 3. Upload signed PDF
      const uploadForm = new FormData()
      uploadForm.append("pdf", new Blob([new Uint8Array(signedPdfBytes)], { type: "application/pdf" }), "signed.pdf")
      uploadForm.append("code", code || "")
      if (isAdmin) uploadForm.append("preview", "td")

      const uploadRes = await fetch(`/api/8832/${token}/upload-signed`, {
        method: "POST",
        body: uploadForm,
      })

      if (!uploadRes.ok) {
        console.error("Storage upload error:", await uploadRes.text())
      }

      // 4. Update DB
      const signedAt = new Date().toISOString()
      await supabase
        .from("form_8832_applications")
        .update({
          status: "signed",
          signed_at: signedAt,
        })
        .eq("id", form.id)

      // 5. Trigger notifications
      await fetch("/api/8832-signed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form_id: form.id, token }),
      })

      setSigned(true)

      // 6. Notify portal parent
      if (isPortal && window.parent !== window) {
        window.parent.postMessage({ type: "8832-signed", token }, "*")
      }
    } catch (err) {
      console.error("Sign error:", err)
      setError("Failed to sign. Please try again.")
    } finally {
      setSigning(false)
    }
  }, [form, pdfUrl, token, code, isPortal, isAdmin])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    )
  }

  if (error && !form) {
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
              Form 8832 — Entity Classification Election
            </h1>
            <p className="text-gray-500 mt-1">
              C-Corp Election for {form?.company_name as string}
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
              title={`Form 8832 for ${form?.company_name as string}`}
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
              Under penalties of perjury, I declare that I consent to the election of the above-named entity to be classified as indicated above.
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
              Form 8832 Signed Successfully
            </h2>
            <p className="text-green-600 mt-2">
              Your C-Corp election has been signed. We will mail it to the IRS. The election will take effect on the date specified in the form.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
