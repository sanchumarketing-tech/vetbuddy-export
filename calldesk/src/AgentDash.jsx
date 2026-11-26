// Agent logs -> Dashboard (team leads), 26 Nov 2026.
// Same rules as the "Agent Wise - MIS" Google Sheet (Team Callback MIS), on the Call Desk's own call logs
// (Corefactor + Runo), plus the time each agent spent on customer cards. Data: cd_agent_calls(p_from, p_to).
// Smartflo = Corefactor. Ring time (RNR splits) comes from Corefactor only; without it the split shows NA.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "./supabase.js";
import { Bars, Num, PctBar, Skeleton, reduced } from "./Coach.jsx";

// ------------------------------------------------------------------ settings (as on the sheet's Settings tab)
const DEFAULTS = {
  breakMin: 10, idleMin: 5, shortRnr: 20, veryShortRnr: 10, shortestRnr: 5,
  shiftStart: "", shiftEnd: "", lunchFrom: "", lunchTo: "", lunchMin: 30,
  rnrTarget: 5, flagBreakMin: 60, flagShortShare: 25,
  names: "",   // "number name" per line: names for Corefactor agent numbers the dashboard can't match by itself
};
const nameList = (txt) => Object.fromEntries((txt || "").split(/\n/).map((l) => l.trim().match(/^(\+?[0-9 -]{10,}?)\s*[=:,-]?\s+(.+)$/)).filter(Boolean)
  .map((m) => [m[1].replace(/\D/g, "").slice(-10), m[2].trim()]));
function useSettings() {
  const [s, setS] = useState(() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("cd_mis_settings") || "{}") }; } catch { return DEFAULTS; } });
  const save = (n) => { setS(n); try { localStorage.setItem("cd_mis_settings", JSON.stringify(n)); } catch { /* ignore */ } };
  return [s, save];
}

