// Break button (26 Nov 2026). Agents: "Break" in the header; while on break the list and the Call buttons are locked
// behind a break screen, and no 12-minute warning is raised (the open customer is closed when the break starts).
// Team leads: who is on break now, in the alert bar. Data: cd_break(p_action).
import React, { useCallback, useEffect, useState } from "react";
import { rpc } from "./supabase.js";

const t12 = (iso) => (iso ? new Date(iso + (iso.length === 19 ? "+05:30" : "")).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
const mins = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso + (iso.length === 19 ? "+05:30" : "")).getTime()) / 60000)) : 0);

export function useBreak(on) {
  const [b, setB] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (on) rpc("cd_break", { p_action: "status" }).then(setB).catch(() => setB({ on_break: false, error: true })); }, [on]);
  const act = useCallback(async (p_action) => {
    setBusy(true);
    try { setB(await rpc("cd_break", { p_action })); } catch (e) { alert(e.message); }
    setBusy(false);
  }, []);
  return { b, busy, start: () => act("start"), end: () => act("end") };
}

export function BreakButton({ brk }) {
  if (!brk.b || brk.b.error) return null;
  return (
    <button className="brk-btn" onClick={brk.start} disabled={brk.busy || brk.b.on_break} title="Start a break: calls are paused until you end it">
      ☕ Break{brk.b.today_minutes ? <span className="brk-today">{brk.b.today_minutes} min today</span> : null}
    </button>
  );
}

export function BreakScreen({ brk, name }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 20000); return () => clearInterval(t); }, []);
  const m = mins(brk.b.since), total = (brk.b.today_minutes || 0);
  const over = total >= 60;
  return (
    <div className="brk-screen">
      <div className="brk-card">
        <div className="brk-cup">☕</div>
        <h2>You’re on a break{name ? `, ${name.split(/[\s.]+/)[0]}` : ""}</h2>
        <p className="brk-since">Since {t12(brk.b.since)} · <b>{m} min</b></p>
        <p className={"brk-total" + (over ? " over" : "")}>Break time today: <b>{total} min</b> of 60 min allowed</p>
        <p className="muted small">Calls are paused and no warnings are sent while you’re on a break.</p>
        <button className="primary brk-end" onClick={brk.end} disabled={brk.busy}>{brk.busy ? "Ending…" : "End break and resume calls"}</button>
      </div>
    </div>
  );
}

// team leads: who is on break right now
export function BreakBar() {
  const [d, setD] = useState(null);
  const load = useCallback(() => rpc("cd_break", { p_action: "list" }).then(setD).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (!d?.now?.length) return null;
  return (
    <div className="alertbar brk-bar">
      ☕ <strong>On break:</strong> {d.now.map((x) => {
        const today = d.today?.[String(x.agent_id)]?.minutes || 0;
        return <span key={x.agent_id} className={"brk-chip" + (today >= 60 ? " over" : "")}>{x.agent} · {x.minutes} min (since {t12(x.since)}) · {today} min today</span>;
      })}
    </div>
  );
}
