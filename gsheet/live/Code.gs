/** @OnlyCurrentDoc */
/* ===================================================================
   SANCHU DAILY SALES REPORT - Google Sheets + Apps Script
   Menu "Sales Report" (or the blue button on Summary):
     Upload & update report -> pick the Vetbuddy and Gofrugal files.
   Everything else is automatic. Runs as whoever clicks - no fixed
   owner account, no computer, no mailbox, no scheduled triggers.
   =================================================================== */

var SH = { SUMMARY: 'Summary', AOP: 'AOP', SETTINGS: 'Settings', EXC: 'Exceptions', DATA: 'Data', VOWD: 'VOW Doctors', UNDO: 'Undo Data', UNDOV: 'Undo VOW', HOW: 'How It Works', EST: 'Estimate Breakup',
           VOWI: 'VOW Vetbuddy Invoices', VOWB: 'VOW Gofrugal Bills', UNDOI: 'Undo VOW Invoices', UNDOB: 'Undo VOW Bills' };
var VOWI_HDR = ['Date', 'Invoice No', 'Billed Clinic', 'Clinic Unit', 'VOW Unit', 'Doctor', 'VOW Amount (Net Sales - Net Return)'];
var VOWB_HDR = ['Date', 'Type', 'Bill No', 'Outlet Name', 'Outlet Unit', 'VOW Unit', 'Doctor (as typed in Gofrugal)', 'Matched VOW Doctor (Vetbuddy)', 'Match', 'VOW Amount (before tax)'];
// These Vet on Wheels units are shown as two columns: Clinical (today's VOW sales) and Non Clinical.
// Non-clinical sales go to unit '<VOW unit> - NON CLINICAL': on a VOW invoice, every line matching a Non Clinical rule
// (Settings V:X, e.g. Plan category contains "Spa and Saloon") goes there; the other lines stay Clinical.
// To split another VOW unit later, add its name to the list.
var VOW_SPLIT = { units: ['CH VET ON WHEELS', 'CBE VET ON WHEELS'], nc: ' - NON CLINICAL', labels: ['Clinical', 'Non Clinical'] };
function isVowParent_(u) { return VOW_SPLIT.units.indexOf(u) >= 0; }
function vowSplitLabel_(u) { return isVowParent_(u) ? VOW_SPLIT.labels[0] : isVowParent_(String(u).replace(VOW_SPLIT.nc, '')) && / - NON CLINICAL$/.test(u) ? VOW_SPLIT.labels[1] : u; }
function vowSplitShown_(shown) {
  var out = [];
  shown.forEach(function (u) { if (/ - NON CLINICAL$/.test(u)) return; out.push(u); if (isVowParent_(u)) out.push(u + VOW_SPLIT.nc); });
  return out;
}
var IND_FMT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Sales Report')
    .addItem('Upload & update report', 'openUpload')
    .addItem('Refresh Summary', 'refreshSummary')
    .addItem('Previous month', 'prevMonth')
    .addItem('Next month', 'nextMonth')
    .addItem('Undo last upload', 'undoMenu')
    .addItem('Rebuild How It Works sheet', 'writeHowItWorks')
    .addItem('Re-apply Vet on Wheels split (after changing Settings)', 'reapplyVowMenu')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('SharePoint auto import')
      .addItem('Import from SharePoint now', 'spiImportNow')
      .addItem('Turn ON daily 9 AM import', 'spiInstall')
      .addItem('Turn OFF daily import', 'spiUninstall')
      .addItem('Status', 'spiStatus')
      .addItem('Set SharePoint login', 'spiSetCredentials')
      .addSeparator()
      .addItem('Send picture to Teams now', 'snapSendNow')
      .addItem('Set Teams posting address', 'snapSetWebhook')
      .addSeparator()
      .addItem('Send picture to WhatsApp now', 'waSendNow')
      .addItem('Set WhatsApp login', 'waSetLogin')
      .addItem('Choose WhatsApp group', 'waChooseGroup')
      .addSeparator()
      .addItem('Send numbers to Supabase (bot) now', 'botPushNow')
      .addItem('Set Supabase (bot) login', 'botSetLogin'))
    .addSeparator()
    .addItem('Setup / repair (first time only)', 'setup')
    .addToUi();
}

function onEdit(e) {
  try {
    var sh = e.range.getSheet(), name = sh.getName();
    var a1 = e.range.getA1Notation();
    if (name === SH.SUMMARY && a1 === 'B1') renderSummary_(labelToKey_(e.range.getValue()));
    else if (name === SH.SUMMARY && (a1 === 'A2' || a1 === 'C2') && e.range.getValue() === true) moveMonth_(a1 === 'A2' ? -1 : 1);
    else if (name === SH.AOP || name === SH.SETTINGS) renderSummary_(currentMonth_());
  } catch (err) {
    SpreadsheetApp.getActive().toast('Summary not refreshed: ' + err.message, 'Sales Report', 8);
  }
}

// ---------------- upload ----------------
// Web app: the team opens this link - no sign-in, no permission screen (runs as the owner account)
function doGet() {
  var t = HtmlService.createTemplateFromFile('Upload');
  t.coreSrc = CoreFactory.toString();
  t.isWeb = true;
  t.sheetUrl = SpreadsheetApp.getActive().getUrl();
  return t.evaluate().setTitle('Sanchu Daily Sales Report - Upload').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function openUpload() {
  var t = HtmlService.createTemplateFromFile('Upload');
  t.coreSrc = CoreFactory.toString();
  t.isWeb = false;
  t.sheetUrl = '';
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(600).setHeight(520), 'Upload Vetbuddy & Gofrugal reports');
}

// called from the upload window
function getContext(gfFrom, gfTo) {
  var ss = SpreadsheetApp.getActive();
  var vow = [];
  if (gfFrom) vow = readTable_(ss, SH.VOWD, 4).filter(function (r) { return +r[0] >= gfFrom && +r[0] <= gfTo; });
  return { settings: readSettings_(ss), vowDocs: vow };
}

// called from the upload window with the processed (small) result
function saveUpload(up) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(60000);
  try {
    var C = CoreFactory(), ss = SpreadsheetApp.getActive();
    var data = readTable_(ss, SH.DATA, 6);
    backup_(ss, data, up);
    writeTable_(ss, SH.DATA, ['Date (serial)', 'Unit', 'Vetbuddy', 'Gofrugal', 'Old history total', 'Gofrugal returns'], C.merge(data, up));
    if (up.vbRange) writeTable_(ss, SH.VOWD, ['Date (serial)', 'Unit', 'Doctor ID', 'Doctor name'], C.mergeVowDocs(readTable_(ss, SH.VOWD, 4), up));
    if (up.vbRange) writeVowList_(ss, SH.VOWI, VOWI_HDR, C.mergeVowVb(readVowList_(ss, SH.VOWI, VOWI_HDR.length), up));
    if (up.gfRange || up.gfrRange) writeVowList_(ss, SH.VOWB, VOWB_HDR, C.mergeVowGf(readVowList_(ss, SH.VOWB, VOWB_HDR.length), up));
    var last = Math.max(up.vbRange ? up.vbRange[1] : 0, up.gfRange ? up.gfRange[1] : 0, up.gfrRange ? up.gfrRange[1] : 0);
    var month = C.monthKey(last);
    writeExceptions_(ss, up);
    renderSummary_(month);
    var ok = up.checks.every(function (c) { return c[1] === 'OK'; });
    return { month: C.monthLabel(month), upto: C.fmtDate(last), ok: ok };
  } finally {
    lock.releaseLock();
  }
}

function refreshSummary() { renderSummary_(currentMonth_()); }

// ---------------- Previous / Next month buttons (tick boxes A2 / C2 on Summary, or the menu) ----------------
function prevMonth() { moveMonth_(-1); }
function nextMonth() { moveMonth_(1); }
function moveMonth_(k) {
  var C = CoreFactory(), ss = SpreadsheetApp.getActive();
  var lo = Infinity, hi = -Infinity;
  readTable_(ss, SH.DATA, 1).forEach(function (r) { var d = +r[0]; if (d < lo) lo = d; if (d > hi) hi = d; });
  if (!isFinite(lo)) { renderSummary_(null); return; }
  var first = C.monthKey(lo), last = C.monthKey(hi), today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM');
  var maxKey = C.shiftMonth(last > today ? last : today, 1);          // up to the month after the latest data / this month
  var cur = currentMonth_() || last, target = C.shiftMonth(cur, k);
  if (target < first) { ss.toast('No sales data before ' + C.monthLabel(first) + '.', 'Sales Report', 5); target = cur; }
  else if (target > maxKey) { ss.toast(C.monthLabel(maxKey) + ' is the furthest month that can be prepared now.', 'Sales Report', 5); target = cur; }
  renderSummary_(target);
}

// ---------------- undo (one step) ----------------
// Before every upload the stored data is copied to two hidden sheets; Undo puts it back.
function backup_(ss, data, up) {
  var C = CoreFactory(), tz = ss.getSpreadsheetTimeZone(), what = [];
  if (up.vbRange) what.push('Vetbuddy ' + C.fmtDate(up.vbRange[0]) + ' to ' + C.fmtDate(up.vbRange[1]));
  if (up.gfRange) what.push('Gofrugal ' + C.fmtDate(up.gfRange[0]) + ' to ' + C.fmtDate(up.gfRange[1]));
  if (up.gfrRange) what.push('Gofrugal returns ' + C.fmtDate(up.gfrRange[0]) + ' to ' + C.fmtDate(up.gfrRange[1]));
  if (up.note) what.push(up.note);
  var info = 'Upload of ' + Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm') + ' (' + what.join(', ') + ')';
  writeTable_(ss, SH.UNDO, [info, String(currentMonth_() || ''), '', '', '', ''], data);
  writeTable_(ss, SH.UNDOV, ['Date (serial)', 'Unit', 'Doctor ID', 'Doctor name'], readTable_(ss, SH.VOWD, 4));
  writeTable_(ss, SH.UNDOI, VOWI_HDR, readVowList_(ss, SH.VOWI, VOWI_HDR.length));
  writeTable_(ss, SH.UNDOB, VOWB_HDR, readVowList_(ss, SH.VOWB, VOWB_HDR.length));
  [SH.UNDO, SH.UNDOV, SH.UNDOI, SH.UNDOB].forEach(function (n) { ss.getSheetByName(n).hideSheet(); });
}
function undoInfo() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.UNDO);
  return sh && sh.getLastRow() >= 1 && String(sh.getRange('A1').getValue()).indexOf('Upload of') === 0 ? String(sh.getRange('A1').getValue()) : '';
}
function undoLastUpload() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(60000);
  try {
    var ss = SpreadsheetApp.getActive(), info = undoInfo();
    if (!info) return { ok: false, msg: 'Nothing to undo - the last upload was already undone (only one step is kept).' };
    var u = ss.getSheetByName(SH.UNDO), month = String(u.getRange('B1').getValue());
    writeTable_(ss, SH.DATA, ['Date (serial)', 'Unit', 'Vetbuddy', 'Gofrugal', 'Old history total', 'Gofrugal returns'], readTable_(ss, SH.UNDO, 6));
    writeTable_(ss, SH.VOWD, ['Date (serial)', 'Unit', 'Doctor ID', 'Doctor name'], readTable_(ss, SH.UNDOV, 4));
    if (ss.getSheetByName(SH.UNDOI)) {   // undo copies of the VOW lists (absent for uploads made before this feature)
      writeVowList_(ss, SH.VOWI, VOWI_HDR, readTable_(ss, SH.UNDOI, VOWI_HDR.length));
      writeVowList_(ss, SH.VOWB, VOWB_HDR, readTable_(ss, SH.UNDOB, VOWB_HDR.length));
      ss.getSheetByName(SH.UNDOI).clearContents(); ss.getSheetByName(SH.UNDOB).clearContents();
    }
    u.clearContents(); ss.getSheetByName(SH.UNDOV).clearContents();
    var exc = sheet_(ss, SH.EXC), tz = ss.getSpreadsheetTimeZone();
    exc.clear();
    exc.getRange('A1').setValue('Last upload UNDONE at ' + Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm') + ' - removed: ' + info).setFontWeight('bold');
    exc.getRange('A2').setValue('Checks: data restored to before that upload').setFontWeight('bold').setFontColor('#006100');
    renderSummary_(/^\d{4}-\d{2}$/.test(month) ? month : null);
    return { ok: true, msg: 'Undone: ' + info + '. The report is back to how it was before that upload.' };
  } finally {
    lock.releaseLock();
  }
}
function undoMenu() {
  var ui = SpreadsheetApp.getUi(), info = undoInfo();
  if (!info) { ui.alert('Nothing to undo', 'The last upload was already undone (only one step is kept).', ui.ButtonSet.OK); return; }
  if (ui.alert('Undo last upload?', info + '\n\nThe report will go back to how it was before this upload.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ui.alert('Undo', undoLastUpload().msg, ui.ButtonSet.OK);
}

// ---------------- sheet helpers ----------------
function sheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}
function readTable_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues().filter(function (r) { return r[0] !== '' && r[0] !== null; });
}
function writeTable_(ss, name, header, rows) {
  var sh = sheet_(ss, name);
  ensureSize_(sh, rows.length + 1, header.length);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('0');
  }
}
// visible invoice-level VOW lists (for other MIS): real dates in column A, one row per invoice / bill
function toSerial_(x) {
  if (x instanceof Date) return Math.round((Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) - Date.UTC(1899, 11, 30)) / 864e5);
  return +x;
}
function readVowList_(ss, name, cols) {
  return readTable_(ss, name, cols).map(function (r) { r = r.slice(); r[0] = toSerial_(r[0]); return r; });
}
function writeVowList_(ss, name, header, rows) {
  var sh = sheet_(ss, name);
  ensureSize_(sh, rows.length + 1, header.length);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setFontColor('white').setBackground('#1F3864').setWrap(true);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('dd-mm-yyyy');
    sh.getRange(2, header.length, rows.length, 1).setNumberFormat('#,##0.00');
  }
  sh.setFrozenRows(1);
}

