// =====================================================================
// Sanchu Sales - AI analyst chatbot for Microsoft Teams  (Supabase Edge Function "teams-bot")   v3
//
// How it works
//  - Every message goes to an AI AGENT that holds the conversation (last 3 hours) and works like an analyst:
//    it decides which DATA TOOLS to call, reads the results, calls more tools to drill down when it needs to
//    ("why", "what drove it"), and then writes the reply in plain, professional English.
//  - DATA TOOLS run tested, parameterised SQL on Supabase and compute every total, comparison, growth %,
//    share and average in code, so the AI never has to calculate: get_sales, get_month_status,
//    get_breakdown, get_customers. For anything else the agent can write its own read-only query (run_sql).
//  - ACCURACY: every number in a reply is checked against the tool results; an unsupported number is sent
//    back to the AI once to fix, and anything still unsupported is removed.
//  - HOUSE RULES (vetbuddy.bot_rules) are added to the agent's instructions; managed from Teams with
//    "rules" / "add rule: never ..." / "remove rule 2".
//  - DAILY REPORT buttons under every answer (Yesterday's sales, Month to date vs target, Units behind
//    target, Last 7 days trend) are answered instantly from code - no AI, no tokens, always the same format.
//  - Models (Groq): AI_AGENT_MODELS, default gpt-oss-120b -> llama-3.3-70b -> qwen3.8-27b -> gpt-oss-20b;
//    when one model hits its limit the next one continues the same conversation.
//  - Every question is logged in vetbuddy.bot_log (tools, models, tokens, time, errors, "wrong" feedback).
// Secrets (Supabase > Edge Functions > Secrets):
//   AI_API_KEY (Groq), BOT_DB_URL (vb_teams login), BOT_APP_ID, BOT_APP_SECRET, BOT_TENANT_ID,
//   ALLOWED_CONVERSATIONS, optional DAILY_TOKEN_CAP, AI_AGENT_MODELS
// =====================================================================
import postgres from "npm:postgres@3.4.5";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const AI_KEY = env("AI_API_KEY", env("GROQ_API_KEY"));
const DAILY_CAP = Number(env("DAILY_TOKEN_CAP", "600000"));
const ALLOWED = env("ALLOWED_CONVERSATIONS").split(",").map((s) => s.trim()).filter(Boolean);
const AGENT_MODELS = (env("AI_AGENT_MODELS") ||
  "openai/gpt-oss-120b,llama-3.3-70b-versatile,qwen/qwen3.8-27b,openai/gpt-oss-20b").split(",").map((s) => s.trim()).filter(Boolean);
const db = postgres(env("BOT_DB_URL"), { prepare: false, max: 3, idle_timeout: 20 });

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// units, dates, formatting
// ---------------------------------------------------------------------------
const ALL_UNITS = ["ADYAR", "NEELANGARAI", "ANNA NAGAR", "VELACHERY", "VALASARAVAKKAM", "COIMBATORE", "MADURAI", "TRICHY",
  "CH VET ON WHEELS", "CH VET ON WHEELS - NON CLINICAL", "CBE VET ON WHEELS", "CBE VET ON WHEELS - NON CLINICAL",
  "MADURAI VET ON WHEELS", "TRICHY VET ON WHEELS"];
const CITIES: { name: string; clinic: string[]; vow: string[] }[] = [
  { name: "Chennai", clinic: ["ADYAR", "NEELANGARAI", "ANNA NAGAR", "VELACHERY", "VALASARAVAKKAM"], vow: ["CH VET ON WHEELS", "CH VET ON WHEELS - NON CLINICAL"] },
  { name: "Coimbatore", clinic: ["COIMBATORE"], vow: ["CBE VET ON WHEELS", "CBE VET ON WHEELS - NON CLINICAL"] },
  { name: "Madurai", clinic: ["MADURAI"], vow: ["MADURAI VET ON WHEELS"] },
  { name: "Trichy", clinic: ["TRICHY"], vow: ["TRICHY VET ON WHEELS"] },
];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (s: string) => new Date(s + "T00:00:00Z");
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(day(s).getTime() + n * 864e5));
const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const wday = (s: string) => day(s).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dm = (s: string) => `${day(s).getUTCDate()} ${MON[day(s).getUTCMonth()]}`;
function rangeLabel(f: string, t: string) {
  if (f === t) return `${wday(f)}, ${dm(f)}`;
  const a = day(f), b = day(t);
  return a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear() ? `${a.getUTCDate()}-${dm(t)}` : `${dm(f)} - ${dm(t)}`;
}
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3), h = d.getUTCHours();
  const part = h < 5 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}), ${d.toISOString().slice(11, 16)} IST, ${part}`;
}
function inr(n: number, dec = 0): string {
  const neg = n < 0, s = Math.abs(n).toFixed(dec), [i, f] = s.split(".");
  const last3 = i.slice(-3), rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-" : "") + (rest ? rest + "," + last3 : last3) + (f ? "." + f : "");
}
const rs = (n: unknown) => (n === null || n === undefined || !isFinite(Number(n)) ? "-" : "Rs " + inr(Number(n)));
const pc = (n: unknown, sign = true) => (n === null || n === undefined || !isFinite(Number(n)) ? "-" : (sign && Number(n) > 0 ? "+" : "") + Number(n).toFixed(1) + "%");
const r0 = (n: number | null | undefined) => (n === null || n === undefined || !isFinite(n) ? null : Math.round(n));
const r1 = (n: number | null | undefined) => (n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10) / 10);
const growth = (a: number | null, b: number | null) => (a === null || !b ? null : r1(((a - b) * 100) / b));
const titleUnit = (u: string) => u.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Ch|Cbe|Vow)\b/g, (m) => m.toUpperCase())
  .replace(/\bOn\b/g, "on").replace(/\bNon Clinical\b/g, "Non-Clinical");
function placeLabel(units: string[]) {
  if (units.length >= ALL_UNITS.length) return "Division (all units)";
  for (const c of CITIES) {
    const all = [...c.clinic, ...c.vow];
    if (units.length === all.length && all.every((u) => units.includes(u))) return c.name;
  }
  return units.length <= 3 ? units.map(titleUnit).join(", ") : `${units.length} units`;
}
function firstName(who: string) {           // nothing for shared / team accounts ("Data Analyst Sanchu" ...)
  const w = who.replace(/\(.*?\)/g, "").trim();
  if (!w || /\b(sanchu|analyst|team|admin|reports?|account|marketing|sales|hospital|office|desk|support|info|hr|accounts)\b/i.test(w)) return "";
  return w.split(/\s+/)[0].replace(/[^A-Za-z.'-]/g, "");
}

let datesCache: { at: number; latest: string } | null = null;
async function latestDay(): Promise<string> {
  if (datesCache && Date.now() - datesCache.at < 5 * 60e3) return datesCache.latest;
  const [r] = await db`select max(sale_date)::text as d from vetbuddy.sheet_daily`;
  datesCache = { at: Date.now(), latest: r?.d ?? addDays(istDate(), -1) };
  return datesCache.latest;
}

class LimitError extends Error {}
async function usage(add = 0) {
  const d = istDate();
  if (add > 0) {
    await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_usage (day, tokens, calls) values (${d}, ${add}, 1)
      on conflict (day) do update set tokens = bot_usage.tokens + ${add}, calls = bot_usage.calls + 1`);
  }
  const [r] = await db`select coalesce(tokens,0)::int as tokens, coalesce(calls,0)::int as calls from vetbuddy.bot_usage where day = ${d}`;
  return { tokens: r?.tokens ?? 0, calls: r?.calls ?? 0 };
}

// ---------------------------------------------------------------------------
// house rules ("negative prompts") - vetbuddy.bot_rules
// ---------------------------------------------------------------------------
let rulesCache: { at: number; list: { id: number; rule: string }[] } | null = null;
async function rules(): Promise<{ id: number; rule: string }[]> {
  if (rulesCache && Date.now() - rulesCache.at < 60e3) return rulesCache.list;
  try {
    const r = await db`select id, rule from vetbuddy.bot_rules where active order by id`;
    rulesCache = { at: Date.now(), list: r as unknown as { id: number; rule: string }[] };
  } catch { rulesCache = { at: Date.now(), list: [] }; }
  return rulesCache.list;
}

// ---------------------------------------------------------------------------
// DATA TOOLS - tested SQL; all derived numbers computed here, never by the AI
// ---------------------------------------------------------------------------
type ToolResult = { id: string; title: string; rows: Row[]; info: string; error?: string };
class ToolInputError extends Error {}

