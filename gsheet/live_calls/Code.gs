/**
 * Corefactor live calls (24 Nov 2026)
 * "Today" = today's calls from the Corefactor live webhook, refreshed every 5 minutes.
 * After midnight the finished day is moved to "Dump" (once per day) and "Today" starts again.
 * Data comes from Supabase public.cf_live_feed (read only, needs the key below).
 */
var FEED_URL = 'https://ykmgbuooksizjqsyfhut.supabase.co/rest/v1/rpc/cf_live_feed';
var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrbWdidW9va3Npempxc3lmaHV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3Nzk0MzcsImV4cCI6MjEwOTM1NTQzN30.-mfbJPEfIUIjgTboxviFqqMCHX7ex2Lh95ql-bTcDuQ';
var FEED_KEY = '__KEY__';
var HEAD = ['Call time', 'Direction', 'Customer phone', 'Customer (Call Desk list)', 'Agent number', 'Call Desk agent', 'Unit',
            'Call status', 'Answered', 'Duration (s)', 'Talk time (s)', 'Recording', 'Corefactor ID'];

function feed_(day) {
  var r = UrlFetchApp.fetch(FEED_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
    payload: JSON.stringify(day ? { p_key: FEED_KEY, p_day: day } : { p_key: FEED_KEY })
  });
  if (r.getResponseCode() !== 200) throw new Error('Feed ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var top = name === 'Dump' ? 1 : 2;
    sh.getRange(top, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(top);
    sh.getRange('C:C').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
    sh.getRange('M:M').setNumberFormat('@');
  }
  return sh;
}

function refreshLive() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var today = feed_();
    var shown = props.getProperty('day');
    // a new day: move the finished day (final numbers) to Dump once
    if (shown && shown !== today.day && props.getProperty('dumped') !== shown) {
      var old = feed_(shown);
      if (old.rows.length) {
        var dump = sheet_('Dump');
        dump.getRange(dump.getLastRow() + 1, 1, old.rows.length, HEAD.length).setValues(old.rows.map(clean_));
      }
      props.setProperty('dumped', shown);
    }
    var sh = sheet_('Today');
    var rows = today.rows.map(clean_);
    var last = sh.getLastRow();
    if (last > 2) sh.getRange(3, 1, last - 2, HEAD.length).clearContent();
    if (rows.length) sh.getRange(3, 1, rows.length, HEAD.length).setValues(rows);
    var ans = rows.filter(function (r) { return r[8] === 'Yes'; }).length;
    sh.getRange('A1').setValue('Live Corefactor calls for ' + today.day + ' - ' + rows.length + ' calls, ' + ans +
      ' answered - updated ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM HH:mm') + ' (refreshes every 5 minutes; yesterday is in Dump)');
    props.setProperty('day', today.day);
  } finally {
    lock.releaseLock();
  }
}

function clean_(r) {
  return r.map(function (v) { return v === null || v === undefined ? '' : v; });
}

/** Run once: makes the tabs, fills Today and turns on the 5-minute refresh. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sheet_('Today'); sheet_('Dump');
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 2) ss.deleteSheet(s1);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'refreshLive') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshLive').timeBased().everyMinutes(5).create();
  refreshLive();
}
