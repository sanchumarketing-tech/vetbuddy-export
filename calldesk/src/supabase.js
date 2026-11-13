import { createClient } from "@supabase/supabase-js";

// Public values (the anon key only allows the cd_* functions, which check who is signed in).
const url = import.meta.env.VITE_SUPABASE_URL || "https://ykmgbuooksizjqsyfhut.supabase.co";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrbWdidW9va3Npempxc3lmaHV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3Nzk0MzcsImV4cCI6MjEwOTM1NTQzN30.-mfbJPEfIUIjgTboxviFqqMCHX7ex2Lh95ql-bTcDuQ";

export const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });

export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
