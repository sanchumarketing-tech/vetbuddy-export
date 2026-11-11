// =====================================================================
// Sanchu sales ANALYST bot for Microsoft Teams  (Supabase Edge Function "teams-bot")
//
// How a question is answered:
//  1. The bot reads the PLACE (city / clinic / VOW) and the PERIOD (MTD, yesterday, last month, ...) itself,
//     and keeps the conversation (follow-ups like "and Trichy?", "same for last month", "split by doctor").
//  2. PLAN   - an AI model plans 2-4 SQL queries like an analyst: the answer, a comparison (previous period /
//              last month / target) and the drill-down that explains it. Plans use placeholders and are
//              saved per question type, so the same kind of question later costs no planning tokens.
//  3. RUN    - the queries run read-only on Supabase; a failing query is repaired by a second model.
//  4. ANALYSE- a model writes the answer from the results and may ask for one more drill-down query.
//  5. CHECK  - every number in the answer is checked in code against the query results; a DIFFERENT model
//              rewrites unsupported claims, and anything still unsupported is removed.
//  0. ASSISTANT - every message first goes to an AI assistant that knows the conversation, who is asking, the
//              time of day and a live sales snapshot. It chats (greetings, help, ideas, drafting messages,
//              quick answers from the snapshot - numbers checked) or hands a self-contained question to 1-5.
//  Models (Groq, free): gpt-oss-120b, qwen3.8-27b, gpt-oss-20b - each step has its own order and falls back
//  to the next model when one hits its limit. The finished analysis is saved for the day (repeats: 0 tokens).
// Secrets (Supabase > Edge Functions > Secrets):
//   AI_API_KEY (Groq), BOT_DB_URL (vb_teams login), BOT_APP_ID, BOT_APP_SECRET, BOT_TENANT_ID,
//   ALLOWED_CONVERSATIONS, optional DAILY_TOKEN_CAP, AI_PLAN_MODELS / AI_ANALYZE_MODELS / AI_REVIEW_MODELS / AI_FIX_MODELS
// =====================================================================
import postgres from "npm:postgres@3.4.5";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const AI_KEY = env("AI_API_KEY", env("GROQ_API_KEY"));
const DAILY_CAP = Number(env("DAILY_TOKEN_CAP", "550000"));   // all models together (each has ~200k/day free)
const ALLOWED = env("ALLOWED_CONVERSATIONS").split(",").map((s) => s.trim()).filter(Boolean);
const db = postgres(env("BOT_DB_URL"), { prepare: false, max: 2, idle_timeout: 20 });

// ---------------------------------------------------------------------------
// Units, cities, places
// ---------------------------------------------------------------------------
const ALL_UNITS = ["ADYAR", "NEELANGARAI", "ANNA NAGAR", "VELACHERY", "VALASARAVAKKAM", "COIMBATORE", "MADURAI", "TRICHY",
  "CH VET ON WHEELS", "CH VET ON WHEELS - NON CLINICAL", "CBE VET ON WHEELS", "CBE VET ON WHEELS - NON CLINICAL",
  "MADURAI VET ON WHEELS", "TRICHY VET ON WHEELS"];
const CITIES: { re: RegExp; name: string; clinic: string[]; vow: string[] }[] = [
  { re: /\b(chennai|ch)\b/g, name: "Chennai", clinic: ["ADYAR", "NEELANGARAI", "ANNA NAGAR", "VELACHERY", "VALASARAVAKKAM"], vow: ["CH VET ON WHEELS", "CH VET ON WHEELS - NON CLINICAL"] },
  { re: /\b(coimbatore|cbe|kovai)\b/g, name: "Coimbatore", clinic: ["COIMBATORE"], vow: ["CBE VET ON WHEELS", "CBE VET ON WHEELS - NON CLINICAL"] },
  { re: /\bmadurai\b/g, name: "Madurai", clinic: ["MADURAI"], vow: ["MADURAI VET ON WHEELS"] },
  { re: /\b(trichy|tiruchi\w*)\b/g, name: "Trichy", clinic: ["TRICHY"], vow: ["TRICHY VET ON WHEELS"] },
];
const CLINICS: [RegExp, string][] = [
  [/\badyar\b/g, "ADYAR"], [/\bneelangarai\b/g, "NEELANGARAI"], [/\banna\s*nagar\b/g, "ANNA NAGAR"],
  [/\bvelachery\b/g, "VELACHERY"], [/\bvalasaravakkam\b/g, "VALASARAVAKKAM"],
];
const VOW_RE = /\b(vet\s*on\s*wheels?|home\s*visits?|mobile\s*vet|vow)\b/g;

type Place = { units: string[]; label: string };
function parsePlace(q: string): { place: Place; rest: string; given: boolean } {
  let s = q;
  const vow = new RegExp(VOW_RE.source).test(s), nonClin = /\bnon[\s-]*clinical\b/.test(s);
  const clinOnly = !vow && /\bclinics?\b/.test(s), clinicalVow = vow && /(^|[^-\w])clinical\b/.test(s.replace(/non[\s-]*clinical/g, ""));
  const units: string[] = [], labels: string[] = [];
  for (const c of CITIES) {
    if (!new RegExp(c.re.source).test(s)) continue;
    s = s.replace(c.re, " ");
    let u = vow ? c.vow : clinOnly ? c.clinic : [...c.clinic, ...c.vow];
    if (vow && nonClin) u = u.filter((x) => /NON CLINICAL/.test(x));
    else if (vow && clinicalVow) u = u.filter((x) => !/NON CLINICAL/.test(x));
    units.push(...u); labels.push(c.name + (vow ? " Vet on Wheels" : clinOnly ? " clinics" : ""));
  }
  for (const [re, u] of CLINICS) if (new RegExp(re.source).test(s)) { s = s.replace(re, " "); units.push(u); labels.push(u.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())); }
  if (!units.length && vow) {
    ALL_UNITS.filter((x) => /VET ON WHEELS/.test(x) && (!nonClin || /NON CLINICAL/.test(x))).forEach((x) => units.push(x));
    labels.push("All Vet on Wheels");
  }
  const allAsked = /\b(division|overall|all\s*units|all\s*(clinics|branches)|whole|company|irrespective|combined|altogether|total)\b/.test(s);
  s = s.replace(VOW_RE, " ").replace(/\bnon[\s-]*clinical\b|\bclinical\b|\bclinics?\b|\bunits?\b|\bbranch(es)?\b|\bdivision\b|\boverall\b/g, " ");
  const uniq = [...new Set(units)].sort((a, b) => ALL_UNITS.indexOf(a) - ALL_UNITS.indexOf(b));
  return { place: uniq.length ? { units: uniq, label: labels.join(", ") } : { units: ALL_UNITS, label: "Division (all units)" },
           rest: s.replace(/\b(all\s*units|all\s*(clinics|branches)|whole|company|irrespective|combined|altogether)\b/g, " "), given: uniq.length > 0 || allAsked };
}