// every unit shown on Summary gets an AOP column automatically (new units are added at the right end)
function ensureAopColumns_(ss, shown) {
  var a = ss.getSheetByName(SH.AOP); if (!a) return;
  var lc = Math.max(a.getLastColumn(), 1), hdr = a.getRange(1, 1, 1, lc).getValues()[0].map(function (x) { return String(x).trim().toUpperCase(); });
  var miss = shown.filter(function (u) { return hdr.indexOf(u) < 0; });
  if (!miss.length) return;
  ensureSize_(a, 1, lc + miss.length);
  a.getRange(1, lc + 1, 1, miss.length).setValues([miss]).setFontWeight('bold');
}

// ---------------- Re-apply the Vet on Wheels split to stored data ----------------
// Use after changing a clinic's VOW unit in Settings (e.g. Madurai -> MADURAI VET ON WHEELS).
// Moves each VOW invoice / bill already in the report to the VOW unit its clinic now has.
// Only dates where the invoice lists add up exactly to the report are changed; other dates are listed (re-upload those files instead).
function reapplyVowSplit_() {
  var lock = LockService.getDocumentLock(); lock.waitLock(60000);
  try {
    var C = CoreFactory(), ss = SpreadsheetApp.getActive(), settings = readSettings_(ss);
    var data = readTable_(ss, SH.DATA, 6), map = {};
    data.forEach(function (r) { map[r[0] + '|' + r[1]] = r; });
    var inv = readVowList_(ss, SH.VOWI, VOWI_HDR.length), bills = readVowList_(ss, SH.VOWB, VOWB_HDR.length);
    function cell(d, u) { var k = d + '|' + u; if (!map[k]) { map[k] = [d, u, 0, 0, '', 0]; data.push(map[k]); } return map[k]; }
    function okDates(rows, vowCol, amtCol, dataCol, typeOk) {
      var sums = {}, ok = {};
      rows.forEach(function (r) { if (!typeOk(r)) return; var k = r[0] + '|' + r[vowCol]; sums[k] = (sums[k] || 0) + (+r[amtCol] || 0); ok[r[0]] = true; });
      Object.keys(sums).forEach(function (k) { var d = +k.split('|')[0], v = map[k] ? (+map[k][dataCol] || 0) : 0; if (Math.abs(v - sums[k]) > 1) ok[d] = false; });
      return ok;
    }
    var okV = okDates(inv, 4, 6, 2, function () { return true; });
    var okS = okDates(bills, 5, 9, 3, function (r) { return r[1] !== 'Return'; });
    var okR = okDates(bills, 5, 9, 5, function (r) { return r[1] === 'Return'; });
    var moved = 0, amt = 0, skipped = {};
    function move(r, d, oldU, nameCol, vowCol, amtCol, dataCol, ok) {
      var cu = C.clinicUnit(r[nameCol], settings); if (!cu || !cu.vow) return;
      // a Non Clinical row stays Non Clinical (in the new VOW unit's Non Clinical column if it has one)
      var to = / - NON CLINICAL$/.test(oldU) && isVowParent_(cu.vow) ? cu.vow + VOW_SPLIT.nc : cu.vow;
      if (to === oldU) return;
      if (!ok[d]) { skipped[d] = 1; return; }
      var a = +r[amtCol] || 0;
      cell(d, oldU)[dataCol] = (+cell(d, oldU)[dataCol] || 0) - a; cell(d, to)[dataCol] = (+cell(d, to)[dataCol] || 0) + a;
      cell(d, oldU)[4] = ''; cell(d, to)[4] = '';
      r[vowCol] = to; moved++; amt += a;
    }
    inv.forEach(function (r) { move(r, r[0], r[4], 2, 4, 6, 2, okV); });
    bills.forEach(function (r) { move(r, r[0], r[5], 3, 5, 9, r[1] === 'Return' ? 5 : 3, r[1] === 'Return' ? okR : okS); });
    var skip = Object.keys(skipped).map(Number).sort(function (a, b) { return a - b; }).map(C.fmtDate);
    if (!moved) return { ok: true, msg: 'Nothing to move - stored data already matches the Vet on Wheels split in Settings.' + (skip.length ? ' Dates that need a re-upload instead: ' + skip.join(', ') : '') };
    backup_(ss, readTable_(ss, SH.DATA, 6), { note: 'Re-applied Vet on Wheels split' });
    var clean = data.filter(function (r) { return !(r[4] === '' && Math.abs(+r[2] || 0) < 0.005 && Math.abs(+r[3] || 0) < 0.005 && Math.abs(+r[5] || 0) < 0.005); })
      .sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    writeTable_(ss, SH.DATA, ['Date (serial)', 'Unit', 'Vetbuddy', 'Gofrugal', 'Old history total', 'Gofrugal returns'], clean);
    writeVowList_(ss, SH.VOWI, VOWI_HDR, inv); writeVowList_(ss, SH.VOWB, VOWB_HDR, bills);
    renderSummary_(currentMonth_());
    return { ok: true, msg: 'Moved ' + moved + ' Vet on Wheels invoices / bills (' + C.inr(amt) + ') to their new VOW unit.' +
      (skip.length ? ' Not changed (lists incomplete - re-upload these dates): ' + skip.join(', ') : '') + ' Undo is available.' };
  } finally { lock.releaseLock(); }
}
function reapplyVowMenu() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Re-apply Vet on Wheels split?', 'Every VOW invoice / bill already in the report is moved to the VOW unit its clinic now has in Settings > Clinic map.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ui.alert('Vet on Wheels split', reapplyVowSplit_().msg, ui.ButtonSet.OK);
}

// guide next to the Settings tables (columns N:O)
function writeSettingsGuide_(ss) {
  var st = ss.getSheetByName(SH.SETTINGS); if (!st) return;
  var G = [
    ['HOW TO ADD A NEW UNIT OR VET ON WHEELS UNIT', ''],
    ['Step 1 - Units (A:B)', 'Type the unit name in column A (CAPITALS, e.g. TRICHY VET ON WHEELS) and Y in column B. The order of this list is the column order on Summary. Use Y / N to show or hide.'],
    ['Step 2 - Clinic map (D:F)', 'For a new clinic: add a row - keyword found in the Vetbuddy billed clinic AND Gofrugal outlet name (e.g. Trichy), its unit (TRICHY) and its VOW unit (TRICHY VET ON WHEELS).'],
    ['', 'For a new Vet on Wheels unit of an existing clinic: only change that clinic\'s VOW unit in column F (e.g. Madurai -> MADURAI VET ON WHEELS).'],
    ['Step 3 - AOP', 'A column for the new unit appears on the AOP sheet by itself - type its targets.'],
    ['Step 4 - Apply', 'New uploads use the new split straight away. To move invoices already in the report: menu Sales Report > Re-apply Vet on Wheels split (or re-upload the month\'s files).'],
    ['VOW rule', 'An invoice is Vet on Wheels if any line matches a VOW rule (H:I). The whole invoice goes to the VOW unit of its billed clinic (column F). Gofrugal bills follow the same doctor / same day / same clinic.'],
    ['Non Clinical (V:X)', 'For CH and CBE VET ON WHEELS: lines of a VOW invoice matching a Non Clinical rule (e.g. Plan category contains Spa and Saloon) go to the Non Clinical column; the rest stays Clinical. Re-upload the month (or Import from SharePoint now) to apply to past days.']
  ];
  ensureSize_(st, G.length + 2, 15);
  st.getRange(2, 14, G.length, 2).setValues(G).setWrap(true).setVerticalAlignment('top');
  st.getRange(2, 14, 1, 2).setFontWeight('bold').setFontColor('white').setBackground('#1F3864');
  st.getRange(3, 14, G.length - 1, 1).setFontWeight('bold').setBackground('#D9E1F2');
  st.setColumnWidth(14, 170); st.setColumnWidth(15, 520);
}

function readSettings_(ss) {
  var sh = ss.getSheetByName(SH.SETTINGS);
  ensureVowFixBlock_(sh);
  ensureNonClinicalBlock_(sh);
  var v = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 24).getValues();
  function block(c0, n) { return v.map(function (r) { return r.slice(c0, c0 + n); }).filter(function (r) { return String(r[0]).trim() !== ''; }); }
  var fix = block(16, 3).map(function (r) { return [toSerial_(r[0]), String(r[1]).trim(), String(r[2]).trim()]; });
  return { units: block(0, 2), clinicMap: block(3, 3), rules: block(7, 2), aliases: block(10, 2), vowFix: fix,
           ncRules: block(21, 3), ncSplit: { units: VOW_SPLIT.units, nc: VOW_SPLIT.nc } };
}
// Settings Q:T - manual Vet on Wheels corrections for single bills (billing mistakes the rules cannot see)
function ensureVowFixBlock_(sh) {
  if (String(sh.getRange(2, 17).getValue()).trim() !== '') return;
  ensureSize_(sh, 3, 20);
  sh.getRange(2, 17, 1, 4).setValues([['Date (VOW correction)', 'Bill / Invoice No', 'Treat as (VOW / CLINIC)', 'Note']])
    .setFontWeight('bold').setFontColor('white').setBackground('#1F3864').setWrap(true);
  var note = 'Customer visited the clinic and took a Vet on Wheels visit the same day - only 374823, 374852, CC2219 are VOW';
  var rows = ['CC2203', 'CC2206', 'CC2207', 'CC2208', 'CC2209', 'CC2211', 'CC2212', 'CC2213', 'CC2216', 'CC2218', 'CC2221']
    .map(function (b) { return [new Date(2026, 10, 2), b, 'CLINIC', note]; });
  sh.getRange(3, 17, rows.length, 4).setValues(rows);
  sh.getRange(3, 17, 200, 1).setNumberFormat('dd-mm-yyyy');
  sh.getRange(3, 18, 200, 1).setNumberFormat('@');
  sh.getRange(3, 19, 200, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['VOW', 'CLINIC'], true).build());
  sh.setColumnWidth(17, 110); sh.setColumnWidth(18, 120); sh.setColumnWidth(19, 120); sh.setColumnWidth(20, 360);
}
// Settings V:X - which lines of a Vet on Wheels invoice are Non Clinical (CH / CBE VET ON WHEELS show them in their own column)
function ensureNonClinicalBlock_(sh) {
  if (String(sh.getRange(2, 22).getValue()).trim() !== '') return;
  ensureSize_(sh, 4, 24);
  sh.getRange(2, 22, 1, 3).setValues([['Non Clinical rule type', 'Look in (Plan category / Plan sub category / Item)', 'Non Clinical text']])
    .setFontWeight('bold').setFontColor('white').setBackground('#1F3864').setWrap(true);
  sh.getRange(3, 22, 1, 3).setValues([['Contains', 'Plan category', 'Spa and Saloon']]);
  sh.getRange(3, 22, 200, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Contains', 'Starts with', 'Exact'], true).build());
  sh.getRange(3, 23, 200, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Plan category', 'Plan sub category', 'Item'], true).build());
  sh.setColumnWidth(22, 130); sh.setColumnWidth(23, 200); sh.setColumnWidth(24, 180);
}
function labelToKey_(label) {
  if (label instanceof Date) return label.getFullYear() + '-' + ('0' + (label.getMonth() + 1)).slice(-2);   // Sheets may turn "Nov 2026" into a date
  var MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var m = String(label).trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  var i = MON.indexOf(m[1].toLowerCase());
  return i < 0 ? null : m[2] + '-' + ('0' + (i + 1)).slice(-2);
}
function currentMonth_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.SUMMARY);
  return sh ? labelToKey_(sh.getRange('B1').getValue()) : null;
}

