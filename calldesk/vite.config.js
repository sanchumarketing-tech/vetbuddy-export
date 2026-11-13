import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 3000 = the Site URL in Supabase Auth, so sign-in links come back here when testing locally.
export default defineConfig({ plugins: [react()], server: { port: 3000, strictPort: true } });
