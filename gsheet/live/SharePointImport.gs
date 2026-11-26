/* ===================================================================
   AUTO IMPORT FROM SHAREPOINT  (morning, ~9:00 AM India time)
   Takes the files the GitHub automation puts in SharePoint each morning:
     Sales Reports Sanchu / CRM Upload       VetBuddy_GoodsServices_MTD_<from>_to_<to>.xlsx
     Sales Reports Sanchu / Gofrugal Upload  Gofrugal_Pharmacy_MTD_<from>_to_<to>.xlsx
                                             (sheet "Sales" = 3111, sheet "Returns" = 3126)
   and runs exactly what "Upload & update report" does (same rules in CoreFactory,
   same saveUpload, so "Undo last upload" works for it too).

   Timing: a daily trigger wakes up between 8:15 and 8:45 and books a one-time run for
   9:00:00. If the files for yesterday are not in SharePoint yet, it tries once more at 9:30 AM
   (20-11-2026: two tries only); after that there is no report that day.
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
  SECOND_TRY: [9, 30],     // 20-11-2026: two tries only - 9:00 and 9:30 AM; then no report that day (never a half report)
  LOG_SHEET: 'Auto Import Log',
  SHEETJS: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'  // same library as the upload window
};

// ---------------- menu actions ----------------
function spiSetCredentials() {
  spiAskScopes_();
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
  spiAskScopes_();
  spiRemoveTriggers_(['spiDaily', 'spiRun']);
  ScriptApp.newTrigger('spiDaily').timeBased().atHour(SPI.RUN_AT[0] - 1).nearMinute(30).everyDays(1).inTimezone(SPI.TZ).create();
  SpreadsheetApp.getUi().alert('Daily import is ON.\nEvery morning at 9:00 AM the report is updated from SharePoint ' +
    '(if the files are late, it tries once more at 9:30 AM, then stops for the day).\nSee the sheet "' + SPI.LOG_SHEET + '".');
}

function spiUninstall() {
  spiRemoveTriggers_(['spiDaily', 'spiRun']);
  SpreadsheetApp.getUi().alert('Daily import is OFF.');
}

// manual: newest files in the two folders, whatever their dates
function spiImportNow() {
  spiAskScopes_();
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
  // 20-11-2026: two tries only (9:00 and 9:30 AM), both files needed - never a report with half the sales
  var second = spiTodayAt_(SPI.SECOND_TRY[0], SPI.SECOND_TRY[1]).getTime();
  var lastTry = Date.now() >= second - 5 * 60000;
  // 26-11-2026: the next try is booked BEFORE the import, so a Google server error in the middle of the import
  // ("We're sorry, a server error occurred") can no longer skip the 9:30 try. After the 9:30 try there is one
  // safety re-run 20 minutes later, used only when that try crashed - never when the files are missing.
  var crashRetry = lastTry && p.getProperty('SPI_CRASH_DATE') !== today;
  if (!lastTry) ScriptApp.newTrigger('spiRun').timeBased().at(new Date(second)).create();
  else if (crashRetry) { p.setProperty('SPI_CRASH_DATE', today); ScriptApp.newTrigger('spiRun').timeBased().after(20 * 60000).create(); }
  var r;
  try {
    r = spiImport_(want, false);
  } catch (e) {
    r = { done: false, msg: 'ERROR: ' + e.message };
    var again = !lastTry || crashRetry;
    try { spiLog_('', '', r.msg + (again ? ' Will try again.' : '')); } catch (e2) {}
    if (!again) throw e;                                           // Google emails the owner
    return;                                                        // the next try is already booked
  }
  if (!r.done && r.gfMissing) { try { spiGfAlert_(today); } catch (e) { spiLog_('', '', 'Gofrugal delay alert FAILED: ' + e.message); } }
  if (r.done) {
    p.setProperty('SPI_DONE_DATE', today);
    spiRemoveTriggers_(['spiRun']);                                // the booked retry is not needed
    // 19-11-2026: posting runs as its own execution 1 minute later, so a slow import cannot use up
    // the 6-minute Apps Script limit and block the Supabase update / Teams / WhatsApp posts.
    spiRemoveTriggers_(['spiPost']);
    ScriptApp.newTrigger('spiPost').timeBased().after(60 * 1000).create();
    return;
  }
  if (lastTry) { spiRemoveTriggers_(['spiRun']); spiStopped_(today); return; }   // files still missing: stop for the day
  // not the last try: the 9:30 try is already booked
}

function spiStopped_(today) {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('SPI_STOP_DATE') === today) return;
  p.setProperty('SPI_STOP_DATE', today);
  spiLog_('', '', 'Stopped: the files were not complete at the 9:30 AM try - no sales report today.');
}

// after a successful import: the picture to WhatsApp (once a day)
function spiPost() {
  spiRemoveTriggers_(['spiPost']);
  var p = PropertiesService.getScriptProperties(), today = spiDay_(0);
  if (p.getProperty('SPI_POSTED_DATE') === today) return;          // already posted today
  // 25-11-2026: the Teams chatbot (Supabase sheet-numbers push) and the Teams report post were removed - WhatsApp only
  if (!waReady_()) return;
  // 26-11-2026: up to 3 tries, 10 minutes apart; the next try is booked first, so a Google error cannot lose the post
  var t = (p.getProperty('SPI_POST_TRY') || '').split('|'), n = t[0] === today ? Number(t[1]) + 1 : 1;
  p.setProperty('SPI_POST_TRY', today + '|' + n);
  if (n < 3) ScriptApp.newTrigger('spiPost').timeBased().after(10 * 60000).create();
  var shot;
  try { shot = snapImage_(today); } catch (e) { spiLog_('', '', 'Picture FAILED (try ' + n + '/3): ' + e.message); return; }
  try { waSend_(shot.img, waTitle_()); } catch (e) { spiLog_('', '', 'WhatsApp post FAILED (try ' + n + '/3): ' + e.message); return; }
  p.setProperty('SPI_POSTED_DATE', today);
  spiRemoveTriggers_(['spiPost']);
}

/* ---------------- Gofrugal sync mail (19-11-2026) ----------------
   If Gofrugal's data sync is still behind, mail IT, the data analyst and Shenbagaraj at 8:15 AM (26-11-2026: was 7:55),
   naming the outlets (units) that are behind. If today's check is not saved yet, it looks again at 8:45 before mailing.
   The GitHub job saves the sync state in SharePoint: Sales Reports Sanchu / Gofrugal Upload / Gofrugal_Sync_Status.json.
   Setup once: run spiSyncMailInstall from the editor and approve "send email as you". */