function units(arg: unknown): string[] {
  const list = (Array.isArray(arg) ? arg : arg ? [arg] : []).map((x) => String(x).trim()).filter(Boolean);
  const out: string[] = [], unknown: string[] = [];
  for (const raw of list) {
    const u = raw.toUpperCase().replace(/\s+/g, " ");
    if (/^(ALL|DIVISION|TOTAL|OVERALL|ALL UNITS)$/.test(u)) return [...ALL_UNITS];
    if (ALL_UNITS.includes(u)) { out.push(u); continue; }
    const city = CITIES.find((c) => u.startsWith(c.name.toUpperCase()) || (c.name === "Chennai" && /^CH\b/.test(u)) || (c.name === "Coimbatore" && /^(CBE|KOVAI)\b/.test(u)));
    if (city) {
      out.push(...(/VET ON WHEELS|VOW/.test(u) ? city.vow : /CLINIC/.test(u) ? city.clinic : [...city.clinic, ...city.vow]));
      continue;
    }
    if (/^(VET ON WHEELS|VOW|ALL VET ON WHEELS)$/.test(u)) { out.push(...ALL_UNITS.filter((x) => x.includes("VET ON WHEELS"))); continue; }
    if (/^(CLINICS|ALL CLINICS)$/.test(u)) { out.push(...ALL_UNITS.filter((x) => !x.includes("VET ON WHEELS"))); continue; }
    unknown.push(raw);
  }
  if (unknown.length) throw new ToolInputError(`Unknown unit(s): ${unknown.join(", ")}. Use names from: ${ALL_UNITS.join(", ")}, or a city (Chennai, Coimbatore, Madurai, Trichy), or "all".`);
  return out.length ? [...new Set(out)] : [...ALL_UNITS];
}
function dateArg(v: unknown, name: string, latest: string, optional = false): string | null {
  if ((v === undefined || v === null || v === "") && optional) return null;
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new ToolInputError(`${name} must be a date YYYY-MM-DD`);
  return s > latest ? latest : s;
}
const uList = (u: string[]) => u.join("|");

// get_sales: official daily sales report (sheet_daily) for a period, optional comparison period and unit split
async function getSales(a: Row, latest: string): Promise<Omit<ToolResult, "id">> {
  const us = units(a.units), from = dateArg(a.from, "from", latest)!, to = dateArg(a.to, "to", latest)!;
  const cf = dateArg(a.compare_from, "compare_from", latest, true), ct = dateArg(a.compare_to, "compare_to", latest, true);
  const q = (f: string, t: string) => db`select unit, sum(total)::float8 t, sum(vetbuddy)::float8 c, sum(gofrugal)::float8 p, count(distinct sale_date)::int d
    from vetbuddy.sheet_daily where sale_date between ${f}::date and ${t}::date and unit = any(string_to_array(${uList(us)}, '|')) group by unit`;
  const [cur, cmp] = await Promise.all([q(from, to), cf && ct ? q(cf, ct) : Promise.resolve([])]);
  const cm = new Map((cmp as unknown as Row[]).map((r) => [String(r.unit), Number(r.t)]));
  let T = 0, C = 0, P = 0, CT = 0, D = 0;
  const per = (cur as unknown as Row[]).map((r) => {
    const t = Number(r.t), c = cm.get(String(r.unit)) ?? null;
    T += t; C += Number(r.c); P += Number(r.p); CT += c ?? 0; D = Math.max(D, Number(r.d));
    return { unit: titleUnit(String(r.unit)), sales: r0(t), clinic: r0(Number(r.c)), pharmacy: r0(Number(r.p)),
             ...(cf ? { compare_sales: r0(c), change: c === null ? null : r0(t - c), growth_pct: growth(t, c) } : {}) } as Row;
  }).sort((x, y) => Number(y.sales ?? 0) - Number(x.sales ?? 0));
  for (const p of per) p.share_pct = T ? r1((Number(p.sales ?? 0) * 100) / T) : null;
  const days = Math.round((day(to).getTime() - day(from).getTime()) / 864e5) + 1;
  const total: Row = { unit: "TOTAL", sales: r0(T), clinic: r0(C), pharmacy: r0(P),
    ...(cf ? { compare_sales: r0(CT), change: r0(T - CT), growth_pct: growth(T, CT) } : {}), share_pct: T ? 100 : null };
  const rows = a.by_unit ? [...per, total] : [total];
  if (days > 1) for (const r of rows) r.avg_per_day = D ? r0(Number(r.sales) / D) : null;
  return { title: `Sales - ${placeLabel(us)}, ${rangeLabel(from, to)}${cf ? ` vs ${rangeLabel(cf, ct!)}` : ""}`, rows,
    info: `Official daily sales report. Units: ${placeLabel(us)}. Period ${from}..${to} (${rangeLabel(from, to)}), days with data: ${D} of ${days}` +
      (cf ? `; compared with ${cf}..${ct} (${rangeLabel(cf, ct!)})` : "") + `. clinic = VetBuddy (services + goods), pharmacy = GoFrugal.` +
      (D === 0 ? " NO DATA for this period yet." : "") };
}

// get_month_status: month-to-date KPIs and targets (sheet_kpi)
async function getMonthStatus(a: Row): Promise<Omit<ToolResult, "id">> {
  const us = units(a.units), all = us.length >= ALL_UNITS.length;
  const m = a.month && /^\d{4}-\d{2}/.test(String(a.month)) ? String(a.month).slice(0, 7) + "-01" : null;
  const rows0 = await db`select * from vetbuddy.sheet_kpi where month = coalesce(${m}::date, (select max(month) from vetbuddy.sheet_kpi))
    and (unit = 'TOTAL' or unit = any(string_to_array(${uList(us)}, '|')))` as unknown as Row[];
  if (!rows0.length) throw new ToolInputError("No month KPIs for that month (only the latest month and the one before are kept).");
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  type K = { mtd: number; target: number | null; est: number | null; lm: number | null; req: number | null; ads: number | null; tpd: number | null; bal: number | null };
  const mk = (unit: string, r: K): Row => ({
    unit, mtd: r0(r.mtd), target: r0(r.target), achieved_pct: r.target ? r1((r.mtd * 100) / r.target) : null,
    month_estimate: r0(r.est), estimate_pct: r.target && r.est !== null ? r1((r.est * 100) / r.target) : null,
    last_month_same_days: r0(r.lm), growth_pct: growth(r.mtd, r.lm), required_per_day: r0(r.req), avg_daily_sales: r0(r.ads),
    target_per_day: r0(r.tpd), balance_to_target: r0(r.bal) });
  const pick = (r: Row): K => ({ mtd: Number(r.mtd ?? 0), target: n(r.target), est: n(r.month_estimate), lm: n(r.last_month_same_days),
    req: n(r.required_per_day), ads: n(r.ads), tpd: n(r.target_per_day), bal: n(r.balance_to_target) });
  const unitRows = rows0.filter((r) => r.unit !== "TOTAL" && us.includes(String(r.unit)));
  const per = unitRows.map((r) => mk(titleUnit(String(r.unit)), pick(r))).sort((x, y) => Number(y.mtd ?? 0) - Number(x.mtd ?? 0));
  const tot = rows0.find((r) => r.unit === "TOTAL");
  let total: Row;
  if (all && tot) total = mk("TOTAL", pick(tot));
  else {
    const s = (k: keyof K) => unitRows.reduce((acc, r) => acc + (pick(r)[k] ?? 0), 0);
    total = mk("TOTAL", { mtd: s("mtd"), target: s("target"), est: s("est"), lm: s("lm"), req: s("req"), ads: s("ads"), tpd: s("tpd"), bal: s("bal") });
  }
  const f = rows0[0];
  const rows = per.length === 1 ? per : a.by_unit ? [...per, total] : [total];
  const mo = f.month instanceof Date ? ymd(f.month) : String(f.month).slice(0, 10);
  const asOf = f.as_of instanceof Date ? ymd(f.as_of) : String(f.as_of).slice(0, 10);
  return { title: `Month to date vs target - ${placeLabel(us)}, ${MON[day(mo).getUTCMonth()]} ${day(mo).getUTCFullYear()}`, rows,
    info: `Month ${mo.slice(0, 7)}, as of ${asOf} (${dm(asOf)}): ${f.days_done} days done, ${f.days_left} days left. ` +
      `month_estimate = projected month-end sales at the current pace; required_per_day = sales needed per remaining day to reach target; ` +
      `growth_pct = vs the same days last month.` };
}

// get_breakdown: what makes up / drives sales (bill lines of clinic + pharmacy)
const DIMS: Record<string, string> = { category: "plan_category", subcategory: "plan_subcategory", doctor: "doctor", item: "item_name",
  species: "species", unit: "sales_unit", day: "sale_date", source: "source", weekday: "trim(to_char(sale_date,'Dy'))" };
