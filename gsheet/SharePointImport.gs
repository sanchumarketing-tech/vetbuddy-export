/* ===================================================================
   AUTO IMPORT FROM SHAREPOINT  (morning, ~9:00 AM India time)
   Takes the files the GitHub automation puts in SharePoint each morning:
     Sales Reports Sanchu / CRM Upload       VetBuddy_GoodsServices_MTD_<from>_to_<to>.xlsx
     Sales Reports Sanchu / Gofrugal Upload  Gofrugal_Pharmacy_MTD_<from>_to_<to>.xlsx
                                             (sheet "Sales" = 3111, sheet "Returns" = 3126)
   and runs exactly what "Upload & update report" does (same rules in CoreFactory,
   same saveUpload, so "Undo last upload" works for it too).

   Timing: a daily trigger wakes up between 8:15 and 8:45 and books a one-time run for
   9:00:00. If the files for yesterday are not in SharePoint yet, it tries again every
   15 minutes until 2 PM; as soon as they arrive, the report is updated.
   Each run is written to the sheet "Auto Import Log".

   Setup (once): menu Sales Report > SharePoint auto import >
     1. Set SharePoint login   (tenant ID, client ID, client secret of the Azure app)
     2. Turn ON daily 9 AM import
     3. Import from SharePoint now  (to test)
   =================================================================== */

var SPI = {
  TZ: 'Asia/Kolkata',
  SITE: 'sanchuhospital.sharepoint.com:/sites/SalesTeam',
  LIBRARY: 'Sales Reports Sanchu',
  VB_FOLDER: 'CRM Upload',
  GF_FOLDER: 'Gofrugal Upload',
  VB_RE: /^VetBuddy_GoodsServices_MTD_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.xlsx$/i,
  GF_RE: /^Gofrugal_Pharmacy_MTD_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.xlsx$/i,
  RUN_AT: [9, 0],          // 9:00 AM
  RETRY_MIN: 15,           // try again every 15 min when the files are not there yet
  LAST_TRY_HOUR: 14,       // ... until 2 PM, then import whatever is there and stop
  LOG_SHEET: 'Auto Import Log',
  SHEETJS: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'  // same library as the upload window
};

