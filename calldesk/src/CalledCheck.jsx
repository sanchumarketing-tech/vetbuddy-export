// Team today (team leads): click an agent's "Marked called" or "Called (logs)" number to see the customers behind it —
// called in the call logs (Corefactor / Runo), marked called in the Call Desk but not in the call logs, and the other way round.
// Data: cd_log (the same rows as the Excel call log), for one agent and one day.
import React, { useEffect, useState } from "react";
import { rpc } from "./supabase.js";

const t12 = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
const phoneFmt = (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);
const clean = (s) => (s || "").replace(/&nbsp;?/gi, " ").replace(/\s*\(\d+\)/g, "").replace(/\s+/g, " ").trim();

export function CalledCheck({ agent, day, start = "logs", onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState(start);
  const [q, setQ] = useState("");
  useEffect(() => {
    rpc("cd_log", { p_from: day, p_to: day, p_agent: agent.id }).then(setRows).catch((e) => setErr(e.message));
  }, [agent.id, day]);
  useEffect(() => { const esc = (e) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]);

  const logs = (rows || []).filter((r) => r.logged_called);
  const marked = (rows || []).filter((r) => r.called_at);
  const markedNoLog = marked.filter((r) => !r.logged_called);
  const logNoMark = logs.filter((r) => !r.called_at);
  const T = { logs: [logs, "Called in call logs"], gap: [markedNoLog, "Marked called · not in call logs"], marked: [marked, "Marked called (all)"], unmarked: [logNoMark, "In call logs · not marked"] };
  const list = (T[tab]?.[0] || []).filter((r) => !q || `${r.client} ${r.phone}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="rules-back" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rules-card cc-card">
        <div className="rules-head">
          <h2 className="cc-title">{agent.name} <span className="muted small">· {new Date(day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span></h2>
          <button className="rules-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {err && <p className="note warn">{err}</p>}
        {!rows && !err && <p className="muted">Loading…</p>}
        {rows && (
          <>
            <div className="cc-sum">
              <button className={"cc-box g" + (tab === "logs" ? " on" : "")} onClick={() => setTab("logs")}><b>{logs.length}</b><span>called in call logs</span><small>Corefactor / Runo</small></button>
              <button className={"cc-box r" + (tab === "gap" ? " on" : "")} onClick={() => setTab("gap")}><b>{markedNoLog.length}</b><span>marked called, not in call logs</span><small>check these</small></button>
              <button className={"cc-box b" + (tab === "marked" ? " on" : "")} onClick={() => setTab("marked")}><b>{marked.length}</b><span>marked called in the Call Desk</span><small>all</small></button>
              <button className={"cc-box a" + (tab === "unmarked" ? " on" : "")} onClick={() => setTab("unmarked")}><b>{logNoMark.length}</b><span>in call logs, not marked</span><small>called but not ticked</small></button>
            </div>
            <div className="cc-bar">
              <b>{T[tab][1]}</b> <span className="muted small">· {list.length} customer{list.length === 1 ? "" : "s"}</span>
              <input placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="hp-sc cc-list">
              <table className="hp-t">
                <thead><tr><th>#</th><th>Customer</th><th>Phone</th><th>Marked called</th><th>In call logs</th><th>Answered</th><th>Last logged call</th><th>Note</th></tr></thead>
                <tbody>
                  {list.length === 0 && <tr><td colSpan={8} className="muted">Nobody here.</td></tr>}
                  {list.map((r, i) => (
                    <tr key={r.id} className={r.called_at && !r.logged_called ? "cc-gap" : ""}>
                      <td className="muted">{i + 1}</td><td>{clean(r.client) || "—"}</td><td className="nowrap">{phoneFmt(r.phone)}</td>
                      <td>{r.called_at ? t12(r.called_at) : <span className="muted">—</span>}</td>
                      <td>{r.logged_called ? <span className="cc-yes">Yes</span> : <span className="cc-no">No</span>}</td>
                      <td>{r.logged_answered ? "Yes" : r.logged_called ? <span className="muted">No</span> : ""}</td>
                      <td className="muted small">{r.last_call || ""}</td><td className="muted small">{r.note || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Same rows as the Excel call log for this agent and day. “In call logs” = a Corefactor or Runo call to that number was found (Corefactor arrives live, Runo each morning).</p>
          </>
        )}
      </div>
    </div>
  );
}