async function getBreakdown(a: Row, latest: string): Promise<Omit<ToolResult, "id">> {
  const by = String(a.by ?? "").toLowerCase();
  if (!DIMS[by]) throw new ToolInputError(`by must be one of: ${Object.keys(DIMS).join(", ")}`);
  const us = units(a.units), from = dateArg(a.from, "from", latest)!, to = dateArg(a.to, "to", latest)!;
  const cf = dateArg(a.compare_from, "compare_from", latest, true), ct = dateArg(a.compare_to, "compare_to", latest, true);
  const top = Math.min(Math.max(Number(a.top_n ?? 10) || 10, 3), 25);
  const src = String(a.source ?? "all").toLowerCase();
  const filt = String(a.filter ?? "").trim();
  const conds = [`sales_unit = any(string_to_array($1, '|'))`];
  if (src === "clinic") conds.push(`source = 'VetBuddy'`); else if (src === "pharmacy") conds.push(`source = 'Pharmacy'`);
  if (filt) conds.push(`(plan_category ilike $4 or plan_subcategory ilike $4 or item_name ilike $4 or coalesce(species,'') ilike $4)`);
  const col = DIMS[by];
  const agg = (d1: string, d2: string) => `select coalesce(nullif(trim(${col}::text),''),'(not recorded)') k, sum(amount)::float8 s, sum(qty)::float8 q,
    count(distinct bill_no)::int b from vetbuddy.v_all_sales where sale_date between ${d1}::date and ${d2}::date and ${conds.join(" and ")} group by 1`;
  const sql = `with cur as (${agg("$2", "$3")}), cmp as (${agg("$5", "$6")})
    select cur.k, cur.s, cur.q, cur.b, cmp.s cs from cur left join cmp using (k)`;
  const rows0 = await db.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '20s'");
    return await tx.unsafe(sql, [uList(us), from, to, filt ? `%${filt}%` : "", cf, ct]);
  }) as unknown as Row[];
  const T = rows0.reduce((s, r) => s + Number(r.s), 0), CT = rows0.reduce((s, r) => s + (r.cs === null ? 0 : Number(r.cs)), 0);
  const isDay = by === "day";
  const key = (r: Row) => r.k instanceof Date ? ymd(r.k) : String(r.k);
  const sorted = [...rows0].sort((x, y) => isDay ? key(x).localeCompare(key(y)) : Number(y.s) - Number(x.s));
  const shown = isDay ? sorted : sorted.slice(0, top), rest = isDay ? [] : sorted.slice(top);
  const row = (k: string, s: number, q: number | null, b: number | null, c: number | null): Row => ({
    [by]: k, sales: r0(s), share_pct: T ? r1((s * 100) / T) : null, ...(by === "item" ? { qty: r0(q) } : {}),
    ...(b !== null ? { bills: b } : {}), ...(cf ? { compare_sales: r0(c), growth_pct: growth(s, c) } : {}) });
  const out = shown.map((r) => row(isDay ? rangeLabel(key(r).slice(0, 10), key(r).slice(0, 10)) : by === "unit" ? titleUnit(key(r)) : key(r),
    Number(r.s), Number(r.q), Number(r.b), r.cs === null ? null : Number(r.cs)));
  if (rest.length) out.push(row(`Others (${rest.length})`, rest.reduce((s, r) => s + Number(r.s), 0), null, null,
    cf ? rest.reduce((s, r) => s + (r.cs === null ? 0 : Number(r.cs)), 0) : null));
  out.push(row("TOTAL", T, null, null, cf ? CT : null));
  return { title: `Sales by ${by}${filt ? ` (${filt})` : ""} - ${placeLabel(us)}, ${rangeLabel(from, to)}${cf ? ` vs ${rangeLabel(cf, ct!)}` : ""}`, rows: out,
    info: `From bill lines (clinic + pharmacy${src !== "all" ? `, only ${src}` : ""}${filt ? `, filter "${filt}"` : ""}); totals can differ slightly from the official daily report. ` +
      `Period ${from}..${to}${cf ? `, compared with ${cf}..${ct}` : ""}. ${rows0.length} ${by} values in total.` };
}

// get_customers: pets, new pets, owners, bills and average bill (clinic)
async function getCustomers(a: Row, latest: string): Promise<Omit<ToolResult, "id">> {
  const us = units(a.units), from = dateArg(a.from, "from", latest)!, to = dateArg(a.to, "to", latest)!;
  const cf = dateArg(a.compare_from, "compare_from", latest, true), ct = dateArg(a.compare_to, "compare_to", latest, true);
  const byUnit = !!a.by_unit;
  const q = (f: string, t: string) => db`select ${byUnit ? db`sales_unit` : db`'TOTAL'::text`} as unit,
      count(distinct pet_key)::int pets, count(distinct pet_key) filter (where pet_category_split = 'New Pets')::int new_pets,
      count(distinct owner_key)::int owners, count(distinct invoice_no)::int bills, sum(amount)::float8 sales
    from vetbuddy.v_vetbuddy_pbi_bot where sale_date between ${f}::date and ${t}::date and sales_unit = any(string_to_array(${uList(us)}, '|'))
    group by 1`;
  const [cur, cmp] = await Promise.all([q(from, to), cf && ct ? q(cf, ct) : Promise.resolve([])]);
  const cm = new Map((cmp as unknown as Row[]).map((r) => [String(r.unit), r]));
  const rows = (cur as unknown as Row[]).map((r): Row => {
    const c = cm.get(String(r.unit)), bills = Number(r.bills), avg = bills ? Number(r.sales) / bills : null;
    const cAvg = c && Number(c.bills) ? Number(c.sales) / Number(c.bills) : null;
    return { unit: r.unit === "TOTAL" ? "TOTAL" : titleUnit(String(r.unit)), pets: r.pets, new_pets: r.new_pets, repeat_pets: Number(r.pets) - Number(r.new_pets),
      owners: r.owners, bills, avg_bill: r0(avg),
      ...(c ? { compare_pets: c.pets, pets_growth_pct: growth(Number(r.pets), Number(c.pets)), compare_avg_bill: r0(cAvg), avg_bill_growth_pct: growth(avg, cAvg) } : {}) };
  }).sort((x, y) => Number(y.pets) - Number(x.pets));
  return { title: `Pets and bills - ${placeLabel(us)}, ${rangeLabel(from, to)}`, rows,
    info: `Clinic (VetBuddy) visits only. new_pets = pets whose first visit ever is in this period. Period ${from}..${to}${cf ? `, compared with ${cf}..${ct}` : ""}.` };
}

// get_camp_performance: camps from the Camp Master (SharePoint -> vetbuddy.camp_master) and how their items sold
async function getCamp(a: Row, latest: string): Promise<Omit<ToolResult, "id">> {
  const name = String(a.camp ?? "").trim();
  const camps = await db`select camp_name, array_agg(distinct d order by d)::text[] dates, string_agg(distinct camp_type, ' + ') types
    from vetbuddy.camp_master, unnest(camp_dates) d where (${name} = '' or camp_name ilike ${"%" + name + "%"}) group by 1` as unknown as Row[];
  if (!camps.length) throw new ToolInputError(name ? `No camp called "${name}" in the Camp Master.` : "The Camp Master has no camps yet.");
  const want = a.date ? dateArg(a.date, "date", latest) : null;
  const c = camps.find((x) => !want || (x.dates as string[]).includes(want)) ?? camps[0];
  const cname = String(c.camp_name);
  const all = (c.dates as string[]).map((d) => String(d).slice(0, 10));
  const done = all.filter((d) => d <= latest);
  if (!done.length) {
    return { title: `${cname} - not started yet`, rows: [], info: `${cname} (${c.types}) runs on ${all.map((d) => rangeLabel(d, d)).join(", ")}; no camp day has data yet (data up to ${latest}).` };
  }
  const day1 = want && done.includes(want) ? want : done[done.length - 1];
  const items = String(a.view ?? "") === "items";
  const days = items ? [day1, addDays(day1, -7)] : done.flatMap((d) => [d, addDays(d, -7)]);
  // camp-item sales on the camp days and on the same weekday one week before (same items, same units)
  const q = items
    ? db`select s.sale_date::text d, m.item k, m.locations loc, sum(s.amount)::float8 amt, sum(s.qty)::float8 qty, count(distinct s.bill_no)::int bills
        from vetbuddy.v_all_sales s join vetbuddy.camp_master m on m.camp_name = ${cname} and s.sales_unit = any(m.units)
          and exists (select 1 from unnest(m.match_keywords) k where s.item_name ilike '%' || k || '%')
        where s.sale_date = any(string_to_array(${days.join("|")}, '|')::date[]) group by 1, 2, 3`
    : db`select s.sale_date::text d, 'camp' k, '' loc, sum(s.amount)::float8 amt, sum(s.qty)::float8 qty, count(distinct s.bill_no)::int bills
        from vetbuddy.v_all_sales s
        where s.sale_date = any(string_to_array(${days.join("|")}, '|')::date[]) and exists (select 1 from vetbuddy.camp_master m, unnest(m.match_keywords) k
          where m.camp_name = ${cname} and s.sales_unit = any(m.units) and s.item_name ilike '%' || k || '%') group by 1`;
  const [rows0, tot] = await Promise.all([q, db`select sale_date::text d, sum(total)::float8 t from vetbuddy.sheet_daily where sale_date = any(string_to_array(${days.join("|")}, '|')::date[]) group by 1`]);
  const R = rows0 as unknown as Row[], T = new Map((tot as unknown as Row[]).map((r) => [String(r.d), Number(r.t)]));
  const get = (d: string, k: string, loc = "") => R.find((r) => r.d === d && r.k === k && (r.loc ?? "") === loc);
  let rows: Row[];
  if (items) {
    const keys = [...new Set(R.filter((r) => r.d === day1).map((r) => `${r.k}|${r.loc}`))];
    rows = keys.map((kl) => {
      const [k, loc] = kl.split("|"), cur = get(day1, k, loc), prev = get(addDays(day1, -7), k, loc);
      return { item: k, locations: loc, sales: r0(Number(cur?.amt ?? 0)), qty: r0(Number(cur?.qty ?? 0)), bills: Number(cur?.bills ?? 0),
        week_before_sales: r0(Number(prev?.amt ?? 0)), week_before_qty: r0(Number(prev?.qty ?? 0)) } as Row;
    }).sort((x, y) => Number(y.sales) - Number(x.sales));
  } else {
    rows = done.map((d) => {
      const cur = get(d, "camp"), prev = get(addDays(d, -7), "camp"), cs = Number(cur?.amt ?? 0), ps = Number(prev?.amt ?? 0);
      const td = T.get(d) ?? null, tp = T.get(addDays(d, -7)) ?? null;
      return { camp_day: rangeLabel(d, d), camp_item_sales: r0(cs), camp_bills: Number(cur?.bills ?? 0), camp_qty: r0(Number(cur?.qty ?? 0)),
        same_items_week_before: r0(ps), week_before_bills: Number(prev?.bills ?? 0), week_before_qty: r0(Number(prev?.qty ?? 0)),
        camp_items_growth_pct: growth(cs, ps), total_sales_that_day: r0(td), total_week_before: r0(tp),
        total_growth_pct: growth(td, tp), camp_share_pct: td ? r1((cs * 100) / td) : null } as Row;
    });
  }
  const list = await db`select item, locations, original_price::float8, camp_price::float8 from vetbuddy.camp_master where camp_name = ${cname} order by row_no`;
  return { title: items ? `${cname} - item-wise, ${rangeLabel(day1, day1)} vs a week before` : `${cname} - camp days`, rows,
    info: `${cname} (${c.types}); camp dates: ${all.map((d) => rangeLabel(d, d)).join(", ")}. Camp items: ` +
      (list as unknown as Row[]).map((r) => `${r.item} (${r.locations}${r.camp_price ? `, camp Rs ${inr(Number(r.camp_price))}` : ""}${r.original_price ? ` vs Rs ${inr(Number(r.original_price))}` : ""})`).join("; ") +
      `. Camp prices are discounted, so camp-item value can fall while volume (qty, bills) rises; extra visits also lift other sales. Sales of camp items are matched by item name in the camp's units and compared with the same weekday one week before. Data up to ${latest}.` };
}

