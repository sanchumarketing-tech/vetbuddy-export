import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc, login, logout, SignedOut } from "./supabase.js";
import { AgentHome, LeadHome, IncentivePlan, TeamPerformance, TeamIncentive, KpiPage, SalaryMonthPicker, salaryLabel } from "./Coach.jsx";
import { RulesNotice } from "./Notice.jsx";
import { useBreak, BreakButton, BreakScreen, BreakBar } from "./Break.jsx";
import { CalledCheck } from "./CalledCheck.jsx";
import { useRepeats, RepeatTiles, RepeatDetails } from "./Repeats.jsx";
import { AgentDashboard } from "./AgentDash.jsx";

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
  rabies_course: { name: "Rabies course", tone: "red" },
  vaccine_course: { name: "Vaccine course", tone: "teal" },
  deworm_due: { name: "Deworming due", tone: "teal" },
  tick_recheck: { name: "Tick fever review", tone: "orange" },
  sibling_vaccine: { name: "Vaccine check", tone: "green" },
  birthday: { name: "Birthday", tone: "violet" },
  senior_check: { name: "Senior check-up", tone: "blue" },
  vaccine_never: { name: "Vaccine status", tone: "green" },
  boarding_holiday: { name: "Holiday boarding", tone: "orange" },
  sub_due: { name: "Grooming Club - visit due", tone: "violet" },
  sub_expiring: { name: "Grooming Club - ending", tone: "red" },
  sub_renew: { name: "Grooming Club - renew", tone: "violet" },
  new_pet: { name: "New pet", tone: "green" },
  lead: { name: "Enquiry", tone: "blue" },
  churned: { name: "Churned (1 yr+)", tone: "grey" },
  multi_pet: { name: "Key customer (multi-pet)", tone: "violet" },
  followup: { name: "Follow-up", tone: "blue" },
  checkin: { name: "Check-in", tone: "grey" },
};
// reasons the team lead can switch on / off (the ones the list builds today)
const SWITCHABLE = ["appt_tomorrow", "appt_missed", "post_surgery", "rabies_course", "sub_expiring", "vaccine_due", "vaccine_course",
  "review_due", "deworm_due", "tick_recheck", "sub_due", "bath_due", "haircut_due", "sub_renew", "consult_followup",
  "sibling_vaccine", "boarding_holiday", "senior_check", "vaccine_never", "multi_pet", "churned", "followup", "checkin"];

