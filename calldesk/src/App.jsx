import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "./supabase.js";

// ------------------------------------------------------------------ labels
export const TYPES = {
  callback: { name: "Call-back", tone: "violet" },
  missed_call: { name: "Inbound - not answered", tone: "red" },
  appt_tomorrow: { name: "Appointment tomorrow", tone: "blue" },
  appt_missed: { name: "Cancelled / no-show", tone: "orange" },
  post_surgery: { name: "Post-surgery", tone: "red" },
  vaccine_due: { name: "Vaccine due", tone: "teal" },
  review_due: { name: "Review due", tone: "teal" },
  report_ready: { name: "Report ready", tone: "blue" },
  grooming_due: { name: "Grooming due", tone: "sky" },
  reminder: { name: "Reminder", tone: "teal" },
  bath_due: { name: "Bath due", tone: "sky" },
  haircut_due: { name: "Haircut due", tone: "sky" },
  consult_followup: { name: "Consult follow-up", tone: "teal" },
  new_pet: { name: "New pet", tone: "green" },
  lead: { name: "Enquiry", tone: "blue" },
  churned: { name: "Win back", tone: "grey" },
};
const OUTCOMES = [
  ["booked", "Appointment booked"],
  ["will_visit", "Will visit"],
  ["callback", "Call back later"],
  ["not_interested", "Not interested"],
  ["wrong_number", "Wrong number"],
  ["dnd", "Do not call"],
  ["deceased", "Pet passed away"],
  ["other", "Other"],
];
const OUTCOME_NAME = Object.fromEntries(OUTCOMES);
const STATUS = {
  new: ["To call", "neutral"],
  attempted: ["No answer yet", "warn"],
  connected: ["Answered", "good"],
  callback: ["Call-back", "violet"],
  closed: ["Done", "good"],
};

