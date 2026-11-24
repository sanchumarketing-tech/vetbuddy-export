/**
 * SM Calling — one Google Sheet per city (Madurai, Valasaravakkam). The same script goes into both files;
 * Settings → C3 says which city the file is for.
 *
 *   Live leads          new leads from the Meta Leads CRM (every minute). The agent calls, fills the row, ticks ✔ Done
 *                       → the row moves on by its comment.
 *   Followup/Callback   Callback · RNR · Hang up · Voicemail · Booked · Inform later. RNR / Hang up / Voicemail: the next
 *                       Followup box turns red every 45 minutes (working hours only), callbacks turn red at their date & time.
 *                       After a call the row goes down by itself. A lead stays a week, then goes to Old leads.
 *   Junk leads          Out of station · No pet · Hindi person · Other — kept for good.
 *   Old leads           every older lead, one row per number, with the last visit from Vetbuddy. Call again, pick the
 *                       comment, tick: Callback / Booked → Followup/Callback, junk → Junk leads, anything else stays.
 *   Summary, Lead quality.
 * Behind the scenes: Leads (one record per lead), Call Log (every call), Visits, Smartflo calls, Uploads read.
 * Untick ✔ on a row that was moved by mistake → it goes back to where it came from.
 *
 * OWNER SETUP (once per city file — the team never touches any of this):
 *  1. A Google Sheet named “SM Calling – Madurai” (and one “SM Calling – Valasaravakkam”). Extensions → Apps Script →
 *     paste this whole file → Save → reload the sheet: the tabs build themselves (Settings → C3 = the city).
 *  2. ⚙ SM Calling (owner) → ① Turn on automatic updates → Allow (in each city file). New leads then come every minute
 *     from 8 am to 6:30 pm, every 5 minutes at night; the “SM Calling uploads” Drive folder is made (Settings → C14).
 *     A newer script pasted later: the automatic run brings the file up to date within a few minutes (not on open).
 *  3. MIS Upload Hub → Connected MIS → “SM Calling sheets” → paste the C14 folder link (same folder for both files).
 *  4. Upload the old comments Excel in the hub (or File → Import here + ②), then ③ for the old CRM leads.
 *     An old Meta lead-form download (created_time, adset_name, phone_number …) uploaded in the hub → Old leads too
 *     (hub → Report Types: “Old Meta leads (lead form download)” · created_time, phone_number · SM Calling sheets).
 *  5. Share the file with the agents as Editor.
 * No web app / deployment is needed for this file.
 */

var FAMILY = 'sm-calling-city';
var REV = '7';
var TZ = 'Asia/Kolkata';
var FONT = 'Arial';

var T = {
  LIVE: 'Live leads', FU: 'Followup/Callback', BOOK: 'Booked leads', VISC: 'Visited customers', JUNK: 'Junk leads', OLD: 'Old leads',
  SUM: 'Summary', QUAL: 'Lead quality',
  HELP: 'How to Use', SET: 'Settings', LEADS: 'Leads', LOG: 'Call Log', VIS: 'Visits', SF: 'Smartflo calls', UP: 'Uploads read'
};
var ORDER = [T.LIVE, T.FU, T.BOOK, T.VISC, T.JUNK, T.OLD, T.SUM, T.QUAL, T.HELP, T.SET, T.LEADS, T.LOG, T.VIS, T.SF, T.UP];
var WORK_TABS = [T.LIVE, T.FU, T.BOOK, T.VISC, T.JUNK];
var CALL_TABS = [T.LIVE, T.FU, T.BOOK, T.VISC, T.JUNK, T.OLD];
var HIDDEN_TABS = [T.LEADS, T.LOG, T.VIS, T.SF, T.UP];

// Live leads / Followup-Callback / Booked leads / Visited customers / Junk leads — the same columns (21–24 are the sheet's own).
// Visited / Not visited is shown on Booked leads and Visited customers only.
var W = { DATE: 1, CALLDATE: 2, CAMP: 3, ADSET: 4, PHONE: 5, CPHONE: 6, NAME: 7, COM: 8, NOTES: 9, DEPT: 10, WA: 11, VISITED: 12, CBD: 13, CBT: 14,
  F1: 15, TICK: 20, NEXT: 21, ID: 22, STATE: 23, ROW: 24, ALERT: 25 };     // ALERT: shown right after Next call (id/state/row are hidden)
var WN = 25, BOXES = 5;
var W_HEADERS = ['Lead date & time', 'Call date', 'Campaign name', 'Adset name', 'Phone number', 'Correct number', 'Client name', 'Comments', 'Notes',
  'Department', 'WhatsApp', 'Visited / Not visited', 'Callback / Booked date', 'Callback / Booked time', 'Followup 1', 'Followup 2', 'Followup 3',
  'Followup 4', 'Followup 5', '✔ Done', 'Next call', 'id', 'state', 'row', '⚠ Overdue'];
var NOSHOW = 'No show';
// Old leads
var O = { DATE: 1, LASTCALL: 2, CAMP: 3, ADSET: 4, PHONE: 5, CPHONE: 6, NAME: 7, VISIT: 8, COM: 9, NOTES: 10, TICK: 11, ID: 12, ROW: 13 };
var ON = 13;
var O_HEADERS = ['Lead date', 'Last called on', 'Campaign name', 'Adset name', 'Phone number', 'Correct number', 'Client name', 'Last visit',
  'Comments', 'Notes', '✔ Done', 'id', 'row'];
var HEAD_ROW = 3, FIRST = 4;

// Leads — one record per lead (hidden)
var L = { ID: 1, DATE: 2, CITY: 3, CAMP: 4, ADSET: 5, PHONE: 6, NAME: 7, SOURCE: 8, TAB: 9, COM: 10, NOTES: 11, DEPT: 12, WA: 13,
  CBD: 14, CBT: 15, F1: 16, TC: 21, TF1: 22, LAST: 27, NEXT: 28, STATE: 29, VISIT: 30, FROM: 31, MOVED: 32, TIDY: 33, OLDRES: 34,
  OLDTIME: 35, ROUND: 36, ADDED: 37, WORKED: 38, PREV: 39, RAW: 40 };
var NL = 40;
var L_HEADERS = ['Lead ID', 'Lead date & time', 'City', 'Campaign name', 'Adset name', 'Phone number', 'Client name', 'Source', 'Tab',
  'Comments', 'Notes', 'Department', 'WhatsApp', 'Callback / Booked date', 'Callback / Booked time', 'Followup 1', 'Followup 2',
  'Followup 3', 'Followup 4', 'Followup 5', 'Comments time', 'Followup 1 time', 'Followup 2 time', 'Followup 3 time',
  'Followup 4 time', 'Followup 5 time', 'Last called', 'Next call', 'State', 'Last visit', 'Came from tab', 'Moved at',
  'Move down after', 'Old leads comment', 'Old leads comment time', 'This round started', 'Added on', 'Worked in this sheet',
  'Before this round', 'Phone as given'];
var LOG_HEADERS = ['Time', 'Lead ID', 'Phone number', 'Comment', 'Connected', 'Box', 'Tab', 'Round'];
var BOX_NAMES = ['Comments', 'Followup 1', 'Followup 2', 'Followup 3', 'Followup 4', 'Followup 5'];

var GOES = { FU: 'Followup/Callback', JUNK: 'Junk leads', OLD: 'Old leads', BOOK: 'Booked leads' };
var BY_OTHER = 'Booked by another agent';
var NODATE_BEFORE = new Date('2026-11-19T00:00:00+05:30');   // bookings picked before this day may stay without a date (one time)
var BOOK_CLOSE_DAYS = 2, VISIT_MOVE_DAYS = 1;          // Booked leads: another comment → Old leads after 2 days; visited → Visited customers after 1 day
var REMIND = { gap: 'Every followup gap', cb: 'At the callback date & time', morning: 'Next morning', appt: 'Morning of the booked day', none: 'None' };
var DEFAULT_COMMENTS = [
  ['Callback', GOES.FU, REMIND.cb, 'Yes'],
  ['RNR', GOES.FU, REMIND.gap, 'No'],
  ['Hang up', GOES.FU, REMIND.gap, 'No'],
  ['Voicemail', GOES.FU, REMIND.gap, 'No'],
  ['Booked', GOES.FU, REMIND.appt, 'Yes'],
  [BY_OTHER, GOES.BOOK, REMIND.none, 'Yes'],
  ['No need', GOES.OLD, REMIND.none, 'Yes'],
  ['Inform later', GOES.FU, REMIND.morning, 'Yes'],
  ['Out of station', GOES.JUNK, REMIND.none, 'Yes'],
  ['No pet', GOES.JUNK, REMIND.none, 'Yes'],
  ['Hindi person', GOES.JUNK, REMIND.none, 'Yes'],
  ['Other', GOES.JUNK, REMIND.none, 'Yes']
];
var DEFAULT_CITIES = [['Madurai', 'madurai, mdu'], ['Valasaravakkam', 'valasaravakkam']];
var DEFAULT_CRM = 'https://docs.google.com/spreadsheets/d/16gHKURpESLqS_WZ5ilFUNTApo0xC7UdtsM5R7qxXqjk/edit';
var DEFAULT_CALL_FOLDER = 'https://drive.google.com/drive/folders/1n84qpxkFrIObs6Wsfuj9wTBxYqWdSa3e';
var UPLOAD_FOLDER_NAME = 'SM Calling uploads';
var DEFAULT_DEPTS = 'Clinical, Salon, Boarding, VOW, Pharmacy, Other';

// Settings cells
var SC = {
  CITY: 'C3', CRM: 'C4', FROM: 'C5', SKIP: 'C6', OPEN: 'C7', CLOSE: 'C8', GAP: 'C9', DAYS: 'C10', REDNEW: 'C11', TIDYMIN: 'C12',
  CALLFOLDER: 'C13', UPFOLDER: 'C14', DEPTS: 'C15', LASTCHECK: 'C17', LASTUP: 'C18', EXCEL: 'C19', OLDCRM: 'C20', DAILY: 'C21',
  CITY_ROW: 25, CITY_ROWS: 4, COM_ROW: 32, COM_ROWS: 20, VERSION: 'H1', REV: 'H2'
};
var COL = { navy: '#1f3a4d', grey: '#5f6b76', line: '#d9dee3', input: '#fff2cc', head: '#1f3a4d', red: '#b71c1c', redFill: '#f4cccc',
  redBox: '#e06666', green: '#d9ead3', done: '#efefef', orange: '#fce5cd', box: '#bf9000' };
var DAY_MS = 86400000;

/* ========================================================================= */
/*  Menu + edits                                                             */
/* ========================================================================= */

function onOpen(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try { ensureSetup_(ss); } catch (err) { console.error(err); }
  SpreadsheetApp.getUi().createMenu('⚙ SM Calling (owner)')
    .addItem('① Turn on automatic updates (every minute)', 'turnOnAutomatic')
    .addItem('② Bring in the old comments Excel', 'bringInOldExcel')
    .addItem('③ Bring in old leads from the CRM (one time)', 'importOldCrmLeads')
    .addSeparator()
    .addItem('Read new uploads now (Vetbuddy / call log / Excel)', 'readUploadsNow')
    .addItem('Rebuild all tabs now', 'rebuildAllNow')
    .addToUi();
}

/** Every edit by anyone. Simple trigger — runs as the person editing, so it only touches this file. */
function onEdit(e) {
  if (!e || !e.range) return;
  var rng = e.range, sh = rng.getSheet(), name = sh.getName(), ss = sh.getParent();
  try {
    if (ensureSetup_(ss)) return;                         // the script was just updated: the tabs were brought up to date first
    if (WORK_TABS.indexOf(name) >= 0) return workEdited_(ss, sh, rng, e);
    if (name === T.OLD) return oldEdited_(ss, sh, rng, e);
    if (name === T.SUM || name === T.QUAL) return reportEdited_(ss, sh, rng);
    if (name === T.SET) return settingsEdited_(ss, sh, rng);
  } catch (err) {
    console.error(err);
    try { ss.toast(String(err && err.message ? err.message : err), 'SM Calling', 8); } catch (x) { }
  }
}

/* ========================================================================= */
/*  Settings                                                                 */
/* ========================================================================= */

function readCfg_(ss) {
  var set = ss.getSheetByName(T.SET);
  var v = set.getRange('C3:C21').getValues().map(function (r) { return r[0]; });
  var at = function (a1) { return v[+a1.slice(1) - 3]; };
  var cfg = {
    city: clean_(at(SC.CITY)), cities: [], crmId: sheetId_(at(SC.CRM)), from: asDate_(at(SC.FROM)),
    skip: splitList_(at(SC.SKIP)).map(function (w) { return w.toLowerCase(); }),
    open: minutesOf_(at(SC.OPEN), 9 * 60), close: minutesOf_(at(SC.CLOSE), 17 * 60 + 30),
    gap: num_(at(SC.GAP)) || 45, days: num_(at(SC.DAYS)) || 7, redNew: num_(at(SC.REDNEW)) || 5, tidyMin: num_(at(SC.TIDYMIN)),
    callFolder: folderId_(at(SC.CALLFOLDER)), upFolder: folderId_(at(SC.UPFOLDER)),
    depts: splitList_(at(SC.DEPTS)), comments: [], rule: {}
  };
  if (!clean_(at(SC.TIDYMIN)) && at(SC.TIDYMIN) !== 0) cfg.tidyMin = 2;
  if (cfg.close <= cfg.open) cfg.close = cfg.open + 60;
  set.getRange(SC.CITY_ROW, 2, SC.CITY_ROWS, 2).getValues().forEach(function (r) {
    var c = clean_(r[0]);
    if (c) cfg.cities.push({ name: c, keys: [c.toLowerCase()].concat(splitList_(r[1]).map(function (k) { return k.toLowerCase(); })) });
  });
  set.getRange(SC.COM_ROW, 2, SC.COM_ROWS, 4).getValues().forEach(function (r) {
    var name = clean_(r[0]);
    if (!name) return;
    var to = clean_(r[1]), rem = clean_(r[2]).toLowerCase();
    var rule = {
      name: name,
      to: to === GOES.JUNK ? 'junk' : to === GOES.OLD ? 'old' : to === GOES.BOOK ? 'book' : 'fu',
      kind: /gap|45/.test(rem) ? 'gap' : /callback/.test(rem) ? 'cb' : /booked|appoint/.test(rem) ? 'appt' : /morning/.test(rem) ? 'morning' : 'none',
      conn: !/^n/i.test(clean_(r[3]))
    };
    cfg.comments.push(rule);
    cfg.rule[name.toLowerCase()] = rule;
  });
  return cfg;
}

/** The rule for a comment (unknown → like “Other”). */
function ruleOf_(res, cfg) {
  var r = cfg.rule[clean_(res).toLowerCase()];
  return r || cfg.rule.other || { name: clean_(res), to: 'junk', kind: 'none', conn: true };
}