function ReasonSwitch({ off, onChange }) {
  const [busy, setBusy] = useState("");
  const offSet = new Set(off.map((o) => o.type));
  const flip = async (type) => {
    setBusy(type);
    try { await rpc("cd_reason_set", { p_type: type, p_on: offSet.has(type) }); await onChange(); }
    catch (e) { alert(e.message); }
    setBusy("");
  };
  return (
    <div className="reason-switch">
      <p className="muted small">Untick a reason to stop calling it for now. Its customers disappear from the agents' lists and the Excel log straight away, and tomorrow's list fills up with the other reasons instead. Tick it again to bring it back.</p>
      <div className="reason-grid">
        {SWITCHABLE.map((type) => (
          <label key={type} className={offSet.has(type) ? "off" : ""}>
            <input type="checkbox" checked={!offSet.has(type)} disabled={busy === type} onChange={() => flip(type)} />
            <ReasonChip r={{ type }} />
            {offSet.has(type) && <span className="muted small"> off{off.find((o) => o.type === type)?.by ? " - " + off.find((o) => o.type === type).by : ""}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

// team lead switch: customers in the Corefactor call log between two dates are kept off the lists
const dShort = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");
function SkipCalled({ s, hidden, onChange }) {
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const on = !!s.on;
  const range = `${dShort(s.from)} to ${dShort(s.to)}`;
  const flip = async () => {
    if (!on && !confirm(`Hide every customer in the ${s.source || "Corefactor"} call log from ${range}?`)) return;
    setBusy(true);
    try { await rpc("cd_skip_called", { p_on: !on }); await onChange(); } catch (e) { alert(e.message); }
    setBusy(false);
  };
  return (
    <div className={"skip-called" + (on ? " on" : "")}>
      <button className={on ? "" : "ghost"} disabled={busy} onClick={flip}>
        {on ? `ON - ${s.source || "Corefactor"} calls ${range} omitted` : `Omit ${s.source || "Corefactor"} calls ${range}`}
      </button>
      <span className="muted small">
        {on ? `${hidden || 0} customers on today's lists are hidden because they are in the ${s.source || "Corefactor"} call log from ${range}. Calls before ${dShort(s.from)} are not affected; promised call-backs still show.${s.by && s.by !== "setup" ? " Switched on by " + s.by + "." : ""}`
            : `Off: customers already called by the team from ${range} can still appear on the lists.`}
      </span>
    </div>
  );
}

const PITCH = ["Grooming", "Vaccination", "Consultation", "Clinical"];

// vaccination date picked by the agent for one pet (saved as YYYY-MM-DD when a date is picked; cleared = removed).
// Older typed notes that are not a date are still shown under the calendar.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function VaccNote({ phone, pet, v, onSaved }) {
  const isDay = ISO_DAY.test(v?.note || "");
  const [t, setT] = useState(isDay ? v.note : "");
  const [st, setSt] = useState("");
  useEffect(() => { setT(ISO_DAY.test(v?.note || "") ? v.note : ""); }, [v?.note, pet.pet_id]);
  const save = async (t) => {
    if (t === (v?.note || "") || (!t && !v?.note)) return;
    setSt("Saving…");
    try {
      const r = await rpc("cd_vacc_note_save", { p_phone: phone, p_pet_id: String(pet.pet_id), p_note: t, p_pet_name: pet.name || null });
      onSaved(r); setSt("Saved"); setTimeout(() => setSt(""), 1500);
    } catch (e) { setSt(e.message); }
  };
  return (
    <div className="vaccnote" onClick={(e) => e.stopPropagation()} style={{ marginTop: 4 }}>
      <label className="muted small">Vaccinated on </label>
      <input type="date" value={t} max={todayISO()} aria-label="Vaccination date"
        onChange={(e) => { setT(e.target.value); if (!e.target.value || ISO_DAY.test(e.target.value)) save(e.target.value); }}
        onKeyDown={(e) => e.stopPropagation()} />
      {v?.note && !isDay && <div className="muted small">Earlier note: {v.note}</div>}
      {(st || v?.by) && <div className="muted small">{st || `by ${v.by}`}</div>}
    </div>
  );
}

// one pet: parent, location, vaccinations and visit history (from VetBuddy bills)
function PetPanel({ phone, pet, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setD(null); setErr("");
    rpc("cd_pet", { p_phone: phone, p_pet_id: pet.pet_id }).then(setD).catch((e) => setErr(e.message));
  }, [phone, pet.pet_id]);
  const info = d?.pet || {};
  const age = info.dob ? (() => { const m = Math.floor((Date.now() - new Date(info.dob)) / 2629800000); return m >= 24 ? `${Math.floor(m / 12)} yrs` : m >= 1 ? `${m} months` : ""; })() : "";
  const units = (d?.units || []).map((u) => `${title(u.unit)}${u.vow ? " (home visit)" : ""}`);
  return (
    <div className="petpanel">
      <div className="petpanel-head">
        <div>
          <div className="cust-name sm">{info.name || pet.name}</div>
          <div className="muted">{[info.species || pet.species, info.breed || pet.breed, info.sex, age, info.weight ? `${Number(info.weight)} kg` : ""].filter(Boolean).join(" · ")}</div>
        </div>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      {err && <p className="note warn">{err}</p>}
      {!d && !err && <p className="muted small">Loading…</p>}
      {d && (
        <>
          <dl className="petfacts">
            <dt>Pet parent</dt><dd>{title(info.parent) || <span className="muted">not in VetBuddy</span>}</dd>
            <dt>Location</dt><dd>{units.length ? units.join(", ") : <span className="muted">not in VetBuddy</span>}</dd>
            {info.dob && (<><dt>Date of birth</dt><dd>{fmtDate(info.dob)}</dd></>)}
            <dt>With Sanchu</dt><dd>{d.first ? `${fmtDate(d.first)} to ${fmtDate(d.last)} · ${d.visit_days} visit ${d.visit_days === 1 ? "day" : "days"} · ${rs(d.spend || 0)}` : <span className="muted">no bills</span>}</dd>
          </dl>
          <h4>Vaccinations at Sanchu</h4>
          {d.vaccines.length === 0 ? <p className="muted small">No vaccination records found at Sanchu.</p> : (
            <table className="mini"><tbody>
              {d.vaccines.map((v, i) => <tr key={i}><td className="nowrap">{fmtDate(v.sale_date)}</td><td><strong>{v.item}</strong></td><td>{title(v.unit)}</td><td className="muted">{v.doctor}</td></tr>)}
            </tbody></table>
          )}
          <h4>Visit history</h4>
          {d.visits.length === 0 ? <p className="muted small">No visits found.</p> : (
            <table className="mini">
              <thead><tr><th>Date</th><th>Unit</th><th>Billed</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {d.visits.map((v, i) => (
                  <tr key={i}>
                    <td className="nowrap">{fmtDate(v.sale_date)}</td>
                    <td>{title(v.unit)}</td>
                    <td>{[...new Set(v.items)].map((x) => x.replace(/^Vaccination & Physical Examination - /, "Vaccination - ")).join(", ")}{v.doctor ? <span className="muted small"> · {v.doctor}</span> : null}</td>
                    <td className="num">{rs(Math.round(v.amount || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">From VetBuddy bills since 20 Dec 2025. Vaccines or visits at other clinics are not shown.</p>
        </>
      )}
    </div>
  );
}

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
const fmtDay = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "");
const fmtDT = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
const rs = (n) => (n == null ? "" : "Rs " + Number(n).toLocaleString("en-IN"));
const daysAgo = (d) => (d ? Math.round((Date.now() - new Date(d + "T00:00:00")) / 864e5) : null);
const clean = (s) => (s || "").replace(/&nbsp;?/gi, " ").replace(/\s*\(\d+\)/g, "").replace(/\s+/g, " ").trim();
const title = (s) => clean(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const phoneFmt = (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);
const todayISO = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

function Chip({ tone = "neutral", children, title: t }) {
  return <span className={`chip chip-${tone}`} title={t}>{children}</span>;
}
function ReasonChip({ r }) {
  const t = TYPES[r.type] || { name: r.type, tone: "grey" };
  return <Chip tone={t.tone}>{t.name}</Chip>;
}
const slotNow = (now) => { const h = new Date(now).getHours(); return h < 12 ? "morning" : h < 16 ? "afternoon" : "evening"; };
const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2 };
const topRank = (r) => Math.min(...(r.reasons || []).map((x) => x.rank ?? 99), 99);
// recommended order: 0 call-back due, 1 urgent (appointments, post-surgery, rabies, Club ending), 2 best time is now,
// 3 no best time known / its best time already passed today, 4 best time is later today (call then)
const recGroup = (r, now) => {
  if (cbDue(r, now)) return 0;
  const cur = SLOT_ORDER[slotNow(now)], best = r.try_slot ? SLOT_ORDER[r.try_slot] : null;
  const later = best != null && best > cur;
  if (topRank(r) <= 4 && !later) return 1;
  if (best != null && best === cur) return 2;
  if (!later) return 3;
  return 4;
};
const REC_TAG = { 1: ["Urgent", "red"], 2: ["Best time now", "good"], 4: ["Best later", "neutral"] };
const SLOT_TIME = { morning: "before 12", afternoon: "12 to 4 pm", evening: "after 4 pm" };
const isCb = (r) => r.outcome === "callback" && !!r.callback_at;
const cbDue = (r, now) => isCb(r) && new Date(r.callback_at).getTime() <= now;
const cbWaiting = (r, now) => isCb(r) && new Date(r.callback_at).getTime() > now;
// Skip: the number leaves "To call" for an hour, then comes back by itself
const SKIP_MS = 60 * 60 * 1000;
const skipWaiting = (r, now) => !!r.skipped_at && !r.called_at && new Date(r.skipped_at).getTime() + SKIP_MS > now;
const skipBack = (r) => new Date(new Date(r.skipped_at).getTime() + SKIP_MS);
// Excel call log: date, agent, customer, phone, reason, Called / Not called / Rescheduled (+ date and time)
export async function downloadLog(from, to, agent = -1, label = "") {
  const rows = await rpc("cd_log", { p_from: from, p_to: to, p_agent: agent });
  const XLSX = await import("xlsx");
  const dt = (x) => (x ? new Date(x).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const data = rows.map((r) => ({
    Date: r.list_date.split("-").reverse().join("-"), Agent: r.agent, Customer: clean(r.client), Phone: r.phone, Unit: title(r.unit),
    Reason: clean(r.reasons), Status: r.status, "Rescheduled to": r.status === "Rescheduled" ? dt(r.callback_at) : "",
    "Marked called at": dt(r.called_at), "Marked by": r.called_by || "", Note: r.note || "",
    "Call log: called": r.logged_called ? "Yes" : "No", "Call log: answered": r.logged_answered ? "Yes" : "No", "Last logged call": r.last_call || "",
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ Date: "", Agent: "No rows for this selection" }]);
  ws["!cols"] = [10, 16, 22, 12, 14, 60, 12, 20, 20, 16, 30, 12, 12, 40].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Call log");
  const d = (x) => x.split("-").reverse().join("-");
  XLSX.writeFile(wb, `Call Desk Log ${label ? label + " " : ""}${from === to ? d(from) : d(from) + " to " + d(to)}.xlsx`);
}
function rowDone(r) {
  return !!r.outcome && r.outcome !== "callback";
}

// the agent's new DND / Deceased marks go to the team's sheets at once (api/sheets.py); the agent does not wait
const writeSheets = () => { fetch("/api/sheets", { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => {}); };
let sheetsFlushed = false;   // on the first customer opened after a page load, marks still waiting are written too

// time on one customer (23 Nov 2026): after ALERT_MIN minutes the team lead is alerted (cd_alerts)
const ALERT_MIN = 12;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const closeCard = (id) => { if (id) fetch("/api/rpc", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn: "cd_card_close", args: { p_card: id } }) }).catch(() => {}); };

function CardTimer({ rowId }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let card = null, gone = false;
    rpc("cd_card_open", { p_id: rowId }).then((id) => { if (gone) closeCard(id); else card = id; }).catch(() => {});
    const leave = () => closeCard(card);
    window.addEventListener("pagehide", leave);
    return () => { gone = true; window.removeEventListener("pagehide", leave); closeCard(card); };
  }, [rowId]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.floor((now - start) / 1000);
  const tone = s >= ALERT_MIN * 60 ? "red" : s >= (ALERT_MIN - 2) * 60 ? "warn" : "neutral";
  return <span title={`Time on this customer. After ${ALERT_MIN} minutes the team lead is alerted.`}><Chip tone={tone}>⏱ {mmss(s)}{s >= ALERT_MIN * 60 ? " · team lead alerted" : ""}</Chip></span>;
}

// team lead: agents on one customer for 12+ minutes (checked once a minute), with a desktop notification
function LeadAlerts() {
  const [list, setList] = useState([]);
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  const seen = useRef(new Set());
  const load = useCallback(() => {
    rpc("cd_alerts").then((a) => {
      setList(a || []);
      (a || []).forEach((x) => {
        if (seen.current.has(x.card)) return;
        seen.current.add(x.card);
        try { if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Call Desk: agent inactive", { body: `${x.agent} - ${x.minutes} min on ${title(x.client) || "one customer"}`, tag: `cd-${x.card}` }); } catch { /* ignore */ }
      });
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const ack = (c) => { setList((l) => l.filter((x) => x.card !== c)); rpc("cd_alert_ack", { p_card: c }).catch(() => {}); };
  return (
    <>
      {perm === "default" && typeof Notification !== "undefined" && (
        <div className="alertbar muted"><button className="link" onClick={() => Notification.requestPermission().then(setPerm)}>Turn on desktop alerts</button> to be told when an agent stays on one customer for {ALERT_MIN}+ minutes.</div>
      )}
      {list.length > 0 && (
        <div className="alertbar">
          {list.map((x) => (
            <div key={x.card}>⚠ <strong>{x.agent}</strong> has been on <strong>{title(x.client) || phoneFmt(x.phone)}</strong> for {x.minutes} min (since {fmtTime(x.opened_at)}). <button className="link" onClick={() => ack(x.card)}>OK</button></div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ customer panel
function Customer({ row, onSaved, onNext, onSkip }) {
  const [marking, setMarking] = useState(false);
  const markNext = async () => {
    setMarking(true);
    try {
      const r = await rpc("cd_mark_called", { p_id: row.id });
      onSaved({ ...row, called_at: r.called_at, outcome: r.outcome, callback_at: r.outcome === "callback" ? r.callback_at : row.callback_at });
      onNext();
    } catch (e) { alert(e.message); }
    setMarking(false);
  };
  // DND (23 Nov 2026): the number is never called again; it goes to the team's DND sheet with the reason
  const [dndOpen, setDndOpen] = useState(false);
  const [dndWhy, setDndWhy] = useState("");
  const [dndErr, setDndErr] = useState("");
  const saveDnd = async () => {
    setDndErr("");
    try {
      const why = dndWhy.trim() || "Customer asked not to call";
      await rpc("cd_dnd", { p_id: row.id, p_reason: why });
      writeSheets();
      onSaved({ ...row, outcome: "dnd", note: why, status: "closed" });
      setDndOpen(false); onNext();
    } catch (e) { setDndErr(e.message); }
  };
  const [cbOpen, setCbOpen] = useState(false);
  const [cbAt, setCbAt] = useState("");
  const [cbNote, setCbNote] = useState(row.note || "");
  const [cbErr, setCbErr] = useState("");
  const openCb = () => { setCbAt(toLocalInput(row.callback_at || new Date(Date.now() + 3600e3).toISOString())); setCbNote(row.note || ""); setCbErr(""); setCbOpen(true); };
  const quick = (mins) => setCbAt(toLocalInput(new Date(Date.now() + mins * 60e3).toISOString()));
  const saveCb = async (next) => {
    if (!cbAt) { setCbErr("Pick the date and time."); return; }
    try {
      const at = new Date(cbAt).toISOString();
      await rpc("cd_save", { p_id: row.id, p_outcome: "callback", p_note: cbNote || null, p_callback: at });
      onSaved({ ...row, outcome: "callback", note: cbNote || null, callback_at: at, status: row.connected_at ? row.status : "callback" });
      setCbOpen(false);
      if (next) { const r = await rpc("cd_mark_called", { p_id: row.id }); onSaved({ ...row, outcome: "callback", note: cbNote || null, callback_at: at, called_at: r.called_at }); onNext(); }
    } catch (e) { setCbErr(e.message); }
  };
  const clearCb = async () => {
    try { await rpc("cd_save", { p_id: row.id, p_outcome: null, p_note: row.note || null, p_callback: null }); onSaved({ ...row, outcome: null, callback_at: null, status: row.connected_at ? "connected" : row.attempted_at ? "attempted" : "new" }); setCbOpen(false); }
    catch (e) { setCbErr(e.message); }
  };
  const [calls, setCalls] = useState(null);
  const [bills, setBills] = useState(null);
  const [copied, setCopied] = useState(false);
  const [openPet, setOpenPet] = useState(null);
  const [extras, setExtras] = useState({ pitch: [], vacc: {} });   // "What to pitch next" ticks + typed vaccination details
  const [pitchErr, setPitchErr] = useState("");
  const [dead, setDead] = useState([]);          // pets ticked "Deceased" on this number (Call Desk marks)
  const [deadErr, setDeadErr] = useState("");

  useEffect(() => {
    setCalls(null); setBills(null); setOpenPet(null); setPitchErr(""); setDead([]); setDeadErr(""); setDndOpen(false); setDndWhy(""); setDndErr("");
    rpc("cd_pet_deceased_list", { p_id: row.id }).then((d) => setDead(d || [])).catch(() => {});
    if (!sheetsFlushed) { sheetsFlushed = true; writeSheets(); }
    setExtras({ pitch: row.pitch || [], vacc: {} });
    rpc("cd_card_extras", { p_id: row.id }).then((e) => setExtras({ pitch: e?.pitch || [], vacc: e?.vacc || {} })).catch(() => {});
    rpc("cd_calls", { p_phone: row.phone }).then(setCalls).catch(() => setCalls([]));
    rpc("cd_bills", { p_phone: row.phone }).then(setBills).catch(() => setBills([]));
  }, [row.id]);

  const togglePitch = async (p, on) => {
    const before = extras.pitch;
    const next = on ? [...before, p] : before.filter((x) => x !== p);
    setExtras((x) => ({ ...x, pitch: next })); setPitchErr("");
    try { const v = await rpc("cd_pitch_save", { p_id: row.id, p_items: next }); setExtras((x) => ({ ...x, pitch: v || [] })); }
    catch (e) { setExtras((x) => ({ ...x, pitch: before })); setPitchErr(e.message); }
  };

  const markDeceased = async (p, on) => {
    setDeadErr("");
    if (on && !window.confirm(`Mark ${p.name || "this pet"} as deceased?\n\nNo more calls about this pet, and it is added to the Deceased sheet.`)) return;
    try {
      const r = await rpc("cd_pet_deceased", { p_id: row.id, p_pet_id: String(p.pet_id), p_on: on });
      setDead((d) => (on ? [...d, String(p.pet_id)] : d.filter((x) => x !== String(p.pet_id))));
      if (on) writeSheets();
      if (on && r?.all_deceased) setDeadErr("All pets on this number are now marked deceased - this number will not be called again. Close the call kindly and move to the next customer.");
    } catch (e) { setDeadErr(e.message); }
  };

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
  // the whole number (all pets together): spend and visit days add up across pets, not the biggest single pet
  const billSpend = (bills || []).reduce((s, b) => s + Number(b.amount || 0), 0);
  const spend = Math.max(pets.reduce((s, p) => s + Number(p.revenue || 0), 0), billSpend);
  const firstVisit = pets.map((p) => p.first_visit).filter(Boolean).sort()[0];
  const lastVisit = pets.map((p) => p.last_visit).filter(Boolean).sort().reverse()[0];
  const billDays = new Set((bills || []).map((b) => b.sale_date)).size;
  const visitDays = Math.max(billDays, pets.reduce((mx, p) => Math.max(mx, Number(p.visits || 0)), 0));
  const reasons = [...row.reasons].sort((a, b) => a.rank - b.rank);
  const [sLabel, sTone] = STATUS[row.status] || ["", "neutral"];

  return (
    <div className="customer">
      <div className="cust-head">
        <div>
          <div className="cust-name">{title(row.client) || "Name not in VetBuddy"}</div>
          <div className="muted">{title(row.unit)}{row.carried_from ? ` · carried from ${fmtDate(row.carried_from)}` : ""}{row.tries ? ` · ${row.tries} earlier ${row.tries === 1 ? "try" : "tries"}` : ""}</div>
        </div>
        <div><CardTimer rowId={row.id} /> <Chip tone={sTone}>{sLabel}</Chip></div>
      </div>

      <div className="dialer">
        <div className="phone">{phoneFmt(row.phone)}</div>
        <button className="primary" onClick={copy}>{copied ? "Copied" : "Copy number"}</button>
        <button className="ghost" onClick={openCb}>{isCb(row) ? "Change call-back time" : "Call back later"}</button>
        <button className="primary" disabled={marking} onClick={markNext} title="Marks this customer as called and opens the next one">{marking ? "Saving…" : "Called - next customer"}</button>
        <button className="link" onClick={onSkip} title="Move on without marking as called - this number comes back to your list in 1 hour">Skip (back in 1 hour)</button>
        <button className="ghost danger" onClick={() => { setDndOpen(!dndOpen); setDndErr(""); }} title="Do not disturb: this number is never called again and goes to the DND sheet">DND</button>
      </div>
      {dndOpen && (
        <div className="cbbox">
          <div className="cbrow">
            <strong>Do not disturb this number?</strong>
            {["Customer asked not to call", "Pet died", "Stop messaging this number"].map((w) => (
              <button key={w} className={`opt ${dndWhy === w ? "on" : ""}`} onClick={() => setDndWhy(w)}>{w}</button>
            ))}
          </div>
          <input className="cbnote" placeholder="Reason (goes to the DND sheet)" value={dndWhy} onChange={(e) => setDndWhy(e.target.value)} />
          {dndErr && <p className="note warn">{dndErr}</p>}
          <div className="actions"><button className="primary" onClick={saveDnd}>Save DND and next</button><button className="link" onClick={() => setDndOpen(false)}>Cancel</button></div>
          <p className="muted small">The number is never called again. It is added to the DND sheet with this reason.</p>
        </div>
      )}
      {row.try_note && <div className="tryline">Best time to call: <strong>{row.try_slot} ({SLOT_TIME[row.try_slot]})</strong> · {row.try_note}</div>}
      {isCb(row) && !cbOpen && (
        <div className="cbline">Call back at <strong>{fmtDT(row.callback_at)}</strong>{row.note ? ` · ${row.note}` : ""} <button className="link" onClick={clearCb}>Remove</button></div>
      )}
      {cbOpen && (
        <div className="cbbox">
          <div className="cbrow">
            <label className="inline">Call back at <input type="datetime-local" value={cbAt} onChange={(e) => setCbAt(e.target.value)} /></label>
            <button className="opt" onClick={() => quick(30)}>+30 min</button>
            <button className="opt" onClick={() => quick(60)}>+1 hour</button>
            <button className="opt" onClick={() => quick(120)}>+2 hours</button>
            <button className="opt" onClick={() => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0); setCbAt(toLocalInput(t.toISOString())); }}>Tomorrow 10 am</button>
          </div>
          <input className="cbnote" placeholder="Note (optional) - what the customer said" value={cbNote} onChange={(e) => setCbNote(e.target.value)} />
          {cbErr && <p className="note warn">{cbErr}</p>}
          <div className="actions"><button className="primary" onClick={() => saveCb(true)}>Save and next</button><button className="ghost" onClick={() => saveCb(false)}>Save</button><button className="link" onClick={() => setCbOpen(false)}>Cancel</button></div>
          <p className="muted small">At that time this customer moves to the top of your list.</p>
        </div>
      )}
      <div className="muted small">{row.last_call ? `Last logged call: ${row.last_call}.` : "Corefactor calls show here within a minute; Runo calls the next morning."}</div>

      <section className="purpose">
        <h3>Purpose of calling</h3>
        <ul className="reasons">
          {reasons.map((r, i) => (
            <li key={i}><ReasonChip r={r} /> <span>{clean(r.label)}{clean(r.pet) ? <strong> · {clean(r.pet)}</strong> : null}</span></li>
          ))}
        </ul>
      </section>

      <section className="pitchnext">
        <h3>What to pitch next</h3>
        <div className="units">
          {PITCH.map((p) => (
            <label key={p} className="check"><input type="checkbox" checked={extras.pitch.includes(p)} onChange={(e) => togglePitch(p, e.target.checked)} /> {p}</label>
          ))}
        </div>
        {pitchErr && <p className="note warn">{pitchErr}</p>}
      </section>

      {pets.length > 0 && (
        <section>
          <h3>Pets <span className="muted small">- click a pet to see its history</span></h3>
          <div className="pets">
            {pets.map((p) => (
              <div role="button" tabIndex={0} className={`pet click ${openPet === p.pet_id ? "on" : ""}`} key={p.pet_id} style={{ textAlign: "left" }}
                      onClick={() => setOpenPet(openPet === p.pet_id ? null : p.pet_id)}
                      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setOpenPet(openPet === p.pet_id ? null : p.pet_id); }}>
                <div className="pet-name">{p.name} <span className="muted">{[p.species, p.breed].filter(Boolean).join(" · ")}</span>
                  <label className="check deceased" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} title="The pet has passed away: no more calls about it; added to the Deceased sheet">
                    <input type="checkbox" checked={dead.includes(String(p.pet_id))} onChange={(e) => markDeceased(p, e.target.checked)} /> Deceased
                  </label>
                </div>
                <dl>
                  <dt>Last visit</dt><dd>{fmtDate(p.last_visit)}{p.last_service ? ` (${p.last_service})` : ""}</dd>
                  <dt>Vaccination</dt><dd>{p.last_vaccination ? fmtDate(p.last_vaccination) : <span className="muted">no record</span>}
                    <VaccNote phone={row.phone} pet={p} v={extras.vacc[p.pet_id]} onSaved={(v) => setExtras((x) => ({ ...x, vacc: { ...x.vacc, [p.pet_id]: v } }))} /></dd>
                  {p.last_bath && (<><dt>Bath</dt><dd>{fmtDate(p.last_bath)}</dd></>)}
                  {p.last_haircut && (<><dt>Haircut</dt><dd>{fmtDate(p.last_haircut)}</dd></>)}
                </dl>
                <span className="pet-open">{openPet === p.pet_id ? "Hide history" : "View history"}</span>
              </div>
            ))}
          </div>
          {deadErr && <p className="note warn">{deadErr}</p>}
          {openPet && <PetPanel phone={row.phone} pet={pets.find((p) => p.pet_id === openPet)} onClose={() => setOpenPet(null)} />}
        </section>
      )}

      <section>
        <h3>VetBuddy summary</h3>
        <div className="summary">
          <div><span>{firstVisit ? fmtDate(firstVisit) : "–"}</span>customer since</div>
          <div><span>{lastVisit ? fmtDate(lastVisit) : "–"}</span>last visit</div>
          <div><span>{visitDays || "–"}</span>visit days</div>
          <div><span>{spend ? rs(spend) : "–"}</span>total spend</div>
        </div>
        {bills !== null && bills.filter((b) => b.invoice_no === "before-dec-2025").map((b, i) => (
          <p key={i} className="muted small oldhist">{b.item} · {rs(Math.round(Number(b.amount || 0)))}{b.pet ? ` · last pet: ${b.pet}` : ""}</p>
        ))}
      </section>

      <section>
        <h3>Call history</h3>
        {calls === null ? <p className="muted small">Loading…</p> : calls.length === 0 ? <p className="muted small">No calls logged for this number.</p> : (
          <table className="mini">
            <tbody>
              {calls.map((c, i) => (
                <tr key={i}>
                  <td>{fmtDT(c.call_at)}</td>
                  <td>{c.source}</td>
                  <td>{c.direction === "in" ? "Incoming" : c.direction === "out" ? "Outgoing" : c.direction === "note" ? "Agent note" : ""}</td>
                  <td>{c.source === "Lead Box" ? <Chip>{c.status || "Note"}</Chip> : c.answered ? <Chip tone="good">Answered</Chip> : <Chip tone="warn">{c.status || "Not answered"}</Chip>}
                    {c.talk_s != null ? <span className="muted small"> {c.talk_s}s talk</span> : c.duration_s != null ? <span className="muted small"> {c.duration_s}s</span> : null}</td>
                  <td className="muted">{c.agent}</td>
                  <td>{[c.disposition, c.notes].filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join(" · ") || <span className="muted small">no note</span>}
                    {c.dtmf ? <span className="muted small"> · pressed {c.dtmf}</span> : null}
                    {c.recording && /^https?:\/\//.test(c.recording) ? <> · <a href={c.recording} target="_blank" rel="noreferrer">Recording</a></> : null}</td>
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
  // live Corefactor calls: every 30 s (only while this tab is on screen) fetch just the rows a call changed
  useEffect(() => {
    if (day !== todayISO()) return undefined;
    let since = null, busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const args = { p_day: day, p_since: since };
        if (isLead) args.p_agent = agentId;
        const r = await rpc("cd_list_live", args);
        since = r.now;
        if (r.rows?.length) {
          const m = new Map(r.rows.map((x) => [x.id, x]));
          setRows((rs) => (rs ? rs.map((x) => (m.has(x.id) ? { ...x, ...m.get(x.id) } : x)) : rs));
        }
      } catch { /* next tick */ } finally { busy = false; }
    };
    tick();
    const t = setInterval(tick, 30000);
    const vis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [day, agentId, isLead]);

  const [reason, setReason] = useState("");
  const reasonCounts = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((r) => new Set(r.reasons.map((x) => x.type)).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(t); }, []);
  const answered = (r) => (rowDone(r) || r.status === "connected" || !!r.called_at) && !isCb(r);
  const counts = useMemo(() => {
    const c = { todo: 0, done: 0, all: rows?.length || 0, callback: 0, due: 0 };
    (rows || []).forEach((r) => {
      if (isCb(r)) c.callback++;
      if (cbDue(r, now)) c.due++;
      if (answered(r)) c.done++; else if (!cbWaiting(r, now) && !skipWaiting(r, now)) c.todo++;
    });
    return c;
  }, [rows, now]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (filter === "todo" && (answered(r) || cbWaiting(r, now) || skipWaiting(r, now))) return false;
      if (filter === "done" && !answered(r)) return false;
      if (filter === "callback" && !isCb(r)) return false;
      if (reason && !r.reasons.some((x) => x.type === reason)) return false;
      if (!t) return true;
      return (r.client || "").toLowerCase().includes(t) || r.phone.includes(t) || (r.pets || []).some((p) => (p.name || "").toLowerCase().includes(t));
    }).map((r, i) => [r, i]).sort((a, b) => {
      if (filter === "callback") return new Date(a[0].callback_at) - new Date(b[0].callback_at);
      const da = cbDue(a[0], now), db = cbDue(b[0], now);
      if (da !== db) return da ? -1 : 1;
      if (da && db) return new Date(a[0].callback_at) - new Date(b[0].callback_at);
      // recommended: urgent first, then numbers whose best time is now, then the rest, numbers best called later today last;
      // inside each group the most urgent reason (priority) first, then the list's own fair-mix order
      if (filter === "todo" || filter === "all") {
        const ga = recGroup(a[0], now), gb = recGroup(b[0], now);
        if (ga !== gb) return ga - gb;
        const ra = topRank(a[0]), rb = topRank(b[0]);
        if (ra !== rb) return ra - rb;
      }
      return a[1] - b[1];
    }).map((x) => x[0]);
  }, [rows, filter, q, now, reason]);

  const current = rows?.find((r) => r.id === sel) || null;
  const next = () => {
    const i = shown.findIndex((r) => r.id === sel);
    const open = (r) => !answered(r) && !cbWaiting(r, now) && !skipWaiting(r, now) && r.id !== sel;
    const n = shown.slice(i + 1).find(open) || shown.find(open);
    setSel(n ? n.id : null);
  };
  // Skip: saved, hidden for an hour, then back in the list (not lost)
  const skip = async () => {
    const r = current;
    if (r) {
      const t = new Date().toISOString();
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, skipped_at: t } : x)));
      rpc("cd_skip", { p_id: r.id }).catch(() => {});
    }
    next();
  };
  const onSaved = (u, goNext) => {
    setRows((rs) => rs.map((r) => (r.id === u.id ? { ...r, ...u } : r)));
    if (goNext) next();
  };

  const attempted = (rows || []).filter((r) => r.called_at || r.attempted_at).length;
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
            <button className="link xl" title="Download this list as an Excel call log" onClick={() => downloadLog(day, day, isLead ? agentId : me.id, isLead && agentId > 0 ? (agents.find((a) => a.id === agentId)?.name || "") : isLead ? "" : me.name).catch((e) => alert(e.message))}>Excel</button>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
          <div className="bar"><span style={{ width: `${total ? Math.min(100, (attempted / total) * 100) : 0}%` }} /></div>
        </div>
        <div className="filters">
          {[["todo", "To call"], ["callback", "Call-backs"], ["done", "Called"], ["all", "All"]].map(([k, v]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{v} <span>{counts[k]}</span></button>
          ))}
        </div>
        <select className="search" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">All reasons ({rows?.length || 0})</option>
          {reasonCounts.map(([t, n]) => <option key={t} value={t}>{(TYPES[t] || { name: t }).name} ({n})</option>)}
        </select>
        <input className="search" placeholder="Search name, pet or number" value={q} onChange={(e) => setQ(e.target.value)} />
        {isLead && picked.size > 0 && (
          <div className="movebar">
            {picked.size} selected · move to
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">agent…</option>
              {agents.filter((a) => a.active && a.role === "agent" && a.calls).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button className="primary sm" disabled={!moveTo} onClick={move}>Move</button>
          </div>
        )}
        <div className="rows" ref={listRef}>
          {rows === null && <p className="muted pad">Loading the list…</p>}
          {err && <p className="note warn pad">{err}</p>}
          {rows && rows.length === 0 && !err && <p className="muted pad">No list for this day yet. Lists are built every morning at 8:05.</p>}
          {filter === "todo" && shown.length > 0 && <p className="muted small pad rec-hint">Recommended order: call-backs due · urgent · best time now ({slotNow(now)}) · others · best later today. "Called - next customer" follows it.</p>}
          {shown.map((r, idx) => {
            const top = r.reasons[0] && [...r.reasons].sort((a, b) => a.rank - b.rank)[0];
            const g = recGroup(r, now), firstOpen = filter === "todo" && idx === 0 && !cbDue(r, now);
            const [sl, st] = STATUS[r.status] || ["", "neutral"];
            return (
              <div key={r.id} className={`row ${sel === r.id ? "sel" : ""} ${rowDone(r) ? "done" : ""} ${cbDue(r, now) ? "cbdue" : ""}`} onClick={() => setSel(r.id)}>
                {isLead && <input type="checkbox" checked={picked.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => { const s = new Set(picked); e.target.checked ? s.add(r.id) : s.delete(r.id); setPicked(s); }} />}
                <div className="row-main">
                  <div className="row-top"><span className="row-name">{firstOpen && <span className="rec-star" title="Recommended next call">★ </span>}{title(r.client) || phoneFmt(r.phone)}</span>{cbDue(r, now) ? <Chip tone="red">Call back now</Chip> : isCb(r) ? <Chip tone="violet">Call back {fmtDT(r.callback_at)}</Chip> : r.called_at ? <Chip tone="good">Called {fmtTime(r.called_at)}</Chip> : skipWaiting(r, now) ? <Chip tone="neutral">Skipped - back {fmtTime(skipBack(r).toISOString())}</Chip> : <Chip tone={st}>{r.outcome ? OUTCOME_NAME[r.outcome] : sl}</Chip>}</div>
                  <div className="row-chips">{[...r.reasons].sort((a, b) => a.rank - b.rank).map((x, i) => <ReasonChip key={i} r={x} />)}</div>
                  <div className="row-sub"><span className="muted">{clean((reason && r.reasons.find((x) => x.type === reason)?.label) || top?.label)}</span></div>
                  <div className="row-meta muted">{title(r.unit)}{r.pets?.[0]?.name ? ` · ${r.pets.map((p) => p.name).slice(0, 3).join(", ")}` : ""}{r.dialed_at ? ` · copied ${fmtTime(r.dialed_at)}` : ""}{r.try_slot ? ` · best: ${r.try_slot}` : ""}{filter === "todo" && REC_TAG[g] ? <> · <span className={`rec-tag ${REC_TAG[g][1]}`}>{REC_TAG[g][0]}{g === 4 ? ` (${r.try_slot})` : ""}</span></> : null}</div>
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
            <Customer key={current.id} row={current} onSaved={(u) => onSaved(u, false)} onNext={next} onSkip={skip} />
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
  const [showReasons, setShowReasons] = useState(false);
  const [check, setCheck] = useState(null);   // { agent, start }: who was called vs marked called
  const open = (e, agent, start) => { e.stopPropagation(); setCheck({ agent, start }); };
  const load = useCallback(() => rpc("cd_team", { p_day: day }).then(setT).catch((e) => setErr(e.message)), [day]);
  useEffect(() => { setT(null); load(); }, [load]);
  if (err) return <p className="note warn pad">{err}</p>;
  if (!t) return <p className="muted pad">Loading…</p>;
  const sum = (k) => t.agents.reduce((s, a) => s + Number(a[k] || 0), 0);
  return (
    <div className="page">
      <div className="page-head">
        <h2>Team today</h2>
        <button className={showReasons ? "" : "ghost"} onClick={() => setShowReasons((v) => !v)}>
          Choose reasons{t.reasons_off?.length ? ` (${t.reasons_off.length} off)` : ""}
        </button>
        <button className="ghost" onClick={() => downloadLog(day, day).catch((e) => alert(e.message))}>Download Excel call log</button>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </div>
      {showReasons && <ReasonSwitch off={t.reasons_off || []} onChange={load} />}
      <SkipCalled s={t.skip_called} hidden={t.hidden_called} onChange={load} />
      <div className="kpis">
        <div><span>{sum("assigned") + t.unassigned}</span>on the lists</div>
        <div><span>{sum("marked_called")}</span>marked called</div>
        <div><span>{sum("rescheduled")}</span>rescheduled</div>
        <div><span>{sum("attempted")}</span>called (logs)</div>
        <div><span>{sum("connected")}</span>answered (logs)</div>
        
      </div>
      <p className="muted small">"Called" and "answered": Corefactor calls arrive live (each call within a minute), Runo calls each morning (latest call: {fmtDT(t.last_call_loaded) || "none yet"}).</p>
      <table className="grid">
        <thead><tr><th>Agent</th><th>Units</th><th>On list</th><th>First call</th><th>Last call</th><th>Marked called</th><th>Rescheduled</th><th>Called (logs)</th><th>Answered (logs)</th><th>Done %</th></tr></thead>
        <tbody>
          {t.agents.filter((a) => a.role === "agent" && a.calls).map((a) => (
            <tr key={a.id} className="click" onClick={() => openAgent(a.id)}>
              <td>{a.name}{!a.active && <span className="muted"> (off)</span>}</td>
              <td className="muted">{a.units?.length ? a.units.map(title).join(", ") : "Any"}</td>
              <td>{a.assigned}</td><td>{fmtTime(a.first_call) || "—"}</td><td>{fmtTime(a.last_call) || "—"}</td>
              <td>{a.marked_called ? <button className="cc-num" title="See who was marked called" onClick={(e) => open(e, a, "marked")}>{a.marked_called}</button> : 0}
                {a.marked_called > a.attempted && <button className="cc-diff" title="Marked called but not in the call logs" onClick={(e) => open(e, a, "gap")}>+{a.marked_called - a.attempted}</button>}</td>
              <td>{a.rescheduled}</td>
              <td>{a.attempted ? <button className="cc-num" title="See who was called (call logs)" onClick={(e) => open(e, a, "logs")}>{a.attempted}</button> : 0}</td><td>{a.connected}</td>
              <td>{a.assigned ? Math.round((Math.max(a.attempted, a.marked_called) / a.assigned) * 100) : 0}%</td>
            </tr>
          ))}
          {t.unassigned > 0 && <tr className="click" onClick={() => openAgent(0)}><td>Not assigned</td><td /><td>{t.unassigned}</td><td colSpan={8} className="muted">Add agents (Agents tab) and rebuild, or move these rows from the list.</td></tr>}
        </tbody>
      </table>
      {check && <CalledCheck agent={check.agent} day={day} start={check.start} onClose={() => setCheck(null)} />}
      <h3>By reason</h3>
      <table className="grid">
        <thead><tr><th>Reason</th><th>On lists</th><th>Called</th><th>Answered</th><th>Answer rate</th></tr></thead>
        <tbody>
          {t.by_reason.map((r) => (
            <tr key={r.type} className={(t.reasons_off || []).some((o) => o.type === r.type) ? "dim" : ""}><td><ReasonChip r={r} />{(t.reasons_off || []).some((o) => o.type === r.type) && <span className="muted small"> switched off - not shown</span>}</td><td>{r.due}</td><td>{r.attempted}</td><td>{r.connected}</td><td>{r.attempted ? Math.round((r.connected / r.attempted) * 100) + "%" : "–"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const UNITS = ["ADYAR", "ANNA NAGAR", "NEELANGARAI", "VELACHERY", "VALASARAVAKKAM", "CH VET ON WHEELS", "COIMBATORE", "CBE VET ON WHEELS", "MADURAI", "MADURAI VET ON WHEELS", "TRICHY"];

function Agents({ me, agents, depts = [], reload }) {
  const blank = { id: null, email: "", name: "", role: "agent", department: "Sharpshooting", units: [], target: 200, active: true, pin: "" };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState("");
  const [fDept, setFDept] = useState("");   // filters: "" = all, "-" = none / Any
  const [fUnit, setFUnit] = useState("");
  const shown = agents.filter((a) =>
    (!fDept || (fDept === "-" ? !a.department : a.department === fDept)) &&
    (!fUnit || (fUnit === "-" ? !a.units?.length : (a.units || []).includes(fUnit))));
  // active / inactive switch (inactive: signed out, cannot sign in, no numbers; past calls are kept)
  const [busy, setBusy] = useState(null);
  const setActive = async (a, on) => {
    setMsg("");
    if (!on && !window.confirm(`Make ${a.name} inactive?\n\nThey are signed out, cannot sign in and get no numbers. Today's numbers they have not touched go to the other agents. You can make them active again any time.`)) return;
    setBusy(a.id);
    try { await rpc("cd_agent_active", { p_id: a.id, p_active: on }); setMsg(`${a.name} is now ${on ? "active" : "inactive"}.`); reload(); }
    catch (e2) { setMsg(e2.message); } finally { setBusy(null); }
  };
  // week off: no numbers on that day (they can still sign in)
  const [offFor, setOffFor] = useState(null);
  const [offDay, setOffDay] = useState(todayISO());
  const setOff = async (a, day, off) => {
    setMsg(""); setBusy(a.id);
    try {
      await rpc("cd_agent_off", { p_id: a.id, p_day: day, p_off: off });
      setMsg(off ? `${a.name} is off on ${fmtDay(day)}${day === todayISO() ? " - their untouched numbers today went to the other agents" : ""}.` : `${a.name} is back on ${fmtDay(day)}.`);
      setOffFor(null); reload();
    } catch (e2) { setMsg(e2.message); } finally { setBusy(null); }
  };
  const save = async (e) => {
    e.preventDefault(); setMsg("");
    try {
      await rpc("cd_agent_save", { p_id: f.id ?? null, p_email: f.email, p_name: f.name, p_role: f.role, p_units: f.units, p_target: Number(f.target), p_active: f.active, p_pin: f.pin || null, p_department: f.department || "" });   // p_id: an edit updates that agent, even if the name or email changes
      setMsg(`Saved ${f.name}.` + (f.pin ? ` New PIN set - they sign in with "${f.name}" or ${f.email.toLowerCase()} and that PIN.` : "")); setF(blank); reload();
    } catch (e2) { setMsg(e2.message); }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h2>Agents{(fDept || fUnit) ? <span className="muted small"> ({shown.length} of {agents.length})</span> : null}</h2>
        <label className="inline">Department <select value={fDept} onChange={(e) => setFDept(e.target.value)}>
          <option value="">All departments</option>
          {depts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          <option value="-">No department</option>
        </select></label>
        <label className="inline">Unit <select value={fUnit} onChange={(e) => setFUnit(e.target.value)}>
          <option value="">All units</option>
          {UNITS.map((u) => <option key={u} value={u}>{title(u)}</option>)}
          <option value="-">Any (no unit set)</option>
        </select></label>
        {(fDept || fUnit) && <button className="ghost" onClick={() => { setFDept(""); setFUnit(""); }}>Show all</button>}
      </div>
      <p className="muted small">Each agent signs in with their name or email and a PIN you set here (4 to 8 digits). Changing a PIN does not show the old one. Agents with units get those units' customers first; "Any" takes the rest. Saving a change updates today's list straight away: a new agent gets numbers of their units, and an agent made inactive or a team lead gives theirs back. "Off" marks a week off: no numbers on that day (marking today sends their untouched numbers to the others). Team leads never get numbers. Only agents of a department with call lists (Sharpshooting for now) get numbers; the other departments are listed but get no calls until their process is set up.</p>
      <table className="grid">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Units</th><th>Daily target</th><th>Active</th><th>PIN</th><th /></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={9} className="muted">No agents match these filters.</td></tr>}
          {shown.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td><td className="muted">{a.email}</td><td>{a.role === "lead" ? "Team lead" : "Agent"}</td>
              <td>{a.department || <span className="muted">–</span>}{a.department && !a.calls && <span className="muted small"> (no calls yet)</span>}</td>
              <td className="muted">{a.units?.length ? a.units.map(title).join(", ") : "Any"}</td><td>{a.target}</td>
              <td><label className="check" title={a.active ? "Active: can sign in and gets numbers" : "Inactive: cannot sign in, gets no numbers"}>
                <input type="checkbox" checked={!!a.active} disabled={busy === a.id || (a.id === me?.id)} onChange={(e) => setActive(a, e.target.checked)} /> {a.active ? "Active" : <span className="warntext">Inactive</span>}</label></td><td>{a.has_pin ? "Set" : <span className="warntext">Not set</span>}</td>
              <td className="nowrap"><button className="link" onClick={() => setF({ id: a.id, email: a.email, name: a.name, role: a.role, department: a.department || "", units: a.units || [], target: a.target, active: a.active, pin: "" })}>Edit</button>
                {a.role === "agent" && <> · <button className="link" onClick={() => { setOffFor(offFor === a.id ? null : a.id); setOffDay(todayISO()); }} title="Week off: no numbers on that day">Off</button></>}
                {a.off_today && <> <Chip tone="warn">Off today</Chip></>}
                {(a.off_days || []).filter((d) => d !== todayISO()).map((d) => <span key={d}> <Chip>Off {fmtDay(d)}</Chip></span>)}
                {offFor === a.id && (
                  <div className="offbox" style={{ marginTop: 6 }}>
                    <input type="date" value={offDay} min={todayISO()} onChange={(e) => setOffDay(e.target.value)} />{" "}
                    {(a.off_days || []).includes(offDay)
                      ? <button disabled={busy === a.id} onClick={() => setOff(a, offDay, false)}>Remove off</button>
                      : <button disabled={busy === a.id || !offDay} onClick={() => setOff(a, offDay, true)}>Mark off</button>}
                    {" "}<button className="ghost" onClick={() => setOffFor(null)}>Close</button>
                  </div>
                )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="agentform" onSubmit={save}>
        <h3>{f.id != null ? "Edit agent" : "Add an agent"}</h3>
        <div className="formgrid">
          <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="agent">Agent</option><option value="lead">Team lead</option></select></label>
          <label>Department<select value={f.department || ""} onChange={(e) => setF({ ...f, department: e.target.value })}>
            <option value="">None</option>
            {depts.map((d) => <option key={d.name} value={d.name}>{d.name}{d.calls ? "" : " (no calls yet)"}</option>)}
          </select></label>
          <label>Daily target<input type="number" min={0} max={1000} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>
          <label>{f.id != null ? "New PIN (leave empty to keep)" : "PIN (4 to 8 digits)"}<input inputMode="numeric" pattern="[0-9]*" maxLength={8} value={f.pin}
            onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} required={f.id == null} /></label>
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

// 12-minute warnings: a customer card left open too long (from the card timer), for team leads
function AgentLogs({ day, setDay }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [who, setWho] = useState("");
  const load = useCallback(() => { setErr(""); rpc("cd_agent_logs", { p_day: day }).then(setD).catch((e) => setErr(e.message)); }, [day]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const rows = (d?.rows || []).filter((r) => !who || r.agent === who);
  return (
    <div className="page">
      <div className="page-head" style={{ gap: 8, alignItems: "center" }}>
        <h2>Agent logs</h2>
        <input type="date" value={day} max={todayISO()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">All agents</option>
          {(d?.summary || []).map((s) => <option key={s.agent} value={s.agent}>{s.agent}</option>)}
        </select>
        <button onClick={load}>Refresh</button>
      </div>
      {err && <p className="note warn">{err}</p>}
      <p className="muted small">A warning is raised when one customer stays open for more than 12 minutes.</p>
      {d && <div className="kpis">
        <div><span>{d.rows.length}</span>warnings</div>
        {d.summary.map((s) => <div key={s.agent}><span>{s.warnings}</span>{s.agent} ({s.minutes} min)</div>)}
      </div>}
      <table className="grid">
        <thead><tr><th>Agent</th><th>Customer</th><th>Opened</th><th>Warned</th><th>Closed</th><th>Minutes</th><th>Seen by</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.agent || "—"}</td><td>{r.client || "—"}<div className="muted small">{r.phone}</div></td>
              <td>{fmtTime(r.opened_at)}</td><td>{fmtTime(r.alerted_at)}</td>
              <td>{r.open ? <span className="muted">still open</span> : fmtTime(r.closed_at)}</td>
              <td>{r.minutes}</td>
              <td>{r.acked_by ? `${r.acked_by} ${fmtTime(r.acked_at)}` : <span className="muted">not yet</span>}</td>
            </tr>
          ))}
          {d && !rows.length && <tr><td colSpan={7} className="muted">No warnings on this day.</td></tr>}
        </tbody>
      </table>
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

// ------------------------------------------------------------------ incentives
const monthISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
// salary month: 21st of the previous month to the 20th; from the 21st we are in next month's cycle
const salaryMonthISO = (d = new Date()) => monthISO(d.getDate() >= 21 ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : d);
const monthName = (iso) => new Date(`${iso}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
function Incentives({ me, startAgent = -1, startMonth, ours }) {
  const isLead = me.role === "lead";
  const [month, setMonth] = useState(startMonth || salaryMonthISO());
  const [agent, setAgent] = useState(isLead ? startAgent : me.id);
  const [dept, setDept] = useState("Sharpshooting");   // department filter (all-agents view)
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(null);
  const [showRep, setShowRep] = useState(false);
  const repD = useRepeats(isLead, month, isLead ? agent : -1);   // team leads only: all appointments, unique pets, same pet 5+
  const repOf = (id) => repD?.error ? repD : repD ? (repD.agents?.[String(id)] || { appts: 0, pets: 0, rep_pets: 0, rep_appts: 0 }) : null;
  const openRep = (id) => { setAgent(id); setShowRep(true); setTimeout(() => document.getElementById("rep-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 900); };
  const load = useCallback(() => {
    setD(null); setErr("");
    rpc("cd_incentives", { p_month: `${month}-01`, p_agent: isLead ? agent : -1, p_dept: isLead && agent === -1 ? dept : null }).then(setD).catch((e) => setErr(e.message));
  }, [month, agent, isLead, dept]);
  useEffect(() => { load(); }, [load]);
  const one = d && (agent !== -1 || !isLead) ? d.agents[0] : null;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const rs = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
  const slabDept = one?.department || dept;
  const saveEdit = async () => {
    try {
      await rpc("cd_agent_incentive", { p_id: edit.id, p_logins: edit.logins.split(",").map((x) => x.trim()).filter(Boolean), p_target: edit.target === "" ? null : Number(edit.target) });
      setEdit(null); load();
    } catch (e) { alert(e.message); }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h2>Incentives{one ? ` - ${one.name}` : ""}{one?.department ? <span className="muted small"> ({one.department})</span> : null}</h2>
        {isLead && agent !== -1 && <button className="ghost" onClick={() => setAgent(-1)}>All agents</button>}
        {isLead && agent === -1 && (
          <label className="inline">Department <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All departments</option>
            {(d?.departments || ["Sharpshooting", "Inbound", "Social Media", "Chat"]).map((x) => <option key={x} value={x}>{x}</option>)}
          </select></label>
        )}
        <SalaryMonthPicker month={month} setMonth={setMonth} />
      </div>
      {d && <p className="cycle">Salary month <strong>{salaryLabel(month)}</strong></p>}
      <p className="muted small">
        <strong>Booked</strong> = appointments booked in VetBuddy by the agent's login whose <strong>appointment date and time</strong> fall in this salary month, 21st to 20th (one per pet).
        <strong> Visited</strong> = that pet was billed in VetBuddy on the appointment date or up to 3 days after.
        <strong> Shared</strong> = the same pet was booked by two or more agents for the same appointment date - it counts for none of them.
        <strong> Eligible</strong> = visited and not shared. <strong>Called</strong> = different numbers called (Corefactor / Runo). <strong>Incentive</strong> = slab amount for the eligible visits (attendance and chat bonuses not included yet).
        {d?.slabs?.[slabDept] && <><br /><strong>{slabDept} slabs:</strong> {d.slabs[slabDept].map((s) => `${s.from} visits ${rs(s.fixed)}, then ₹${s.per_visit} per visit`).join(" · ")}</>}
      </p>
      {err && <p className="note warn">{err}</p>}
      {!d && !err && <p className="muted">Loading…</p>}
      {d && one && (
        <>
          <div className="summary inc">
            <div><span>{one.target ?? "–"}</span>target</div>
            <div><span>{one.called}</span>people called</div>
            <div><span>{one.booked}</span>appointments booked</div>
            <div><span>{one.visited}</span>visited</div>
            <div><span>{one.shared}</span>shared (not counted)</div>
            <div className="good"><span>{one.eligible}</span>eligible for incentive</div>
            <div className="good"><span>{rs(one.amount)}</span>incentive</div>
            {one.next_slab && <div><span>{one.next_slab.more}</span>more visits to the {one.next_slab.at} slab (₹{one.next_slab.per_visit} per visit)</div>}
            <div><span>{one.target ? pct(one.eligible, one.target) : "–"}</span>of target</div>
          </div>
          {isLead && <RepeatTiles r={repOf(one.id)} min={repD?.min || 5} onOpen={() => setShowRep(true)} />}
          {isLead && showRep && repD && !repD.error && <RepeatDetails rows={repD.repeats} min={repD.min || 5} onClose={() => setShowRep(false)} />}
          <IncentivePlan slabs={d.slabs?.[one.department]} visits={one.eligible} dept={one.department} />
          {one.logins?.length === 0 && <p className="note warn">No VetBuddy login is linked to {one.name} yet{isLead ? " - add it below." : " - ask your team lead."}</p>}
          <table className="grid">
            <thead><tr><th>Appointment date and time</th><th>Customer</th><th>Pet</th><th>Unit</th><th>Status</th><th>Visited</th><th>Incentive</th></tr></thead>
            <tbody>
              {d.rows.length === 0 && <tr><td colSpan={7} className="muted">No appointments this month.</td></tr>}
              {d.rows.map((r) => (
                <tr key={r.appt_id}>
                  <td className="nowrap">{r.appt_time || fmtDate(r.appt_date)}</td>
                  <td>{title(clean(r.client))}<div className="muted small">{phoneFmt(r.phone)}</div></td><td>{r.pet}</td><td>{title(r.clinic)}</td><td>{r.status}</td>
                  <td>{r.visit_date ? fmtDate(r.visit_date) : <span className="muted">not yet</span>}</td>
                  <td>{r.shared ? <Chip tone="warn">Shared{r.shared_with ? ` with ${r.shared_with}` : ""}</Chip> : r.eligible ? <Chip tone="good">Eligible</Chip> : <span className="muted">no visit yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d && !one && (
        <>
          <table className="grid">
            <thead><tr><th>Agent</th><th>Department</th><th>Target</th><th>Called</th><th>Booked</th><th title="Every appointment, including the same pet more than once">All appts</th><th>Unique pets</th><th title="Pets this agent booked 5 or more times this salary month">Same pet 5+</th><th>Visited</th><th>Shared</th><th>Eligible</th><th>Incentive</th><th>Of target</th><th>VetBuddy logins</th><th /></tr></thead>
            <tbody>
              {d.agents.filter((a) => !ours?.size || ours.has(a.id)).map((a) => (
                <tr key={a.id}>
                  <td><button className="link" onClick={() => setAgent(a.id)}>{a.name}</button></td>
                  <td className="muted">{a.department || "–"}</td>
                  <td>{a.target ?? <span className="muted">–</span>}</td><td>{a.called}</td><td>{a.booked}</td>
                  <td>{repD && !repD.error ? repOf(a.id).appts : <span className="muted">…</span>}</td><td>{repD && !repD.error ? repOf(a.id).pets : <span className="muted">…</span>}</td>
                  <td>{repD && !repD.error ? (repOf(a.id).rep_pets ? <button className="link rep-flag" onClick={() => openRep(a.id)}>{repOf(a.id).rep_pets} pets · {repOf(a.id).rep_appts} bookings</button> : <span className="muted">0</span>) : <span className="muted">…</span>}</td>
                  <td>{a.visited}</td>
                  <td>{a.shared || ""}</td><td><strong>{a.eligible}</strong></td><td><strong>{rs(a.amount)}</strong>{a.next_slab && <div className="muted small">{a.next_slab.more} more → ₹{a.next_slab.per_visit}/visit</div>}</td><td>{a.target ? pct(a.eligible, a.target) : "–"}</td>
                  <td className="muted small">{a.logins?.length ? a.logins.join(", ") : <span className="warntext">none</span>}</td>
                  <td><button className="link" onClick={() => setEdit({ id: a.id, name: a.name, logins: (a.logins || []).join(", "), target: a.target ?? "" })}>Edit</button></td>
                </tr>
              ))}
              <tr className="total"><td>Total</td><td /><td>{d.agents.filter((a) => !ours?.size || ours.has(a.id)).reduce((s, a) => s + (a.target || 0), 0) || "–"}</td>
                {["called", "booked"].map((k) => <td key={k}><strong>{d.agents.filter((a) => !ours?.size || ours.has(a.id)).reduce((s, a) => s + (a[k] || 0), 0)}</strong></td>)}
                {["appts", "pets", "rep_pets"].map((k) => <td key={k}><strong>{repD && !repD.error ? d.agents.filter((a) => !ours?.size || ours.has(a.id)).reduce((s, a) => s + Number(repOf(a.id)[k] || 0), 0) : ""}</strong></td>)}
                {["visited", "shared", "eligible"].map((k) => <td key={k}><strong>{d.agents.filter((a) => !ours?.size || ours.has(a.id)).reduce((s, a) => s + (a[k] || 0), 0)}</strong></td>)}<td><strong>{rs(d.agents.filter((a) => !ours?.size || ours.has(a.id)).reduce((s, a) => s + Number(a.amount || 0), 0))}</strong></td><td /><td /><td /></tr>
            </tbody>
          </table>
          {edit && (
            <div className="agentform">
              <h3>{edit.name}: incentive settings</h3>
              <div className="formgrid">
                <label>Monthly target (eligible visits)<input type="number" min={0} value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} /></label>
                <label className="wide">VetBuddy logins (comma separated - exactly as in "Created By")<input value={edit.logins} onChange={(e) => setEdit({ ...edit, logins: e.target.value })} /></label>
              </div>
              <div className="actions"><button className="primary" onClick={saveEdit}>Save</button><button className="link" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          )}
          {d.unmapped_logins?.length > 0 && (
            <p className="muted small">VetBuddy logins this month not linked to any agent (clinic staff, or an agent's second login): {d.unmapped_logins.map((u) => `${u.login} (${u.n})`).join(", ")}</p>
          )}
          <p className="muted small">Appointments in the database from {fmtDate(d.appts_from)}.</p>
        </>
      )}
    </div>
  );
}

// team lead: Agent logs tab = Dashboard (sheet logic + time on customers) | Logs (the 12-minute warnings, unchanged)
function AgentLogsTabs({ day, setDay, agents }) {
  const [sub, setSub] = useState("dash");
  return (
    <>
      <div className="subnav">
        {[["dash", "Dashboard"], ["logs", "Logs"]].map(([k, v]) => <button key={k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>{v}</button>)}
      </div>
      <div className="hp-fade" key={sub}>
        {sub === "dash" ? <AgentDashboard day={day} setDay={setDay} agents={agents} /> : <AgentLogs day={day} setDay={setDay} />}
      </div>
    </>
  );
}

// team lead: Incentives tab with Team performance / Team incentive / Agents
function LeadIncentives({ me, ours }) {
  const [sub, setSub] = useState("perf");
  const [month, setMonth] = useState(salaryMonthISO());
  const [pick, setPick] = useState({ agent: -1, n: 0 });
  const openAgentIncentive = (id) => { setPick((p) => ({ agent: id, n: p.n + 1 })); setSub("agents"); };
  return (
    <>
      <div className="subnav">
        {[["perf", "Team performance"], ["team", "Team incentive"], ["agents", "Agents' incentives"]].map(([k, v]) => (
          <button key={k} className={sub === k ? "on" : ""} onClick={() => { if (k === "agents") setPick((p) => ({ agent: -1, n: p.n + 1 })); setSub(k); }}>{v}</button>
        ))}
      </div>
      <div className="hp-fade" key={sub + pick.n}>
        {sub === "perf" && <TeamPerformance month={month} setMonth={setMonth} openAgentIncentive={openAgentIncentive} ours={ours} />}
        {sub === "team" && <TeamIncentive month={month} setMonth={setMonth} openAgentIncentive={openAgentIncentive} ours={ours} />}
        {sub === "agents" && <Incentives me={me} startAgent={pick.agent} startMonth={month} ours={ours} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ app
function Login({ onDone }) {
  const [user, setUser] = useState(() => { try { return localStorage.getItem("cd_user") || ""; } catch { return ""; } });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setMsg("");
    try {
      await login(user.trim(), pin.trim());
      try { localStorage.setItem("cd_user", user.trim()); } catch { /* ignore */ }
      setPin(""); onDone();
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  };
  return (
    <div className="login">
      <div className="login-card">
        <img className="login-logo" src="/logo.png" alt="Sanchu Animal Hospital" />
        <div className="brand login-title">Call Desk</div>
        <p className="muted">Sign in with your name or email and your PIN.</p>
        <form onSubmit={submit}>
          <label>Name or email<input autoFocus={!user} required value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" /></label>
          <label>PIN<input autoFocus={!!user} required type="password" inputMode="numeric" pattern="[0-9]*" maxLength={8} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="current-password" /></label>
          <button className="primary" disabled={busy || pin.length < 4}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        {msg && <p className="note warn">{msg}</p>}
        <p className="muted small">Team lead: the first time you sign in, the PIN you type becomes your PIN. Agents get their PIN from the team lead.</p>
      </div>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined);       // undefined = checking, null = signed out
  const [tab, setTab] = useState("list");
  const [day, setDay] = useState(todayISO());
  const [agentId, setAgentId] = useState(-1);
  const [agents, setAgents] = useState([]);
  const [depts, setDepts] = useState([]);   // departments: [{ name, calls }]
  const [err, setErr] = useState("");
  const brk = useBreak(me?.role === "agent");   // agents: Break button and break screen

  const check = useCallback(() => {
    setErr("");
    rpc("cd_me").then((m) => { setMe(m || null); setTab("home"); })
      .catch((e) => { if (e instanceof SignedOut) setMe(null); else { setErr(e.message); setMe(null); } });
  }, []);
  useEffect(() => { check(); }, [check]);
  useEffect(() => { const f = () => setMe(null); window.addEventListener("cd-signed-out", f); return () => window.removeEventListener("cd-signed-out", f); }, []);
  const loadAgents = useCallback(() => {
    const got = (t) => { setAgents(t.agents); setDepts(t.departments || []); };
    // one retry: a slow first load (cold database) must not leave the Agents page empty
    rpc("cd_team", { p_day: todayISO() }).then(got).catch(() => setTimeout(() => rpc("cd_team", { p_day: todayISO() }).then(got).catch(() => {}), 2000));
  }, []);
  useEffect(() => { if (me?.role === "lead") loadAgents(); }, [me, loadAgents]);
  const out = async () => { await logout(); setMe(null); };

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (!me) return (<>{err && <p className="note warn pad">{err}</p>}<Login onDone={check} /></>);

  const isLead = me.role === "lead";
  const ours = new Set(agents.filter((a) => a.role === "agent").map((a) => a.id));   // our agents (Agents list)
  const openAgent = (id) => { setAgentId(id); setTab("list"); };
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><img className="logo-img" src="/logo.png" alt="Sanchu Animal Hospital" /><span className="brand-sep">Call Desk</span></div>
        {isLead && (
          <nav>
            {[["home", "Home"], ["team", "Team"], ["list", "Lists"], ["incentives", "Incentives"], ["kpi", "KPIs"], ["agents", "Agents"], ["logs", "Agent logs"]].map(([k, v]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{v}</button>
            ))}
          </nav>
        )}
        {!isLead && (
          <nav>
            {[["home", "Home"], ["list", "My list"], ["incentives", "My incentives"]].map(([k, v]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{v}</button>
            ))}
          </nav>
        )}
        <div className="who">{!isLead && <BreakButton brk={brk} />}<span>{me.name}</span><button className="link" onClick={out}>Sign out</button></div>
        {isLead && tab === "list" && (
          <select className="agentpick" title="Whose list" value={agentId} onChange={(e) => setAgentId(Number(e.target.value))}>
            <option value={-1}>Everyone</option>
            <option value={0}>Not assigned</option>
            {agents.filter((a) => a.role === "agent" && a.calls).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}

      </header>
      <RulesNotice me={me} />
      {isLead && <LeadAlerts />}
      {isLead && <BreakBar />}
      {!isLead && brk.b?.on_break ? <BreakScreen brk={brk} name={me.name} /> : <>
      {tab === "list" && <CallList me={me} agentId={isLead ? agentId : me.id} agents={agents} day={day} setDay={setDay} />}
      {tab === "team" && <Team day={day} setDay={setDay} openAgent={openAgent} />}
      {tab === "agents" && <Agents me={me} agents={agents} depts={depts} reload={loadAgents} />}
      {tab === "logs" && isLead && <AgentLogsTabs day={day} setDay={setDay} agents={agents} />}
      {tab === "kpi" && <KpiPage types={TYPES} Chip={ReasonChip} />}
      {tab === "home" && (isLead
        ? <LeadHome me={me} ours={ours} goPerf={() => setTab("incentives")} goTeam={() => setTab("team")} goLogs={() => setTab("logs")} />
        : <AgentHome me={me} goList={() => setTab("list")} goIncentives={() => setTab("incentives")} />)}
      {tab === "incentives" && (isLead ? <LeadIncentives me={me} ours={ours} /> : <Incentives me={me} />)}
      </>}
    </div>
  );
}
