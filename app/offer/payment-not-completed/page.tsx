export const metadata = { title: "Payment not completed" }

export default function Page() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0A3161", padding: 24, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 48, maxWidth: 520, width: "100%", textAlign: "center" }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#0A3161", marginBottom: 12 }}>Payment not completed</h1>
        <p style={{ fontSize: 16, color: "#555", lineHeight: 1.6 }}>Nothing was charged. You can open the payment link again whenever you are ready.</p>
        <p style={{ marginTop: 24, fontSize: 13, color: "#999" }}>Tony Durante LLC</p>
      </div>
    </div>
  )
}