function cityOf_(text, cfg) {
  var t = String(text || '').toLowerCase();
  if (!t) return '';
  for (var i = 0; i < cfg.cities.length; i++) {
    if (cfg.cities[i].keys.some(function (k) { return k && new RegExp('(^|[^a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(t); })) return cfg.cities[i].name;
  }
  return '';
}

/** '9:30 AM', '20:00', a time cell … → minutes after midnight. */
function minutesOf_(v, def) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    var p = Utilities.formatDate(v, TZ, 'HH:mm').split(':');
    return +p[0] * 60 + +p[1];
  }
  var m = clean_(v).toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return def;
  var h = +m[1], mi = +(m[2] || 0);
  if (m[3] && /^p/.test(m[3]) && h < 12) h += 12;
  if (m[3] && /^a/.test(m[3]) && h === 12) h = 0;
  return h > 23 || mi > 59 ? def : h * 60 + mi;
}
function timeText_(mins) {
  var h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
  return h12 + ':' + ('0' + m).slice(-2) + ' ' + ap;
}

/* ========================================================================= */
/*  A lead: its calls, what is next                                          */
/* ========================================================================= */

function boxVal_(r, k) { return clean_(r[(k === 0 ? L.COM : L.F1 + k - 1) - 1]); }
function boxTime_(r, k) { return asDate_(r[(k === 0 ? L.TC : L.TF1 + k - 1) - 1]); }
function setBox_(r, k, v, t) { r[(k === 0 ? L.COM : L.F1 + k - 1) - 1] = v; r[(k === 0 ? L.TC : L.TF1 + k - 1) - 1] = t || ''; }

/** The last filled box of this round → { res, t, box } or null. */
function latest_(r) {
  for (var k = BOXES; k >= 0; k--) { var v = boxVal_(r, k); if (v) return { res: v, t: boxTime_(r, k), box: k }; }
  return null;
}
/** The latest comment of all (a call from Old leads counts too) → { res, t } or null. */
function latestAll_(r) {
  var lt = latest_(r), ot = asDate_(r[L.OLDTIME - 1]), or = clean_(r[L.OLDRES - 1]);
  if (or && (!lt || !lt.t || (ot && ot >= lt.t))) return { res: or, t: ot };
  return lt;
}

/** When the callback / booking is: the date + the time picked (no time → the start of the working day). */
function cbTime_(r, cfg) {
  var d = asDate_(r[L.CBD - 1]);
  if (!d) return null;
  var mins = minutesOf_(r[L.CBT - 1], -1);
  return new Date(dayOnly_(d).getTime() + (mins >= 0 ? mins : cfg.open) * 60000);
}
/** d moved into working hours: before opening → opening that day; after closing → opening next day. */
function withinHours_(d, cfg) {
  var day = dayOnly_(d), mins = (d.getTime() - day.getTime()) / 60000;
  if (mins < cfg.open) return new Date(day.getTime() + cfg.open * 60000);
  if (mins > cfg.close) return new Date(day.getTime() + DAY_MS + cfg.open * 60000);
  return d;
}
function nextMorning_(d, cfg) { return new Date(dayOnly_(d).getTime() + DAY_MS + cfg.open * 60000); }

/**
 * Last called, Next call and State of a lead, from its tab and its comments.
 * States: new / called (Live) · active (followup) / callback (callback at a time) / needcb (callback, no time yet) /
 * booked / done / leaving (Followup) · junk · old.
 */
function computeLead_(r, cfg, now) {
  now = now || new Date();
  var last = null;
  for (var k = 0; k <= BOXES; k++) { var t = boxTime_(r, k); if (t && (!last || t > last)) last = t; }
  var ot = asDate_(r[L.OLDTIME - 1]);
  if (ot && (!last || ot > last)) last = ot;
  if (last) r[L.LAST - 1] = last;
  var tab = r[L.TAB - 1], lt = latest_(r), next = '', state = '';
  if (tab === T.LIVE) state = lt ? 'called' : 'new';
  else if (tab === T.BOOK) { var b = bookedState_(r, cfg, now, lt); state = b.state; next = b.next; }
  else if (tab === T.VISC) state = 'visited';
  else if (tab === T.JUNK) state = 'junk';
  else if (tab === T.OLD) state = 'old';
  else if (!lt) { state = 'needcb'; next = asDate_(r[L.MOVED - 1]) || now; }
  else {
    var rule = ruleOf_(lt.res, cfg), at = lt.t || asDate_(r[L.MOVED - 1]) || now, full = lt.box >= BOXES;
    if (rule.to !== 'fu') state = 'leaving';
    else if (rule.kind === 'gap') { if (full) state = 'done'; else { state = 'active'; next = withinHours_(new Date(at.getTime() + cfg.gap * 60000), cfg); } }
    else if (rule.kind === 'cb') {
      var cb = cbTime_(r, cfg);
      if (cb && cb > at) { state = 'callback'; next = cb; }
      else if (full) state = 'done';
      else { state = 'needcb'; next = withinHours_(at, cfg); }
    }
    else if (rule.kind === 'morning') { if (full) state = 'done'; else { state = 'active'; next = nextMorning_(at, cfg); } }
    else if (rule.kind === 'appt') {
      var bd = asDate_(r[L.CBD - 1]);
      if ((!bd || !clean_(r[L.CBT - 1])) && now - at < 2 * DAY_MS) { state = 'needcb'; next = withinHours_(at, cfg); }   // date & time to pick (→ Booked leads)
      else if (!bd) state = 'booked';                                                // an older booking with no date: left as it was
      else if (dayOnly_(bd) > dayOnly_(at) && !full) { state = 'active'; next = new Date(dayOnly_(bd).getTime() + cfg.open * 60000); }
      else state = 'booked';
    }
    else state = 'done';
  }
  r[L.NEXT - 1] = next;
  r[L.STATE - 1] = state;
  return r;
}

/**
 * Booked leads. booked = the visit is still to come · visited = Vetbuddy shows a bill on/after the booked day ·
 * noshow = the booked day passed without a visit (or an RNR / Hang up / Voicemail retry): the next Followup box turns red every
 * followup gap, 5 retries · needcb = Booked again, the new date & time still to pick · closing = another comment (→ Old leads
 * after 2 days) · leaving = 5 retries done (→ Old leads now).
 */
function bookedState_(r, cfg, now, lt) {
  var bd = asDate_(r[L.CBD - 1]), vis = asDate_(r[L.VISIT - 1]);
  if (bd && vis && dayOnly_(vis) >= dayOnly_(bd)) return { state: 'visited', next: '' };
  if (!lt) return bd ? { state: 'booked', next: '' } : { state: 'needcb', next: now };
  var rule = ruleOf_(lt.res, cfg), cb = cbTime_(r, cfg);
  if ((!bd || rule.to === 'book') && noDateOk_(r, cfg, lt)) {                         // booked with no date: visited once Vetbuddy shows it
    var since = lt.t || asDate_(r[L.MOVED - 1]);
    if (vis && since && dayOnly_(vis) >= dayOnly_(since)) return { state: 'visited', next: '' };
    return { state: 'booked', next: '' };
  }
  if (rule.kind === 'appt' || rule.to === 'book') {
    if (!bd || !clean_(r[L.CBT - 1]) || (lt.box > 0 && lt.t && cb && cb <= lt.t)) return { state: 'needcb', next: withinHours_(lt.t || now, cfg) };
    var over = new Date(dayOnly_(bd).getTime() + DAY_MS);
    if (now < over) return { state: 'booked', next: '' };
    if (lt.box >= BOXES) return { state: 'leaving', next: '' };
    return { state: 'noshow', next: withinHours_(new Date(over.getTime() + cfg.open * 60000), cfg) };
  }
  if (rule.kind === 'gap') {
    if (lt.box >= BOXES) return { state: 'leaving', next: '' };
    return { state: 'noshow', next: withinHours_(new Date((lt.t || now).getTime() + cfg.gap * 60000), cfg) };
  }
  return { state: 'closing', next: '' };
}

/** A booking that may have no date: Booked by another agent, or a Booked picked before 19-Nov (one time). */
function noDateOk_(r, cfg, lt) {
  lt = lt || latest_(r);
  if (!lt) return true;
  var ru = ruleOf_(lt.res, cfg);
  return ru.to === 'book' || (ru.kind === 'appt' && (!lt.t || lt.t < NODATE_BEFORE));
}

/** The Visited / Not visited cell: the visit date, “No show” once the booked day has passed, else blank. */
function visitedCell_(r, tab, now) {
  if (tab !== T.BOOK && tab !== T.VISC) return '';
  var bd = asDate_(r[L.CBD - 1]), vis = asDate_(r[L.VISIT - 1]);
  if (!bd) { var lt = latest_(r), since = (lt && lt.t) || asDate_(r[L.MOVED - 1]); return vis && since && dayOnly_(vis) >= dayOnly_(since) ? dayOnly_(vis) : ''; }
  if (vis && (!bd || dayOnly_(vis) >= dayOnly_(bd))) return dayOnly_(vis);
  if (bd && (now || new Date()) >= new Date(dayOnly_(bd).getTime() + DAY_MS)) return NOSHOW;
  return '';
}

/**
 * A lead going to Booked leads starts there with fresh Followup boxes (for the no-show retries): Comments = Booked, the
 * booked date & time kept. The boxes it had are kept for an undo.
 */
function bookRound_(r, now) {
  var lt = latest_(r);
  if (!lt || lt.box === 0) return;
  var cbd = r[L.CBD - 1], cbt = r[L.CBT - 1], t = lt.t || now;
  newRound_(r, lt.res, t, now);
  var p = {};
  try { p = JSON.parse(r[L.PREV - 1]); } catch (err) { p = {}; }
  p.book = 1;
  r[L.PREV - 1] = JSON.stringify(p);
  r[L.CBD - 1] = cbd; r[L.CBT - 1] = cbt;
}

/** Puts a lead into a new round (it left Old leads with a fresh comment): the boxes start empty again. */
function newRound_(r, res, t, now) {
  var keep = {};
  ['COM', 'TC', 'F1', 'TF1', 'CBD', 'CBT', 'ROUND'].forEach(function (f) { keep[f] = r[L[f] - 1]; });
  var prev = { b: [], cbd: asDate_(r[L.CBD - 1]) ? r[L.CBD - 1].getTime() : '', cbt: clean_(r[L.CBT - 1]), round: clean_(r[L.ROUND - 1]),
    oldres: clean_(r[L.OLDRES - 1]), oldtime: asDate_(r[L.OLDTIME - 1]) ? r[L.OLDTIME - 1].getTime() : '' };
  for (var k = 0; k <= BOXES; k++) { prev.b.push([boxVal_(r, k), boxTime_(r, k) ? boxTime_(r, k).getTime() : '']); setBox_(r, k, '', ''); }
  r[L.PREV - 1] = JSON.stringify(prev);
  setBox_(r, 0, res, t);
  r[L.CBD - 1] = ''; r[L.CBT - 1] = '';
  r[L.OLDRES - 1] = ''; r[L.OLDTIME - 1] = '';
  r[L.ROUND - 1] = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm');
}
/** Undo of newRound_. */
function restoreRound_(r) {
  var p = null;
  try { p = JSON.parse(String(r[L.PREV - 1] || '')); } catch (err) { p = null; }
  if (!p || !p.b) return false;
  for (var k = 0; k <= BOXES; k++) setBox_(r, k, p.b[k] ? p.b[k][0] : '', p.b[k] && p.b[k][1] ? new Date(p.b[k][1]) : '');
  r[L.CBD - 1] = p.cbd ? new Date(p.cbd) : ''; r[L.CBT - 1] = p.cbt || '';
  r[L.ROUND - 1] = p.round || '';
  r[L.OLDRES - 1] = p.oldres || ''; r[L.OLDTIME - 1] = p.oldtime ? new Date(p.oldtime) : '';
  r[L.PREV - 1] = '';
  return true;
}

/** Where a comment sends a lead. */
function tabFor_(res, cfg) {
  var to = ruleOf_(res, cfg).to;
  return to === 'junk' ? T.JUNK : to === 'old' ? T.OLD : to === 'book' ? T.BOOK : T.FU;
}

/* ========================================================================= */
/*  The Leads record                                                         */
/* ========================================================================= */

function newLead_() { var r = []; for (var i = 0; i < NL; i++) r.push(''); return r; }

function leadsAll_(ss) {
  var sh = ss.getSheetByName(T.LEADS), last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, NL).getValues() : [];
  var byId = {};
  rows.forEach(function (r, i) { if (r[L.ID - 1]) byId[r[L.ID - 1]] = i; });
  return { sh: sh, rows: rows, byId: byId };
}
/** Row number of a lead on Leads (hint = where it was last time). */
function findLead_(leads, id, hint) {
  hint = +hint;
  if (hint >= 2 && hint <= leads.getLastRow() && leads.getRange(hint, L.ID).getValue() === id) return hint;
  var last = leads.getLastRow();
  if (last < 2) return 0;
  var ids = leads.getRange(2, L.ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}
function readLead_(leads, lr) { return leads.getRange(lr, 1, 1, NL).getValues()[0]; }
function writeLead_(leads, lr, r) { leads.getRange(lr, 1, 1, NL).setValues([r]); }
function appendLeads_(leads, rows) {
  if (!rows.length) return 0;
  var r = Math.max(leads.getLastRow(), 1) + 1;
  ensureRows_(leads, r + rows.length);
  leads.getRange(r, L.PHONE, rows.length, 1).setNumberFormat('@');
  leads.getRange(r, 1, rows.length, NL).setValues(rows);
  return r;
}

/** Call Log: add a line, change the comment of a box already logged, or take a line out (v = ''). */
function logBox_(log, r, k, v, t, tab, cfg) {
  var id = r[L.ID - 1], box = k < 0 ? 'Old leads' : BOX_NAMES[k], round = clean_(r[L.ROUND - 1]);
  var last = log.getLastRow();
  if (k >= 0 && last >= 2) {
    var from = Math.max(2, last - 400), vals = log.getRange(from, 1, last - from + 1, LOG_HEADERS.length).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (vals[i][1] === id && vals[i][5] === box && clean_(vals[i][7]) === round) {
        if (!v) { log.deleteRow(from + i); return; }
        log.getRange(from + i, 4, 1, 2).setValues([[v, ruleOf_(v, cfg).conn ? 'Yes' : 'No']]);
        return;
      }
    }
  }
  if (!v) return;
  var row = Math.max(last, 1) + 1;
  ensureRows_(log, row);
  log.getRange(row, 3).setNumberFormat('@');
  log.getRange(row, 1, 1, LOG_HEADERS.length).setValues([[t, id, r[L.PHONE - 1], v, ruleOf_(v, cfg).conn ? 'Yes' : 'No', box, tab, round]]);
}

/* ========================================================================= */
/*  Edits on Live leads / Followup-Callback / Junk leads                     */
/* ========================================================================= */

var AGENT_FIELDS = [[W.CAMP, L.CAMP], [W.ADSET, L.ADSET], [W.NAME, L.NAME], [W.NOTES, L.NOTES], [W.DEPT, L.DEPT],
  [W.WA, L.WA], [W.CBD, L.CBD], [W.CBT, L.CBT]];

function workEdited_(ss, sh, rng, e) {
  var tab = sh.getName(), r0 = rng.getRow(), nr = rng.getNumRows(), c0 = rng.getColumn(), nc = rng.getNumColumns();
  if (r0 < 3 && nr === 1 && nc === 1) return;
  if (r0 + nr - 1 < FIRST || c0 > W.TICK) return;
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) {                                                       // the sheet is busy: the every-minute run finishes this
    try { PropertiesService.getDocumentProperties().setProperty('MISSED_' + tab, '1'); } catch (err) { }
    ss.toast('Saved — the sheet is busy, this row moves by itself within a minute.', 'SM Calling', 6);
    return;
  }
  try {
    var cfg = readCfg_(ss), now = new Date();
    // the ✔ box of one row
    if (nr === 1 && nc === 1 && c0 === W.TICK) {
      var ticked = sh.getRange(r0, W.TICK).getValue() === true;
      if (tab === T.LIVE && ticked) return tickLive_(ss, cfg, sh, r0, now);
      if (tab !== T.LIVE && !ticked) return undoMove_(ss, cfg, sh, r0, now);
      return;
    }
    var edited = {};
    for (var c = Math.max(c0, 1); c <= Math.min(c0 + nc - 1, W.TICK - 1); c++) edited[c] = 1;
    var from = Math.max(r0, FIRST), to = r0 + nr - 1;
    var rows = sh.getRange(from, 1, to - from + 1, WN).getValues();
    var leads = ss.getSheetByName(T.LEADS), log = ss.getSheetByName(T.LOG), one = null;
    rows.forEach(function (row, k) {
      var res = saveWorkRow_(ss, cfg, leads, log, tab, row, edited, now);
      if (res) { writeSystemCells_(sh, from + k, res, tab); one = res; }
    });
    if (rows.length === 1 && one && tab !== T.BOOK && tab !== T.VISC && byOtherPicked_(one.r, cfg)) {
      toBooked_(ss, cfg, leads, one.lr, one.r, { row: from, now: now });
      ss.toast('Moved to Booked leads (' + BY_OTHER + '). Wrong? Untick ✔ on that row there and it comes back.', 'SM Calling', 6);
      return;
    }
    if (tab === T.FU && rows.length === 1 && one && cfg.tidyMin === 0) settleNow_(ss, cfg, sh, from, one, now);
    if (tab === T.BOOK && rows.length === 1 && one) settleBooked_(ss, cfg, sh, from, one, now);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Saves what the agent typed / picked in one row to the lead's record (and the Call Log for comments).
 * A row with a phone number but no id (typed by hand on Live leads) becomes a new lead.
 * → { r, lr, isNew } or null.
 */
function saveWorkRow_(ss, cfg, leads, log, tab, row, edited, now) {
  var id = clean_(row[W.ID - 1]), r, lr, isNew = false;
  if (!id) {
    if (tab !== T.LIVE || !(clean_(row[W.PHONE - 1]) || clean_(row[W.NAME - 1]) || clean_(row[W.COM - 1]))) return null;
    r = newLead_();
    r[L.ID - 1] = 'hand:' + Utilities.getUuid().slice(0, 8);
    r[L.DATE - 1] = now; r[L.CITY - 1] = cfg.city; r[L.SOURCE - 1] = 'Added by hand on Live leads'; r[L.TAB - 1] = T.LIVE; r[L.ADDED - 1] = now;
    lr = appendLeads_(leads, [r]);
    isNew = true;
    edited = {};
    for (var c = 1; c < W.TICK; c++) edited[c] = 1;
  } else {
    lr = findLead_(leads, id, row[W.ROW - 1]);
    if (!lr) return null;
    r = readLead_(leads, lr);
  }
  AGENT_FIELDS.forEach(function (f) {
    if (!edited[f[0]]) return;
    var v = row[f[0] - 1];
    if (f[0] === W.CBD) v = asDate_(v) || '';
    else if (f[0] === W.CBT) v = v instanceof Date ? Utilities.formatDate(v, TZ, 'h:mm a') : clean_(v);
    else v = clean_(v);
    r[f[1] - 1] = v;
  });
  if (edited[W.PHONE] || edited[W.CPHONE]) setPhones_(r, row[W.PHONE - 1], row[W.CPHONE - 1], edited[W.PHONE], edited[W.CPHONE]);
  if (tab === T.FU && edited[W.NOTES] && junkNote_(r[L.NOTES - 1])) {
    r[L.TIDY - 1] = new Date(now.getTime() + cfg.tidyMin * 60000);              // a note that says junk → Junk leads in a couple of minutes
    try { PropertiesService.getDocumentProperties().setProperty('TIDY', '1'); } catch (err) { }
  }
  var picked = false;
  for (var k = 0; k <= BOXES; k++) {
    var col = k === 0 ? W.COM : W.F1 + k - 1;
    if (!edited[col]) continue;
    var v = canonical_(row[col - 1], cfg), old = boxVal_(r, k);
    if (v === old) continue;
    picked = true;
    setBox_(r, k, v, v ? (old && boxTime_(r, k) ? boxTime_(r, k) : now) : '');
    logBox_(log, r, k, v, boxTime_(r, k) || now, tab, cfg);
  }
  if (picked || isNew) r[L.WORKED - 1] = 1;
  if (tab === T.FU && (picked || edited[W.CBD] || edited[W.CBT])) {
    r[L.TIDY - 1] = new Date(now.getTime() + cfg.tidyMin * 60000);
    try { PropertiesService.getDocumentProperties().setProperty('TIDY', '1'); } catch (err) { }
  }
  computeLead_(r, cfg, now);
  writeLead_(leads, lr, r);
  return { r: r, lr: lr, isNew: isNew };
}

/**
 * Followup/Callback, one row just saved (C12 = 0): the row goes where it now belongs straight away — down the list after a
 * call, to Old leads / Junk leads when the comment says so. A Callback / Booked pick waits until its date and time are
 * typed (then moves); if they are never typed, the every-minute run moves it 2 minutes later.
 */
function settleNow_(ss, cfg, sh, row, res, now) {
  var r = res.r, due = asDate_(r[L.TIDY - 1]), leads = ss.getSheetByName(T.LEADS);
  if (!due) return;
  var lt = latest_(r), rule = lt ? ruleOf_(lt.res, cfg) : null;
  if (rule && (rule.kind === 'cb' || rule.kind === 'appt') && rule.to !== 'book' && r[L.STATE - 1] !== 'leaving') {
    var cb = cbTime_(r, cfg), picked = lt.t && lt.t.getTime() === now.getTime();
    if (picked && cb && cb.getTime() <= now.getTime()) {                         // the date & time of the last callback: clear for the new one
      r[L.CBD - 1] = ''; r[L.CBT - 1] = '';
      sh.getRange(row, W.CBD, 1, 2).setValues([['', '']]);
      computeLead_(r, cfg, now);
      sh.getRange(row, W.NEXT, 1, 4).setValues([[asDate_(r[L.NEXT - 1]) || '', r[L.ID - 1], r[L.STATE - 1], res.lr]]);
    }
    if (!asDate_(r[L.CBD - 1]) || !clean_(r[L.CBT - 1])) {                        // wait for the date & time (or 2 minutes)
      r[L.TIDY - 1] = new Date(now.getTime() + 2 * 60000);
      writeLead_(leads, res.lr, r);
      return;
    }
  }
  r[L.TIDY - 1] = '';
  if (junkNote_(r[L.NOTES - 1])) return moveLead_(ss, cfg, leads, res.lr, r, T.JUNK, { row: row, now: now });
  if (isBooking_(r, cfg)) return toBooked_(ss, cfg, leads, res.lr, r, { row: row, now: now });
  if (r[L.STATE - 1] === 'leaving' && lt) return moveLead_(ss, cfg, leads, res.lr, r, tabFor_(lt.res, cfg), { row: row, now: now });
  writeLead_(leads, res.lr, r);
  var p = isWaiting_(r[L.STATE - 1]) ? fuSlot_(sh, r, row, now) : Math.max(sh.getLastRow(), FIRST);
  moveRow_(sh, row, p);
}

/** The cells the sheet fills itself (never what the agent types). */
function writeSystemCells_(sh, row, res, tab) {
  var r = res.r, last = asDate_(r[L.LAST - 1]);
  if (res.isNew) {
    sh.getRange(row, W.DATE).setValue(r[L.DATE - 1]);
    sh.getRange(row, W.TICK).insertCheckboxes();
  }
  sh.getRange(row, W.CALLDATE).setValue(last ? dayOnly_(last) : '');
  sh.getRange(row, W.CPHONE).setValue(r[L.PHONE - 1]);
  if (tab === T.BOOK || tab === T.VISC) sh.getRange(row, W.VISITED).setValue(visitedCell_(r, tab));
  sh.getRange(row, W.NEXT, 1, 4).setValues([[asDate_(r[L.NEXT - 1]) || '', r[L.ID - 1], r[L.STATE - 1], res.lr]]);
}

/** ✔ on Live leads: the row moves to the tab its comment belongs to. */
function tickLive_(ss, cfg, sh, row, now) {
  var vals = sh.getRange(row, 1, 1, WN).getValues()[0];
  var leads = ss.getSheetByName(T.LEADS), log = ss.getSheetByName(T.LOG);
  var all = {};
  for (var c = 1; c < W.TICK; c++) all[c] = 1;
  var res = saveWorkRow_(ss, cfg, leads, log, T.LIVE, vals, all, now);     // anything typed but not saved yet
  if (!res) { sh.getRange(row, W.TICK).setValue(false); return; }
  if (res.isNew) writeSystemCells_(sh, row, res, T.LIVE);                       // a row typed by hand: its id first
  var go = liveRoute_(res.r, cfg);
  if (!go.to) {
    sh.getRange(row, W.TICK).setValue(false);
    writeSystemCells_(sh, row, res, T.LIVE);
    ss.toast(go.why, 'SM Calling', 8);
    return;
  }
  if (go.to === T.BOOK) toBooked_(ss, cfg, leads, res.lr, res.r, { row: row, now: now });
  else moveLead_(ss, cfg, leads, res.lr, res.r, go.to, { row: row, now: now });
  ss.toast('Moved to ' + go.to + '. Wrong? Untick ✔ on that row there and it comes back.', 'SM Calling', 5);
}

/**
 * Where a ticked Live leads row goes → { to } or { why } (it stays). Junk comments and No need go straight away; every other
 * comment needs WhatsApp = Yes first; Booked also needs the booked date & time (→ Booked leads).
 */
function liveRoute_(r, cfg) {
  var lt = latest_(r);
  if (!lt) return { why: 'Pick the comment first, then tick ✔.' };
  if (junkNote_(r[L.NOTES - 1])) return { to: T.JUNK };
  var to = tabFor_(lt.res, cfg);
  if (to !== T.FU) return { to: to };                                                // junk, No need, Booked by another agent
  if (clean_(r[L.WA - 1]).toLowerCase() !== 'yes')
    return { why: 'WhatsApp is not Yes — the lead stays on Live leads. Send the WhatsApp, set WhatsApp = Yes, then tick ✔.' };
  if (ruleOf_(lt.res, cfg).kind === 'appt') {
    if (!asDate_(r[L.CBD - 1]) || !clean_(r[L.CBT - 1])) return { why: 'Fill the booked date and time, then tick ✔.' };
    return { to: T.BOOK };
  }
  return { to: T.FU };
}

/** A comment that means booked (Booked, Booked by another agent). */
function isBookedRes_(v, cfg) { var ru = ruleOf_(v, cfg); return ru.kind === 'appt' || ru.to === 'book'; }

/** The latest comment is Booked and the booked date & time are filled — or a comment that goes to Booked leads by itself. */
function isBooking_(r, cfg) {
  var lt = latest_(r);
  if (lt && ruleOf_(lt.res, cfg).to === 'book') return true;
  if (!lt || ruleOf_(lt.res, cfg).kind !== 'appt' || !asDate_(r[L.CBD - 1]) || !clean_(r[L.CBT - 1])) return false;
  var cb = cbTime_(r, cfg);
  return !(lt.box > 0 && lt.t && cb && cb <= lt.t);                                 // a booking made now is for later
}

/** The latest comment goes to Booked leads by itself (Booked by another agent). */
function byOtherPicked_(r, cfg) { var lt = latest_(r); return !!lt && ruleOf_(lt.res, cfg).to === 'book'; }

/** → Booked leads (fresh Followup boxes for the no-show retries). */
function toBooked_(ss, cfg, leads, lr, r, opts) {
  bookRound_(r, opts.now || new Date());
  return moveLead_(ss, cfg, leads, lr, r, T.BOOK, opts);
}

/**
 * Booked leads, one row just saved: a retry made → the row goes to its place straight away; 5 retries with no answer → Old
 * leads now; Booked again with its new date & time → waits for the visit; any other comment → Old leads after 2 days.
 */
function settleBooked_(ss, cfg, sh, row, res, now) {
  var r = res.r, leads = ss.getSheetByName(T.LEADS);
  computeLead_(r, cfg, now);
  var st = r[L.STATE - 1];
  if (st === 'leaving') return moveLead_(ss, cfg, leads, res.lr, r, T.OLD, { row: row, now: now });
  bookedTimers_(r, now);
  writeLead_(leads, res.lr, r);
  sh.getRange(row, W.VISITED).setValue(visitedCell_(r, T.BOOK, now));
  sh.getRange(row, W.NEXT, 1, 4).setValues([[asDate_(r[L.NEXT - 1]) || '', r[L.ID - 1], st, res.lr]]);
  var p = isWaiting_(st) ? fuSlot_(sh, r, row, now) : Math.max(sh.getLastRow(), FIRST);
  moveRow_(sh, row, p);
}

/** A booking whose fresh boxes were overwritten by its old ones (the same boxes as kept for the undo): fresh boxes again. */
function refreshBookRound_(r) {
  var p = null;
  try { p = JSON.parse(String(r[L.PREV - 1] || '')); } catch (err) { p = null; }
  if (!p || !p.book || !p.b) return false;
  for (var k = 0; k <= BOXES; k++) if (boxVal_(r, k) !== clean_(p.b[k] ? p.b[k][0] : '')) return false;
  var lt = latest_(r);
  if (!lt || lt.box === 0) return false;
  for (var j = 0; j <= BOXES; j++) setBox_(r, j, '', '');
  setBox_(r, 0, lt.res, lt.t);
  return true;
}

/** Booked leads timers (L.TIDY): visited → Visited customers 1 day later; another comment → Old leads 2 days after it. */
function bookedTimers_(r, now) {
  var st = r[L.STATE - 1], due = asDate_(r[L.TIDY - 1]), lt = latest_(r);
  if (st === 'visited') { if (!due) r[L.TIDY - 1] = new Date(now.getTime() + VISIT_MOVE_DAYS * DAY_MS); }
  else if (st === 'closing') { var at = (lt && lt.t) || now; r[L.TIDY - 1] = new Date(at.getTime() + BOOK_CLOSE_DAYS * DAY_MS); }
  else r[L.TIDY - 1] = '';
}

/** ✔ taken off a row that was moved → it goes back to where it came from. */
function undoMove_(ss, cfg, sh, row, now) {
  var tab = sh.getName(), idCol = tab === T.OLD ? O.ID : W.ID, rowCol = tab === T.OLD ? O.ROW : W.ROW;
  var vals = sh.getRange(row, 1, 1, tab === T.OLD ? ON : WN).getValues()[0];
  var leads = ss.getSheetByName(T.LEADS), lr = findLead_(leads, clean_(vals[idCol - 1]), vals[rowCol - 1]);
  if (!lr) return;
  var r = readLead_(leads, lr), back = clean_(r[L.FROM - 1]), moved = asDate_(r[L.MOVED - 1]);
  if (!back || back === tab || ORDER.indexOf(back) < 0 || !moved || dayOnly_(moved).getTime() !== dayOnly_(now).getTime()) {
    if (tab !== T.OLD) sh.getRange(row, W.TICK).setValue(true);
    if (tab !== T.OLD) ss.toast('Only a row moved here today can be sent back.', 'SM Calling', 5);
    return;
  }
  if (back === T.OLD && clean_(r[L.PREV - 1])) restoreRound_(r);                  // it had left Old leads with a fresh comment (or Booked by another agent)
  else if (tab === T.BOOK && /"book":1/.test(String(r[L.PREV - 1] || ''))) restoreRound_(r);   // it came with fresh boxes
  r[L.TIDY - 1] = '';
  moveLead_(ss, cfg, leads, lr, r, back, { row: row, now: now, undo: true });
  ss.toast('Sent back to ' + back + '.', 'SM Calling', 5);
}

/* ========================================================================= */
/*  Edits on Old leads                                                       */
/* ========================================================================= */

function oldEdited_(ss, sh, rng, e) {
  var r0 = rng.getRow(), nr = rng.getNumRows(), c0 = rng.getColumn(), nc = rng.getNumColumns();
  if (r0 + nr - 1 < FIRST || c0 > O.TICK) return;
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) { ss.toast('Busy — try again in a few seconds.', 'SM Calling', 5); return; }
  try {
    var cfg = readCfg_(ss), now = new Date(), leads = ss.getSheetByName(T.LEADS), log = ss.getSheetByName(T.LOG);
    if (nr === 1 && nc === 1 && c0 === O.TICK) {
      if (sh.getRange(r0, O.TICK).getValue() === true) return tickOld_(ss, cfg, sh, r0, now);
      return undoMove_(ss, cfg, sh, r0, now);
    }
    var from = Math.max(r0, FIRST), to = r0 + nr - 1;
    var rows = sh.getRange(from, 1, to - from + 1, ON).getValues();
    rows.forEach(function (row, k) {
      var lr = findLead_(leads, clean_(row[O.ID - 1]), row[O.ROW - 1]);
      if (!lr) return;
      var r = readLead_(leads, lr);
      if (c0 <= O.NAME && c0 + nc - 1 >= O.NAME) r[L.NAME - 1] = clean_(row[O.NAME - 1]);
      var eP = c0 <= O.PHONE && c0 + nc - 1 >= O.PHONE, eC = c0 <= O.CPHONE && c0 + nc - 1 >= O.CPHONE;
      if (eP || eC) { setPhones_(r, row[O.PHONE - 1], row[O.CPHONE - 1], eP, eC); sh.getRange(from + k, O.CPHONE).setValue(r[L.PHONE - 1]); }
      if (c0 <= O.NOTES && c0 + nc - 1 >= O.NOTES) r[L.NOTES - 1] = clean_(row[O.NOTES - 1]);
      if (c0 <= O.COM && c0 + nc - 1 >= O.COM) {
        var v = canonical_(row[O.COM - 1], cfg), shown = latestAll_(r);
        if (v && (nr === 1 || !shown || v !== shown.res)) {
          r[L.OLDRES - 1] = v; r[L.OLDTIME - 1] = now; r[L.WORKED - 1] = 1;
          logBox_(log, r, -1, v, now, T.OLD, cfg);
        }
      }
      if (nr === 1 && ruleOf_(clean_(r[L.OLDRES - 1]), cfg).to === 'book' && asDate_(r[L.OLDTIME - 1]) && r[L.OLDTIME - 1].getTime() === now.getTime()) {
        newRound_(r, clean_(r[L.OLDRES - 1]), now, now);
        moveLead_(ss, cfg, leads, lr, r, T.BOOK, { row: from + k, now: now });
        ss.toast('Moved to Booked leads (' + BY_OTHER + '). Wrong? Untick ✔ on that row there and it comes back.', 'SM Calling', 6);
        return;
      }
      computeLead_(r, cfg, now);
      writeLead_(leads, lr, r);
      var lc = asDate_(r[L.LAST - 1]);
      sh.getRange(from + k, O.LASTCALL).setValue(lc ? dayOnly_(lc) : '-');
      sh.getRange(from + k, O.ROW).setValue(lr);
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * ✔ on Old leads after calling: Callback / Booked → Followup/Callback (pick the date & time there),
 * junk → Junk leads, anything else stays here with today as “Last called on”.
 */
function tickOld_(ss, cfg, sh, row, now) {
  var vals = sh.getRange(row, 1, 1, ON).getValues()[0];
  var leads = ss.getSheetByName(T.LEADS), lr = findLead_(leads, clean_(vals[O.ID - 1]), vals[O.ROW - 1]);
  if (!lr) { sh.getRange(row, O.TICK).setValue(false); return; }
  var r = readLead_(leads, lr), ot = asDate_(r[L.OLDTIME - 1]), res = clean_(r[L.OLDRES - 1]);
  if (junkNote_(r[L.NOTES - 1])) {                                              // “wrongly filled” / “out of station” in Notes
    moveLead_(ss, cfg, leads, lr, r, T.JUNK, { row: row, now: now });
    ss.toast('Moved to Junk leads (Notes say wrongly filled / out of station). Wrong? Untick ✔ on that row there.', 'SM Calling', 6);
    return;
  }
  if (!res || !ot || dayOnly_(ot).getTime() !== dayOnly_(now).getTime()) {
    sh.getRange(row, O.TICK).setValue(false);
    ss.toast('Pick the comment of today’s call first, then tick ✔.', 'SM Calling', 6);
    return;
  }
  var rule = ruleOf_(res, cfg);
  var to = rule.to === 'junk' ? T.JUNK : (rule.kind === 'cb' || rule.kind === 'appt') && rule.to === 'fu' ? T.FU : '';
  if (!to) {
    sh.getRange(row, O.TICK).setValue(false);
    ss.toast('Saved — “' + res + '” stays on Old leads.', 'SM Calling', 4);
    return;
  }
  newRound_(r, res, ot, now);
  moveLead_(ss, cfg, leads, lr, r, to, { row: row, now: now });
  ss.toast('Moved to ' + to + (to === T.FU && rule.kind === 'cb' ? ' — pick the callback date & time there.' : '.') + ' Wrong? Untick ✔ on that row.', 'SM Calling', 6);
}

/* ========================================================================= */
/*  Helpers                                                                  */
/* ========================================================================= */

/** A comment as the list spells it (old values: 'rnr', 'hungup', 'switched off' …). */
function canonical_(v, cfg) {
  var t = clean_(v);
  if (!t) return '';
  var low = t.toLowerCase();
  if (cfg.rule[low]) return cfg.rule[low].name;
  var m = mapResult_(low);
  var name = m ? legacy_(m.result) : 'Other';
  return cfg.rule[name.toLowerCase()] ? cfg.rule[name.toLowerCase()].name : (cfg.rule.other ? cfg.rule.other.name : name);
}
/** Results of the old Excel that are not in the list any more. */
function legacy_(res) {
  return { 'Switched off': 'RNR', 'Busy': 'RNR', 'Not reachable': 'RNR', 'Visited': 'Booked', 'Wrong number': 'Other', 'Other place': 'Other' }[res] || res;
}

/** Old free text → { result, extra } (extra = words worth keeping as a note). */
function mapResult_(low) {
  var t = String(low || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t === '-' || /rnr\s*\/\s*hang/.test(t)) return null;
  var R = [
    [/^(r\s*n\s*r|rnr|rbr|rnt|rn|rnr busy)\b|ring no response/, 'RNR'],
    [/hang\s*-?\s*up|hung\s*up/, 'Hang up'],
    [/voice\s*mail/, 'Voicemail'],
    [/switch(ed)?\s*off/, 'Switched off'],
    [/^busy/, 'Busy'],
    [/not\s*re(a|e)?r?ch|not recbl|no incom|not rearch|out of coverage/, 'Not reachable'],
    [/call\s*back|cal back|callback|call bck|eve call|tom+o?r+o?w|call (on|at|after)|^at \d/, 'Callback'],
    [/inform later|will inform|week later|next week|will come|will call|he will call|cus will call/, 'Inform later'],
    [/out of station|out station/, 'Out of station'],
    [/^booked|already booked|already appt|appointment booked|^appt/, 'Booked'],
    [/visited|completed/, 'Visited'],
    [/no\s*need|not required|not interested|noneed|dis\s*satisf|not satisf|not statisf|competet|competitor/, 'No need'],
    [/no\s*pet|nopet|pet died|pet sales/, 'No pet'],
    [/wrong|invalid|incomplete|out of service|wrongly filled|not a valid/, 'Wrong number'],
    [/hindi/, 'Hindi person'],
    [/district|far\s*away|salem|bangalore|bengaluru|trichy|deva ?kot|chennai cus|other (place|city)|^cbe$/, 'Other place']
  ];
  for (var i = 0; i < R.length; i++) if (R[i][0].test(t)) return { result: R[i][1], extra: /^(rnr|rn|rbr|rnt|rnr busy|hangup|hang up|hung up|hungup|voicemail|voice mail|busy|booked|no need|noneed|not required|no pet|nopet|callback|call back|visited|hindi person|out of station|switch off|switchoff|switched off|not reachable|wrong number|inform later|will inform later|other place|other)$/.test(t) ? '' : low };
  return { result: 'Other', extra: low };
}

/** A phone number → { phone: its last 10 digits (the correct number), raw: as it was given, ok: a real Indian mobile }. */
function normPhone_(v) {
  var raw = String(v === null || v === undefined ? '' : v).trim().replace(/^p:\s*/i, '');
  if (/^\d+\.0+$/.test(raw)) raw = raw.replace(/\.0+$/, '');
  var d = raw.replace(/\D/g, ''), phone = d.length > 10 ? d.slice(-10) : d;
  return { phone: phone || raw, raw: raw, ok: phone.length === 10 && /^[6-9]/.test(phone) };
}
/** Phone number (as given) and Correct number of a lead, from what was typed on a tab. */
function setPhones_(r, given, correct, editedGiven, editedCorrect) {
  var before = clean_(r[L.PHONE - 1]);
  if (editedGiven) r[L.RAW - 1] = normPhone_(given).raw;
  var fixed = editedCorrect ? normPhone_(correct).phone : '';
  r[L.PHONE - 1] = fixed && fixed !== before ? fixed : normPhone_(r[L.RAW - 1] || before).phone;
  if (!clean_(r[L.RAW - 1])) r[L.RAW - 1] = r[L.PHONE - 1];
}
/** Notes that say the lead is junk: “wrongly filled” (any spelling) or “out of station”. */
function junkNote_(notes) {
  return /wr[a-z]{1,7}ly\s*fil+e?d|out\s*(of\s*)?station/i.test(String(notes || ''));
}

function sheetId_(v) { var s = clean_(v), m = s.match(/\/d\/([\w-]{20,})/); return m ? m[1] : (/^[\w-]{20,}$/.test(s) ? s : ''); }
function folderId_(v) { var s = clean_(v), m = s.match(/folders\/([\w-]{20,})/); return m ? m[1] : (/^[\w-]{20,}$/.test(s) ? s : ''); }
function splitList_(v) { return String(v || '').split(/[,\n]/).map(clean_).filter(Boolean); }
function clean_(v) { return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function num_(v) { var n = Number(String(v === null || v === undefined ? '' : v).replace(/[,₹\s]/g, '')); return isFinite(n) ? n : 0; }
function asDate_(v) { return v instanceof Date && !isNaN(v.getTime()) ? v : null; }
function time_(v) { var d = asDate_(v); return d ? d.getTime() : 0; }
/** Midnight (India time) of the day d falls on. */
function dayOnly_(d) {
  var s = Utilities.formatDate(d, TZ, 'yyyy-MM-dd').split('-');
  return new Date(Date.UTC(+s[0], +s[1] - 1, +s[2]) - 330 * 60000);
}
function addDays_(d, n) { return new Date(d.getTime() + n * DAY_MS); }
function ensureRows_(sh, needed) { var max = sh.getMaxRows(); if (max < needed) sh.insertRowsAfter(max, needed - max + 50); }
/** A new tab has 26 columns (A–Z); add more when a tab needs them. */
function ensureCols_(sh, n) { var m = sh.getMaxColumns(); if (m < n) sh.insertColumnsAfter(m, n - m); }
function widths_(sh, px) { ensureCols_(sh, px.length); for (var i = 0; i < px.length; i++) if (px[i]) sh.setColumnWidth(i + 1, px[i]); }
function hash_(s) {
  var a = 5381, b = 52711;
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = ((a << 5) + a + c) | 0; b = ((b << 7) - b + c) | 0; }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/* ========================================================================= */
/*  Rows on the tabs                                                         */
/* ========================================================================= */

/** The row of a lead on Live / Followup / Junk. */
function workCells_(r, lr, tab) {
  var last = asDate_(r[L.LAST - 1]);
  var out = [asDate_(r[L.DATE - 1]) || '', last ? dayOnly_(last) : '', r[L.CAMP - 1], r[L.ADSET - 1], r[L.RAW - 1] || r[L.PHONE - 1], r[L.PHONE - 1], r[L.NAME - 1],
    r[L.COM - 1], r[L.NOTES - 1], r[L.DEPT - 1], r[L.WA - 1], visitedCell_(r, tab), asDate_(r[L.CBD - 1]) || '',
    r[L.CBT - 1] instanceof Date ? Utilities.formatDate(r[L.CBT - 1], TZ, 'h:mm a') : r[L.CBT - 1]];
  for (var k = 0; k < BOXES; k++) out.push(r[L.F1 - 1 + k]);
  out.push(tab !== T.LIVE);
  out.push(asDate_(r[L.NEXT - 1]) || '', r[L.ID - 1], r[L.STATE - 1], lr, tab === T.FU || tab === T.BOOK ? alertFormula_() : '');
  return out;
}
/** Followup/Callback “⚠ Overdue”: a call still to make whose time passed more than 3 days ago (the same formula on every row). */
function alertFormula_() {
  var n = 'INDEX($' + colL_(W.NEXT) + ':$' + colL_(W.NEXT) + ',ROW())', st = 'INDEX($' + colL_(W.STATE) + ':$' + colL_(W.STATE) + ',ROW())';
  return '=IF(AND(' + n + '<>"",OR(' + st + '="active",' + st + '="callback",' + st + '="needcb",' + st + '="noshow"),NOW()-' + n + '>3),"🚨 "&INT(NOW()-' + n +
    ')&" days overdue — call now","")';
}
/** The row of a lead on Old leads. */
function oldCells_(r, lr, ticked) {
  var d = asDate_(r[L.DATE - 1]), lc = asDate_(r[L.LAST - 1]), vis = asDate_(r[L.VISIT - 1]), la = latestAll_(r);
  return [d ? dayOnly_(d) : '', lc ? dayOnly_(lc) : '-', r[L.CAMP - 1], r[L.ADSET - 1], r[L.RAW - 1] || r[L.PHONE - 1], r[L.PHONE - 1], r[L.NAME - 1],
    vis ? dayOnly_(vis) : '-', la ? la.res : '', r[L.NOTES - 1], !!ticked, r[L.ID - 1], lr];
}

/** Column number → letter (1 → A). */
function colL_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/** The tab a sheet is (while it is being built it is called “Live leads …”). */
function tabOf_(sh) { return sh.getName().replace(/ …$/, ''); }
function idCol_(tab) { return tab === T.OLD ? O.ID : W.ID; }
function width_(tab) { return tab === T.OLD ? ON : WN; }
function tickCol_(tab) { return tab === T.OLD ? O.TICK : W.TICK; }

/** Row of a lead on a tab (hint = the row it was edited on). */
function findOnTab_(sh, id, hint) {
  var col = idCol_(tabOf_(sh)), last = sh.getLastRow();
  hint = +hint;
  if (hint >= FIRST && hint <= last && sh.getRange(hint, col).getValue() === id) return hint;
  if (last < FIRST) return 0;
  var ids = sh.getRange(FIRST, col, last - FIRST + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return FIRST + i;
  return 0;
}

function removeRow_(sh, at) {
  if (sh.getMaxRows() <= FIRST) { sh.getRange(at, 1, 1, width_(tabOf_(sh))).clearContent(); return; }
  sh.deleteRow(at);
}

/** Grows a tab inside its formatted area (new rows get the dropdowns, colours and filter of the rows around them). */
function growRows_(ss, sh, need, cfg) {
  var max = sh.getMaxRows();
  if (max >= need + 5) return;
  var add = need + 200 - max;
  cfg = cfg || readCfg_(ss);
  sh.insertRowsBefore(max, add);
  rowFormats_(sh, tabOf_(sh), max, add + 1, cfg);
  applyColours_(ss, sh, cfg);
}

/** Writes a lead at the bottom of a tab → its row. */
function appendRow_(ss, sh, cells) {
  var tab = tabOf_(sh), row = Math.max(sh.getLastRow(), HEAD_ROW) + 1;
  growRows_(ss, sh, row);
  if (tab !== T.OLD) { sh.getRange(row, W.CBT).setNumberFormat('@'); sh.getRange(row, W.VISITED).setNumberFormat('dd-mmm-yy'); }
  sh.getRange(row, 1, 1, cells.length).setValues([cells]);
  var tc = tickCol_(tab);
  sh.getRange(row, tc).insertCheckboxes();
  sh.getRange(row, tc).setValue(cells[tc - 1] === true);
  return row;
}

/** Moves one row so that it ends up at row `to`. */
function moveRow_(sh, from, to) {
  if (from === to) return;
  sh.moveRows(sh.getRange(from, 1), to > from ? to + 1 : to);
}

/**
 * Followup/Callback order: (1) callbacks whose time has come, at the top until they are done; (2) every other call still to
 * make, earliest first; (3) finished leads (booked / done), in the order they finished.
 */
function isWaiting_(state) { return state === 'active' || state === 'callback' || state === 'needcb' || state === 'noshow'; }
function fuGroup_(state, next, now) {
  if (state === 'needcb' || (state === 'callback' && time_(next) <= now.getTime())) return 0;
  return isWaiting_(state) ? 1 : 2;
}
/** Does row x (state, next) come before row y on Followup/Callback? (a negative number: yes) */
function fuCmp_(xs, xn, ys, yn, now) {
  var gx = fuGroup_(xs, xn, now), gy = fuGroup_(ys, yn, now);
  if (gx !== gy) return gx - gy;
  return gx === 2 ? 0 : time_(xn) - time_(yn);
}
/** Where a lead belongs on Followup/Callback, leaving out row `skip` → the row it should end up on. */
function fuSlot_(sh, r, skip, now) {
  now = now || new Date();
  var last = sh.getLastRow();
  if (last < FIRST) return FIRST;
  var v = sh.getRange(FIRST, W.NEXT, last - FIRST + 1, 3).getValues();   // Next call, id, state
  var ms = r[L.STATE - 1], mn = r[L.NEXT - 1], n = 0;
  if (!isWaiting_(ms)) { for (var j = 0; j < v.length; j++) if (FIRST + j !== skip && v[j][1]) n++; return FIRST + n; }
  for (var i = 0; i < v.length; i++) {
    if (FIRST + i === skip) continue;
    if (!v[i][1]) continue;
    if (fuCmp_(ms, mn, v[i][2], v[i][0], now) < 0) return FIRST + n;
    n++;
  }
  return FIRST + n;
}

/**
 * Every minute: a callback whose time has just come goes to the top of Followup/Callback (above the followups due) and
 * stays there until it is done. Only rows that are out of place move.
 */
function promoteCallbacks_(ss, cfg, now) {
  var sh = ss.getSheetByName(T.FU);
  var read = function () { var last = sh.getLastRow(); return last < FIRST ? [] : sh.getRange(FIRST, W.NEXT, last - FIRST + 1, 3).getValues(); };
  var firstLate = function (v) {                                                   // a due callback with another row above it
    var other = false;
    for (var k = 0; k < v.length; k++) {
      if (!v[k][1]) continue;
      if (fuGroup_(v[k][2], v[k][0], now) === 0) { if (other) return k; } else other = true;
    }
    return -1;
  };
  if (firstLate(read()) < 0) return 0;
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var n = 0;
    for (var guard = 0; guard < 50; guard++) {
      var v = read(), at = firstLate(v);
      if (at < 0) break;
      var key = new Array(NL).fill('');
      key[L.STATE - 1] = v[at][2]; key[L.NEXT - 1] = v[at][0];
      var p = fuSlot_(sh, key, FIRST + at, now);
      if (p >= FIRST + at) break;
      moveRow_(sh, FIRST + at, p);
      n++;
    }
    return n;
  } finally {
    lock.releaseLock();
  }
}

/** Puts a lead on its tab (at the bottom; on Followup/Callback where it belongs). → its row. */
function placeLead_(ss, cfg, r, lr) {
  var tab = r[L.TAB - 1], sh = ss.getSheetByName(tab);
  if (!sh) return 0;
  if (tab === T.OLD) return appendRow_(ss, sh, oldCells_(r, lr, !!clean_(r[L.FROM - 1])));
  var at = appendRow_(ss, sh, workCells_(r, lr, tab));
  if (tab === T.FU || (tab === T.BOOK && isWaiting_(r[L.STATE - 1]))) {
    var p = fuSlot_(sh, r, at, new Date());
    if (p < at) { moveRow_(sh, at, p); at = p; }
  }
  return at;
}

/**
 * Moves a lead to another tab: its row leaves the tab it is on and is written on the new one.
 * opts: row (where it is now), now, undo (going back — nothing to go back to afterwards), quiet (the morning tidy-up).
 */
function moveLead_(ss, cfg, leads, lr, r, toTab, opts) {
  opts = opts || {};
  var now = opts.now || new Date(), fromTab = clean_(r[L.TAB - 1]);
  var src = ss.getSheetByName(fromTab);
  if (src) { var at = findOnTab_(src, r[L.ID - 1], opts.row); if (at) removeRow_(src, at); }
  r[L.TAB - 1] = toTab;
  r[L.FROM - 1] = opts.undo || opts.quiet ? '' : fromTab;
  r[L.MOVED - 1] = now;
  r[L.TIDY - 1] = '';
  computeLead_(r, cfg, now);
  writeLead_(leads, lr, r);
  return placeLead_(ss, cfg, r, lr);
}

/**
 * What the agents typed on a tab is what counts: any cell that differs from the lead's record (an edit that landed
 * while rows were moving, so its save went to the wrong row) is saved now. Run before rows move or tabs are rewritten.
 */
function syncTab_(ss, cfg, tab, now) {
  var sh = ss.getSheetByName(tab), last = sh.getLastRow();
  if (last < FIRST) return 0;
  var isOld = tab === T.OLD, rows = sh.getRange(FIRST, 1, last - FIRST + 1, isOld ? ON : WN).getValues();
  var data = leadsAll_(ss), log = ss.getSheetByName(T.LOG), n = 0;
  rows.forEach(function (row, k) {
    var i = data.byId[clean_(row[(isOld ? O.ID : W.ID) - 1])];
    if (i === undefined) return;
    var r = data.rows[i], lr = i + 2;
    if (clean_(r[L.TAB - 1]) !== tab) return;                                     // a stale row of a lead that has moved on: not saved
    if (isOld) {
      var ch = false, v = canonical_(row[O.COM - 1], cfg), shown = latestAll_(r);
      if (v && (!shown || v !== shown.res)) { r[L.OLDRES - 1] = v; r[L.OLDTIME - 1] = now; r[L.WORKED - 1] = 1; logBox_(log, r, -1, v, now, T.OLD, cfg); ch = true; }
      if (clean_(row[O.NOTES - 1]) !== clean_(r[L.NOTES - 1])) { r[L.NOTES - 1] = clean_(row[O.NOTES - 1]); ch = true; }
      if (clean_(row[O.NAME - 1]) !== clean_(r[L.NAME - 1])) { r[L.NAME - 1] = clean_(row[O.NAME - 1]); ch = true; }
      if (clean_(row[O.CPHONE - 1]) && normPhone_(row[O.CPHONE - 1]).phone !== clean_(r[L.PHONE - 1])) { setPhones_(r, row[O.PHONE - 1], row[O.CPHONE - 1], false, true); ch = true; }
      if (ch) { computeLead_(r, cfg, now); writeLead_(data.sh, lr, r); n++; }
      return;
    }
    var edited = {}, any = false;
    AGENT_FIELDS.forEach(function (f) {
      if ((f[0] === W.CBD || f[0] === W.CBT) && clean_(row[f[0] - 1]) === '' && clean_(r[f[1] - 1]) !== '') return;   // a blank cell never wipes a booked date / time
      if (!sameCell_(row[f[0] - 1], r[f[1] - 1], f[0])) { edited[f[0]] = 1; any = true; }
    });
    if (normPhone_(row[W.PHONE - 1]).raw !== clean_(r[L.RAW - 1] || r[L.PHONE - 1])) { edited[W.PHONE] = 1; any = true; }
    if (clean_(row[W.CPHONE - 1]) && normPhone_(row[W.CPHONE - 1]).phone !== clean_(r[L.PHONE - 1])) { edited[W.CPHONE] = 1; any = true; }
    for (var b = 0; b <= BOXES; b++) {
      var col = b === 0 ? W.COM : W.F1 + b - 1;
      if (canonical_(row[col - 1], cfg) !== boxVal_(r, b)) { edited[col] = 1; any = true; }
    }
    if (!any) return;
    row[W.ROW - 1] = lr;
    var res = saveWorkRow_(ss, cfg, data.sh, log, tab, row, edited, now);
    if (res) { writeSystemCells_(sh, FIRST + k, res, tab); n++; }
  });
  return n;
}
function sameCell_(a, b, col) {
  if (col === W.CBD) return time_(a) === time_(b);
  if (col === W.CBT) return (a instanceof Date ? Utilities.formatDate(a, TZ, 'h:mm a') : clean_(a)) === clean_(b);
  return clean_(a) === clean_(b);
}

/**
 * Every minute: Followup/Callback rows whose call was made a couple of minutes ago go down to where they now belong
 * (or to Old leads / Junk leads if the comment says so). The pause lets the agent finish typing Notes on the row.
 */
function tidyFollowups_(ss, cfg, now) {
  syncTab_(ss, cfg, T.FU, now);
  var data = leadsAll_(ss), sh = ss.getSheetByName(T.FU), n = 0;
  data.rows.forEach(function (r, i) {
    var due = asDate_(r[L.TIDY - 1]);
    if (r[L.TAB - 1] !== T.FU || !due || due > now) return;
    var lr = i + 2;
    r[L.TIDY - 1] = '';
    computeLead_(r, cfg, now);
    var lt = latest_(r);
    if (junkNote_(r[L.NOTES - 1])) { moveLead_(ss, cfg, data.sh, lr, r, T.JUNK, { now: now }); n++; return; }
    if (isBooking_(r, cfg)) { toBooked_(ss, cfg, data.sh, lr, r, { now: now }); n++; return; }
    if (r[L.STATE - 1] === 'leaving' && lt) { moveLead_(ss, cfg, data.sh, lr, r, tabFor_(lt.res, cfg), { now: now }); n++; return; }
    writeLead_(data.sh, lr, r);
    var at = findOnTab_(sh, r[L.ID - 1]);
    if (!at) { placeLead_(ss, cfg, r, lr); n++; return; }
    var p = isWaiting_(r[L.STATE - 1]) ? fuSlot_(sh, r, at, now) : Math.max(sh.getLastRow(), FIRST);
    if (p !== at) { moveRow_(sh, at, p); at = p; n++; }
    sh.getRange(at, W.NEXT, 1, 4).setValues([[asDate_(r[L.NEXT - 1]) || '', r[L.ID - 1], r[L.STATE - 1], lr]]);
  });
  return n;
}

/* ========================================================================= */
/*  Making the tabs fresh from the Leads record                              */
/* ========================================================================= */

/** Which leads go on which tab, in order. */
function tabLists_(data, now) {
  var out = {}, rows = data.rows;
  out[T.LIVE] = []; out[T.FU] = []; out[T.BOOK] = []; out[T.VISC] = []; out[T.JUNK] = []; out[T.OLD] = [];
  var busy = {};
  rows.forEach(function (r, i) {
    var tab = r[L.TAB - 1];
    if (WORK_TABS.indexOf(tab) >= 0) {
      out[tab].push(i);
      if (clean_(r[L.PHONE - 1])) busy[clean_(r[L.PHONE - 1])] = 1;
    }
  });
  // Old leads: one row per number (its newest lead); numbers being worked on or in Junk leads are not shown
  var best = {};
  rows.forEach(function (r, i) {
    if (r[L.TAB - 1] !== T.OLD) return;
    var key = clean_(r[L.PHONE - 1]) || r[L.ID - 1];
    if (busy[key]) return;
    if (best[key] === undefined || time_(rows[best[key]][L.DATE - 1]) < time_(r[L.DATE - 1])) best[key] = i;
  });
  out[T.OLD] = Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return time_(rows[b][L.DATE - 1]) - time_(rows[a][L.DATE - 1]); });
  out[T.LIVE].sort(function (a, b) { return time_(rows[a][L.DATE - 1]) - time_(rows[b][L.DATE - 1]) || a - b; });
  out[T.JUNK].sort(function (a, b) { return (time_(rows[a][L.MOVED - 1]) || time_(rows[a][L.DATE - 1])) - (time_(rows[b][L.MOVED - 1]) || time_(rows[b][L.DATE - 1])) || a - b; });
  now = now || new Date();
  out[T.FU].sort(function (a, b) {
    var x = rows[a], y = rows[b], c = fuCmp_(x[L.STATE - 1], x[L.NEXT - 1], y[L.STATE - 1], y[L.NEXT - 1], now);
    if (c) return c;
    if (!isWaiting_(x[L.STATE - 1])) return (time_(x[L.LAST - 1]) || time_(x[L.MOVED - 1])) - (time_(y[L.LAST - 1]) || time_(y[L.MOVED - 1])) || a - b;
    return a - b;
  });
  out[T.BOOK].sort(bookCmp_(rows));
  out[T.VISC].sort(function (a, b) { return time_(rows[a][L.MOVED - 1]) - time_(rows[b][L.MOVED - 1]) || a - b; });
  return out;
}

/** Booked leads order: retries due first (earliest first), then visits to come (soonest first), then visited, then the rest. */
function bookCmp_(rows) {
  var rank = function (st) { return isWaiting_(st) ? 0 : st === 'booked' ? 1 : st === 'visited' ? 2 : 3; };
  return function (a, b) {
    var x = rows[a], y = rows[b], rx = rank(x[L.STATE - 1]), ry = rank(y[L.STATE - 1]);
    if (rx !== ry) return rx - ry;
    if (rx === 0) return time_(x[L.NEXT - 1]) - time_(y[L.NEXT - 1]) || a - b;
    return time_(x[L.CBD - 1]) - time_(y[L.CBD - 1]) || a - b;
  };
}

/** Rewrites the calling tabs from the Leads record (every morning, and from the owner menu). */
function rebuildTabs_(ss, cfg, now) {
  now = now || new Date();
  var data = leadsAll_(ss), vis = visitsMap_(ss);
  data.rows.forEach(function (r) {
    if (!r[L.ID - 1]) return;
    var v = vis[clean_(r[L.PHONE - 1])];                                       // Vetbuddy visits, whatever came in first
    if (v && (!asDate_(r[L.VISIT - 1]) || v > r[L.VISIT - 1])) r[L.VISIT - 1] = v;
    computeLead_(r, cfg, now);
  });
  if (data.rows.length) data.sh.getRange(2, 1, data.rows.length, NL).setValues(data.rows);
  var lists = tabLists_(data, now);
  CALL_TABS.forEach(function (tab) {
    var sh = ss.getSheetByName(tab), idx = lists[tab];
    if (!sh) return;
    var rows = idx.map(function (i) { return tab === T.OLD ? oldCells_(data.rows[i], i + 2, false) : workCells_(data.rows[i], i + 2, tab); });
    writeTab_(ss, sh, rows);
  });
  return lists;
}

function writeTab_(ss, sh, rows) {
  var tab = tabOf_(sh), n = width_(tab), tc = tickCol_(tab), last = sh.getLastRow();
  if (last >= FIRST) {
    sh.getRange(FIRST, 1, last - FIRST + 1, n).clearContent();
    sh.getRange(FIRST, tc, last - FIRST + 1, 1).clearDataValidations();
  }
  if (!rows.length) return;
  growRows_(ss, sh, FIRST + rows.length);
  if (tab !== T.OLD) {                                                            // the booked time stays text (“5:00 PM”), dates stay dates
    sh.getRange(FIRST, W.CBT, rows.length, 1).setNumberFormat('@');
    sh.getRange(FIRST, W.VISITED, rows.length, 1).setNumberFormat('dd-mmm-yy');
  }
  sh.getRange(FIRST, 1, rows.length, n).setValues(rows);
  var ticks = sh.getRange(FIRST, tc, rows.length, 1);
  ticks.insertCheckboxes();
  ticks.setValues(rows.map(function (r) { return [r[tc - 1] === true]; }));
}

/** Every number's last Vetbuddy visit (the hidden Visits tab). */
function visitsMap_(ss) {
  var sh = ss.getSheetByName(T.VIS), last = sh ? sh.getLastRow() : 0, out = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (x) { var d = asDate_(x[1]); if (d && x[0]) out[clean_(x[0])] = d; });
  return out;
}

/** Old leads: the Last visit column brought up to date in place (after a Vetbuddy upload). */
function refreshOldVisits_(ss) {
  var sh = ss.getSheetByName(T.OLD), last = sh.getLastRow();
  if (last < FIRST) return;
  var data = leadsAll_(ss);
  var ids = sh.getRange(FIRST, O.ID, last - FIRST + 1, 1).getValues();
  var out = ids.map(function (x) {
    var i = data.byId[x[0]], v = i === undefined ? null : asDate_(data.rows[i][L.VISIT - 1]);
    return [v ? dayOnly_(v) : (x[0] ? '-' : '')];
  });
  sh.getRange(FIRST, O.VISIT, out.length, 1).setValues(out);
}

/* ========================================================================= */
/*  Look of the calling tabs                                                 */
/* ========================================================================= */

var LIVE_SUB = 'New leads come in here by themselves. Call → fill the row → tick ✔ Done. Junk comments / No need move straight away; RNR, Callback, Inform later, Booked … move only with WhatsApp = Yes (Booked with its date & time → Booked leads). Red = waiting too long.';
var BOOK_SUB = 'Booked appointments. Visited / Not visited fills itself from the Vetbuddy upload (the visit date, or No show once the booked day has passed). No show → the red Followup box every 45 min, 5 tries. Booked again → pick the new date & time. Visited → Visited customers after 1 day; another comment → Old leads after 2 days.';
var VISC_SUB = 'Booked leads who visited (Vetbuddy bill on/after the booked day). Untick ✔ to send a row back to Booked leads.';
var FU_SUB = 'Callbacks whose time has come stay at the top until done. White = not due yet · light red = due now (fill the strong red box) · 🚨 = overdue more than 3 days. Pick the result → the row moves to its place by itself. Booked → pick the date & time (red until picked) → the row goes to Booked leads. Grey = done. Untick ✔ to send a row back.';
var JUNK_SUB = 'Out of station · No pet · Hindi person · Other. These stay here. Untick ✔ to send a row back.';
var OLD_SUB = 'One row per number, newest first. Call → pick the comment → tick ✔ Done: Callback / Booked → Followup/Callback, junk → Junk leads, anything else stays here.';

function buildWorkTab_(ss, sh, cfg) {
  var tab = tabOf_(sh);
  ensureCols_(sh, WN);
  sh.setTabColor(tab === T.LIVE ? '#cc0000' : tab === T.FU ? '#e69138' : tab === T.BOOK ? '#38761d' : tab === T.VISC ? '#6aa84f' : '#999999');
  widths_(sh, [118, 74, 150, 150, 110, 94, 110, 100, 170, 92, 74, 104, 96, 92, 86, 86, 86, 86, 86, 56, 104, 40, 40, 40, 210]);
  sh.getRange('A1').setValue(TAB_TITLE[tab] || tab).setFontFamily(FONT).setFontSize(15).setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange('A2').setValue(TAB_SUB[tab] || '').setFontFamily(FONT).setFontSize(9).setFontColor(COL.grey);
  topLine_(sh, tab, cfg);
  sh.getRange(HEAD_ROW, 1, 1, WN).setValues([W_HEADERS.map(function (h, i) { return i === W.TICK - 1 ? (tab === T.LIVE ? '✔ Done' : '✔') : h; })])
    .setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff').setBackground(COL.head).setWrap(true).setVerticalAlignment('middle');
  sh.getRange(HEAD_ROW, W.F1, 1, BOXES).setBackground(COL.box);
  sh.getRange(HEAD_ROW, W.TICK).setBackground('#38761d');
  sh.getRange(HEAD_ROW, W.ALERT).setBackground(COL.red);
  sh.setRowHeight(HEAD_ROW, 34);
  sh.setFrozenRows(HEAD_ROW);
  sh.setFrozenColumns(W.CPHONE);
  sh.hideColumns(W.ID, 3);
  if (tab !== T.FU && tab !== T.BOOK) { sh.hideColumns(W.NEXT); sh.hideColumns(W.ALERT); }
  if (tab !== T.BOOK && tab !== T.VISC) sh.hideColumns(W.VISITED);
  sh.getRange(HEAD_ROW, W.VISITED).setBackground('#38761d');
  growRows_(ss, sh, 300, cfg);
  rowFormats_(sh, tab, FIRST, sh.getMaxRows() - FIRST + 1, cfg);
  applyColours_(ss, sh, cfg);
  if (!sh.getFilter()) sh.getRange(HEAD_ROW, 1, sh.getMaxRows() - HEAD_ROW + 1, W.NEXT).createFilter();
  try { sh.getRange(FIRST, W.DATE, sh.getMaxRows() - FIRST + 1, 2).protect().setDescription('Filled by the sheet').setWarningOnly(true); } catch (err) { }
}

var TAB_TITLE = {}; TAB_TITLE[T.LIVE] = '📞 Live leads'; TAB_TITLE[T.FU] = '🔁 Followup / Callback'; TAB_TITLE[T.BOOK] = '📅 Booked leads';
TAB_TITLE[T.VISC] = '✅ Visited customers'; TAB_TITLE[T.JUNK] = '🗑 Junk leads';
var TAB_SUB = {}; TAB_SUB[T.LIVE] = LIVE_SUB; TAB_SUB[T.FU] = FU_SUB; TAB_SUB[T.BOOK] = BOOK_SUB; TAB_SUB[T.VISC] = VISC_SUB; TAB_SUB[T.JUNK] = JUNK_SUB;

/** The count line at the top of a calling tab (formulas — they follow the sheet by themselves). */
function topLine_(sh, tab, cfg) {
  var c = function (n) { return colL_(n) + FIRST + ':' + colL_(n); };
  var top = sh.getRange('H1');
  sh.getRange('G1').clearContent();
  if (tab === T.LIVE) top.setFormula('="🔴 "&COUNTIFS(' + c(W.CPHONE) + ',"<>",' + c(W.COM) + ',"",' + c(W.DATE) + ',"<="&(NOW()-' + cfg.redNew + '/1440))&" waiting more than ' +
    cfg.redNew + ' min   ·   "&COUNTIFS(' + c(W.CPHONE) + ',"<>",' + c(W.COM) + ',"")&" not called yet   ·   "&COUNTIFS(' + c(W.COM) + ',"<>",' + c(W.TICK) + ',FALSE)&" called, not ticked"');
  else if (tab === T.FU) top.setFormula('="🚨 "&COUNTIF(' + c(W.ALERT) + ',"🚨*")&" overdue 3+ days   ·   🔴 "&COUNTIFS(' + c(W.NEXT) + ',"<="&NOW(),' + c(W.NEXT) + ',"<>")&" calls due now   ·   "&COUNTIFS(' + c(W.NEXT) + ',">"&NOW())&" coming up   ·   "&COUNTIF(' +
    c(W.STATE) + ',"booked")&" booked this week"');
  else if (tab === T.BOOK) top.setFormula('="🔴 "&COUNTIFS(' + c(W.NEXT) + ',"<="&NOW(),' + c(W.NEXT) + ',"<>")&" no-show calls due now   ·   "&COUNTIF(' +
    c(W.STATE) + ',"booked")&" visits to come   ·   "&COUNTIF(' + c(W.STATE) + ',"visited")&" visited   ·   "&COUNTIF(' + c(W.VISITED) + ',"' + NOSHOW + '")&" no show"');
  else if (tab === T.VISC) top.setFormula('=COUNTIF(' + c(W.ID) + ',"?*")&" visited customers"');
  else top.setFormula('=COUNTIF(' + c(W.ID) + ',"?*")&" junk leads"');
  top.setFontFamily(FONT).setFontWeight('bold').setFontColor(COL.red);
}

function oldTopLine_(sh) {
  var c = function (n) { return colL_(n) + FIRST + ':' + colL_(n); };
  sh.getRange('F1').clearContent();
  sh.getRange('G1').setFormula('=COUNTIF(' + c(O.ID) + ',"?*")&" numbers   ·   "&COUNT(' + c(O.VISIT) + ')&" have visited before"');
}

function buildOldTab_(ss, sh, cfg) {
  ensureCols_(sh, ON);
  sh.setTabColor('#6d9eeb');
  widths_(sh, [86, 96, 170, 170, 110, 94, 120, 86, 110, 220, 64, 40, 40]);
  sh.getRange('A1').setValue('♻ Old leads').setFontFamily(FONT).setFontSize(15).setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange('A2').setValue(OLD_SUB).setFontFamily(FONT).setFontSize(9).setFontColor(COL.grey);
  oldTopLine_(sh);
  sh.getRange('G1')
    .setFontFamily(FONT).setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange(HEAD_ROW, 1, 1, ON).setValues([O_HEADERS]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
    .setBackground(COL.head).setWrap(true).setVerticalAlignment('middle');
  sh.getRange(HEAD_ROW, O.TICK).setBackground('#38761d');
  sh.setRowHeight(HEAD_ROW, 34);
  sh.setFrozenRows(HEAD_ROW);
  sh.setFrozenColumns(O.CPHONE);
  sh.hideColumns(O.ID, 2);
  growRows_(ss, sh, 300, cfg);
  rowFormats_(sh, T.OLD, FIRST, sh.getMaxRows() - FIRST + 1, cfg);
  applyColours_(ss, sh, cfg);
  if (!sh.getFilter()) sh.getRange(HEAD_ROW, 1, sh.getMaxRows() - HEAD_ROW + 1, O.TICK).createFilter();
  try { sh.getRange(FIRST, O.DATE, sh.getMaxRows() - FIRST + 1, 2).protect().setDescription('Filled by the sheet').setWarningOnly(true); } catch (err) { }
}

/** Number formats and dropdowns for rows r1 … r1+n-1. */
function rowFormats_(sh, tab, r1, n, cfg) {
  if (n < 1) return;
  if (!cfg || !cfg.comments) return;
  var list = function (vals, strict) { return SpreadsheetApp.newDataValidation().requireValueInList(vals, true).setAllowInvalid(!strict).build(); };
  var coms = cfg.comments.map(function (c) { return c.name; });
  if (tab === T.OLD) {
    sh.getRange(r1, O.DATE, n, 2).setNumberFormat('dd-mmm-yy');
    sh.getRange(r1, O.PHONE, n, 2).setNumberFormat('@');
    sh.getRange(r1, O.VISIT, n, 1).setNumberFormat('dd-mmm-yy');
    sh.getRange(r1, O.COM, n, 1).setDataValidation(list(coms, true)).setBackground(COL.input);
    return;
  }
  sh.getRange(r1, W.DATE, n, 1).setNumberFormat('dd-mmm-yy hh:mm');
  sh.getRange(r1, W.CALLDATE, n, 1).setNumberFormat('dd-mmm-yy');
  sh.getRange(r1, W.PHONE, n, 2).setNumberFormat('@');
  sh.getRange(r1, W.COM, n, 1).setDataValidation(list(coms, true));
  sh.getRange(r1, W.F1, n, BOXES).setDataValidation(list(coms, true));
  sh.getRange(r1, W.DEPT, n, 1).setDataValidation(list(cfg.depts.length ? cfg.depts : splitList_(DEFAULT_DEPTS), false));
  sh.getRange(r1, W.WA, n, 1).setDataValidation(list(['Yes', 'No'], true));
  sh.getRange(r1, W.CBD, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()).setNumberFormat('dd-mmm-yy');
  var times = [];
  for (var m = cfg.open; m <= cfg.close; m += 30) times.push(timeText_(m));
  sh.getRange(r1, W.CBT, n, 1).setNumberFormat('@').setDataValidation(list(times, false));
  sh.getRange(r1, W.NEXT, n, 1).setNumberFormat('dd-mmm hh:mm');
  sh.getRange(r1, W.VISITED, n, 1).setNumberFormat('dd-mmm-yy');
  sh.getRange(r1, W.COM, n, 1).setBackground(COL.input);
  sh.getRange(r1, W.F1, n, BOXES).setBackground(COL.input);
}

/** The colours (they follow the time by themselves: the sheet recalculates every minute). */
function applyColours_(ss, sh, cfg) {
  var tab = tabOf_(sh), n = sh.getMaxRows() - FIRST + 1, rules = [], R = FIRST;
  if (n < 1) return;
  var rule = function (f, ranges, bg, font, bold) {
    var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setRanges(ranges);
    if (bg) b.setBackground(bg);
    if (font) b.setFontColor(font);
    if (bold) b.setBold(true);
    rules.push(b.build());
  };
  var rng = function (c1, nc) { return sh.getRange(R, c1, n, nc || 1); };
  var $ = function (n) { return '$' + colL_(n) + R; }, at = function (n) { return colL_(n) + R; };
  var badNo = function (c) { return '=AND(' + $(c) + '<>"",NOT(REGEXMATCH(TO_TEXT(' + $(c) + '),"^[6-9][0-9]{9}$")))'; };
  if (tab === T.OLD) rule(badNo(O.CPHONE), [rng(O.CPHONE)], COL.orange, COL.red, true);         // not a 10-digit mobile → check it
  else rule(badNo(W.CPHONE), [rng(W.CPHONE)], COL.orange, COL.red, true);
  if (tab === T.LIVE) {
    rule('=AND(' + $(W.CPHONE) + '<>"",' + $(W.COM) + '="",' + $(W.DATE) + '<>"",' + $(W.DATE) + '<=NOW()-' + cfg.redNew + '/1440)', [rng(1, W.TICK - 1)], COL.redFill, COL.red);
    rule('=AND(' + $(W.COM) + '<>"",' + $(W.TICK) + '=FALSE)', [rng(W.TICK)], COL.orange);
  } else if (tab === T.FU) {
    // white = not due yet · light red = due and not done · 🚨 = due more than 3 days ago; the box to fill in strong red
    var due = 'OR(' + $(W.STATE) + '="active",' + $(W.STATE) + '="callback",' + $(W.STATE) + '="needcb"),' + $(W.NEXT) + '<>"",' + $(W.NEXT) + '<=NOW()';
    var boxes = [W.COM]; for (var b = 0; b < BOXES; b++) boxes.push(W.F1 + b);
    for (var k = 1; k <= BOXES; k++) rule('=AND(' + due + ',' + at(boxes[k]) + '="",' + at(boxes[k - 1]) + '<>"")', [rng(boxes[k])], COL.redBox, '#ffffff', true);
    rule('=' + $(W.STATE) + '="needcb"', [rng(W.CBD, 2)], COL.redBox, '#ffffff', true);
    rule('=AND(' + due + ',' + $(boxes[BOXES]) + '<>"")', [rng(W.CBD, 2)], COL.redBox, '#ffffff', true);
    rule('=AND(' + due + ',NOW()-' + $(W.NEXT) + '>3)', [rng(W.ALERT)], '#990000', '#ffffff', true);
    rule('=AND(' + due + ')', [rng(W.NEXT)], COL.redFill, COL.red, true);
    rule('=AND(' + due + ')', [rng(1, W.TICK)], COL.redFill);
    rule('=' + $(W.STATE) + '="booked"', [rng(1, W.NEXT)], COL.green);
    rule('=OR(' + $(W.STATE) + '="done",' + $(W.STATE) + '="leaving")', [rng(1, W.NEXT)], COL.done, COL.grey);
  } else if (tab === T.BOOK) {
    var dueB = 'OR(' + $(W.STATE) + '="noshow",' + $(W.STATE) + '="needcb"),' + $(W.NEXT) + '<>"",' + $(W.NEXT) + '<=NOW()';
    var bx = [W.COM]; for (var q = 0; q < BOXES; q++) bx.push(W.F1 + q);
    for (var j = 1; j <= BOXES; j++) rule('=AND(' + $(W.STATE) + '="noshow",' + dueB + ',' + at(bx[j]) + '="",' + at(bx[j - 1]) + '<>"")', [rng(bx[j])], COL.redBox, '#ffffff', true);
    rule('=' + $(W.STATE) + '="needcb"', [rng(W.CBD, 2)], COL.redBox, '#ffffff', true);
    rule('=AND(' + dueB + ',NOW()-' + $(W.NEXT) + '>3)', [rng(W.ALERT)], '#990000', '#ffffff', true);
    rule('=' + $(W.VISITED) + '="' + NOSHOW + '"', [rng(W.VISITED)], COL.redFill, COL.red, true);
    rule('=ISNUMBER(' + $(W.VISITED) + ')', [rng(W.VISITED)], '#b6d7a8', '#274e13', true);
    rule('=AND(' + dueB + ')', [rng(1, W.TICK)], COL.redFill);
    rule('=' + $(W.STATE) + '="visited"', [rng(1, W.NEXT)], COL.green);
    rule('=OR(' + $(W.STATE) + '="closing",' + $(W.STATE) + '="leaving")', [rng(1, W.NEXT)], COL.done, COL.grey);
  } else if (tab === T.VISC) {
    rule('=ISNUMBER(' + $(W.VISITED) + ')', [rng(W.VISITED)], '#b6d7a8', '#274e13', true);
  } else if (tab === T.JUNK) {
    rule('=' + $(W.ID) + '<>""', [rng(1, W.NEXT)], null, COL.grey);
  } else if (tab === T.OLD) {
    rule('=ISNUMBER(' + $(O.VISIT) + ')', [rng(O.VISIT)], COL.green);
    rule('=' + $(O.TICK) + '=TRUE', [rng(1, O.TICK)], '#e8f0fe');
  }
  sh.setConditionalFormatRules(rules);
}

/* ========================================================================= */
/*  Setting the file up (on open — nobody runs anything)                     */
/* ========================================================================= */

/**
 * Builds or updates the tabs. inTrigger: called from the owner's every-minute run or the menu (6 minutes allowed). On open /
 * on an edit (30 seconds allowed) a big file is not updated: the every-minute run does it within a few minutes (a short
 * note says so), so nothing is cut off half-way.
 */
function ensureSetup_(ss, inTrigger) {
  var set = ss.getSheetByName(T.SET);
  var fam = set ? clean_(set.getRange(SC.VERSION).getValue()) : '', rev = set ? clean_(set.getRange(SC.REV).getValue()) : '';
  if (set && fam === FAMILY && rev === REV && ORDER.every(function (n) { return ss.getSheetByName(n); })) return false;
  if (set && fam === FAMILY && rev !== REV && !inTrigger) {
    var props = PropertiesService.getDocumentProperties(), leads = ss.getSheetByName(T.LEADS);
    var auto = Date.now() - +(props.getProperty('BEAT') || 0) < 30 * 60000, big = leads && leads.getLastRow() > 800;
    if (auto || big) {
      try {
        ss.toast(auto ? 'This sheet is being updated to the new version — ready in a few minutes. Ticks made now may need doing again.'
          : 'Owner: ⚙ SM Calling (owner) → ① Turn on automatic updates — that finishes updating this sheet to the new version.', 'SM Calling', 15);
      } catch (err) { }
      return true;
    }
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(inTrigger ? 60000 : 10000)) return true;
  try {
    set = ss.getSheetByName(T.SET);                                                // done meanwhile by another run?
    if (set && clean_(set.getRange(SC.VERSION).getValue()) === FAMILY && clean_(set.getRange(SC.REV).getValue()) === REV &&
      ORDER.every(function (n) { return ss.getSheetByName(n); })) return false;
    return setUp_(ss, set);
  } finally {
    lock.releaseLock();
  }
}

function setUp_(ss, set) {
  // the earlier one-file SM Calling sheet: its tabs are kept but put away (renamed “(old)” when a name is needed, hidden)
  var converting = set && clean_(set.getRange(SC.VERSION).getValue()) !== FAMILY && /^sm-calling/.test(clean_(set.getRange(SC.VERSION).getValue()));
  if (converting) {
    ss.getSheets().forEach(function (sh) { if (ORDER.indexOf(sh.getName()) >= 0) sh.setName(sh.getName() + ' (old)'); });
    set = null;
  }
  // an earlier revision of this script: bring its tabs up to this one
  if (set && clean_(set.getRange(SC.VERSION).getValue()) === FAMILY && clean_(set.getRange(SC.REV).getValue()) !== REV) upgrade_(ss, clean_(set.getRange(SC.REV).getValue()));
  var tz = ss.getSpreadsheetTimeZone();
  if (tz !== TZ && tz !== 'Asia/Calcutta') ss.setSpreadsheetTimeZone(TZ);
  try { ss.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.ON_CHANGE_AND_MINUTE); } catch (err) { }
  if (!set) { set = ss.insertSheet(T.SET); buildSettings_(ss, set); }
  var cfg = readCfg_(ss);
  [T.LEADS, T.LOG, T.VIS, T.SF, T.UP].forEach(function (n) {
    if (ss.getSheetByName(n)) return;
    var sh = ss.insertSheet(n);
    if (n === T.LEADS) headerTab_(sh, L_HEADERS, [2, 21, 22, 23, 24, 25, 26, 27, 28, 32, 33, 35, 37], 6);
    if (n === T.LOG) headerTab_(sh, LOG_HEADERS, [1], 3);
    if (n === T.VIS) headerTab_(sh, ['Phone number', 'Last visit', 'Clinic', 'Client'], [2], 1);
    if (n === T.SF) headerTab_(sh, ['Phone number', 'Call time', 'Smartflo status', 'Connected', 'Talk time (s)', 'Agent', 'key'], [2], 1);
    if (n === T.UP) headerTab_(sh, ['Read at', 'File', 'Folder', 'What it was', 'Result', 'File id'], [1], 0);
    sh.hideSheet();
  });
  // each tab is built under a temporary name and named at the end, so a build cut short (30-second limit) is redone
  var make = function (n, fn) {
    if (ss.getSheetByName(n)) return;
    var half = ss.getSheetByName(n + ' …');
    if (half) ss.deleteSheet(half);
    var sh = ss.insertSheet(n + ' …');
    fn(sh);
    sh.setName(n);
  };
  WORK_TABS.forEach(function (n) { make(n, function (sh) { buildWorkTab_(ss, sh, cfg); }); });
  make(T.OLD, function (sh) { buildOldTab_(ss, sh, cfg); });
  make(T.SUM, function (sh) { buildSummary_(sh); });
  make(T.QUAL, function (sh) { buildQuality_(sh, cfg); });
  make(T.HELP, function (sh) { buildHelp_(sh); });
  // the empty “Sheet1” of a new file goes
  ss.getSheets().forEach(function (sh) {
    if (ORDER.indexOf(sh.getName()) < 0 && sh.getLastRow() === 0 && ss.getSheets().length > 1 && /^(sheet|tab)\s*\d*$/i.test(sh.getName())) ss.deleteSheet(sh);
  });
  ORDER.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
  if (converting) ss.getSheets().forEach(function (sh) { if (ORDER.indexOf(sh.getName()) < 0) sh.hideSheet(); });
  ss.setActiveSheet(ss.getSheetByName(T.LIVE));
  set.getRange(SC.VERSION).setValue(FAMILY).setFontColor('#ffffff');
  set.getRange(SC.REV).setValue(REV).setFontColor('#ffffff');
  return true;
}

/**
 * Rev 7: “Booked by another agent” comment (every tab) → Booked leads at once, no date needed; one time, Followup / Live
 * bookings picked before 19-Nov with no date → Booked leads (they wait for the visit, no no-show calls).
 * Rev 6: Booked leads and Visited customers tabs (Visited / Not visited column from Vetbuddy, no-show retries every followup gap,
 * 5 × RNR → Old leads, another comment → Old leads after 2 days, visited → Visited customers after 1 day); Followup bookings with
 * their date & time move there; Live leads ✔ needs WhatsApp = Yes except for junk / No need; ticks and picks made while the sheet
 * was busy are finished by the every-minute run; Summary: Visited, Visited %.
 * Rev 5: Followup/Callback — callbacks whose time came at the top, white / light red / 🚨 overdue 3+ days (new ⚠ Overdue
 * column), rows move right after a pick (Settings C12 = 0), unfinished followups never go to Old leads.
 * Rev 4: the CRM is read again (tabs whose header cell was typed over, rows pasted in with shifted columns): old leads whose
 * “number” was a name are replaced, typed campaign names corrected — once, by the every-minute run (REPAIR).
 * Rev 3: Notes keep only what the agents wrote; leads with no campaign get theirs from the CRM (next minute run).
 * Rev 2: a “Correct number” column (the last 10 digits) next to Phone number on every calling tab; the Leads record keeps
 * the number as it was given. Safe to run twice (the column is added only once). The tabs are then written fresh by the
 * next every-minute run, which also moves leads whose Notes say “wrongly filled” / “out of station” to Junk leads.
 */
function upgrade_(ss, from) {
  var cfg = readCfg_(ss), now = new Date();
  [T.LIVE, T.FU, T.JUNK, T.OLD].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (!sh) return;
    var isOld = n === T.OLD, pc = isOld ? O.PHONE : W.PHONE;
    if (!isOld && clean_(sh.getRange(HEAD_ROW, W.VISITED).getValue()) === 'Callback / Booked date') {   // rev 6: Visited / Not visited column
      sh.insertColumnBefore(W.VISITED);
      sh.getRange(FIRST, W.VISITED, sh.getMaxRows() - FIRST + 1, 1).clearDataValidations().setBackground(null).setNumberFormat('dd-mmm-yy');
      sh.getRange(HEAD_ROW, W.VISITED).setValue(W_HEADERS[W.VISITED - 1]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
        .setBackground('#38761d').setWrap(true).setVerticalAlignment('middle');
      sh.setColumnWidth(W.VISITED, 104);
      sh.hideColumns(W.VISITED);
    }
    if (clean_(sh.getRange(HEAD_ROW, pc + 1).getValue()) !== 'Correct number') {
      sh.insertColumnAfter(pc);
      sh.getRange(HEAD_ROW, pc + 1).setValue('Correct number');
      var last = sh.getLastRow();
      if (last >= FIRST) {
        var v = sh.getRange(FIRST, pc, last - FIRST + 1, 1).getValues().map(function (x) { return [clean_(x[0]) ? normPhone_(x[0]).phone : '']; });
        sh.getRange(FIRST, pc + 1, v.length, 1).setNumberFormat('@').setValues(v);
      }
    }
    var nc = isOld ? O.NOTES : W.NOTES, lastN = sh.getLastRow();                 // rev 3: the same clean Notes on the tab
    if (lastN >= FIRST) {
      var nv = sh.getRange(FIRST, nc, lastN - FIRST + 1, 1).getValues(), changed = false;
      nv = nv.map(function (x) { var y = agentNotes_(x[0]); if (y !== clean_(x[0])) changed = true; return [y]; });
      if (changed) sh.getRange(FIRST, nc, nv.length, 1).setValues(nv);
    }
    sh.setFrozenColumns(isOld ? O.CPHONE : W.CPHONE);
    sh.setColumnWidth(pc, 110);
    sh.setColumnWidth(pc + 1, 94);
    if (!isOld) ensureCols_(sh, WN);
    if (!isOld && clean_(sh.getRange(HEAD_ROW, W.ALERT).getValue()) !== W_HEADERS[W.ALERT - 1]) {   // rev 5: ⚠ Overdue after Next call
      sh.getRange(HEAD_ROW, W.ALERT).setValue(W_HEADERS[W.ALERT - 1]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
        .setBackground(COL.red).setWrap(true).setVerticalAlignment('middle');
      sh.setColumnWidth(W.ALERT, 210);
      if (n === T.FU) sh.showColumns(W.ALERT); else sh.hideColumns(W.ALERT);
    }
    if (n === T.FU) sh.getRange('A2').setValue(FU_SUB);
    if (n === T.LIVE) sh.getRange('A2').setValue(LIVE_SUB);
    applyColours_(ss, sh, cfg);
    if (isOld) oldTopLine_(sh); else topLine_(sh, n, cfg);
    if (n === T.LIVE) sh.getRange('I1:Z1').clearContent();                      // status cells: written again by the next run
  });
  if (!(+from >= 5)) {                                                            // rev 5: a followup row moves right away
    var set = ss.getSheetByName(T.SET);
    set.getRange('B12').setValue('A followup row moves to its place after (minutes, 0 = right away)');
    set.getRange(SC.TIDYMIN).setValue(0);
  }
  if (!(+from >= 7)) {                                                            // rev 7: Booked by another agent
    var st = ss.getSheetByName(T.SET);
    var coms = st.getRange(SC.COM_ROW, 2, SC.COM_ROWS, 1).getValues().map(function (x) { return clean_(x[0]); });
    st.getRange(SC.COM_ROW, 3, SC.COM_ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([GOES.FU, GOES.BOOK, GOES.JUNK, GOES.OLD], true).build());
    if (coms.indexOf(BY_OTHER) < 0) {
      var free = coms.indexOf('');
      if (free >= 0) st.getRange(SC.COM_ROW + free, 2, 1, 4).setValues([[BY_OTHER, GOES.BOOK, REMIND.none, 'Yes']]);
    }
    cfg = readCfg_(ss);
    props7_().setProperty('LOOKS', '1');
  }
  var leads = ss.getSheetByName(T.LEADS);
  if (leads) {
    ensureCols_(leads, NL);
    leads.getRange(1, 1, 1, NL).setValues([L_HEADERS]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff').setBackground(COL.head);
    var lastL = leads.getLastRow();
    if (lastL >= 2) {
      var rows = leads.getRange(2, 1, lastL - 1, NL).getValues();
      rows.forEach(function (r) {
        if (!r[L.ID - 1]) return;
        if (!clean_(r[L.RAW - 1])) r[L.RAW - 1] = clean_(r[L.PHONE - 1]);
        var p = normPhone_(r[L.RAW - 1]);
        r[L.PHONE - 1] = p.phone;
        r[L.NOTES - 1] = agentNotes_(r[L.NOTES - 1]);                                  // rev 3: Notes keep only what the agents wrote
        var lt7 = latest_(r);
        if (!(+from >= 7) && (r[L.TAB - 1] === T.FU || r[L.TAB - 1] === T.LIVE) && lt7 && isBookedRes_(lt7.res, cfg) &&
          !asDate_(r[L.CBD - 1]) && lt7.t && lt7.t < NODATE_BEFORE) {                      // rev 7, one time: older bookings with no date
          bookRound_(r, now);
          r[L.TAB - 1] = T.BOOK; r[L.FROM - 1] = ''; r[L.MOVED - 1] = now; r[L.TIDY - 1] = '';
          computeLead_(r, cfg, now);
        }
        if (!(+from >= 6) && r[L.TAB - 1] === T.FU && isBooking_(r, cfg)) {               // rev 6: bookings → Booked leads
          bookRound_(r, now);
          r[L.TAB - 1] = T.BOOK; r[L.FROM - 1] = ''; r[L.MOVED - 1] = now; r[L.TIDY - 1] = '';
          computeLead_(r, cfg, now);
        }
      });
      leads.getRange(2, L.PHONE, rows.length, 1).setNumberFormat('@');
      leads.getRange(2, L.RAW, rows.length, 1).setNumberFormat('@');
      leads.getRange(2, 1, rows.length, NL).setValues(rows);
    }
  }
  [T.VIS, T.SF].forEach(function (n) {                                          // the same 10-digit numbers everywhere
    var sh = ss.getSheetByName(n), last = sh ? sh.getLastRow() : 0;
    if (last < 2) return;
    var v = sh.getRange(2, 1, last - 1, 1).getValues().map(function (x) { return [clean_(x[0]) ? normPhone_(x[0]).phone : '']; });
    sh.getRange(2, 1, v.length, 1).setValues(v);
  });
  var help = ss.getSheetByName(T.HELP);
  if (help) ss.deleteSheet(help);                                               // rebuilt below with the new lines
  var props = PropertiesService.getDocumentProperties();
  props.setProperty('REBUILD', '1');
  props.setProperty('BOOK_AT', '0');
  if (!(+from >= 4)) props.setProperty('REPAIR', '1');
}

function props7_() { return PropertiesService.getDocumentProperties(); }

/** Notes without what the sheet itself added (Excel campaign, CRM remarks, ⚠ check number …). */
function agentNotes_(notes) {
  return clean_(notes).split(' | ').map(function (x) { return x.replace(/^other number\s+/i, ''); }).filter(function (x) {
    return x && !/^(Excel campaign:|CRM:|⚠ check number|visited \(CRM\)|spoken to \(CRM)/.test(x);
  }).join(' | ');
}

function headerTab_(sh, heads, dateCols, phoneCol) {
  ensureCols_(sh, heads.length);
  sh.getRange(1, 1, 1, heads.length).setValues([heads]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff').setBackground(COL.head);
  sh.setFrozenRows(1);
  dateCols.forEach(function (c) { sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('dd-mmm-yy hh:mm'); });
  if (phoneCol) sh.getRange(2, phoneCol, sh.getMaxRows() - 1, 1).setNumberFormat('@');
}

/** The city this file is for, from its name (“SM Calling – Madurai”). */
function cityFromName_(ss) {
  var n = String(ss.getName() || '').toLowerCase();
  if (/valasaravakkam|vala|vlk/.test(n)) return 'Valasaravakkam';
  if (/madurai|mdu/.test(n)) return 'Madurai';
  return '';
}

function buildSettings_(ss, sh) {
  sh.setTabColor('#a6a6a6');
  ensureCols_(sh, 8);
  widths_(sh, [24, 300, 380, 30, 200, 200, 30, 120]);
  sh.getRange('A1').setValue('Settings').setFontFamily(FONT).setFontSize(16).setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange('B2').setValue('Owner only. Blue cells can be changed.').setFontFamily(FONT).setFontColor(COL.grey).setFontStyle('italic');
  var rows = [
    ['City of this file', cityFromName_(ss)],
    ['Meta Leads CRM (link)', DEFAULT_CRM],
    ['Bring new leads from (date) — set by ① on the menu', ''],
    ['CRM tabs / campaigns to skip (words)', 'vow'],
    ['Working hours — start', '9:00 AM'],
    ['Working hours — end', '5:30 PM'],
    ['Followup gap (minutes)', 45],
    ['Days a lead stays in Followup/Callback', 7],
    ['New lead turns red after (minutes)', 5],
    ['A followup row moves to its place after (minutes, 0 = right away)', 0],
    ['Call log folder (the Calling MIS “Call Logs” folder)', DEFAULT_CALL_FOLDER],
    ['Upload folder (Vetbuddy / old comments Excel) — made by ① on the menu', ''],
    ['Departments', DEFAULT_DEPTS]
  ];
  sh.getRange(3, 2, rows.length, 2).setValues(rows).setFontFamily(FONT);
  sh.getRange(3, 3, rows.length, 1).setBackground(COL.input).setFontColor('#0000ff').setHorizontalAlignment('left');
  sh.getRange(SC.FROM).setNumberFormat('dd-mmm-yyyy');
  sh.getRange(SC.OPEN + ':' + SC.CLOSE).setNumberFormat('@');
  var status = [['Last lead check', ''], ['Last upload read', ''], ['Old comments Excel', ''], ['Old CRM leads', ''], ['Morning tidy-up', '']];
  sh.getRange(17, 2, status.length, 2).setValues(status).setFontFamily(FONT);
  sh.getRange(17, 3, status.length, 1).setFontColor(COL.grey).setWrap(true);
  sh.getRange(16, 2).setValue('What the sheet did last').setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange(SC.CITY_ROW - 1, 2, 1, 2).setValues([['City', 'Words that mean this city in campaign / ad set names']]).setFontWeight('bold').setFontColor('#ffffff').setBackground(COL.head);
  sh.getRange(SC.CITY_ROW, 2, DEFAULT_CITIES.length, 2).setValues(DEFAULT_CITIES);
  sh.getRange(SC.CITY_ROW, 2, SC.CITY_ROWS, 2).setBackground(COL.input).setFontColor('#0000ff');
  sh.getRange(SC.COM_ROW - 1, 2, 1, 4).setValues([['Comment', 'Goes to', 'Reminder', 'Connected?']]).setFontWeight('bold').setFontColor('#ffffff').setBackground(COL.head);
  sh.getRange(SC.COM_ROW - 2, 2).setValue('Comments — the dropdown on every tab, and where each one sends the lead').setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange(SC.COM_ROW, 2, DEFAULT_COMMENTS.length, 4).setValues(DEFAULT_COMMENTS);
  var rem = Object.keys(REMIND).map(function (k) { return REMIND[k]; });
  sh.getRange(SC.COM_ROW, 2, SC.COM_ROWS, 4).setBackground(COL.input).setFontColor('#0000ff');
  sh.getRange(SC.COM_ROW, 3, SC.COM_ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([GOES.FU, GOES.BOOK, GOES.JUNK, GOES.OLD], true).build());
  sh.getRange(SC.COM_ROW, 4, SC.COM_ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(rem, true).build());
  sh.getRange(SC.COM_ROW, 5, SC.COM_ROWS, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).build());
  sh.getRange(SC.CITY).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(DEFAULT_CITIES.map(function (c) { return c[0]; }), true).build());
  if (!clean_(sh.getRange(SC.CITY).getValue())) {
    sh.getRange('E3').setValue('⚠ Pick the city of this file in C3 — nothing is imported until then.').setFontColor(COL.red).setFontWeight('bold');
  }
}

function buildHelp_(sh) {
  sh.setTabColor('#93c47d');
  widths_(sh, [36, 860]);
  sh.getRange('A1').setValue('How to use this sheet').setFontFamily(FONT).setFontSize(16).setFontWeight('bold').setFontColor(COL.navy);
  var lines = [
    ['', 'FOR THE TEAM'],
    ['1', 'Live leads: new leads from the Meta Leads CRM appear at the bottom by themselves (within a minute). A row turns red if nobody calls it within 5 minutes.'],
    ['2', 'Call → fill the row (Comments, Notes, Department, WhatsApp, Callback / Booked date & time) → tick ✔ Done. The row moves by itself within seconds:'],
    ['', '      Out of station · No pet · Hindi person · Other → Junk leads, No need → Old leads — straight away, WhatsApp not needed.'],
    ['', '      Callback · RNR · Hang up · Voicemail · Inform later → Followup/Callback, Booked (with date & time) → Booked leads — only when WhatsApp = Yes. WhatsApp = No → the lead stays on Live leads.'],
    ['', '      Booked leads: Visited / Not visited fills itself from the Vetbuddy upload — the visit date, or No show once the booked day has passed. No show → the red Followup box every 45 minutes, up to 5 tries (5 × RNR → Old leads). Booked again → pick the new date & time. Any other comment → Old leads after 2 days. Visited → Visited customers after 1 day.'],
    ['', '      Followup/Callback: Booked + its date & time → Booked leads.'],
    ['', '      Booked by another agent (any tab) → Booked leads straight away, no date & time or WhatsApp needed; it waits there for the visit.'],
    ['3', 'Followup/Callback: a callback whose date & time has come goes to the TOP and stays there until it is done. White row = not due yet; light red row = due now — fill the strong red box (RNR / Hang up / Voicemail every 45 minutes in working hours, callbacks at their date & time, Inform later next morning, Booked on the morning of the booked day); 🚨 in “⚠ Overdue” = due more than 3 days ago, call now. Pick the result → the row moves to its place by itself within seconds (after Callback / Booked, once the date & time are typed).'],
    ['4', 'If Callback has no date & time yet, those two cells are red: pick them.'],
    ['5', 'A followup or callback still to make stays on Followup/Callback however many days pass. Only a finished lead (all 5 followups made, booked, or done) goes to Old leads, a week after it came in.'],
    ['6', 'Old leads: one row per number, newest first, with the last visit from Vetbuddy (“-” = never visited). Call → pick the comment → tick ✔ Done. Callback / Booked → Followup/Callback (pick the date & time there), junk → Junk leads, anything else stays.'],
    ['7', 'Moved a row by mistake? Untick ✔ on that row in the tab it went to (the same day) — it goes back.'],
    ['', 'Phone number = the number as it came in; Correct number = its last 10 digits (dial this one). A lead whose Notes say “wrongly filled” or “out of station” goes to Junk leads for good.'],
    ['8', 'Filters: every column has a ▼ on the header row (e.g. Call date → tick today). Filters are shared — two people on one tab can use Data → Create filter view for their own.'],
    ['', ''],
    ['', 'FOR THE OWNER (one time, in each city file)'],
    ['1', 'Settings → C3: the city of this file (filled from the file name if it has Madurai / Valasaravakkam in it).'],
    ['2', '⚙ SM Calling (owner) → ① Turn on automatic updates (in EACH city file). Allow access when Google asks. New leads then come every minute from 8 am to 6:30 pm (every 5 minutes at night), and the sheet makes the “SM Calling uploads” Drive folder (link on Settings → C14). After pasting a newer script, the automatic run updates the file within a few minutes.'],
    ['3', 'MIS Upload Hub → Connected MIS → “SM Calling sheets”: paste the C14 folder link. Then the Vetbuddy export and the old comments Excel uploaded in the hub reach both city files; the Smartflo call log is read from the Calling MIS folder.'],
    ['4', 'Upload the old comments Excel in the hub (or File → Import → Insert new sheet here and use ② on the menu). The last week’s leads go to Followup/Callback, junk to Junk leads, the rest to Old leads.'],
    ['5', '⚙ → ③ Bring in old leads from the CRM (one time) — the older leads of this city from every CRM tab, hidden ones too, go to Old leads. An old Meta lead-form download (created_time, adset_name, phone_number …) uploaded in the hub does the same: this city’s leads go to Old leads.'],
    ['6', 'Share the file with the agents (Editor). They never need the CRM, the hub or any script.']
  ];
  sh.getRange(3, 1, lines.length, 2).setValues(lines).setFontFamily(FONT).setWrap(true).setVerticalAlignment('top');
  lines.forEach(function (l, i) { if (!l[0] && /^(FOR THE TEAM|FOR THE OWNER)/.test(l[1])) sh.getRange(i + 3, 2).setFontWeight('bold').setFontColor(COL.navy); });
}

/* ========================================================================= */
/*  New leads from the Meta Leads CRM (every minute)                         */
/* ========================================================================= */

/**
 * Brings this city's leads created on/after Settings → C5 from the Meta Leads CRM to the bottom of Live leads.
 * Light enough for every minute: when the CRM file has not changed nothing is read; otherwise only the rows added to
 * each tab since the last run (both ends of the tab). Once an hour every tab is read in full, so nothing is missed.
 * A lead already here (same lead id, same number + campaign, or the same number a day either side) is never added twice.
 */
function importNewLeads_(ss, cfg, force, now) {
  var props = PropertiesService.getDocumentProperties(), set = ss.getSheetByName(T.SET);
  if (!cfg.crmId) { set.getRange(SC.LASTCHECK).setValue('⚠ Put the Meta Leads CRM link in C4'); return ''; }
  var blockKey = Utilities.formatDate(now, TZ, 'yyyyMMdd') + '-' + Math.floor(+Utilities.formatDate(now, TZ, 'HH') / 3);
  var stamp = '';
  try { stamp = String(DriveApp.getFileById(cfg.crmId).getLastUpdated().getTime()); } catch (err) { }
  var full = force || props.getProperty('FULL_BLOCK') !== blockKey;          // every tab read in full every 3 hours
  if (!full && stamp && stamp === props.getProperty('CRM_STAMP')) { checked_(ss, now, 'no change in the CRM'); return ''; }
  var memo = {};
  try { memo = JSON.parse(props.getProperty('CRM_TABS2') || '{}'); } catch (err) { memo = {}; }
  if (memo.crm !== cfg.crmId) memo = { crm: cfg.crmId, t: {} };
  var from = cfg.from || dayOnly_(now), found = [], names = {}, quarter = now.getMinutes() % 15 === 0;
  openCrm_(cfg.crmId).getSheets().forEach(function (tab) {
    var tabName = tab.getName();
    names[tabName] = 1;
    if (skipTab_(tabName, cfg)) return;
    // memo per tab: [last row with anything, last row with a phone number, header row, phone column, hidden] — small, so it fits
    var m = memo.t[tabName];
    if (!full && m && m[4] && !quarter) return;                                   // hidden tabs (old campaigns): every 15 minutes
    var lr = tab.getLastRow();
    var fullRead = function () {
      var vals = lr ? tab.getDataRange().getValues() : [], cols = crmCols_(vals), ld = 0, hid = tab.isSheetHidden() ? 1 : 0;
      if (cols) for (var i = vals.length - 1; i > cols.hr; i--) if (clean_(vals[i][cols.phone])) { ld = i + 1; break; }
      memo.t[tabName] = cols ? [lr, ld, cols.hr, cols.phone + 1, hid] : [lr, 0, -1, 0, hid];
      if (cols) crmRows_(vals.slice(cols.hr + 1), cols, tabName, cfg, from, found, null);
    };
    if (full || !m) return fullRead();
    if (m[2] < 0) { if (lr !== m[0]) fullRead(); return; }                       // not a lead tab (looked at again if it grows)
    // the last lead row — a tab with checkboxes / formulas filled down has more rows than leads, so look at the phone column
    var ld = lr;
    if (m[1] < m[0] || lr !== m[0]) {
      if (lr >= tab.getMaxRows()) return fullRead();
      ld = tab.getRange(lr + 1, m[3]).getNextDataCell(SpreadsheetApp.Direction.UP).getRow();
      if (ld <= m[2] + 1 && m[1] > m[2] + 1) return fullRead();
    }
    if (ld === m[1]) { m[0] = lr; return; }
    if (ld < m[1]) return fullRead();                                              // rows were deleted
    var width = Math.max(tab.getLastColumn(), 1), head = tab.getRange(1, 1, m[2] + 1, width).getValues(), cols = crmCols_(head);
    if (!cols) cols = crmCols_(tab.getRange(1, 1, Math.min(m[2] + 41, lr), width).getValues());   // typed-over header: found by the numbers
    if (!cols) return fullRead();
    var n = ld - m[1], firstData = cols.hr + 2;
    var topCount = Math.min(n + 2, ld - firstData + 1);
    if (topCount > 0) crmRows_(tab.getRange(firstData, 1, topCount, width).getValues(), cols, tabName, cfg, from, found, null);
    var botFirst = Math.max(m[1] + 1, firstData + topCount);
    if (ld >= botFirst) crmRows_(tab.getRange(botFirst, 1, ld - botFirst + 1, width).getValues(), cols, tabName, cfg, from, found, null);
    memo.t[tabName] = [lr, ld, cols.hr, cols.phone + 1, m[4] || 0];
  });
  Object.keys(memo.t).forEach(function (k) { if (!names[k]) delete memo.t[k]; });
  props.setProperty('CRM_TABS2', JSON.stringify(memo));
  if (full) props.setProperty('FULL_BLOCK', blockKey);

  if (!found.length) {                                                         // nothing new: no need to hold up the agents' edits
    if (stamp) props.setProperty('CRM_STAMP', stamp);
    checked_(ss, now, 'no new leads' + (full ? ' (all tabs read)' : ''));
    return '';
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return 'busy';
  try {
    var data = leadKeys_(ss), seen = seenIndex_(data.rows), add = [];
    found.forEach(function (f) {
      var x = f.row;
      if (alreadyHere_(seen, x)) return;
      remember_(seen, x);
      x[L.TAB - 1] = T.LIVE;
      x[L.ADDED - 1] = now;
      computeLead_(x, cfg, now);
      add.push(x);
    });
    add.sort(function (a, b) { return a[L.DATE - 1] - b[L.DATE - 1]; });
    var msg = add.length ? add.length + ' new lead' + (add.length === 1 ? '' : 's') : 'no new leads';
    if (add.length) {
      var lr = appendLeads_(data.sh, add), live = ss.getSheetByName(T.LIVE);
      var row = Math.max(live.getLastRow(), HEAD_ROW) + 1;
      growRows_(ss, live, row + add.length, cfg);
      live.getRange(row, 1, add.length, WN).setValues(add.map(function (x, i) { return workCells_(x, lr + i, T.LIVE); }));
      live.getRange(row, W.TICK, add.length, 1).insertCheckboxes();
      props.setProperty('LAST_NEW', '🆕 ' + msg + ' at ' + Utilities.formatDate(now, TZ, 'HH:mm') + ' (from row ' + row + ')');
    }
    if (stamp) props.setProperty('CRM_STAMP', stamp);
    checked_(ss, now, msg + (full ? ' (all tabs read)' : ''));
    return add.length ? msg : '';
  } finally {
    lock.releaseLock();
  }
}

/** Shows when the CRM was last checked: Settings → C17 and the top of Live leads. */
function checked_(ss, now, what) {
  var t = Utilities.formatDate(now, TZ, 'HH:mm'), props = PropertiesService.getDocumentProperties();
  ss.getSheetByName(T.SET).getRange(SC.LASTCHECK).setValue('Checked ' + Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ' — ' + what);
  var lastNew = props.getProperty('LAST_NEW') || '';
  ss.getSheetByName(T.LIVE).getRange('P1').setValue('🔄 CRM checked ' + t + (lastNew ? '   ·   ' + lastNew : ''))
    .setFontColor(COL.red).setFontWeight('bold').setFontFamily(FONT);
}

function skipTab_(name, cfg) { var n = String(name).toLowerCase(); return cfg.skip.some(function (w) { return w && n.indexOf(w) >= 0; }); }

/** What is already on Leads: ids, number + campaign, number + day. */
/** Just the columns that tell whether a lead is already here (quick, so the lock is held only briefly). */
function leadKeys_(ss) {
  var sh = ss.getSheetByName(T.LEADS), last = sh.getLastRow(), w = Math.max(L.ID, L.DATE, L.CAMP, L.ADSET, L.PHONE);
  return { sh: sh, rows: last >= 2 ? sh.getRange(2, 1, last - 1, w).getValues() : [] };
}
function seenIndex_(rows) {
  var s = { id: {}, pc: {}, day: {} };
  rows.forEach(function (r) { remember_(s, r); });
  return s;
}
function dayKey_(phone, d) { return phone + '|' + Utilities.formatDate(d, TZ, 'yyyyMMdd'); }
function remember_(s, r) {
  var ph = clean_(r[L.PHONE - 1]), d = asDate_(r[L.DATE - 1]);
  s.id[r[L.ID - 1]] = 1;
  if (ph) {
    s.pc[ph + '|' + clean_(r[L.CAMP - 1]).toLowerCase()] = 1;
    if (clean_(r[L.ADSET - 1])) s.pc[ph + '|' + clean_(r[L.ADSET - 1]).toLowerCase()] = 1;
    if (d) s.day[dayKey_(ph, d)] = 1;
  }
}
function alreadyHere_(s, x) {
  var ph = clean_(x[L.PHONE - 1]), t = x[L.DATE - 1];
  if (s.id[x[L.ID - 1]]) return true;
  if (s.pc[ph + '|' + clean_(x[L.CAMP - 1]).toLowerCase()]) return true;
  return !!(s.day[dayKey_(ph, t)] || s.day[dayKey_(ph, addDays_(t, -1))] || s.day[dayKey_(ph, addDays_(t, 1))]);
}

/** A cell that holds a mobile number: p:+91 98…, +91 98…, 9876543210, 919876543210 (a number cell too). */
function phoneLike_(v) {
  if (typeof v === 'number') { var n = String(Math.round(v)); return n.length >= 10 && n.length <= 12; }
  var s = clean_(v);
  if (!s || s.length > 24 || /@|[a-z]{3,}/i.test(s.replace(/^p:/i, ''))) return false;
  var d = s.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 && /^[6-9]/.test(d.slice(-10));
}

/**
 * Finds the header row (one of the first 5) and the columns a lead needs, or null. A header whose phone cell was typed
 * over (a number where “phone_number” should be) still works: the phone column is then the one full of numbers.
 */
function crmCols_(vals) {
  var H = null, hr = 0, norm = function (x) { return clean_(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  for (var k = 0; k < Math.min(5, vals.length) && !H; k++) {
    var h = vals[k].map(norm);
    if (h.some(function (x) { return /phone|mobile|contact n|whatsapp n/.test(x); }) ||
      (h.indexOf('created time') >= 0 && (h.indexOf('id') >= 0 || h.indexOf('full name') >= 0 || h.indexOf('adset name') >= 0))) { H = h; hr = k; }
  }
  if (!H) return null;
  var ix = function (names) { for (var k = 0; k < names.length; k++) { var j = H.indexOf(names[k]); if (j >= 0) return j; } return -1; };
  var c = {
    hr: hr,
    id: ix(['id', 'lead id']),
    time: ix(['created time', 'date', 'timestamp', 'date time', 'date and time', 'lead date', 'created on', 'time']),
    adset: ix(['adset name', 'ad set name']), ad: ix(['ad name']), camp: ix(['campaign name', 'campaign']),
    name: ix(['full name', 'name', 'customer name', 'client name', 'pet parent name']),
    phone: ix(['phone number', 'phone', 'mobile number', 'mobile', 'contact number', 'whatsapp number', 'phone no', 'mobile no']),
    city: ix(['city', 'location', 'branch', 'unit']),
    booked: ix(['booked', 'booking', 'appointment booked']), visited: ix(['visited']), connected: ix(['connected', 'reached', 'spoke']),
    remarks: ix(['remarks', 'remark', 'comments', 'comment', 'notes', 'feedback'])
  };
  if (c.phone < 0) for (var q = 0; q < H.length; q++) if (/phone|mobile|contact n|whatsapp n/.test(H[q])) { c.phone = q; break; }
  if (c.phone < 0) {                                                      // the header cell was typed over: the column of numbers
    var best = -1, most = 0, data = vals.slice(hr + 1, hr + 41);
    for (var j = 0; j < H.length; j++) {
      var n = data.filter(function (r) { return phoneLike_(r[j]); }).length;
      if (n > most) { most = n; best = j; }
    }
    if (best >= 0 && most >= Math.min(3, data.length)) c.phone = best;
  }
  return c.phone < 0 || c.time < 0 ? null : c;
}

/**
 * CRM rows → leads of this file's city (not yet checked against Leads). A row pasted in with its columns shifted
 * (another form's layout) still counts: its number is taken from the cell that holds one, the name from the cell before.
 * anyCity: every city (to find a number's campaign); 'all' also keeps the skipped campaigns (VOW …), marked skip.
 */
function crmRows_(rows, c, tabName, cfg, from, out, until, anyCity) {
  var g = function (row, j) { return j >= 0 && j < row.length ? clean_(row[j]) : ''; };
  var yes = function (row, j) { var v = j >= 0 && j < row.length ? row[j] : ''; return v === true || v === 1 || /^(yes|y|true|1|booked|visited|connected|done|✓|✔)$/i.test(clean_(v)); };
  rows.forEach(function (row) {
    var t = parseLeadTime_(row[c.time]);
    if (t && CRM_SHIFT_ && row[c.time] instanceof Date && /whats\s*app/i.test(tabName)) t = new Date(t.getTime() - CRM_SHIFT_);   // WhatsApp tool writes Indian clock time
    if (!t || (from && t < from) || (until && t >= until)) return;
    var adset = g(row, c.adset), ad = g(row, c.ad), camp = g(row, c.camp);
    var all = [adset, ad, camp, tabName].join(' | ').toLowerCase();
    var skip = cfg.skip.some(function (w) { return w && all.indexOf(w) >= 0; });
    if (skip && anyCity !== 'all') return;
    var city = cityOf_(adset, cfg) || cityOf_(ad, cfg) || cityOf_(camp, cfg) || cityOf_(g(row, c.city), cfg);
    if (!city && !otherBranch_([adset, ad, camp, g(row, c.city)].join(' | '))) city = cityOf_(tabName, cfg);   // no city in the ad names → the tab's
    if (!anyCity && (!city || city !== cfg.city)) return;                  // anyCity: every lead (to find a number's campaign)
    var pc = c.phone, name = g(row, c.name);
    if (!phoneLike_(row[pc])) {                                            // shifted row: the cell that holds the number
      for (var j = 0; j < row.length; j++) {
        if (j === c.time || j === c.id || !phoneLike_(row[j])) continue;
        var before = j > 0 ? g(row, j - 1) : '';
        if (before && !phoneLike_(before) && !/^_?(yes|no)$/i.test(before) && !/@/.test(before)) name = before;
        pc = j;
        break;
      }
    }
    var p = normPhone_(row[pc]);
    if (!/\d{7,}/.test(p.phone)) return;                                    // no number (a status word like CREATED …)
    if (phoneLike_(name) || /^_?(yes|no)$/i.test(name)) name = '';
    var x = newLead_();
    x[L.ID - 1] = g(row, c.id) ? 'meta:' + g(row, c.id) : 'wa:' + p.phone + ':' + Utilities.formatDate(t, TZ, 'yyyyMMddHHmm');
    x[L.DATE - 1] = t;
    x[L.CITY - 1] = city;
    x[L.CAMP - 1] = camp || adset || tabName;
    x[L.ADSET - 1] = adset;
    x[L.NAME - 1] = name;
    x[L.PHONE - 1] = p.phone;
    x[L.RAW - 1] = p.raw;
    x[L.SOURCE - 1] = c.id >= 0 ? 'Meta lead form' : /whats\s*app/i.test(tabName) ? 'WhatsApp lead' : 'CRM tab: ' + tabName;
    if (yes(row, c.booked) || yes(row, c.visited)) setBox_(x, 0, 'Booked', t);    // Notes stay for what the agents write
    out.push({ row: x, tab: tabName, skip: skip });
  });
}

/** '2026-11-04T07:52:01+05:30', '2026-10-19 12:48:22' (India time), 04/11/2026, a date cell … → Date */
/** Names another branch (an ad set for Coimbatore on the Madurai tab …). */
function otherBranch_(text) {
  return /coimbatore|\bcbe\b|trichy|bangalore|bengaluru|salem|velachery|adyar|anna\s*nagar|neelan?g?karai|neelangarai|saibaba/i.test(String(text || ''));
}

/**
 * The Meta Leads CRM file is set to GMT, but the WhatsApp tool writes Indian clock time into it (17:00 written means
 * 5:00 PM in India). CRM_SHIFT_ = how far such a time reads ahead (5½ hours for a GMT file, 0 for an India-time file).
 * Meta lead-form times carry their own zone and Google Form timestamps are real moments, so only WhatsApp tabs are shifted.
 */
var CRM_SHIFT_ = 0;
function openCrm_(id) {
  var crm = SpreadsheetApp.openById(id);
  CRM_SHIFT_ = tzShift_(crm.getSpreadsheetTimeZone());
  return crm;
}
function tzShift_(tz) {
  if (!tz) tz = 'GMT';                                                           // a file never given a time zone is on GMT
  var now = new Date(), off = function (z) { var s = Utilities.formatDate(now, z, 'Z'), m = s.match(/([+-])(\d{2})(\d{2})/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; };
  return (off(TZ) - off(tz)) * 60000;
}

/**
 * Once: WhatsApp leads brought in before the fix above read 5½ hours late — their lead time is put right (lead id kept,
 * comments untouched). → a message, '' when nothing needed it, null when busy.
 */
var WA_DIAG_ = '';
function fixWhatsappTimes_(ss, cfg, cut) {
  if (!cfg.crmId) return '';
  var tz = openCrm_(cfg.crmId).getSpreadsheetTimeZone(), shift = tzShift_(tz);
  WA_DIAG_ = 'CRM time zone ' + (tz || 'not set = GMT') + ', shift ' + Math.round(shift / 60000) + ' min';
  if (!shift) return '';
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return null;
  try {
    var sh = ss.getSheetByName(T.LEADS), last = sh.getLastRow();
    if (last < 2) return '';
    var ids = sh.getRange(2, L.ID, last - 1, 1).getValues(), src = sh.getRange(2, L.SOURCE, last - 1, 1).getValues();
    var dates = sh.getRange(2, L.DATE, last - 1, 1).getValues(), added = sh.getRange(2, L.ADDED, last - 1, 1).getValues(), n = 0;
    for (var i = 0; i < ids.length; i++) {
      var d = asDate_(dates[i][0]), a = asDate_(added[i][0]);
      if (!d || !/^wa:/.test(String(ids[i][0])) || !/whats\s*app/i.test(String(src[i][0]))) continue;
      if (cut && a && a.getTime() >= cut) continue;                                // brought in by the fixed reading already
      dates[i][0] = new Date(d.getTime() - shift);
      n++;
    }
    WA_DIAG_ += ', ' + n + ' WhatsApp leads';
    if (!n) return '';
    sh.getRange(2, L.DATE, last - 1, 1).setValues(dates);
    return n + ' WhatsApp lead times put right (they read ' + Math.round(shift / 60000) / 60 + ' h late)';
  } finally {
    lock.releaseLock();
  }
}

function parseLeadTime_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = clean_(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 330 * 60000);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) {
    var h = +(m[4] || 0);
    if (m[7] && /pm/i.test(m[7]) && h < 12) h += 12;
    if (m[7] && /am/i.test(m[7]) && h === 12) h = 0;
    return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], h, +(m[5] || 0), +(m[6] || 0)) - 330 * 60000);
  }
  return null;
}

/* ========================================================================= */
/*  Old leads from the CRM (one time)                                        */
/* ========================================================================= */

/**
 * OWNER (menu, one time). This city's leads the CRM had before the automatic import started (Settings → C5), from every
 * tab — hidden ones too. An enquiry the old Excel already has (same number from 2 days before to 7 days after) is not
 * added again. They go to Old leads. Safe to run again: what is already here is skipped.
 */
function importOldCrmLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSetup_(ss, true);
  var cfg = readCfg_(ss), set = ss.getSheetByName(T.SET), now = new Date();
  if (!cfg.city) { ss.toast('Pick the city of this file in Settings → C3 first.', 'SM Calling', 10); return ''; }
  if (!cfg.crmId) { ss.toast('Put the Meta Leads CRM link in Settings → C4 first.', 'SM Calling', 10); return ''; }
  var found = [], tabs = 0, hidden = 0;
  openCrm_(cfg.crmId).getSheets().forEach(function (tab) {
    var name = tab.getName();
    if (skipTab_(name, cfg)) return;
    var vals = tab.getLastRow() ? tab.getDataRange().getValues() : [];
    var cols = crmCols_(vals);
    if (!cols) return;
    tabs++;
    if (tab.isSheetHidden()) hidden++;
    crmRows_(vals.slice(cols.hr + 1), cols, name, cfg, null, found, cfg.from || null);
  });
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { ss.toast('Busy — try again in a minute.', 'SM Calling', 8); return ''; }
  try {
    var r = addOldLeads_(ss, cfg, found, function (f) { return 'Old CRM lead (' + f.tab + ')'; }, now);
    var msg = Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ': ' + found.length + ' ' + cfg.city + ' leads found in ' + tabs + ' CRM tabs (' + hidden +
      ' hidden) · ' + r.added + ' added to Old leads · ' + r.skipped + ' already here';
    set.getRange(SC.OLDCRM).setValue(msg);
    rebuildTabs_(ss, cfg, now);
    refreshReports_(ss, cfg);
    ss.toast(msg, 'SM Calling', 15);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Adds old leads ({row, tab} from crmRows_) to the Leads record for Old leads (Junk leads when the notes say so).
 * A number already here from 2 days before to 7 days after is the same enquiry and is skipped. Call inside the lock.
 */
function addOldLeads_(ss, cfg, found, label, now, synced) {
  if (!synced) CALL_TABS.forEach(function (t) { if (ss.getSheetByName(t)) syncTab_(ss, cfg, t, now); });
  var data = leadsAll_(ss), seen = seenIndex_(data.rows), dates = {}, add = [], skipped = 0;
  data.rows.forEach(function (r) {
    var d = asDate_(r[L.DATE - 1]), ph = clean_(r[L.PHONE - 1]);
    if (d && ph) (dates[ph] = dates[ph] || []).push(d.getTime());
  });
  found.sort(function (a, b) { return a.row[L.DATE - 1] - b.row[L.DATE - 1]; });
  found.forEach(function (f) {
    var x = f.row, ph = x[L.PHONE - 1], t = x[L.DATE - 1].getTime();
    var same = (dates[ph] || []).some(function (d) { return d >= t - 2 * DAY_MS && d <= t + 7 * DAY_MS; });
    if (same || alreadyHere_(seen, x)) { skipped++; return; }
    remember_(seen, x);
    (dates[ph] = dates[ph] || []).push(t);
    x[L.SOURCE - 1] = label(f);
    x[L.TAB - 1] = junkNote_(x[L.NOTES - 1]) ? T.JUNK : T.OLD;
    x[L.ADDED - 1] = now;
    computeLead_(x, cfg, now);
    add.push(x);
  });
  if (add.length) appendLeads_(data.sh, add);
  return { added: add.length, skipped: skipped };
}

/**
 * A Meta lead-form export (created_time, adset_name, full_name, phone_number …) uploaded on the hub → this city's leads
 * from before the automatic import (Settings → C5) go to Old leads. Ad set names pick the city; when the file names only
 * one city, its rows without a city name are that city's. Returns null when busy (the file is read again next time).
 */
function loadMetaLeads_(ss, cfg, rows, name, now) {
  var cols = crmCols_(rows);
  if (!cols) return 'no created time / phone number columns';
  var part = String(name).replace(/\.csv$/i, '').replace(/^Hub_[\d-]+_\d+_/, '');
  var all = [], count = {};
  crmRows_(rows.slice(cols.hr + 1), cols, part, cfg, null, all, cfg.from || null, true);
  all.forEach(function (f) { var c = f.row[L.CITY - 1]; if (c) count[c] = (count[c] || 0) + 1; });
  var only = Object.keys(count).length === 1 ? Object.keys(count)[0] : '';
  var found = all.filter(function (f) {
    var x = f.row;
    if (!x[L.CITY - 1] && only && !otherBranch_(x[L.ADSET - 1] + ' | ' + x[L.CAMP - 1])) x[L.CITY - 1] = only;
    return x[L.CITY - 1] === cfg.city;
  });
  if (!found.length) return 'no ' + cfg.city + ' leads' + (cfg.from ? ' before ' + Utilities.formatDate(cfg.from, TZ, 'dd-MMM-yyyy') : '');
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) return null;
  try {
    var r = addOldLeads_(ss, cfg, found, function () { return 'Old Meta leads file'; }, now);
    var msg = Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ' Meta leads file (' + part + '): ' + found.length + ' ' + cfg.city + ' leads · ' +
      r.added + ' added to Old leads · ' + r.skipped + ' already here';
    ss.getSheetByName(T.SET).getRange(SC.OLDCRM).setValue(msg);
    rebuildTabs_(ss, cfg, now);
    refreshReports_(ss, cfg);
    return found.length + ' ' + cfg.city + ' leads · ' + r.added + ' added to Old leads · ' + r.skipped + ' already here';
  } finally {
    lock.releaseLock();
  }
}

/* ========================================================================= */
/*  The old comments Excel                                                   */
/* ========================================================================= */

/** OWNER (menu): the old Excel tabs added here with File → Import, and any Excel uploaded through the hub. */
function bringInOldExcel() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSetup_(ss, true);
  var cfg = readCfg_(ss);
  if (!cfg.city) { ss.toast('Pick the city of this file in Settings → C3 first.', 'SM Calling', 10); return ''; }
  var tables = [];
  ss.getSheets().forEach(function (tab) {
    var name = tab.getName();
    if (ORDER.indexOf(name) >= 0 || tab.getLastRow() < 2) return;
    var vals = tab.getDataRange().getValues();
    if (excelHeader_(vals) >= 0) tables.push({ name: name, rows: vals, sheet: tab });
  });
  var msg = '';
  if (tables.length) {
    msg = importExcelTables_(ss, cfg, tables, new Date());
    tables.forEach(function (t) { try { t.sheet.hideSheet(); } catch (err) { } });
  }
  var up = '';
  try { up = readUploads_(ss, cfg, new Date(), true); } catch (err) { up = ''; }
  var out = [msg, up].filter(Boolean).join(' · ') || 'No old Excel found. Upload it in the MIS Upload Hub, or use File → Import → “Insert new sheet(s)” here, then run this again.';
  ss.toast(out, 'SM Calling', 15);
  return out;
}

/** Row of the header (Phone number + Comments / RNR columns) in the first 5 rows, or -1. */
function excelHeader_(vals) {
  for (var k = 0; k < Math.min(5, vals.length); k++) {
    var h = vals[k].map(function (x) { return clean_(x).toLowerCase(); });
    if (h.some(function (x) { return /phone/.test(x); }) && h.some(function (x) { return /^comment|rnr/.test(x); })) return k;
  }
  return -1;
}

/**
 * Old Excel tables → leads of this city. The rows were typed by hand: statuses many ways (rnr / RNR / hungup …), dates
 * many ways, the same enquiry on several rows. Each enquiry (city + number + campaign) becomes one lead with all its
 * calls: Comments + Followup 1–5 (the latest six), the Excel date as the call day. Then:
 *  • the campaign, ad set, name and lead time come from the Meta Leads CRM (same number, lead in the month before);
 *  • the last week’s leads (not junk) go to Followup/Callback, junk to Junk leads, the rest to Old leads.
 * Safe to run again with a newer Excel: a lead not yet worked on in this sheet is updated, not added twice.
 */
function importExcelTables_(ss, cfg, tables, now) {
  var recs = {}, order = [], used = [], skipped = 0;
  tables.forEach(function (tb) {
    var vals = tb.rows, hi = excelHeader_(vals);
    if (hi < 0) return;
    var H = vals[hi].map(function (x) { return clean_(x).toLowerCase(); });
    var find = function (re) { for (var j = 0; j < H.length; j++) if (re.test(H[j])) return j; return -1; };
    var iDate = find(/^date/), iCamp = find(/campaign/), iPhone = find(/phone/), iCom = find(/^comment/);
    var iRem = find(/^remark/), iDept = find(/^department/), rnr = [];
    H.forEach(function (x, j) { if (/rnr|hang\s*up|voice\s*mail|follow/.test(x)) rnr.push(j); });
    var lastUsed = Math.max.apply(null, [iDate, find(/^agent/), iCamp, iPhone, iCom, iRem, iDept].concat(rnr));
    var part = String(tb.name).replace(/\.csv$/i, '').split('_').pop();             // hub files: Hub_<time>_<file>_<sheet>.csv
    var tabCity = cityOf_(part, cfg) || cityOf_(tb.name, cfg), archive = /old/i.test(part);
    var dates = rowDates_(vals, hi + 1, iDate, iCamp);
    var n = 0;
    for (var r = hi + 1; r < vals.length; r++) {
      var row = vals[r];
      var phoneRaw = clean_(row[iPhone]), camp = iCamp >= 0 ? clean_(row[iCamp]) : '';
      var remRaw = iRem >= 0 ? clean_(row[iRem]) : '', deptRaw = iDept >= 0 ? clean_(row[iDept]) : '';
      var remRes = bareResult_(remRaw), deptRes = bareResult_(deptRaw);
      var cells = [iCom >= 0 ? clean_(row[iCom]) : '', remRes ? remRaw : '', deptRes ? deptRaw : ''].concat(rnr.map(function (j) { return clean_(row[j]); }));
      var extra = row.slice(lastUsed + 1).map(clean_).filter(Boolean);
      if ((!phoneRaw && !cells.some(Boolean)) || /phone/i.test(phoneRaw)) continue;
      var city = tabCity || cityOf_(camp, cfg);
      if (city !== cfg.city) { if (!city) skipped++; continue; }
      var p = normPhone_(phoneRaw);
      if (!p.phone) continue;
      var results = [], notes = [];
      cells.concat(extra.filter(function (x) { return x.length < 40 && !/\|/.test(x); })).forEach(function (c) {
        if (!c) return;
        var digits = c.replace(/\D/g, '');
        if (digits.length >= 10 && /^[\d\s+\-]+$/.test(c)) { notes.push(c); return; }
        var m = mapResult_(c.toLowerCase());
        if (!m) return;
        results.push(canonical_(m.result, cfg));
        if (m.extra) notes.push(c);
      });
      var rem = remRes ? '' : remRaw;
      var d = dates[r] || campaignDate_(camp);
      var id = 'xl:' + hash_(city + '|' + p.phone + '|' + camp.toLowerCase());
      var rec = recs[id];
      if (!rec) {
        rec = recs[id] = { id: id, camp: camp, phone: p.phone, ok: p.ok, raw: p.raw, date: d || null, calls: [], notes: [], dept: '',
          source: archive ? 'Old Excel (old data tab)' : 'Old Excel' };
        order.push(id);
      }
      if (d && (!rec.date || d < rec.date)) rec.date = d;
      results.forEach(function (x) { rec.calls.push({ v: x, t: d || null }); });
      [rem].concat(notes).forEach(function (x) { if (x && rec.notes.indexOf(x) < 0) rec.notes.push(x); });
      var dept = deptRes ? '' : deptRaw;
      if (dept) rec.dept = dept.charAt(0).toUpperCase() + dept.slice(1).toLowerCase();
      n++;
    }
    if (n) used.push(tb.name);
  });
  if (!order.length) return used.length ? 'Old Excel: no ' + cfg.city + ' rows' : '';

  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) return 'Old Excel: busy, will try again';
  try {
    CALL_TABS.forEach(function (t) { if (ss.getSheetByName(t)) syncTab_(ss, cfg, t, now); });
    var data = leadsAll_(ss), rows = data.rows, byPhone = {};
    rows.forEach(function (r, i) { var ph = clean_(r[L.PHONE - 1]); if (ph) (byPhone[ph] = byPhone[ph] || []).push(i); });
    var add = [], touched = {}, o = { added: 0, updated: 0, joined: 0, kept: 0 };
    order.forEach(function (id) {
      var rec = recs[id], calls = rec.calls.slice(-(BOXES + 1));
      var fill = function (x) {
        for (var k = 0; k <= BOXES; k++) setBox_(x, k, calls[k] ? calls[k].v : '', calls[k] && calls[k].t ? calls[k].t : '');
        x[L.NOTES - 1] = rec.notes.filter(function (s, k, a) { return s && a.indexOf(s) === k; }).join(' | ');   // only what the agents typed
        if (rec.dept) x[L.DEPT - 1] = rec.dept;
        if (!/^xl:/.test(x[L.ID - 1]) && String(x[L.SOURCE - 1]).indexOf('Old Excel') < 0) x[L.SOURCE - 1] = clean_(x[L.SOURCE - 1]) + ' + Old Excel';
      };
      var i = data.byId[id];
      if (i === undefined) {
        // the same enquiry brought from the CRM already (a lead of this number in the month before the Excel day)
        var end = rec.date ? dayOnly_(rec.date).getTime() + DAY_MS : 0;
        (byPhone[rec.phone] || []).some(function (j) {
          var y = rows[j], t = time_(y[L.DATE - 1]);
          if (/^xl:/.test(y[L.ID - 1]) || !end || t >= end + DAY_MS || t < end - 31 * DAY_MS) return false;
          i = j;
          return true;
        });
        if (i !== undefined) o.joined++;
      }
      if (i !== undefined) {
        var y = rows[i];
        if (y[L.WORKED - 1]) { o.kept++; return; }                         // already worked on here — this sheet wins
        var sig = function (z) { return JSON.stringify(z.slice(L.COM - 1, L.TF1 + BOXES - 1)) + z[L.NOTES - 1] + z[L.DEPT - 1]; }, was = sig(y);
        fill(y);
        if (sig(y) === was && data.byId[id] !== undefined) return;            // nothing new for this lead
        touched[i] = 1;
        if (data.byId[id] !== undefined) o.updated++;
        return;
      }
      var x = newLead_();
      x[L.ID - 1] = id; x[L.DATE - 1] = rec.date || ''; x[L.CITY - 1] = cfg.city; x[L.CAMP - 1] = rec.camp; x[L.PHONE - 1] = rec.phone; x[L.RAW - 1] = rec.raw;
      x[L.SOURCE - 1] = rec.source; x[L.ADDED - 1] = now; x[L.TAB - 1] = T.OLD;
      fill(x);
      rows.push(x);
      data.byId[id] = rows.length - 1;
      (byPhone[rec.phone] = byPhone[rec.phone] || []).push(rows.length - 1);
      touched[rows.length - 1] = 1;
      o.added++;
    });
    // campaign / ad set / name / lead time from the CRM
    var fix = '';
    try { fix = fixFromCrm_(cfg, rows, touched); var bl = fillBlankCampaigns_(cfg, rows); if (bl) fix += ' · ' + bl; }
    catch (err) { fix = 'campaign names not checked (' + String(err && err.message ? err.message : err) + ')'; }
    // which tab: the last week’s leads (not junk) → Followup/Callback, junk → Junk leads, no need / older → Old leads
    var cut = now.getTime() - cfg.days * DAY_MS, per = {};
    Object.keys(touched).forEach(function (k) {
      var x = rows[k];
      if (!x || !x[L.ID - 1]) return;
      var lt = latest_(x), recent = time_(x[L.DATE - 1]) >= cut;
      var tab = !lt ? (recent ? T.LIVE : T.OLD) : tabFor_(lt.res, cfg);
      if (tab === T.FU && !recent) tab = T.OLD;
      if (tab !== T.LIVE && junkNote_(x[L.NOTES - 1])) tab = T.JUNK;            // Notes say wrongly filled / out of station
      x[L.TAB - 1] = tab;
      x[L.FROM - 1] = ''; x[L.MOVED - 1] = now;
      computeLead_(x, cfg, now);
      per[tab] = (per[tab] || 0) + 1;
    });
    rows = rows.filter(function (x) { return x[L.ID - 1]; });
    var sh = data.sh;
    ensureRows_(sh, rows.length + 2);
    if (sh.getLastRow() > rows.length + 1) sh.getRange(rows.length + 2, 1, sh.getLastRow() - rows.length - 1, NL).clearContent();
    if (rows.length) {
      sh.getRange(2, L.PHONE, rows.length, 1).setNumberFormat('@');
      sh.getRange(2, 1, rows.length, NL).setValues(rows);
    }
    relogExcel_(ss, cfg, rows);
    var msg = 'Old Excel ' + Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ' (' + used.join(', ') + '): ' + o.added + ' leads added, ' + o.updated +
      ' updated, ' + o.joined + ' joined to the CRM lead already here' + (o.kept ? ', ' + o.kept + ' left as they are (already worked on here)' : '') +
      ' → ' + [T.FU, T.JUNK, T.OLD, T.LIVE].filter(function (t) { return per[t]; }).map(function (t) { return t + ' ' + per[t]; }).join(', ') +
      (fix ? ' · ' + fix : '');
    ss.getSheetByName(T.SET).getRange(SC.EXCEL).setValue(msg);
    rebuildTabs_(ss, cfg, now);
    refreshReports_(ss, cfg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** The Call Log lines of the old-Excel calls, written again from the leads (so a newer Excel never doubles them). */
function relogExcel_(ss, cfg, rows) {
  var redo = {}, alive = {}, lines = [];
  rows.forEach(function (r) {
    alive[r[L.ID - 1]] = 1;
    if (r[L.WORKED - 1] || (!/^xl:/.test(r[L.ID - 1]) && String(r[L.SOURCE - 1]).indexOf('Old Excel') < 0)) return;
    redo[r[L.ID - 1]] = 1;
    for (var k = 0; k <= BOXES; k++) {
      var v = boxVal_(r, k), t = boxTime_(r, k);
      if (v && t) lines.push([t, r[L.ID - 1], r[L.PHONE - 1], v, ruleOf_(v, cfg).conn ? 'Yes' : 'No', BOX_NAMES[k], 'Old Excel', '']);
    }
  });
  var log = ss.getSheetByName(T.LOG), last = log.getLastRow();
  var keep = last >= 2 ? log.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues().filter(function (x) {
    return x[6] !== 'Old Excel' || (!redo[x[1]] && alive[x[1]]);
  }) : [];
  var all = keep.concat(lines).sort(function (a, b) { return time_(a[0]) - time_(b[0]); });
  if (last >= 2) log.getRange(2, 1, last - 1, LOG_HEADERS.length).clearContent();
  if (!all.length) return;
  ensureRows_(log, all.length + 2);
  log.getRange(2, 3, all.length, 1).setNumberFormat('@');
  log.getRange(2, 1, all.length, LOG_HEADERS.length).setValues(all);
}

/** Every lead of this city in the CRM (all tabs, hidden too) → { phone: [{ t, camp, adset, name, id }] }. */
function crmIndex_(cfg, found) {
  var idx = {};
  (found || crmAll_(cfg)).forEach(function (f) {
    var x = f.row;
    (idx[x[L.PHONE - 1]] = idx[x[L.PHONE - 1]] || []).push({ t: x[L.DATE - 1], camp: x[L.CAMP - 1], adset: x[L.ADSET - 1], name: x[L.NAME - 1], id: x[L.ID - 1],
      own: x[L.CITY - 1] === cfg.city, skip: !!f.skip });
  });
  return idx;
}
/** Every lead in every CRM tab, hidden ones too — every city, the skipped campaigns (VOW …) marked skip. */
function crmAll_(cfg) {
  var found = [];
  openCrm_(cfg.crmId).getSheets().forEach(function (tab) {
    var vals = tab.getLastRow() ? tab.getDataRange().getValues() : [];
    var cols = crmCols_(vals);
    if (cols) crmRows_(vals.slice(cols.hr + 1), cols, tab.getName(), cfg, null, found, null, 'all');
  });
  return found;
}
/** The candidate to use: this city's own campaigns first, then any other, a VOW / skipped campaign only when nothing else. */
function bestCand_(cand, pick) {
  return pick(cand.filter(function (c) { return c.own && !c.skip; })) || pick(cand.filter(function (c) { return c.own; })) ||
    pick(cand.filter(function (c) { return !c.skip; })) || pick(cand);
}
function normCamp_(c) { return clean_(c).toLowerCase().replace(/[–—]/g, '-').replace(/\s*\|\s*/g, '|').replace(/\s+/g, ' '); }

/**
 * Old-Excel leads (rows[k] for k in `which`) get the campaign, ad set, name and lead time of their CRM lead: the same
 * number's CRM lead in the 31 days up to the Excel day (the latest), else in the week after. The Excel name is kept in
 * Notes when it was different. The same CRM lead typed twice in the Excel becomes one lead.
 */
function fixFromCrm_(cfg, rows, which) {
  if (!cfg.crmId) return '';
  var idx = crmIndex_(cfg), o = { fixed: 0, filled: 0, same: 0, none: 0, merged: 0 }, byCrm = {};
  Object.keys(which).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) {
    var x = rows[i];
    if (!x || !/^xl:/.test(x[L.ID - 1])) return;
    var cand = idx[clean_(x[L.PHONE - 1])] || [], d = asDate_(x[L.DATE - 1]);
    var pick = function (list) {
      var best = null;
      if (d) {
        var end = dayOnly_(d).getTime() + DAY_MS;
        list.forEach(function (c) { var t = c.t.getTime(); if (t < end && t >= end - 31 * DAY_MS && (!best || c.t > best.t)) best = c; });
        if (!best) list.forEach(function (c) { var t = c.t.getTime(); if (t >= end && t < end + 7 * DAY_MS && (!best || c.t < best.t)) best = c; });
      } else list.forEach(function (c) { if (!best || c.t > best.t) best = c; });
      return best;
    };
    // this city's campaigns first; a number that enquired through another city's ad gets that campaign
    var best = bestCand_(cand, pick);
    if (!best) { o.none++; return; }
    var was = clean_(x[L.CAMP - 1]);
    if (!was) o.filled++;
    else if (normCamp_(was) === normCamp_(best.camp) || normCamp_(was) === normCamp_(best.adset)) o.same++;
    else {
      o.fixed++;
    }
    x[L.CAMP - 1] = best.camp;
    x[L.ADSET - 1] = best.adset;
    if (!clean_(x[L.NAME - 1])) x[L.NAME - 1] = best.name;
    if (!d || best.t.getTime() < dayOnly_(d).getTime() + DAY_MS) x[L.DATE - 1] = best.t;       // the real lead date & time
    if (byCrm[best.id] !== undefined) { mergeLeads_(rows[byCrm[best.id]], x); x[L.ID - 1] = ''; o.merged++; }
    else byCrm[best.id] = i;
  });
  return 'Campaign names from the CRM: ' + o.fixed + ' corrected, ' + o.filled + ' filled in, ' + o.same + ' already right, ' + o.none +
    ' not found (kept as typed)' + (o.merged ? ', ' + o.merged + ' duplicate rows joined' : '');
}

/**
 * Leads with no campaign name: the campaign / ad set of the same number's lead in the Meta Leads CRM — this city's first,
 * else any — the one nearest in time to the lead date (no time limit). Numbers not in the CRM at all stay blank.
 */
function fillBlankCampaigns_(cfg, rows, idx) {
  var blank = rows.filter(function (x) { return x[L.ID - 1] && !clean_(x[L.CAMP - 1]); });
  if (!blank.length || !cfg.crmId) return '';
  idx = idx || crmIndex_(cfg);
  var filled = 0;
  blank.forEach(function (x) {
    var cand = idx[clean_(x[L.PHONE - 1])] || [];
    if (!cand.length) return;
    var d = time_(x[L.DATE - 1]), pick = function (list) {
      var best = null;
      list.forEach(function (c) { if (!best || (d ? Math.abs(c.t - d) < Math.abs(best.t - d) : c.t > best.t)) best = c; });
      return best;
    };
    var best = bestCand_(cand, pick);
    x[L.CAMP - 1] = best.camp;
    x[L.ADSET - 1] = best.adset;
    if (!clean_(x[L.NAME - 1])) x[L.NAME - 1] = best.name;
    filled++;
  });
  return 'blank campaigns: ' + filled + ' filled from the CRM, ' + (blank.length - filled) + ' numbers not in the CRM';
}

/** Lead b’s calls and notes go into lead a (the same enquiry typed twice). */
function mergeLeads_(a, b) {
  var calls = [];
  [a, b].forEach(function (x) { for (var k = 0; k <= BOXES; k++) { var v = boxVal_(x, k); if (v) calls.push({ v: v, t: boxTime_(x, k) }); } });
  calls.sort(function (p, q) { return (p.t ? p.t.getTime() : 0) - (q.t ? q.t.getTime() : 0); });
  calls = calls.slice(-(BOXES + 1));
  for (var k = 0; k <= BOXES; k++) setBox_(a, k, calls[k] ? calls[k].v : '', calls[k] && calls[k].t ? calls[k].t : '');
  var da = asDate_(a[L.DATE - 1]), db = asDate_(b[L.DATE - 1]);
  if (db && (!da || db < da)) a[L.DATE - 1] = db;
  var notes = [clean_(a[L.NOTES - 1]), clean_(b[L.NOTES - 1])].filter(Boolean);
  a[L.NOTES - 1] = notes.filter(function (r, k) { return notes.indexOf(r) === k; }).join(' | ');
  ['DEPT', 'NAME'].forEach(function (f) { if (!clean_(a[L[f] - 1]) && clean_(b[L[f] - 1])) a[L[f] - 1] = b[L[f] - 1]; });
}

/** 'LC | Vaccine Camp | Valasaravakkam | 16-09-2026 - A03' → 16-Sep-2026 */
function campaignDate_(camp) {
  var m = String(camp || '').match(/(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(20\d{2})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]) - 330 * 60000) : null;
}

/**
 * The Date column of an old tab, row by row. The rows were typed in date order, but the dates were typed many ways
 * (8/9/2026 meant 8-Sep but Excel read it as 9-Aug, 15/9/2026 stayed text, 11-Oct, blanks …). Every reading of a cell
 * is tried and the one that fits the row above (and the campaign date) is kept; a row with no date gets the one above.
 */
function rowDates_(vals, first, iDate, iCamp) {
  var today = dayOnly_(new Date()), out = [], prev = null;
  var yr = +Utilities.formatDate(today, TZ, 'yyyy');
  for (var r = 0; r < vals.length; r++) {
    if (r < first || iDate < 0) { out.push(null); continue; }
    var camp = iCamp >= 0 ? campaignDate_(vals[r][iCamp]) : null;
    var cands = dateReadings_(vals[r][iDate], prev ? +Utilities.formatDate(prev, TZ, 'yyyy') : yr, yr).filter(function (d) {
      return d <= today && (!camp || d >= addDays_(camp, -1));
    });
    if (prev && cands.length > 1) {
      var score = function (d) { var diff = (d - prev) / DAY_MS; return diff >= -2 ? diff : 1000 - diff; };
      cands.sort(function (a, b) { return score(a) - score(b); });
    }
    var pick = cands.length ? cands[0] : prev;
    if (pick && prev && pick - prev > 3 * DAY_MS && r + 1 < vals.length) {
      var nxt = dateReadings_(vals[r + 1][iDate], +Utilities.formatDate(prev, TZ, 'yyyy'), yr);
      if (nxt.some(function (d) { return Math.abs(d - prev) <= 3 * DAY_MS; })) pick = prev;
    }
    out.push(pick);
    if (pick) prev = pick;
  }
  return out;
}

/** Every date a cell could mean, most likely first. */
function dateReadings_(v, defYear, maxYear) {
  var out = [];
  var mk = function (y, m, d) {
    if (y < 2020 || y > maxYear) y = defYear;
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    var x = new Date(Date.UTC(y, m - 1, d));
    if (x.getUTCMonth() !== m - 1) return;
    var t = new Date(x.getTime() - 330 * 60000);
    if (!out.some(function (o) { return o.getTime() === t.getTime(); })) out.push(t);
  };
  if (v instanceof Date && !isNaN(v.getTime())) {
    var p = Utilities.formatDate(v, TZ, 'yyyy-MM-dd').split('-').map(Number);
    mk(p[0], p[1], p[2]);
    if (p[2] <= 12) mk(p[0], p[2], p[1]);
    return out;
  }
  var s = clean_(v).toLowerCase().replace(/[a-z]+$/, '').trim();
  if (!s) return out;
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                      // a real date cell, as the hub sends it
  if (iso) { mk(+iso[1], +iso[2], +iso[3]); if (+iso[3] <= 12) mk(+iso[1], +iso[3], +iso[2]); return out; }
  var MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var m = s.match(/^(\d{1,2})\s*[-\/ ]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:[-\/ ,]*(\d{2,4}))?/);
  if (m) { mk(m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : defYear, MON.indexOf(m[2]) + 1, +m[1]); return out; }
  m = s.match(/^(\d{1,2})\s*[\/.\- ]\s*(\d{1,2})(?:\s*[\/.\- ]\s*(\d{2,4}))?/);
  if (m) {
    var y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : defYear;
    mk(y, +m[2], +m[1]);
    mk(y, +m[1], +m[2]);
  }
  return out;
}

