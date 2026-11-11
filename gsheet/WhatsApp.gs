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
  var host = method === 'sendFileByUpload' ? b.url.replace('.api.', '.media.') : b.url;   // files go to the media host
  var r = UrlFetchApp.fetch(host + '/waInstance' + b.id + '/' + method + '/' + b.tok, o);
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
  var t = String(SpreadsheetApp.getActive().getSheetByName(SH.SUMMARY).getRange('C1').getDisplayValue() || '');
  return 'Sanchu Daily Sales - ' + t.split('(')[0].trim();
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
