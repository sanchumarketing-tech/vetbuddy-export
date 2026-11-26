import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// light by default; dark only if the person switched it on (corner button)
try { if (localStorage.getItem("cd_theme") === "dark") document.documentElement.dataset.theme = "dark"; } catch { /* ignore */ }

function ThemeButton() {
  const [dark, setDark] = React.useState(document.documentElement.dataset.theme === "dark");
  const flip = () => {
    const d = !dark; setDark(d);
    if (d) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("cd_theme", d ? "dark" : "light"); } catch { /* ignore */ }
  };
  return <button className="theme-btn" onClick={flip} title={dark ? "Switch to light mode" : "Switch to dark mode"} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? "☀" : "☾"}</button>;
}

createRoot(document.getElementById("root")).render(<><App /><ThemeButton /></>);