// ---------------------------------------------------------------------------
// Periods (relative to the latest data date)
// ---------------------------------------------------------------------------
type Period = { from: string; to: string; kind: "mtd" | "period"; label: string };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(s + "T00:00:00Z");
const addD = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const nice = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)}`;

function parsePeriod(q: string, latest: string): { period: Period; rest: string; given: boolean } {
  const L = day(latest);
  let s = q, p: Period | null = null;
  const take = (re: RegExp) => { const m = s.match(re); if (m) s = s.replace(re, " "); return m; };
  let m: RegExpMatchArray | null;
  if (take(/\byesterday\b/)) p = { from: latest, to: latest, kind: "period", label: `yesterday (${nice(L)})` };
  else if (take(/\btoday\b/)) p = { from: latest, to: latest, kind: "period", label: `latest day (${nice(L)})` };
  else if ((m = take(/\b(?:last|past)\s*(\d{1,3})\s*days?\b/))) { const f = addD(L, 1 - +m[1]); p = { from: ymd(f), to: latest, kind: "period", label: `last ${m[1]} days (${nice(f)} - ${nice(L)})` }; }
  else if (take(/\b(this|current)\s*week\b|\bwtd\b/)) { const f = addD(L, -((L.getUTCDay() + 6) % 7)); p = { from: ymd(f), to: latest, kind: "period", label: `this week (${nice(f)} - ${nice(L)})` }; }
  else if (take(/\b(last|previous|prev)\s*week\b/)) { const t = addD(L, -((L.getUTCDay() + 6) % 7) - 1), f = addD(t, -6); p = { from: ymd(f), to: ymd(t), kind: "period", label: `last week (${nice(f)} - ${nice(t)})` }; }
  else if (take(/\b(last|previous|prev)\s*month\b/)) { const f = monthStart(addD(monthStart(L), -1)); p = { from: ymd(f), to: ymd(monthEnd(f)), kind: "period", label: `${MONTHS[f.getUTCMonth()].toUpperCase()} ${f.getUTCFullYear()} (full month)` }; }
  else if ((m = take(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const d = new Date(Date.UTC(y, +m[2] - 1, +m[1])); p = { from: ymd(d), to: ymd(d), kind: "period", label: nice(d) + " " + y }; }
  else if ((m = take(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*\d)/))) {
    const dd = +(m[1] ?? m[4]), mi = MONTHS.indexOf(m[2] ?? m[3]);
    let d = new Date(Date.UTC(L.getUTCFullYear(), mi, dd)); if (d > L) d = new Date(Date.UTC(L.getUTCFullYear() - 1, mi, dd));
    p = { from: ymd(d), to: ymd(d), kind: "period", label: nice(d) + " " + d.getUTCFullYear() };
  } else if ((m = take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*'?(\d{2,4})?\b/))) {
    const mi = MONTHS.indexOf(m[1]); let y = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : L.getUTCFullYear();
    if (!m[2] && new Date(Date.UTC(y, mi, 1)) > L) y--;
    const f = new Date(Date.UTC(y, mi, 1)), e = monthEnd(f);
    p = e >= L && f <= L ? { from: ymd(f), to: latest, kind: "mtd", label: `${MONTHS[mi].toUpperCase()} ${y} MTD (1 - ${L.getUTCDate()})` }
                         : { from: ymd(f), to: ymd(e), kind: "period", label: `${MONTHS[mi].toUpperCase()} ${y} (full month)` };
  }
  const mtdWords = take(/\b(month\s*to\s*date|mtd|this\s*month|current\s*month|so\s*far|till\s*date|to\s*date)\b/g);
  const given = !!p || !!mtdWords;
  if (!p) { const f = monthStart(L); p = { from: ymd(f), to: latest, kind: "mtd", label: `${MONTHS[f.getUTCMonth()].toUpperCase()} ${f.getUTCFullYear()} MTD (1 - ${L.getUTCDate()})` }; }
  return { period: p, rest: s, given };
}

// ---------------------------------------------------------------------------
// The analyst: what it knows about the data (kept identical on every call -> provider prompt cache)
// ---------------------------------------------------------------------------
const TABLES = `DATA (PostgreSQL, schema vetbuddy - always write vetbuddy.<name>). Sanchu Pet Hospitals, India. Money in Rs.
sheet_daily(sale_date,unit,total,vetbuddy,gofrugal) -- OFFICIAL daily sales report per unit (= the numbers management sees). vetbuddy = clinic services+goods, gofrugal = pharmacy, total = both.
sheet_kpi(month date,unit,as_of,days_done,days_left,mtd,last_month_same_days,growth_vs_last_month,month_estimate,target,estimate_vs_target,balance_to_target,required_per_day,ads,target_per_day,vetbuddy_mtd,gofrugal_mtd) -- month KPIs per unit for the latest month and the one before (fractions: 0.12 = 12%).
sheet_targets(month date,unit,target) -- monthly sales target per unit.
v_all_sales(sale_date,source,bill_no,clinic,item_name,plan_category,plan_subcategory,species,qty,amount,is_vow,sales_unit,doctor) -- every bill line of clinic (source 'VetBuddy') and pharmacy (source 'Pharmacy'); sales = SUM(amount); bills = COUNT(DISTINCT bill_no).
v_sales_bot(sale_date,invoice_no,item_name,goods_or_service,plan_category,plan_subcategory,qty,gross_sales,discount_name,discount_amount,net_sales,amount,is_vow,sales_unit,doctor,species,breed,performed_clinic) -- clinic (VetBuddy) lines; amount = net sales after returns.
v_pharmacy_bot(sale_date,kind,outlet,bill_no,item_name,manufacturer,qty,amount,doctor,is_vow,sales_unit) -- pharmacy lines; kind 'sale'/'return'.
v_vetbuddy_pbi_bot -- clinic lines + customer/pet analytics: pet_key, owner_key (anonymous; pets = COUNT(DISTINCT pet_key)); pet_category ('Puppy','Adult','Aged','Error Date'); pet_category_split ('New Pets','With in 1 Months','With in 6 Months','With in 12 Months','With in 18 Months','More than 18 Months' = gap since previous visit); previous_visit_date; is_night_service (1/0); came_back_for_consultation ('Yes'/'No'); per pet (same on every line): first_visit_date, client_visit_count, total_client_revenue, last_<x>_visit, <x>_visit_count, no_of_days_still_visit_<x>, <x>_status for x in bathing/haircut/vaccination/consultation/boarding; callback_date_bathing, callback_date_haircut, services_due; plus sale_date, sales_unit, amount, plan_category, plan_subcategory, item_name, doctor, species, breed.
UNITS (column unit / sales_unit): clinics ADYAR, NEELANGARAI, ANNA NAGAR, VELACHERY, VALASARAVAKKAM (Chennai), COIMBATORE, MADURAI, TRICHY; Vet on Wheels (home visits) units 'CH VET ON WHEELS', 'CH VET ON WHEELS - NON CLINICAL', 'CBE VET ON WHEELS', 'CBE VET ON WHEELS - NON CLINICAL', 'MADURAI VET ON WHEELS', 'TRICHY VET ON WHEELS'.
CATEGORIES: surgery plan_subcategory='Surgery'; vaccination plan_category ILIKE 'Vaccination%'; lab ILIKE 'Laboratory%'; scan/x-ray ILIKE 'Diagnostics%'; grooming/saloon ILIKE 'Spa and Saloon%'; consultation plan_subcategory IN ('Consultation','OPD'); boarding ILIKE 'BOARDING%'; dog species='Canine', cat 'Feline'. Exclude sales_unit LIKE '%UNMAPPED%'.
PLACEHOLDERS (the bot fills them; NEVER write unit names or dates yourself): {{UNITS}} = text[] of the units asked (WHERE unit = ANY({{UNITS}})); {{FROM}} {{TO}} = the period asked (inclusive dates); {{PREV_FROM}} {{PREV_TO}} = the previous period of the same length; {{LM_FROM}} {{LM_TO}} = the same days last month; {{MONTH}} = first day of the period's month.
SQL RULES: one SELECT or WITH per query, no semicolon, read-only. Money ROUND(x,0); percentages ROUND(x*100.0,1) in columns ending _pct (growth_pct, share_pct, achieved_pct). Readable snake_case aliases (unit, sales, prev_sales, growth_pct, share_pct, target, achieved_pct, bills, avg_bill ...), at most 7 columns. WIDE format: one row per unit / category / doctor with the current value, the comparison value and the change side by side - never a long table with a "period" column. At most 15 rows (ORDER BY the main measure DESC + LIMIT 15); add a final 'TOTAL' row when summing units. Use NULLIF to avoid division by zero. With UNION ALL wrap it: SELECT * FROM (... UNION ALL ...) t ORDER BY .... Targets, month_estimate and achieved % are MONTHLY - use them only for a month / month-to-date period. Compute EVERY derived number in SQL (differences, growth %, shares, averages, per-day, ranks) - the final answer may only quote numbers that appear in query results.`;

const PLAN_SYSTEM = `You are the senior business analyst of Sanchu Pet Hospitals (veterinary clinics, pharmacy and Vet on Wheels home visits in Chennai, Coimbatore, Madurai and Trichy). A manager asks a question in a Teams chat. Plan how to answer it with data, the way a good analyst would.
Write 2 to 4 queries that together answer it completely:
 1. ANSWER - exactly what was asked (the number, ranking or list), by unit when several units are asked, with a TOTAL row.
 2. CONTEXT - is it good or bad? The same measure for {{LM_FROM}}..{{LM_TO}} (same days last month) or {{PREV_FROM}}..{{PREV_TO}}, with growth_pct computed in SQL; for month / MTD questions also the target (sheet_targets / sheet_kpi) with achieved_pct.
 3. DRIVERS - what explains it: the breakdown that matters for this question (category mix, doctors, items, species, bills and average bill value, new vs repeat pets, day-wise trend ...). Compare current vs last month in the same row so changes are visible.
Use one query when the question is a simple lookup, but never skip CONTEXT for a sales question. Official sales totals come from sheet_daily / sheet_kpi / sheet_targets; breakdowns ("why") come from the line views.
"purpose" = a short plain-English title shown above the table, e.g. "Sales by unit vs same days last month", "Category mix vs last month", "Top 10 doctors by sales".
Reply ONLY JSON: {"understanding":"what is asked, one line","queries":[{"purpose":"...","sql":"..."}]}
If it cannot be answered from this data: {"understanding":"...","queries":[],"reply":"short reason and what can be asked instead"}