// run_sql: the agent's own read-only query for anything the other tools don't cover
const SCHEMA = `Schema vetbuddy. sheet_daily(sale_date,unit,total,vetbuddy,gofrugal); sheet_kpi(month,unit,mtd,target,month_estimate,required_per_day,...; unit 'TOTAL');
v_all_sales(sale_date,source 'VetBuddy'|'Pharmacy',bill_no,item_name,plan_category,plan_subcategory,species,qty,amount,sales_unit,doctor);
v_vetbuddy_pbi_bot(sale_date,invoice_no,item_name,plan_category,amount,sales_unit,doctor,species,breed,pet_key,owner_key,pet_category,pet_category_split,first_visit_date,last_visit_date,last_vaccination_visit,vaccination_status,bathing_status,haircut_status,services_due,is_night_service).
Vaccination plan_category ILIKE 'Vaccination%'; surgery plan_subcategory='Surgery'. One SELECT, no semicolon, compute derived numbers in SQL, LIMIT 25.`;
async function runSqlTool(a: Row): Promise<Omit<ToolResult, "id">> {
  const clean = String(a.sql ?? "").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(clean) || clean.includes(";")) throw new ToolInputError("Only one SELECT (or WITH) query, without semicolons.");
  const rows = await db.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '20s'");
    return await tx.unsafe(`select * from (${clean}) as _q limit 60`);
  }) as unknown as Row[];
  const norm = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
    v instanceof Date ? ymd(v) : typeof v === "string" && ALL_UNITS.includes(v) ? titleUnit(v)
      : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16 ? Number(v) : v])));
  return { title: String(a.purpose || "Query result").slice(0, 80), rows: norm, info: `${rows.length} row(s)${rows.length === 60 ? " (first 60)" : ""}.` };
}