// ---------------- Summary ----------------
function renderSummary_(month) {
  var C = CoreFactory(), ss = SpreadsheetApp.getActive();
  var st = readSettings_(ss);
  var shown = st.units.filter(function (u) { return /^y/i.test(String(u[1]).trim()); }).map(function (u) { return String(u[0]).trim().toUpperCase(); });
  shown = vowSplitShown_(shown);
  ensureAopColumns_(ss, shown);
  var S = C.summary(readTable_(ss, SH.DATA, 6), ss.getSheetByName(SH.AOP).getDataRange().getValues(), shown, month);
  var sh = sheet_(ss, SH.SUMMARY);
  var ncol = 2 + shown.length + 1;            // Day | Date | units... | Total
  var msgCol = ncol + 2;                       // message block to the right, like the old report
  ensureSize_(sh, 80, msgCol + 6);
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 1), Math.max(sh.getMaxColumns(), msgCol + 6)).breakApart();
  sh.getRange(3, 1, Math.max(sh.getMaxRows() - 2, 1), Math.max(sh.getMaxColumns(), msgCol + 6)).clear();
  sh.getRange(1, 3, 1, Math.max(sh.getMaxColumns() - 2, 1)).clear().clearDataValidations();
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), sh.getMaxColumns()).clearDataValidations();
  sh.getRange('A1').setValue('Month').setFontWeight('bold');
  if (!S) { sh.getRange('B1').clearDataValidations().setValue(''); sh.getRange('C1').setValue('No data yet - use the Upload & Update Report button.'); return; }
  var labels = S.monthList.map(C.monthLabel);
  sh.getRange('B1').setNumberFormat('@');
  sh.getRange('B1').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(labels, true).setAllowInvalid(false).build())
    .setValue(S.monthLabel).setFontWeight('bold').setBackground('#FFF2CC');
  sh.getRange('C1').setValue(S.title + (S.empty ? '' : S.remaining > 0 ? '   (' + S.remaining + ' days left in month)' : '   (month complete)')).setFontWeight('bold').setFontColor('#1F3864');
  // ---- row 2: Previous / Next month buttons (tick boxes work for everyone, no permission prompt)
  sh.getRange(2, 1, 1, 4).clearContent();
  sh.setRowHeight(2, 30);
  sh.getRange('A2').insertCheckboxes().setValue(false).setBackground('#1F3864').setFontColor('#FFFFFF').setHorizontalAlignment('right');
  sh.getRange('B2').setValue('\u25C0 Prev month').setBackground('#1F3864').setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
  sh.getRange('C2').insertCheckboxes().setValue(false).setBackground('#2E75B6').setFontColor('#FFFFFF').setHorizontalAlignment('right');
  sh.getRange('D2').setValue('Next month  \u25B6').setBackground('#2E75B6').setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
  sh.getRange('E2').setValue('Tick a box to switch month (same format, all formulas recalculated).').setFontColor('#7F7F7F').setFontStyle('italic');

  // ---- CH VET ON WHEELS over its Clinical / Non Clinical columns (row 2)
  sh.getRange(2, 6, 1, Math.max(sh.getMaxColumns() - 5, 1)).clear();
  shown.forEach(function (u, k) {
    if (isVowParent_(u)) sh.getRange(2, 3 + k, 1, 2).merge().setValue(u).setFontWeight('bold').setFontColor('white').setBackground('#1F3864')
      .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  });

  // ---- header (row 3), like the old Summary: Day | Date | units | Total
  var hdr = ['Day', 'Date'].concat(shown).concat(['Total']);
  sh.getRange(3, 1, 1, ncol).setValues([hdr.map(vowSplitLabel_)]).setFontWeight('bold').setFontColor('white').setBackground('#1F3864')
    .setWrap(true).setVerticalAlignment('middle').setHorizontalAlignment('center');
  sh.setRowHeight(3, 36);

  // ---- one row per day of the month
  var rows = [], bg = [], fc = [], n = shown.length;
  S.days.forEach(function (d) {
    var dayName = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[d.dow];
    if (d.values) {
      rows.push([dayName, d.label].concat(d.values.slice(0, n)).concat([d.values[n]]));
      bg.push(['#FFFFFF', '#FFFFFF'].concat(d.values.slice(0, n).map(function (x) { return Math.abs(x) < 0.5 ? '#FFC7CE' : '#FFFFFF'; })).concat(['#FFF2CC']));
      fc.push(hdr.map(function () { return '#000000'; }));
    } else {
      rows.push([dayName, d.label].concat(shown.map(function () { return ''; })).concat(['']));
      bg.push(hdr.map(function () { return '#FFFFFF'; }));
      fc.push(hdr.map(function () { return '#BFBFBF'; }));
    }
  });
  sh.getRange(4, 1, rows.length, 2).setNumberFormat('@');
  sh.getRange(4, 1, rows.length, ncol).setValues(rows).setBackgrounds(bg).setFontColors(fc)
    .setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(4, 3, rows.length, n + 1).setNumberFormat(IND_FMT);
  sh.getRange(4, ncol, rows.length, 1).setFontWeight('bold');

  // ---- KPI block, same rows as the old report
  var top = 4 + rows.length, cols = shown.concat(['*']);
  var K = [
    [S.mon + ' MTD', 'mtd', 'amt', true],
    [S.lmMon + ' MTD', 'lm', 'amt'],
    [S.l2mMon + ' MTD', 'l2m', 'amt'],
    [S.mon + ' VS ' + S.lmMon, 'g1', 'pct'],
    [S.mon + ' VS ' + S.l2mMon, 'g2', 'pct'],
    ['EST. CLOSURE', 'est', 'amt', true],
    ['Target @ 2 Cr', 'aop', 'amt'],
    ['Target @ 2 Cr vs ' + S.mon + ' EST', 'estVsAop', 'pct', true],
    ['ADS CM', 'ads', 'amt'],
    ['ADS LM', 'adsLm', 'amt'],
    ['Target @ 2 Cr/Day', 'aopPerDay', 'amt'],
    ['Target @ 2 Cr vs ADS', 'adsVsAop', 'pct'],
    ['Balance to Target @ 2 Cr', 'balance', 'amt'],
    ['REQ. PER DAY (' + S.remaining + ' days left)', 'reqPerDay', 'amt'],
    ['VETBUDDY MTD', 'vb', 'amt'],
    ['GOFRUGAL MTD', 'gf', 'amt']
  ];
  var kv = [], kbg = [], kfc = [], kfmt = [];
  K.forEach(function (k) {
    var line = ['', k[0]], b = ['#D9E1F2', '#D9E1F2'], f = ['#000000', '#000000'], fm = ['@', '@'];
    cols.forEach(function (u) {
      var x = S.rows[u][k[1]];
      if ((k[1] === 'vb' || k[1] === 'gf') && S.legacyMonth) x = null;
      line.push(x === null || x === undefined ? '-' : x);
      b.push(k[3] ? '#FFF2CC' : '#FFFFFF');
      f.push(typeof x === 'number' && x < 0 && (k[2] === 'pct' || k[1] === 'balance') ? '#C00000' : '#000000');
      fm.push(k[2] === 'pct' ? '0.0%;-0.0%' : (k[1] === 'balance' ? '#,##0;-#,##0' : IND_FMT));
    });
    kv.push(line); kbg.push(b); kfc.push(f); kfmt.push(fm);
  });
  sh.getRange(top, 1, K.length, ncol).setValues(kv).setBackgrounds(kbg).setFontColors(kfc).setNumberFormats(kfmt)
    .setBorder(true, true, true, true, true, true, '#BFBFBF', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(top, 1, K.length, 2).setFontWeight('bold');
  for (var i = 0; i < K.length; i++) {
    sh.getRange(top + i, 1, 1, 2).merge();
    if (K[i][3]) sh.getRange(top + i, 3, 1, ncol - 2).setFontWeight('bold');
  }

  // ---- keep the Upload / Undo buttons above the message block (it moves when units are added)
  sh.getImages().forEach(function (img) {
    var t = String(img.getAltTextTitle() || '');
    if (/^Upload/i.test(t)) img.setAnchorCell(sh.getRange(1, msgCol)).setAnchorCellXOffset(0).setAnchorCellYOffset(0);
    else if (/^Undo/i.test(t)) img.setAnchorCell(sh.getRange(1, msgCol + 3)).setAnchorCellXOffset(10).setAnchorCellYOffset(0);
  });

  // ---- message block on the right (copy to WhatsApp)
  // note under the Upload button (button sits over this column, rows 1-2)
  var autoTxt = 'AUTO updated everyday 9AM', waTxt = 'WhatsApp message';
  sh.getRange(3, msgCol, 1, 5).merge();
  sh.getRange(3, msgCol).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(autoTxt + '\n' + waTxt)
    .setTextStyle(0, autoTxt.length, SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor('#006100').build())
    .setTextStyle(autoTxt.length + 1, autoTxt.length + 1 + waTxt.length, SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor('#000000').build())
    .build()).setWrap(true).setVerticalAlignment('top');
  sh.getRange(4, msgCol, 1, 5).merge();
  sh.getRange(4, msgCol).setValue(S.title).setFontWeight('bold').setBackground('#E2EFDA');
  sh.getRange(5, msgCol, 3, 5).merge();
  sh.getRange(5, msgCol).setValue(S.message).setWrap(true).setVerticalAlignment('top').setBackground('#E2EFDA');
  var exc = ss.getSheetByName(SH.EXC);
  var lastUp = exc ? String(exc.getRange('A1').getValue()) : '', checks = exc ? String(exc.getRange('A2').getValue()) : '';
  sh.getRange(9, msgCol, 1, 5).merge();
  sh.getRange(9, msgCol).setValue(checks).setFontWeight('bold').setFontColor(/ALL OK/.test(checks) ? '#006100' : '#C00000');
  sh.getRange(10, msgCol, 2, 5).merge();
  sh.getRange(10, msgCol).setValue(lastUp).setWrap(true).setVerticalAlignment('top').setFontColor('#595959');
  if (S.empty) sh.getRange(top + K.length + 2, 1).setValue('No sales uploaded for ' + S.monthLabel + ' yet: EST. CLOSURE is a forecast of the full month from the last 4 weeks of sales. Upload the month\'s files to start it.')
    .setFontColor('#C00000').setFontStyle('italic');
  sh.getRange(top + K.length + 1, 1).setValue('Pink = no sales that day. Last-month rows compare the same days. AOP / Settings edits refresh this sheet automatically.')
    .setFontColor('#7F7F7F').setFontStyle('italic');

  sh.setColumnWidth(1, 90); sh.setColumnWidth(2, 96);
  for (var c = 3; c <= ncol; c++) sh.setColumnWidth(c, 104);
  sh.setColumnWidth(ncol + 1, 24);
  for (c = msgCol; c < msgCol + 5; c++) sh.setColumnWidth(c, 90);
  sh.setFrozenRows(3); sh.setFrozenColumns(2);
  try { renderEstimate_(S.month, shown); } catch (err) { Logger.log('Estimate sheet: ' + err); }
}

// ---------------- Estimate Breakup (refreshed with every Summary refresh) ----------------
function renderEstimate_(month, shown) {
  var C = CoreFactory(), ss = SpreadsheetApp.getActive();
  var E = C.estimateDetail(readTable_(ss, SH.DATA, 6), ss.getSheetByName(SH.AOP).getDataRange().getValues(), shown, month);
  var sh = sheet_(ss, SH.EST), cols = shown.concat(['*']), ncol = cols.length + 1;
  var need = 60 + (E ? E.remaining + E.insights.length : 0);
  ensureSize_(sh, need, Math.max(ncol, 4));
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart().clearDataValidations();
  sh.clear();
  if (!E) { sh.getRange('A1').setValue('No data yet.'); return; }
  var r = 1, DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  sh.getRange(1, 1).setValue('Estimate Breakup - ' + E.monthLabel + '   (data up to ' + E.asOfText + ', ' + E.remaining + ' days left)').setFontWeight('bold').setFontSize(13).setFontColor('#1F3864');
  sh.getRange(2, 1).setValue('Changes with the month selected on Summary (cell B1) and refreshes after every upload. Formula: EST. CLOSURE = MTD actual + for every remaining day, the average of the same weekday in the last 4 weeks (' + E.windowText + ').')
    .setFontColor('#595959').setFontStyle('italic');
  r = 4;
  function hdr(t) {
    sh.getRange(r, 1).setValue(t).setFontWeight('bold').setFontSize(12).setFontColor('#1F3864'); r++;
    sh.getRange(r, 1, 1, ncol).setValues([['Item'].concat(shown).concat(['Total'])]).setFontWeight('bold').setFontColor('white').setBackground('#1F3864').setWrap(true).setHorizontalAlignment('center');
    sh.setRowHeight(r, 34); r++;
  }
  function block(lines) {   // lines: [label, key or fn, fmt('amt'|'pct'|'num'), highlight]
    var v = [], bg = [], fm = [], fc = [];
    lines.forEach(function (L) {
      var row = [L[0]], b = [L[3] ? '#FFF2CC' : '#D9E1F2'], f = ['@'], c = ['#000000'];
      cols.forEach(function (u) {
        var x = typeof L[1] === 'function' ? L[1](E.rows[u], u) : E.rows[u][L[1]];
        row.push(x === null || x === undefined || (typeof x === 'number' && !isFinite(x)) ? '-' : x);
        b.push(L[3] ? '#FFF2CC' : '#FFFFFF');
        f.push(L[2] === 'pct' ? '+0.0%;-0.0%' : L[2] === 'num' ? '0' : L[2] === 'signed' ? '+#,##0;-#,##0;0' : IND_FMT);
        c.push(typeof x === 'number' && x < 0 ? '#C00000' : '#000000');
      });
      v.push(row); bg.push(b); fm.push(f); fc.push(c);
    });
    sh.getRange(r, 1, v.length, ncol).setValues(v).setBackgrounds(bg).setNumberFormats(fm).setFontColors(fc)
      .setBorder(true, true, true, true, true, true, '#BFBFBF', SpreadsheetApp.BorderStyle.SOLID);
    for (var i = 0; i < lines.length; i++) if (lines[i][3]) sh.getRange(r + i, 1, 1, ncol).setFontWeight('bold');
    r += v.length + 1;
  }

  // 1. how the estimate is built
  hdr('1. How the estimate is built (per unit)');
  var L1 = [['Sales so far (MTD, ' + E.dayNo + ' days)', 'mtd', 'amt', true]];
  for (var k = 1; k <= 7; k++) {
    var w = k % 7;
    L1.push(['Avg ' + DOWL[w] + ' (last 4 wks)  x ' + E.remCount[w] + ' left', (function (w) { return function (R) { return R.avg[w]; }; })(w), 'amt']);
  }
  L1.push(['Estimate for remaining ' + E.remaining + ' days', 'estRem', 'amt']);
  L1.push(['EST. CLOSURE', 'est', 'amt', true]);
  L1.push(['AOP TARGET', 'aop', 'amt']);
  L1.push(['EST vs AOP', 'estVsAop', 'pct', true]);
  L1.push(['Gap: EST - AOP', function (R) { return R.aop ? R.est - R.aop : null; }, 'signed']);
  L1.push(['Usual per day for remaining days', 'usualLeft', 'amt']);
  L1.push(['Required per day to reach AOP', 'reqPerDay', 'amt']);
  L1.push(['Simple run-rate closure (avg/day x ' + E.daysInMonth + ')', 'runRate', 'amt']);
  L1.push(['Weekday method vs simple run-rate', function (R) { return R.est - R.runRate; }, 'signed']);
  block(L1);

  // 2. why it changed since the previous day
  if (E.prevText) {
    hdr('2. Why the estimate changed: ' + E.prevText + ' -> ' + E.asOfText);
    block([
      ['Estimate on ' + E.prevText, 'estPrev', 'amt'],
      ['Actual sales on ' + E.asOfText + ' (' + E.weekday + ')', 'actual', 'amt'],
      ['Usual ' + E.weekday + ' (estimate had assumed)', 'expected', 'amt'],
      ['(a) Day effect = actual - usual', 'dayEffect', 'signed', true],
      ['Same weekday 4 weeks ago, dropped from window (' + E.droppedText + ')', 'dropped', 'amt'],
      ['(b) Window refresh = (' + E.asOfText.slice(0, 6) + ' - ' + E.droppedText.slice(0, 6) + ') / 4 x ' + E.remCount[DOW.indexOf(E.weekday)] + ' ' + E.weekday + ' left', 'windowEffect', 'signed', true],
      ['Total change (a) + (b)', 'change', 'signed', true],
      ['Estimate on ' + E.asOfText, 'est', 'amt', true]]);
  }

  // 3. insights
  sh.getRange(r, 1).setValue((E.prevText ? '3' : '2') + '. Insights').setFontWeight('bold').setFontSize(12).setFontColor('#1F3864'); r++;
  E.insights.forEach(function (t) {
    sh.getRange(r, 1, 1, ncol).merge();
    sh.getRange(r, 1).setValue('- ' + t).setWrap(true).setVerticalAlignment('top');
    sh.setRowHeight(r, t.length > 170 ? 48 : 32); r++;
  });
  r++;

  // 4. remaining calendar
  if (E.remaining > 0) {
    sh.getRange(r, 1).setValue((E.prevText ? '4' : '3') + '. What is assumed for each remaining day').setFontWeight('bold').setFontSize(12).setFontColor('#1F3864'); r++;
    sh.getRange(r, 1, 1, ncol).setValues([['Date'].concat(shown).concat(['Total'])]).setFontWeight('bold').setFontColor('white').setBackground('#1F3864').setWrap(true).setHorizontalAlignment('center');
    r++;
    var cal = [];
    for (var d = E.asOf + 1; d <= E.asOf + E.remaining; d++) {
      var wd = C.ymd(d).wd;
      cal.push([C.fmtDate(d) + ' ' + DOW[wd]].concat(cols.map(function (u) { return E.rows[u].avg[wd]; })));
    }
    sh.getRange(r, 1, cal.length, 1).setNumberFormat('@');
    sh.getRange(r, 1, cal.length, ncol).setValues(cal).setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(r, 2, cal.length, ncol - 1).setNumberFormat(IND_FMT);
    sh.getRange(r, ncol, cal.length, 1).setFontWeight('bold');
    r += cal.length + 1;
  }
  sh.getRange(r, 1).setValue('Why the estimate moves every day: (a) the new day sold more or less than a usual day of that weekday, and (b) that day replaces the same weekday 4 weeks earlier in the average, which re-values the remaining days of that weekday. Nothing else changes it, unless an older date is re-uploaded or corrected.')
    .setFontColor('#7F7F7F').setFontStyle('italic');
  sh.setColumnWidth(1, 330);
  for (var c = 2; c <= ncol; c++) sh.setColumnWidth(c, 100);
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
}

