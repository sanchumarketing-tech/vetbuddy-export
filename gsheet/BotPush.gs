/* ===================================================================
   SHEET NUMBERS -> SUPABASE  (for the Teams bot)
   Every morning after the 9 AM import (and from the menu) the sheet sends:
     - the daily unit totals of "Data" (= the Summary, with the manual VOW corrections)
     - the monthly targets of "AOP" (Target @ 2 Cr)
     - the Summary KPIs (MTD, MON EST, target, balance, ADS ...) for this and last month
   to Supabase through public.sheet_push (sql/04_sheet_numbers.sql).
   Setup (once): menu Sales Report > SharePoint auto import > Set Supabase (bot) login
   =================================================================== */

function botProps_() { return PropertiesService.getScriptProperties(); }
function botReady_() {
  var p = botProps_();
  return !!(p.getProperty('SB_URL') && p.getProperty('SB_ANON') && p.getProperty('SB_PUSH_KEY'));
}

function botSetLogin() {
  var ui = SpreadsheetApp.getUi(), p = botProps_();
  var keys = [['SB_URL', 'Project URL (Supabase > Project Settings > API), e.g. https://abcdxyz.supabase.co'],
              ['SB_ANON', 'anon / publishable key (Supabase > Project Settings > API Keys)'],
              ['SB_PUSH_KEY', 'push key shown by 04_sheet_numbers.sql ("COPY THIS PUSH KEY")']];
  for (var i = 0; i < keys.length; i++) {
    var r = ui.prompt('Supabase (bot) login (' + (i + 1) + '/3)', keys[i][1] +
                      (p.getProperty(keys[i][0]) ? '\n(already set - leave empty to keep it)' : ''), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = r.getResponseText().trim();
    if (v) p.setProperty(keys[i][0], keys[i][0] === 'SB_URL' ? v.replace(/\/+$/, '') : v);
  }
  try { ui.alert('Supabase works: ' + botPush_()); }
  catch (e) { ui.alert('Supabase did NOT work:\n' + e.message); }
}

function botPushNow() {
  spiAskScopes_();
  var ui = SpreadsheetApp.getUi();
  try { ui.alert('Sent to Supabase: ' + botPush_()); }
  catch (e) { ui.alert('Supabase push failed:\n' + e.message); }
}

function botPush_() {
  var p = botProps_(), ss = SpreadsheetApp.getActive(), C = CoreFactory(), tz = ss.getSpreadsheetTimeZone();
  if (!botReady_()) throw new Error('Supabase login not set. Menu Sales Report > SharePoint auto import > Set Supabase (bot) login.');
  var iso = function (s) { return Utilities.formatDate(new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 864e5), 'UTC', 'yyyy-MM-dd'); };
  var r2 = function (x) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100; };
  var r4 = function (x) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10000) / 10000; };
  var blank = function (x) { return x === '' || x === null || x === undefined; };

  // 1. daily totals per unit (same rule as the Summary)
  var data = readTable_(ss, SH.DATA, 6), agg = {};
  data.forEach(function (r) {
    var d = +r[0], u = String(r[1]).trim().toUpperCase();
    if (!d || !u) return;
    var legacy = !blank(r[4]);
    var k = d + '|' + u, a = agg[k] || (agg[k] = { d: iso(d), u: u, t: 0, v: legacy ? null : 0, g: legacy ? null : 0 });
    if (legacy) a.t += +r[4] || 0;
    else {
      var vb = +r[2] || 0, gf = (+r[3] || 0) + (+r[5] || 0);
      a.t += vb + gf; a.v = (a.v || 0) + vb; a.g = (a.g || 0) + gf;
    }
  });
  var daily = Object.keys(agg).map(function (k) { var a = agg[k]; return { d: a.d, u: a.u, t: r2(a.t), v: r2(a.v), g: r2(a.g) }; });

  // 2. targets from AOP (row 1 = units, column A = month)
  var aop = ss.getSheetByName(SH.AOP).getDataRange().getValues(), hdr = aop[0] || [], targets = [];
  var MONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var monthOf = function (x) {
    if (x instanceof Date) return Utilities.formatDate(x, tz, 'yyyy-MM');
    if (typeof x === 'number' && x > 0) return iso(x).slice(0, 7);
    var t = String(x || '').trim(), m = t.match(/^(\d{4})-(\d{2})/);
    if (m) return m[1] + '-' + m[2];
    m = t.match(/([A-Za-z]{3})[a-z]*[\s\-']*(\d{2,4})/);
    if (m && MONS.indexOf(m[1].toLowerCase()) >= 0) { var y = +m[2]; if (y < 100) y += 2000; return y + '-' + ('0' + (MONS.indexOf(m[1].toLowerCase()) + 1)).slice(-2); }
    return '';
  };
  aop.slice(1).forEach(function (row) {
    var mk = monthOf(row[0]);
    if (!mk) return;
    for (var j = 1; j < hdr.length; j++) {
      var u = String(hdr[j] || '').trim().toUpperCase(), v = typeof row[j] === 'number' ? row[j] : parseFloat(String(row[j]).replace(/,/g, ''));
      if (u && isFinite(v) && v > 0) targets.push({ m: mk + '-01', u: u, t: r2(v) });
    }
  });

  // 3. Summary KPIs for the latest month and the month before
  var st = readSettings_(ss);
  var shown = vowSplitShown_(st.units.filter(function (u) { return /^y/i.test(String(u[1]).trim()); })
                                     .map(function (u) { return String(u[0]).trim().toUpperCase(); }));
  var kpi = [], months = [], latest = daily.reduce(function (m, x) { return x.d > m ? x.d : m; }, '').slice(0, 7);
  if (latest) {
    var y = +latest.slice(0, 4), mo = +latest.slice(5, 7);
    var prev = (mo === 1 ? (y - 1) + '-12' : y + '-' + ('0' + (mo - 1)).slice(-2));
    months = [latest, prev];
  }
  months.forEach(function (mk) {
    var S = C.summary(data, aop, shown, mk);
    if (!S || S.empty) return;
    shown.concat(['*']).forEach(function (u) {
      var R = S.rows[u];
      if (!R) return;
      kpi.push({ month: mk + '-01', unit: u === '*' ? 'TOTAL' : u, as_of: iso(S.asOf), days_done: S.dayNo, days_left: S.remaining,
                 mtd: r2(R.mtd), last_month_same_days: r2(R.lm), two_months_same_days: r2(R.l2m),
                 growth_vs_last_month: r4(R.g1), growth_vs_two_months: r4(R.g2), month_estimate: r2(R.est), target: r2(R.aop),
                 estimate_vs_target: r4(R.estVsAop), balance_to_target: r2(R.balance), required_per_day: r2(R.reqPerDay),
                 ads: r2(R.ads), ads_last_month: r2(R.adsLm), target_per_day: r2(R.aopPerDay), ads_vs_target: r4(R.adsVsAop),
                 vetbuddy_mtd: r2(R.vb), gofrugal_mtd: r2(R.gf) });
    });
  });

  // 4. send
  var key = p.getProperty('SB_ANON'), headers = { apikey: key };
  if (!/^sb_/.test(key)) headers.Authorization = 'Bearer ' + key;     // old-style anon JWT
  var res = UrlFetchApp.fetch(p.getProperty('SB_URL') + '/rest/v1/rpc/sheet_push', {
    method: 'post', contentType: 'application/json', headers: headers, muteHttpExceptions: true,
    payload: JSON.stringify({ p_key: p.getProperty('SB_PUSH_KEY'), p_daily: daily, p_targets: targets, p_kpi: kpi })
  });
  if (res.getResponseCode() >= 300) throw new Error('Supabase HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  var msg = String(JSON.parse(res.getContentText()));
  spiLog_('', '', 'Supabase (bot) updated: ' + msg);
  return msg;
}