/** 'rnr', 'no pet', 'Booked' typed alone → that result; anything longer → '' (it is a note). */
function bareResult_(x) {
  var m = x ? mapResult_(x.toLowerCase()) : null;
  return m && !m.extra && m.result !== 'Other' ? m.result : '';
}

/**
 * Old-Excel leads whose typed campaign name was kept (the CRM lead was not found then): the campaign of the same number's
 * CRM lead in the 31 days up to the Excel day (else the week after). Only the campaign and ad set change.
 */
function recorrectExcel_(cfg, rows, idx) {
  var n = 0;
  rows.forEach(function (x) {
    if (!x[L.ID - 1] || String(x[L.SOURCE - 1]).indexOf('Old Excel') < 0) return;
    var cand = idx[clean_(x[L.PHONE - 1])] || [], d = asDate_(x[L.DATE - 1]);
    if (!cand.length || !d) return;
    var end = dayOnly_(d).getTime() + DAY_MS;
    var best = bestCand_(cand, function (list) {
      var b = null;
      list.forEach(function (c) { var t = c.t.getTime(); if (t < end && t >= end - 31 * DAY_MS && (!b || c.t > b.t)) b = c; });
      if (!b) list.forEach(function (c) { var t = c.t.getTime(); if (t >= end && t < end + 7 * DAY_MS && (!b || c.t < b.t)) b = c; });
      return b;
    });
    if (!best) return;
    var was = normCamp_(x[L.CAMP - 1]);
    if (was && (was === normCamp_(best.camp) || was === normCamp_(best.adset))) return;
    x[L.CAMP - 1] = best.camp;
    x[L.ADSET - 1] = best.adset;
    n++;
  });
  return n;
}