// ---------------- Exceptions ----------------
function writeExceptions_(ss, up) {
  var C = CoreFactory(), sh = sheet_(ss, SH.EXC), tz = ss.getSpreadsheetTimeZone();
  ensureSize_(sh, 60 + Object.keys(up.nameMatches).length + Object.keys(up.possibleMisses).length + Object.keys(up.unmapped).length + up.checks.length, 6);
  sh.clear();
  var r = 1;
  function put(values, opts) {
    if (!values.length) return;
    var rg = sh.getRange(r, 1, values.length, values[0].length).setValues(values);
    if (opts && opts.hdr) sh.getRange(r, 1, 1, values[0].length).setFontWeight('bold').setBackground('#1F3864').setFontColor('white');
    if (opts && opts.amtCol) sh.getRange(r + 1, opts.amtCol, Math.max(values.length - 1, 1), 1).setNumberFormat(IND_FMT);
    r += values.length;
    return rg;
  }
  function title(t) { r++; sh.getRange(r, 1).setValue(t).setFontWeight('bold').setFontSize(12); r++; }
  var files = [];
  if (up.vbRange) files.push('Vetbuddy ' + C.fmtDate(up.vbRange[0]) + ' to ' + C.fmtDate(up.vbRange[1]));
  if (up.gfRange) files.push('Gofrugal ' + C.fmtDate(up.gfRange[0]) + ' to ' + C.fmtDate(up.gfRange[1]));
  if (up.gfrRange) files.push('Gofrugal returns ' + C.fmtDate(up.gfrRange[0]) + ' to ' + C.fmtDate(up.gfrRange[1]));
  var ok = up.checks.every(function (c) { return c[1] === 'OK'; });
  sh.getRange('A1').setValue('Last upload: ' + Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm') + ' (' + files.join(', ') + ')').setFontWeight('bold');
  sh.getRange('A2').setValue(ok ? 'Checks: ALL OK' : 'Checks: SOME NEED A LOOK (see below)').setFontWeight('bold').setFontColor(ok ? '#006100' : '#C00000');
  r = 3;
  title('Checks');
  var cStart = r + 1;
  put([['Check', 'Status', 'Detail']].concat(up.checks), { hdr: true });
  for (var i = 0; i < up.checks.length; i++) {
    sh.getRange(cStart + i, 2).setBackground(up.checks[i][1] === 'OK' ? '#C6EFCE' : '#FFC7CE').setFontWeight('bold');
  }
  var s = up.stats;
  title('Vet on Wheels');
  put([['Item', 'Value'],
       ['VOW invoices in Vetbuddy', s.vowInvoices === undefined ? '-' : s.vowInvoices],
       ['VOW sales - Vetbuddy', s.vowVb === undefined ? '-' : s.vowVb],
       ['VOW sales - Gofrugal (doctor code match)', s.vowGfId === undefined ? '-' : s.vowGfId],
       ['VOW sales - Gofrugal (doctor name auto-corrected)', s.vowGfName === undefined ? '-' : s.vowGfName],
       ['Gofrugal returns - total (deducted)', s.gfrTotal === undefined ? '-' : s.gfrTotal],
       ['Gofrugal returns - of which VOW', s.gfrTotal === undefined ? '-' : (s.vowGfrId || 0) + (s.vowGfrName || 0)]], { hdr: true, amtCol: 2 });
  title('Gofrugal doctor names auto-corrected to a VOW doctor (same clinic, same day)');
  var nm = Object.keys(up.nameMatches).map(function (k) { var p = k.split('  ->  '); return [p[0], p[1], up.nameMatches[k].lines, up.nameMatches[k].amt]; });
  put([['Name typed in Gofrugal', 'Matched to Vetbuddy VOW doctor', 'Lines', 'Amount']].concat(nm.length ? nm : [['(none)', '', '', '']]), { hdr: true, amtCol: 4 });
  title('Close to a VOW doctor but NOT matched (check once)');
  var pm = Object.keys(up.possibleMisses).map(function (k) { return [k, up.possibleMisses[k].lines, up.possibleMisses[k].amt]; });
  put([['Name typed in Gofrugal', 'Lines', 'Amount']].concat(pm.length ? pm : [['(none)', '', '']]), { hdr: true, amtCol: 3 });
  title('Clinic / outlet names not mapped to a unit');
  var um = Object.keys(up.unmapped).map(function (k) { return [k, up.unmapped[k]]; });
  put([['Name in report', 'Amount (not counted)']].concat(um.length ? um : [['(none)', '']]), { hdr: true, amtCol: 2 });
  r++;
  sh.getRange(r + 1, 1, 3, 1).setValues([
    ['To fix a wrong doctor match: Settings > Doctor names - type the Gofrugal name and the correct doctor code (e.g. P00186), or NONE to stop it matching.'],
    ['To fix an unmapped clinic: Settings > Clinic map - add a keyword from the name and its unit.'],
    ['Then upload the files again (same files are fine).']]).setFontColor('#7F7F7F').setFontStyle('italic');
  sh.setColumnWidth(1, 330); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 120); sh.setColumnWidth(4, 120);
}

// ---------------- first-time setup ----------------
function setup() {
  var ss = SpreadsheetApp.getActive();
  [SH.SUMMARY, SH.AOP, SH.SETTINGS, SH.EXC, SH.DATA, SH.VOWD].forEach(function (n) { sheet_(ss, n); });
  var st = ss.getSheetByName(SH.SETTINGS);
  if (st.getLastRow() < 3) {
    st.getRange('A1').setValue('Settings - edit any time. Summary refreshes itself.').setFontWeight('bold');
    st.getRange('A2:L2').setValues([['Unit', 'Show in Summary (Y/N)', '', 'Keyword in clinic / outlet name', 'Unit', 'VOW unit', '', 'VOW rule type', 'VOW item text', '', 'Doctor name as typed', 'Doctor code (P00xxx or NONE)']]).setFontWeight('bold');
    var units = [['ADYAR', 'Y'], ['NEELANGARAI', 'Y'], ['ANNA NAGAR', 'Y'], ['VELACHERY', 'Y'], ['COIMBATORE', 'Y'], ['MADURAI', 'Y'], ['VALASARAVAKKAM', 'Y'], ['CH VET ON WHEELS', 'Y'], ['CBE VET ON WHEELS', 'Y'], ['KORAMANGALA', 'N'], ['WHITEFIELD', 'N'], ['VAAL AATUM DANCE FLOOR', 'N']];
    st.getRange(3, 1, units.length, 2).setValues(units);
    var cm = [['Adyar', 'ADYAR', 'CH VET ON WHEELS'], ['Anna Nagar', 'ANNA NAGAR', 'CH VET ON WHEELS'], ['Velachery', 'VELACHERY', 'CH VET ON WHEELS'], ['Neelangarai', 'NEELANGARAI', 'CH VET ON WHEELS'], ['Palavakkam', 'NEELANGARAI', 'CH VET ON WHEELS'], ['Valasaravakkam', 'VALASARAVAKKAM', 'CH VET ON WHEELS'], ['Madurai', 'MADURAI', 'CH VET ON WHEELS'], ['Coimbatore', 'COIMBATORE', 'CBE VET ON WHEELS'], ['Saibaba', 'COIMBATORE', 'CBE VET ON WHEELS']];
    st.getRange(3, 4, cm.length, 3).setValues(cm);
    var rules = [['Contains', 'VOW'], ['Starts with', 'Home visit'], ['Starts with', 'Nobivac'], ['Starts with', 'Mobile Veterinary Consult'], ['Exact', 'Consultation VOW']];
    st.getRange(3, 8, rules.length, 2).setValues(rules);
  }
  [SH.DATA, SH.VOWD].forEach(function (n) { ss.getSheetByName(n).hideSheet(); });
  [SH.UNDO, SH.UNDOV, SH.UNDOI, SH.UNDOB].forEach(function (n) { var s = ss.getSheetByName(n); if (s) s.hideSheet(); });
  var sm = ss.getSheetByName(SH.SUMMARY);
  sm.getImages().forEach(function (img) { img.remove(); });
  var blob = Utilities.newBlob(Utilities.base64Decode(BUTTON_PNG), 'image/png', 'upload.png');
  var img = sm.insertImage(blob, 14, 1, 0, 0);
  img.setWidth(220).setHeight(40).assignScript('openUpload').setAltTextTitle('Upload & Update Report');
  var ub = sm.insertImage(Utilities.newBlob(Utilities.base64Decode(UNDO_PNG), 'image/png', 'undo.png'), 17, 1, 10, 0);
  ub.setWidth(170).setHeight(40).assignScript('undoMenu').setAltTextTitle('Undo Last Upload');
  ss.setActiveSheet(sm);
  writeHowItWorks();
  ss.setActiveSheet(sm);
  renderSummary_(currentMonth_());
  SpreadsheetApp.getUi().alert('Setup done. Use the blue "Upload & Update Report" button on Summary (or menu Sales Report).');
}