` + TABLES;

const ANALYZE_SYSTEM = `You are the senior business analyst of Sanchu Pet Hospitals, replying to a manager in a Teams chat. You ran the queries below; the results are CSV with numbers ALREADY FORMATTED (Indian commas, % values). Write a sharp, correct answer.
OUTPUT
- "headline": the direct answer in ONE sentence (max 25 words), starting with the answer itself, e.g. "Division sales are Rs 56,82,999 for 1-10 Nov, up 1.1% on the same days last month." No "Here is" / "Based on the data".
- "points": 3 to 5 bullets, each "Label: sentence" with a 1-3 word label, e.g. "Biggest driver: Anna Nagar brought Rs 11,08,705 (19.5% of sales).". Cover: what drives the number, the comparison (growth / vs target), the strongest and the weakest contributor, and anything unusual. No repetition of the headline, no generic advice.
- "action": ONE short practical next step the manager could take, grounded in these results (may be "").
- "main": 0-based index of the result that best answers the question (shown first); "extra": up to 2 more result indexes worth showing ([] if none).
- "drill": ONE more query {"purpose":"...","sql":"..."} only if a big change in the results is still unexplained, else null (same placeholders and rules).
- "followups": 3 short follow-up questions the manager is likely to ask next (max 10 words each).
ACCURACY RULES (most important)
- Copy numbers EXACTLY as written in the results (e.g. 56,82,999 / 19.5%). Do not convert to lakh/crore, do not round further, never calculate a new number (no differences, sums, shares or % of your own). If you need a number that is not in the results, ask for it with "drill" or leave it out.
- Words must match the signs: a negative growth_pct is a fall/decline, positive is growth. "Only", "all", "highest", "lowest", "most" must be true for EVERY row of the result - check before writing.
- Say which comparison you mean ("vs same days last month", "vs previous 10 days", "vs target"). Never say YoY unless the data is a year apart.
- Units in Title Case (Anna Nagar, CH Vet on Wheels). Money as "Rs 11,08,705".
Reply ONLY JSON: {"headline":"","points":[],"action":"","main":0,"extra":[],"drill":null,"followups":[]}

` + TABLES;

const REPAIR_SYSTEM = `You are a strict reviewer of a data analyst's answer for Sanchu Pet Hospitals. Check EVERY statement in the draft against the query results (CSV, numbers already formatted):
- each number must appear in the results exactly (same value; Indian-comma formatting may differ);
- direction words must match signs (negative = decline / fall, positive = growth / rise);
- "only", "all", "highest", "lowest", "most", "biggest" must be true for every row;
- shares, sums and differences must not be invented.
Fix a wrong statement using the results, or remove it. Do not add new claims. Keep the same JSON keys; keep "main", "extra", "followups" unchanged; set "drill" to null. If everything is correct, return the draft unchanged.
Reply ONLY JSON: {"headline":"","points":[],"action":"","main":0,"extra":[],"drill":null,"followups":[],"changes":"what you fixed, or 'none'"}`;

const FIX_SYSTEM = `You fix PostgreSQL queries for Sanchu Pet Hospitals' data. Keep the purpose and the placeholders. Reply ONLY JSON: {"sql":"..."}

` + TABLES;

// ---------------------------------------------------------------------------
// question TYPE key: what is left after removing place and period (finds repeats without AI)
// ---------------------------------------------------------------------------
const INSIGHT_RE = /\b(insights?|why|explain|analy[sz]e|analysis|reasons?|suggest|recommend|trends?|summari[sz]e|summary|observations?)\b/gi;
const PHRASES: [RegExp, string][] = [
  [/\b(revenue|turnover|business|collection|income|sale|sales|amount)\b/g, " sales "],
  [/\b(target|aop|budget|achievement|achieved)\b/g, " target "],
  [/\b(bills?|invoices?)\b/g, " bills "],
  [/\b(dogs?|canines?)\b/g, " dog "], [/\b(cats?|felines?)\b/g, " cat "],
  [/\b(operations?|surgeries)\b/g, " surgery "],
  [/\b(vaccines?|vaccinations?)\b/g, " vaccination "],
  [/\b(doctors?|vets?|drs?)\b/g, " doctor "],
  [/\b(medicines?|drugs?|pharmacy|gofrugal)\b/g, " pharmacy "],
  [/\b(how\s*many|count|number\s*of|no\s*of)\b/g, " count "],
  [/\b(split\s*ups?|breakdown|break\s*up|detailed|details?|wise)\b/g, " "],
];
const STOP = new Set(("a an the of for in on at to and or by with from is are was were be been what whats which who " +
  "how much me us our we show give tell get find list please pls can could would you i my do does did " +
  "about all total value rs inr rupees data report numbers number vs versus compared compare " +
  "it its that this these those there here so far till until up as per same also then now again just only " +
  "ok okay hi hello thanks thank yes no some any more business interesting using detail details give tell " +
  "please kindly about").split(" "));

function typeKey(rest: string, kind: string): string {
  let s = " " + rest.replace(/\bbusiness\s+(insights?|analysis|summary|observations?)\b/g, " ").replace(INSIGHT_RE, " ") + " ";
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  const words = s.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w));
  const k = [...new Set(words)].sort().join(" ");
  return k + (kind ? "" : "");   // "" = no words of its own (a follow-up); one template serves every place and period
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

function inr(n: number, dec = 0): string {
  const neg = n < 0, s = Math.abs(n).toFixed(dec), [i, f] = s.split(".");
  const last3 = i.slice(-3), rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-" : "") + (rest ? rest + "," + last3 : last3) + (f ? "." + f : "");
}

async function dataDates() {
  const [r] = await db`select (select max(sale_date) from vetbuddy.sheet_daily)::text as report,
                              (select date_to from vetbuddy.v_data_freshness)::text as detail`;
  return { report: r?.report ?? "", detail: r?.detail ?? "" };
}

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
// AI: several Groq models, each step has its own order; on a limit / error the next model takes over
// ---------------------------------------------------------------------------
const M120 = "openai/gpt-oss-120b", M20 = "openai/gpt-oss-20b", MQWEN = "qwen/qwen3.8-27b";
const STEP_MODELS: Record<string, string[]> = {
  plan:    (env("AI_PLAN_MODELS") || `${M120},${MQWEN},${M20}`).split(","),     // most accurate model plans the queries
  analyze: (env("AI_ANALYZE_MODELS") || `${M120},${MQWEN},${M20}`).split(","),
  review:  (env("AI_REVIEW_MODELS") || `${MQWEN},${M120}`).split(","),          // a DIFFERENT model checks the draft
  fix:     (env("AI_FIX_MODELS") || `${M20},${MQWEN},${M120}`).split(","),      // cheap model repairs a failing query
  chat:    (env("AI_CHAT_MODELS") || `${M120},${MQWEN},${M20}`).split(","),     // the assistant: understands every message
};
class LimitError extends Error {}
type AiOut = { text: string; tokens: number; model: string };

async function aiCall(step: string, system: string, user: string, maxTokens: number): Promise<AiOut> {
  const errs: string[] = [];
  let limited = 0;
  const models = STEP_MODELS[step] ?? STEP_MODELS.analyze;
  const tries: [string, boolean][] = [];
  for (const m of models.map((x) => x.trim()).filter(Boolean)) tries.push([m, true]);
  for (const m of models.map((x) => x.trim()).filter(Boolean)) tries.push([m, false]);   // 2nd round: no JSON mode (parsed leniently)
  for (const [model, jsonMode] of tries) {
    const body: Record<string, unknown> = {
      model, temperature: step === "chat" ? 0.4 : 0, max_completion_tokens: jsonMode ? maxTokens * 2 : maxTokens * 3,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (model.includes("gpt-oss")) { body.reasoning_effort = step === "plan" ? "medium" : "low"; body.include_reasoning = false; }
    else if (model.includes("qwen")) { body.reasoning_effort = "low"; body.reasoning_format = "hidden"; }
    let r: Response;
    try {
      r = await fetch(GROQ_URL, { method: "POST", body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${AI_KEY}`, "Content-Type": "application/json" } });
    } catch (e) { errs.push(String(e).slice(0, 80)); continue; }
    if (r.status === 429) { limited++; errs.push(`${model.split("/").pop()} busy`); continue; }   // per-model limits -> next model
    if (!r.ok) {
      const t = await r.text();
      const failed = t.match(/"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (failed) {                                    // JSON mode rejected the output - often it is usable JSON anyway
        try { const g = JSON.parse(`"${failed[1]}"`); if (Object.keys(parseJson(g)).length) return { text: g, tokens: 0, model }; } catch { /* next */ }
      }
      errs.push(`${model.split("/").pop()} ${r.status} ${(t.match(/"code"\s*:\s*"([^"]+)"/) ?? [])[1] ?? t.slice(0, 60)}`);
      console.error("ai", step, model, r.status, t.slice(0, 300));
      continue;
    }
    const j = await r.json();
    const tokens = j.usage?.total_tokens ?? 0;
    await usage(tokens);
    const text = String(j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text || (!jsonMode && !Object.keys(parseJson(text)).length)) { errs.push(`${model.split("/").pop()} no answer`); continue; }
    return { text, tokens, model };
  }
  if (limited && limited >= tries.length / 2) throw new LimitError("All free AI models are busy right now (per-minute limit) - please ask again in a minute.");
  throw new Error("AI unavailable: " + errs.join("; "));
}
// deno-lint-ignore no-explicit-any
function parseJson(t: string): any {
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return {};
}