/**
 * Rev 4, once (inside the owner's every-minute rebuild, tabs already saved, under the lock): the CRM read again now that
 * tabs with a typed-over header cell and rows pasted in with shifted columns are understood. Old CRM leads whose “number”
 * was a name or a word (nobody could call them) go and the old CRM leads are brought in again (if ③ was used); old-Excel
 * campaign names kept as typed are corrected. The tabs are written fresh right after (by the caller).
 */
function repairLeads_(ss, cfg, now, crm) {
  var data = leadsAll_(ss), rows = data.rows, keep = [], gone = 0;
  rows.forEach(function (r) {
    var worked = r[L.WORKED - 1] || clean_(r[L.NOTES - 1]) || [0, 1, 2, 3, 4, 5].some(function (k) { return boxVal_(r, k); });
    if (r[L.ID - 1] && /^Old CRM lead/.test(String(r[L.SOURCE - 1])) && !/\d{7,}/.test(String(r[L.PHONE - 1])) && !worked) { gone++; return; }
    keep.push(r);
  });
  var fixed = recorrectExcel_(cfg, keep, crm.idx);
  if (rows.length) data.sh.getRange(2, 1, rows.length, NL).clearContent();
  if (keep.length) {
    data.sh.getRange(2, L.PHONE, keep.length, 1).setNumberFormat('@');
    data.sh.getRange(2, 1, keep.length, NL).setValues(keep);
  }
  var again = '';
  if (clean_(ss.getSheetByName(T.SET).getRange(SC.OLDCRM).getValue())) {                    // ③ was used: the old CRM leads again
    var old = crm.found.filter(function (f) { return !f.skip && f.row[L.CITY - 1] === cfg.city && (!cfg.from || f.row[L.DATE - 1] < cfg.from); });
    var r = addOldLeads_(ss, cfg, old, function (f) { return 'Old CRM lead (' + f.tab + ')'; }, now, true);
    again = ' · old CRM leads brought in again: ' + r.added;
  }
  var msg = Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ': CRM read again — ' + gone + ' old leads whose number was a name removed' + again +
    ' · ' + fixed + ' Excel campaign names corrected';
  ss.getSheetByName(T.SET).getRange(SC.OLDCRM).setValue(msg);
  return msg;
}

