"use client";
import { useState, useEffect, useCallback } from "react";

const BASE = process.env.NEXT_PUBLIC_AIRTABLE_BASE;
const TOKEN = process.env.NEXT_PUBLIC_AIRTABLE_TOKEN;
const T = {
  accounts: "tblf1e3aeIta34k3y",
  contacts: "tbl4PtEJVuDtb4bTp",
  services: "tbl2vc7HT55MXqTLF",
  deals: "tblSKnBKuz0FhINS2",
  tasks: "tblX6sJfmx4Roa5jr",
  payments: "tblfh26DGQlw0MrCq",
  deadlines: "tblnhSJFi07O6npGt",
  conversations: "tblxriAPUYWZo6LX0",
  responses: "tblsywfkHdbJMhkRa",
};

async function fetchAll(tableId, opts = {}) {
  const { filter, sort, fields, max = 500 } = opts;
  let all = [], offset = null;
  do {
    const p = new URLSearchParams({ maxRecords: String(max), pageSize: "100" });
    if (filter) p.append("filterByFormula", filter);
    if (offset) p.append("offset", offset);
    if (sort) sort.forEach((s, i) => {
      p.append(`sort[${i}][field]`, s.field);
      p.append(`sort[${i}][direction]`, s.direction || "asc");
    });
    if (fields) fields.forEach(f => p.append("fields[]", f));
    try {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${tableId}?${p}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!r.ok) break;
      const d = await r.json();
      all = all.concat(d.records || []);
      offset = d.offset || null;
    } catch { break; }
  } while (offset);
  return all;
}

const C = {
  bg: "#0a0a0a", sf: "#141414", card: "#1a1a1a", brd: "#252525",
  txt: "#e5e5e5", dim: "#888", mut: "#555",
  red: "#dc2626", grn: "#22c55e", ylw: "#f59e0b", blu: "#3b82f6",
  w: "#fff",
  grnBg: "#0a200d", redBg: "#2a0a0a", ylwBg: "#1a1500", bluBg: "#0a1a2a",
};

function Badge({ c, bg, ch }) {
  return <span style={{ background: bg, color: c, fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, letterSpacing: .3, textTransform: "uppercase", whiteSpace: "nowrap" }}>{ch}</span>;
}

function SBadge({ s }) {
  const m = { Active: [C.grn, C.grnBg], Inactive: [C.dim, "#1a1a1a"], "Payment Delinquent": [C.red, C.redBg], Cancelled: [C.mut, "#1a1a1a"], Overdue: [C.red, C.redBg], Delinquent: [C.red, C.redBg], Paid: [C.grn, C.grnBg], "To Do": [C.ylw, C.ylwBg], "In Progress": [C.blu, C.bluBg], Done: [C.grn, C.grnBg], Proposed: [C.ylw, C.ylwBg], Approved: [C.grn, C.grnBg], Sent: [C.blu, C.bluBg], Open: [C.ylw, C.ylwBg], Won: [C.grn, C.grnBg], Lost: [C.red, C.redBg], Invoiced: [C.ylw, C.ylwBg], "Not Invoiced": [C.mut, "#1a1a1a"], "Delay Approved": [C.blu, C.bluBg], Blocked: [C.red, C.redBg], "Not Started": [C.dim, "#1a1a1a"], "In Progress": [C.blu, C.bluBg], Filed: [C.grn, C.grnBg], Completed: [C.grn, C.grnBg] };
  const [color, bg] = m[s] || [C.dim, "#1a1a1a"];
  return <Badge c={color} bg={bg} ch={s || "—"} />;
}