// ---------------------------------------------------------------------------
// follow-ups: each chat remembers its last question (place, period, question type) for 2 hours
// ---------------------------------------------------------------------------
type Ctx = { key: string; question: string; units: string[]; place_label: string; p_from: string; p_to: string; p_kind: string; p_label: string; headline: string | null };
async function getCtx(conv: string): Promise<Ctx | null> {
  if (!conv) return null;
  const [c] = await db`select key, question, units, place_label, p_from::text as p_from, p_to::text as p_to, p_kind, p_label, headline
                       from vetbuddy.bot_context where conversation = ${conv} and updated_at > now() - interval '30 minutes'`;
  return (c as unknown as Ctx) ?? null;
}
async function setCtx(conv: string, key: string, question: string, pl: Place, pe: Period, headline = "") {
  if (!conv) return;
  await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_context (conversation, key, question, units, place_label, p_from, p_to, p_kind, p_label, headline, updated_at)
    values (${conv}, ${key}, ${question}, ${pl.units}, ${pl.label}, ${pe.from}, ${pe.to}, ${pe.kind}, ${pe.label}, ${headline.slice(0, 400)}, now())
    on conflict (conversation) do update set key = excluded.key, question = excluded.question, units = excluded.units,
      place_label = excluded.place_label, p_from = excluded.p_from, p_to = excluded.p_to, p_kind = excluded.p_kind,
      p_label = excluded.p_label, headline = excluded.headline, updated_at = now()`);
}

// a message continues the previous question only when it reads like a follow-up
const FOLLOW_RE = /^\s*(and|also|what about|how about|same|now|then|only|just|but|instead|split|break|compare|vs|versus|by|for|in|show|what if)\b|\b(same|that|those|them|it|this one)\b/;
// place names typed into a saved title/answer by the AI -> {PLACE}, so a template never shows another place
const PLACE_WORDS = /\b(chennai|coimbatore|cbe|kovai|madurai|trichy|adyar|neelangarai|anna\s*nagar|velachery|valasaravakkam)(\s+(vet\s*on\s*wheels|vow))?\b|\b(vet\s*on\s*wheels|vow)\b/gi;
function placeless(t: string, needPeriod = false): string {
  if (!t) return t;
  let s = t.replace(PLACE_WORDS, "{PLACE}").replace(/\{PLACE\}(\s*(,|&|and)?\s*\{PLACE\})+/g, "{PLACE}");
  if (needPeriod) {
    if (!s.includes("{PLACE}")) s += " - {PLACE}";
    if (!s.includes("{PERIOD}")) s += " · {PERIOD}";
  }
  return s;
}
class NotAQuestion extends Error {}

// ---------------------------------------------------------------------------
// placeholders -> real values (units, the period, the previous period, the same days last month)
// ---------------------------------------------------------------------------
function shiftMonth(d: string, by: number): string {
  const x = new Date(d + "T00:00:00Z");
  const t = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + by, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(x.getUTCDate(), last));
  return ymd(t);
}
function comparePeriods(pe: Period) {
  const f = new Date(pe.from + "T00:00:00Z"), t = new Date(pe.to + "T00:00:00Z");
  const days = Math.round((t.getTime() - f.getTime()) / 864e5) + 1;
  const prevTo = new Date(f.getTime() - 864e5), prevFrom = new Date(f.getTime() - days * 864e5);
  const fullMonth = f.getUTCDate() === 1 && new Date(t.getTime() + 864e5).getUTCDate() === 1;
  const lmFrom = shiftMonth(pe.from, -1);
  const lmTo = fullMonth ? ymd(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0))) : shiftMonth(pe.to, -1);
  return { prevFrom: ymd(prevFrom), prevTo: ymd(prevTo), lmFrom, lmTo };
}
const sqlStr = (s: string) => "'" + s.replace(/'/g, "''") + "'";
function render(tpl: string, pl: Place, pe: Period) {
  const c = comparePeriods(pe);
  return tpl
    .replace(/\{\{\s*UNITS\s*\}\}/g, `ARRAY[${pl.units.map(sqlStr).join(",")}]::text[]`)
    .replace(/\{\{\s*PREV_FROM\s*\}\}/g, `DATE '${c.prevFrom}'`).replace(/\{\{\s*PREV_TO\s*\}\}/g, `DATE '${c.prevTo}'`)
    .replace(/\{\{\s*LM_FROM\s*\}\}/g, `DATE '${c.lmFrom}'`).replace(/\{\{\s*LM_TO\s*\}\}/g, `DATE '${c.lmTo}'`)
    .replace(/\{\{\s*FROM\s*\}\}/g, `DATE '${pe.from}'`).replace(/\{\{\s*TO\s*\}\}/g, `DATE '${pe.to}'`)
    .replace(/\{\{\s*MONTH\s*\}\}/g, `DATE '${pe.from.slice(0, 7)}-01'`);
}

// run SQL: one SELECT, read-only transaction, 15 s, max 201 rows
async function runSql(q: string) {
  const clean = q.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(clean) || clean.includes(";")) throw new Error("only one SELECT is allowed");
  return await db.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '15s'");
    return await tx.unsafe(`select * from (${clean}) as _q limit 201`);
  }) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// accuracy check: every number in the answer must be traceable to a query result
// ---------------------------------------------------------------------------
function resultNumbers(sets: Record<string, unknown>[][]): number[] {
  const out: number[] = [];
  for (const rows of sets) for (const r of rows.slice(0, 60)) for (const v of Object.values(r)) {
    const n = typeof v === "number" ? v : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
    if (!isFinite(n)) continue;
    out.push(n, n / 1e5, n / 1e7, n * 100, Math.abs(n), Math.abs(n) / 1e5, Math.abs(n) * 100);
  }
  return out;
}
function claimedNumbers(text: string): { raw: string; value: number; dec: number }[] {
  const out: { raw: string; value: number; dec: number }[] = [];
  const re = /(?<![\w.\/-])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*(?:lakhs?|lacs?|l\b|cr\b|crores?|%|k\b))?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim(), unit = (m[2] || "").trim().toLowerCase();
    let v = Number(m[1].replace(/,/g, ""));
    if (!isFinite(v)) continue;
    if (!unit && !m[1].includes(",") && !m[1].includes(".") && v <= 31) continue;      // days, counts of units, dates
    if (!unit && v >= 1900 && v <= 2100 && !m[1].includes(",")) continue;                // years
    let dec = (m[1].split(".")[1] || "").length;
    if (unit === "k") { v *= 1000; dec = Math.max(0, dec - 3); }
    out.push({ raw, value: v, dec });                                  // lakh / crore are compared with n/1e5, n/1e7
  }
  return out;
}
function isSupported(v: number, dec: number, pool: number[]): boolean {
  const tol = Math.max(0.5 * Math.pow(10, -dec), Math.abs(v) * 0.001);                  // rounding of what was written
  return pool.some((p) => Math.abs(p - v) <= tol + 1e-9);
}
function unsupported(texts: string[], sets: Record<string, unknown>[][]): string[] {
  const pool = resultNumbers(sets);
  const bad = new Set<string>();
  for (const t of texts) for (const c of claimedNumbers(t)) if (!isSupported(c.value, c.dec, pool)) bad.add(c.raw);
  return [...bad];
}

// ---------------------------------------------------------------------------
// answer one question: plan -> run -> (drill) -> write -> check
// ---------------------------------------------------------------------------
type Result = { purpose: string; sql: string; rows: Record<string, unknown>[]; error?: string };
type Answer = { title: string; points?: string[]; action?: string; tables?: { title: string; rows: Record<string, unknown>[] }[];
                steps?: string[]; followups?: string[]; note?: string; checked?: string; sig?: string; cacheKey?: string };
// deno-lint-ignore no-explicit-any
type Draft = { headline: string; points: string[]; action: string; main: number; extra: number[]; drill: any; followups: string[] };

// results as the model sees them: numbers formatted exactly like the cards (Indian commas, %), so it copies them as-is
function fmtCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (c: string, v: unknown) => fmt(c, v).replace(/;/g, " ");
  return [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(c, r[c])).join(";"))].join("\n");
}
function resultsText(results: Result[]) {
  return results.map((r, i) => `#${i} ${r.purpose}\n` + (r.error ? `(failed: ${r.error.slice(0, 120)})` :
    r.rows.length ? fmtCsv(r.rows.slice(0, 30)).slice(0, 2600) : "(no rows)")).join("\n\n");
}
// deno-lint-ignore no-explicit-any
function cleanDraft(d: any, n: number): Draft {
  const idx = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n ? x as number : -1;
  return { headline: String(d?.headline ?? "").trim(), points: Array.isArray(d?.points) ? d.points.map(String).filter(Boolean).slice(0, 6) : [],
           action: String(d?.action ?? "").trim(),
           main: idx(d?.main), extra: Array.isArray(d?.extra) ? d.extra.map(idx).filter((x: number) => x >= 0).slice(0, 2) : [],
           drill: d?.drill && d.drill.sql ? d.drill : null, followups: Array.isArray(d?.followups) ? d.followups.map(String).slice(0, 3) : [] };
}