// ------------------------------------------------------------------ helpers
const N = (x) => Number(x || 0).toLocaleString("en-IN");
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const ms = (s) => Date.parse(s + "Z");                                  // IST wall clock, read as UTC on purpose
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const hm = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const hms = (sec) => { sec = Math.round(sec); return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`; };
const minOf = (hhmmStr) => { if (!hhmmStr) return null; const [h, m] = hhmmStr.split(":").map(Number); return h * 60 + m; };
const dayMin = (t) => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const longDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null);
const keyName = (s) => (s || "").trim().toLowerCase();
const ringN = (r, v) => (r.ringKnown ? N(v) : "NA");                    // RNR ring-time splits: Corefactor only

// ------------------------------------------------------------------ the sheet's rules
function parse(d, names = {}) {
  const calls = (d?.calls || []).map(([agent, at, dir, ans, dur, talk, status, src, isNew, phone]) => {
    const t = ms(at);
    return { agent: (agent || "").trim(), day: at.slice(0, 10), t, end: t + (dur || 0) * 1000, dir, ans: !!ans, dur: dur || 0, talk: talk ?? (ans ? dur || 0 : 0),
      agentMiss: /\(agent\)/i.test(status || ""), ringKnown: src === "Corefactor", isNew: !!isNew, phone };
  });
  const cards = (d?.cards || []).map(([agent, o, c, warned, open, phone]) => ({ agent: (agent || "").trim(), day: o.slice(0, 10), t: ms(o), end: ms(c), warned, open, phone }));
  // Corefactor webhook calls carry the agent's NUMBER, not the name. Learn number -> agent from customer cards:
  // the agent opens a customer and a call from that number to the customer's phone follows.
  const isNum = (a) => /^\+?[0-9 -]{10,}$/.test(a);
  const byPhone = {};
  cards.forEach((k) => { if (k.phone) (byPhone[k.phone] = byPhone[k.phone] || []).push(k); });
  const votes = {};
  calls.forEach((c) => {
    if (!isNum(c.agent) || c.dir !== "out") return;
    const k = (byPhone[c.phone] || []).find((x) => c.t >= x.t - 60000 && c.t <= x.end + 60000);
    if (!k) return;
    const v = (votes[c.agent] = votes[c.agent] || {});
    v[k.agent] = (v[k.agent] || 0) + 1;
  });
  const learned = {};
  Object.entries(votes).forEach(([num, v]) => {
    const tot = Object.values(v).reduce((a, b) => a + b, 0);
    const [name, hits] = Object.entries(v).sort((a, b) => b[1] - a[1])[0];
    if (hits >= 3 && hits / tot >= 0.8) learned[num] = name;
  });
  calls.forEach((c) => {
    const typed = isNum(c.agent) && names[c.agent.replace(/\D/g, "").slice(-10)];
    const nm = typed || learned[c.agent];
    if (nm) { c.number = c.agent; c.agent = nm; }
  });
  const unmatched = [...new Set(calls.filter((c) => isNum(c.agent)).map((c) => c.agent))];
  return { calls, cards, learned, unmatched };
}

// one agent (or the whole team) for a set of calls + cards
function stats(calls, cards, S, { day, loadedTo } = {}) {
  const out = calls.filter((c) => c.dir === "out");
  const work = calls.filter((c) => c.dir === "out" || (c.dir === "in" && c.ans)).sort((a, b) => a.t - b.t);
  const r = { calls: out.length, leads: new Set(out.map((c) => c.phone)).size, answered: out.filter((c) => c.ans).length,
    talk: work.reduce((s, c) => s + (c.talk || 0), 0), calling: work.reduce((s, c) => s + c.dur, 0),
    newLeads: calls.filter((c) => c.isNew).length, agentMiss: calls.filter((c) => c.agentMiss).length, inAnswered: calls.filter((c) => c.dir === "in" && c.ans).length };
  r.connectPct = pct(r.answered, r.calls);
  // RNR: outbound, customer didn't answer; ring splits only where the ring time is known (Corefactor)
  const rnr = out.filter((c) => !c.ans && !c.agentMiss);
  const ring = rnr.filter((c) => c.ringKnown);
  r.rnr = rnr.length;
  r.rnr20 = ring.filter((c) => c.dur < S.shortRnr).length;
  r.rnr10 = ring.filter((c) => c.dur < S.veryShortRnr).length;
  r.rnr5 = ring.filter((c) => c.dur < S.shortestRnr).length;
  r.ringKnown = ring.length;
  r.shortShare = pct(r.rnr20, ring.length);
  // RNR follow-up: an RNR lead should get S.rnrTarget calls the same day
  const rnrLeads = new Set(rnr.map((c) => c.phone));
  const perPhone = {}; out.forEach((c) => { perPhone[c.phone] = (perPhone[c.phone] || 0) + 1; });
  r.rnrLeads = rnrLeads.size;
  r.rnrFollowed = [...rnrLeads].filter((p) => perPhone[p] >= S.rnrTarget).length;
  // activity span and breaks (gaps between one call ending and the next starting)
  r.breaks = []; r.idle = [];
  if (work.length) {
    r.first = work[0].t; r.last = Math.max(...work.map((c) => c.end)); r.span = (r.last - r.first) / 1000;
    let endSoFar = work[0].end;
    for (let i = 1; i < work.length; i++) {
      const gap = (work[i].t - endSoFar) / 60000;
      if (gap >= S.breakMin) r.breaks.push({ from: endSoFar, to: work[i].t, min: gap });
      else if (gap >= S.idleMin) r.idle.push({ from: endSoFar, to: work[i].t, min: gap });
      endSoFar = Math.max(endSoFar, work[i].end);
    }
  }
  const lf = minOf(S.lunchFrom), lt = minOf(S.lunchTo);
  if (lf !== null && lt !== null) {
    const lunch = r.breaks.filter((b) => b.min >= S.lunchMin && dayMin(b.from) >= lf && dayMin(b.from) <= lt).sort((a, b) => b.min - a.min)[0];
    if (lunch) lunch.lunch = true;
  }
  r.breakMin = r.breaks.reduce((s, b) => s + b.min, 0);
  r.lunchMin = r.breaks.filter((b) => b.lunch).reduce((s, b) => s + b.min, 0);
  r.breakExLunch = r.breakMin - r.lunchMin;
  r.longestBreak = r.breaks.reduce((m, b) => Math.max(m, b.min), 0);
  r.breakPctSpan = r.span ? pct(r.breakMin * 60, r.span) : null;
  r.idleMin = r.idle.reduce((s, b) => s + b.min, 0);
  const ss = minOf(S.shiftStart), se = minOf(S.shiftEnd);
  r.late = ss !== null && r.first ? Math.max(0, dayMin(r.first) - ss) : null;
  const complete = day && loadedTo && loadedTo.slice(0, 10) > day;
  r.early = se !== null && r.last && complete ? Math.max(0, se - dayMin(r.last)) : null;
  // time on customer cards
  r.cards = cards.length;
  r.cardSec = cards.reduce((s, c) => s + Math.max(0, (c.end - c.t) / 1000), 0);
  r.cardAvg = cards.length ? r.cardSec / cards.length : 0;
  r.cardLongest = cards.reduce((m, c) => Math.max(m, (c.end - c.t) / 1000), 0);
  r.cardWarn = cards.filter((c) => c.warned).length;
  r.cardOpen = cards.filter((c) => c.open).length;
  r.flagBreak = r.breakExLunch > S.flagBreakMin;
  r.flagShort = r.shortShare !== null && r.shortShare > S.flagShortShare;
  return r;
}

function dayStatus(day, loadedTo) {
  if (!loadedTo) return { tone: "grey", text: "No calls loaded yet" };
  const ld = loadedTo.slice(0, 10);
  if (ld < day) return { tone: "grey", text: `No calls for this day yet (latest call ${shortDay(ld)} ${loadedTo.slice(11, 16)})` };
  if (ld === day) return { tone: "amber", text: `Partial — calls up to ${loadedTo.slice(11, 16)}` };
  return { tone: "green", text: "Complete" };
}

// ------------------------------------------------------------------ data
function useCalls(from, to) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true; setD(null); setErr("");
    rpc("cd_agent_calls", { p_from: from, p_to: to }).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [from, to, n]);
  return [d, err, () => setN((x) => x + 1)];
}
const groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] = m[k] || []).push(x); return m; }, {});
function displayNames(calls, cards) {
  const m = {};
  calls.forEach((c) => { m[keyName(c.agent)] = m[keyName(c.agent)] || c.agent; });
  cards.forEach((c) => { m[keyName(c.agent)] = m[keyName(c.agent)] || c.agent; });
  return m;
}

// ------------------------------------------------------------------ page
// only our agents: people on the Agents list (role agent, not deleted). Names are compared without case, spaces or dots.
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function AgentDashboard({ day, setDay, agents = [] }) {
  const [S, setS] = useSettings();
  const [view, setView] = useState("day");
  const [who, setWho] = useState("");
  const [showSet, setShowSet] = useState(false);
  const t = todayIST();
  const salaryStart = (() => { const [y, m, d] = t.split("-").map(Number); return new Date(Date.UTC(y, d >= 21 ? m - 1 : m - 2, 21)).toISOString().slice(0, 10); })();
  const [rf, setRf] = useState(addDays(t, -6));
  const [rt, setRt] = useState(t);
  const from = view === "range" ? rf : day, to = view === "range" ? rt : day;
  const [d, err, reload] = useCalls(from, to);
  const ours = useMemo(() => Object.fromEntries(agents.filter((a) => a.role === "agent").map((a) => [norm(a.name), a.name])), [agents]);
  const raw = useMemo(() => parse(d, nameList(S.names)), [d, S.names]);
  // keep only our agents, and show them by the name on the Agents list
  const P = useMemo(() => {
    if (!agents.length) return { ...raw, calls: [], cards: [], hidden: [] };
    const own = (x) => { const n = ours[norm(x.agent)]; return n ? { ...x, agent: n } : null; };
    const calls = raw.calls.map(own).filter(Boolean), cards = raw.cards.map(own).filter(Boolean);
    const hidden = [...new Set([...raw.calls, ...raw.cards].filter((x) => !ours[norm(x.agent)]).map((x) => x.agent))];
    return { ...raw, calls, cards, hidden };
  }, [raw, ours, agents.length]);
  const names = useMemo(() => displayNames(P.calls, P.cards), [P]);
  const agentKeys = Object.keys(names).sort((a, b) => names[a].localeCompare(names[b]));

  return (
    <div className="page hp hp-fade mis">
      <div className="page-head">
        <h2>Agent dashboard</h2>
        <div className="mis-ctl">
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {agentKeys.map((k) => <option key={k} value={k}>{names[k]}</option>)}
          </select>
          <button className="ghost" onClick={reload} title="Load again">↻ Refresh</button>
          <button className={showSet ? "" : "ghost"} onClick={() => setShowSet((v) => !v)}>⚙ Settings</button>
        </div>
      </div>
      <div className="hp-tabs">
        {[["day", "Day"], ["range", "Range summary"], ["hourly", "Hourly"]].map(([k, v]) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{v}</button>)}
      </div>
      {showSet && <SettingsPanel S={S} setS={setS} close={() => setShowSet(false)} />}

      {view !== "range" && (
        <div className="mis-date">
          <button className="ghost" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</button>
          <input type="date" value={day} max={t} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="ghost" onClick={() => setDay(addDays(day, 1))} disabled={day >= t} aria-label="Next day">›</button>
          {day !== t && <button className="link" onClick={() => setDay(t)}>Today</button>}
          <span className="mis-daylabel">{longDay(day)}</span>
          {d && <span className={`mis-pill ${dayStatus(day, d.loaded_to).tone}`}>{dayStatus(day, d.loaded_to).text}</span>}
        </div>
      )}
      {view === "range" && (
        <div className="mis-date">
          <input type="date" value={rf} max={rt} onChange={(e) => e.target.value && setRf(e.target.value)} aria-label="From" />
          <span className="muted">to</span>
          <input type="date" value={rt} min={rf} max={t} onChange={(e) => e.target.value && setRt(e.target.value)} aria-label="To" />
          <div className="hp-tabs inline">
            {[["Last 7 days", addDays(t, -6)], ["Last 14 days", addDays(t, -13)], ["This salary month", salaryStart]].map(([l, f]) => (
              <button key={l} className={rf === f && rt === t ? "on" : ""} onClick={() => { setRf(f); setRt(t); }}>{l}</button>
            ))}
          </div>
        </div>
      )}

      {err && <p className="note warn">{err}</p>}
      {(!d || !agents.length) && !err && <Skeleton rows={6} />}
      {d && agents.length > 0 && view === "day" && <DayView P={P} names={names} who={who} setWho={setWho} S={S} day={day} loadedTo={d.loaded_to} />}
      {d && agents.length > 0 && view === "range" && <RangeView P={P} names={names} who={who} S={S} />}
      {d && agents.length > 0 && view === "hourly" && <HourlyView P={P} names={names} who={who} S={S} />}

      <details className="mis-how">
        <summary>How it counts</summary>
        <ul>
          <li><b>Break</b> = a gap of {S.breakMin}+ min between one call ending and the next starting (answered incoming calls count as work). Gaps of {S.idleMin}–{S.breakMin} min are idle gaps.</li>
          <li><b>RNR</b> = an outbound call the customer didn’t answer. Ring time = Corefactor (Smartflo) “Total Time”. The splits below {S.shortRnr}, {S.veryShortRnr} and {S.shortestRnr} seconds count Corefactor calls only; where there is no Corefactor ring time they show <b>NA</b>.</li>
          <li><b>Agent didn’t pick up</b> = “Unanswered (Agent)” / “Unreachable (Agent)”: the call never reached the customer. Counted separately, not as RNR.</li>
          <li><b>Calling time</b> = ring + talk time of every outbound call and answered incoming call. <b>Connect %</b> = answered ÷ outbound calls.</li>
          <li><b>Agent names</b>: Corefactor (Smartflo) sends the agent’s number. The dashboard matches a number to an agent when that agent opened the customer in the Call Desk just before the call (at least 3 calls, 80% agreement). Numbers that can’t be matched are shown as numbers.</li>
          <li><b>New lead</b> = the first outbound call ever made to that number in the Call Desk’s call history.</li>
          <li><b>Time on customers</b> = how long the agent kept each customer open in the Call Desk (from opening the customer until they open the next one or leave the page; a card left open more than 3 hours counts as 3 hours).</li>
          <li>Red = break time without lunch over {S.flagBreakMin} min, or more than {S.flagShortShare}% of RNR calls under {S.shortRnr} seconds.</li>
        </ul>
      </details>
    </div>
  );
}

function SettingsPanel({ S, setS, close }) {
  const [f, setF] = useState(S);
  const num = (k, label, unit) => <label>{label}<span className="mis-in"><input type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />{unit}</span></label>;
  const time = (k, label) => <label>{label}<input type="time" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <div className="hp-card mis-set">
      <h3 className="hp-h">Settings <span className="muted small">(saved on this computer)</span></h3>
      <div className="mis-setgrid">
        {num("breakMin", "Break = gap of at least", "min")}{num("idleMin", "Short idle gap from", "min")}
        {num("shortRnr", "Short RNR = ring under", "sec")}{num("veryShortRnr", "Very short RNR = under", "sec")}{num("shortestRnr", "Shortest RNR = under", "sec")}
        {time("shiftStart", "Shift starts (late start)")}{time("shiftEnd", "Shift ends (early finish)")}
        {time("lunchFrom", "Lunch window starts")}{time("lunchTo", "Lunch window ends")}{num("lunchMin", "Lunch = break of at least", "min")}
        {num("rnrTarget", "RNR follow-up target", "calls")}{num("flagBreakMin", "Flag break time over", "min")}{num("flagShortShare", "Flag short-RNR share over", "%")}
      </div>
      <label className="mis-names">Names for agent numbers <span className="muted small">one per line, e.g. <code>9876543210 Priya</code> (for numbers shown instead of a name)</span>
        <textarea rows={4} value={f.names} onChange={(e) => setF({ ...f, names: e.target.value })} placeholder="9876543210 Priya" /></label>
      <div className="actions"><button className="primary" onClick={() => { setS(f); close(); }}>Save</button><button className="link" onClick={() => setF({ ...DEFAULTS, names: f.names })}>Back to the sheet’s settings</button><button className="link" onClick={close}>Cancel</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Day
function DayView({ P, names, who, setWho, S, day, loadedTo }) {
  const [open, setOpen] = useState(null);
  const [sort, setSort] = useState({ k: "calls", d: -1 });
  const calls = P.calls.filter((c) => c.day === day), cards = P.cards.filter((c) => c.day === day);
  const byC = groupBy(calls, (c) => keyName(c.agent)), byK = groupBy(cards, (c) => keyName(c.agent));
  const keys = [...new Set([...Object.keys(byC), ...Object.keys(byK)])].filter((k) => !who || k === who);
  const rows = keys.map((k) => ({ k, name: names[k] || k, ...stats(byC[k] || [], byK[k] || [], S, { day, loadedTo }) }));
  const team = stats(keys.flatMap((k) => byC[k] || []), keys.flatMap((k) => byK[k] || []), S, {});
  const sorted = [...rows].sort((a, b) => sort.d * ((a[sort.k] ?? -1) - (b[sort.k] ?? -1)) || a.name.localeCompare(b.name));
  const th = (k, l, cls = "") => <th className={"sortable " + cls + (sort.k === k ? " on" : "")} onClick={() => setSort((s) => ({ k, d: s.k === k ? -s.d : -1 }))}>{l}{sort.k === k ? (sort.d < 0 ? " ↓" : " ↑") : ""}</th>;
  const focus = who || open;
  if (!rows.length) return <div className="hp-soon"><span className="hp-soon-tag">No activity</span><p>No calls or customers opened on {longDay(day)}{who ? ` by ${names[who]}` : ""}.</p></div>;
  return (
    <>
      <div className="hp-tiles mis-tiles">
        <div className="hp-tile"><b><Num v={team.calls} /></b><span>outbound calls · {N(team.leads)} leads</span></div>
        <div className="hp-tile"><b><Num v={team.answered} /></b><span>answered · {team.connectPct ?? "–"}% connect</span></div>
        <div className="hp-tile"><b>{hm(team.talk)}</b><span>talk time (h:mm)</span></div>
        <div className="hp-tile"><b><Num v={Math.round(team.breakMin)} /> min</b><span>break time · {team.breaks.length} breaks</span></div>
        <div className="hp-tile"><b><Num v={team.rnr} /></b><span>RNR · {team.ringKnown ? `${N(team.rnr20)} under ${S.shortRnr}s` : "ring time NA"}</span></div>
        <div className="hp-tile"><b>{hm(team.cardSec)}</b><span>time on customers · {N(team.cards)} opened</span></div>
      </div>

      {!who && (
        <div className="hp-card">
          <div className="hp-card-head"><h3 className="hp-h">Agents side by side</h3><span className="muted small">Click an agent for their day. Red = needs a look.</span></div>
          <div className="hp-sc">
            <table className="hp-t mis-t">
              <thead>
                <tr className="grp"><th /><th colSpan={4}>Activity</th><th colSpan={4}>Calls</th><th colSpan={3}>Breaks</th><th colSpan={3}>RNR</th><th colSpan={3}>Time on customers</th></tr>
                <tr><th>Agent</th>{th("first", "First call")}{th("last", "Last ended")}{th("span", "Active")}{th("late", "Late start")}
                  {th("calls", "Outbound")}{th("leads", "Leads")}{th("connectPct", "Connect %")}{th("talk", "Talk")}
                  {th("breaks", "No.")}{th("breakExLunch", "Min (ex lunch)")}{th("longestBreak", "Longest")}
                  {th("rnr", "RNR")}{th("shortShare", `<${S.shortRnr}s share`)}{th("agentMiss", "Didn’t pick up")}
                  {th("cards", "Opened")}{th("cardSec", "Time")}{th("cardWarn", "12-min warnings")}</tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.k} className={"click" + (open === r.k ? " sel" : "")} onClick={() => setOpen(open === r.k ? null : r.k)}>
                    <td><b>{r.name}</b></td>
                    <td>{r.first ? hhmm(r.first) : "—"}</td><td>{r.last ? hhmm(r.last) : "—"}</td><td>{r.span ? hm(r.span) : "—"}</td><td>{r.late ?? "—"}</td>
                    <td>{N(r.calls)}</td><td>{N(r.leads)}</td><td><PctBar v={r.answered} d={r.calls} /></td><td>{hm(r.talk)}</td>
                    <td>{r.breaks.length}</td><td className={r.flagBreak ? "flag" : ""}>{Math.round(r.breakExLunch)}</td><td>{Math.round(r.longestBreak) || "—"}</td>
                    <td>{N(r.rnr)}</td><td className={r.flagShort ? "flag" : ""}>{r.shortShare === null ? <span className="muted">NA</span> : `${Math.round(r.shortShare)}%`}</td><td>{N(r.agentMiss)}</td>
                    <td>{N(r.cards)}</td><td>{r.cards ? hm(r.cardSec) : "—"}</td><td className={r.cardWarn ? "flag" : ""}>{r.cardWarn || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {P.hidden?.length > 0 && !who && (
        <details className="mis-hidden"><summary>Only agents on the Agents list are shown · {P.hidden.length} other caller{P.hidden.length === 1 ? "" : "s"} hidden</summary>
          <p className="muted small">Not on the Agents list (or the name differs): {P.hidden.slice(0, 40).join(", ")}{P.hidden.length > 40 ? " …" : ""}. Corefactor numbers belong to agents who didn’t open customers in the Call Desk; give them a name under ⚙ Settings (use the name exactly as on the Agents list) and they will show.</p>
        </details>
      )}
      {focus && <AgentDay k={focus} name={names[focus] || focus} calls={byC[focus] || []} cards={byK[focus] || []} S={S} day={day} loadedTo={loadedTo} onClose={who ? null : () => setOpen(null)} />}
      {!focus && <p className="muted small">Tip: pick one agent above (or click a row) to see their timeline, break timings and customers.</p>}
    </>
  );
}

function Stat({ l, v, flag, sub }) {
  return <div className={"mis-stat" + (flag ? " flag" : "")}><span>{l}</span><b>{v}</b>{sub && <small>{sub}</small>}</div>;
}

function AgentDay({ k, name, calls, cards, S, day, loadedTo, onClose }) {
  const r = stats(calls, cards, S, { day, loadedTo });
  const longCards = [...cards].sort((a, b) => (b.end - b.t) - (a.end - a.t)).slice(0, 8);
  return (
    <div className="hp-card mis-agent" id={`mis-${k}`}>
      <div className="hp-card-head">
        <h3 className="hp-h">{name} · {longDay(day)}</h3>
        {onClose && <button className="link" onClick={onClose}>Close ✕</button>}
      </div>
      <Timeline calls={calls} cards={cards} breaks={r.breaks} day={day} />
      <div className="mis-groups">
        <div className="mis-group"><h4>Activity</h4>
          <Stat l="First call" v={r.first ? hhmm(r.first) : "—"} /><Stat l="Last call ended" v={r.last ? hhmm(r.last) : "—"} />
          <Stat l="Active span" v={r.span ? hm(r.span) : "—"} /><Stat l="Late start" v={r.late === null ? "—" : `${r.late} min`} sub={S.shiftStart ? `shift ${S.shiftStart}` : "set shift in Settings"} />
          <Stat l="Early finish" v={r.early === null ? "—" : `${r.early} min`} sub={S.shiftEnd ? `shift ${S.shiftEnd}` : "set shift in Settings"} />
          <Stat l="Outbound calls" v={N(r.calls)} /><Stat l="Leads called" v={N(r.leads)} /><Stat l="Answered" v={N(r.answered)} />
          <Stat l="Connect %" v={r.connectPct === null ? "—" : `${r.connectPct}%`} /><Stat l="Talk time" v={hms(r.talk)} /><Stat l="Calling time" v={hms(r.calling)} />
          <Stat l="Incoming answered" v={N(r.inAnswered)} /><Stat l="New leads" v={N(r.newLeads)} />
        </div>
        <div className="mis-group"><h4>Breaks</h4>
          <Stat l="Number of breaks" v={r.breaks.length} /><Stat l="Total break time" v={`${Math.round(r.breakMin)} min`} />
          <Stat l="…of which lunch" v={`${Math.round(r.lunchMin)} min`} sub={S.lunchFrom ? `${S.lunchFrom}–${S.lunchTo}` : "set lunch window in Settings"} />
          <Stat l="Break time excluding lunch" v={`${Math.round(r.breakExLunch)} min`} flag={r.flagBreak} /><Stat l="Longest break" v={`${Math.round(r.longestBreak)} min`} />
          <Stat l="Break time as % of active span" v={r.breakPctSpan === null ? "—" : `${r.breakPctSpan}%`} /><Stat l="Idle gaps (count / min)" v={`${r.idle.length} / ${Math.round(r.idleMin)}`} />
        </div>
        <div className="mis-group"><h4>RNR &amp; follow-up</h4>
          <Stat l="RNR calls" v={N(r.rnr)} /><Stat l={`Below ${S.shortRnr} seconds`} v={ringN(r, r.rnr20)} sub={r.ringKnown ? `${Math.round(r.shortShare)}% of ${N(r.ringKnown)} Corefactor RNR calls` : "no Corefactor ring time"} flag={r.flagShort} />
          <Stat l={`Below ${S.veryShortRnr} seconds`} v={ringN(r, r.rnr10)} /><Stat l={`Below ${S.shortestRnr} seconds`} v={ringN(r, r.rnr5)} />
          <Stat l="Agent didn’t pick up" v={N(r.agentMiss)} sub="call never reached the customer" />
          <Stat l={`RNR leads called ${S.rnrTarget}+ times`} v={`${r.rnrFollowed} of ${r.rnrLeads}`} />
        </div>
        <div className="mis-group cust"><h4>Time on customers</h4>
          <Stat l="Customers opened" v={N(r.cards)} /><Stat l="Total time" v={hms(r.cardSec)} /><Stat l="Average per customer" v={r.cards ? `${(r.cardAvg / 60).toFixed(1)} min` : "—"} />
          <Stat l="Longest" v={r.cards ? `${(r.cardLongest / 60).toFixed(1)} min` : "—"} /><Stat l="12-minute warnings" v={r.cardWarn} flag={r.cardWarn > 0} />
          <Stat l="Time on customers vs talk time" v={r.talk ? `${(r.cardSec / r.talk).toFixed(1)}×` : "—"} sub="how long cards stay open per minute of talk" />
        </div>
      </div>
      <div className="mis-two">
        <div>
          <h4 className="mis-h4">Break timings — gaps of {S.breakMin}+ min between calls</h4>
          <table className="hp-t mis-small"><thead><tr><th>From (call ended)</th><th>To (next call)</th><th>Min</th><th>Note</th></tr></thead>
            <tbody>{r.breaks.length ? r.breaks.map((b, i) => <tr key={i} className={b.lunch ? "" : b.min >= 30 ? "warnrow" : ""}><td>{hhmm(b.from)}</td><td>{hhmm(b.to)}</td><td>{b.min.toFixed(1)}</td><td>{b.lunch ? "Lunch" : ""}</td></tr>) : <tr><td colSpan={4} className="muted">No breaks</td></tr>}</tbody>
          </table>
        </div>
        <div>
          <h4 className="mis-h4">Longest time on a customer</h4>
          <table className="hp-t mis-small"><thead><tr><th>Opened</th><th>Closed</th><th>Min</th><th /></tr></thead>
            <tbody>{longCards.length ? longCards.map((c, i) => <tr key={i}><td>{hhmm(c.t)}</td><td>{c.open ? "still open" : hhmm(c.end)}</td><td>{((c.end - c.t) / 60000).toFixed(1)}</td><td>{c.warned ? <span className="mis-pill red">12-min warning</span> : ""}</td></tr>) : <tr><td colSpan={4} className="muted">No customers opened in the Call Desk</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// the agent's day on one line: calls, breaks and time on customers
function Timeline({ calls, cards, breaks, day }) {
  const [tip, setTip] = useState(null);
  const box = useRef(null);
  const all = [...calls.map((c) => c.t), ...cards.map((c) => c.t)];
  if (!all.length) return null;
  const d0 = ms(day + "T00:00:00");
  const startH = Math.max(0, Math.min(8, Math.floor((Math.min(...all) - d0) / 36e5)));
  const endH = Math.min(24, Math.max(20, Math.ceil((Math.max(...calls.map((c) => c.end), ...cards.map((c) => c.end)) - d0) / 36e5)));
  const x = (t) => ((t - d0) / 36e5 - startH) / (endH - startH) * 100;
  const hours = []; for (let h = startH; h <= endH; h++) hours.push(h);
  const show = (e, text) => { const r = box.current?.getBoundingClientRect(); if (r) setTip({ x: Math.min(Math.max(e.clientX - r.left, 120), r.width - 120), text }); };
  return (
    <div className="mis-tl" ref={box} onMouseLeave={() => setTip(null)}>
      <div className="mis-tl-row"><span className="mis-tl-l">Customers</span><div className="mis-tl-track">
        {cards.map((c, i) => <i key={i} className={"cardseg" + (c.warned ? " warn" : "")} style={{ left: `${x(c.t)}%`, width: `${Math.max(0.25, x(c.end) - x(c.t))}%` }}
          onMouseMove={(e) => show(e, `Customer open ${hhmm(c.t)}–${c.open ? "now" : hhmm(c.end)} · ${((c.end - c.t) / 60000).toFixed(1)} min${c.warned ? " · 12-min warning" : ""}`)} />)}
      </div></div>
      <div className="mis-tl-row"><span className="mis-tl-l">Calls</span><div className="mis-tl-track">
        {breaks.map((b, i) => <i key={"b" + i} className={"brk" + (b.lunch ? " lunch" : "")} style={{ left: `${x(b.from)}%`, width: `${x(b.to) - x(b.from)}%` }}
          onMouseMove={(e) => show(e, `${b.lunch ? "Lunch" : "Break"} ${hhmm(b.from)}–${hhmm(b.to)} · ${Math.round(b.min)} min`)} />)}
        {calls.map((c, i) => <i key={i} className={"tcall " + (c.ans ? "ans" : c.agentMiss ? "miss" : c.dir === "out" ? "rnr" : "in")} style={{ left: `${x(c.t)}%`, width: `${Math.max(0.12, x(c.end) - x(c.t))}%` }}
          onMouseMove={(e) => show(e, `${hhmm(c.t)} · ${c.dir === "out" ? "outbound" : "incoming"} · ${c.ans ? `answered, talk ${hms(c.talk)}` : c.agentMiss ? "agent didn’t pick up" : `not answered, rang ${c.dur}s`}`)} />)}
      </div></div>
      <div className="mis-tl-axis">{hours.map((h) => <span key={h} style={{ left: `${(h - startH) / (endH - startH) * 100}%` }}>{h}:00</span>)}</div>
      <div className="mis-tl-key"><span><i className="tcall ans" />answered</span><span><i className="tcall rnr" />RNR</span><span><i className="tcall miss" />agent didn’t pick up</span><span><i className="brk" />break</span><span><i className="cardseg" />customer open</span></div>
      {tip && <div className="mis-tl-tip" style={{ left: tip.x }}>{tip.text}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Range summary
function RangeView({ P, names, who, S }) {
  const [sort, setSort] = useState({ k: "calls", d: -1 });
  const byC = groupBy(P.calls, (c) => keyName(c.agent)), byK = groupBy(P.cards, (c) => keyName(c.agent));
  const keys = [...new Set([...Object.keys(byC), ...Object.keys(byK)])].filter((k) => !who || k === who);
  // breaks are counted day by day, then added up
  const rows = keys.map((k) => {
    const cd = groupBy(byC[k] || [], (c) => c.day), kd = groupBy(byK[k] || [], (c) => c.day);
    const days = [...new Set([...Object.keys(cd), ...Object.keys(kd)])];
    const per = days.map((dd) => stats(cd[dd] || [], kd[dd] || [], S, {}));
    const all = stats(byC[k] || [], byK[k] || [], S, {});
    return { k, name: names[k] || k, days: days.length, ...all, breakMin: per.reduce((s, x) => s + x.breakMin, 0), nBreaks: per.reduce((s, x) => s + x.breaks.length, 0) };
  });
  const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const sorted = [...rows].sort((a, b) => sort.d * ((a[sort.k] ?? -1) - (b[sort.k] ?? -1)) || a.name.localeCompare(b.name));
  const th = (k, l) => <th className={"sortable" + (sort.k === k ? " on" : "")} onClick={() => setSort((s) => ({ k, d: s.k === k ? -s.d : -1 }))}>{l}{sort.k === k ? (sort.d < 0 ? " ↓" : " ↑") : ""}</th>;
  const T = { calls: sum("calls"), answered: sum("answered") };
  return (
    <>
      <div className="hp-tiles mis-tiles">
        <div className="hp-tile"><b><Num v={T.calls} /></b><span>outbound calls</span></div>
        <div className="hp-tile"><b><Num v={T.answered} /></b><span>connected · {pct(T.answered, T.calls) ?? "–"}%</span></div>
        <div className="hp-tile"><b>{hm(sum("talk"))}</b><span>talk time (h:mm)</span></div>
        <div className="hp-tile"><b><Num v={Math.round(sum("breakMin"))} /> min</b><span>break time</span></div>
        <div className="hp-tile"><b><Num v={sum("rnr")} /></b><span>RNR calls</span></div>
        <div className="hp-tile"><b>{hm(sum("cardSec"))}</b><span>time on customers</span></div>
      </div>
      <div className="hp-card">
        <h3 className="hp-h">Agent-wise totals</h3>
        <div className="hp-sc">
          <table className="hp-t mis-t">
            <thead><tr><th>Agent</th>{th("days", "Days")}{th("breakMin", "Break (min)")}<th>Break (h:mm)</th>{th("calling", "Calling time")}{th("talk", "Talk time")}
              {th("calls", "Calls made")}{th("answered", "Connected")}{th("connectPct", "Connected %")}{th("rnr", "RNR")}{th("rnr20", `<${S.shortRnr}s`)}{th("rnr10", `<${S.veryShortRnr}s`)}{th("rnr5", `<${S.shortestRnr}s`)}
              {th("newLeads", "New leads")}{th("cards", "Customers opened")}{th("cardSec", "Time on customers")}</tr></thead>
            <tbody>
              <tr className="tot"><td>Total</td><td /><td>{N(Math.round(sum("breakMin")))}</td><td>{hm(sum("breakMin") * 60)}</td><td>{hm(sum("calling"))}</td><td>{hm(sum("talk"))}</td>
                <td>{N(T.calls)}</td><td>{N(T.answered)}</td><td><PctBar v={T.answered} d={T.calls} /></td><td>{N(sum("rnr"))}</td><td>{sum("ringKnown") ? N(sum("rnr20")) : "NA"}</td><td>{sum("ringKnown") ? N(sum("rnr10")) : "NA"}</td><td>{sum("ringKnown") ? N(sum("rnr5")) : "NA"}</td>
                <td>{N(sum("newLeads"))}</td><td>{N(sum("cards"))}</td><td>{hm(sum("cardSec"))}</td></tr>
              {sorted.map((r) => (
                <tr key={r.k}><td><b>{r.name}</b></td><td>{r.days}</td><td>{N(Math.round(r.breakMin))}</td><td>{hm(r.breakMin * 60)}</td><td>{hm(r.calling)}</td><td>{hm(r.talk)}</td>
                  <td>{N(r.calls)}</td><td>{N(r.answered)}</td><td><PctBar v={r.answered} d={r.calls} /></td><td>{N(r.rnr)}</td><td>{ringN(r, r.rnr20)}</td><td>{ringN(r, r.rnr10)}</td><td>{ringN(r, r.rnr5)}</td>
                  <td>{N(r.newLeads)}</td><td>{N(r.cards)}</td><td>{r.cards ? hm(r.cardSec) : "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Break time is worked out day by day and added up. Times are h:mm.</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Hourly
function HourlyView({ P, names, who, S }) {
  const [metric, setMetric] = useState("calls");
  const [hover, setHover] = useState(null);
  const calls = P.calls.filter((c) => !who || keyName(c.agent) === who), cards = P.cards.filter((c) => !who || keyName(c.agent) === who);
  const hrs = {};
  const H = (h) => (hrs[h] = hrs[h] || { h, calls: 0, connected: 0, rnr: 0, miss: 0, newLeads: 0, cardMin: 0, agents: {} });
  calls.forEach((c) => {
    const o = H(new Date(c.t).getUTCHours());
    if (c.dir === "out") { o.calls++; o.agents[c.agent] = (o.agents[c.agent] || 0) + 1; if (c.ans) o.connected++; else if (!c.agentMiss) o.rnr++; }
    if (c.agentMiss) o.miss++;
    if (c.isNew) o.newLeads++;
  });
  cards.forEach((c) => { H(new Date(c.t).getUTCHours()).cardMin += (c.end - c.t) / 60000; });
  const list = Object.values(hrs).sort((a, b) => a.h - b.h).map((o) => ({ ...o, pct: o.calls ? Math.round((o.connected * 100) / o.calls) : 0, cardMin: Math.round(o.cardMin) }));
  const agentsAll = [...new Set(calls.filter((c) => c.dir === "out").map((c) => c.agent))].sort();
  const M = [["calls", "Calls made"], ["connected", "Connected"], ["rnr", "RNR"], ["miss", "Agent didn’t pick up"], ["newLeads", "New leads"], ["pct", "Connected %"], ["cardMin", "Minutes on customers"]];
  if (!list.length) return <div className="hp-soon"><span className="hp-soon-tag">No activity</span><p>No calls this day{who ? ` for ${names[who]}` : ""}.</p></div>;
  const lab = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
  return (
    <>
      <div className="hp-card">
        <h3 className="hp-h">Hour by hour {who ? `· ${names[who]}` : "· whole team"}</h3>
        <div className="hp-tabs">{M.map(([k, v]) => <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{v}</button>)}</div>
        <Bars animKey={metric} active={hover} onHover={setHover}
          items={list.map((o) => ({ v: o[metric], unit: metric === "pct" ? "%" : "", l: lab(o.h), full: `${lab(o.h)} – ${lab(o.h + 1)}`,
            sub: `${o.calls} calls · ${o.connected} connected · ${o.rnr} RNR · ${o.newLeads} new leads · ${o.cardMin} min on customers` }))}
          label="Hour of the day · hover for details" />
        <div className="hp-sc">
          <table className="hp-t">
            <thead><tr><th>Hour</th><th>Calls made</th><th>Connected</th><th>RNR</th><th>Agent didn’t pick up</th><th>New leads</th><th>Connected %</th><th>Minutes on customers</th></tr></thead>
            <tbody>{list.map((o, i) => (
              <tr key={o.h} className={hover === i ? "hot" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <td>{lab(o.h)} – {lab(o.h + 1)}</td><td>{o.calls}</td><td>{o.connected}</td><td>{o.rnr}</td><td>{o.miss}</td><td>{o.newLeads}</td><td><PctBar v={o.connected} d={o.calls} /></td><td>{o.cardMin}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
      {!who && agentsAll.length > 0 && (
        <div className="hp-card">
          <h3 className="hp-h">Calls made per agent per hour</h3>
          <div className="hp-sc">
            <table className="hp-t mis-heat">
              <thead><tr><th>Agent</th>{list.map((o) => <th key={o.h}>{lab(o.h)}</th>)}<th>Total</th></tr></thead>
              <tbody>{agentsAll.map((a) => {
                const max = Math.max(1, ...list.map((o) => o.agents[a] || 0));
                return (
                  <tr key={a}><td><b>{a}</b></td>{list.map((o) => { const v = o.agents[a] || 0; return <td key={o.h} style={{ background: v ? `rgba(31,138,112,${0.12 + 0.6 * v / max})` : "transparent", color: v / max > 0.6 ? "#fff" : undefined }}>{v || ""}</td>; })}
                    <td><b>{list.reduce((s, o) => s + (o.agents[a] || 0), 0)}</b></td></tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