/* ========================================================================= */
/*  Every minute (owner's trigger)                                           */
/* ========================================================================= */

/** OWNER (menu ①): makes the upload folder, turns on the every-minute run and runs it once. */
function turnOnAutomatic() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSetup_(ss, true);
  var set = ss.getSheetByName(T.SET), cfg = readCfg_(ss);
  if (!cfg.city) { ss.toast('Pick the city of this file in Settings → C3 first.', 'SM Calling', 10); return ''; }
  if (!asDate_(set.getRange(SC.FROM).getValue())) set.getRange(SC.FROM).setValue(dayOnly_(new Date()));
  if (!cfg.upFolder) {
    var it = DriveApp.getFoldersByName(UPLOAD_FOLDER_NAME), folder = it.hasNext() ? it.next() : DriveApp.createFolder(UPLOAD_FOLDER_NAME);
    set.getRange(SC.UPFOLDER).setValue(folder.getUrl());
  }
  set.getRange('E3').clearContent();
  // this one, and the every-minute check of the earlier one-file version (if this file was that sheet)
  ScriptApp.getProjectTriggers().forEach(function (t) { if (/^(everyMinute|importNewLeads)$/.test(t.getHandlerFunction())) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('everyMinute').timeBased().everyMinutes(1).create();
  PropertiesService.getDocumentProperties().setProperties({ PACE: '1', BEAT: String(Date.now()) });
  var res = everyMinute(true);
  ss.toast('Automatic updates are on: new leads every minute in working hours (every 5 minutes at night), uploads read every few minutes. ' +
    (res || ''), 'SM Calling', 12);
  return res;
}

/**
 * The owner's automatic run: every minute from an hour before opening to an hour after closing, every 5 minutes at night
 * (it switches its own timer). Google allows a free account about 90 minutes of automatic runs a day for all its sheets
 * together, so the night runs are kept few.
 */
function everyMinute(force) {
  force = force === true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var run = LockService.getScriptLock();
  if (!run.tryLock(force ? 30000 : 100)) return 'busy';
  try {
    var now = new Date(), started = Date.now(), props = PropertiesService.getDocumentProperties();
    var mins = +Utilities.formatDate(now, TZ, 'HH') * 60 + +Utilities.formatDate(now, TZ, 'mm');
    var open = +(props.getProperty('OPEN') || 540), close = +(props.getProperty('CLOSE') || 1050);
    var working = mins >= open - 60 && mins <= close + 60;
    if (!force) pace_(props, working);
    if (!force && !working && props.getProperty('PACE') !== '5' && mins % 5 !== 0 && props.getProperty('REV_DONE') === REV) return 'night';   // timer not switched
    props.setProperty('BEAT', String(now.getTime()));
    ensureSetup_(ss, true);
    if (props.getProperty('REV_DONE') !== REV && clean_(ss.getSheetByName(T.SET).getRange(SC.REV).getValue()) === REV) props.setProperty('REV_DONE', REV);
    var cfg = readCfg_(ss);
    props.setProperties({ OPEN: String(cfg.open), CLOSE: String(cfg.close) });
    if (!cfg.city) return 'no city';
    var out = [];
    if (props.getProperty('WA_TZ3') !== '1') {                                 // once: WhatsApp lead times (CRM file set to GMT)
      if (!props.getProperty('WA_CUT3')) props.setProperty('WA_CUT3', String(now.getTime()));
      var wa = fixWhatsappTimes_(ss, cfg, +props.getProperty('WA_CUT3'));
      if (wa !== null) {
        props.setProperty('WA_TZ3', '1');
        if (wa) { out.push(wa); props.setProperty('REBUILD', '1'); }
        ss.getSheetByName(T.SET).getRange('E17').setValue('WhatsApp times ' + Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ': ' + (wa || 'nothing to fix') + ' (' + WA_DIAG_ + ')');
      }
    }
    var n = importNewLeads_(ss, cfg, force, now);
    if (n) out.push(n);
    var cu = catchUp_(ss, cfg, now, props);                                       // ticks / picks the busy sheet could not finish
    if (cu) out.push(cu);
    if (force || now.getTime() - +(props.getProperty('UP_AT') || 0) >= (working ? 5 : 30) * 60000 - 30000) {
      props.setProperty('UP_AT', String(now.getTime()));
      var u = readUploads_(ss, cfg, now, force);
      if (u) out.push(u);
    }
    var repair = props.getProperty('REPAIR') === '1', tries = +(props.getProperty('REPAIR_TRY') || 0);   // once after the update to rev 4
    if (repair && tries >= 2) { repair = false; props.deleteProperty('REPAIR'); props.setProperty('REBUILD', '1'); }   // too slow twice: tabs only
    if ((repair || props.getProperty('REBUILD') === '1') && Date.now() - started < (repair ? 60000 : 120000)) {   // after an update of the script
      if (repair) props.setProperty('REPAIR_TRY', String(tries + 1));
      var sw = sweepAndRebuild_(ss, cfg, now, props.getProperty('LOOKS') === '1', repair);
      if (sw !== null) { props.deleteProperty('REPAIR'); props.deleteProperty('REBUILD'); props.deleteProperty('LOOKS'); out.push(sw); }
    }
    if (force || now.getTime() - +(props.getProperty('BOOK_AT') || 0) >= 5 * 60000 - 30000) {   // Booked leads: visits, no shows, moves
      props.setProperty('BOOK_AT', String(now.getTime()));
      var bk = bookedSweep_(ss, cfg, now);
      if (bk) out.push(bk);
    }
    if (working || force) promoteCallbacks_(ss, cfg, now);                       // a callback whose time came → top of Followup/Callback
    if (props.getProperty('TIDY') === '1') {                                   // rows waiting to move (one column read to see if any is due)
      var td = tidyState_(ss, now);
      if (!td.any) props.deleteProperty('TIDY');
      else if (td.due) {
        var lock = LockService.getDocumentLock();
        if (lock.tryLock(20000)) {
          try { tidyFollowups_(ss, cfg, now); props.deleteProperty('TIDY'); if (pendingTidy_(ss)) props.setProperty('TIDY', '1'); } finally { lock.releaseLock(); }
        }
      }
    }
    var day = Utilities.formatDate(now, TZ, 'yyyyMMdd');
    if (props.getProperty('DAILY') !== day && mins >= 6 * 60) { out.push(dailyRun_(ss, cfg, now)); props.setProperty('DAILY', day); props.setProperty('REPORT_HOUR', Utilities.formatDate(now, TZ, 'yyyyMMddHH')); }
    var hour = Utilities.formatDate(now, TZ, 'yyyyMMddHH');
    if (props.getProperty('REPORT_HOUR') !== hour && (working || force)) { refreshReports_(ss, cfg); props.setProperty('REPORT_HOUR', hour); }
    return out.join(' · ');
  } finally {
    run.releaseLock();
  }
}

/**
 * Every minute: what an agent did while the sheet was busy is finished here — a Live leads row ticked ✔ but still there moves
 * by its comment (or is unticked if it must stay: WhatsApp not Yes, booked date missing); picks on other tabs are saved.
 */
function catchUp_(ss, cfg, now, props) {
  var missed = WORK_TABS.concat([T.OLD]).filter(function (t) { return props.getProperty('MISSED_' + t) === '1'; });
  var live = ss.getSheetByName(T.LIVE), last = live.getLastRow();
  var anyTick = last >= FIRST && live.getRange(FIRST, W.TICK, last - FIRST + 1, 1).getValues().some(function (x) { return x[0] === true; });
  if (!missed.length && !anyTick) return '';
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) return '';
  try {
    var out = [];
    missed.forEach(function (t) {
      props.deleteProperty('MISSED_' + t);
      if (t === T.LIVE) return;
      var k = syncTab_(ss, cfg, t, now);
      if (k) out.push(k + ' ' + t + ' rows saved');
    });
    if (missed.indexOf(T.FU) >= 0) props.setProperty('TIDY', '1');
    if (missed.indexOf(T.BOOK) >= 0) props.setProperty('BOOK_AT', '0');
    last = live.getLastRow();
    if (last < FIRST) return out.join(' · ');
    syncTab_(ss, cfg, T.LIVE, now);
    var vals = live.getRange(FIRST, 1, last - FIRST + 1, WN).getValues(), data = leadsAll_(ss), moved = 0, held = 0;
    for (var k = vals.length - 1; k >= 0; k--) {                                   // bottom up: the rows above keep their place
      if (vals[k][W.TICK - 1] !== true) continue;
      var i = data.byId[clean_(vals[k][W.ID - 1])];
      if (i === undefined) continue;
      var r = data.rows[i], lr = i + 2;
      if (r[L.TAB - 1] !== T.LIVE) continue;
      var go = liveRoute_(r, cfg);
      if (!go.to) { live.getRange(FIRST + k, W.TICK).setValue(false); held++; continue; }
      if (go.to === T.BOOK) toBooked_(ss, cfg, data.sh, lr, r, { row: FIRST + k, now: now });
      else moveLead_(ss, cfg, data.sh, lr, r, go.to, { row: FIRST + k, now: now });
      moved++;
    }
    if (moved || held) out.push('Live leads: ' + moved + ' ticked rows moved' + (held ? ', ' + held + ' unticked (WhatsApp not Yes / no booked date)' : ''));
    return out.join(' · ');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Booked leads (every 5 minutes and right after a Vetbuddy upload): the visit from Vetbuddy, No show once the booked day
 * passed (→ retries every followup gap), visited → Visited customers after 1 day, 5 unanswered retries → Old leads, another
 * comment → Old leads after 2 days. The tab is written again in order when anything changed.
 */
function bookedSweep_(ss, cfg, now) {
  var sh = ss.getSheetByName(T.BOOK);
  if (!sh) return '';
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return '';
  try {
    syncTab_(ss, cfg, T.BOOK, now);
    var data = leadsAll_(ss), vis = visitsMap_(ss), n = { visc: 0, old: 0, upd: 0 }, keep = [];
    data.rows.forEach(function (r, i) {
      if (r[L.TAB - 1] !== T.BOOK || !r[L.ID - 1]) return;
      var lr = i + 2, v = vis[clean_(r[L.PHONE - 1])];
      var before = [r[L.STATE - 1], time_(r[L.NEXT - 1]), time_(r[L.TIDY - 1]), time_(r[L.VISIT - 1])].join('|');
      if (v && (!asDate_(r[L.VISIT - 1]) || v > r[L.VISIT - 1])) r[L.VISIT - 1] = v;
      if (refreshBookRound_(r)) before += '|fixed';
      computeLead_(r, cfg, now);
      bookedTimers_(r, now);
      var st = r[L.STATE - 1], due = asDate_(r[L.TIDY - 1]);
      if (st === 'leaving' || (st === 'closing' && due && due <= now)) { moveLead_(ss, cfg, data.sh, lr, r, T.OLD, { now: now, quiet: true }); n.old++; return; }
      if (st === 'visited' && due && due <= now) { moveLead_(ss, cfg, data.sh, lr, r, T.VISC, { now: now }); n.visc++; return; }
      keep.push(i);
      if ([st, time_(r[L.NEXT - 1]), time_(r[L.TIDY - 1]), time_(r[L.VISIT - 1])].join('|') !== before) { writeLead_(data.sh, lr, r); n.upd++; }
    });
    var shown = sh.getLastRow() >= FIRST ? sh.getRange(FIRST, W.ID, sh.getLastRow() - FIRST + 1, 1).getValues().filter(function (x) { return clean_(x[0]); }).length : 0;
    if (n.upd || n.visc || n.old || shown !== keep.length) {
      keep.sort(bookCmp_(data.rows));
      writeTab_(ss, sh, keep.map(function (i) { return workCells_(data.rows[i], i + 2, T.BOOK); }));
    }
    return n.upd || n.visc || n.old ? 'Booked leads: ' + n.visc + ' → Visited customers, ' + n.old + ' → Old leads, ' + n.upd + ' updated' : '';
  } finally {
    lock.releaseLock();
  }
}

/** Every minute in working hours, every 5 minutes at night: the run switches its own timer when the time comes. */
function pace_(props, working) {
  var want = working ? '1' : '5';
  if (props.getProperty('PACE') === want) return;
  try {
    var old = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'everyMinute'; });
    if (!old.length) return;                                                       // automatic updates were turned off
    ScriptApp.newTrigger('everyMinute').timeBased().everyMinutes(+want).create();
    old.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    props.setProperty('PACE', want);
  } catch (err) { console.error(err); }
}