async function runQuery(purpose: string, sql: string, place: Place, period: Period, used: Set<string>, tok: { n: number }): Promise<Result> {
  try { return { purpose, sql, rows: await runSql(render(sql, place, period)) }; }
  catch (e) {
    const err = String((e as Error).message).slice(0, 300);
    try {                                                     // one repair by the cheap model
      const out = await aiCall("fix", FIX_SYSTEM, `Purpose: ${purpose}\nSQL:\n${sql}\nError: ${err}`, 1200);
      used.add(out.model); tok.n += out.tokens;
      const fixed = String(parseJson(out.text).sql ?? "");
      if (fixed) return { purpose, sql: fixed, rows: await runSql(render(fixed, place, period)) };
    } catch (e2) { return { purpose, sql, rows: [], error: String((e2 as Error).message) }; }
    return { purpose, sql, rows: [], error: err };
  }
}

async function answer(question: string, who: string, conv = ""): Promise<Answer> {
  const q = question.toLowerCase().replace(/[⁠​]/g, " ");
  const wantInsight = new RegExp(INSIGHT_RE.source, "i").test(q);
  const dates = await dataDates();
  const latest = dates.report || dates.detail || istDate();
  const pp = parsePlace(q);
  const pd = parsePeriod(pp.rest, latest);
  let place = pp.place, period = pd.period, key = typeKey(pd.rest, pd.period.kind), follow = "";
  const ownKey = key;
  const ctx = await getCtx(conv);
  // Conversation rules:
  //  - a message with its own question ("pharmacy sales", "doctors") is a new question; if it names no place /
  //    period, it uses the place / period of the conversation (like a person would)
  //  - a message with no question of its own ("and Trichy?", "last month", "insights", "split by doctor"...)
  //    continues the previous question
  const isFollow = !!ctx && (FOLLOW_RE.test(q) || !ownKey);
  if (ctx && (isFollow || ownKey)) {
    const kept: string[] = [];
    if (!key && isFollow) { key = ctx.key; kept.push("question"); }
    if (!pp.given) { place = { units: ctx.units, label: ctx.place_label }; kept.push("place"); }
    if (!pd.given) { period = { from: ctx.p_from, to: ctx.p_to, kind: ctx.p_kind as Period["kind"], label: ctx.p_label }; kept.push("period"); }
    if (kept.length) follow = (isFollow ? "follow-up: same " : "same ") + kept.join(" & ");
  }
  if (!key) {
    if (!pp.given && !pd.given && !isFollow) throw new NotAQuestion();   // "thank you", "ok", "stop" ...
    key = "sale";
  }
  const isFollowUp = follow.startsWith("follow-up") && !!ctx;
  // what the AI is told: the question, and for a follow-up the conversation so far
  const asked = isFollowUp && ctx ? `Previous question: ${ctx.question}${ctx.headline ? `\nPrevious answer: ${ctx.headline}` : ""}\nFollow-up: ${question}` : question;
  const baseQuestion = isFollowUp && ctx ? ctx.question : question;
  const sig = key + (wantInsight ? " +insight" : "");
  const c = comparePeriods(period);
  const cacheKey = `${sig}|${place.units.join(",")}|${period.from}|${period.to}|${latest}`;
  const where = `${place.label} · ${period.label}`;
  const conversation = follow ? `Conversation (${follow}) · ` : "";

  // 0. the same analysis was already done today on the same data -> reuse it (0 AI tokens)
  const [hit] = await db`select answer from vetbuddy.bot_answer where cache_key = ${cacheKey}`;
  if (hit) {
    const a = hit.answer as Answer;
    await setCtx(conv, key, baseQuestion, place, period, a.title);
    return { ...a, sig, cacheKey, note: `${conversation}${where} · data up to ${latest} · saved analysis, 0 AI tokens` };
  }
  const used = await usage();
  if (used.tokens >= DAILY_CAP) throw new LimitError("Today's free AI allowance is used up.");
  const models = new Set<string>(), tok = { n: 0 };
  const facts = `Units asked: ${place.units.join(", ")} (${place.label}). Period: ${period.label}, ${period.from} to ${period.to}. ` +
    `Previous period: ${c.prevFrom} to ${c.prevTo}. Same days last month: ${c.lmFrom} to ${c.lmTo}. Data available up to ${latest}.`;

  // 1. PLAN: which queries answer this (saved per question type and re-used for any place / period)
  const [saved] = await db`select plan from vetbuddy.bot_plan where good and signature = ${sig}`;
  // deno-lint-ignore no-explicit-any
  let plan: any = saved?.plan, planSaved = !!plan;
  if (!plan || isFollowUp) {
    const out = await aiCall("plan", PLAN_SYSTEM, `Question: ${asked}\n${facts}\n(Write placeholders, not these values.)`, 2500);
    models.add(out.model); tok.n += out.tokens;
    plan = parseJson(out.text); planSaved = false;
  }
  // deno-lint-ignore no-explicit-any
  const planned: { purpose: string; sql: string }[] = (Array.isArray(plan?.queries) ? plan.queries : []).filter((x: any) => x?.sql).slice(0, 4);
  if (!planned.length) return { title: String(plan?.reply || "I couldn't work that out from our sales data. Try e.g. 'Madurai sales this month' or 'top doctors in Adyar last month'.") };

  // 2. RUN the queries (a failing one is repaired once by another model)
  const results: Result[] = [];
  for (const p of planned) results.push(await runQuery(String(p.purpose || "Query"), String(p.sql), place, period, models, tok));
  const ok = results.filter((r) => !r.error);
  if (!ok.length) throw new Error("the queries for this question failed: " + results[0].error);
  if (!planSaved && ok.length === results.length && !isFollowUp) {
    await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_plan (signature, question, plan, tokens, asked_by)
      values (${sig}, ${question}, ${tx.json({ understanding: plan.understanding ?? "", queries: results.map((r) => ({ purpose: r.purpose, sql: r.sql })) })}, ${tok.n}, ${who})
      on conflict (signature) do update set plan = excluded.plan, question = excluded.question, good = true, last_used_at = now()`);
  } else if (planSaved) {
    await db.begin("read write", (tx) => tx`update vetbuddy.bot_plan set uses = uses + 1, last_used_at = now() where signature = ${sig}`);
  }

  // 3. ANALYSE the results; the analyst may ask for ONE more drill-down query
  const analyseOnce = async () => {
    const out = await aiCall("analyze", ANALYZE_SYSTEM,
      `Question: ${asked}\n${facts}${wantInsight ? "\nThe manager wants insights: explain the why." : ""}\n\nRESULTS\n${resultsText(results)}`, 1800);
    models.add(out.model); tok.n += out.tokens;
    return cleanDraft(parseJson(out.text), results.length);
  };
  let draft = await analyseOnce();
  if (draft.drill && results.length < 6) {
    results.push(await runQuery(String(draft.drill.purpose || "Drill-down"), String(draft.drill.sql), place, period, models, tok));
    if (!results[results.length - 1].error) draft = await analyseOnce();
  }

  // 4. CHECK: a second model reviews every statement against the results, then every number is checked in code
  const sets = results.map((r) => r.rows);
  const texts = (d: Draft) => [d.headline, ...d.points, d.action];
  let review = "", reviewedOk = false;
  try {
    const bad0 = unsupported(texts(draft), sets);
    const out = await aiCall("review", REPAIR_SYSTEM, `Question: ${asked}\n${bad0.length ? `Numbers NOT found in the results: ${bad0.join(", ")}\n` : ""}` +
      `\nDRAFT\n${JSON.stringify({ ...draft, drill: null })}\n\nRESULTS\n${resultsText(results)}`, 1800);
    models.add(out.model); tok.n += out.tokens;
    const j = parseJson(out.text), fixed = cleanDraft(j, results.length);
    review = String(j?.changes ?? "").trim(); reviewedOk = true;
    if (fixed.headline || fixed.points.length) draft = { ...fixed, main: draft.main, extra: draft.extra, followups: draft.followups.length ? draft.followups : fixed.followups };
  } catch { /* reviewer busy: the number check below still applies */ }
  const removed = draft.points.filter((p) => unsupported([p], sets).length);
  draft.points = draft.points.filter((p) => !removed.includes(p));
  if (draft.action && unsupported([draft.action], sets).length) draft.action = "";
  if (draft.headline && unsupported([draft.headline], sets).length) {
    draft.headline = draft.points.length ? draft.points.shift()!.replace(/^[^:]{1,30}:\s*/, "") : `${place.label} - ${period.label}`;
  }
  const reviewed = review && !/^none\.?$/i.test(review) ? "reviewed & corrected by a 2nd AI" : "reviewed by a 2nd AI";
  const checked = (reviewedOk ? reviewed + " · " : "") +
    (removed.length ? `numbers checked against the data (${removed.length} unverified point removed)` : "every number checked against the data ✓");

  // 5. the card
  const show = [draft.main >= 0 ? draft.main : results.findIndex((r) => r.rows.length), ...draft.extra]
    .filter((i, k, a) => i >= 0 && a.indexOf(i) === k && results[i] && results[i].rows.length).slice(0, 3);
  const a: Answer = {
    title: draft.headline || `${place.label} - ${period.label}`,
    points: draft.points, action: draft.action,
    tables: show.map((i) => ({ title: results[i].purpose, rows: results[i].rows })),
    steps: results.map((r) => r.purpose + (r.error ? " (failed)" : "")),
    followups: draft.followups, checked,
  };
  await db.begin("read write", (tx) => tx`insert into vetbuddy.bot_answer (cache_key, plan_sig, answer)
    values (${cacheKey}, ${sig}, ${tx.json(a as never)}) on conflict (cache_key) do update set answer = excluded.answer, created_at = now()`);
  await setCtx(conv, key, baseQuestion, place, period, a.title);
  return { ...a, sig, cacheKey,
    note: `${conversation}${where} · data up to ${latest} · AI: ${[...models].map((m) => m.split("/").pop()).join(" + ")}, ${inr(tok.n)} tokens` };
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const v = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x ?? "")).replace(/,/g, " ");
  return [cols.join(","), ...rows.map((r) => cols.map((c) => v(r[c])).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// Teams: Adaptive Card with the answer, the table and the split-up
// ---------------------------------------------------------------------------
function fmt(col: string, v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (/pct|percent|growth|_vs_/i.test(col)) return (Math.abs(n) <= 1.5 && !/pct/i.test(col) ? (n * 100).toFixed(1) : n.toFixed(1)) + "%";
    if (/date|year|month_no|^id$/i.test(col)) return s;
    return inr(n, Math.abs(n) < 100 && !Number.isInteger(n) ? 1 : 0);
  }
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

function table(rows: Record<string, unknown>[], max: number) {
  const cols = Object.keys(rows[0]).slice(0, 8);
  const isTot = (r: Record<string, unknown>) => /^total$/i.test(String(r[cols[0]] ?? ""));
  return {
    type: "Table", firstRowAsHeaders: true, showGridLines: true, spacing: "Medium",
    columns: cols.map((_c, i) => ({ width: i === 0 ? 2 : 1 })),
    rows: [
      { type: "TableRow", style: "accent", cells: cols.map((c) => ({ type: "TableCell", items: [{ type: "TextBlock", text: colTitle(c), weight: "Bolder", wrap: true }] })) },
      ...rows.slice(0, max).map((r) => ({ type: "TableRow", style: isTot(r) ? "emphasis" : "default",
        cells: cols.map((c) => ({ type: "TableCell", items: [{ type: "TextBlock", text: fmt(c, r[c]), wrap: true, weight: isTot(r) ? "Bolder" : "Default" }] })) })),
    ],
  };
}

// readable column titles
function colTitle(c: string): string {
  const t = c.replace(/_pct$/, " %").replace(/\blm\b|_lm\b|^lm_/g, (m) => m.replace("lm", "last month")).replace(/_/g, " ")
    .replace(/\bprev\b/g, "previous").replace(/\bmtd\b/g, "MTD").replace(/\bavg\b/g, "avg").replace(/\bvow\b/gi, "VOW").replace(/\bpct\b/g, "%");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// a small bar chart column for the first money column of the main table
function withBars(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const cols = Object.keys(rows[0] ?? {});
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  const col = cols.slice(1).find((c) => !/pct|percent|growth|_vs_|date|year|count|bills|days|qty/i.test(c) && rows.some((r) => isFinite(num(r[c]))));
  if (!col || rows.length < 2 || rows.length > 15 || cols.length >= 8) return rows;
  const isTot = (r: Record<string, unknown>) => /^total$/i.test(String(r[cols[0]] ?? ""));
  const max = Math.max(...rows.filter((r) => !isTot(r)).map((r) => Math.abs(num(r[col])) || 0));
  if (!(max > 0)) return rows;
  return rows.map((r) => ({ ...r, chart: isTot(r) || !isFinite(num(r[col])) ? "" : "█".repeat(Math.max(1, Math.round(10 * Math.abs(num(r[col])) / max))) }));
}

function card(a: Answer) {
  const body: unknown[] = [{ type: "TextBlock", text: a.title, weight: "Bolder", size: "Medium", wrap: true }];
  if (a.points?.length) {
    body.push({ type: "TextBlock", text: a.points.map((p) => "- " + p.replace(/^([^:]{1,30}):\s*/, "**$1:** ")).join("\n"), wrap: true, spacing: "Small" });
  }
  if (a.action) body.push({ type: "TextBlock", text: "**What to do:** " + a.action, wrap: true, spacing: "Small", color: "Accent" });
  for (const [k, t] of (a.tables ?? []).entries()) {
    const rows = k === 0 ? withBars(t.rows) : t.rows, max = k ? 15 : 20;
    body.push({ type: "TextBlock", text: t.title, weight: "Bolder", spacing: "Large", wrap: true });
    body.push(table(rows, max));
    if (rows.length > max) body.push({ type: "TextBlock", text: `Showing ${max} of ${rows.length >= 201 ? "200+" : rows.length} rows.`, isSubtle: true, size: "Small" });
  }
  const foot = [a.steps?.length ? "How I worked it out: " + a.steps.map((s, i) => `${i + 1}) ${s}`).join("  ") : "", a.checked ?? "", a.note ?? "",
    a.sig ? "reply 'wrong' if this is not right" : ""].filter(Boolean).join(" · ");
  if (foot) body.push({ type: "TextBlock", text: foot, isSubtle: true, size: "Small", wrap: true, spacing: "Medium" });
  // follow-up questions as buttons (messageBack reaches the bot without an @mention)
  const actions = (a.followups ?? []).slice(0, 3).map((f) => ({ type: "Action.Submit", title: f.length > 60 ? f.slice(0, 57) + "..." : f,
    data: { msteams: { type: "messageBack", text: f, displayText: f } } }));
  return { contentType: "application/vnd.microsoft.card.adaptive",
           content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.5", body,
                      ...(actions.length ? { actions } : {}), msteams: { width: "Full" } } };
}

// ---------------------------------------------------------------------------
// Bot Framework plumbing
// ---------------------------------------------------------------------------
const JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));
let botToken = { value: "", exp: 0 };
// multi-tenant bots log in at botframework.com, single-tenant bots at their own tenant; try both
let tokenTenants = ["botframework.com", env("BOT_TENANT_ID")].filter(Boolean);

async function outboundToken() {
  if (botToken.value && Date.now() < botToken.exp - 60e3) return botToken.value;
  const tenant = tokenTenants[0];
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
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
async function send(act: any, msg: Record<string, unknown>) {
  const url = `${act.serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(act.conversation.id)}/activities` +
    (act.id ? `/${encodeURIComponent(act.id)}` : "");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await outboundToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", replyToId: act.id, ...msg, _retry: undefined }),
  });
  if (r.status === 401 && tokenTenants.length > 1 && !msg._retry) {   // wrong login type -> switch and retry once
    tokenTenants = tokenTenants.slice(1).concat(tokenTenants[0]); botToken = { value: "", exp: 0 };
    return send(act, { ...msg, _retry: true });
  }
  if (!r.ok) console.error("send failed", r.status, await r.text());
}

// ---------------------------------------------------------------------------
// ASSISTANT: the front door. Every message is understood by an AI that knows the conversation, the person,
// the time of day and a live sales snapshot; it chats itself or hands a clear question to the analyst.
// ---------------------------------------------------------------------------
type SnapRow = Record<string, number | string | null>;
let snapCache: { at: number; text: string; rows: SnapRow[] } | null = null;

async function snapshot(): Promise<{ text: string; rows: SnapRow[] }> {
  if (snapCache && Date.now() - snapCache.at < 10 * 60e3) return snapCache;
  const rows = await db`
    with k as (select * from vetbuddy.sheet_kpi where month = (select max(month) from vetbuddy.sheet_kpi) and unit not ilike '%unmapped%'),
         d as (select max(sale_date) as day from vetbuddy.sheet_daily),
         y as (select unit, sum(total) as s from vetbuddy.sheet_daily, d where sale_date = d.day group by unit)
    select k.unit, (select day from d)::text as last_day, k.as_of::text as as_of, k.days_done::int as days_done, k.days_left::int as days_left,
           round(y.s)::float8 as last_day_sales, round(k.mtd)::float8 as mtd, round(k.last_month_same_days)::float8 as lm_same_days,
           round(k.target)::float8 as target, round(k.month_estimate)::float8 as estimate, round(k.required_per_day)::float8 as required_per_day
    from k left join y on y.unit = k.unit order by k.mtd desc nulls last` as unknown as SnapRow[];
  if (!rows.length) return { text: "(no snapshot available)", rows: [] };
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
  const pct = (a: number, b: number) => (b ? Math.round((a * 1000) / b) / 10 : null);
  const isTotal = (u: unknown) => /total|division|overall/i.test(String(u));
  const units = rows.filter((r) => !isTotal(r.unit));
  const tot: SnapRow = rows.find((r) => isTotal(r.unit)) ?? {
    unit: "ALL UNITS (division)", last_day_sales: units.reduce((a, r) => a + n(r.last_day_sales), 0), mtd: units.reduce((a, r) => a + n(r.mtd), 0),
    lm_same_days: units.reduce((a, r) => a + n(r.lm_same_days), 0), target: units.reduce((a, r) => a + n(r.target), 0),
    estimate: units.reduce((a, r) => a + n(r.estimate), 0), required_per_day: units.reduce((a, r) => a + n(r.required_per_day), 0) };
  if (tot.last_day_sales === null || tot.last_day_sales === undefined) tot.last_day_sales = units.reduce((a, r) => a + n(r.last_day_sales), 0);
  const all: SnapRow[] = [tot, ...units].map((r): SnapRow => ({ ...r, growth_pct: r.lm_same_days ? pct(n(r.mtd) - n(r.lm_same_days), n(r.lm_same_days)) : null,
    achieved_pct: pct(n(r.mtd), n(r.target)), estimate_pct: pct(n(r.estimate), n(r.target)) }));
  const rs = (v: unknown) => (v === null || v === undefined ? "-" : "Rs " + inr(n(v)));
  const pc = (v: unknown) => (v === null || v === undefined ? "-" : (n(v) > 0 ? "+" : "") + n(v).toFixed(1) + "%");
  const f = rows[0];
  const text = `Official sales report. Latest day loaded: ${f.last_day}. Month-to-date as of ${f.as_of ?? f.last_day}: ${f.days_done ?? "?"} days done, ${f.days_left ?? "?"} days left.\n` +
    all.map((r) => `${r.unit}: ${f.last_day} sales ${rs(r.last_day_sales)} | MTD ${rs(r.mtd)} | vs same days last month ${pc(r.growth_pct)} | ` +
      `target ${rs(r.target)} | achieved ${r.achieved_pct ?? "-"}% | month estimate ${rs(r.estimate)} (${r.estimate_pct ?? "-"}% of target) | needed per day ${rs(r.required_per_day)}`).join("\n");
  snapCache = { at: Date.now(), text, rows: all as SnapRow[] };
  return snapCache;
}

// the conversation (last turns, 3 hours) - table vetbuddy.bot_turns (SQL 13); works without it too
async function turns(conv: string): Promise<{ role: string; text: string }[]> {
  if (!conv) return [];
  try {
    const r = await db`select role, text from vetbuddy.bot_turns where conversation = ${conv} and at > now() - interval '3 hours' order by at desc limit 10`;
    return (r as unknown as { role: string; text: string }[]).reverse();
  } catch { return []; }
}
async function addTurns(conv: string, ...t: [string, string][]) {
  if (!conv) return;
  try {
    await db.begin("read write", async (tx) => {
      for (const [role, text] of t) if (text) await tx`insert into vetbuddy.bot_turns (conversation, role, text) values (${conv}, ${role}, ${text.slice(0, 700)})`;
      if (Math.random() < 0.05) await tx`delete from vetbuddy.bot_turns where at < now() - interval '14 days'`;
    });
  } catch (e) { console.error("bot_turns", String(e).slice(0, 150)); }
}
async function clearTurns(conv: string) {
  try { await db.begin("read write", (tx) => tx`delete from vetbuddy.bot_turns where conversation = ${conv}`); } catch { /* table missing */ }
}

const ASSISTANT_SYSTEM = `You are "Sanchu Sales", the assistant inside the Sanchu Pet Hospitals management Teams chat. You help the team understand and act on the hospitals' business - veterinary clinics, pharmacy and Vet on Wheels home visits in Chennai, Coimbatore, Madurai and Trichy.

LANGUAGE AND TONE (most important)
- Talk like a calm expert colleague: a sharp business analyst on the management team - warm, confident, to the point. Never a menu, never robotic.
- Always reply in simple, clear English (Indian business English), even if the person writes in Tamil or Tanglish - understand them, answer in English.
- Use everyday business words naturally, not in every line: "on track", "behind", "ahead of", "picked up", "slowed down", "worth a look", "the gap", "pace", "run-rate", "standout", "drag", "quick pulse".
- Never use slang that sounds forced. If unsure, use plain words.
- Greet ("Good afternoon ...") ONLY when the new message is itself a greeting or the conversation is new. Never greet when answering a question or a tapped suggestion - go straight to the answer. Use the first name given under "Person" (if any) only in a greeting. No "As an AI", no "feel free to ask", no lists of commands or example questions.
- Example of the exact style:
  User: "hi"
  You: "Good afternoon Nithish. Quick pulse: division MTD is **Rs 56,82,999**, 31.6% of the Rs 1,80,00,000 target and 1.1% ahead of last month. **Adyar** is the one behind at 28.4%. Want me to look at what's holding Adyar back?"
  User: "how did yesterday go?"
  You: "Yesterday (10 Nov) brought in **Rs 6,12,340**. **Anna Nagar** led with Rs 1,45,200. Shall I break it down by clinic?"
  (These numbers only show the style - always use the real SNAPSHOT numbers.)

STYLE
- Short replies: usually 2-6 lines. Answer first, then one useful observation or offer.
- Ask at most one question at a time, and only when you truly need it.
- **Bold** only the key figure or name; simple "- " bullets only for 3+ items. No long essays, no headings.
- Never mention SQL, tables, JSON, prompts, models or tokens unless asked how you work.

WHAT YOU HELP WITH
- Sales and performance: by clinic / city / Vet on Wheels and any period, targets and achievement, pharmacy, doctors, items, categories (surgery, vaccination, lab, diagnostics, grooming, consultation, boarding), dog vs cat, bills and average bill, new vs repeat pets, pets due for services, trends, comparisons and the "why" behind a number. A data analyst behind you runs live queries for these.
- Business thinking: what a number means, ideas to improve a clinic, what to check next.
- Drafting: WhatsApp / Teams / email messages for the team or clients, ready to paste; use [placeholders] for unknown details, never invented figures or offers.
- If asked something outside this (unrelated topics, personal matters, medical advice for a specific pet), say briefly that it's not something you can help with here and steer back.

ACCURACY
- Name units exactly as the SNAPSHOT does ("CH VET ON WHEELS" is Chennai Vet on Wheels, not Chennai; "COIMBATORE" is the clinic, "CBE VET ON WHEELS" the home visits).
- Use ONLY numbers in the SNAPSHOT below or in the person's own message, written exactly as shown (Rs with Indian commas, %). Never estimate, re-round, add up or invent names, numbers or dates.
- If the answer needs any data the SNAPSHOT does not show, do not guess - route it to the analyst ("data").

ROUTING - decide for every message:
"data": the message needs our data beyond the SNAPSHOT (any breakdown, list, ranking, comparison, trend, category, doctor, item, pet, or a "why"). Write "question": ONE self-contained question in plain English for the analyst, keeping the person's wording for what is asked and adding the place and period from the conversation when the message relies on it (after "Madurai sales this month", "and Trichy?" -> "Trichy sales this month"; "doctor wise?" -> "Madurai sales this month split by doctor"). Write it in English (translate Tamil / Tanglish). Do not add a place or period nobody mentioned. Add "insights" when they ask why or for analysis. Also set "reply" to "" .
"chat": greetings, thanks, small talk, "what can you do", questions about you, business thinking, drafting, or a sales question the SNAPSHOT fully answers. Write "reply". For a greeting or "what can you do": one friendly line, the pulse of the business from the SNAPSHOT (division MTD vs target or last month, plus the one unit that stands out), then one concrete offer.
"suggestions": 2-3 short next questions this person would likely tap (max 8 words, in English, specific: real unit names and periods).
Reply ONLY JSON: {"route":"data"|"chat","question":"","reply":"","suggestions":[]}`;

type Route = { route: "data" | "chat"; question: string; reply: string; suggestions: string[]; model?: string };

// first name of a person; nothing for shared / team accounts ("Data Analyst Sanchu", "Sanchu Reports" ...)
function firstName(who: string) {
  const w = who.replace(/\(.*?\)/g, "").trim();
  if (!w || /\b(sanchu|analyst|team|admin|reports?|account|marketing|sales|hospital|office|desk|support|info|hr|accounts)\b/i.test(w)) return "";
  return w.split(/\s+/)[0].replace(/[^A-Za-z.'-]/g, "");
}

function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3), h = d.getUTCHours();
  const part = h < 5 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}), ${d.toISOString().slice(11, 16)} IST - ${part}`;
}

