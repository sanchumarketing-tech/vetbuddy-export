// All data goes through the Python functions on Vercel (/api/*): they keep the login cookie and
// pass the session to Supabase. The page never holds a key or a token.
export class SignedOut extends Error {}

export async function rpc(name, args = {}, retry = true) {
  const r = await fetch("/api/rpc", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn: name, args }),
  });
  if (r.status === 401) { window.dispatchEvent(new Event("cd-signed-out")); throw new SignedOut("Signed out"); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  // statement timeout (cold database, first load of the day): the statement was rolled back, so one retry is safe
  if (!r.ok && retry && data && data.code === "57014") { await new Promise((ok) => setTimeout(ok, 300)); return rpc(name, args, false); }
  if (!r.ok) throw new Error((data && (data.message || data.msg)) || `Error ${r.status}`);
  return data;
}

export async function login(user, pin) {
  const r = await fetch("/api/login", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, pin }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.msg || "Login failed");
  return data;
}

export async function logout() {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
}