/** Rows marked to move: any at all, and any whose time has come. */
function tidyState_(ss, now) {
  var sh = ss.getSheetByName(T.LEADS), last = sh.getLastRow(), out = { any: false, due: false };
  if (last < 2) return out;
  var tabs = sh.getRange(2, L.TAB, last - 1, 1).getValues();
  sh.getRange(2, L.TIDY, last - 1, 1).getValues().forEach(function (x, i) {
    var d = asDate_(x[0]);
    if (d && tabs[i][0] === T.FU) { out.any = true; if (d <= now) out.due = true; }
  });
  return out;
}
/** Is any Followup/Callback row still waiting to go down? */
function pendingTidy_(ss) {
  var sh = ss.getSheetByName(T.LEADS), last = sh.getLastRow();
  if (last < 2) return false;
  var tabs = sh.getRange(2, L.TAB, last - 1, 1).getValues();
  return sh.getRange(2, L.TIDY, last - 1, 1).getValues().some(function (x, i) { return asDate_(x[0]) && tabs[i][0] === T.FU; });
}

/**
 * Every morning (first run after 6 am): a lead a week on Followup/Callback goes to Old leads only when it is finished
 * (all 5 followups made, booked, done) — a followup or callback still to make stays there however many days pass; a lead
 * a week on Live leads that nobody ticked goes where its comment says (not called → Old leads). Then every tab is written
 * fresh and the summaries brought up to date.
 */