const TOOL_DEFS = [
  { type: "function", function: { name: "get_sales", description:
    "Official sales (the numbers management sees) for any day or period, optionally compared with another period, optionally split by unit. Use for: sales on a day, yesterday, a week, a month, totals, X vs Y comparisons, which unit did best or worst.",
    parameters: { type: "object", properties: {
      units: { type: "array", items: { type: "string" }, description: "Unit names, or city names (Chennai, Coimbatore, Madurai, Trichy - add 'clinics' or 'Vet on Wheels' to narrow), or ['all']. Default all." },
      from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      compare_from: { type: "string", description: "YYYY-MM-DD, only if a comparison is wanted" }, compare_to: { type: "string" },
      by_unit: { type: "boolean", description: "true = one row per unit (splits, rankings, best / worst)" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "get_month_status", description:
    "Month-to-date sales vs the monthly target: achieved %, projected month-end estimate, sales needed per remaining day, growth vs the same days last month. Use for target, pace and 'are we on track' questions.",
    parameters: { type: "object", properties: {
      units: { type: "array", items: { type: "string" }, description: "as in get_sales; default all" },
      month: { type: "string", description: "YYYY-MM; default the current month" },
      by_unit: { type: "boolean", description: "true = one row per unit" } } } } },
  { type: "function", function: { name: "get_breakdown", description:
    "What makes up or drives sales: split by category, subcategory, doctor, item, species, unit, day (trend), weekday or source (clinic vs pharmacy), with share % and an optional comparison period. Use for top-N lists, mix, 'what drove it', trends.",
    parameters: { type: "object", properties: {
      by: { type: "string", enum: Object.keys(DIMS) },
      units: { type: "array", items: { type: "string" } }, from: { type: "string" }, to: { type: "string" },
      compare_from: { type: "string" }, compare_to: { type: "string" },
      filter: { type: "string", description: "optional text filter on category / subcategory / item / species, e.g. 'Vaccination', 'Surgery', 'Canine'" },
      source: { type: "string", enum: ["all", "clinic", "pharmacy"] },
      top_n: { type: "integer", description: "rows to return (3-25), default 10" } }, required: ["by", "from", "to"] } } },
  { type: "function", function: { name: "get_customers", description:
    "Clinic customer metrics: pets seen, new vs repeat pets, owners, bills and average bill value, optionally compared and split by unit.",
    parameters: { type: "object", properties: {
      units: { type: "array", items: { type: "string" } }, from: { type: "string" }, to: { type: "string" },
      compare_from: { type: "string" }, compare_to: { type: "string" }, by_unit: { type: "boolean" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "get_camp_performance", description:
    "Camps / offers from the Camp Master (e.g. the Wednesday Camp): camp dates, items, camp prices, and how much the camp items sold on each camp day vs the same weekday a week before, with the camp's share of the day's total sales. view 'items' = item-wise for one camp day. Use whenever a camp day is involved or sales on a day look unusual.",
    parameters: { type: "object", properties: {
      camp: { type: "string", description: "camp name or part of it; empty = the camp on that date / the latest camp" },
      date: { type: "string", description: "YYYY-MM-DD camp day (optional)" },
      view: { type: "string", enum: ["days", "items"], description: "days (default) = every camp day so far; items = item-wise for one camp day" } } } } },
  { type: "function", function: { name: "run_sql", description:
    "Run your own read-only SQL when the other tools cannot answer (e.g. services due, vaccination status, a specific item or doctor detail, breeds, night services). " + SCHEMA,
    parameters: { type: "object", properties: { purpose: { type: "string", description: "short title of what this shows" }, sql: { type: "string" } }, required: ["purpose", "sql"] } } },
];

async function runTool(name: string, args: Row, latest: string): Promise<Omit<ToolResult, "id">> {
  switch (name) {
    case "get_sales": return await getSales(args, latest);
    case "get_month_status": return await getMonthStatus(args);
    case "get_breakdown": return await getBreakdown(args, latest);
    case "get_customers": return await getCustomers(args, latest);
    case "get_camp_performance": return await getCamp(args, latest);
    case "run_sql": return await runSqlTool(args);
    default: throw new ToolInputError(`Unknown tool ${name}`);
  }
}

// the tool result as the AI sees it: formatted numbers (Indian commas, %), compact CSV
function fmtCell(col: string, v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") return /pct|percent/i.test(col) ? pc(v) : inr(v, Number.isInteger(v) ? 0 : 1);
  return String(v).replace(/[\n,]/g, " ").slice(0, 70);
}
function forModel(t: ToolResult) {
  if (t.error) return `${t.id} ERROR: ${t.error}`;
  if (!t.rows.length) return `${t.id} "${t.title}": no rows. ${t.info}`;
  const cols = Object.keys(t.rows[0]);
  return `${t.id} "${t.title}"\n${t.info}\n${cols.join(",")}\n` + t.rows.slice(0, 26).map((r) => cols.map((c) => fmtCell(c, r[c])).join(",")).join("\n");
}

// ---------------------------------------------------------------------------
// accuracy check: every number in a reply must be traceable to tool results / the conversation
// ---------------------------------------------------------------------------
function claimed(text: string): { raw: string; value: number; dec: number }[] {
  const out: { raw: string; value: number; dec: number }[] = [];
  const re = /(?<![\w.\/:-])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*(?:lakhs?|lacs?|l\b|cr\b|crores?|%|k\b))?/gi;
  for (const m of text.matchAll(re)) {
    const unit = (m[2] || "").trim().toLowerCase();
    let v = Number(m[1].replace(/,/g, ""));
    if (!isFinite(v)) continue;
    if (!unit && !m[1].includes(",") && !m[1].includes(".") && v <= 31) continue;      // days, counts, dates
    if (!unit && v >= 1900 && v <= 2100 && !m[1].includes(",")) continue;                // years
    let dec = (m[1].split(".")[1] || "").length;
    if (unit === "k") { v *= 1000; dec = Math.max(0, dec - 3); }
    out.push({ raw: m[0].trim(), value: v, dec });
  }
  return out;
}
function numberPool(sets: Row[][], extra: string[]): number[] {
  const out: number[] = [];
  const add = (n: number) => out.push(n, Math.abs(n), n / 1e5, Math.abs(n) / 1e5, n / 1e7, n * 100);
  for (const rows of sets) for (const r of rows.slice(0, 80)) for (const v of Object.values(r)) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    if (isFinite(n)) add(n);
  }
  for (const t of extra) for (const c of claimed(t)) add(c.value);
  return out;
}
let basePool: number[] = [];          // raw tool numbers of the current answer, for the arithmetic check
function derivable(v: number, tol: number): boolean {
  const b = basePool.filter((x) => isFinite(x) && x !== 0).slice(0, 400);
  for (let i = 0; i < b.length; i++) for (let j = 0; j < b.length; j++) {
    if (i === j) continue;
    const x = b[i], y = b[j];
    if (Math.abs(Math.abs(x - y) - v) <= tol || Math.abs(x + y - v) <= tol || Math.abs((x * 100) / y - v) <= Math.max(tol, 0.05) ||
        Math.abs(((x - y) * 100) / Math.abs(y) - v) <= Math.max(tol, 0.05) || Math.abs(Math.abs(((x - y) * 100) / y) - v) <= Math.max(tol, 0.05) ||
        Math.abs(Math.abs(x - y) / 1e5 - v) <= tol || Math.abs(x / y - v) <= Math.max(tol, 0.05)) return true;
  }
  return false;
}
function unsupportedIn(text: string, pool: number[]): string[] {
  const bad = new Set<string>();
  for (const c of claimed(text)) {
    const tol = Math.max(0.5 * Math.pow(10, -c.dec), Math.abs(c.value) * 0.001);
    if (!pool.some((p) => Math.abs(p - c.value) <= tol + 1e-9) && !derivable(c.value, tol + 1e-9)) bad.add(c.raw);
  }
  return [...bad];
}
function stripUnsupported(text: string, pool: number[]) {
  return text.split("\n").map((ln) => unsupportedIn(ln, pool).length
    ? ln.split(/(?<=[.!?])\s+/).filter((s) => !unsupportedIn(s, pool).length).join(" ") : ln)
    .filter((ln, i, a) => ln.trim() || (i > 0 && a[i - 1].trim())).join("\n").trim();
}

// ---------------------------------------------------------------------------
// AI: Groq chat with tools; on a limit / error the next model continues the same conversation
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// seconds Groq asks us to wait after a per-minute limit ("Please try again in 7.4s" / retry-after header)
function waitSecs(r: Response, t: string): number {
  const h = Number(r.headers.get("retry-after"));
  const m = t.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : isFinite(h) && h > 0 ? h : 60;
}

async function chat(messages: Msg[], useTools: boolean, startAt: number, maxTokens = 1200, deadline = Date.now() + 90_000):
  Promise<{ msg: Msg; tokens: number; model: string; index: number }> {
  const errs: string[] = [];
  let limited = 0;
  const order = AGENT_MODELS.map((_m, k) => (startAt + k) % AGENT_MODELS.length);   // current model first, then the others
  const waits: { i: number; at: number }[] = [];
  const attempt = async (i: number): Promise<{ msg: Msg; tokens: number; model: string; index: number } | number | null> => {
    const model = AGENT_MODELS[i];
    const body: Row = { model, messages, temperature: 0.3, max_completion_tokens: maxTokens,
      ...(useTools ? { tools: TOOL_DEFS, tool_choice: "auto" } : {}) };
    if (model.includes("gpt-oss")) { body.reasoning_effort = "low"; body.include_reasoning = false; }
    else if (model.includes("qwen")) { body.reasoning_format = "hidden"; }
    let r: Response;
    try {
      r = await fetch(GROQ_URL, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${AI_KEY}`, "Content-Type": "application/json" } });
    } catch (e) { errs.push(`${model.split("/").pop()} ${String(e).slice(0, 60)}`); return null; }
    if (r.status === 429) {
      const t = await r.text();
      limited++; errs.push(`${model.split("/").pop()} limit`);
      console.error("ai 429", model, t.slice(0, 200));
      return /per day|TPD|RPD/i.test(t) ? null : waitSecs(r, t);          // daily limit: skip; per-minute: wait time
    }
    if (!r.ok) {
      const t = await r.text();
      console.error("ai", model, r.status, t.slice(0, 300));
      errs.push(`${model.split("/").pop()} ${r.status} ${(t.match(/"code"\s*:\s*"([^"]+)"/) ?? [])[1] ?? ""}`);
      return null;
    }
    const j = await r.json();
    const tokens = j.usage?.total_tokens ?? 0;
    await usage(tokens);
    const m = j.choices?.[0]?.message ?? {};
    const content = typeof m.content === "string" ? m.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim() : "";
    if (!content && !m.tool_calls?.length) { errs.push(`${model.split("/").pop()} empty`); return null; }
    return { msg: { role: "assistant", content: content || null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) }, tokens, model, index: i };
  };
  for (const i of order) {
    const out = await attempt(i);
    if (out && typeof out === "object") return out;
    if (typeof out === "number") waits.push({ i, at: Date.now() + out * 1000 });
  }
  // every model was at its per-minute limit: wait for the first one to free up (if there is time), then retry
  for (const w of waits.sort((a, b) => a.at - b.at)) {
    const ms = w.at - Date.now() + 500;
    if (Date.now() + ms > deadline - 15_000) break;
    if (ms > 0) await sleep(ms);
    const out = await attempt(w.i);
    if (out && typeof out === "object") return out;
  }
  if (limited) throw new LimitError("The AI is getting a lot of questions right now. Please ask again in a minute - the daily report buttons below still work.");
  throw new Error("AI unavailable: " + errs.join("; "));
}

const AGENT_SYSTEM = `You are "Sanchu Sales", the AI business analyst in the Sanchu Pet Hospitals management team's Teams chat. Sanchu runs veterinary clinics (Adyar, Neelangarai, Anna Nagar, Velachery and Valasaravakkam in Chennai; Coimbatore; Madurai; Trichy), a pharmacy, and Vet on Wheels home-visit units (Chennai, Coimbatore, Madurai, Trichy).

WHO YOU ARE
- You talk like a capable, warm and professional colleague: natural, confident, concise. You are an AI assistant - if asked, say so plainly; never claim to be a person.
- Hold a real conversation. Use the conversation so far to understand "it", "that clinic", "same for last month", "why?", "and Madurai?". If a request is genuinely ambiguous, ask one short question instead of guessing.
- Greetings, thanks, small talk, "what can you do", drafting a message: reply directly without tools (for a greeting you may fetch one headline figure).

WORKING WITH DATA
- Every business number you state must come from a tool result in this conversation. Never guess, estimate or calculate a number yourself - the tools compute totals, comparisons, growth %, shares and averages. If you need a number the tools did not give, call a tool.
- Choose tools like an analyst: get_sales (official sales for a day or period, comparisons, unit split), get_month_status (MTD vs target, estimate, required per day), get_breakdown (category / doctor / item / species / unit / day / clinic-vs-pharmacy mix and drivers), get_customers (pets, new pets, bills, average bill), run_sql (anything else).
- Simple question: usually one tool call. "Why", "what drove it", "insights", "analyse": first get the movement, then break down the biggest contributors (2-4 tool calls), and explain the cause with numbers. When you already know which views you need, request them together in one step (several tool calls at once) - it is faster.
- Dates: use the CONTEXT dates. "yesterday" = the day before today. "today" = today (usually not loaded yet). "this month" / "MTD" = 1st of this month to the latest data day. "last week" alone = the previous Monday-Sunday. "<day> vs last week" = the same weekday one week earlier. "<period> vs last month" = the same dates last month. If asked about a day after the latest data day, say that data isn't in yet and offer the latest day.
- Camps: the CONTEXT lists camps and their days. When asked why a day was high or low, first check whether it was a camp day; if so quantify the camp's contribution (get_camp_performance) next to the overall movement.
- Places: a city means its clinic(s) plus its Vet on Wheels unless they say clinic or Vet on Wheels only. No place = the whole division.

HOW YOU REPLY
- The first sentence is the answer, with the key figure in **bold**, naming the unit and the exact date or period, e.g. "Anna Nagar did **Rs 98,596** on Sun, 2 Nov, 12.4% more than the previous Sunday."
- Simple question: 1-3 sentences, no bullets. Insights / why / analysis: one answer line, then 3-5 short "- " bullets with the drivers (each with its number), then one practical suggestion.
- Money as Rs with Indian commas exactly as the tools show; percentages as shown; unit names in Title Case; dates like "Tue, 10 Nov" or "1-10 Nov". No emojis, no slang, no headings. Never mention tools, SQL, queries, models or tokens.
- Do not add comparisons, splits or extra numbers that were not asked for.
- To attach a table, add on its own line at the end: TABLE: R<n> | <title>  - only when they asked for a split, list, ranking, breakdown or comparison across units (max 2 tables).
- Always finish with one line: FOLLOWUPS: <question> | <question>  - two short, specific next questions they are likely to ask (max 7 words each).`;

type AgentOut = { text: string; tables: { title: string; rows: Row[] }[]; followups: string[]; tools: string[]; models: string[]; tokens: number; checked: string };

async function agent(question: string, who: string, conv: string): Promise<AgentOut> {
  const used = await usage();
  if (used.tokens >= DAILY_CAP) throw new LimitError("Today's AI allowance is used up. The daily report buttons below still work.");
  const [latest, hist, rl] = await Promise.all([latestDay(), turns(conv), rules()]);
  const campRows = await db`select camp_name, string_agg(distinct camp_type, ' + ') types, array_agg(distinct d order by d)::text[] dates
    from vetbuddy.camp_master, unnest(camp_dates) d where d between ${addDays(latest, -60)}::date and ${addDays(latest, 30)}::date group by 1`
    .catch(() => []) as unknown as Row[];
  const campText = campRows.length ? campRows.map((c) => `${c.camp_name} (${c.types}): ${(c.dates as string[]).map((d) => rangeLabel(d, d)).join(", ")}`).join("; ")
    : "none recorded";
  const name = firstName(who);
  const system = AGENT_SYSTEM +
    `\n\nCONTEXT\nNow: ${istNow()}. Today: ${istDate()}. Latest data day loaded: ${latest} (${wday(latest)}).\n` +
    `Talking to: ${name ? `${name} (use the first name only in a greeting)` : "a shared team account - don't address anyone by name"}.\n` +
    `Units: ${ALL_UNITS.join(", ")}.\nCAMPS / OFFERS (Camp Master): ${campText}. A camp day usually lifts the camp items; when a day with a camp is asked about (or looks unusual), check get_camp_performance.` +
    (rl.length ? `\n\nHOUSE RULES - always follow these; they override everything above:\n${rl.map((r) => "- " + r.rule).join("\n")}` : "");
  const messages: Msg[] = [{ role: "system", content: system },
    ...hist.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.text })), { role: "user", content: question }];
  const results: ToolResult[] = [], toolsUsed: string[] = [], models = new Set<string>();
  let tokens = 0, idx = 0, final = "";
  const t0 = Date.now();
  for (let round = 0; round < 6; round++) {
    const late = round === 4 || Date.now() - t0 > 75_000;
    const out = await chat(messages, !late, idx, 1200, t0 + 110_000);
    idx = out.index; tokens += out.tokens; models.add(out.model);
    const calls = out.msg.tool_calls ?? [];
    if (!calls.length || late) { final = out.msg.content ?? ""; break; }
    messages.push(out.msg);
    for (const [k, c] of calls.entries()) {
      if (k >= 4) { messages.push({ role: "tool", tool_call_id: c.id, name: c.function?.name, content: "Skipped: at most 4 tool calls at a time." }); continue; }
      // deno-lint-ignore no-explicit-any
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* empty */ }
      const id = `R${results.length + 1}`;
      let res: ToolResult;
      try { res = { id, ...(await runTool(String(c.function?.name), args, latest)) }; }
      catch (e) {
        const msg = e instanceof ToolInputError ? e.message : String((e as Error).message).slice(0, 220);
        console.error("tool", c.function?.name, msg);
        res = { id, title: String(c.function?.name), rows: [], info: "", error: msg };
      }
      results.push(res); toolsUsed.push(`${c.function?.name}${res.error ? "(error)" : ""}`);
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function?.name, content: forModel(res) });
    }
  }
  if (!final) { const out = await chat(messages, false, idx, 1200, t0 + 120_000); tokens += out.tokens; models.add(out.model); final = out.msg.content ?? ""; }

  // accuracy check
  const pool = numberPool(results.map((r) => r.rows), [question, ...hist.map((h) => h.text), latest, istDate()]);
  basePool = results.flatMap((r) => r.rows.slice(0, 40).flatMap((row) => Object.values(row).filter((v): v is number => typeof v === "number")));
  let checked = results.length ? "numbers checked" : "";
  const body = (t: string) => t.split("\n").filter((l) => !/^\s*\**(TABLE|FOLLOW-?UPS?)\**\s*:/i.test(l)).join("\n");
  let bad = unsupportedIn(body(final), pool);
  if (bad.length) {
    try {
      const fix = await chat([...messages, { role: "assistant", content: final }, { role: "user", content:
        `(Internal check, not from the user) These numbers in your reply are not in the tool results: ${bad.join(", ")}. ` +
        `Rewrite the same reply using only numbers from the tool results (or leave them out). Keep the same format, TABLE and FOLLOWUPS lines.` }], false, idx, 1200, t0 + 125_000);
      tokens += fix.tokens; models.add(fix.model);
      if (fix.msg.content) final = fix.msg.content;
    } catch { /* strip below */ }
    bad = unsupportedIn(body(final), pool);
    if (bad.length) { console.error("unverified", bad.join(", "), "|", final.slice(0, 600)); final = stripUnsupported(final, pool); checked = "unverified figures removed"; }
  }

  // TABLE / FOLLOWUPS lines
  const tables: { title: string; rows: Row[] }[] = [];
  let followups: string[] = [];
  const lines: string[] = [];
  for (const ln of final.split("\n")) {
    const tm = ln.match(/^\s*\**TABLE\**\s*:\s*R(\d+)\s*(?:\|\s*(.+))?$/i);
    const fm = ln.match(/^\s*\**FOLLOW-?UPS?\**\s*:\s*(.+)$/i);
    if (tm) { const r = results[Number(tm[1]) - 1]; if (r && r.rows.length && tables.length < 2) tables.push({ title: (tm[2] || r.title).trim(), rows: r.rows }); }
    else if (fm) followups = fm[1].split("|").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s && s.length <= 80).slice(0, 2);
    else lines.push(ln);
  }
  const text = lines.join("\n").replace(/\(?\bR\d+\b\)?/g, "").replace(/[ \t]+([.,])/g, "$1").replace(/\n{3,}/g, "\n\n").trim() ||
    "Sorry, I couldn't put that together. Could you rephrase it?";
  return { text, tables, followups, tools: toolsUsed, models: [...models], tokens, checked };
}

