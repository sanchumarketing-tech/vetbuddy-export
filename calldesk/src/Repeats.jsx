// Agents' incentives, team leads only (26 Nov 2026): all appointments, unique pets, and pets the same agent booked
// 5+ times in the salary month (possible target padding), with every booking of those pets. Data: cd_booking_repeats.
import React, { useEffect, useState } from "react";
import { rpc } from "./supabase.js";

export function useRepeats(on, month, agent) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true; setD(null);
    rpc("cd_booking_repeats", { p_month: `${month}-01`, p_agent: agent }).then((r) => { if (live) setD(r); }).catch((e) => { if (live) setD({ error: e.message }); });
    return () => { live = false; };
  }, [on, month, agent]);
  return d;
}

const N = (x) => Number(x || 0).toLocaleString("en-IN");
const fmtD = (iso) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");
const fmtDT = (iso) => (iso ? `${fmtD(iso)} ${iso.slice(11, 16)}` : "");
const phoneFmt = (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);

// the three numbers for one agent (summary row) + the details panel
export function RepeatTiles({ r, min = 5, onOpen }) {
  if (!r) return <div className="rep-tiles"><div className="rep-t muted">Checking bookings…</div></div>;
  if (r.error) return <p className="note warn">{r.error}</p>;
  return (
    <div className="rep-tiles">
      <div className="rep-t"><b>{N(r.appts)}</b><span>appointments booked (all)</span></div>
      <div className="rep-t"><b>{N(r.pets)}</b><span>unique pets</span>{r.appts > r.pets && <small>{N(r.appts - r.pets)} repeat bookings</small>}</div>
      <button className={"rep-t click" + (r.rep_pets ? " bad" : "")} onClick={onOpen} disabled={!r.rep_pets}>
        <b>{N(r.rep_pets)}</b><span>pets booked {min}+ times</span><small>{r.rep_pets ? `${N(r.rep_appts)} bookings · click to see` : "none this month"}</small>
      </button>
    </div>
  );
}

export function RepeatDetails({ rows, min = 5, onClose }) {
  const pets = [];
  (rows || []).forEach((x) => { let p = pets.find((q) => q.pet_id === x.pet_id); if (!p) pets.push(p = { ...x, list: [] }); p.list.push(x); });
  return (
    <div className="rep-panel" id="rep-panel">
      <div className="rep-head">
        <h3>Same pet booked {min}+ times <span className="muted small">· {pets.length} pet{pets.length === 1 ? "" : "s"}, {N(rows?.length)} bookings</span></h3>
        <button className="link" onClick={onClose}>Close ✕</button>
      </div>
      <p className="muted small">Every booking this agent made for these pets in the salary month. Many bookings of one pet can mean the target is being padded; check the dates booked and the statuses.</p>
      {pets.map((p) => (
        <div className="rep-pet" key={p.pet_id}>
          <div className="rep-pet-h">
            <span className="rep-n">{p.n}×</span>
            <div><b>{p.pet || "Pet"}</b> <span className="muted small">#{p.pet_id}</span><div className="muted small">{p.client} · {phoneFmt(p.phone)}</div></div>
          </div>
          <table className="hp-t rep-t-table">
            <thead><tr><th>Booked on</th><th>Appointment</th><th>Type</th><th>Unit</th><th>Status</th><th>Login</th><th>Cancel reason</th></tr></thead>
            <tbody>{p.list.map((x) => (
              <tr key={x.appt_id}><td className="nowrap">{fmtDT(x.booked_at) || "—"}</td><td className="nowrap">{x.appt_time || fmtD(x.appt_date)}</td><td>{x.type || "—"}</td><td>{x.clinic || "—"}</td>
                <td><span className={"rep-st " + (/cancel/i.test(x.status || "") ? "c" : /complete|visit|check/i.test(x.status || "") ? "v" : "")}>{x.status || "—"}</span></td><td className="muted">{x.login}</td><td className="muted">{x.cancel_reason || ""}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