// drop the sentences / lines of a chat reply whose numbers are not in the snapshot or the conversation
function keepSupported(reply: string, sets: Record<string, unknown>[][]): { text: string; removed: number } {
  let removed = 0;
  const lines = reply.split("\n").map((ln) => {
    if (!unsupported([ln], sets).length) return ln;
    const parts = ln.split(/(?<=[.!?])\s+/).filter((p) => { const ok = !unsupported([p], sets).length; if (!ok) removed++; return ok; });
    return parts.join(" ");
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

async function assistant(text: string, who: string, conv: string): Promise<Route> {
  const [snap, hist, ctx] = await Promise.all([snapshot().catch(() => ({ text: "(snapshot unavailable)", rows: [] as SnapRow[] })), turns(conv), getCtx(conv)]);
  const history = hist.map((t) => `${t.role === "user" ? "Them" : "You"}: ${t.text}`).join("\n");
  const name = firstName(who);
  const user = `Now: ${istNow()}\nPerson: ${name ? `${name} (use this first name only when greeting)` : "a shared team account - do not address anyone by name"}\n` +
    (ctx ? `Last analysed question: ${ctx.question} (${ctx.place_label}, ${ctx.p_label})${ctx.headline ? ` -> ${ctx.headline}` : ""}\n` : "") +
    `\nSNAPSHOT\n${snap.text}\n\nCONVERSATION SO FAR\n${history || "(new conversation)"}\n\nNEW MESSAGE\n${text}`;
  const out = await aiCall("chat", ASSISTANT_SYSTEM, user, 1400);
  const j = parseJson(out.text);
  const r: Route = { route: j.route === "data" ? "data" : "chat", question: String(j.question ?? "").trim(), reply: String(j.reply ?? "").trim(),
    suggestions: Array.isArray(j.suggestions) ? j.suggestions.map(String).filter(Boolean).slice(0, 3) : [], model: out.model };
  if (r.route === "data" && !r.question) r.question = text;
  if (r.route === "chat") {
    const sets: Record<string, unknown>[][] = [snap.rows as Record<string, unknown>[],
      [Object.fromEntries(claimedNumbers(text + "\n" + history).map((c, i) => [i, c.value]))]];
    let bad = unsupported([r.reply], sets);
    if (bad.length) {                                   // one rewrite without the unsupported numbers, then strip what is left
      try {
        const fix = await aiCall("chat", ASSISTANT_SYSTEM, user + `\n\nYour previous reply used numbers that are NOT in the snapshot: ${bad.join(", ")}. ` +
          `Rewrite it using only snapshot numbers (or choose "data").\nPrevious reply: ${r.reply}`, 1400);
        const j2 = parseJson(fix.text);
        if (j2.route === "data" && j2.question) return { ...r, route: "data", question: String(j2.question) };
        if (j2.reply) r.reply = String(j2.reply).trim();
      } catch { /* keep and strip */ }
      bad = unsupported([r.reply], sets);
      if (bad.length) r.reply = keepSupported(r.reply, sets).text;
    }
    if (!r.reply) r.reply = "I'm here - ask me anything about the hospitals' sales, or tell me what you'd like to dig into.";
  }
  return r;
}

// Teams cards join single line breaks; keep paragraphs and bullet lists as written
function teamsText(t: string) {
  const ls = t.split("\n");
  return ls.map((l, i) => (i === 0 ? "" : (/^\s*[-*\d]/.test(l) && /^\s*[-*\d]/.test(ls[i - 1]) ? "\n" : "\n\n")) + l).join("").replace(/\n{3,}/g, "\n\n");
}
function chatCard(reply: string, suggestions: string[]) {
  const actions = suggestions.slice(0, 3).map((f) => ({ type: "Action.Submit", title: f.length > 60 ? f.slice(0, 57) + "..." : f,
    data: { msteams: { type: "messageBack", text: f, displayText: f } } }));
  return { contentType: "application/vnd.microsoft.card.adaptive",
           content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.5",
                      body: [{ type: "TextBlock", text: teamsText(reply), wrap: true }], ...(actions.length ? { actions } : {}), msteams: { width: "Full" } } };
}

const lastAnswer = new Map<string, { sig: string; cacheKey: string }>();   // conversation -> last analysis (for "wrong")

// deno-lint-ignore no-explicit-any
async function handle(act: any) {
  const conv = act.conversation?.id ?? "";
  const text = String(act.text ?? "").replace(/<at>.*?<\/at>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
  const cmd = text.toLowerCase();
  const tenantOk = !env("BOT_TENANT_ID") || (act.conversation?.tenantId ?? act.channelData?.tenant?.id) === env("BOT_TENANT_ID");

  if (cmd === "chat id" && tenantOk) return send(act, { text: `This chat id is: ${conv}` });
  if (!tenantOk || (ALLOWED.length && !ALLOWED.includes(conv))) {
    return send(act, { text: "Sorry, this bot only works in the Sanchu Core team chat." });
  }
  const small = cmd.replace(/[!.?\s]+$/u, "").trim();
  if (/^(stop|end|reset|clear|new( question| chat| topic)?|start over|start fresh|stop( the)? conversation|end( the)? conversation)$/.test(small)) {
    if (conv) { await db.begin("read write", (tx) => tx`delete from vetbuddy.bot_context where conversation = ${conv}`); await clearTurns(conv); }
    return send(act, { text: "Done - fresh start. What would you like to look at?" });
  }
  if (cmd === "usage") {
    const u = await usage();
    const [m] = await db`select count(*)::int as n, coalesce(sum(uses),0)::int as uses from vetbuddy.bot_plan where good`;
    return send(act, { text: `Today: ${inr(u.tokens)} of ${inr(DAILY_CAP)} free AI tokens used (${u.calls} AI calls). ` +
      `Memory: ${m.n} saved analysis plans, re-used ${m.uses} times.` });
  }
  if (cmd === "wrong" || cmd === "incorrect" || cmd === "not correct") {
    const last = lastAnswer.get(conv);
    if (last) await db.begin("read write", async (tx) => {
      await tx`update vetbuddy.bot_plan set good = false where signature = ${last.sig}`;
      await tx`delete from vetbuddy.bot_answer where plan_sig = ${last.sig}`;
    });
    return send(act, { text: "Thanks for flagging it - I've dropped that answer. Ask again (a little more detail helps) and I'll work it out fresh." });
  }

  await send(act, { type: "typing" });
  const who = String(act.from?.name ?? "").trim();
  const said = text || "hi";
  let route: Route;
  try {
    route = await assistant(said, who, conv);
  } catch (e) {
    console.error("assistant", e);
    if (e instanceof LimitError) return send(act, { text: e.message });
    route = { route: "data", question: said, reply: "", suggestions: [] };          // AI busy -> straight to the analyst
  }
  if (route.route === "chat") {
    await addTurns(conv, ["user", said], ["bot", route.reply]);
    return send(act, { attachments: [chatCard(route.reply, route.suggestions)] });
  }
  try {
    const a = await answer(route.question, who, conv);
    if (a.sig && a.cacheKey) lastAnswer.set(conv, { sig: a.sig, cacheKey: a.cacheKey });
    await addTurns(conv, ["user", said], ["bot", [a.title, ...(a.points ?? []).slice(0, 2)].join(" ")]);
    await send(act, { attachments: [card(a)] });
  } catch (e) {
    console.error(e);
    if (e instanceof NotAQuestion) {
      const reply = route.reply || "I'm not sure what you'd like me to look at - a clinic, a period, doctors, items, targets? Tell me and I'll dig in.";
      await addTurns(conv, ["user", said], ["bot", reply]);
      return send(act, { attachments: [chatCard(reply, route.suggestions)] });
    }
    const msg = e instanceof LimitError ? e.message + " Questions asked before still work (they come from memory)."
      : "Sorry, I hit a problem working that out (" + String((e as Error).message).slice(0, 160) + "). Try asking it a little differently.";
    await send(act, { text: msg });
  }
}

// keep working after the HTTP reply has gone back to Teams
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
  if (act.type === "message") {
    // answer in the background; Teams wants a quick 200
    background(handle(act));
  } else if (act.type === "conversationUpdate" && act.membersAdded?.some((m: { id: string }) => m.id === act.recipient?.id)) {
    background(send(act, { text: "Hi everyone! I'm **Sanchu Sales**, your AI assistant for the hospitals' numbers. Mention me and ask in plain words - how a clinic is doing, why sales moved, top doctors or items, targets - or just say hi for today's pulse." }));
  }
  return new Response(null, { status: 200 });
});