// ---------------------------------------------------------------------------
// DAILY REPORT buttons - answered from code (instant, no AI)
// ---------------------------------------------------------------------------
type Reply = { text: string; tables: { title: string; rows: Row[] }[]; followups: string[]; note?: string };
const REPORT_BUTTONS = ["Yesterday's sales", "Month to date vs target", "Units behind target", "Last 7 days trend"];
const REPORTS: Record<string, string> = Object.fromEntries(REPORT_BUTTONS.map((b, i) => [b.toLowerCase(), ["yesterday", "mtd", "behind", "week"][i]]));
const reportCache = new Map<string, { at: number; reply: Reply }>();

async function report(kind: string): Promise<Reply> {
  const latest = await latestDay();
  const key = kind + latest, hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.reply;
  let reply: Reply;
  if (kind === "yesterday") {
    const prev = addDays(latest, -7);
    const s = await getSales({ units: ["all"], from: latest, to: latest, compare_from: prev, compare_to: prev, by_unit: true }, latest);
    const T = s.rows[s.rows.length - 1], per = s.rows.slice(0, -1).filter((r) => Number(r.sales) > 0);
    const best = per[0];
    const grow = per.filter((r) => r.growth_pct !== null).sort((a, b) => Number(b.growth_pct) - Number(a.growth_pct));
    reply = { text: `**Sales on ${rangeLabel(latest, latest)}: ${rs(T.sales)}** (clinic ${rs(T.clinic)}, pharmacy ${rs(T.pharmacy)}), ` +
      `${pc(T.growth_pct)} vs ${rangeLabel(prev, prev)} (${rs(T.compare_sales)}).` +
      (best ? `\n\nTop unit: **${best.unit}** with ${rs(best.sales)}.` : "") +
      (grow.length > 1 ? ` Biggest rise: ${grow[0].unit} (${pc(grow[0].growth_pct)}); biggest drop: ${grow[grow.length - 1].unit} (${pc(grow[grow.length - 1].growth_pct)}).` : ""),
      tables: [{ title: `Unit-wise, ${rangeLabel(latest, latest)} vs ${rangeLabel(prev, prev)}`,
        rows: s.rows.map((r) => ({ unit: r.unit, sales: r.sales, same_day_last_week: r.compare_sales, growth_pct: r.growth_pct, share_pct: r.share_pct })) }],
      followups: [`What drove sales on ${dm(latest)}?`, `Category mix on ${dm(latest)}`] };
  } else if (kind === "mtd" || kind === "behind") {
    const m = await getMonthStatus({ units: ["all"], by_unit: true });
    const T = m.rows[m.rows.length - 1], per = m.rows.slice(0, -1).filter((r) => r.target);
    const days = (m.info.match(/(\d+) days done, (\d+) days left/) ?? []).slice(1);
    if (kind === "mtd") {
      reply = { text: `**Month to date: ${rs(T.mtd)}**, ${pc(T.achieved_pct, false)} of the ${rs(T.target)} target` +
        (days.length ? ` with ${days[0]} days done and ${days[1]} to go.` : ".") +
        `\n\nAt the current pace the month ends at ${rs(T.month_estimate)} (${pc(T.estimate_pct, false)} of target); ` +
        `${rs(T.required_per_day)} a day is needed from here. Versus the same days last month: ${pc(T.growth_pct)}.`,
        tables: [{ title: "Unit-wise month to date", rows: m.rows.map((r) => ({ unit: r.unit, mtd: r.mtd, target: r.target, achieved_pct: r.achieved_pct,
          estimate_pct: r.estimate_pct, growth_pct: r.growth_pct })) }],
        followups: ["Which category is behind this month?", "Top doctors this month"] };
    } else {
      const behind = per.filter((r) => r.estimate_pct !== null && Number(r.estimate_pct) < 100).sort((a, b) => Number(a.estimate_pct) - Number(b.estimate_pct));
      reply = { text: behind.length
        ? `**${behind.length} of ${per.length} units** are on course to miss their target this month. Furthest behind: ` +
          behind.slice(0, 3).map((r) => `**${r.unit}** (estimate ${pc(r.estimate_pct, false)} of target; needs ${rs(r.required_per_day)} a day vs ${rs(r.avg_daily_sales)} now)`).join("; ") + "."
        : `All ${per.length} units are on course to reach their target this month.`,
        tables: behind.length ? [{ title: "Units projected below target", rows: behind.map((r) => ({ unit: r.unit, mtd: r.mtd, target: r.target,
          estimate_pct: r.estimate_pct, required_per_day: r.required_per_day, avg_daily_sales: r.avg_daily_sales })) }] : [],
        followups: behind.length ? [`Why is ${behind[0].unit} behind target?`, `${behind[0].unit} category mix this month`] : ["Top units this month"] };
    }
  } else {
    const from = addDays(latest, -6), pf = addDays(latest, -13), pt = addDays(latest, -7);
    const [s, d] = await Promise.all([
      getSales({ units: ["all"], from, to: latest, compare_from: pf, compare_to: pt }, latest),
      db`select a.sale_date::text d, sum(a.total)::float8 t,
           (select sum(b.total) from vetbuddy.sheet_daily b where b.sale_date = a.sale_date - 7)::float8 p
         from vetbuddy.sheet_daily a where a.sale_date between ${from}::date and ${latest}::date group by a.sale_date order by a.sale_date`]);
    const T = s.rows[0];
    const days = (d as unknown as Row[]).map((r) => ({ day: rangeLabel(String(r.d), String(r.d)), sales: r0(Number(r.t)),
      same_day_last_week: r.p === null ? null : r0(Number(r.p)), growth_pct: growth(Number(r.t), r.p === null ? null : Number(r.p)) }));
    const best = [...days].sort((a, b) => Number(b.sales) - Number(a.sales))[0], worst = [...days].sort((a, b) => Number(a.sales) - Number(b.sales))[0];
    reply = { text: `**Last 7 days (${rangeLabel(from, latest)}): ${rs(T.sales)}**, ${pc(T.growth_pct)} vs the 7 days before (${rs(T.compare_sales)}), ` +
      `${rs(T.avg_per_day)} a day on average.` + (best ? `\n\nBest day: ${best.day} (${rs(best.sales)}); slowest: ${worst.day} (${rs(worst.sales)}).` : ""),
      tables: [{ title: "Day by day vs the same day last week", rows: days }], followups: ["Unit-wise sales last 7 days", "What drove this week's change?"] };
  }
  reply.note = `Daily report · data up to ${rangeLabel(latest, latest)}`;
  reportCache.set(key, { at: Date.now(), reply });
  return reply;
}

