// Corefactor webhook, hosted on Supabase (no Vercel).
//   POST https://ykmgbuooksizjqsyfhut.supabase.co/functions/v1/corefactor/calls?key=<key>   live calls
// Accepts JSON, form-encoded or query-string fields. GET with only the key answers {"ok": true} (link test).
// The body goes to public.cf_webhook, which checks the key, keeps the raw push (calldesk.cf_live_raw)
// and saves the call (calldesk.calls). Lead Box comes through Corefactor's API instead (separate job).
// Deployed with verify_jwt = false so Corefactor needs only the key in the link.

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SHEET_URL = Deno.env.get("SHEET_PUSH_URL") ?? "";
const SHEET_TOKEN = Deno.env.get("SHEET_PUSH_TOKEN") ?? "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function rpc(fn: string, args: unknown) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const kind = u.pathname.split("/").filter(Boolean).pop();
  const fn = kind === "calls" ? "cf_webhook" : null;
  if (!fn) return json(404, { ok: false, message: "use /corefactor/calls" });
  const q = Object.fromEntries(u.searchParams);
  const key = q.key ?? req.headers.get("x-api-key") ?? req.headers.get("x-webhook-key");
  delete q.key;
  if (!key) return json(401, { ok: false, message: "key missing" });

  if (req.method === "GET" && Object.keys(q).length === 0) {
    const r = await rpc("cf_webhook_ping", { p_key: key });
    return json(r.body === true ? 200 : 401, { ok: r.body === true });
  }

  let body: unknown = {};
  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > 200_000) return json(413, { ok: false, message: "too large" });
    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (text) {
      if (ctype.includes("form")) body = Object.fromEntries(new URLSearchParams(text));
      else { try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 20000) }; } }
    }
  }
  if ((!body || (typeof body === "object" && Object.keys(body as object).length === 0)) && Object.keys(q).length) body = q;

  const r = await rpc(fn, { p_key: key, p_body: body });
  if (r.status !== 200) return json(502, { ok: false, message: "database error" });
  // 24 Nov 2026: a saved call is also pushed to the RUNO MIS Google Sheet (Called on Corefactor), in the background —
  // nothing is read from the database for it. SHEET_PUSH_URL / SHEET_PUSH_TOKEN are Edge Function secrets.
  if (r.body?.ok && SHEET_URL && SHEET_TOKEN) {
    const push = fetch(SHEET_URL, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SHEET_TOKEN, kind: "cf", body }),
    }).catch(() => null);
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(push); else await push;
  }
  return json(r.body?.ok ? 200 : 401, r.body);
});