function dailyRun_(ss, cfg, now) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) return 'morning tidy-up: busy';
  try {
    CALL_TABS.forEach(function (t) { if (ss.getSheetByName(t)) syncTab_(ss, cfg, t, now); });
    var data = leadsAll_(ss), cut = now.getTime() - cfg.days * DAY_MS, n = { fu: 0, live: 0 };
    data.rows.forEach(function (r) {
      if (!r[L.ID - 1]) return;
      var tab = r[L.TAB - 1];
      computeLead_(r, cfg, now);
      var start = Math.max(time_(r[L.DATE - 1]), time_(parseLeadTime_(r[L.ROUND - 1])));
      if (start >= cut) return;
      if (tab === T.FU) {
        if (isWaiting_(r[L.STATE - 1])) return;                                   // a followup / callback not finished stays, however old
        r[L.TAB - 1] = T.OLD; n.fu++;
      } else if (tab === T.LIVE) {
        var l2 = latest_(r);
        r[L.TAB - 1] = l2 && tabFor_(l2.res, cfg) === T.JUNK ? T.JUNK : T.OLD; n.live++;
      } else return;
      r[L.FROM - 1] = ''; r[L.MOVED - 1] = now; r[L.TIDY - 1] = '';
      computeLead_(r, cfg, now);
    });
    n.junk = junkSweep_(data.rows, now);
    if (data.rows.length) data.sh.getRange(2, 1, data.rows.length, NL).setValues(data.rows);
    rebuildTabs_(ss, cfg, now);
    refreshReports_(ss, cfg);
    var msg = Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ': ' + n.fu + ' from Followup/Callback and ' + n.live + ' from Live leads moved to Old leads (a week old)' +
      (n.junk ? ', ' + n.junk + ' to Junk leads (Notes: wrongly filled / out of station)' : '') + '; all tabs written fresh';
    ss.getSheetByName(T.SET).getRange(SC.DAILY).setValue(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** OWNER (menu). */
function readUploadsNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSetup_(ss, true);
  var msg = readUploads_(ss, readCfg_(ss), new Date(), true) || 'No new files in the folders.';
  ss.toast(msg, 'SM Calling', 12);
  return msg;
}
/** OWNER (menu). */
function rebuildAllNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSetup_(ss, true);
  var msg = sweepAndRebuild_(ss, readCfg_(ss), new Date(), true) || 'Busy — try again in a minute.';
  ss.toast(msg, 'SM Calling', 8);
  return msg;
}

/**
 * Saves what the tabs show, moves leads whose Notes say “wrongly filled” / “out of station” to Junk leads (for good — a new
 * lead nobody has called yet is called first), and writes every calling tab fresh from the Leads record.
 */