const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" }) : "");
const fmtDT = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
const rs = (n) => (n == null ? "" : "Rs " + Number(n).toLocaleString("en-IN"));
const daysAgo = (d) => (d ? Math.round((Date.now() - new Date(d + "T00:00:00")) / 864e5) : null);
const title = (s) => (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const phoneFmt = (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);
const todayISO = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

function Chip({ tone = "neutral", children, title: t }) {
  return <span className={`chip chip-${tone}`} title={t}>{children}</span>;
}
function ReasonChip({ r }) {
  const t = TYPES[r.type] || { name: r.type, tone: "grey" };
  return <Chip tone={t.tone}>{t.name}</Chip>;
}
function rowDone(r) {
  return !!r.outcome && r.outcome !== "callback";
}

// ------------------------------------------------------------------ customer panel
function Customer({ row, onSaved, onNext }) {
  const [calls, setCalls] = useState(null);
  const [bills, setBills] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCalls(null); setBills(null);
    rpc("cd_calls", { p_phone: row.phone }).then(setCalls).catch(() => setCalls([]));
    rpc("cd_bills", { p_phone: row.phone }).then(setBills).catch(() => setBills([]));
  }, [row.id]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(row.phone); } catch { /* ignore */ }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
    if (!row.dialed_at) rpc("cd_dial", { p_id: row.id }).then(() => onSaved({ ...row, dialed_at: new Date().toISOString() })).catch(() => {});
  };

  // bills grouped by invoice (one line per visit)
  const visits = useMemo(() => {
    const m = new Map();
    (bills || []).forEach((b) => {
      const k = b.invoice_no || b.sale_date;
      if (!m.has(k)) m.set(k, { date: b.sale_date, unit: b.unit, pets: new Set(), items: [], amount: 0, doctor: b.doctor });
      const v = m.get(k);
      if (b.pet) v.pets.add(b.pet);
      v.items.push(b.plan_subcategory && !/^(medication|pharmacy)$/i.test(b.plan_subcategory) ? `${b.item}` : b.item);
      v.amount += Number(b.amount || 0);
    });
    return [...m.values()].slice(0, 10);
  }, [bills]);
  const pets = row.pets || [];
  const spend = pets.reduce((mx, p) => Math.max(mx, Number(p.revenue || 0)), 0);
  const firstVisit = pets.map((p) => p.first_visit).filter(Boolean).sort()[0];
  const lastVisit = pets.map((p) => p.last_visit).filter(Boolean).sort().reverse()[0];
  const visitDays = pets.reduce((mx, p) => Math.max(mx, Number(p.visits || 0)), 0);
  const reasons = [...row.reasons].sort((a, b) => a.rank - b.rank);
  const [sLabel, sTone] = STATUS[row.status] || ["", "neutral"];

  return (
    <div className="customer">
      <div className="cust-head">
        <div>
          <div className="cust-name">{title(row.client) || "Name not in VetBuddy"}</div>
          <div className="muted">{title(row.unit)}{row.carried_from ? ` · carried from ${fmtDate(row.carried_from)}` : ""}{row.tries ? ` · ${row.tries} earlier ${row.tries === 1 ? "try" : "tries"}` : ""}</div>
        </div>
        <Chip tone={sTone}>{sLabel}</Chip>
      </div>

      <div className="dialer">
        <div className="phone">{phoneFmt(row.phone)}</div>
        <button className="primary" onClick={copy}>{copied ? "Copied" : "Copy number"}</button>
        <button className="ghost" onClick={onNext}>Next customer</button>
      </div>
      <div className="muted small">{row.last_call ? `Last logged call: ${row.last_call}.` : "Calls show here the next morning, from the Corefactor and Runo logs."}</div>

      <section className="purpose">
        <h3>Purpose of calling</h3>
        <ul className="reasons">
          {reasons.map((r, i) => (
            <li key={i}><ReasonChip r={r} /> <span>{r.label}{r.pet ? <strong> · {r.pet}</strong> : null}</span></li>
          ))}
        </ul>
      </section>

      <section>
        <h3>VetBuddy summary</h3>
        <div className="summary">
          <div><span>{firstVisit ? fmtDate(firstVisit) : "–"}</span>customer since</div>
          <div><span>{lastVisit ? fmtDate(lastVisit) : "–"}</span>last visit</div>
          <div><span>{visitDays || "–"}</span>visit days</div>
          <div><span>{spend ? rs(spend) : "–"}</span>total spend</div>
        </div>
        {bills === null ? <p className="muted small">Loading bills…</p> : visits.length === 0 ? <p className="muted small">No bills in the last 13 months.</p> : (
          <table className="mini">
            <thead><tr><th>Date</th><th>Unit</th><th>Pet</th><th>Billed</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {visits.map((v, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtDate(v.date)}</td>
                  <td>{title(v.unit)}</td>
                  <td>{[...v.pets].join(", ")}</td>
                  <td>{[...new Set(v.items)].slice(0, 6).join(", ")}{v.items.length > 6 ? ` +${v.items.length - 6} more` : ""}</td>
                  <td className="num">{rs(Math.round(v.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {pets.length > 0 && (
        <section>
          <h3>Pets</h3>
          <div className="pets">
            {pets.map((p) => (
              <div className="pet" key={p.pet_id}>
                <div className="pet-name">{p.name} <span className="muted">{[p.species, p.breed].filter(Boolean).join(" · ")}</span></div>
                <dl>
                  <dt>Last visit</dt><dd>{fmtDate(p.last_visit)}{p.last_service ? ` (${p.last_service})` : ""}</dd>
                  {p.last_vaccination && (<><dt>Vaccination</dt><dd>{fmtDate(p.last_vaccination)}</dd></>)}
                  {p.last_consultation && (<><dt>Consultation</dt><dd>{fmtDate(p.last_consultation)}</dd></>)}
                  {p.last_bath && (<><dt>Bath</dt><dd>{fmtDate(p.last_bath)}</dd></>)}
                  {p.last_haircut && (<><dt>Haircut</dt><dd>{fmtDate(p.last_haircut)}</dd></>)}
                </dl>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>Call history</h3>
        {calls === null ? <p className="muted small">Loading…</p> : calls.length === 0 ? <p className="muted small">No calls logged for this number.</p> : (
          <table className="mini">
            <tbody>
              {calls.map((c, i) => (
                <tr key={i}>
                  <td>{fmtDT(c.call_at)}</td>
                  <td>{c.source}</td>
                  <td>{c.direction === "in" ? "Incoming" : c.direction === "out" ? "Outgoing" : ""}</td>
                  <td>{c.answered ? <Chip tone="good">Answered</Chip> : <Chip tone="warn">{c.status || "Not answered"}</Chip>}</td>
                  <td className="muted">{c.agent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ the list (agent view, and a lead looking at a list)
function CallList({ me, agentId, agents, day, setDay }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("todo");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [moveTo, setMoveTo] = useState("");
  const listRef = useRef(null);
  const isLead = me.role === "lead";

  const load = useCallback(async () => {
    setErr("");
    try {
      const args = { p_day: day };
      if (isLead) args.p_agent = agentId;
      const data = await rpc("cd_list", args);
      setRows(data);
      setSel((s) => (s && data.find((r) => r.id === s) ? s : null));
    } catch (e) { setErr(e.message); setRows([]); }
  }, [day, agentId, isLead]);
  useEffect(() => { setRows(null); setPicked(new Set()); load(); }, [load]);

  const counts = useMemo(() => {
    const c = { todo: 0, done: 0, all: rows?.length || 0, callback: 0 };
    (rows || []).forEach((r) => {
      if (r.status === "callback") c.callback++;
      if (rowDone(r) || r.status === "connected") c.done++; else c.todo++;
    });
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (filter === "todo" && (rowDone(r) || r.status === "connected")) return false;
      if (filter === "done" && !(rowDone(r) || r.status === "connected")) return false;
      if (filter === "callback" && r.status !== "callback") return false;
      if (!t) return true;
      return (r.client || "").toLowerCase().includes(t) || r.phone.includes(t) || (r.pets || []).some((p) => (p.name || "").toLowerCase().includes(t));
    });
  }, [rows, filter, q]);

  const current = rows?.find((r) => r.id === sel) || null;
  const next = () => {
    const i = shown.findIndex((r) => r.id === sel);
    const n = shown.slice(i + 1).find((r) => !rowDone(r)) || shown.find((r) => !rowDone(r) && r.id !== sel);
    setSel(n ? n.id : null);
  };
  const onSaved = (u, goNext) => {
    setRows((rs) => rs.map((r) => (r.id === u.id ? { ...r, ...u } : r)));
    if (goNext) next();
  };

  const attempted = (rows || []).filter((r) => r.attempted_at || r.dialed_at).length;
  const total = rows?.length || 0;
  const target = isLead ? total : me.target;

  const move = async () => {
    if (!moveTo || !picked.size) return;
    try { await rpc("cd_assign", { p_ids: [...picked], p_agent: Number(moveTo) }); setPicked(new Set()); setMoveTo(""); load(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="desk">
      <aside className="listpane">
        <div className="progress">
          <div className="progress-top">
            <strong>{attempted}</strong> of {total} called{!isLead && total < target ? <span className="muted"> · target {target}</span> : null}
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
          <div className="bar"><span style={{ width: `${total ? Math.min(100, (attempted / total) * 100) : 0}%` }} /></div>
        </div>
        <div className="filters">
          {[["todo", "To call"], ["done", "Answered"], ["all", "All"]].map(([k, v]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{v} <span>{counts[k]}</span></button>
          ))}
        </div>
        <input className="search" placeholder="Search name, pet or number" value={q} onChange={(e) => setQ(e.target.value)} />
        {isLead && picked.size > 0 && (
          <div className="movebar">
            {picked.size} selected · move to
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">agent…</option>
              {agents.filter((a) => a.active && a.role === "agent").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button className="primary sm" disabled={!moveTo} onClick={move}>Move</button>
          </div>
        )}
        <div className="rows" ref={listRef}>
          {rows === null && <p className="muted pad">Loading the list…</p>}
          {err && <p className="note warn pad">{err}</p>}
          {rows && rows.length === 0 && !err && <p className="muted pad">No list for this day yet. Lists are built every morning at 8:05.</p>}
          {shown.map((r) => {
            const top = r.reasons[0] && [...r.reasons].sort((a, b) => a.rank - b.rank)[0];
            const [sl, st] = STATUS[r.status] || ["", "neutral"];
            return (
              <div key={r.id} className={`row ${sel === r.id ? "sel" : ""} ${rowDone(r) ? "done" : ""}`} onClick={() => setSel(r.id)}>
                {isLead && <input type="checkbox" checked={picked.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => { const s = new Set(picked); e.target.checked ? s.add(r.id) : s.delete(r.id); setPicked(s); }} />}
                <div className="row-main">
                  <div className="row-top"><span className="row-name">{title(r.client) || phoneFmt(r.phone)}</span><Chip tone={st}>{r.outcome ? OUTCOME_NAME[r.outcome] : sl}</Chip></div>
                  <div className="row-chips">{[...r.reasons].sort((a, b) => a.rank - b.rank).map((x, i) => <ReasonChip key={i} r={x} />)}</div>
                  <div className="row-sub"><span className="muted">{top?.label}</span></div>
                  <div className="row-meta muted">{title(r.unit)}{r.pets?.[0]?.name ? ` · ${r.pets.map((p) => p.name).slice(0, 3).join(", ")}` : ""}{r.dialed_at ? ` · copied ${fmtTime(r.dialed_at)}` : ""}</div>
                </div>
              </div>
            );
          })}
        </div>
        <button className="ghost refresh" onClick={load}>Refresh</button>
      </aside>
      <main className={`detail ${current ? "open" : ""}`}>
        {current ? (
          <>
            <button className="link back" onClick={() => setSel(null)}>← Back to list</button>
            <Customer key={current.id} row={current} onSaved={(u) => onSaved(u, false)} onNext={next} />
          </>
        ) : (
          <div className="empty">
            <h2>{counts.todo ? `${counts.todo} customers to call` : rows?.length ? "All done for today" : ""}</h2>
            {counts.todo > 0 && <button className="primary" onClick={() => setSel(shown.find((r) => !rowDone(r))?.id || null)}>Start with the first one</button>}
            <p className="muted small">Each list mixes every purpose: appointments, cancellations, post-surgery checks, vaccine and review reminders, grooming and follow-ups.</p>
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ team lead pages
function Team({ day, setDay, openAgent }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { setT(null); rpc("cd_team", { p_day: day }).then(setT).catch((e) => setErr(e.message)); }, [day]);
  if (err) return <p className="note warn pad">{err}</p>;
  if (!t) return <p className="muted pad">Loading…</p>;
  const sum = (k) => t.agents.reduce((s, a) => s + Number(a[k] || 0), 0);
  return (
    <div className="page">
      <div className="page-head">
        <h2>Team today</h2>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      <div className="kpis">
        <div><span>{sum("assigned") + t.unassigned}</span>on the lists</div>
        <div><span>{sum("dialed")}</span>numbers copied</div>
        <div><span>{sum("attempted")}</span>called (logs)</div>
        <div><span>{sum("connected")}</span>answered (logs)</div>
        
      </div>
      <p className="muted small">"Called" and "answered" come from the Corefactor and Runo logs, loaded each morning (latest call loaded: {fmtDT(t.last_call_loaded) || "none yet"}).</p>
      <table className="grid">
        <thead><tr><th>Agent</th><th>Units</th><th>On list</th><th>Must-call</th><th>Copied</th><th>Called</th><th>Answered</th><th>Done %</th></tr></thead>
        <tbody>
          {t.agents.filter((a) => a.role === "agent").map((a) => (
            <tr key={a.id} className="click" onClick={() => openAgent(a.id)}>
              <td>{a.name}{!a.active && <span className="muted"> (off)</span>}</td>
              <td className="muted">{a.units?.length ? a.units.map(title).join(", ") : "Any"}</td>
              <td>{a.assigned}</td><td>{a.must_call}</td><td>{a.dialed}</td><td>{a.attempted}</td><td>{a.connected}</td>
              <td>{a.assigned ? Math.round((Math.max(a.attempted, a.dialed) / a.assigned) * 100) : 0}%</td>
            </tr>
          ))}
          {t.unassigned > 0 && <tr className="click" onClick={() => openAgent(0)}><td>Not assigned</td><td /><td>{t.unassigned}</td><td colSpan={5} className="muted">Add agents (Agents tab) and rebuild, or move these rows from the list.</td></tr>}
        </tbody>
      </table>
      <h3>By reason</h3>
      <table className="grid">
        <thead><tr><th>Reason</th><th>On lists</th><th>Called</th><th>Answered</th><th>Answer rate</th></tr></thead>
        <tbody>
          {t.by_reason.map((r) => (
            <tr key={r.type}><td><ReasonChip r={r} /></td><td>{r.due}</td><td>{r.attempted}</td><td>{r.connected}</td><td>{r.attempted ? Math.round((r.connected / r.attempted) * 100) + "%" : "–"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const UNITS = ["ADYAR", "ANNA NAGAR", "NEELANGARAI", "VELACHERY", "VALASARAVAKKAM", "CH VET ON WHEELS", "COIMBATORE", "CBE VET ON WHEELS", "MADURAI", "MADURAI VET ON WHEELS", "TRICHY"];

function Agents({ me, agents, reload }) {
  const blank = { email: "", name: "", role: "agent", units: [], target: 200, active: true };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState("");
  const save = async (e) => {
    e.preventDefault(); setMsg("");
    try {
      await rpc("cd_agent_save", { p_email: f.email, p_name: f.name, p_role: f.role, p_units: f.units, p_target: Number(f.target), p_active: f.active });
      setMsg(`Saved ${f.name}. They can sign in with ${f.email.toLowerCase()}.`); setF(blank); reload();
    } catch (e2) { setMsg(e2.message); }
  };
  return (
    <div className="page">
      <h2>Agents</h2>
      <p className="muted small">Each agent signs in with the email below. Agents with units get those units' customers first; "Any" takes the rest. New lists use these settings from the next morning (or rebuild today's list from GitHub).</p>
      <table className="grid">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Units</th><th>Daily target</th><th>Active</th><th /></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td><td className="muted">{a.email}</td><td>{a.role === "lead" ? "Team lead" : "Agent"}</td>
              <td className="muted">{a.units?.length ? a.units.map(title).join(", ") : "Any"}</td><td>{a.target}</td><td>{a.active ? "Yes" : "No"}</td>
              <td><button className="link" onClick={() => setF({ email: a.email, name: a.name, role: a.role, units: a.units || [], target: a.target, active: a.active })}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="agentform" onSubmit={save}>
        <h3>{agents.some((a) => a.email === f.email) ? "Edit agent" : "Add an agent"}</h3>
        <div className="formgrid">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="agent">Agent</option><option value="lead">Team lead</option></select></label>
          <label>Daily target<input type="number" min={0} max={1000} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </div>
        <div className="units">
          {UNITS.map((u) => (
            <label key={u} className="check"><input type="checkbox" checked={f.units.includes(u)} onChange={(e) => setF({ ...f, units: e.target.checked ? [...f.units, u] : f.units.filter((x) => x !== u) })} /> {title(u)}</label>
          ))}
        </div>
        <div className="actions"><button className="primary">Save</button><button type="button" className="link" onClick={() => setF(blank)}>Clear</button></div>
        {msg && <p className="note">{msg}</p>}
      </form>
    </div>
  );
}

function Kpis() {
  const t = todayISO();
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(t);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { setRows(null); setErr(""); rpc("cd_kpi", { p_from: from, p_to: to }).then(setRows).catch((e) => setErr(e.message)); }, [from, to]);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
  return (
    <div className="page">
      <div className="page-head">
        <h2>Call KPIs</h2>
        <div><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <p className="muted small">Called and answered come from the call logs. Converted = a matching bill for that number within the window (vaccine or consultation for reminders, bath for bath due, haircut for haircut due, review for post-surgery; any bill otherwise; 1 day for appointments, 30 days for win-back, 60 for new pets, 14 for the rest).</p>
      {err && <p className="note warn">{err}</p>}
      {!rows ? <p className="muted">Loading…</p> : (
        <table className="grid">
          <thead><tr><th>Reason</th><th>Due</th><th>Called</th><th>Answered</th><th>Converted</th><th>Called %</th><th>Answer %</th><th>Converted %</th><th>Converted after answered call</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.type}><td><ReasonChip r={r} /></td><td>{r.due}</td><td>{r.attempted}</td><td>{r.connected}</td><td>{r.converted}</td>
                <td>{pct(r.attempted, r.due)}</td><td>{pct(r.connected, r.attempted)}</td><td>{pct(r.converted, r.due)}</td><td>{pct(r.converted_after_call, r.connected)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ app
export default function App() {
  // No sign-in: the Call Desk opens straight away; each agent picks their own name on the Lists tab.
  const saved = (() => { try { return Number(localStorage.getItem("cd_agent") ?? -1); } catch { return -1; } })();
  const [me, setMe] = useState(undefined);
  const [tab, setTab] = useState(saved > 0 ? "list" : "team");
  const [day, setDay] = useState(todayISO());
  const [agentId, setAgentIdRaw] = useState(saved);
  const [agents, setAgents] = useState([]);
  const setAgentId = (id) => { setAgentIdRaw(id); try { localStorage.setItem("cd_agent", String(id)); } catch { /* ignore */ } };

  useEffect(() => { rpc("cd_me").then(setMe).catch(() => setMe(null)); }, []);
  const loadAgents = useCallback(() => {
    rpc("cd_team", { p_day: todayISO() }).then((t) => setAgents(t.agents)).catch(() => {});
  }, []);
  useEffect(() => { if (me) loadAgents(); }, [me, loadAgents]);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (!me) return <div className="center muted">The Call Desk could not reach the database. Check the internet connection and refresh.</div>;

  const isLead = me.role === "lead";
  const openAgent = (id) => { setAgentId(id); setTab("list"); };
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo" /> Call Desk</div>
        {isLead && (
          <nav>
            {[["team", "Team"], ["list", "Lists"], ["kpi", "KPIs"], ["agents", "Agents"]].map(([k, v]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{v}</button>
            ))}
          </nav>
        )}
        {isLead && tab === "list" && (
          <select className="agentpick" title="Whose list" value={agentId} onChange={(e) => setAgentId(Number(e.target.value))}>
            <option value={-1}>Everyone</option>
            <option value={0}>Not assigned</option>
            {agents.filter((a) => a.role === "agent").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}

      </header>
      {tab === "list" && <CallList me={me} agentId={isLead ? agentId : me.id} agents={agents} day={day} setDay={setDay} />}
      {tab === "team" && <Team day={day} setDay={setDay} openAgent={openAgent} />}
      {tab === "agents" && <Agents me={me} agents={agents} reload={loadAgents} />}
      {tab === "kpi" && <Kpis />}
    </div>
  );
}