// ---------------- How It Works (static guide) ----------------
function writeHowItWorks() {
  var ss = SpreadsheetApp.getActive(), sh = sheet_(ss, SH.HOW);
  writeSettingsGuide_(ss);
  var T = [
    ['#', 'HOW THIS REPORT WORKS - rules, daily use, how it is built, month change'],
    ['', 'Sanchu network daily sales MIS = Vetbuddy clinic billing + Gofrugal pharmacy sales - Gofrugal pharmacy returns, split by unit and Vet on Wheels.'],
    ['#', '1. DAILY ROUTINE (the only manual work)'],
    ['Step 1', 'Download from Vetbuddy: Reports > "Sales by plan item" for the dates needed (month start to yesterday is best).'],
    ['Step 2', 'Download from Gofrugal (cloud): "Sales Detail - Itemwise" and "Sales Return Detail - Itemwise" for the same dates.'],
    ['Step 3', 'Open Summary, click the blue "Upload & Update Report" button (or menu Sales Report > Upload & update report, or the team upload link). Drop the 3 files in any order - the file type is recognised automatically.'],
    ['Step 4', 'Click "Update report". The Summary, Estimate Breakup and Exceptions sheets refresh. Copy the WhatsApp message from the green box on Summary.'],
    ['Step 5', 'Look at Summary cell N9 / Exceptions sheet. "Checks: ALL OK" = done. If not, see section 6.'],
    ['AOP', 'Targets are typed (or pasted) on the AOP sheet: one row per month (e.g. "Nov 2026"), one column per unit. Editing AOP refreshes the Summary by itself.'],
    ['Undo', 'The red "Undo Last Upload" button puts the report back exactly as it was before the last upload (one step only).'],
    ['VOW invoice lists', '"VOW Vetbuddy Invoices" (date, invoice no, clinic, unit, VOW unit, doctor, amount) and "VOW Gofrugal Bills" (date, bill no, outlet, unit, VOW unit, doctor, match, amount; returns as negative) list every invoice / bill counted in Vet on Wheels. They update with every upload and can be used in other MIS (e.g. with IMPORTRANGE). Do not type in them.'],
    ['#', '2. SALES RULES'],
    ['Vetbuddy sales', 'Net Sales - Net Return of every line in "Sales by plan item", on the invoice date, for the clinic in "Billed Clinic".'],
    ['Gofrugal sales', '"Item Amt BeforeTax" of every line in "Sales Detail - Itemwise", on the bill date, for the outlet in "Outlet Name".'],
    ['Gofrugal returns', '"Sub Total" of every line in "Sales Return Detail - Itemwise" is DEDUCTED, on the return date, from the outlet (or Vet on Wheels, same doctor rule as sales).'],
    ['Total sales', 'Vetbuddy + Gofrugal - Gofrugal returns. This is what every Summary number uses.'],
    ['Units', 'A clinic / outlet name is mapped to a unit by a keyword (Settings > Clinic map), e.g. "Palavakkam" -> NEELANGARAI, "Saibaba" -> COIMBATORE. Units shown on Summary are set in Settings > Show in Summary (Y/N). KORAMANGALA, WHITEFIELD and VAAL AATUM DANCE FLOOR are hidden (N).'],
    ['#', '3. VET ON WHEELS (VOW) RULES'],
    ['Vetbuddy - VOW invoice', 'If ANY line of an invoice contains "VOW", or starts with "Home visit", "Nobivac" or "Mobile Veterinary Consult" (Settings > VOW rules), the WHOLE invoice (all its plans and services) goes to Vet on Wheels.'],
    ['Vetbuddy - which VOW unit', 'The VOW unit comes from the billed clinic (Settings > Clinic map, column F): Coimbatore / Saibaba -> CBE VET ON WHEELS, Madurai -> MADURAI VET ON WHEELS, Trichy -> TRICHY VET ON WHEELS, all Chennai clinics -> CH VET ON WHEELS. Other invoices of the same pet that have no VOW item stay with the clinic.'],
    ['Adding a unit', 'Settings sheet, columns N:O, has the 4 steps: add the unit name (A:B), map the clinic keyword and VOW unit (D:F), type its AOP, then Sales Report > Re-apply Vet on Wheels split.'],
    ['Gofrugal layouts', 'Both Gofrugal export layouts are accepted: totals row at the bottom, or totals row directly under the header.'],
    ['Gofrugal - VOW', 'A Gofrugal bill goes to VOW only if the SAME doctor billed a VOW invoice in Vetbuddy on the SAME date at the SAME clinic/outlet.'],
    ['Doctor matching', '1) Doctor code (P0xxxx) in the Gofrugal doctor name = exact match. 2) Otherwise the name is auto-corrected for spelling against that day\'s VOW doctors of that clinic (e.g. "vamshi dr" -> Bandi Vamsi Krishna). 3) Settings > Doctor names always wins: type the Gofrugal name and the code, or NONE to stop a match.'],
    ['Gofrugal-only upload', 'If only Gofrugal files are uploaded, the VOW doctors saved from earlier Vetbuddy uploads are used.'],
    ['#', '4. SUMMARY NUMBERS'],
    ['MTD', 'Sales from the 1st of the month up to the latest date that has data ("as of" date in the title).'],
    ['LM / L2M MTD', 'Last month and the month before, for the SAME days (e.g. 1-22 Oct vs 1-22 Sep). If last month is shorter, it stops at its last day.'],
    ['Growth %', 'MTD / LM MTD - 1 (and vs L2M).'],
    ['EST. CLOSURE', 'MTD + for every remaining day, the average of the same weekday over the last 4 weeks. Full breakup and reasons: Estimate Breakup sheet.'],
    ['AOP / Day, ADS', 'AOP/Day = AOP / days in month. ADS CM = MTD / days passed. ADS LM = LM MTD / same days.'],
    ['Balance / Req. per day', 'Balance = AOP - MTD. Required per day = Balance / remaining days (0 if AOP already reached).'],
    ['Pink cells', 'A unit with no sales on that day - usually a closed day or a missing report.'],
    ['#', '5. MONTH CHANGE - what happens when October ends and November starts'],
    ['Nothing to do', 'There is no "close month" step. Everything is keyed by date, so the month changes automatically.'],
    ['Month buttons', 'Summary row 2: tick "Previous month" or "Next month" to move the whole report (Summary + Estimate Breakup) one month back or forward in the same format with all numbers recalculated. The month dropdown in B1 does the same. Next month works even before any sales of that month are uploaded: the day rows, AOP, AOP/day and Required/day are ready, and EST. CLOSURE shows a full-month forecast from the last 4 weeks.'],
    ['First Nov upload', 'When files containing 1-Nov are uploaded, the Summary moves to "Nov 2026" by itself (it always shows the month of the latest uploaded date). The day rows become 1-30 Nov.'],
    ['October', 'October data stays stored. In the Nov view, Oct becomes "LM" (Nov 1-x vs Oct 1-x) and Sep becomes "L2M". Pick "Oct 2026" in the Summary B1 dropdown any time to see the final October report.'],
    ['Files across the month end', 'A file covering e.g. 30-Oct to 2-Nov is fine: Oct dates go to October, Nov dates to November.'],
    ['Late Oct corrections', 'Re-upload Oct files (any date range) at any time, even in November. Only those dates are replaced; all other dates and November stay untouched. The Summary then shows October; choose Nov in B1 to go back.'],
    ['Nov estimate', 'From 1-Nov the estimate uses the last 4 weeks, which are October days, so it is meaningful from day 1. By 29-Nov the 4 weeks are all November days.'],
    ['Nov AOP', 'Type the Nov 2026 targets on the AOP sheet (row "Nov 2026"). Until then AOP lines show "-".'],
    ['Redo / older months', 'Any month can be redone by uploading its files. The Summary dropdown lists every month that has data.'],
    ['#', '6. CHECKS AND FIXES (Exceptions sheet)'],
    ['Totals check', 'Each upload is checked against the report footer totals (Vetbuddy Net Sales - Net Return, Gofrugal total, line counts). Any difference shows as NEEDS A LOOK.'],
    ['Unmapped clinic', 'A clinic / outlet with no unit keyword is listed and NOT counted. Fix: Settings > Clinic map, add a keyword and unit, upload again.'],
    ['Doctor name', 'Auto-corrected names and "close but not matched" names are listed for a quick check. Fix: Settings > Doctor names, upload again.'],
    ['Re-upload', 'Uploading the same files again never double counts - the uploaded dates are replaced, not added.'],
    ['#', '7. HOW IT IS BUILT'],
    ['Platform', 'One Google Sheet owned by sanchumarketing@gmail.com with an attached Apps Script. No desktop, Excel, macro or personal mail ID is needed. Team members use the sheet or the upload link without any Google permission prompt.'],
    ['Upload window', 'The files are read inside the browser (SheetJS). The rules above run there, and only the small daily unit totals are sent to the sheet - so big reports upload in seconds.'],
    ['Data sheet (hidden)', 'One row per date per unit: Vetbuddy, Gofrugal, Gofrugal returns (plus old history totals from the earlier Excel report). An upload replaces only the dates in the uploaded files, per source.'],
    ['VOW Doctors (hidden)', 'Date, unit, doctor code and name of every Vetbuddy VOW invoice - used for Gofrugal VOW matching.'],
    ['Undo Data / Undo VOW (hidden)', 'A copy of Data and VOW Doctors taken just before the last upload, used by Undo.'],
    ['Summary', 'Rebuilt by the script from Data + AOP after every upload, month change (B1) or AOP / Settings edit. Do not type on it - it is overwritten.'],
    ['Estimate Breakup', 'Rebuilt with the Summary: per-unit estimate breakup, reason for the change since the previous day, insights and the assumed value of each remaining day.'],
    ['Settings', 'Units and Y/N display, clinic keyword map, VOW item rules, doctor name overrides. Safe to edit.'],
    ['Menu', 'Sales Report > Upload & update report / Refresh Summary / Undo last upload / Rebuild How It Works sheet / Setup (repair).'],
    ['Do not', 'Do not rename sheets, delete hidden sheets or type in Summary / Estimate Breakup. To change rules use Settings.']
  ];
  ensureSize_(sh, T.length + 5, 3);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart().clearDataValidations();
  sh.clear();
  sh.getRange(1, 1, T.length, 2).setValues(T.map(function (x) { return [x[0] === '#' ? '' : x[0], x[1]]; })).setWrap(true).setVerticalAlignment('top');
  for (var i = 0; i < T.length; i++) {
    if (T[i][0] === '#') {
      sh.getRange(i + 1, 1, 1, 2).merge();
      sh.getRange(i + 1, 1).setValue(T[i][1]).setFontWeight('bold').setFontColor('white').setBackground(i === 0 ? '#C00000' : '#1F3864').setFontSize(i === 0 ? 13 : 11);
      sh.setRowHeight(i + 1, 28);
    } else {
      sh.getRange(i + 1, 1).setFontWeight('bold').setBackground('#D9E1F2');
    }
  }
  sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 900);
  sh.setFrozenRows(1);
}

/* ===================================================================
   CORE LOGIC - pure JavaScript (runs in the browser upload window AND
   in Apps Script). No Google services are used here.
   =================================================================== */