// ---------------------------------------------------------------------------
// conversation memory (vetbuddy.bot_turns) and log (vetbuddy.bot_log)
// ---------------------------------------------------------------------------
async function turns(conv: string): Promise<{ role: string; text: string }[]> {
  if (!conv) return [];
  try {
    const r = await db`select role, text from vetbuddy.bot_turns where conversation = ${conv} and at > now() - interval '3 hours' order by at desc limit 12`;
    return (r as unknown as { role: string; text: string }[]).reverse();
  } catch { return []; }
}
async function addTurns(conv: string, ...t: [string, string][]) {
  if (!conv) return;
  try {
    await db.begin("read write", async (tx) => {
      for (const [role, text] of t) if (text) await tx`insert into vetbuddy.bot_turns (conversation, role, text) values (${conv}, ${role}, ${text.slice(0, 900)})`;
      if (Math.random() < 0.05) await tx`delete from vetbuddy.bot_turns where at < now() - interval '14 days'`;
    });
  } catch (e) { console.error("bot_turns", String(e).slice(0, 150)); }
}
async function clearTurns(conv: string) {
  try { await db.begin("read write", (tx) => tx`delete from vetbuddy.bot_turns where conversation = ${conv}`); } catch { /* ignore */ }
}
async function logTurn(l: { conv: string; who: string; q: string; reply?: string; tools?: string[]; models?: string[]; tokens?: number; ms: number; ok: boolean; error?: string }) {
  try {
    await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_log (conversation, who, question, reply, tools, models, tokens, ms, ok, error)
      values (${l.conv}, ${l.who}, ${l.q.slice(0, 1000)}, ${(l.reply ?? "").slice(0, 2000)}, ${tx.json(l.tools ?? [])}, ${(l.models ?? []).join(",")},
              ${l.tokens ?? 0}, ${l.ms}, ${l.ok}, ${l.error ?? null})`);
  } catch (e) { console.error("bot_log", String(e).slice(0, 150)); }
}

// ---------------------------------------------------------------------------
// Teams card
// ---------------------------------------------------------------------------
function colTitle(c: string): string {
  const t = c.replace(/_pct$/, " %").replace(/_/g, " ").replace(/\bmtd\b/g, "MTD").replace(/\bavg\b/g, "avg");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function cell(col: string, v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") return /pct/i.test(col) ? pc(v) : inr(v, Number.isInteger(v) ? 0 : 1);
  const s = String(v);
  return s.length > 50 ? s.slice(0, 47) + "..." : s;
}
function table(rows: Row[]) {
  const cols = Object.keys(rows[0]).slice(0, 7);
  const isTot = (r: Row) => /^total$/i.test(String(r[cols[0]] ?? ""));
  return { type: "Table", firstRowAsHeaders: true, showGridLines: true, spacing: "Small",
    columns: cols.map((_c, i) => ({ width: i === 0 ? 2 : 1 })),
    rows: [
      { type: "TableRow", style: "accent", cells: cols.map((c, i) => ({ type: "TableCell",
        items: [{ type: "TextBlock", text: colTitle(c), weight: "Bolder", wrap: true, horizontalAlignment: i ? "Right" : "Left" }] })) },
      ...rows.slice(0, 25).map((r) => ({ type: "TableRow", style: isTot(r) ? "emphasis" : "default",
        cells: cols.map((c, i) => ({ type: "TableCell", items: [{ type: "TextBlock", text: cell(c, r[c]), wrap: true, weight: isTot(r) ? "Bolder" : "Default",
          horizontalAlignment: i ? "Right" : "Left",
          color: /growth/.test(c) && typeof r[c] === "number" && r[c] !== 0 ? (Number(r[c]) < 0 ? "Attention" : "Good") : "Default" }] })) })),
    ] };
}
function teamsText(t: string) {                   // Teams joins single line breaks; keep paragraphs and bullets
  const ls = t.split("\n");
  return ls.map((l, i) => (i === 0 ? "" : (/^\s*[-*\d]/.test(l) && /^\s*[-*\d]/.test(ls[i - 1]) ? "\n" : "\n\n")) + l).join("").replace(/\n{3,}/g, "\n\n");
}
const btn = (t: string) => ({ type: "Action.Submit", title: t.length > 50 ? t.slice(0, 47) + "..." : t, data: { msteams: { type: "messageBack", text: t, displayText: t } } });
function card(r: Reply) {
  const body: unknown[] = [{ type: "TextBlock", text: teamsText(r.text), wrap: true }];
  for (const t of r.tables) {
    body.push({ type: "TextBlock", text: t.title, weight: "Bolder", spacing: "Medium", wrap: true, size: "Small" });
    body.push(table(t.rows));
  }
  if (r.note) body.push({ type: "TextBlock", text: r.note, isSubtle: true, size: "Small", wrap: true, spacing: "Small" });
  if (r.followups.length) body.push({ type: "ActionSet", spacing: "Medium", actions: r.followups.slice(0, 2).map(btn) });
  body.push({ type: "TextBlock", text: "Daily report", isSubtle: true, size: "Small", spacing: "Medium", separator: true });
  body.push({ type: "ActionSet", spacing: "Small", actions: REPORT_BUTTONS.map(btn) });
  return { contentType: "application/vnd.microsoft.card.adaptive",
    content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.5", body, msteams: { width: "Full" } } };
}

// ---------------------------------------------------------------------------
// Bot Framework plumbing
// ---------------------------------------------------------------------------
const JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));
let botToken = { value: "", exp: 0 };
let tokenTenants = ["botframework.com", env("BOT_TENANT_ID")].filter(Boolean);   // multi- or single-tenant bot

async function outboundToken() {
  if (botToken.value && Date.now() < botToken.exp - 60e3) return botToken.value;
  const r = await fetch(`https://login.microsoftonline.com/${tokenTenants[0]}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env("BOT_APP_ID"),
      client_secret: env("BOT_APP_SECRET"), scope: "https://api.botframework.com/.default" }),
  });
  const j = await r.json();
  if (!j.access_token) {
    if (tokenTenants.length > 1 && !botToken.exp) { tokenTenants = tokenTenants.slice(1).concat(tokenTenants[0]); botToken.exp = -1; return outboundToken(); }
    throw new Error("bot login failed: " + (j.error_description || j.error));
  }
  botToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return botToken.value;
}
// deno-lint-ignore no-explicit-any
async function send(act: any, msg: Row) {
  const url = `${act.serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(act.conversation.id)}/activities` +
    (act.id ? `/${encodeURIComponent(act.id)}` : "");
  const r = await fetch(url, { method: "POST",
    headers: { Authorization: `Bearer ${await outboundToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", replyToId: act.id, ...msg, _retry: undefined }) });
  if (r.status === 401 && tokenTenants.length > 1 && !msg._retry) {
    tokenTenants = tokenTenants.slice(1).concat(tokenTenants[0]); botToken = { value: "", exp: 0 };
    return send(act, { ...msg, _retry: true });
  }
  if (!r.ok) console.error("send failed", r.status, await r.text());
}

// ---------------------------------------------------------------------------
// one message
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handle(act: any) {
  const conv = act.conversation?.id ?? "";
  const text = String(act.text ?? "").replace(/<at>.*?<\/at>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const cmd = text.toLowerCase().replace(/[!.?\s]+$/u, "").trim();
  const tenantOk = !env("BOT_TENANT_ID") || (act.conversation?.tenantId ?? act.channelData?.tenant?.id) === env("BOT_TENANT_ID");
  if (cmd === "chat id" && tenantOk) return send(act, { text: `This chat id is: ${conv}` });
  if (!tenantOk || (ALLOWED.length && !ALLOWED.includes(conv))) return send(act, { text: "Sorry, this bot only works in the Sanchu management team chat." });
  const who = String(act.from?.name ?? "").trim();
  const t0 = Date.now();

  // commands
  if (/^(reset|clear|new chat|new topic|start over|start fresh)$/.test(cmd)) {
    await clearTurns(conv);
    return send(act, { text: "Done - fresh start. What would you like to look at?" });
  }
  if (/^(rules|show rules|list rules|house rules)$/.test(cmd)) {
    const list = await rules();
    return send(act, { text: list.length ? "**House rules** (I always follow these):\n\n" + list.map((r, i) => `${i + 1}. ${r.rule}`).join("\n\n") +
      "\n\nAdd one with **add rule: never ...**, remove one with **remove rule 2**." : "No house rules yet. Add one with **add rule: never ...**" });
  }
  const addRule = text.match(/^\s*(?:add\s+)?rule\s*[:\-]\s*(.{5,300})$/i);
  if (addRule) {
    await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_rules (rule, created_by) values (${addRule[1].trim()}, ${who})`);
    rulesCache = null;
    return send(act, { text: `Rule added: "${addRule[1].trim()}". I'll follow it from now on. Type **rules** to see all of them.` });
  }
  const delRule = cmd.match(/^(?:remove|delete|drop)\s+rule\s+(\d+)$/);
  if (delRule) {
    const list = await rules(), r = list[Number(delRule[1]) - 1];
    if (!r) return send(act, { text: `There is no rule ${delRule[1]}. Type **rules** to see the list.` });
    await db.begin("read write", (tx) => tx`update vetbuddy.bot_rules set active = false where id = ${r.id}`);
    rulesCache = null;
    return send(act, { text: `Removed rule ${delRule[1]}: "${r.rule}".` });
  }
  if (cmd === "usage") {
    const u = await usage();
    const [l] = await db`select count(*)::int n, coalesce(round(avg(ms)/1000.0,1),0)::float8 s, count(*) filter (where not ok)::int e
      from vetbuddy.bot_log where at > now() - interval '24 hours'`.catch(() => [{ n: 0, s: 0, e: 0 }]);
    return send(act, { text: `Today: ${inr(u.tokens)} of ${inr(DAILY_CAP)} AI tokens used (${u.calls} AI calls). ` +
      `Last 24 hours: ${l.n} questions, ${l.s} s average reply time, ${l.e} errors.` });
  }
  if (/^(wrong|incorrect|not correct|that'?s wrong)$/.test(cmd)) {
    try {
      await db.begin("read write", (tx) => tx`update vetbuddy.bot_log set feedback = 'wrong'
        where id = (select id from vetbuddy.bot_log where conversation = ${conv} and ok order by at desc limit 1)`);
    } catch { /* ignore */ }
    return send(act, { text: "Thanks for flagging it - I've noted it for review. Tell me what looks off (the period, the unit or the figure) and I'll redo it." });
  }

  await send(act, { type: "typing" });
  // daily report buttons: instant, from code
  const rk = REPORTS[cmd];
  if (rk) {
    try {
      const r = await report(rk);
      await addTurns(conv, ["user", text], ["bot", r.text]);
      await logTurn({ conv, who, q: text, reply: r.text, tools: ["report:" + rk], ms: Date.now() - t0, ok: true });
      return send(act, { attachments: [card(r)] });
    } catch (e) {
      console.error("report", e);
      await logTurn({ conv, who, q: text, ms: Date.now() - t0, ok: false, error: String(e).slice(0, 300) });
      return send(act, { text: "Sorry, I couldn't build that report just now. Please try again in a minute." });
    }
  }
  // everything else: the AI analyst
  const said = text || "hi";
  try {
    const a = await agent(said, who, conv);
    const latest = await latestDay();
    await addTurns(conv, ["user", said], ["bot", a.text]);
    await logTurn({ conv, who, q: said, reply: a.text, tools: a.tools, models: a.models, tokens: a.tokens, ms: Date.now() - t0, ok: true });
    await send(act, { attachments: [card({ text: a.text, tables: a.tables, followups: a.followups,
      note: a.tools.length ? `Data up to ${rangeLabel(latest, latest)} · ${a.checked} · reply "wrong" if something is off` : undefined })] });
  } catch (e) {
    console.error("agent", e);
    await logTurn({ conv, who, q: said, ms: Date.now() - t0, ok: false, error: String((e as Error).message).slice(0, 300) });
    const msg = e instanceof LimitError ? e.message : "Sorry, something went wrong while I was working on that. Please try again, or use the daily report buttons below.";
    await send(act, { attachments: [card({ text: msg, tables: [], followups: [] })] });
  }
}

function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else p.catch(console.error);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const auth = req.headers.get("authorization") ?? "";
    await jwtVerify(auth.replace(/^Bearer\s+/i, ""), JWKS, { issuer: "https://api.botframework.com", audience: env("BOT_APP_ID") });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const act = await req.json();
  if (act.type === "message") background(handle(act));               // Teams wants a quick 200; answer in the background
  else if (act.type === "conversationUpdate" && act.membersAdded?.some((m: { id: string }) => m.id === act.recipient?.id)) {
    background(send(act, { attachments: [card({ text: "Hello everyone. I'm **Sanchu Sales**, the team's AI analyst. Ask me anything about the hospitals' " +
      "business in plain words - how a clinic is doing, why sales moved, doctors, items, pets, targets - and I'll dig into the data. " +
      "The daily report buttons below give you the standard numbers instantly.", tables: [], followups: [] })] }));
  }
  return new Response(null, { status: 200 });
});