function Stat({ l, v, c = C.w, sub }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 12, padding: "18px 20px", flex: 1, minWidth: 130, animation: "fadeIn 0.4s ease" }}>
      <p style={{ color: C.dim, fontSize: 11, margin: 0, textTransform: "uppercase", letterSpacing: 1, fontWeight: 500 }}>{l}</p>
      <p style={{ color: c, fontSize: 28, fontWeight: 700, margin: "6px 0 0", fontFamily: "'DM Mono', monospace" }}>{v}</p>
      {sub && <p style={{ color: C.mut, fontSize: 11, margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
}

function ClientDetail({ client, contacts, onClose }) {
  if (!client) return null;
  const f = client.fields || {};
  const cc = contacts.filter(c => c.fields?.Accounts?.includes(client.id));
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100vh", background: "rgba(0,0,0,0.5)", zIndex: 998 }} />
      <div style={{ position: "fixed", top: 0, right: 0, width: 420, height: "100vh", background: C.sf, borderLeft: `1px solid ${C.brd}`, zIndex: 1000, overflowY: "auto", padding: 24, boxShadow: "-8px 0 30px rgba(0,0,0,0.5)", animation: "slideIn 0.25s ease-out" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ color: C.w, fontSize: 18, fontWeight: 700, margin: 0 }}>{f["Company Name"]}</h2>
          <button onClick={onClose} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, color: C.dim, cursor: "pointer", padding: "6px 12px", fontSize: 13 }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <SBadge s={f.Status} />
          {f["State of Formation"] && <Badge c={C.blu} bg={C.bluBg} ch={f["State of Formation"]} />}
          {f["Company Type"] && <Badge c={C.dim} bg={C.card} ch={f["Company Type"]} />}
        </div>
        <Section t="Entity">
          {[["EIN", f.EIN], ["Filing ID", f["Filing ID"]], ["State", f["State of Formation"]], ["Incorporated", f["Incorporation Date"]], ["RA Provider", f["RA Provider"]]].map(([l, v], i) => <Row key={i} l={l} v={v} />)}
        </Section>
        <Section t={`Contacts (${cc.length})`}>
          {cc.length === 0 && <p style={{ color: C.mut, fontSize: 12 }}>No contacts linked</p>}
          {cc.map((c, i) => (
            <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < cc.length - 1 ? `1px solid ${C.brd}` : "none" }}>
              <p style={{ color: C.w, fontSize: 13, fontWeight: 600, margin: 0 }}>{c.fields?.["Full Name"]}</p>
              {c.fields?.Email && <p style={{ color: C.blu, fontSize: 12, margin: "2px 0 0" }}>{c.fields.Email}</p>}
              {c.fields?.Phone && <p style={{ color: C.dim, fontSize: 12, margin: "2px 0 0" }}>{c.fields.Phone}</p>}
            </div>
          ))}
        </Section>
        {f["Services Bundle"]?.length > 0 && (
          <Section t="Services">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {f["Services Bundle"].map((s, i) => <Badge key={i} c={C.grn} bg={C.grnBg} ch={s} />)}
            </div>
          </Section>
        )}
        <Section t="Payments">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ background: C.bg, borderRadius: 8, padding: 12, textAlign: "center" }}>
              <p style={{ color: C.mut, fontSize: 10, margin: 0, textTransform: "uppercase" }}>Jan</p>
              <p style={{ color: C.w, fontSize: 16, fontWeight: 700, margin: "4px 0 0" }}>{f["Installment 1 Amount"] ? `$${f["Installment 1 Amount"]}` : "—"}</p>
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: 12, textAlign: "center" }}>
              <p style={{ color: C.mut, fontSize: 10, margin: 0, textTransform: "uppercase" }}>Jun</p>
              <p style={{ color: C.w, fontSize: 16, fontWeight: 700, margin: "4px 0 0" }}>{f["Installment 2 Amount"] ? `$${f["Installment 2 Amount"]}` : "—"}</p>
            </div>
          </div>
        </Section>
        {f.Notes && <Section t="Notes"><p style={{ color: C.txt, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{f.Notes}</p></Section>}
      </div>
    </>
  );
}