function CoreFactory() {
  'use strict';
  var DAY = 86400000, EPOCH = Date.UTC(1899, 11, 30);

  // ---------- small helpers ----------
  function trim(x) { return (x === null || x === undefined) ? '' : String(x).replace(/\s+/g, ' ').trim(); }
  function low(x) { return trim(x).toLowerCase(); }
  function num(x) { if (typeof x === 'number') return x; var n = Number(String(x).replace(/,/g, '')); return (x === '' || x === null || x === undefined || isNaN(n)) ? 0 : n; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function toDate(s) { return new Date(EPOCH + Math.round(s) * DAY); }
  function serial(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY); }
  function ymd(s) { var d = toDate(s); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: (d.getUTCDay() + 6) % 7 }; } // wd: Mon=0
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addMonths(s, k) { var a = ymd(s); var y = a.y, m = a.m + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return serial(y, m, Math.min(a.d, daysIn(y, m))); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function fmtDate(s) { var a = ymd(s); return (a.d < 10 ? '0' : '') + a.d + '-' + MON[a.m - 1] + '-' + a.y; }
  function monthKey(s) { var a = ymd(s); return a.y + '-' + (a.m < 10 ? '0' : '') + a.m; }
  function shiftMonth(key, k) { var y = +key.split('-')[0], m = +key.split('-')[1] + k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + (m < 10 ? '0' : '') + m; }
  function monthLabel(key) { var p = key.split('-'); return MON[+p[1] - 1] + ' ' + p[0]; }
  function inr(n) { // Indian grouping, no decimals
    var neg = n < 0, s = String(Math.round(Math.abs(n)));
    if (s.length > 3) { var last = s.slice(-3), rest = s.slice(0, -3); rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ','); s = rest + ',' + last; }
    return (neg ? '-' : '') + s;
  }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

  // ---------- doctor names ----------
  var STOP = { dr: 1, doctor: 1, vet: 1, walk: 1, 'in': 1, mr: 1, mrs: 1, ms: 1 };
  function pcode(name) { var m = (' ' + trim(name) + ' ').match(/[^a-z0-9](p0\d{4})(?![0-9])/i); return m ? m[1].toUpperCase() : ''; }
  function tokens(name) {
    return low(name).replace(/[.\-,_()\/]/g, ' ').split(' ').filter(function (t) {
      return t.length >= 3 && !STOP[t] && !/^\d/.test(t) && !/^.\d/.test(t);
    });
  }
  function lev(a, b) {
    var m = a.length, n = b.length, i, j, prev = [], cur;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) { cur = [i]; for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  }
  function sim(a, b) { return 1 - lev(a, b) / Math.max(a.length, b.length, 1); }
  function tokScore(a, b) {
    if (a === b) return 1;
    if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return 0.9;
    if (a.length >= 4 && b.length >= 4) { var s = 1 - lev(a, b) / Math.max(a.length, b.length); if (s >= 0.75) return s; }
    return 0;
  }

  // ---------- customers (24 Nov 2026: a Gofrugal bill follows its CUSTOMER's VetBuddy invoice) ----------
  // Only used to decide Vet on Wheels or clinic. The sales values are never changed.
  function phone10(x) {
    var d = String(typeof x === 'number' ? Math.round(x) : (x === null || x === undefined ? '' : x)).replace(/\D/g, '');
    return d.length >= 10 && /[6-9]/.test(d.charAt(d.length - 10)) ? d.slice(-10) : '';
  }
  var CSTOP = { mr: 1, mrs: 1, ms: 1, dr: 1, miss: 1, sir: 1, madam: 1 };
  var CNONE = { 'walk in': 1, walkin: 1, cash: 1, customer: 1, 'cash customer': 1, doctor: 1, test: 1, general: 1, na: 1, nil: 1 };
  function custName(x) {
    var s = low(x).replace(/[^a-z ]/g, ' ').split(' ').filter(function (w) { return w && !CSTOP[w]; }).join(' ');
    return s.length >= 3 && !CNONE[s] ? s : '';
  }

  // ---------- settings ----------
  function clinicUnit(name, settings) {
    var n = low(name);
    for (var i = 0; i < settings.clinicMap.length; i++) {
      var r = settings.clinicMap[i], k = low(r[0]);
      if (k && n.indexOf(k) >= 0) return { unit: trim(r[1]).toUpperCase(), vow: trim(r[2]).toUpperCase() };
    }
    return null;
  }
  function isVowItem(item, settings) {
    var t = low(item);
    for (var i = 0; i < settings.rules.length; i++) {
      var ty = low(settings.rules[i][0]), x = low(settings.rules[i][1]);
      if (!x) continue;
      if (ty === 'contains' && t.indexOf(x) >= 0) return true;
      if ((ty === 'starts with' || ty === 'startswith') && t.slice(0, x.length) === x) return true;
      if (ty === 'exact' && t === x) return true;
    }
    return false;
  }
  // a line of a Vet on Wheels invoice that is Non Clinical (Settings V:X), e.g. Plan category contains "Spa and Saloon"
  function isNonClinical(l, settings) {
    var rules = settings.ncRules || [];
    for (var i = 0; i < rules.length; i++) {
      var ty = low(rules[i][0]), where = low(rules[i][1]), x = low(rules[i][2]);
      if (!x) continue;
      var t = low(where.indexOf('sub') >= 0 ? l.sub : where.indexOf('item') >= 0 ? l.item : l.cat);
      if (ty === 'contains' && t.indexOf(x) >= 0) return true;
      if ((ty === 'starts with' || ty === 'startswith') && t.slice(0, x.length) === x) return true;
      if (ty === 'exact' && t === x) return true;
    }
    return false;
  }
  function aliasMap(settings) {
    var m = {};
    (settings.aliases || []).forEach(function (r) { if (trim(r[0]) && trim(r[1])) m[low(r[0])] = trim(r[1]).toUpperCase(); });
    return m;
  }
  function doctorId(name, aliases) { return aliases[low(name)] || pcode(name); }

  // ---------- report detection / extraction (raw sheet as array of rows) ----------
  function findRow(aoa, text) {
    for (var i = 0; i < Math.min(aoa.length, 60); i++) if (aoa[i] && low(aoa[i][0]) === low(text)) return i;
    return -1;
  }
  function findHdr(aoa, a, b) { // row containing both header texts in any column
    for (var i = 0; i < Math.min(aoa.length, 60); i++) {
      var r = (aoa[i] || []).map(low);
      if (r.indexOf(low(a)) >= 0 && (!b || r.indexOf(low(b)) >= 0)) return i;
    }
    return -1;
  }
  function detect(aoa) {
    if (findRow(aoa, 'Sr No.') >= 0) return 'VB';
    if (findHdr(aoa, 'Outlet Name', 'Return Date') >= 0) return 'GFR';
    if (findRow(aoa, 'Outlet Name') >= 0) return 'GF';
    return null;
  }
  function colMap(row, names, report) {
    var idx = {}, hdr = row.map(low);
    names.forEach(function (n) {
      var j = hdr.indexOf(low(n));
      if (j < 0) throw new Error(report + ' report: column "' + n + '" not found. Please upload the report exactly as downloaded.');
      idx[n] = j;
    });
    return idx;
  }
  function optCol(row, names) { var hdr = row.map(low); for (var i = 0; i < names.length; i++) { var j = hdr.indexOf(low(names[i])); if (j >= 0) return j; } return -1; }
  function extractVB(aoa) {
    var h = findRow(aoa, 'Sr No.');
    if (h < 0) throw new Error('This is not the Vetbuddy "Sales by plan item" report.');
    var c = colMap(aoa[h], ['Sr No.', 'Date', 'Invoice #', 'Services and Goods', 'Doctor', 'Billed Clinic', 'Net Sales', 'Net Return'], 'Vetbuddy');
    var cCat = optCol(aoa[h], ['Plan Category']), cSub = optCol(aoa[h], ['Plan SubCategory', 'Plan Sub Category']);   // optional (Non Clinical rules)
    var cPh = optCol(aoa[h], ['Primary Phone']), cCl = optCol(aoa[h], ['Client']);   // optional (customer match, 24 Nov 2026)
    var lines = [], footer = null, count = null;
    for (var i = 0; i < h; i++) { var m = trim(aoa[i] && aoa[i][0]).match(/Search Result\s*\((\d+)\)/i); if (m) count = +m[1]; }
    for (i = h + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      if (low(r[0]) === 'total') { footer = num(r[c['Net Sales']]) - num(r[c['Net Return']]); break; }
      if (!isNum(r[c['Sr No.']]) || !isNum(r[c['Date']])) continue;
      lines.push({ date: Math.floor(r[c['Date']]), inv: trim(r[c['Invoice #']]), item: r[c['Services and Goods']], doc: trim(r[c['Doctor']]),
                   clinic: trim(r[c['Billed Clinic']]), amt: num(r[c['Net Sales']]) - num(r[c['Net Return']]),
                   cat: cCat >= 0 ? trim(r[cCat]) : '', sub: cSub >= 0 ? trim(r[cSub]) : '',
                   ph: cPh >= 0 ? phone10(r[cPh]) : '', cust: cCl >= 0 ? custName(r[cCl]) : '' });
    }
    return { lines: lines, footer: footer, count: count };
  }
  function extractGF(aoa) {
    var h = findRow(aoa, 'Outlet Name');
    if (h < 0) throw new Error('This is not the Gofrugal "Sales Detail - Itemwise" report.');
    var c = colMap(aoa[h], ['Outlet Name', 'Bill Dt.', 'Item Amt BeforeTax', 'Doc Name(During Billing)'], 'Gofrugal');
    var lines = [], footer = null, cb = optCol(aoa[h], ['Bill No', 'Bill No.', 'Bill Number']);
    // optional customer columns (24 Nov 2026): phones, names, and the doctor's own numbers (never a customer)
    function cols(names) { return names.map(function (n) { return optCol(aoa[h], [n]); }).filter(function (j) { return j >= 0; }); }
    var cPhs = cols(['Telephone', 'Phone1', 'Mobile No/SMS Alerts', 'Mobile2']), cNms = cols(['Cust Name(During Billing)', 'Cust. Name']),
        cDph = cols(['Telephone (Doctor)', 'Mobile No (Doctor)']);
    for (var i = h + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      // the totals row has no outlet name; some exports put it right under the header, others at the end
      if (trim(r[c['Outlet Name']]) === '') { if (footer === null && isNum(r[c['Item Amt BeforeTax']])) footer = r[c['Item Amt BeforeTax']]; continue; }
      if (!isNum(r[c['Bill Dt.']])) continue;
      var keys = [], dph = [];
      cPhs.forEach(function (j) { var p = phone10(r[j]); if (p && keys.indexOf('p:' + p) < 0) keys.push('p:' + p); });
      cNms.forEach(function (j) { var n = custName(r[j]); if (n && keys.indexOf('n:' + n) < 0) keys.push('n:' + n); });
      cDph.forEach(function (j) { var p = phone10(r[j]); if (p) dph.push(p); });
      lines.push({ date: Math.floor(r[c['Bill Dt.']]), outlet: trim(r[c['Outlet Name']]), doc: trim(r[c['Doc Name(During Billing)']]), amt: num(r[c['Item Amt BeforeTax']]),
                   bill: cb >= 0 ? trim(r[cb]) : '', keys: keys, dph: dph });
    }
    return { lines: lines, footer: footer };
  }

  function extractGFR(aoa) {
    var h = findHdr(aoa, 'Outlet Name', 'Return Date');
    if (h < 0) throw new Error('This is not the Gofrugal "Sales Return Detail - Itemwise" report.');
    var c = colMap(aoa[h], ['Outlet Name', 'Return Date', 'Sub Total', 'Doctor Name'], 'Gofrugal Sales Return');
    var lines = [], footer = null, cb = optCol(aoa[h], ['Prefix_Ret.No', 'Ret. No.']), cs = optCol(aoa[h], ['Sold Billno']);
    for (var i = h + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      if (trim(r[c['Outlet Name']]) === '') { if (footer === null && isNum(r[c['Sub Total']])) footer = -r[c['Sub Total']]; continue; }
      if (!isNum(r[c['Return Date']])) continue;
      lines.push({ date: Math.floor(r[c['Return Date']]), outlet: trim(r[c['Outlet Name']]), doc: trim(r[c['Doctor Name']]), amt: -num(r[c['Sub Total']]),
                   bill: (cb >= 0 ? trim(r[cb]) : '') + (cs >= 0 && trim(r[cs]) ? ' (sold bill ' + trim(r[cs]) + ')' : '') });
    }
    return { lines: lines, footer: footer };
  }

  // ---------- main processing ----------
  // vb/gf: output of extractVB/extractGF (either may be null)
  // storedVowDocs: [[date, unit, id, name], ...] from earlier uploads (used when Vetbuddy is not uploaded for those dates)
  function process(vb, gf, settings, storedVowDocs, gfr) {
    var aliases = aliasMap(settings);
    // manual corrections (Settings Q:T): date + bill/invoice no -> 'vow' or 'clinic'
    var fixes = {};
    (settings.vowFix || []).forEach(function (r) { var d = Math.floor(+r[0]), n = low(r[1]), t = low(r[2]); if (d && n && (t === 'vow' || t === 'clinic')) fixes[d + '|' + n] = t; });
    function fixOf(d, no) { return fixes[d + '|' + low(no)] || ''; }
    var out = { vbDaily: {}, gfDaily: {}, gfrDaily: {}, vbRange: null, gfRange: null, gfrRange: null, vowDoctors: [], checks: [], unmapped: {},
                nameMatches: {}, possibleMisses: {}, stats: {}, vowVbInv: [], vowGfBills: [] };
    var vbAgg = {}, gfAgg = {};
    function addTo(map, d, u, a) { var k = d + '|' + u; map[k] = (map[k] || 0) + a; }
    function range(lines) { if (!lines.length) return null; var a = Infinity, b = -Infinity; lines.forEach(function (l) { if (l.date < a) a = l.date; if (l.date > b) b = l.date; }); return [a, b]; }
    var vowDocsByDay = {}; // date|unit -> [{id,name,toks}]
    var custIdx = {};      // date|unit|p:phone or n:name -> { v: first VOW invoice of that customer, c: 1 if a clinic invoice }
    function addVowDoc(d, u, id, name) {
      var k = d + '|' + u, list = vowDocsByDay[k] || (vowDocsByDay[k] = []);
      if (list.some(function (x) { return x.id === id; })) return;
      list.push({ id: id, name: name, toks: tokens(name) });
    }

    if (vb) {
      var vowInv = {}, vbTotal = 0, vowAmt = 0;
      var vowItemDoc = {};
      vb.lines.forEach(function (l) { if (isVowItem(l.item, settings)) { vowInv[l.inv] = 1; if (trim(l.doc)) vowItemDoc[l.inv] = 1; } });
      vb.lines.forEach(function (l) { var f = fixOf(l.date, l.inv); if (f === 'clinic') delete vowInv[l.inv]; else if (f === 'vow') vowInv[l.inv] = 1; });
      vb.lines.forEach(function (l) {
        var cu = clinicUnit(l.clinic, settings);
        vbTotal += l.amt;
        if (!cu) { out.unmapped['Vetbuddy: ' + l.clinic] = (out.unmapped['Vetbuddy: ' + l.clinic] || 0) + l.amt; return; }
        if (vowInv[l.inv]) {
          var ncs = settings.ncSplit, vu = ncs && ncs.units.indexOf(cu.vow) >= 0 && isNonClinical(l, settings) ? cu.vow + ncs.nc : cu.vow;
          addTo(out.vbDaily, l.date, vu, l.amt); vowAmt += l.amt;
          var ak = l.date + '|' + l.inv + '|' + vu, ag = vbAgg[ak] || (vbAgg[ak] = [l.date, l.inv, l.clinic, cu.unit, vu, l.doc, 0]);
          ag[6] += l.amt; if (!ag[5] && l.doc) ag[5] = l.doc;
          var id = doctorId(l.doc, aliases) || ('NAME:' + low(l.doc));
          // VOW doctor = the doctor billed on the VOW item lines (e.g. a registration line under another doctor does not count)
          if (trim(l.doc) && (!vowItemDoc[l.inv] || isVowItem(l.item, settings))) addVowDoc(l.date, cu.unit, id, l.doc);
        } else addTo(out.vbDaily, l.date, cu.unit, l.amt);
      });
      vb.lines.forEach(function (l) {
        var cu = clinicUnit(l.clinic, settings); if (!cu) return;
        [l.ph ? 'p:' + l.ph : '', l.cust ? 'n:' + l.cust : ''].forEach(function (k) {
          if (!k) return;
          var e = custIdx[l.date + '|' + cu.unit + '|' + k] || (custIdx[l.date + '|' + cu.unit + '|' + k] = { v: '', c: 0 });
          if (vowInv[l.inv]) e.v = e.v || l.inv; else e.c = 1;
        });
      });
      out.vbRange = range(vb.lines);
      out.vowVbInv = Object.keys(vbAgg).map(function (k) { return vbAgg[k]; });
      Object.keys(vowDocsByDay).forEach(function (k) { var p = k.split('|'); vowDocsByDay[k].forEach(function (x) { out.vowDoctors.push([+p[0], p[1], x.id, x.name]); }); });
      out.stats.vbLines = vb.lines.length; out.stats.vbTotal = vbTotal; out.stats.vbFooter = vb.footer; out.stats.vbCount = vb.count;
      out.stats.vowInvoices = Object.keys(vowInv).length; out.stats.vowVb = vowAmt;
    }
    if (gf) out.gfRange = range(gf.lines);
    if (gfr) { // returns replace the whole period covered by this upload (also when the return file has no lines)
      var rr = range(gfr.lines), gr = out.gfRange;
      out.gfrRange = rr && gr ? [Math.min(rr[0], gr[0]), Math.max(rr[1], gr[1])] : (rr || gr || out.vbRange);
    }
    // VOW doctors for Gofrugal dates not covered by this Vetbuddy upload come from earlier uploads
    (storedVowDocs || []).forEach(function (r) {
      var d = +r[0];
      var inG = (out.gfRange && d >= out.gfRange[0] && d <= out.gfRange[1]) || (out.gfrRange && d >= out.gfrRange[0] && d <= out.gfrRange[1]);
      if (inG && !(out.vbRange && d >= out.vbRange[0] && d <= out.vbRange[1])) addVowDoc(d, trim(r[1]).toUpperCase(), trim(r[2]), trim(r[3]));
    });
    // 24 Nov 2026 - VET ON WHEELS BY CUSTOMER. A Gofrugal bill is matched to the SAME customer's VetBuddy invoices
    // of the same date and clinic, by any phone column (Telephone, Phone1, Mobile, Mobile2 vs Primary Phone) or the
    // customer name (Cust Name vs Client). The customer has only a VOW invoice -> the bill is VOW; only clinic
    // invoices -> clinic. Both, or no customer found -> the doctor rule below (same doctor, same day, same clinic).
    // Not used as a match: a phone / name on more than 3 bills of that outlet that day (shared or default numbers)
    // and the doctors' own numbers. Sales values are never changed - only which unit gets them.
    function custDecisions(lines) {
      var bills = {}, use = {}, docPh = {}, res = {};
      lines.forEach(function (l) {
        var cu = clinicUnit(l.outlet, settings); if (!cu || !l.keys) return;
        var bk = l.date + '|' + l.outlet + '|' + l.bill, b = bills[bk] || (bills[bk] = { d: l.date, u: cu.unit, keys: {} });
        l.keys.forEach(function (k) { b.keys[k] = 1; });
        (l.dph || []).forEach(function (p) { docPh[p] = 1; });
      });
      Object.keys(bills).forEach(function (bk) { var b = bills[bk]; Object.keys(b.keys).forEach(function (k) { var uk = b.d + '|' + b.u + '|' + k; use[uk] = (use[uk] || 0) + 1; }); });
      Object.keys(bills).forEach(function (bk) {
        var b = bills[bk], v = '', by = '', c = 0;
        Object.keys(b.keys).forEach(function (k) {
          var uk = b.d + '|' + b.u + '|' + k;
          if (use[uk] > 3 || (k.charAt(0) === 'p' && docPh[k.slice(2)])) return;
          var e = custIdx[uk]; if (!e) return;
          if (e.v && !v) { v = e.v; by = k.charAt(0) === 'p' ? 'phone' : 'name'; }
          if (e.c) c = 1;
        });
        res[bk] = v && !c ? { vow: true, inv: v, by: by } : c && !v ? { vow: false } : null;
      });
      return res;
    }
    var saleVow = {};   // outlet|bill -> true/false: a return follows its sold bill when that bill is in this upload
    out.custMoves = [];
    function runGF(lines, daily, label) {
      var total = 0, vowId = 0, vowName = 0, dec = label === 'Gofrugal' ? custDecisions(lines) : {}, moved = {};
      lines.forEach(function (l) {
        var cu = clinicUnit(l.outlet, settings);
        total += l.amt;
        if (!cu) { out.unmapped[label + ': ' + l.outlet] = (out.unmapped[label + ': ' + l.outlet] || 0) + l.amt; return; }
        var fx = fixOf(l.date, String(l.bill).split(' (')[0]);
        var bk = l.date + '|' + l.outlet + '|' + l.bill, cd = fx ? null : dec[bk];
        if (!fx && !cd && label !== 'Gofrugal') {   // a return: same answer as its sold bill
          var sm = String(l.bill).match(/\(sold bill ([^)]+)\)/), sv = sm ? saleVow[l.outlet + '|' + trim(sm[1])] : undefined;
          if (sv !== undefined) cd = { vow: sv, inv: 'sold bill ' + trim(sm[1]), by: 'sold bill' };
        }
        var cands = fx ? [] : (vowDocsByDay[l.date + '|' + cu.unit] || []);
        var id = doctorId(l.doc, aliases), hit = fx === 'vow' ? { name: 'Manual correction (Settings)' } : null, how = fx === 'vow' ? 'manual' : '', near = 0;
        if (cands.length) {
          if (id) { hit = cands.filter(function (x) { return x.id === id; })[0] || null; how = 'id'; }
          else {
            var gt = tokens(l.doc), best = 0;
            if (gt.length) cands.forEach(function (x) {
              x.toks.forEach(function (t) { var sc = tokScore(gt[0], t); if (sc > best) { best = sc; hit = x; } var q = sim(gt[0], t); if (q > near) near = q; });
            });
            how = 'name';
          }
        }
        var docHit = !!hit;
        if (cd) {   // the customer decides (see custDecisions)
          if (cd.vow) { hit = { name: cd.by === 'sold bill' ? 'Same as ' + cd.inv : 'Customer of VOW invoice ' + cd.inv }; how = 'cust'; }
          else hit = null;
          if (docHit !== cd.vow && !moved[bk] && cd.by !== 'sold bill') {
            moved[bk] = 1;
            out.custMoves.push([l.date, l.bill, l.outlet, l.doc, cd.vow ? 'clinic -> VOW (customer of invoice ' + cd.inv + ', by ' + cd.by + ')' : 'VOW -> clinic (customer has clinic invoices only)']);
          }
        }
        if (label === 'Gofrugal') saleVow[l.outlet + '|' + l.bill] = !!hit;
        if (hit) {
          addTo(daily, l.date, cu.vow, l.amt);
          var ak = label + '|' + l.date + '|' + l.outlet + '|' + l.bill, bg = gfAgg[ak] ||
            (gfAgg[ak] = [l.date, label === 'Gofrugal' ? 'Sale' : 'Return', l.bill, l.outlet, cu.unit, cu.vow, l.doc, hit.name, how === 'id' ? 'Doctor code' : how === 'manual' ? 'Manual (Settings)' : how === 'cust' ? 'Customer (' + cd.by + ')' : 'Name auto-corrected', 0]);
          bg[9] += l.amt;
          if (how === 'id' || how === 'manual' || how === 'cust') vowId += l.amt; else {
            vowName += l.amt;
            var k = l.doc + '  ->  ' + hit.name, nm = out.nameMatches[k] || (out.nameMatches[k] = { lines: 0, amt: 0 });
            nm.lines++; nm.amt += l.amt;
          }
        } else {
          addTo(daily, l.date, cu.unit, l.amt);
          if (cands.length && !id && near >= 0.5) {
            var pm = out.possibleMisses[l.doc] || (out.possibleMisses[l.doc] = { lines: 0, amt: 0 });
            pm.lines++; pm.amt += l.amt;
          }
        }
      });
      return { total: total, vowId: vowId, vowName: vowName };
    }
    if (gf) {
      var g1 = runGF(gf.lines, out.gfDaily, 'Gofrugal');
      out.stats.gfLines = gf.lines.length; out.stats.gfTotal = g1.total; out.stats.gfFooter = gf.footer;
      out.stats.vowGfId = g1.vowId; out.stats.vowGfName = g1.vowName;
    }
    if (gfr) {
      var g2 = runGF(gfr.lines, out.gfrDaily, 'Gofrugal return');
      out.stats.gfrLines = gfr.lines.length; out.stats.gfrTotal = g2.total; out.stats.gfrFooter = gfr.footer;
      out.stats.vowGfrId = g2.vowId; out.stats.vowGfrName = g2.vowName;
    }

    out.vowGfBills = Object.keys(gfAgg).map(function (k) { return gfAgg[k]; });
    // ---------- checks ----------
    function chk(name, ok, detail) { out.checks.push([name, ok ? 'OK' : 'CHECK', detail]); }
    if (vb) {
      chk('Vetbuddy lines read = report count', vb.count === null || vb.count === vb.lines.length, vb.lines.length + ' of ' + (vb.count === null ? '?' : vb.count));
      chk('Vetbuddy total = report Total row (Net Sales - Net Return)', vb.footer === null || Math.abs(vb.footer - out.stats.vbTotal) < 1, inr(out.stats.vbTotal) + ' vs ' + (vb.footer === null ? 'no Total row' : inr(vb.footer)));
      var vr = out.vbRange, missing = [];
      if (vr) { var have = {}; vb.lines.forEach(function (l) { have[l.date] = 1; }); for (var d = vr[0]; d <= vr[1]; d++) if (!have[d]) missing.push(fmtDate(d)); }
      chk('Vetbuddy: no missing days', missing.length === 0, missing.length ? 'Missing: ' + missing.join(', ') : (vr ? fmtDate(vr[0]) + ' to ' + fmtDate(vr[1]) : 'no data'));
    }
    if (gfr) chk('Gofrugal returns total = report Total row (Sub Total)', gfr.footer === null || Math.abs(gfr.footer - out.stats.gfrTotal) < 1, inr(-out.stats.gfrTotal || 0) + ' vs ' + (gfr.footer === null ? 'no Total row' : inr(-gfr.footer)) + ' (' + gfr.lines.length + ' lines)');
    if (gf) chk('Gofrugal total = report Total row', gf.footer === null || Math.abs(gf.footer - out.stats.gfTotal) < 1, inr(out.stats.gfTotal || 0) + ' vs ' + (gf.footer === null ? 'no Total row' : inr(gf.footer)));
    if (vb && gf && out.vbRange && out.gfRange) chk('Both reports cover the same dates', out.vbRange[0] === out.gfRange[0] && out.vbRange[1] === out.gfRange[1],
      'Vetbuddy ' + fmtDate(out.vbRange[0]) + ' to ' + fmtDate(out.vbRange[1]) + ' | Gofrugal ' + fmtDate(out.gfRange[0]) + ' to ' + fmtDate(out.gfRange[1]));
    if (gf) chk('Vet on Wheels by customer (moved vs the doctor rule)', true, (out.custMoves || []).length ? out.custMoves.map(function (m) { return fmtDate(m[0]) + ' ' + m[1] + ' (' + m[3] + '): ' + m[4]; }).join('; ') : 'none');
    chk('All clinics / outlets mapped to a unit', Object.keys(out.unmapped).length === 0, Object.keys(out.unmapped).join('; ') || 'all mapped');
    return out;
  }

  // ---------- merge an upload into stored daily data ----------
  // rows: [[serial, unit, vb, gf, legacy], ...] -> returns new rows
  function merge(rows, up) {
    var map = {};
    function nv(x) { return x === '' || x === null || x === undefined ? '' : +x; }
    rows.forEach(function (r) { var k = r[0] + '|' + r[1]; map[k] = [+r[0], String(r[1]), nv(r[2]), nv(r[3]), nv(r[4]), nv(r[5])]; });
    function clear(rng, col) {
      if (!rng) return;
      Object.keys(map).forEach(function (k) { var r = map[k]; if (r[0] >= rng[0] && r[0] <= rng[1]) { r[col] = 0; r[4] = ''; } });
    }
    clear(up.vbRange, 2); clear(up.gfRange, 3); clear(up.gfrRange, 5);
    function add(daily, col) {
      Object.keys(daily).forEach(function (k) {
        var p = k.split('|'), key = p[0] + '|' + p[1];
        var r = map[key] || (map[key] = [+p[0], p[1], 0, 0, '', 0]);
        if (r[2] === '') r[2] = 0; if (r[3] === '') r[3] = 0; if (r[5] === '') r[5] = 0;
        r[col] += daily[k]; r[4] = '';
      });
    }
    add(up.vbDaily, 2); add(up.gfDaily, 3); add(up.gfrDaily || {}, 5);
    var out = Object.keys(map).map(function (k) { return map[k]; }).filter(function (r) {
      return !(r[4] === '' && !r[2] && !r[3] && !r[5]);
    });
    out.sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    return out;
  }
  // invoice-level VOW lists: replace only the dates covered by the uploaded file(s)
  function mergeVowVb(stored, up) {
    var rng = up.vbRange;
    if (!rng) return stored || [];
    return (stored || []).filter(function (r) { return !(+r[0] >= rng[0] && +r[0] <= rng[1]); }).concat(up.vowVbInv || [])
      .sort(function (a, b) { return a[0] - b[0] || String(a[1]).localeCompare(String(b[1])); });
  }
  function mergeVowGf(stored, up) {
    return (stored || []).filter(function (r) {
      var d = +r[0], rng = r[1] === 'Return' ? up.gfrRange : up.gfRange;
      return !(rng && d >= rng[0] && d <= rng[1]);
    }).concat(up.vowGfBills || []).sort(function (a, b) { return a[0] - b[0] || String(a[3]).localeCompare(String(b[3])) || String(a[2]).localeCompare(String(b[2])); });
  }
  function mergeVowDocs(stored, up) {
    var rng = up.vbRange;
    var keep = (stored || []).filter(function (r) { return !(rng && +r[0] >= rng[0] && +r[0] <= rng[1]); });
    return keep.concat(up.vowDoctors).sort(function (a, b) { return a[0] - b[0]; });
  }

  // ---------- summary model ----------
  // rows: stored daily data; aopRows: [[monthDate(serial or key), unit1, unit2...]] with header; shown: unit codes in order
  function summary(rows, aop, shown, month) {
    var tot = {}, vbm = {}, gfm = {}, legacyOnly = {}, months = {};
    rows.forEach(function (r) {
      var d = +r[0], u = String(r[1]).toUpperCase();
      var v = r[4] !== '' && r[4] !== null && r[4] !== undefined ? +r[4] : (+r[2] || 0) + (+r[3] || 0) + (+r[5] || 0);
      tot[d + '|' + u] = (tot[d + '|' + u] || 0) + v; tot[d + '|*'] = (tot[d + '|*'] || 0) + v;
      if (r[4] === '' || r[4] === null || r[4] === undefined) {
        vbm[d + '|' + u] = (vbm[d + '|' + u] || 0) + (+r[2] || 0); vbm[d + '|*'] = (vbm[d + '|*'] || 0) + (+r[2] || 0);
        var g = (+r[3] || 0) + (+r[5] || 0); gfm[d + '|' + u] = (gfm[d + '|' + u] || 0) + g; gfm[d + '|*'] = (gfm[d + '|*'] || 0) + g;
      } else legacyOnly[d] = 1;
      months[monthKey(d)] = 1;
    });
    var dataMonths = Object.keys(months).sort().reverse();
    if (!dataMonths.length) return null;
    // any month can be shown: months with data, the month after the latest data, or a month picked with the Next / Previous buttons
    if (!month || !/^\d{4}-\d{2}$/.test(month)) month = dataMonths[0];
    var ml = {}; dataMonths.forEach(function (k) { ml[k] = 1; }); ml[shiftMonth(dataMonths[0], 1)] = 1; ml[month] = 1;
    var monthList = Object.keys(ml).sort().reverse();
    var y = +month.split('-')[0], m = +month.split('-')[1], mStart = serial(y, m, 1), mEnd = serial(y, m, daysIn(y, m));
    var asOf = mStart - 1;
    Object.keys(tot).forEach(function (k) { var d = +k.split('|')[0]; if (d >= mStart && d <= mEnd && d > asOf) asOf = d; });
    function val(map, d, u) { return map[d + '|' + u] || 0; }
    function sum(map, u, a, b) { var s = 0; for (var d = a; d <= b; d++) s += val(map, d, u); return s; }
    var dayNo = asOf - mStart + 1, rem = mEnd - asOf;
    var lmS = addMonths(mStart, -1), lmE = addMonths(asOf, -1), l2S = addMonths(mStart, -2), l2E = addMonths(asOf, -2);
    var aopRow = null, aopHdr = aop && aop[0] ? aop[0].map(function (x) { return trim(x).toUpperCase(); }) : [];
    (aop || []).slice(1).forEach(function (r) { if (r[0] !== '' && r[0] !== null && aopKey(r[0]) === month) aopRow = r; });
    function aopKey(x) { if (typeof x === 'number') return monthKey(x); if (x instanceof Date) return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2); var t = trim(x); var mm = t.match(/^(\d{4})-(\d{2})/); if (mm) return mm[1] + '-' + mm[2]; var p = t.match(/([A-Za-z]{3})[a-z]*[\s\-']*(\d{2,4})/); if (p) { var mi = MON.map(function (z) { return z.toLowerCase(); }).indexOf(p[1].toLowerCase()); var yy = +p[2]; if (yy < 100) yy += 2000; if (mi >= 0) return yy + '-' + ('0' + (mi + 1)).slice(-2); } return ''; }
    function aopOf(u) { if (!aopRow) return null; var j = aopHdr.indexOf(u); if (j < 1) return null; var v = num(aopRow[j]); return v > 0 ? v : null; }
    // weekday averages over last 28 days ending asOf
    var remCount = [0, 0, 0, 0, 0, 0, 0];
    for (var d = asOf + 1; d <= mEnd; d++) remCount[ymd(d).wd]++;
    // estimate window = last 4 weeks ending on the latest sales date (for a month with no sales yet: the last date before it)
    var anchor = asOf;
    if (asOf < mStart) { anchor = -Infinity; Object.keys(tot).forEach(function (k) { var d = +k.split('|')[0]; if (d < mStart && d > anchor) anchor = d; }); if (!isFinite(anchor)) anchor = asOf; }
    function est(u) { var s = 0; for (var k = anchor - 27; k <= anchor; k++) s += val(tot, k, u) / 4 * remCount[ymd(k).wd]; return s; }
    var cols = shown.concat(['*']);
    var res = { month: month, monthLabel: monthLabel(month), monthList: monthList, dataMonths: dataMonths, empty: asOf < mStart, estAnchorText: fmtDate(anchor), asOf: asOf, asOfText: fmtDate(asOf), dayNo: dayNo,
                daysInMonth: mEnd - mStart + 1, remaining: rem, units: shown, days: [], rows: {}, legacyMonth: false };
    for (d = mStart; d <= mEnd; d++) {
      var a = ymd(d);
      res.days.push({ serial: d, label: fmtDate(d), dow: DOW[a.wd], values: d <= asOf ? cols.map(function (u) { return val(tot, d, u); }) : null });
      if (legacyOnly[d] && d <= asOf) res.legacyMonth = true;
    }
    var R = {};
    cols.forEach(function (u, i) {
      var mtd = sum(tot, u, mStart, asOf), lm = sum(tot, u, lmS, lmE), l2 = sum(tot, u, l2S, l2E), e = mtd + est(u);
      var ap = u === '*' ? (function () { var s = 0, any = false; shown.forEach(function (x) { var v = aopOf(x); if (v) { s += v; any = true; } }); return any ? s : null; })() : aopOf(u);
      R[u] = { mtd: mtd, lm: lm, l2m: l2, g1: lm ? mtd / lm - 1 : null, g2: l2 ? mtd / l2 - 1 : null, est: e, aop: ap,
               estVsAop: ap ? e / ap - 1 : null, balance: ap ? ap - mtd : null, reqPerDay: ap && rem > 0 ? Math.max(0, ap - mtd) / rem : null,
               ads: dayNo > 0 ? mtd / dayNo : 0, adsLm: dayNo > 0 ? lm / dayNo : 0, aopPerDay: ap ? ap / res.daysInMonth : null,
               vb: sum(vbm, u, mStart, asOf), gf: sum(gfm, u, mStart, asOf) };
      R[u].adsVsAop = R[u].aopPerDay ? R[u].ads / R[u].aopPerDay - 1 : null;
    });
    res.rows = R;
    var T = R['*'];
    res.labels = { mtd: MON[m - 1].toUpperCase() + ' MTD (1-' + ymd(asOf).d + ')',
                   lm: MON[ymd(lmS).m - 1].toUpperCase() + ' same days (1-' + ymd(lmE).d + ')',
                   l2m: MON[ymd(l2S).m - 1].toUpperCase() + ' same days (1-' + ymd(l2E).d + ')' };
    var a0 = ymd(asOf), dd = function (n) { return (n < 10 ? '0' : '') + n; };
    res.title = 'Division MTD as of ' + dd(a0.d) + '-' + dd(a0.m) + '-' + String(a0.y).slice(2);
    res.message = 'Sales were ' + inr(val(tot, asOf, '*')) +
      (res.legacyMonth ? '.' : '. In this Vetbuddy ' + inr(val(vbm, asOf, '*')) + ' and Gofrugal ' + inr(val(gfm, asOf, '*')) + '.');
    if (res.empty) {
      res.title = monthLabel(month) + ' - no sales uploaded yet (estimate = forecast from the 4 weeks to ' + fmtDate(anchor) + ')';
      res.message = 'No sales uploaded for ' + monthLabel(month) + ' yet.';
      res.labels.mtd = MON[m - 1].toUpperCase() + ' MTD';
    }
    res.mon = MON[m - 1].toUpperCase(); res.lmMon = MON[ymd(lmS).m - 1].toUpperCase(); res.l2mMon = MON[ymd(l2S).m - 1].toUpperCase();
    return res;
  }

  // ---------- estimate breakup: how the closure estimate is built and why it moved since the previous day ----------
  function estimateDetail(rows, aop, shown, month) {
    var tot = {}, months = {};
    rows.forEach(function (r) {
      var d = +r[0], u = String(r[1]).toUpperCase();
      var v = r[4] !== '' && r[4] !== null && r[4] !== undefined ? +r[4] : (+r[2] || 0) + (+r[3] || 0) + (+r[5] || 0);
      tot[d + '|' + u] = (tot[d + '|' + u] || 0) + v; tot[d + '|*'] = (tot[d + '|*'] || 0) + v; months[monthKey(d)] = 1;
    });
    var list = Object.keys(months).sort().reverse();
    if (!list.length) return null;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) month = list[0];
    var y = +month.split('-')[0], m = +month.split('-')[1], mStart = serial(y, m, 1), mEnd = serial(y, m, daysIn(y, m)), asOf = mStart - 1;
    Object.keys(tot).forEach(function (k) { var d = +k.split('|')[0]; if (d >= mStart && d <= mEnd && d > asOf) asOf = d; });
    function val(d, u) { return tot[d + '|' + u] || 0; }
    function avgs(end, u) { var a = [0, 0, 0, 0, 0, 0, 0]; for (var k = end - 27; k <= end; k++) a[ymd(k).wd] += val(k, u) / 4; return a; }
    function rem(from) { var c = [0, 0, 0, 0, 0, 0, 0]; for (var d = from; d <= mEnd; d++) c[ymd(d).wd]++; return c; }
    function sumR(a, c) { var s = 0; for (var i = 0; i < 7; i++) s += a[i] * c[i]; return s; }
    var S = summary(rows, aop, shown, month);
    var empty = asOf < mStart, anchor = asOf;
    if (empty) { anchor = -Infinity; Object.keys(tot).forEach(function (k) { var d = +k.split('|')[0]; if (d < mStart && d > anchor) anchor = d; }); if (!isFinite(anchor)) anchor = asOf; }
    var remNow = rem(asOf + 1), hasPrev = asOf - 1 >= mStart, remPrev = rem(asOf);
    var wdA = ymd(asOf).wd, dropped = asOf - 28;
    var res = { month: month, monthLabel: monthLabel(month), asOf: asOf, asOfText: fmtDate(asOf), prevText: hasPrev ? fmtDate(asOf - 1) : '',
                remaining: mEnd - asOf, daysInMonth: mEnd - mStart + 1, dayNo: asOf - mStart + 1, remCount: remNow, weekday: DOW[wdA],
                droppedText: fmtDate(dropped), windowText: fmtDate(anchor - 27) + ' to ' + fmtDate(anchor), empty: empty, units: shown, rows: {}, insights: [] };
    shown.concat(['*']).forEach(function (u) {
      var a = avgs(anchor, u), mtd = 0; for (var d = mStart; d <= asOf; d++) mtd += val(d, u);
      var estRem = sumR(a, remNow), est = mtd + estRem, R = { avg: a, mtd: mtd, estRem: estRem, est: est, aop: S.rows[u].aop };
      R.runRate = R.dayNo = null;
      R.runRate = res.dayNo > 0 ? mtd / res.dayNo * res.daysInMonth : 0;
      R.estVsAop = R.aop ? est / R.aop - 1 : null;
      R.reqPerDay = R.aop && res.remaining > 0 ? Math.max(0, R.aop - mtd) / res.remaining : null;
      R.usualLeft = res.remaining > 0 ? estRem / res.remaining : null;
      if (hasPrev) {
        var ap = avgs(asOf - 1, u), estP = (mtd - val(asOf, u)) + sumR(ap, remPrev);
        R.estPrev = estP; R.change = est - estP; R.actual = val(asOf, u); R.expected = ap[wdA];
        R.dayEffect = R.actual - R.expected; R.dropped = val(dropped, u); R.windowEffect = R.change - R.dayEffect;
      }
      res.rows[u] = R;
    });
    // insights (plain language)
    var T = res.rows['*'], I = res.insights;
    function L(u) { return u === '*' ? 'Network' : u; }
    I.push('Method: estimated closure = sales so far (' + inr(T.mtd) + ') + for each of the ' + res.remaining + ' remaining days, the average of the same weekday over the last 4 weeks (' + res.windowText + ').');
    if (empty) I.push('No sales uploaded for ' + res.monthLabel + ' yet - this is a full-month forecast from the last 4 weeks before the month. It becomes a normal estimate from the first upload of the month.');
    if (res.remaining > 0) {
      var best = 0, bi = 0; for (var i = 0; i < 7; i++) if (T.avg[i] > best) { best = T.avg[i]; bi = i; }
      var low = Infinity, li = 0; for (i = 0; i < 7; i++) if (T.avg[i] < low) { low = T.avg[i]; li = i; }
      I.push('Strongest day of the week right now: ' + DOW[bi] + ' (avg ' + inr(best) + '); weakest: ' + DOW[li] + ' (avg ' + inr(low) + '). Remaining days include ' +
        DOW.map(function (n, k) { return remNow[k] ? remNow[k] + ' ' + n : ''; }).filter(String).join(', ') + '.');
      if (!empty) I.push('Simple run-rate (avg daily so far x ' + res.daysInMonth + ' days) would give ' + inr(T.runRate) + ' - the weekday method gives ' + inr(T.est) +
        ' (' + (T.est >= T.runRate ? 'higher' : 'lower') + ' by ' + inr(Math.abs(T.est - T.runRate)) + ') because the remaining days are ' + (T.est >= T.runRate ? 'stronger' : 'weaker') + ' weekdays than the mix so far.');
    } else I.push('Month is complete - the closure is the actual month total, no estimate needed.');
    if (T.aop) I.push('Against AOP ' + inr(T.aop) + ': estimated closure is ' + (T.estVsAop >= 0 ? 'ahead by ' : 'short by ') + inr(Math.abs(T.est - T.aop)) + ' (' + pct(T.estVsAop) + ').' +
      (T.reqPerDay !== null ? ' To hit AOP the network needs ' + inr(T.reqPerDay) + '/day for the rest of the month vs a usual ' + inr(T.usualLeft) + '/day.' : ''));
    var risk = shown.filter(function (u) { return res.rows[u].aop && res.rows[u].estVsAop < 0; });
    if (risk.length) I.push('Units estimated BELOW AOP: ' + risk.map(function (u) { var r = res.rows[u]; return u + ' (' + pct(r.estVsAop) + ', needs ' + inr(r.reqPerDay || 0) + '/day vs usual ' + inr(r.usualLeft || 0) + ')'; }).join('; ') + '.');
    else if (shown.some(function (u) { return res.rows[u].aop; })) I.push('All units with an AOP are estimated at or above target.');
    if (hasPrev) {
      I.push('Change since previous day (' + res.prevText + ' -> ' + res.asOfText + '): network estimate moved ' + (T.change >= 0 ? '+' : '-') + inr(Math.abs(T.change)) + '. ' +
        res.asOfText + ' (' + res.weekday + ') sold ' + inr(T.actual) + ' vs a usual ' + res.weekday + ' of ' + inr(T.expected) + ' (' + (T.dayEffect >= 0 ? '+' : '-') + inr(Math.abs(T.dayEffect)) + '). ' +
        'The 4-week window also swapped ' + res.droppedText + ' (' + inr(T.dropped) + ') for ' + res.asOfText + ', changing the remaining ' + res.weekday + 's by ' + (T.windowEffect >= 0 ? '+' : '-') + inr(Math.abs(T.windowEffect)) + '.');
      var movers = shown.map(function (u) { return [u, res.rows[u].change]; }).sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).slice(0, 3);
      movers.forEach(function (mv) {
        var r = res.rows[mv[0]];
        I.push(L(mv[0]) + ': estimate ' + (r.change >= 0 ? '+' : '-') + inr(Math.abs(r.change)) + ' - sold ' + inr(r.actual) + ' vs usual ' + inr(r.expected) + ' on ' + res.weekday +
          (Math.abs(r.windowEffect) >= 1 ? '; window refresh ' + (r.windowEffect >= 0 ? '+' : '-') + inr(Math.abs(r.windowEffect)) + ' (dropped ' + res.droppedText + ': ' + inr(r.dropped) + ')' : '') + '.');
      });
      var zero = shown.filter(function (u) { return res.rows[u].actual === 0 && res.rows[u].expected > 0; });
      if (zero.length) I.push('No sales on ' + res.asOfText + ' for: ' + zero.join(', ') + ' - check if closed or report missing.');
    }
    return res;
  }

  return { detect: detect, estimateDetail: estimateDetail, extractVB: extractVB, extractGF: extractGF, extractGFR: extractGFR, process: process, merge: merge, mergeVowDocs: mergeVowDocs, mergeVowVb: mergeVowVb, mergeVowGf: mergeVowGf,
           summary: summary, shiftMonth: shiftMonth, fmtDate: fmtDate, monthKey: monthKey, monthLabel: monthLabel, inr: inr, serial: serial, ymd: ymd,
           tokens: tokens, pcode: pcode, tokScore: tokScore, clinicUnit: clinicUnit };
}


var BUTTON_PNG = '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';
var UNDO_PNG = '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';
