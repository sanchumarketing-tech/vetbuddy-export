// Agent home page, the incentive plan, and the team lead's Team performance / Team incentive pages.
// Look and content follow the "Sanchu Sales Team Backend" page (26 Nov 2026). Numbers come from cd_incentives.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "./supabase.js";

// ------------------------------------------------------------------ helpers
const N = (x) => Number(x || 0).toLocaleString("en-IN");
const rs = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const pctNum = (a, b) => (b ? Math.round((a * 100) / b) : null);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso) => { const p = iso.split("-"); return `${+p[2]} ${MON[+p[1] - 1]}`; };
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const monthISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
// salary month: 21st of the previous month to the 20th
export const salaryMonthISO = (d = new Date()) => monthISO(d.getDate() >= 21 ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : d);
const monthName = (iso) => new Date(`${iso}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function cycleInfo() {
  const t = todayIST(), [y, m, d] = t.split("-").map(Number);
  const start = d >= 21 ? Date.UTC(y, m - 1, 21) : Date.UTC(y, m - 2, 21);
  const end = d >= 21 ? Date.UTC(y, m, 20) : Date.UTC(y, m - 1, 20);
  const now = Date.parse(t + "T00:00:00Z");
  return { day: Math.round((now - start) / 864e5) + 1, total: Math.round((end - start) / 864e5) + 1 };
}
function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }
const dayOfYear = () => { const n = new Date(); return Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 864e5); };

// ------------------------------------------------------------------ content
export const QUOTES = [
  ["Well done is better than well said.", "Benjamin Franklin"],
  ["Success is the sum of small efforts, repeated day in and day out.", "Robert Collier"],
  ["The only way to do great work is to love what you do.", "Steve Jobs"],
  ["Whether you think you can, or you think you can’t, you’re right.", "Henry Ford"],
  ["Alone we can do so little; together we can do so much.", "Helen Keller"],
  ["Excellence is not a destination; it is a continuous journey that never ends.", "Brian Tracy"],
  ["Motivation is what gets you started. Habit is what keeps you going.", "Jim Ryun"],
  ["Customers will never love a company until the employees love it first.", "Simon Sinek"],
  ["Your most unhappy customers are your greatest source of learning.", "Bill Gates"],
  ["A smile is the universal welcome.", "Max Eastman"],
];
export const SALES_TIPS = [
  ["Open warm", "Greet, say your name and the hospital, then ask the pet’s name."],
  ["Use the pet’s name", "It builds trust and shows you care about the animal."],
  ["Ask, then listen", "Let the owner finish before you suggest a visit."],
  ["Offer two slots", "“Today at 5 or tomorrow at 11?” works better than “When are you free?”"],
  ["Repeat the details", "Pet name, date, time, clinic and phone number, back to the owner."],
  ["Handle “later”", "Offer to hold a tentative slot and send a WhatsApp reminder."],
  ["Close with a next step", "“I’m sending your confirmation on WhatsApp right now.”"],
  ["Follow up the day before", "A quick confirmation call cuts no-shows."],
];
export const SCRIPTS = [
  ["Opening", "Good morning, this is [Your name] from Sanchu Animal Hospital. May I speak with [Owner name]? I’m calling about [Pet name]’s [vaccination / check-up]. Is this a good time for a quick minute?"],
  ["Book a visit", "[Pet name] is due for [service]. We have openings at [time 1] or [time 2] at our [clinic] clinic. Which one suits you better?"],
  ["Confirmation call", "Hello [Owner name], this is [Your name] from Sanchu Animal Hospital, confirming [Pet name]’s appointment tomorrow at [time] at [clinic]. Will you be able to make it?"],
  ["“I’ll think about it”", "Of course, many owners prefer to take a day. Shall I hold a tentative slot for [Pet name] at [time] and send the details on WhatsApp, so you can confirm or change it whenever you like?"],
  ["After a missed visit", "Hello [Owner name], we missed [Pet name] yesterday. I hope everything is alright. Shall we rebook for a time that suits you better?"],
  ["Closing", "Thank you, [Owner name]. [Pet name] is booked for [date] at [time] at [clinic]. I’ll send the confirmation on WhatsApp now. Please call us if anything changes. Have a lovely day!"],
];
export const IMPORTANT_POINTS = [
  <>Incentives are calculated on <b className="hl">visits completed</b>, not appointments fixed.</>,
  <>The visit must happen on the <b className="hl">same day</b> the appointment was fixed.</>,
  <>The visit must be recorded under the <b className="hl">agent’s name</b>.</>,
  <>Only valid and eligible visits will be considered.</>,
  <>Duplicate, RNR, No Pet, Pet Deceased and other ineligible cases will be excluded.</>,
  <>This plan is applicable for <b>Social Media, Sharp Shooting, Runo Calls, Appointment Confirmation and VOW</b> teams.</>,
];
export const incentiveFor = (slabs, v) => {
  const s = [...(slabs || [])].filter((x) => x.from <= v).sort((a, b) => b.from - a.from)[0];
  return s ? Number(s.fixed) + (v - s.from) * Number(s.per_visit) : 0;
};

// ------------------------------------------------------------------ small pieces
function CycleBar() {
  const c = cycleInfo();
  return (
    <div className="hp-cyc">Cycle day {c.day} of {c.total}<div><i style={{ width: `${Math.round((c.day * 100) / c.total)}%` }} /></div></div>
  );
}
function PctBar({ v, d }) {
  const p = pctNum(v, d);
  if (p === null) return <span className="muted">–</span>;
  return <span className="nowrap">{p}%<span className="hp-pb"><i style={{ width: `${Math.min(100, p)}%` }} /></span></span>;
}
function Quote() {
  const [q, setQ] = useState(dayOfYear() % QUOTES.length);
  return (
    <div className="hp-qt">
      <p>“{QUOTES[q][0]}”</p>
      <b>— {QUOTES[q][1]}</b>
      <button onClick={() => setQ((q + 1) % QUOTES.length)}>Another quote</button>
    </div>
  );
}
function Scripts() {
  const [i, setI] = useState(0);
  const [copied, setCopied] = useState(false);
  const copy = () => { try { navigator.clipboard?.writeText(SCRIPTS[i][1]); setCopied(true); } catch { /* ignore */ } };
  return (
    <>
      <div className="hp-tabs">
        {SCRIPTS.map((s, k) => <button key={s[0]} className={k === i ? "on" : ""} onClick={() => { setI(k); setCopied(false); }}>{s[0]}</button>)}
      </div>
      <div className="hp-sb"><p>{SCRIPTS[i][1]}</p><button onClick={copy}>{copied ? "Copied" : "Copy script"}</button></div>
    </>
  );
}
export function ImportantPoints() {
  return (
    <div className="hp-box hp-points">
      <h4>Important points</h4>
      <ul>{IMPORTANT_POINTS.map((p, i) => <li key={i}>{p}</li>)}</ul>
    </div>
  );
}
export function AttendanceBonus() {
  return (
    <div className="hp-box hp-att">
      <h4>Attendance bonus</h4>
      <div className="hp-att-amt"><b>₹500</b> per month</div>
      <p>To get the ₹500 attendance bonus, you should have:</p>
      <ul><li>No leaves</li><li>Week off on Sunday, Friday and Saturday</li><li>No extra leaves (without approval) during the month</li></ul>
    </div>
  );
}

// ------------------------------------------------------------------ incentive plan table
export function IncentivePlan({ slabs, visits, dept }) {
  if (!slabs?.length) return <p className="note warn">No incentive plan is set for {dept || "this team"} yet. Ask your team lead.</p>;
  const s = [...slabs].sort((a, b) => a.from - b.from);
  const rows = [];
  rows.push({ range: `0 – ${s[0].from - 1}`, inc: "₹0", amt: "₹0", tot: "₹0", lo: 0, hi: s[0].from - 1 });
  rows.push({ range: `${s[0].from}`, inc: <>{rs(s[0].fixed)}{Number(s[0].fixed) > 0 && " (base amount)"}</>, amt: rs(s[0].fixed), tot: rs(s[0].fixed), base: true, lo: s[0].from, hi: s[0].from });
  s.forEach((x, i) => {
    const nx = s[i + 1];
    if (nx) rows.push({ range: `${x.from + 1} – ${nx.from}`, inc: `₹${N(x.per_visit)} per additional visit`, amt: rs((nx.from - x.from) * x.per_visit), tot: rs(Number(x.fixed) + (nx.from - x.from) * x.per_visit), lo: x.from + 1, hi: nx.from });
    else rows.push({ range: `${x.from + 1}+`, inc: <>₹{N(x.per_visit)} per additional visit <span className="hl">(above {x.from} visits)</span></>, amt: "–", tot: "–", lo: x.from + 1, hi: Infinity });
  });
  const v = visits ?? null;
  const next = v === null ? null : s.find((x) => x.from > v);
  return (
    <div className="hp-plan">
      <div className="hp-plan-head">
        <div><h3 className="hp-h">Incentive plan</h3><span className="muted small">Based on <b className="hl">visited</b>{dept ? ` · ${dept}` : ""}</span></div>
        {v !== null && <div className="hp-plan-now"><b>{N(v)}</b> eligible visits · <b>{rs(incentiveFor(s, v))}</b> so far{next ? <> · {N(next.from - v)} more to the {next.from} level</> : null}</div>}
      </div>
      <table className="hp-plan-t">
        <thead><tr><th>Visited range<small>visits completed</small></th><th>Incentive at that level</th><th>Amount at that level<small>for additional visits</small></th><th>Total amount<small>at that level</small></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const here = v !== null && v >= r.lo && v <= r.hi;
            return (
              <tr key={r.range} className={(r.base ? "base " : "") + (here ? "here" : "")}>
                <td>{r.range}{here && <span className="hp-you">You are here</span>}</td><td>{r.inc}</td><td>{r.amt}</td><td>{r.tot}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ agent home
export function AgentHome({ me, goList, goIncentives }) {
  const first = (me.name || "").split(/[\s.]+/)[0] || me.name;
  return (
    <div className="page hp hp-fade">
      <header className="hp-hero">
        <div>
          <div className="hp-gt">{greeting()}, {first}!</div>
          <div className="muted">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · let’s make today count</div>
        </div>
        <div className="hp-hero-r"><button className="primary" onClick={goList}>Start calling →</button></div>
      </header>

      <h2 className="hp-h2">My progress this cycle</h2>
      <div className="hp-soon">
        <span className="hp-soon-tag">Coming soon</span>
        <p>Your visits, incentive so far and how close you are to the next level will show here.</p>
        <button className="link" onClick={goIncentives}>Meanwhile, see my incentive plan →</button>
      </div>

      <h2 className="hp-h2">Thought for the day</h2>
      <Quote />

      <div className="hp-two">
        <ImportantPoints />
        <AttendanceBonus />
      </div>

      <h2 className="hp-h2">Sales tips</h2>
      <div className="hp-tg">{SALES_TIPS.map((t, i) => <div className="hp-tc" key={t[0]}><span>{i + 1}</span><b>{t[0]}</b><p>{t[1]}</p></div>)}</div>

      <h2 className="hp-h2">Call scripts</h2>
      <Scripts />
      <p className="hp-foot">Quotes are widely attributed to the authors named. Scripts are a starting point: make them your own.</p>
    </div>
  );
}

// ------------------------------------------------------------------ celebration (top performer tap)
function useCelebrate() {
  const ref = useRef(null);
  const [toast, setToast] = useState("");
  const boom = (name, v) => {
    setToast(`Congratulations, ${name}! ${N(v)} eligible visits this cycle. A winning moment!`);
    setTimeout(() => setToast(""), 4200);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const c = ref.current; if (!c) return;
    const x = c.getContext("2d"); c.width = window.innerWidth; c.height = window.innerHeight;
    let P = []; const col = ["#ee2a5f", "#f2c14e", "#1f8a70", "#1f6fb8", "#b06bff", "#ff9a3c"];
    const burst = (cx, cy) => { for (let i = 0; i < 80; i++) { const a = Math.random() * 6.283, s = 2 + Math.random() * 5.5; P.push({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, l: 1, c: col[i % 6] }); } };
    for (let k = 0; k < 8; k++) setTimeout(() => burst(c.width * (0.12 + Math.random() * 0.76), c.height * (0.12 + Math.random() * 0.45)), k * 330);
    const t0 = Date.now();
    (function f() {
      x.clearRect(0, 0, c.width, c.height);
      P.forEach((p) => { p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.vx *= 0.99; p.l -= 0.011; x.globalAlpha = Math.max(p.l, 0); x.fillStyle = p.c; x.fillRect(p.x, p.y, 3.5, 3.5); });
      P = P.filter((p) => p.l > 0);
      if (Date.now() - t0 < 3600 || P.length) requestAnimationFrame(f); else x.clearRect(0, 0, c.width, c.height);
    })();
  };
  const layer = (<><canvas ref={ref} className="hp-fw" />{toast && <div className="hp-toast">{toast}</div>}</>);
  return [boom, layer];
}

// ------------------------------------------------------------------ motion helpers
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
// counts a number up from 0 when it first shows (and from the old value when it changes)
export function Num({ v, fmt = N }) {
  const target = Number(v) || 0;
  const [x, setX] = useState(reduced() ? target : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduced()) { setX(target); return; }
    const start = from.current, t0 = performance.now(), dur = 700;
    let raf;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      setX(start + (target - start) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = target; };
  }, [target]);
  return <>{fmt(Math.round(x))}</>;
}
export function Skeleton({ rows = 3 }) {
  return <div className="hp-skel" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <i key={i} style={{ width: `${90 - i * 14}%` }} />)}</div>;
}

// ------------------------------------------------------------------ interactive bar chart (svg)
// items: [{ v, l (axis label), full (tooltip title), sub (tooltip line), onClick }]
function Bars({ items, label, active, onHover, animKey }) {
  const [hov, setHov] = useState(null);
  const cur = active ?? hov;
  const set = (i) => { setHov(i); onHover?.(i); };
  const max = Math.max(1, ...items.map((p) => p.v));
  const w = 600 / Math.max(items.length, 1);
  const avg = items.length ? items.reduce((s, p) => s + p.v, 0) / items.length : 0;
  const ay = 150 - Math.round((avg / max) * 130);
  const tip = cur !== null && cur !== undefined && items[cur];
  return (
    <div className="hp-chartwrap" onMouseLeave={() => set(null)}>
      <svg className="hp-chart" viewBox="0 0 640 200" width="100%" role="img" aria-label={label} key={animKey}>
        <defs>
          <linearGradient id="hpbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1f8a70" /><stop offset="1" stopColor="#1f6fb8" /></linearGradient>
          <linearGradient id="hpbh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ee2a5f" /><stop offset="1" stopColor="#f2864f" /></linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1="20" x2="620" y1={150 - g * 130} y2={150 - g * 130} className="hp-gridline" />)}
        {items.map((p, i) => {
          const h = Math.max(p.v > 0 ? 2 : 0, Math.round((p.v / max) * 130)), x = 20 + i * w;
          const on = cur === i, dim = cur !== null && cur !== undefined && !on;
          return (
            <g key={i} className={"hp-bar" + (on ? " on" : "") + (dim ? " dim" : "") + (p.onClick ? " click" : "")}
              onMouseEnter={() => set(i)} onClick={() => p.onClick?.()} tabIndex={p.onClick ? 0 : -1}
              onFocus={() => set(i)} onBlur={() => set(null)} onKeyDown={(e) => { if (e.key === "Enter" && p.onClick) p.onClick(); }}>
              <rect className="hit" x={x} y="10" width={w} height="165" fill="transparent" />
              <rect className="b" x={x + w * 0.15} y={150 - h} width={w * 0.7} height={h} rx="3" fill={on ? "url(#hpbh)" : "url(#hpbg)"} style={{ animationDelay: `${Math.min(i * 22, 500)}ms` }} />
              {p.v > 0 && <text className="v" x={x + w / 2} y={144 - h} textAnchor="middle">{p.v}</text>}
              <text className="l" x={x + w / 2} y="168" textAnchor="middle">{p.l}</text>
            </g>
          );
        })}
        {items.length > 1 && avg > 0 && <g className="hp-avg"><line x1="20" x2="620" y1={ay} y2={ay} /><text x="622" y={ay + 3}>avg</text></g>}
        <text x="20" y="192" className="l">{label}</text>
      </svg>
      {tip && (
        <div className="hp-tip" style={{ left: `${((20 + cur * w + w / 2) / 640) * 100}%` }}>
          <b>{tip.full || tip.l}</b><span>{tip.v.toLocaleString("en-IN")}{tip.unit ? ` ${tip.unit}` : ""}</span>
          {tip.sub && <small>{tip.sub}</small>}
          {tip.onClick && <em>{tip.hint || "Click to open"}</em>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ team lead: Team performance
// Loads every team for the salary month. One request per team: asking for all teams at once
// is too slow for the database (statement timeout), one team takes 1-2 seconds.
function useMonthData(month) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setD(null); setErr("");
    const get = (dept) => rpc("cd_incentives", { p_month: `${month}-01`, p_agent: -1, p_dept: dept });
    (async () => {
      const first = await get("Sharpshooting");
      const depts = (first.departments || ["Sharpshooting"]).filter((x) => x !== "Sharpshooting");
      const agents = [...first.agents];
      for (const dept of depts) {
        if (!live) return;
        const r = await get(dept);
        r.agents.forEach((a) => { if (!agents.some((x) => x.id === a.id)) agents.push(a); });
      }
      if (live) setD({ ...first, department: null, agents: agents.sort((a, b) => b.eligible - a.eligible || a.name.localeCompare(b.name)) });
    })().catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [month]);
  return [d, err];
}
const teamsOf = (d) => {
  const seen = (d?.departments || []).filter((t) => d.agents.some((a) => a.department === t));
  if (d?.agents.some((a) => !a.department)) seen.push("");
  return seen;
};
const teamName = (t) => (t === "" ? "No team" : t);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sumBy = (rows, k) => rows.reduce((s, a) => s + Number(a[k] || 0), 0);

function MonthPick({ month, setMonth }) {
  return <label className="inline">Salary month <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>;
}

export function TeamPerformance({ month, setMonth, openAgentIncentive }) {
  const [d, err] = useMonthData(month);
  const [team, setTeam] = useState(null);         // null = choose a team; "*" = all teams
  const [agent, setAgent] = useState(null);       // agent id for the day-by-day view
  const [metric, setMetric] = useState("eligible");
  const [hover, setHover] = useState(null);
  const [boom, layer] = useCelebrate();

  if (agent) return <AgentPerformance id={agent} month={month} back={() => setAgent(null)} openAgentIncentive={openAgentIncentive} />;
  const head = (
    <div className="page-head">
      <h2>{team === null ? "Team performance" : `Team: ${team === "*" ? "All teams" : teamName(team)}`}</h2>
      <MonthPick month={month} setMonth={setMonth} />
    </div>
  );
  if (err) return <div className="page">{head}<p className="note warn">{err}</p></div>;
  if (!d) return <div className="page">{head}<Skeleton /></div>;
  const T = teamsOf(d);

  if (team === null) {
    const top = [...d.agents].sort((a, b) => b.eligible - a.eligible).slice(0, 3).filter((a) => a.eligible > 0);
    return (
      <div className="page hp hp-fade" key="choose">
        {layer}
        {head}
        <p className="cycle"><strong>{monthName(month)}</strong> salary month: {dayLabel(d.cycle_from)} to {dayLabel(d.cycle_to)} <span className="muted">· latest day may be partial</span></p>
        {top.length > 0 && (<>
          <h3 className="hp-h">Top performers this cycle</h3>
          <p className="muted small">Tap a name to celebrate a winning moment.</p>
          <div className="hp-stars">
            {top.map((a, i) => (
              <button key={a.id} className="hp-star" onClick={() => boom(a.name, a.eligible)}>
                <i>{i + 1}</i><div><b>{a.name}</b><small>{a.department || "No team"} · {N(a.eligible)} eligible visits</small></div>
              </button>
            ))}
          </div>
        </>)}
        <TeamTiles rows={d.agents} label="this cycle" />
        <h3 className="hp-h">Choose a team</h3>
        <div className="hp-grid">
          <button className="hp-pick" onClick={() => setTeam("*")}><b>All teams</b><small>{plural(d.agents.length, "agent")}</small></button>
          {T.map((t) => (
            <button key={t || "none"} className="hp-pick" onClick={() => setTeam(t)}>
              <b>{teamName(t)}</b><small>{plural(d.agents.filter((a) => (a.department || "") === t).length, "agent")} · {N(sumBy(d.agents.filter((a) => (a.department || "") === t), "eligible"))} eligible visits</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const rows = d.agents.filter((a) => team === "*" || (a.department || "") === team);
  const sorted = [...rows].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name));
  const M = [["called", "People called"], ["booked", "Appts booked"], ["visited", "Visited"], ["eligible", "Eligible"]];
  return (
    <div className="page hp hp-fade" key={"t" + team}>
      <button className="link hp-back" onClick={() => setTeam(null)}>← Back</button>
      {head}
      <p className="cycle"><strong>{monthName(month)}</strong>: {dayLabel(d.cycle_from)} to {dayLabel(d.cycle_to)}</p>
      <TeamTiles rows={rows} />
      <div className="hp-card">
        <h3 className="hp-h">Agents compared</h3>
        <div className="hp-tabs">{M.map(([k, v]) => <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{v}</button>)}</div>
        <Bars animKey={metric + team} active={hover !== null && hover < 24 ? hover : null} onHover={setHover}
          items={sorted.slice(0, 24).map((a) => ({ v: Number(a[metric] || 0), l: a.name.split(/[\s.]+/)[0].slice(0, 9), full: a.name,
            sub: `${a.department || "No team"} · ${N(a.booked)} booked · ${N(a.visited)} visited · ${rs(a.amount)}`, onClick: () => setAgent(a.id) }))}
          label={sorted.length > 24 ? "Top 24 agents · hover for details, click to open" : "Agent · hover for details, click to open"} />
      </div>
      <div className="hp-card">
        <h3 className="hp-h">Agents in {team === "*" ? "all teams" : teamName(team)}</h3>
        <div className="hp-sc">
          <table className="hp-t">
            <thead><tr><th>Agent</th>{team === "*" && <th>Team</th>}<th>Called</th><th>Booked</th><th>Visited</th><th>Visit %</th><th>Eligible</th><th>Target</th><th>Incentive</th></tr></thead>
            <tbody>
              <tr className="tot"><td>Total</td>{team === "*" && <td />}<td>{N(sumBy(rows, "called"))}</td><td>{N(sumBy(rows, "booked"))}</td><td>{N(sumBy(rows, "visited"))}</td>
                <td><PctBar v={sumBy(rows, "visited")} d={sumBy(rows, "booked")} /></td><td>{N(sumBy(rows, "eligible"))}</td><td>{N(sumBy(rows, "target")) || "–"}</td><td>{rs(sumBy(rows, "amount"))}</td></tr>
              {sorted.map((a, i) => (
                <tr key={a.id} className={"click" + (hover === i ? " hot" : "")} onClick={() => setAgent(a.id)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <td><b>{a.name}</b></td>{team === "*" && <td className="muted">{a.department || "–"}</td>}
                  <td>{N(a.called)}</td><td>{N(a.booked)}</td><td>{N(a.visited)}</td><td><PctBar v={a.visited} d={a.booked} /></td>
                  <td><b>{N(a.eligible)}</b></td><td>{a.target ? <PctBar v={a.eligible} d={a.target} /> : <span className="muted">–</span>}</td><td>{rs(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Tap an agent for day by day. Visit % = visited ÷ appointments booked. Eligible = visited and not shared with another agent.</p>
      </div>
    </div>
  );
}

function TeamTiles({ rows, label = "" }) {
  const b = sumBy(rows, "booked"), v = sumBy(rows, "visited");
  return (
    <div className="hp-tiles">
      <div className="hp-tile"><b><Num v={sumBy(rows, "called")} /></b><span>people called {label}</span></div>
      <div className="hp-tile"><b><Num v={b} /></b><span>appts booked {label}</span></div>
      <div className="hp-tile"><b><Num v={v} /></b><span>visited {label}</span></div>
      <div className="hp-tile"><b>{b ? <Num v={Math.round((v * 100) / b)} fmt={(x) => `${x}%`} /> : "–"}</b><span>visit % {label}</span></div>
    </div>
  );
}

// one agent, day by day (from the agent's appointment rows)
function AgentPerformance({ id, month, back, openAgentIncentive }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [metric, setMetric] = useState("b");
  const [range, setRange] = useState("all");
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const pick = (day) => { setFocus(day); setTimeout(() => document.getElementById(`hp-day-${day}`)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" }), 30); };
  useEffect(() => { rpc("cd_incentives", { p_month: `${month}-01`, p_agent: id, p_dept: null }).then(setD).catch((e) => setErr(e.message)); }, [id, month]);
  const per = useMemo(() => {
    if (!d) return [];
    const last = d.cycle_to < todayIST() ? d.cycle_to : todayIST();
    const days = [];
    for (let x = d.cycle_from; x <= last; x = addDays(x, 1)) days.push(x);
    const m = Object.fromEntries(days.map((x) => [x, { d: x, b: 0, v: 0, e: 0 }]));
    d.rows.forEach((r) => {
      if (m[r.appt_date]) m[r.appt_date].b++;
      if (r.visit_date && m[r.visit_date]) { m[r.visit_date].v++; if (r.eligible) m[r.visit_date].e++; }
    });
    return days.map((x) => m[x]);
  }, [d]);
  if (err) return <div className="page"><button className="link hp-back" onClick={back}>← Back</button><p className="note warn">{err}</p></div>;
  if (!d) return <div className="page"><button className="link hp-back" onClick={back}>← Back</button><Skeleton /></div>;
  const one = d.agents[0];
  const shown = range === "all" ? per : per.slice(-Number(range));
  const s = (k) => shown.reduce((a, p) => a + p[k], 0);
  return (
    <div className="page hp hp-fade">
      <button className="link hp-back" onClick={back}>← Back</button>
      <div className="page-head">
        <h2>Agent: {one?.name}{one?.department && <span className="muted small"> ({one.department})</span>}</h2>
        <button className="ghost" onClick={() => openAgentIncentive(id)}>Appointments and incentive</button>
      </div>
      <div className="hp-tabs">
        {[["all", "Whole cycle"], ["7", "Last 7 days"], ["1", "Latest day"]].map(([k, v]) => <button key={k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{v}</button>)}
      </div>
      <div className="hp-kpis">
        <div><b><Num v={one?.called} /></b><span>people called (cycle)</span></div>
        <div><b><Num v={s("b")} /></b><span>appointments due</span></div>
        <div><b><Num v={s("v")} /></b><span>visited</span></div>
        <div><b><Num v={s("e")} /></b><span>eligible</span></div>
        <div><b>{range === "all" ? <Num v={one?.amount} fmt={rs} /> : "–"}</b><span>incentive (cycle)</span></div>
      </div>
      <div className="hp-card">
        <h3 className="hp-h">Day by day</h3>
        <div className="hp-tabs">{[["b", "Appointments due"], ["v", "Visited"], ["e", "Eligible"]].map(([k, v]) => <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{v}</button>)}</div>
        <Bars animKey={metric + range} active={hover} onHover={setHover}
          items={shown.map((p) => ({ v: p[metric], l: String(+p.d.slice(8)), full: new Date(p.d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
            sub: `${p.b} due · ${p.v} visited · ${p.e} eligible`, hint: "Click to find it in the table", onClick: () => pick(p.d) }))}
          label="Day of month · click a day to find it in the table" />
        <div className="hp-sc">
          <table className="hp-t">
            <thead><tr><th>Date</th><th>Appointments due</th><th>Visited</th><th>Eligible</th><th>Visit %</th></tr></thead>
            <tbody>
              <tr className="tot"><td>Total</td><td>{N(s("b"))}</td><td>{N(s("v"))}</td><td>{N(s("e"))}</td><td><PctBar v={s("v")} d={s("b")} /></td></tr>
              {shown.slice().reverse().map((p) => <tr key={p.d} id={`hp-day-${p.d}`} className={(focus === p.d ? "focus " : "") + (hover !== null && shown[hover]?.d === p.d ? "hot" : "")}
                onMouseEnter={() => setHover(shown.indexOf(p))} onMouseLeave={() => setHover(null)}><td>{dayLabel(p.d)}</td><td>{p.b}</td><td>{p.v}</td><td>{p.e}</td><td><PctBar v={p.v} d={p.b} /></td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted small">Appointments are counted on their appointment date, visits on the day the pet was billed (up to 3 days after). The latest day may be partial.</p>
    </div>
  );
}

// ------------------------------------------------------------------ team lead: Team incentive
export function TeamIncentive({ month, setMonth, openAgentIncentive }) {
  const [d, err] = useMonthData(month);
  const [team, setTeam] = useState(null);
  const head = (<div className="page-head"><h2>Team incentive</h2><MonthPick month={month} setMonth={setMonth} /></div>);
  if (err) return <div className="page">{head}<p className="note warn">{err}</p></div>;
  if (!d) return <div className="page">{head}<Skeleton /></div>;
  const T = teamsOf(d);
  const sel = team ?? T[0] ?? "";
  const of = (t) => d.agents.filter((a) => (a.department || "") === t);
  const slabsOf = (t) => d.slabs?.[t];
  const firstLevel = (t) => { const s = slabsOf(t); return s?.length ? Math.min(...s.map((x) => x.from)) : null; };
  const rows = of(sel);
  const slabs = [...(slabsOf(sel) || [])].sort((a, b) => a.from - b.from);
  // how many agents sit in each level
  const levels = slabs.length ? [{ lo: 0, hi: slabs[0].from - 1, name: `Below ${slabs[0].from}` }].concat(slabs.map((x, i) => ({ lo: x.from, hi: slabs[i + 1] ? slabs[i + 1].from - 1 : Infinity, name: slabs[i + 1] ? `${x.from} – ${slabs[i + 1].from - 1}` : `${x.from}+`, per: x.per_visit }))) : [];
  return (
    <div className="page hp hp-fade">
      {head}
      <p className="cycle"><strong>{monthName(month)}</strong> salary month: {dayLabel(d.cycle_from)} to {dayLabel(d.cycle_to)}</p>
      <div className="hp-sc">
        <table className="hp-t">
          <thead><tr><th>Team</th><th>Agents</th><th>Eligible visits</th><th>Earning incentive</th><th>Team incentive</th><th>Average per agent</th><th>Top earner</th><th>Attendance bonus (max)</th></tr></thead>
          <tbody>
            {T.map((t) => {
              const r = of(t), fl = firstLevel(t), earning = r.filter((a) => Number(a.amount) > 0).length;
              const top = [...r].sort((a, b) => b.amount - a.amount || b.eligible - a.eligible)[0];
              return (
                <tr key={t || "none"} className={"click" + (t === sel ? " sel" : "")} onClick={() => setTeam(t)}>
                  <td><b>{teamName(t)}</b>{!slabsOf(t) && <div className="muted small">no incentive plan set</div>}</td>
                  <td>{r.length}</td><td>{N(sumBy(r, "eligible"))}</td>
                  <td>{earning} of {r.length}{fl !== null && <div className="muted small">{fl}+ visits</div>}</td>
                  <td><b>{rs(sumBy(r, "amount"))}</b></td><td>{r.length ? rs(sumBy(r, "amount") / r.length) : "–"}</td>
                  <td>{top && Number(top.amount) > 0 ? <>{top.name}<div className="muted small">{rs(top.amount)}</div></> : <span className="muted">–</span>}</td>
                  <td className="muted">{rs(500 * r.length)}</td>
                </tr>
              );
            })}
            <tr className="tot"><td>Total</td><td>{d.agents.length}</td><td>{N(sumBy(d.agents, "eligible"))}</td><td>{d.agents.filter((a) => Number(a.amount) > 0).length} of {d.agents.length}</td>
              <td><b>{rs(sumBy(d.agents, "amount"))}</b></td><td>{d.agents.length ? rs(sumBy(d.agents, "amount") / d.agents.length) : "–"}</td><td /><td className="muted">{rs(500 * d.agents.length)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="muted small">Team incentive = the sum of each agent's slab amount for their eligible visits. The ₹500 attendance bonus is paid on top to agents who qualify; attendance is not in the Call Desk, so the last column is the most it can add.</p>

      <h3 className="hp-h">{teamName(sel)}: agents by level</h3>
      {levels.length === 0 && <p className="muted">No incentive levels are set for this team.</p>}
      {levels.length > 0 && (
        <div className="hp-levels">
          {levels.map((l) => {
            const inL = rows.filter((a) => a.eligible >= l.lo && a.eligible <= l.hi).sort((a, b) => b.eligible - a.eligible);
            return (
              <div key={l.name} className={"hp-level" + (inL.length ? "" : " none")}>
                <div className="hp-level-h"><b>{l.name}</b><span>{l.per ? `₹${l.per}/visit` : "₹0"}</span></div>
                <div className="hp-level-n">{inL.length} agent{inL.length === 1 ? "" : "s"}</div>
                {inL.map((a) => <button key={a.id} className="link" onClick={() => openAgentIncentive(a.id)}>{a.name} · {a.eligible}</button>)}
              </div>
            );
          })}
        </div>
      )}
      {slabsOf(sel) && <IncentivePlan slabs={slabsOf(sel)} dept={teamName(sel)} />}
    </div>
  );
}
