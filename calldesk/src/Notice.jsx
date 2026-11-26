// Team rules notice (26 Nov 2026): shown the first time each person opens the Call Desk each day.
// Remembered per person, per day, on that computer. "Team rules" in the corner opens it again.
import React, { useEffect, useState } from "react";

const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const keyFor = (me) => `cd_rules_seen_${me?.id ?? me?.name ?? "user"}`;

export function RulesNotice({ me }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem(keyFor(me)) !== todayIST()) setOpen(true); } catch { setOpen(true); }
  }, [me]);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });
  const close = () => { try { localStorage.setItem(keyFor(me), todayIST()); } catch { /* ignore */ } setOpen(false); };

  return (
    <>
      <button className="rules-btn" onClick={() => setOpen(true)} title="Team rules">📋 Team rules</button>
      {open && (
        <div className="rules-back" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="rules-card">
            <div className="rules-head">
              <span className="rules-tag">Important · with immediate effect</span>
              <button className="rules-x" onClick={close} aria-label="Close">✕</button>
            </div>
            <h2 id="rules-title">Dear Team,</h2>
            <p>Please be informed that the following rules are being implemented with immediate effect. Everyone is expected to follow them strictly.</p>

            <div className="rules-grid">
              <section className="r1">
                <h3><span>1</span>Total Break Time</h3>
                <ul>
                  <li>The total break allowance is <b>1 hour per day</b>, including lunch breaks, tea breaks and all short breaks.</li>
                  <li>All breaks combined must not exceed 1 hour per day.</li>
                  <li>Any excess break time will be treated as a violation.</li>
                </ul>
              </section>
              <section className="r2">
                <h3><span>2</span>Minimum Call Duration</h3>
                <ul>
                  <li><b>Every call must have a minimum duration of 20 seconds.</b></li>
                  <li>No call should be disconnected or closed before completing 20 seconds without a valid reason.</li>
                  <li>If any call is below 20 seconds, the agent must provide a proper explanation.</li>
                  <li>Repeated short calls or calls without valid explanations will be treated as violations.</li>
                </ul>
              </section>
              <section className="r3">
                <h3><span>3</span>Daily MIS Monitoring</h3>
                <ul>
                  <li>MIS will strictly monitor individual break timings and call durations on a daily basis.</li>
                  <li>Any irregularities, unnecessary short calls or excess break time will be identified and reported.</li>
                </ul>
              </section>
              <section className="r4">
                <h3><span>4</span>Disciplinary Action</h3>
                <ol className="steps">
                  <li><b>1st Violation:</b> First Warning.</li>
                  <li><b>2nd Violation:</b> Second and Final Warning.</li>
                  <li><b>3rd Violation:</b> Immediate termination, subject to company policy and applicable procedures.</li>
                </ol>
              </section>
              <section className="r5">
                <h3><span>5</span>Mandatory Email Acknowledgement</h3>
                <p>Every agent must reply to this email with <b>“Acknowledged”</b>, confirming that they have read, understood and agreed to follow these rules with immediate effect.</p>
              </section>
            </div>

            <p>These rules are being implemented to improve discipline, accountability and productivity across the team.</p>
            <p>Please take this communication seriously. Daily MIS monitoring will be strictly implemented, and repeated violations will not be tolerated.</p>
            <p className="rules-strict">Strict compliance is expected from everyone.</p>
            <p className="rules-sign">Regards,</p>

            <div className="rules-foot">
              <span className="muted small">Shown once a day. Open it again any time from “Team rules” in the corner.</span>
              <button className="primary" onClick={close}>I have read and understood</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