function sweepAndRebuild_(ss, cfg, now, looks, repair) {
  var crm = null;
  if (repair && cfg.crmId) { var found = crmAll_(cfg); crm = { found: found, idx: crmIndex_(cfg, found) }; }   // read before the lock
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) return null;
  try {
    CALL_TABS.forEach(function (t) { if (ss.getSheetByName(t)) syncTab_(ss, cfg, t, now); });
    var fixedMsg = crm ? repairLeads_(ss, cfg, now, crm) : '';
    if (looks) CALL_TABS.forEach(function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh) return;
      rowFormats_(sh, n, FIRST, sh.getMaxRows() - FIRST + 1, cfg);
      applyColours_(ss, sh, cfg);
      if (n === T.OLD) oldTopLine_(sh); else topLine_(sh, n, cfg);
    });
    var data = leadsAll_(ss), junk = junkSweep_(data.rows, now), camps = '';
    try { camps = fillBlankCampaigns_(cfg, data.rows, crm && crm.idx); } catch (err) { camps = ''; }   // needs the owner's access to the CRM
    if (junk || camps) data.sh.getRange(2, 1, data.rows.length, NL).setValues(data.rows);
    rebuildTabs_(ss, cfg, now);
    refreshReports_(ss, cfg);
    var msg = Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ': all tabs written fresh' + (junk ? '; ' + junk + ' leads moved to Junk leads (Notes: wrongly filled / out of station)' : '') +
      (camps ? '; ' + camps : '') + (fixedMsg ? '; ' + fixedMsg.replace(/^[^:]*: /, '') : '');
    ss.getSheetByName(T.SET).getRange(SC.DAILY).setValue(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** Leads whose Notes say “wrongly filled” / “out of station” → Junk leads (not a new lead nobody has called yet). */
function junkSweep_(rows, now) {
  var n = 0;
  rows.forEach(function (r) {
    var tab = r[L.TAB - 1];
    if (!r[L.ID - 1] || tab === T.JUNK || tab === T.BOOK || tab === T.VISC || (tab === T.LIVE && !latest_(r)) || !junkNote_(r[L.NOTES - 1])) return;
    r[L.TAB - 1] = T.JUNK; r[L.FROM - 1] = ''; r[L.MOVED - 1] = now; r[L.TIDY - 1] = '';
    n++;
  });
  return n;
}

/** Settings changed by the owner: hours / gap / days / comments → the tabs follow. */
function settingsEdited_(ss, sh, rng) {
  var r = rng.getRow();
  if (!((r >= 7 && r <= 12) || r === 15 || r >= SC.COM_ROW)) return;
  rebuildAllNow();
}

/* ========================================================================= */
/*  Files the MIS Upload Hub saved (Smartflo call log, Vetbuddy, old Excel)  */
/* ========================================================================= */

/**
 * Looks in the call-log folder (Calling MIS) and the upload folder for CSV files not read yet, and uses each one:
 * a Smartflo call log → Smartflo calls (calls to our leads), a Vetbuddy export → Visits + Last visit, the old comments
 * Excel → leads, an old Meta lead-form download → Old leads. Every file read is listed on the hidden “Uploads read” tab.
 */
function readUploads_(ss, cfg, now, force) {
  var props = PropertiesService.getDocumentProperties(), up = ss.getSheetByName(T.UP);
  var since = +(props.getProperty('UP_SINCE') || 0) || (now.getTime() - 30 * DAY_MS);
  var q = 'modifiedDate > "' + new Date(since - 2 * DAY_MS).toISOString().slice(0, 19) + '"';
  var last = up.getLastRow(), seen = {};
  if (last >= 2) up.getRange(2, 6, last - 1, 1).getValues().forEach(function (x) { if (x[0]) seen[x[0]] = 1; });
  var started = Date.now(), done = [], log = [];
  [[cfg.callFolder, 'call log folder'], [cfg.upFolder, 'upload folder']].forEach(function (f) {
    if (!f[0]) return;
    var folder;
    try { folder = DriveApp.getFolderById(f[0]); } catch (err) { done.push('⚠ cannot open the ' + f[1] + ' (Settings → C' + (f[1] === 'call log folder' ? 13 : 14) + ')'); return; }
    var it = folder.searchFiles(q), files = [];
    while (it.hasNext()) { var file = it.next(); if (!seen[file.getId()] && !/^UNDONE_/.test(file.getName())) files.push(file); }
    files.sort(function (a, b) { return a.getLastUpdated() - b.getLastUpdated(); });
    files.forEach(function (file) {
      if (Date.now() - started > 240000) return;                                       // the rest next time
      var name = file.getName(), what = '', res = '';
      if (!/\.csv$/i.test(name) && !/csv|text/i.test(String(file.getMimeType()))) { what = 'not a CSV'; }
      else {
        try {
          var rows = Utilities.parseCsv(file.getBlob().getDataAsString());
          var kind = kindOf_(rows);
          if (kind === 'smartflo') { what = 'Smartflo call log'; res = loadSmartflo_(ss, cfg, rows); }
          else if (kind === 'vetbuddy') { what = 'Vetbuddy export'; res = loadVetbuddy_(ss, cfg, rows); props.setProperty('BOOK_AT', '0'); }
          else if (kind === 'excel') { what = 'old comments Excel'; res = importExcelTables_(ss, cfg, [{ name: name, rows: rows }], now) || 'no ' + cfg.city + ' rows'; }
          else if (kind === 'metaleads') { what = 'old Meta leads file'; res = loadMetaLeads_(ss, cfg, rows, name, now); }
          else what = 'not used here';
          if (res === null || /busy, will try again/.test(res)) return;                    // read it again next time
        } catch (err) { what = what || 'could not read'; res = String(err && err.message ? err.message : err); }
      }
      log.push([now, name, f[1], what, res, file.getId()]);
      if (res) done.push(what + ': ' + res);
    });
  });
  if (log.length) {
    var r = Math.max(up.getLastRow(), 1) + 1;
    ensureRows_(up, r + log.length);
    up.getRange(r, 1, log.length, 6).setValues(log);
  }
  if (Date.now() - started <= 240000) props.setProperty('UP_SINCE', String(now.getTime()));
  if (done.length) ss.getSheetByName(T.SET).getRange(SC.LASTUP).setValue(Utilities.formatDate(now, TZ, 'dd-MMM HH:mm') + ' — ' + done.join(' · '));
  return done.join(' · ');
}

/** Which report a CSV is, from its header row. */
function kindOf_(rows) {
  for (var i = 0; i < Math.min(30, rows.length); i++) {
    var H = (rows[i] || []).map(function (x) { return clean_(x).toLowerCase(); });
    if (H.indexOf('customer number') >= 0 && H.indexOf('call status') >= 0) return 'smartflo';
    if (H.indexOf('primary phone') >= 0 && H.indexOf('date') >= 0) return 'vetbuddy';
    if (i < 5 && H.some(function (x) { return /phone/.test(x); }) && H.some(function (x) { return /^comment|rnr/.test(x); })) return 'excel';
    if (i < 5 && H.some(function (x) { return /phone/.test(x); }) && H.some(function (x) { return /^created[ _]time$/.test(x); })) return 'metaleads';
  }
  return '';
}

/** Smartflo call log → the outgoing calls to this file's leads (one line per call, never twice). */
function loadSmartflo_(ss, cfg, rows) {
  var hr = -1, H = [];
  for (var i = 0; i < Math.min(30, rows.length) && hr < 0; i++) {
    H = (rows[i] || []).map(function (x) { return clean_(x).toLowerCase(); });
    if (H.indexOf('customer number') >= 0 && H.indexOf('call status') >= 0) hr = i;
  }
  if (hr < 0) return 'no Customer number / Call status columns';
  var ix = function (n) { return H.indexOf(n); };
  var iStart = ix('start time'), iDate = ix('call date'), iType = ix('call type'), iNum = ix('customer number'), iAgent = ix('agent name');
  var iStatus = ix('call status'), iTalk = ix('talk time');
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) throw new Error('busy');
  try {
    var leads = ss.getSheetByName(T.LEADS), lastL = leads.getLastRow(), ours = {};
    if (lastL >= 2) leads.getRange(2, L.PHONE, lastL - 1, 1).getValues().forEach(function (x) { if (clean_(x[0])) ours[clean_(x[0])] = 1; });
    var sf = ss.getSheetByName(T.SF), last = sf.getLastRow(), keys = {};
    if (last >= 2) sf.getRange(2, 7, last - 1, 1).getValues().forEach(function (x) { keys[x[0]] = 1; });
    var add = [], read = 0;
    for (var r = hr + 1; r < rows.length; r++) {
      var row = rows[r];
      read++;
      if (iType >= 0 && !/out/i.test(clean_(row[iType]))) continue;
      var ph = normPhone_(row[iNum]);
      if (!ph.phone || !ours[ph.phone]) continue;
      var t = parseLeadTime_(iStart >= 0 && clean_(row[iStart]) ? (/^\d{1,2}:\d{2}/.test(clean_(row[iStart])) && iDate >= 0 ? clean_(row[iDate]) + ' ' + clean_(row[iStart]) : row[iStart]) : row[iDate]);
      if (!t) continue;
      var key = ph.phone + '|' + Utilities.formatDate(t, TZ, 'yyMMddHHmmss');
      if (keys[key]) continue;
      keys[key] = 1;
      var status = clean_(row[iStatus]);
      add.push([ph.phone, t, status, /^answered/i.test(status) ? 'Yes' : 'No', num_(row[iTalk]), clean_(row[iAgent]), key]);
    }
    if (add.length) {
      var at = Math.max(last, 1) + 1;
      ensureRows_(sf, at + add.length);
      sf.getRange(at, 1, add.length, 1).setNumberFormat('@');
      sf.getRange(at, 1, add.length, 7).setValues(add);
    }
    return add.length + ' calls to ' + cfg.city + ' leads (of ' + read + ' lines)';
  } finally {
    lock.releaseLock();
  }
}

/** Vetbuddy “Sales by plan item” export → each number's last visit; Old leads' Last visit brought up to date. */
function loadVetbuddy_(ss, cfg, rows) {
  var hr = -1, H = [];
  for (var i = 0; i < Math.min(30, rows.length) && hr < 0; i++) {
    H = (rows[i] || []).map(function (x) { return clean_(x).toLowerCase(); });
    if (H.indexOf('primary phone') >= 0 && H.indexOf('date') >= 0) hr = i;
  }
  if (hr < 0) return 'no Date / Primary Phone columns';
  var ix = function (n) { return H.indexOf(n); };
  var iDate = ix('date'), iPhone = ix('primary phone'), iClient = ix('client');
  var iClinic = ix('performed/carted clinic') >= 0 ? ix('performed/carted clinic') : ix('billed clinic');
  var up = {}, lines = 0;
  for (var r = hr + 1; r < rows.length; r++) {
    var row = rows[r], d = vbDate_(row[iDate]), ph = normPhone_(row[iPhone]);
    if (!d || !ph.ok) continue;
    lines++;
    var u = up[ph.phone];
    if (!u || d > u.d) up[ph.phone] = { d: d, clinic: clinicName_(iClinic >= 0 ? row[iClinic] : ''), client: iClient >= 0 ? clean_(row[iClient]) : '' };
  }
  if (!lines) return 'no bill lines with a phone number';
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(60000)) throw new Error('busy');
  try {
    var vs = ss.getSheetByName(T.VIS), last = vs.getLastRow();
    var cur = last >= 2 ? vs.getRange(2, 1, last - 1, 4).getValues() : [], at = {}, newer = 0;
    cur.forEach(function (x, k) { at[clean_(x[0])] = k; });
    Object.keys(up).forEach(function (ph) {
      var u = up[ph], k = at[ph];
      if (k === undefined) { cur.push([ph, u.d, u.clinic, u.client]); at[ph] = cur.length - 1; newer++; }
      else if (!asDate_(cur[k][1]) || u.d > cur[k][1]) { cur[k] = [ph, u.d, u.clinic, u.client || cur[k][3]]; newer++; }
    });
    if (cur.length) {
      ensureRows_(vs, cur.length + 2);
      vs.getRange(2, 1, cur.length, 1).setNumberFormat('@');
      vs.getRange(2, 1, cur.length, 4).setValues(cur);
    }
    // every lead's Last visit
    var data = leadsAll_(ss), changed = 0;
    data.rows.forEach(function (x) {
      var k = at[clean_(x[L.PHONE - 1])];
      if (k === undefined) return;
      var d = asDate_(cur[k][1]);
      if (d && time_(x[L.VISIT - 1]) !== d.getTime()) { x[L.VISIT - 1] = d; changed++; }
    });
    if (changed) data.sh.getRange(2, L.VISIT, data.rows.length, 1).setValues(data.rows.map(function (x) { return [x[L.VISIT - 1]]; }));
    refreshOldVisits_(ss);
    return lines + ' bill lines, ' + Object.keys(up).length + ' numbers (' + newer + ' newer visits) · ' + changed + ' leads got a visit date';
  } finally {
    lock.releaseLock();
  }
}

function clinicName_(s) { var t = clean_(s).replace(/\(.*$/, '').replace(/^.*?hospital\s*[-–]\s*/i, '').trim(); return t || clean_(s); }
/** A Vetbuddy date: a date, '2026-11-07 14:29:00' (from the hub), an Excel day number, 07-11-2026, Nov 07, 2026. */
function vbDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  var s = clean_(v);
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) { var n = +s; if (n > 30000 && n < 80000) return new Date(Math.round((n - 25569) * DAY_MS) - 330 * 60000); }
  var d = parseLeadTime_(s);
  if (d) return d;
  var m = s.match(/^([A-Za-z]{3})[a-z]*[ ,]+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    var mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
    if (mon >= 0) return new Date(Date.UTC(+m[3], mon, +m[2]) - 330 * 60000);
  }
  return null;
}

/* ========================================================================= */
/*  Summary and Lead quality                                                 */
/* ========================================================================= */
/*
 * Worked out by the script from the Leads record, the Call Log and the Smartflo call log (no heavy formulas).
 * They update when the month is changed or ↻ is ticked, every hour in working hours and every morning.
 * Counts go by LEAD DATE: a lead that came in on 05-Nov is counted on 05-Nov.
 */

var RP = { MONTH: 'C2', UPDATE: 'F2', INFO: 'H2', HEAD: 4, TOTAL: 5, FIRST: 6 };
var SUM_HEADERS = ['Date', 'No. of new leads received', 'Leads within 6.00 PM', 'Same day calls', 'Callback done within 5 mins', 'Next day calls', 'Calls connected', 'Booked', 'Connected %', 'Booked %', 'Visited', 'Visited %'];
/** The headers, with the minutes of Settings → C11 (new lead turns red after …). */
function sumHeaders_(cfg) { var h = SUM_HEADERS.slice(); h[4] = 'Callback done within ' + cfg.redNew + ' mins'; return h; }
var SUM_NOTE = 'By lead date. Leads within 6.00 PM = leads that came in that day before 6:00 PM. Same day / Next day calls = leads first called on the day they came / the day after (this sheet or the Smartflo call log). ' +
  'Callback done within 5 mins = leads called within 5 minutes of coming in (the minutes of Settings → C11; old-Excel calls have no time and leads typed in by hand have no real arrival time, so they are not counted here). ' +
  'Calls connected = leads reached on any call. Connected % = connected ÷ leads called. Booked % = booked ÷ new leads. ' +
  'Visited = booked leads with a Vetbuddy bill on/after the day they were booked. Visited % = visited ÷ booked.';
var QUAL_NOTE = 'Each lead counted once, by its latest comment. Potential = comments that go to Followup/Callback (Callback, RNR, Hang up, Voicemail, ' +
  'Booked, Inform later). Junk = Out of station, No pet, Hindi person, Other. % of the leads called.';

function reportShell_(sh, title, note) {
  ensureCols_(sh, 20);
  sh.getRange('A1').setValue(title).setFontFamily(FONT).setFontSize(15).setFontWeight('bold').setFontColor(COL.navy);
  sh.getRange('B2').setValue('Month ▸').setFontFamily(FONT).setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange(RP.MONTH).setBackground(COL.input).setFontColor('#0000ff').setFontWeight('bold').setFontFamily(FONT);
  sh.getRange('E2').setValue('↻ Update').setFontFamily(FONT).setHorizontalAlignment('right');
  sh.getRange(RP.UPDATE).insertCheckboxes();
  sh.getRange(RP.INFO).setFontFamily(FONT).setFontColor(COL.grey).setFontSize(9);
  sh.getRange('A3').setValue(note).setFontFamily(FONT).setFontSize(9).setFontColor(COL.grey);
  sh.setFrozenRows(RP.TOTAL);
}

function buildSummary_(sh) {
  sh.setTabColor('#674ea7');
  reportShell_(sh, '📊 Summary', SUM_NOTE);
  widths_(sh, [110, 120, 110, 100, 120, 100, 110, 80, 100, 90, 80, 90]);
  sh.getRange(RP.HEAD, 1, 1, SUM_HEADERS.length).setValues([SUM_HEADERS]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
    .setBackground(COL.head).setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(RP.HEAD, 34);
}

function buildQuality_(sh, cfg) {
  sh.setTabColor('#674ea7');
  reportShell_(sh, '🎯 Lead quality', QUAL_NOTE);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 300);
}

function reportEdited_(ss, sh, rng) {
  var a1 = rng.getA1Notation();
  if (a1 !== RP.MONTH && a1 !== RP.UPDATE) return;
  var cfg = readCfg_(ss);
  if (sh.getName() === T.SUM) summary_(ss, cfg, reportData_(ss, cfg)); else quality_(ss, cfg, reportData_(ss, cfg));
  sh.getRange(RP.UPDATE).setValue(false);
}

function refreshReports_(ss, cfg) {
  var d = reportData_(ss, cfg);
  summary_(ss, cfg, d);
  quality_(ss, cfg, d);
}

/** Per lead: lead day, first call, reached, booked, campaign, latest comment. */
function reportData_(ss, cfg) {
  var data = leadsAll_(ss), calls = {};
  var log = ss.getSheetByName(T.LOG), lastLog = log.getLastRow();
  if (lastLog >= 2) log.getRange(2, 1, lastLog - 1, 7).getValues().forEach(function (x) {
    var t = asDate_(x[0]), id = x[1];
    if (!t || !id) return;
    var c = calls[id] = calls[id] || { first: null, conn: false, booked: false, timed: [], bookedAt: null };
    if (!c.first || t < c.first) c.first = t;
    if (x[6] !== 'Old Excel') c.timed.push(t.getTime());                    // calls with a real time (not the old Excel's day only)
    if (x[4] === 'Yes') c.conn = true;
    if (isBookedRes_(clean_(x[3]), cfg)) { c.booked = true; if (!c.bookedAt || t < c.bookedAt) c.bookedAt = t; }
  });
  var sfc = {}, sfMax = null, sf = ss.getSheetByName(T.SF), lastSf = sf.getLastRow();
  if (lastSf >= 2) sf.getRange(2, 1, lastSf - 1, 4).getValues().forEach(function (x) {
    var t = asDate_(x[1]);
    if (!t) return;
    (sfc[clean_(x[0])] = sfc[clean_(x[0])] || []).push({ t: t, conn: x[3] === 'Yes' });
    if (!sfMax || t > sfMax) sfMax = t;
  });
  var out = [], months = {};
  data.rows.forEach(function (r) {
    var d = asDate_(r[L.DATE - 1]);
    if (!r[L.ID - 1] || !d) return;
    var c = calls[r[L.ID - 1]] || { first: null, conn: false, booked: false, timed: [], bookedAt: null }, first = c.first, conn = c.conn, booked = c.booked, bookedAt = c.bookedAt;
    // a lead typed in by hand has the typing time as its lead time — it cannot tell how fast it was called
    var lt0 = d.getTime(), fastTo = lt0 + cfg.redNew * 60000, hand = /^hand:/.test(r[L.ID - 1]);
    var fast = !hand && c.timed.some(function (t) { return t >= lt0 - 60000 && t <= fastTo; });
    for (var k = 0; k <= BOXES; k++) {
      var v = boxVal_(r, k), t = boxTime_(r, k);
      if (!v) continue;
      if (t && (!first || t < first)) first = t;
      if (ruleOf_(v, cfg).conn) conn = true;
      if (isBookedRes_(v, cfg)) { booked = true; if (t && (!bookedAt || t < bookedAt)) bookedAt = t; }
    }
    if (clean_(r[L.OLDRES - 1]) && isBookedRes_(clean_(r[L.OLDRES - 1]), cfg)) { booked = true; if (!bookedAt) bookedAt = asDate_(r[L.OLDTIME - 1]); }
    var vd = asDate_(r[L.VISIT - 1]);
    var visited = booked && (r[L.TAB - 1] === T.VISC || r[L.STATE - 1] === 'visited' || !!(vd && bookedAt && dayOnly_(vd) >= dayOnly_(bookedAt)));
    (sfc[clean_(r[L.PHONE - 1])] || []).forEach(function (s) {
      if (s.t.getTime() < d.getTime() - 5 * 60000) return;
      if (!first || s.t < first) first = s.t;
      if (s.conn) conn = true;
      if (!hand && s.t.getTime() <= fastTo) fast = true;
    });
    var la = latestAll_(r), mk = Utilities.formatDate(d, TZ, 'yyyy-MM');
    months[mk] = 1;
    var hm = +Utilities.formatDate(d, TZ, 'H') * 60 + +Utilities.formatDate(d, TZ, 'm');
    out.push({ day: dayOnly_(d), early: hm < 18 * 60, month: mk, first: first, fast: fast, conn: conn, booked: booked, visited: visited, camp: clean_(r[L.CAMP - 1]) || '(number not in the CRM)', latest: la ? la.res : '' });
  });
  return { leads: out, months: Object.keys(months).sort().reverse(), sfMax: sfMax };
}

/** Month dropdown: “All months”, then the months that have leads (newest first). → the month picked ('' = all). */
function monthPick_(sh, months) {
  var label = function (k) { var p = k.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + p[0]; };
  var opts = ['All months'].concat(months.map(label));
  var cell = sh.getRange(RP.MONTH), cur = clean_(cell.getValue());
  cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(opts, true).setAllowInvalid(false).build());
  if (opts.indexOf(cur) < 0) { cur = months.length ? label(months[0]) : 'All months'; cell.setValue(cur); }
  for (var i = 0; i < months.length; i++) if (label(months[i]) === cur) return months[i];
  return '';
}

function pct_(a, b) { return b ? Math.round(a / b * 1000) / 10 + '%' : '—'; }

function summary_(ss, cfg, D) {
  var sh = ss.getSheetByName(T.SUM), month = monthPick_(sh, D.months), by = {};
  sh.getRange('A1').setValue('📊 Summary — ' + (cfg.city || ''));
  D.leads.forEach(function (x) {
    if (month && x.month !== month) return;
    var k = x.day.getTime(), o = by[k] = by[k] || { n: 0, early: 0, same: 0, fast: 0, next: 0, called: 0, conn: 0, booked: 0, visited: 0 };
    o.n++;
    if (x.early) o.early++;
    if (x.fast) o.fast++;
    if (x.first) {
      o.called++;
      var fd = dayOnly_(x.first).getTime();
      if (fd === k) o.same++;
      else if (fd === k + DAY_MS || (fd > k && fd <= k + 26 * 3600000)) o.next++;
    }
    if (x.conn) o.conn++;
    if (x.booked) o.booked++;
    if (x.visited) o.visited++;
  });
  var days = Object.keys(by).map(Number).sort(function (a, b) { return b - a; });
  var t = { n: 0, early: 0, same: 0, fast: 0, next: 0, called: 0, conn: 0, booked: 0, visited: 0 };
  var rows = days.map(function (k) {
    var o = by[k];
    Object.keys(t).forEach(function (f) { t[f] += o[f]; });
    return [new Date(k), o.n, o.early, o.same, o.fast, o.next, o.conn, o.booked, pct_(o.conn, o.called), pct_(o.booked, o.n), o.visited, pct_(o.visited, o.booked)];
  });
  var total = ['TOTAL', t.n, t.early, t.same, t.fast, t.next, t.conn, t.booked, pct_(t.conn, t.called), pct_(t.booked, t.n), t.visited, pct_(t.visited, t.booked)];
  var heads = sumHeaders_(cfg);
  if (sh.getRange(RP.HEAD, 1, 1, heads.length).getValues()[0].join('|') !== heads.join('|')) {                     // a sheet made before this column: headers + widths again
    ensureCols_(sh, heads.length);
    sh.getRange(RP.HEAD, 1, 1, heads.length).setValues([heads]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
      .setBackground(COL.head).setWrap(true).setVerticalAlignment('middle');
    widths_(sh, [110, 120, 110, 100, 120, 100, 110, 80, 100, 90, 80, 90]);
    sh.getRange('A3').setValue(SUM_NOTE.replace(/within 5 mins = leads called within 5 minutes/, 'within ' + cfg.redNew + ' mins = leads called within ' + cfg.redNew + ' minutes'));
  }
  writeReport_(sh, heads.length, total, rows);
  sh.getRange(RP.TOTAL, 2, rows.length + 1, 7).setNumberFormat('0');                // counts (a column that moved keeps no old % format)
  sh.getRange(RP.TOTAL, 11, rows.length + 1, 1).setNumberFormat('0');
  sh.getRange(RP.FIRST, 1, Math.max(rows.length, 1), 1).setNumberFormat('dd-mmm-yy (ddd)');
  sh.getRange(RP.INFO).setValue('Updated ' + Utilities.formatDate(new Date(), TZ, 'dd-MMM HH:mm') + '   ·   Smartflo call log up to: ' +
    (D.sfMax ? Utilities.formatDate(D.sfMax, TZ, 'dd-MMM HH:mm') : 'not uploaded yet'));
}

function quality_(ss, cfg, D) {
  var sh = ss.getSheetByName(T.QUAL), month = monthPick_(sh, D.months);
  var coms = cfg.comments.map(function (c) { return c.name; }), by = {};
  sh.getRange('A1').setValue('🎯 Lead quality — ' + (cfg.city || ''));
  var heads = ['Campaign name', 'Total leads', 'Not called yet'].concat(coms).concat(['Potential leads %', 'Junk leads %']);
  D.leads.forEach(function (x) {
    if (month && x.month !== month) return;
    var o = by[x.camp] = by[x.camp] || { n: 0, none: 0, c: {} };
    o.n++;
    if (!x.latest) { o.none++; return; }
    o.c[x.latest] = (o.c[x.latest] || 0) + 1;
  });
  var isPot = function (c) { var t = ruleOf_(c, cfg).to; return t === 'fu' || t === 'book'; }, isJunk = function (c) { return ruleOf_(c, cfg).to === 'junk'; };
  var line = function (name, o) {
    var called = o.n - o.none, pot = 0, junk = 0;
    Object.keys(o.c).forEach(function (c) { if (isPot(c)) pot += o.c[c]; if (isJunk(c)) junk += o.c[c]; });
    return [name, o.n, o.none].concat(coms.map(function (c) { return o.c[c] || 0; })).concat([pct_(pot, called), pct_(junk, called)]);
  };
  var names = Object.keys(by).sort(function (a, b) { return by[b].n - by[a].n || (a < b ? -1 : 1); });
  var t = { n: 0, none: 0, c: {} };
  names.forEach(function (k) { var o = by[k]; t.n += o.n; t.none += o.none; Object.keys(o.c).forEach(function (c) { t.c[c] = (t.c[c] || 0) + o.c[c]; }); });
  ensureCols_(sh, heads.length);
  sh.getRange(RP.HEAD, 1, 1, sh.getMaxColumns()).clearContent();
  sh.getRange(RP.HEAD, 1, 1, heads.length).setValues([heads]).setFontFamily(FONT).setFontWeight('bold').setFontColor('#ffffff')
    .setBackground(COL.head).setWrap(true).setVerticalAlignment('middle').setHorizontalAlignment('center');
  sh.getRange(RP.HEAD, 4, 1, coms.length).setBackground('#45818e');
  sh.getRange(RP.HEAD, heads.length - 1, 1, 2).setBackground('#38761d');
  for (var c = 2; c <= heads.length; c++) sh.setColumnWidth(c, 84);
  sh.setRowHeight(RP.HEAD, 34);
  writeReport_(sh, heads.length, line('TOTAL', t), names.map(function (k) { return line(k, by[k]); }));
  sh.getRange(RP.INFO).setValue('Updated ' + Utilities.formatDate(new Date(), TZ, 'dd-MMM HH:mm'));
}

function writeReport_(sh, n, total, rows) {
  var last = sh.getLastRow();
  if (last >= RP.TOTAL) sh.getRange(RP.TOTAL, 1, last - RP.TOTAL + 1, sh.getMaxColumns()).clearContent().setBackground(null).setFontWeight('normal');
  ensureRows_(sh, RP.FIRST + rows.length + 1);
  sh.getRange(RP.TOTAL, 1, 1, n).setValues([total]).setFontWeight('bold').setBackground('#e8eef4');
  if (rows.length) sh.getRange(RP.FIRST, 1, rows.length, n).setValues(rows).setFontFamily(FONT);
  sh.getRange(RP.TOTAL, 2, rows.length + 1, n - 1).setHorizontalAlignment('center');
}