var SPI_MAIL_TO = 'it@sanchu.co.in,dataanalyst@sanchu.co.in,shenbagaraj@sanchu.co.in';
var SPI_MAIL_AT = [8, 15];   // 26-11-2026: was 7:55 - the GitHub export (starts ~7:55) saves today's sync check at ~8:00

function spiSyncMailInstall() {
  MailApp.getRemainingDailyQuota();                       // asks for the mail permission once
  spiRemoveTriggers_(['spiMailDaily', 'spiSyncMail']);
  ScriptApp.newTrigger('spiMailDaily').timeBased().atHour(6).nearMinute(30).everyDays(1).inTimezone(SPI.TZ).create();
  console.log('Gofrugal sync mail is ON: daily check at ' + SPI_MAIL_AT.join(':') + ' to ' + SPI_MAIL_TO);
}

function spiMailDaily() {
  spiRemoveTriggers_(['spiSyncMail']);
  ScriptApp.newTrigger('spiSyncMail').timeBased().at(spiTodayAt_(SPI_MAIL_AT[0], SPI_MAIL_AT[1])).create();
}

function spiSyncMail() {
  spiRemoveTriggers_(['spiSyncMail']);
  var p = PropertiesService.getScriptProperties(), today = spiDay_(0), want = spiDay_(-1);
  if (p.getProperty('SPI_MAIL_DATE') === today) return;
  var g = spiGraph_();
  if (spiPick_(g, SPI.GF_FOLDER, SPI.GF_RE, want)) return;              // the Gofrugal file is there: synced and downloaded
  var st = null;
  try {
    var r = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0/drives/' + g.drive + '/root:/' + encodeURIComponent(SPI.GF_FOLDER) +
                              '/Gofrugal_Sync_Status.json:/content', { headers: { Authorization: 'Bearer ' + g.token }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) st = JSON.parse(r.getContentText());
  } catch (e) { st = null; }
  // 26-11-2026: no check from today yet (the export is late) - look again once at 8:45 before mailing
  if (!(st && st.date === today) && p.getProperty('SPI_MAIL_WAIT') !== today) {
    p.setProperty('SPI_MAIL_WAIT', today);
    ScriptApp.newTrigger('spiSyncMail').timeBased().at(spiTodayAt_(8, 45)).create();
    return;
  }
  var lines = [], units = [];
  if (st && st.date === today && st.state === 'behind') {
    units = (st.behind || []).map(function (o) { return String(o.outlet).replace(/^Sanchu\s+/i, ''); });
    lines.push('Gofrugal data sync is not complete. Every outlet must show "Data as on" ' + st.needed + ' or later before the pharmacy');
    lines.push('report (3111 / 3126) is downloaded. Last check: ' + st.checked_at + '.', '', 'Outlets behind:');
    (st.behind || []).forEach(function (o) { lines.push('  ' + o.outlet + ' - data as on ' + (o.data_as_on || '-') + ' (' + o.status + ')'); });
  } else if (st && st.date === today && st.state === 'ok') {
    return;                                                               // synced; the download is on its way
  } else {
    lines.push('The Gofrugal file for ' + want + ' is not in SharePoint yet and no sync check has been recorded today.');
    if (st && st.behind && st.behind.length) {
      units = st.behind.map(function (o) { return String(o.outlet).replace(/^Sanchu\s+/i, ''); });
      lines.push('', 'Last check (' + st.checked_at + ') - outlets behind:');
      st.behind.forEach(function (o) { lines.push('  ' + o.outlet + ' - data as on ' + (o.data_as_on || '-') + ' (' + o.status + ')'); });
    }
  }
  lines.push('', 'Backup status Active and Backup request - Incremental have been sent automatically; the job keeps retrying',
             '(no report that day if still not synced by the 9:30 AM try). Please check the shop systems / internet.',
             'The 9 AM WhatsApp sales report waits for the Gofrugal file.');
  var subj = 'Gofrugal data not synced - ' + today + (units.length ? ' - ' + units.join(', ') : '');
  MailApp.sendEmail(SPI_MAIL_TO, subj, lines.join('\n'));
  p.setProperty('SPI_MAIL_DATE', today);
  spiLog_('', '', 'Gofrugal sync mail sent to ' + SPI_MAIL_TO + (units.length ? ' (units: ' + units.join(', ') + ')' : ''));
}