// ---------------- menu actions ----------------
function spiSetCredentials() {
  var ui = SpreadsheetApp.getUi(), p = PropertiesService.getScriptProperties();
  var keys = [['SP_TENANT_ID', 'Directory (tenant) ID'], ['SP_CLIENT_ID', 'Application (client) ID'], ['SP_CLIENT_SECRET', 'Client secret VALUE']];
  for (var i = 0; i < keys.length; i++) {
    var r = ui.prompt('SharePoint login (' + (i + 1) + '/3)', keys[i][1] + ' of the Azure app "VetBuddy Export"' +
                      (p.getProperty(keys[i][0]) ? '\n(already set - leave empty to keep it)' : ''), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = r.getResponseText().trim();
    if (v) p.setProperty(keys[i][0], v);
  }
  try { spiToken_(); ui.alert('SharePoint login works.'); }
  catch (e) { ui.alert('SharePoint login did NOT work:\n' + e.message); }
}

function spiInstall() {
  spiRemoveTriggers_(['spiDaily', 'spiRun']);
  ScriptApp.newTrigger('spiDaily').timeBased().atHour(SPI.RUN_AT[0] - 1).nearMinute(30).everyDays(1).inTimezone(SPI.TZ).create();
  SpreadsheetApp.getUi().alert('Daily import is ON.\nEvery morning at 9:00 AM the report is updated from SharePoint ' +
    '(if the files are late, it retries every 15 minutes until 2 PM).\nSee the sheet "' + SPI.LOG_SHEET + '".');
}

function spiUninstall() {
  spiRemoveTriggers_(['spiDaily', 'spiRun']);
  SpreadsheetApp.getUi().alert('Daily import is OFF.');
}

// manual: newest files in the two folders, whatever their dates
function spiImportNow() {
  var ui = SpreadsheetApp.getUi();
  var r = spiImport_(null, true);
  ui.alert(r.msg);
}

function spiStatus() {
  var t = ScriptApp.getProjectTriggers().filter(function (x) { return x.getHandlerFunction() === 'spiDaily'; }).length;
  var last = PropertiesService.getScriptProperties().getProperty('SPI_LAST') || 'never';
  SpreadsheetApp.getUi().alert('Daily 9 AM import: ' + (t ? 'ON' : 'OFF') + '\nLast successful import: ' + last);
}

// ---------------- triggers ----------------
// daily, between 8:15 and 8:45 -> book the run for 9:00:00 sharp
function spiDaily() {
  spiRemoveTriggers_(['spiRun']);
  var at = spiTodayAt_(SPI.RUN_AT[0], SPI.RUN_AT[1]);
  if (at.getTime() - Date.now() < 60000) return spiRun();
  ScriptApp.newTrigger('spiRun').timeBased().at(at).create();
}

// 9:00 run (and the 15-minute retries)
function spiRun() {
  spiRemoveTriggers_(['spiRun']);
  var p = PropertiesService.getScriptProperties();
  var today = spiDay_(0), want = spiDay_(-1);
  if (p.getProperty('SPI_DONE_DATE') === today) return;          // already updated today
  var lastTry = Number(Utilities.formatDate(new Date(), SPI.TZ, 'H')) >= SPI.LAST_TRY_HOUR;
  var r;
  try {
    r = spiImport_(want, lastTry);
  } catch (e) {
    r = { done: false, msg: 'ERROR: ' + e.message };
    spiLog_('', '', r.msg);
    if (lastTry) throw e;                                          // Google emails the owner
  }
  if (r.done) { p.setProperty('SPI_DONE_DATE', today); return; }
  if (!lastTry) ScriptApp.newTrigger('spiRun').timeBased().after(SPI.RETRY_MIN * 60 * 1000).create();
}

// ---------------- the import ----------------
// want: 'yyyy-MM-dd' = the "to" date the files must have (null = newest file)
// force: import even if only one of the two files is there
function spiImport_(want, force) {
  var g = spiGraph_();
  var vbF = spiPick_(g, SPI.VB_FOLDER, SPI.VB_RE, want);
  var gfF = spiPick_(g, SPI.GF_FOLDER, SPI.GF_RE, want);
  if (!vbF && !gfF) {
    var m = 'No ' + (want ? 'files up to ' + want : 'files') + ' in SharePoint yet (' + SPI.VB_FOLDER + ' / ' + SPI.GF_FOLDER + ').';
    spiLog_('', '', m + (force ? '' : ' Will try again.'));
    return { done: false, msg: m };
  }
  if ((!vbF || !gfF) && !force) {
    spiLog_(vbF ? vbF.name : '', gfF ? gfF.name : '', 'Waiting for the ' + (vbF ? 'Gofrugal' : 'VetBuddy') + ' file. Will try again.');
    return { done: false, msg: 'waiting' };
  }

  var XLSX = spiXlsx_(), C = CoreFactory(), vb = null, gf = null, gfr = null, notes = [];
  if (vbF) {
    var aoa = spiSheet_(XLSX, spiRead_(XLSX, spiDownload_(vbF)), null);
    if (C.detect(aoa) !== 'VB') throw new Error(vbF.name + ' is not a VetBuddy report (no "Sr No." header).');
    vb = C.extractVB(aoa);
    if (!vb.lines.length) throw new Error(vbF.name + ' has no sales lines.');
  }
  if (gfF) {
    var wb = spiRead_(XLSX, spiDownload_(gfF));
    var sales = spiSheet_(XLSX, wb, 'Sales'), rets = spiSheet_(XLSX, wb, 'Returns');
    if (C.detect(sales) === 'GF') gf = C.extractGF(sales); else notes.push('no Gofrugal sales lines');
    gfr = C.detect(rets) === 'GFR' ? C.extractGFR(rets) : { lines: [], footer: null };   // "No returns in this period"
    if (gf && !gf.lines.length) gf = null;
  }

  // same as the upload window: VOW doctors of earlier uploads for the Gofrugal dates
  var from = Infinity, to = 0;
  [gf, gfr].forEach(function (x) { (x ? x.lines : []).forEach(function (l) { if (l.date < from) from = l.date; if (l.date > to) to = l.date; }); });
  var ctx = getContext(isFinite(from) ? from : null, to || null);
  var up = C.process(vb, gf, ctx.settings, ctx.vowDocs, gfr);
  var res = saveUpload(up);

  var msg = (res.ok ? 'Updated' : 'Updated - some checks need a look (see Exceptions)') + ': Summary shows ' + res.month + ' up to ' + res.upto +
            ' | VetBuddy ' + (vb ? vb.lines.length + ' lines' : 'not imported') + ', Gofrugal ' + (gf ? gf.lines.length : 0) +
            ' sales / ' + (gfr ? gfr.lines.length : 0) + ' return lines' + (notes.length ? ' (' + notes.join(', ') + ')' : '');
  spiLog_(vbF ? vbF.name : '', gfF ? gfF.name : '', msg);
  PropertiesService.getScriptProperties().setProperty('SPI_LAST', Utilities.formatDate(new Date(), SPI.TZ, 'dd-MM-yyyy HH:mm') + ' - ' + msg);
  return { done: true, msg: msg };
}

// newest matching file in a folder (with the wanted "to" date, if given)
function spiPick_(g, folder, re, want) {
  var url = 'https://graph.microsoft.com/v1.0/drives/' + g.drive + '/root:/' + encodeURIComponent(folder) + ':/children?$top=200';
  var items = [];
  while (url) { var j = spiGet_(url, g.token); items = items.concat(j.value || []); url = j['@odata.nextLink']; }
  var best = null;
  items.forEach(function (it) {
    var m = it.file && String(it.name).match(re);
    if (!m || (want && m[2] !== want)) return;
    if (!best || it.lastModifiedDateTime > best.lastModifiedDateTime) best = it;
  });
  return best;
}

function spiDownload_(item) {
  var url = item['@microsoft.graph.downloadUrl'];           // pre-signed, no login needed
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Download of ' + item.name + ' failed: HTTP ' + r.getResponseCode());
  return r.getBlob().getBytes();
}

function spiRead_(XLSX, bytes) {
  return XLSX.read(Utilities.base64Encode(bytes), { type: 'base64', cellText: false, cellNF: false });
}
// one sheet -> rows, exactly like the upload window (raw values, dates as serial numbers)
function spiSheet_(XLSX, wb, name) {
  var ws = wb.Sheets[name || wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

var SPI_XLSX_ = null;
function spiXlsx_() {
  if (SPI_XLSX_) return SPI_XLSX_;
  var src = UrlFetchApp.fetch(SPI.SHEETJS).getContentText();
  // exports/module/define/require hidden so the library puts itself into the local XLSX
  SPI_XLSX_ = new Function('exports', 'module', 'define', 'require', src + '\n;return XLSX;')();
  if (!SPI_XLSX_ || !SPI_XLSX_.read) throw new Error('Could not load the Excel reader (SheetJS).');
  return SPI_XLSX_;
}

// ---------------- Microsoft Graph ----------------
function spiToken_() {
  var p = PropertiesService.getScriptProperties();
  var t = p.getProperty('SP_TENANT_ID'), id = p.getProperty('SP_CLIENT_ID'), sec = p.getProperty('SP_CLIENT_SECRET');
  if (!t || !id || !sec) throw new Error('SharePoint login not set. Menu Sales Report > SharePoint auto import > Set SharePoint login.');
  var r = UrlFetchApp.fetch('https://login.microsoftonline.com/' + encodeURIComponent(t) + '/oauth2/v2.0/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: id, client_secret: sec, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }
  });
  var j = JSON.parse(r.getContentText());
  if (!j.access_token) throw new Error('Microsoft login failed: ' + (j.error_description || j.error || r.getResponseCode()).toString().split('\r')[0]);
  return j.access_token;
}

function spiGraph_() {
  var token = spiToken_();
  var site = spiGet_('https://graph.microsoft.com/v1.0/sites/' + SPI.SITE + '?$select=id', token);
  var drives = spiGet_('https://graph.microsoft.com/v1.0/sites/' + site.id + '/drives?$select=id,name,webUrl', token).value || [];
  var d = drives.filter(function (x) {
    return x.name === SPI.LIBRARY || decodeURIComponent(String(x.webUrl).split('/').pop()) === SPI.LIBRARY;
  })[0];
  if (!d) throw new Error('Library "' + SPI.LIBRARY + '" not found. Available: ' + drives.map(function (x) { return x.name; }).join(', '));
  return { token: token, drive: d.id };
}

function spiGet_(url, token) {
  for (var i = 0; i < 3; i++) {
    var r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    var c = r.getResponseCode();
    if (c === 200) return JSON.parse(r.getContentText());
    if (c !== 429 && c < 500) throw new Error('SharePoint ' + c + ': ' + r.getContentText().slice(0, 300));
    Utilities.sleep(5000 * (i + 1));
  }
  throw new Error('SharePoint not answering (' + c + ')');
}

// ---------------- helpers ----------------
function spiDay_(k) { return Utilities.formatDate(new Date(Date.now() + k * 864e5), SPI.TZ, 'yyyy-MM-dd'); }
function spiTodayAt_(h, m) {
  return new Date(spiDay_(0) + 'T' + ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2) + ':00+05:30');
}
function spiRemoveTriggers_(names) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (names.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
}
function spiLog_(vbName, gfName, msg) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SPI.LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SPI.LOG_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['Time (IST)', 'VetBuddy file', 'Gofrugal file', 'Result']]).setFontWeight('bold');
    sh.setFrozenRows(1); sh.setColumnWidth(1, 140); sh.setColumnWidths(2, 2, 330); sh.setColumnWidth(4, 600);
  }
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 4).setValues([[Utilities.formatDate(new Date(), SPI.TZ, 'dd-MM-yyyy HH:mm'), vbName, gfName, msg]]);
  if (sh.getMaxRows() > 400) sh.deleteRows(401, sh.getMaxRows() - 400);
}