function Section({ t, children }) {
  return (
    <div style={{ background: C.card, borderRadius: 10, padding: 16, marginBottom: 16, border: `1px solid ${C.brd}` }}>
      <p style={{ color: C.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 12px", fontWeight: 600 }}>{t}</p>
      {children}
    </div>
  );
}

function Row({ l, v }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
      <span style={{ color: C.dim, fontSize: 12 }}>{l}</span>
      <span style={{ color: v ? C.txt : C.mut, fontSize: 12, fontWeight: 500 }}>{v || "—"}</span>
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sf, setSf] = useState("all");
  const [sel, setSel] = useState(null);
  const [time, setTime] = useState("");
  const [data, setData] = useState({ accounts: [], contacts: [], services: [], deals: [], tasks: [], payments: [], deadlines: [], conversations: [] });

  useEffect(() => {
    const u = () => setTime(new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    u(); const i = setInterval(u, 60000); return () => clearInterval(i);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [accounts, contacts, services, deals, tasks, payments, deadlines, conversations] = await Promise.all([
      fetchAll(T.accounts, { sort: [{ field: "Company Name" }] }),
      fetchAll(T.contacts),
      fetchAll(T.services),
      fetchAll(T.deals),
      fetchAll(T.tasks),
      fetchAll(T.payments),
      fetchAll(T.deadlines, { sort: [{ field: "Due Date" }] }),
      fetchAll(T.conversations, { sort: [{ field: "Date", direction: "desc" }], max: 200 }),
    ]);
    setData({ accounts, contacts, services, deals, tasks, payments, deadlines, conversations });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const { accounts, contacts, services, deals, tasks, payments, deadlines, conversations } = data;

  const stats = {
    total: accounts.length,
    active: accounts.filter(a => a.fields?.Status === "Active").length,
    delinquent: accounts.filter(a => a.fields?.Status === "Payment Delinquent").length,
  };

  const stateStats = {};
  accounts.forEach(a => { const s = a.fields?.["State of Formation"] || "Unknown"; stateStats[s] = (stateStats[s] || 0) + 1; });

  const taskStats = {
    todo: tasks.filter(t => t.fields?.Status === "To Do").length,
    antonio: tasks.filter(t => t.fields?.["Assigned To"] === "Antonio" && t.fields?.Status !== "Done").length,
  };

  const overdueDeadlines = deadlines.filter(d => d.fields?.["Due Date"] && new Date(d.fields["Due Date"]) < new Date() && !["Completed", "Filed", "N/A"].includes(d.fields?.Status));

  const pendingConvs = conversations.filter(c => c.fields?.Status === "Proposed");

  const filtered = accounts.filter(a => {
    const f = a.fields || {};
    const ms = !search || (f["Company Name"] || "").toLowerCase().includes(search.toLowerCase()) || (f.EIN || "").includes(search);
    const mf = sf === "all" || (sf === "active" && f.Status === "Active") || (sf === "delinquent" && f.Status === "Payment Delinquent") || (sf === "inactive" && (f.Status === "Inactive" || f.Status === "Cancelled"));
    return ms && mf;
  });

  const tabs = [
    { id: "dashboard", l: "Dashboard" },
    { id: "clients", l: "Clients", n: stats.total },
    { id: "services", l: "Services", n: services.length },
    { id: "payments", l: "Payments", n: payments.length },
    { id: "deadlines", l: "Deadlines", n: overdueDeadlines.length > 0 ? overdueDeadlines.length : undefined },
    { id: "conversations", l: "Messages", n: pendingConvs.length || undefined },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* HEADER */}
      <div style={{ background: C.sf, borderBottom: `1px solid ${C.brd}`, padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg, ${C.red}, #991b1b)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: C.w, letterSpacing: 1 }}>TD</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.w, letterSpacing: -.3 }}>TD Operations</h1>
            <p style={{ margin: 0, fontSize: 11, color: C.dim }}>{time} EST</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: tab === t.id ? C.red : "transparent",
              color: tab === t.id ? C.w : C.dim,
              border: tab === t.id ? "none" : `1px solid ${C.brd}`,
              borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
            }}>
              {t.l}
              {t.n !== undefined && <span style={{ background: tab === t.id ? "rgba(255,255,255,0.2)" : C.brd, color: tab === t.id ? C.w : C.dim, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10 }}>{t.n}</span>}
            </button>
          ))}
        </div>
        <button onClick={load} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, color: C.dim, cursor: "pointer", padding: "8px 14px", fontSize: 12, fontWeight: 500 }}>↻ Refresh</button>
      </div>

      {/* CONTENT */}
      <div style={{ padding: "24px", maxWidth: 1440, margin: "0 auto" }}>
        {loading ? (
          <div style={{ display: "flex", gap: 6, justifyContent: "center", padding: 60 }}>
            {[0, 1, 2].map(i => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: C.red, animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite` }} />)}
          </div>
        ) : (
          <>
            {/* DASHBOARD */}
            {tab === "dashboard" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
                  <Stat l="Total Clients" v={stats.total} />
                  <Stat l="Active" v={stats.active} c={C.grn} />
                  <Stat l="Delinquent" v={stats.delinquent} c={stats.delinquent > 0 ? C.red : C.dim} />
                  <Stat l="Services" v={services.length} c={C.blu} />
                  <Stat l="Payments" v={payments.length} c={C.ylw} />
                  <Stat l="Overdue Deadlines" v={overdueDeadlines.length} c={overdueDeadlines.length > 0 ? C.red : C.grn} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                  <Section t="Clients by State">
                    {Object.entries(stateStats).sort((a, b) => b[1] - a[1]).map(([s, n], i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ color: C.txt, fontSize: 13 }}>{s}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 120, height: 6, background: C.bg, borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ width: `${(n / stats.total) * 100}%`, height: "100%", background: C.red, borderRadius: 3 }} />
                          </div>
                          <span style={{ color: C.dim, fontSize: 12, fontWeight: 600, minWidth: 28, textAlign: "right" }}>{n}</span>
                        </div>
                      </div>
                    ))}
                  </Section>
                  <Section t={`Recent Messages (${conversations.length})`}>
                    {conversations.length === 0 && <p style={{ color: C.mut, fontSize: 12 }}>No conversations yet</p>}
                    {conversations.slice(0, 8).map((cv, i) => (
                      <div key={i} style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div><p style={{ color: C.txt, fontSize: 13, margin: 0, fontWeight: 500 }}>{cv.fields?.Topic || "—"}</p><p style={{ color: C.mut, fontSize: 11, margin: "2px 0 0" }}>{cv.fields?.Category} · {cv.fields?.Date}</p></div>
                        <SBadge s={cv.fields?.Status} />
                      </div>
                    ))}
                  </Section>
                  <Section t={`Overdue Deadlines (${overdueDeadlines.length})`}>
                    {overdueDeadlines.length === 0 && <p style={{ color: C.grn, fontSize: 12 }}>✓ No overdue deadlines</p>}
                    {overdueDeadlines.slice(0, 8).map((d, i) => (
                      <div key={i} style={{ background: C.redBg, borderRadius: 8, padding: "10px 14px", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #7f1d1d" }}>
                        <div><p style={{ color: C.w, fontSize: 13, margin: 0 }}>{d.fields?.["Deadline Type"]}</p><p style={{ color: C.dim, fontSize: 11, margin: "2px 0 0" }}>{d.fields?.State}</p></div>
                        <span style={{ color: C.red, fontSize: 12, fontWeight: 600 }}>{d.fields?.["Due Date"]}</span>
                      </div>
                    ))}
                  </Section>
                  <Section t={`Payments Summary`}>
                    {(() => {
                      const paid = payments.filter(p => p.fields?.Status === "Paid").length;
                      const overdue = payments.filter(p => ["Overdue", "Delinquent"].includes(p.fields?.Status)).length;
                      const invoiced = payments.filter(p => p.fields?.Status === "Invoiced").length;
                      return (
                        <>
                          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                            <div style={{ flex: 1, background: C.grnBg, borderRadius: 8, padding: 12, textAlign: "center" }}>
                              <p style={{ color: C.grn, fontSize: 22, fontWeight: 700, margin: 0 }}>{paid}</p>
                              <p style={{ color: C.dim, fontSize: 11, margin: "2px 0 0" }}>Paid</p>
                            </div>
                            <div style={{ flex: 1, background: C.ylwBg, borderRadius: 8, padding: 12, textAlign: "center" }}>
                              <p style={{ color: C.ylw, fontSize: 22, fontWeight: 700, margin: 0 }}>{invoiced}</p>
                              <p style={{ color: C.dim, fontSize: 11, margin: "2px 0 0" }}>Invoiced</p>
                            </div>
                            <div style={{ flex: 1, background: overdue > 0 ? C.redBg : C.bg, borderRadius: 8, padding: 12, textAlign: "center" }}>
                              <p style={{ color: overdue > 0 ? C.red : C.dim, fontSize: 22, fontWeight: 700, margin: 0 }}>{overdue}</p>
                              <p style={{ color: C.dim, fontSize: 11, margin: "2px 0 0" }}>Overdue</p>
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </Section>
                </div>
              </div>
            )}

            {/* CLIENTS */}
            {tab === "clients" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search company or EIN..." style={{ background: C.sf, border: `1px solid ${C.brd}`, borderRadius: 8, padding: "10px 16px", color: C.txt, fontSize: 13, outline: "none", width: 300 }} />
                  {["all", "active", "delinquent", "inactive"].map(f => (
                    <button key={f} onClick={() => setSf(f)} style={{ background: sf === f ? C.red : "transparent", color: sf === f ? C.w : C.dim, border: sf === f ? "none" : `1px solid ${C.brd}`, borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{f}</button>
                  ))}
                  <span style={{ color: C.dim, fontSize: 12, marginLeft: "auto" }}>{filtered.length} results</span>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr", padding: "12px 20px", background: C.sf, borderBottom: `1px solid ${C.brd}` }}>
                    {["Company", "State", "Type", "Status", "EIN"].map(h => <span key={h} style={{ color: C.mut, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: .8 }}>{h}</span>)}
                  </div>
                  {filtered.slice(0, 100).map((a) => {
                    const f = a.fields || {};
                    return (
                      <div key={a.id} onClick={() => setSel(a)} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.5fr", padding: "14px 20px", borderBottom: `1px solid ${C.brd}`, cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={e => e.currentTarget.style.background = C.sf} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <span style={{ color: C.w, fontSize: 13, fontWeight: 600 }}>{f["Company Name"] || "—"}</span>
                        <span style={{ color: C.dim, fontSize: 13 }}>{f["State of Formation"] || "—"}</span>
                        <span style={{ color: C.dim, fontSize: 12 }}>{f["Company Type"] || "—"}</span>
                        <SBadge s={f.Status} />
                        <span style={{ color: C.dim, fontSize: 12, fontFamily: "'DM Mono', monospace" }}>{f.EIN || "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* SERVICES */}
            {tab === "services" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <p style={{ color: C.dim, fontSize: 13, margin: "0 0 20px" }}>{services.length} service records across {accounts.length} clients</p>
                {(() => {
                  const byType = {};
                  services.forEach(s => { const t = s.fields?.["Service Type"] || "Unknown"; byType[t] = (byType[t] || 0) + 1; });
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                      {Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count], i) => (
                        <div key={i} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10, padding: "16px 20px" }}>
                          <p style={{ color: C.w, fontSize: 14, fontWeight: 600, margin: 0 }}>{type}</p>
                          <p style={{ color: C.red, fontSize: 24, fontWeight: 700, margin: "8px 0 0", fontFamily: "'DM Mono', monospace" }}>{count}</p>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* PAYMENTS */}
            {tab === "payments" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                {(() => {
                  const byStatus = {};
                  payments.forEach(p => { const s = p.fields?.Status || "Unknown"; byStatus[s] = (byStatus[s] || 0) + 1; });
                  return (
                    <>
                      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
                        {Object.entries(byStatus).map(([s, n], i) => (
                          <div key={i} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10, padding: "14px 20px", minWidth: 120 }}>
                            <SBadge s={s} />
                            <p style={{ color: C.w, fontSize: 22, fontWeight: 700, margin: "8px 0 0" }}>{n}</p>
                          </div>
                        ))}
                      </div>
                      <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 12, overflow: "hidden" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", padding: "12px 20px", background: C.sf, borderBottom: `1px solid ${C.brd}` }}>
                          {["Account", "Year", "Installment", "Amount", "Status"].map(h => <span key={h} style={{ color: C.mut, fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>{h}</span>)}
                        </div>
                        {payments.filter(p => ["Overdue", "Delinquent", "Invoiced"].includes(p.fields?.Status)).slice(0, 50).map((p, i) => {
                          const f = p.fields || {};
                          return (
                            <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", padding: "12px 20px", borderBottom: `1px solid ${C.brd}` }}>
                              <span style={{ color: C.txt, fontSize: 13 }}>{f["Payment Record"] || "—"}</span>
                              <span style={{ color: C.dim, fontSize: 13 }}>{f.Year}</span>
                              <span style={{ color: C.dim, fontSize: 12 }}>{f.Installment}</span>
                              <span style={{ color: C.w, fontSize: 13, fontWeight: 600 }}>{f["Amount Due"] ? `$${f["Amount Due"]}` : "—"}</span>
                              <SBadge s={f.Status} />
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* DEADLINES */}
            {tab === "deadlines" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <p style={{ color: C.dim, fontSize: 13, margin: "0 0 20px" }}>{deadlines.length} deadlines · {overdueDeadlines.length} overdue</p>
                <div style={{ display: "grid", gap: 8 }}>
                  {deadlines.map((d, i) => {
                    const f = d.fields || {};
                    const ov = f["Due Date"] && new Date(f["Due Date"]) < new Date() && !["Completed", "Filed", "N/A"].includes(f.Status);
                    return (
                      <div key={i} style={{ background: ov ? C.redBg : C.card, border: `1px solid ${ov ? "#7f1d1d" : C.brd}`, borderRadius: 10, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <p style={{ color: C.w, fontSize: 13, fontWeight: 600, margin: 0 }}>{f["Deadline Type"] || "—"}</p>
                          <p style={{ color: C.dim, fontSize: 12, margin: "2px 0 0" }}>{f.State} · {f.Year}</p>
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                          <span style={{ color: ov ? C.red : C.ylw, fontSize: 13, fontWeight: 600 }}>{f["Due Date"] || "—"}</span>
                          <SBadge s={f.Status} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* CONVERSATIONS */}
            {tab === "conversations" && (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                <p style={{ color: C.dim, fontSize: 13, margin: "0 0 20px" }}>{conversations.length} messages · {pendingConvs.length} pending approval</p>
                {conversations.length === 0 ? (
                  <Section t="No conversations yet">
                    <p style={{ color: C.mut, fontSize: 13 }}>Share a client message in Cowork → Claude proposes response → you approve → saved here</p>
                  </Section>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {conversations.map((cv, i) => {
                      const f = cv.fields || {};
                      return (
                        <div key={i} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10, padding: "16px 20px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ color: C.w, fontSize: 14, fontWeight: 600 }}>{f.Topic || "—"}</span>
                              <Badge c={C.blu} bg={C.bluBg} ch={f.Category || "—"} />
                              <Badge c={C.dim} bg={C.bg} ch={f.Channel || "—"} />
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ color: C.mut, fontSize: 11 }}>{f.Date}</span>
                              <SBadge s={f.Status} />
                            </div>
                          </div>
                          {f["Client Message"] && (
                            <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}>
                              <p style={{ color: C.mut, fontSize: 10, margin: "0 0 4px", textTransform: "uppercase" }}>Client</p>
                              <p style={{ color: C.txt, fontSize: 12, margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{f["Client Message"]}</p>
                            </div>
                          )}
                          {f["Response Sent"] && (
                            <div style={{ background: C.grnBg, borderRadius: 8, padding: "10px 14px" }}>
                              <p style={{ color: C.mut, fontSize: 10, margin: "0 0 4px", textTransform: "uppercase" }}>Response</p>
                              <p style={{ color: C.txt, fontSize: 12, margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{f["Response Sent"]}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ClientDetail client={sel} contacts={contacts} onClose={() => setSel(null)} />
    </div>
  );
}