// 19-11-2026: the GitHub job uploads the Gofrugal file only after Gofrugal's data sync is up to date
// (gofrugal_sync.py). If it is still missing at the 9 AM run, tell the WhatsApp group once a day.
function spiGfAlert_(today) {
  var p = PropertiesService.getScriptProperties();
  if (Number(Utilities.formatDate(new Date(), SPI.TZ, 'H')) < 9 || p.getProperty('SPI_GF_ALERT_DATE') === today || !waReady_()) return;
  p.setProperty('SPI_GF_ALERT_DATE', today);
  waText_('Gofrugal data sync issue, sales report will be delayed.');
}

function waText_(text) {
  var gid = waProps_().getProperty('WA_GROUP_ID');
  if (!gid) throw new Error('WhatsApp group not chosen.');
  var j = waCall_('sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chatId: gid, message: text }) });
  if (!j.idMessage) throw new Error('WhatsApp did not accept the message: ' + JSON.stringify(j).slice(0, 300));
  spiLog_('', '', 'Posted to WhatsApp (' + (waProps_().getProperty('WA_GROUP_NAME') || gid) + '): ' + text);
  return j.idMessage;
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
    return { done: false, msg: m, gfMissing: true };
  }
  if ((!vbF || !gfF) && !force) {
    spiLog_(vbF ? vbF.name : '', gfF ? gfF.name : '', 'Waiting for the ' + (vbF ? 'Gofrugal' : 'VetBuddy') + ' file. Will try again.');
    return { done: false, msg: 'waiting', gfMissing: !gfF };
  }

  var t0 = Date.now(); console.log('files found: ' + (vbF ? vbF.name : '-') + ' / ' + (gfF ? gfF.name : '-'));
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
  console.log('download + read + rules: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'); t0 = Date.now();
  var res = saveUpload(up);
  console.log('saveUpload (sheet writes + Summary): ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

  var msg = (res.ok ? 'Updated' : 'Updated - some checks need a look (see Exceptions)') + ': Summary shows ' + res.month + ' up to ' + res.upto +
            ' | VetBuddy ' + (vb ? vb.lines.length + ' lines' : 'not imported') + ', Gofrugal ' + (gf ? gf.lines.length : 0) +
            ' sales / ' + (gfr ? gfr.lines.length : 0) + ' return lines' + (notes.length ? ' (' + notes.join(', ') + ')' : '');
  spiLog_(vbF ? vbF.name : '', gfF ? gfF.name : '', msg);
  PropertiesService.getScriptProperties().setProperty('SPI_LAST', Utilities.formatDate(new Date(), SPI.TZ, 'dd-MM-yyyy HH:mm') + ' - ' + msg);
  return { done: true, msg: msg };
}

// READ-ONLY timing check (19-11-2026): runs the import steps WITHOUT saving anything and logs how long
// each takes (see Execution log). Run it from the editor: pick spiTimingTest and press Run.
function spiTimingTest() {
  var t = Date.now(), lap = function (what) { var n = Date.now(); console.log(what + ': ' + ((n - t) / 1000).toFixed(1) + ' s'); t = n; };
  var want = spiDay_(-1);
  var g = spiGraph_(); lap('SharePoint login + library');
  var vbF = spiPick_(g, SPI.VB_FOLDER, SPI.VB_RE, want), gfF = spiPick_(g, SPI.GF_FOLDER, SPI.GF_RE, want); lap('find the two files (' + (vbF ? vbF.name : 'no VB') + ', ' + (gfF ? gfF.name : 'no GF') + ')');
  var vbB = vbF ? spiDownload_(vbF) : null; lap('download VetBuddy file (' + (vbB ? Math.round(vbB.length / 1024) : 0) + ' KB)');
  var gfB = gfF ? spiDownload_(gfF) : null; lap('download Gofrugal file (' + (gfB ? Math.round(gfB.length / 1024) : 0) + ' KB)');
  var XLSX = spiXlsx_(); lap('load Excel reader (SheetJS from cdn.jsdelivr.net)');
  var C = CoreFactory(), vb = null, gf = null, gfr = null;
  if (vbB) { var aoa = spiSheet_(XLSX, spiRead_(XLSX, vbB), null); lap('read VetBuddy file (' + aoa.length + ' rows)'); vb = C.extractVB(aoa); lap('VetBuddy rules (' + vb.lines.length + ' lines)'); }
  if (gfB) { var wb = spiRead_(XLSX, gfB); gf = C.extractGF(spiSheet_(XLSX, wb, 'Sales')); var rs = spiSheet_(XLSX, wb, 'Returns'); gfr = C.detect(rs) === 'GFR' ? C.extractGFR(rs) : { lines: [], footer: null }; lap('read + rules Gofrugal (' + gf.lines.length + ' lines)'); }
  var from = Infinity, to = 0;
  [gf, gfr].forEach(function (x) { (x ? x.lines : []).forEach(function (l) { if (l.date < from) from = l.date; if (l.date > to) to = l.date; }); });
  var ctx = getContext(isFinite(from) ? from : null, to || null); lap('read Settings + VOW doctors from the sheet');
  C.process(vb, gf, ctx.settings, ctx.vowDocs, gfr); lap('VOW split / process');
  var lock = LockService.getDocumentLock(); lock.waitLock(60000); lap('wait for the sheet lock'); lock.releaseLock();
  console.log('Not saved - this was a timing check only. (Saving = saveUpload: Data, VOW lists, Undo copies, Exceptions, Summary.)');
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
function spiToken_(scope) {
  var p = PropertiesService.getScriptProperties();
  var t = p.getProperty('SP_TENANT_ID'), id = p.getProperty('SP_CLIENT_ID'), sec = p.getProperty('SP_CLIENT_SECRET');
  if (!t || !id || !sec) throw new Error('SharePoint login not set. Menu Sales Report > SharePoint auto import > Set SharePoint login.');
  var r = UrlFetchApp.fetch('https://login.microsoftonline.com/' + encodeURIComponent(t) + '/oauth2/v2.0/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: id, client_secret: sec, scope: scope || 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }
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
// Google lets people untick single permissions on the approval screen; this asks again for any that are missing
function spiAskScopes_() {
  if (ScriptApp.requireAllScopes) ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
}
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

// ===================================================================
// DAILY SNAPSHOT OF THE CORE TEAM REPORT -> SharePoint "Daily Snapshots" (+ Teams)
// ===================================================================
var SNAP = { SHEET: 'Core Team Report', FOLDER: 'Daily Snapshots' };

// -------------------------------------------------------------------
// CORE TEAM REPORT SYNC (runs automatically just before the daily picture)
// Re-links every row of "Core Team Report" to the right Summary row for any
// month length (28-31 day rows), copies Summary number formats, shows only
// the days that have sales, and keeps the chosen KPI rows hidden.
// -------------------------------------------------------------------
var CTS = {
  FIRST: 5,                                             // first day row on Core Team Report
  // Core Team KPI rows -> KPI index on Summary (row 7 repeats "Target @ 2 Cr")
  KPI_MAP: [0, 1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  // Core Team KPI rows kept hidden in the picture: duplicate Target, Balance, Req/day, Vetbuddy MTD, Gofrugal MTD
  KPI_HIDE: [6, 13, 14, 15, 16]
};
function coreTeamSync_() {
  var ss = SpreadsheetApp.getActive(), sm = ss.getSheetByName(SH.SUMMARY), ct = ss.getSheetByName(SNAP.SHEET);
  if (!sm || !ct) throw new Error('Summary or Core Team Report sheet not found');
  var colA = function (n) { return String.fromCharCode(64 + n); };
  // Summary: day rows start at row 4 (weekday names in column A), KPI block right after
  var sv = sm.getRange(4, 1, 40, 16).getDisplayValues();
  var wd = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/, D = 0;
  while (D < sv.length && wd.test(String(sv[D][0]).trim())) D++;
  if (D < 28 || D > 31) throw new Error('Summary has ' + D + ' day rows (expected 28-31)');
  var shown = 0;                                        // days that have sales
  for (var i = 0; i < D; i++) if (sv[i].slice(2).some(function (x) { return String(x).trim() !== ''; })) shown = i + 1;
  // Core Team: KPI block starts at the first row whose B:C cells are merged
  var kStart = 0;
  ct.getRange(CTS.FIRST, 2, 120, 2).getMergedRanges().forEach(function (m) {
    if (m.getColumn() === 2 && m.getNumColumns() === 2 && (!kStart || m.getRow() < kStart)) kStart = m.getRow();
  });
  if (!kStart) throw new Error('Core Team Report: KPI block not found');
  var Cd = kStart - CTS.FIRST;                          // day rows on Core Team now
  if (D > Cd) ct.insertRowsAfter(kStart - 1, D - Cd);   // new rows copy the day-row format
  else if (D < Cd) ct.deleteRows(CTS.FIRST + D, Cd - D);
  kStart = CTS.FIRST + D;
  // day rows: Core B..Q = Summary A..P
  var f = [];
  for (var d = 0; d < D; d++) {
    var row = [];
    for (var c = 1; c <= 16; c++) row.push('=Summary!' + colA(c) + (4 + d));
    f.push(row);
  }
  ct.getRange(CTS.FIRST, 2, D, 16).setFormulas(f);
  ct.getRange(CTS.FIRST, 4, D, 14).setNumberFormats(sm.getRange(4, 3, D, 14).getNumberFormats());
  // KPI rows: label in B (B:C merged), values in D..Q
  var K = CTS.KPI_MAP.length, lab = [], val = [], fmt = [];
  for (var k = 0; k < K; k++) {
    var sr = 4 + D + CTS.KPI_MAP[k];
    lab.push(['=Summary!A' + sr]);
    var vr = [];
    for (var c2 = 3; c2 <= 16; c2++) vr.push('=Summary!' + colA(c2) + sr);
    val.push(vr);
    fmt.push(sm.getRange(sr, 3, 1, 14).getNumberFormats()[0]);
  }
  ct.getRange(kStart, 2, K, 1).setFormulas(lab);
  ct.getRange(kStart, 4, K, 14).clearContent().setFormulas(val).setNumberFormats(fmt);
  // what the picture shows: days with sales + visible KPI rows
  ct.showRows(CTS.FIRST, D + K);
  // keep 2 empty rows after the sales: today and tomorrow (by today's date; else last sales day + 2)
  var todayLbl = Utilities.formatDate(new Date(), SPI.TZ, 'dd-MMM-yyyy'), ti = 0;
  for (var j = 0; j < D; j++) if (String(sv[j][1]).trim() === todayLbl) ti = j + 1;
  var vis = ti ? Math.max(shown, Math.min(D, ti + 1)) : Math.min(D, shown + 2);
  if (vis < D) ct.hideRows(CTS.FIRST + vis, D - vis);
  CTS.KPI_HIDE.forEach(function (k) { ct.hideRows(kStart + k); });
  SpreadsheetApp.flush();
  return 'Core Team Report synced: ' + D + ' day rows, ' + shown + ' with sales';
}
function coreTeamSyncNow() { Logger.log(coreTeamSync_()); }


// the Core Team Report table as a PDF (hidden rows are left out, like on screen)
function snapPdf_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(SNAP.SHEET);
  if (!sh) throw new Error('Sheet "' + SNAP.SHEET + '" not found');
  try { coreTeamSync_(); } catch (e) { spiLog_('', '', 'Core Team sync FAILED: ' + e.message); }
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=pdf&gid=' + sh.getSheetId() +
    '&r1=2&c1=1&r2=' + sh.getLastRow() + '&c2=' + sh.getLastColumn() +
    '&size=' + snapPageSize_(sh) + '&portrait=false&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&attachment=false' +
    '&top_margin=0.25&bottom_margin=0.25&left_margin=0.25&right_margin=0.25&horizontal_alignment=CENTER';
  var r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('PDF export failed: HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  return r.getBlob().setName('Core_Team_Report.pdf');
}

// page size (inches) with the same shape as the visible table, so the picture has no empty space
function snapPageSize_(sh) {
  var w = 0, h = 0, lr = sh.getLastRow(), lc = sh.getLastColumn();
  for (var c = 2; c <= lc; c++) if (!sh.isColumnHiddenByUser(c)) w += sh.getColumnWidth(c);
  for (var r = 3; r <= lr; r++) if (!sh.isRowHiddenByUser(r) && !sh.isRowHiddenByFilter(r)) h += sh.getRowHeight(r);
  var W = 14, H = Math.max(2, W * h / Math.max(w, 1)) + 0.5;
  return W.toFixed(2) + 'x' + H.toFixed(2);
}

// upload to SharePoint, let SharePoint turn the PDF into a picture
function snapImage_(day) {
  var g = spiGraph_(), pdf = snapPdf_();
  var base = 'https://graph.microsoft.com/v1.0/drives/' + g.drive + '/root:/' + encodeURIComponent(SNAP.FOLDER) + '/';
  var up = UrlFetchApp.fetch(base + encodeURIComponent('Core_Team_Report_' + day + '.pdf') + ':/content', {
    method: 'put', contentType: 'application/pdf', payload: pdf.getBytes(), headers: { Authorization: 'Bearer ' + g.token }, muteHttpExceptions: true });
  if (up.getResponseCode() >= 300) throw new Error('SharePoint upload failed: ' + up.getResponseCode() + ' ' + up.getContentText().slice(0, 200));
  var item = JSON.parse(up.getContentText()), img = null;
  for (var i = 0; i < 8 && !img; i++) {
    Utilities.sleep(i ? 4000 : 1500);
    var t = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0/drives/' + g.drive + '/items/' + item.id + '/thumbnails?select=c2400x2400',
      { headers: { Authorization: 'Bearer ' + g.token }, muteHttpExceptions: true });
    if (t.getResponseCode() !== 200) continue;
    var v = (JSON.parse(t.getContentText()).value || [])[0], th = v && v.c2400x2400;
    if (th && th.url) { var b = UrlFetchApp.fetch(th.url, { muteHttpExceptions: true }); if (b.getResponseCode() === 200) img = b.getBlob(); }
  }
  if (!img) throw new Error('SharePoint did not make a picture of the PDF');
  img.setName('Core_Team_Report_' + day + '.jpg');
  UrlFetchApp.fetch(base + encodeURIComponent(img.getName()) + ':/content', {
    method: 'put', contentType: img.getContentType() || 'image/jpeg', payload: img.getBytes(), headers: { Authorization: 'Bearer ' + g.token }, muteHttpExceptions: true });
  return { img: img, pdfUrl: item.webUrl };
}


// 25-11-2026: the Teams report post (snapSend_ / Teams Workflow) was removed - the picture goes to WhatsApp only.

/* ===================================================================
   DAILY PICTURE TO A WHATSAPP GROUP  (via Green API, free Developer plan)
   After the 9 AM import, the same Core Team Report picture that goes to
   Teams is also posted into one WhatsApp group.

   Setup (once): menu Sales Report > SharePoint auto import >
     Set WhatsApp login   (API URL, instance ID, API token from console.green-api.com)
     Choose WhatsApp group (type the group name; the script finds it)
     Send picture to WhatsApp now  (to test)
   =================================================================== */

function waProps_() { return PropertiesService.getScriptProperties(); }

function waBase_() {
  var p = waProps_();
  var url = (p.getProperty('WA_API_URL') || 'https://api.green-api.com').replace(/\/+$/, '');
  var id = p.getProperty('WA_INSTANCE_ID'), tok = p.getProperty('WA_API_TOKEN');
  if (!id || !tok) throw new Error('WhatsApp login not set. Menu Sales Report > SharePoint auto import > Set WhatsApp login.');
  return { url: url, id: id, tok: tok };
}

function waCall_(method, opts) {
  var b = waBase_();
  var o = opts || {};
  o.muteHttpExceptions = true;
  var hosts = [b.url];
  if (method === 'sendFileByUpload') {          // files go to a media host; the right one depends on the instance
    var p = waProps_();
    hosts = [p.getProperty('WA_MEDIA_URL'), b.url, b.url.replace('.api.', '.media.'), 'https://media.green-api.com']
      .filter(function (h, i, all) { return h && all.indexOf(h) === i; });
  }
  var r = null, errs = [];
  for (var i = 0; i < hosts.length && !r; i++) {
    try { r = UrlFetchApp.fetch(hosts[i] + '/waInstance' + b.id + '/' + method + '/' + b.tok, o); }
    catch (e) {                                  // only an unknown address is safe to retry elsewhere (no duplicate photos)
      if (!/DNS|resolve|Address unavailable/i.test(String(e.message))) throw e;
      errs.push(hosts[i] + ': ' + String(e.message).split(':')[0]); continue;
    }
    if (r.getResponseCode() === 404 && i < hosts.length - 1) { errs.push(hosts[i] + ': 404'); r = null; continue; }
    if (method === 'sendFileByUpload' && r.getResponseCode() === 200) waProps_().setProperty('WA_MEDIA_URL', hosts[i]);
  }
  if (!r) throw new Error('WhatsApp (' + method + ') could not reach Green API: ' + errs.join(' | '));
  var c = r.getResponseCode(), t = r.getContentText();
  if (c !== 200) throw new Error('WhatsApp (' + method + ') HTTP ' + c + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : {};
}

// ---------------- menu actions ----------------
function waSetLogin() {
  var ui = SpreadsheetApp.getUi(), p = waProps_();
  var keys = [['WA_API_URL', 'apiUrl (for example https://7105.api.greenapi.com)'],
              ['WA_INSTANCE_ID', 'idInstance (the number of your instance)'],
              ['WA_API_TOKEN', 'apiTokenInstance']];
  for (var i = 0; i < keys.length; i++) {
    var r = ui.prompt('WhatsApp login (' + (i + 1) + '/3)', keys[i][1] + ' - from console.green-api.com' +
                      (p.getProperty(keys[i][0]) ? '\n(already set - leave empty to keep it)' : ''), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = r.getResponseText().trim();
    if (v) p.setProperty(keys[i][0], v);
  }
  try {
    var s = waCall_('getStateInstance', { method: 'get' });
    ui.alert(s.stateInstance === 'authorized' ? 'WhatsApp login works (phone linked).'
             : 'Login accepted, but the phone is not linked yet (state: ' + s.stateInstance + '). Scan the QR code in console.green-api.com.');
  } catch (e) { ui.alert('WhatsApp login did NOT work:\n' + e.message); }
}

function waChooseGroup() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('WhatsApp group', 'Type the WhatsApp group name (or part of it):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var q = r.getResponseText().trim().toLowerCase();
  if (!q) return;
  var groups;
  try { groups = waCall_('getContacts', { method: 'get' }).filter(function (c) { return c.type === 'group' || /@g\.us$/.test(c.id); }); }
  catch (e) { ui.alert(e.message); return; }
  var hit = groups.filter(function (g) { return String(g.name || '').toLowerCase().indexOf(q) >= 0; });
  if (!hit.length) {
    ui.alert('No group matching "' + q + '". Groups this number is in:\n' +
             (groups.map(function (g) { return '- ' + (g.name || g.id); }).join('\n') || '(none)'));
    return;
  }
  if (hit.length > 1) {
    var exact = hit.filter(function (g) { return String(g.name || '').toLowerCase() === q; });
    if (exact.length !== 1) { ui.alert('More than one group matches - type the full name:\n' + hit.map(function (g) { return '- ' + g.name; }).join('\n')); return; }
    hit = exact;
  }
  waProps_().setProperty('WA_GROUP_ID', hit[0].id);
  waProps_().setProperty('WA_GROUP_NAME', hit[0].name || hit[0].id);
  ui.alert('WhatsApp group set: ' + (hit[0].name || hit[0].id) + '\nThe daily picture will be posted there after the 9 AM import.');
}

function waSendNow() {
  spiAskScopes_();
  var ui = SpreadsheetApp.getUi();
  try {
    var day = Utilities.formatDate(new Date(), SPI.TZ, 'yyyy-MM-dd');
    var s = snapImage_(day);
    var title = waTitle_();
    waSend_(s.img, title);
    ui.alert('Sent to WhatsApp group "' + (waProps_().getProperty('WA_GROUP_NAME') || '') + '": ' + title);
  } catch (e) { ui.alert('WhatsApp send failed:\n' + e.message); }
}

// ---------------- the send ----------------
function waReady_() {
  var p = waProps_();
  return !!(p.getProperty('WA_INSTANCE_ID') && p.getProperty('WA_API_TOKEN') && p.getProperty('WA_GROUP_ID'));
}

function waTitle_() {
  var m = snapMsg_();
  if (m) return m.title + (m.text ? '\n' + m.text : '');
  var t = String(SpreadsheetApp.getActive().getSheetByName(SH.SUMMARY).getRange('C1').getDisplayValue() || '');
  return 'Sanchu Daily Sales - ' + t.split('(')[0].trim();
}

// the "WhatsApp message" block on the Summary: title (row 4) and sales text (row 5) under the label
function snapMsg_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH.SUMMARY);
  var row3 = sh.getRange(3, 1, 1, sh.getLastColumn()).getDisplayValues()[0], c = 0;
  for (var i = 0; i < row3.length; i++) if (/WhatsApp message/i.test(row3[i])) { c = i + 1; break; }
  if (!c) return null;
  var t = sh.getRange(4, c).getDisplayValue().trim(), x = sh.getRange(5, c).getDisplayValue().trim();
  return t || x ? { title: t, text: x } : null;
}

// img: Blob (jpg/png); caption: text under the photo
function waSend_(img, caption) {
  var gid = waProps_().getProperty('WA_GROUP_ID');
  if (!gid) throw new Error('WhatsApp group not chosen. Menu Sales Report > SharePoint auto import > Choose WhatsApp group.');
  var name = img.getName() || 'Core_Team_Report.jpg';
  var j = waCall_('sendFileByUpload', {
    method: 'post',
    payload: { chatId: gid, caption: caption || '', fileName: name, file: img.setName(name) }
  });
  if (!j.idMessage) throw new Error('WhatsApp did not accept the picture: ' + JSON.stringify(j).slice(0, 300));
  spiLog_('', '', 'Posted to WhatsApp (' + (waProps_().getProperty('WA_GROUP_NAME') || gid) + '): ' + caption);
  return j.idMessage;
}

/* 25-11-2026: the Teams chatbot was deleted - the sheet-numbers push to Supabase (botPush_) was removed. */
