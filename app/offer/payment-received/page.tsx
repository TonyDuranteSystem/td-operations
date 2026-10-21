export const metadata = { title: "Payment received" }

export default function Page() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0A3161", padding: 24, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 48, maxWidth: 520, width: "100%", textAlign: "center" }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#0A3161", marginBottom: 12 }}>Payment received</h1>
        <p style={{ fontSize: 16, color: "#555", lineHeight: 1.6 }}>Thank you. Your payment went through. We will be in touch with you shortly.</p>
        <p style={{ marginTop: 24, fontSize: 13, color: "#999" }}>Tony Durante LLC</p>
      </div>
    </div>
  )
}
