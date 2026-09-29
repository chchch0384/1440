/**
 * 1440 — Google Apps Script 收件員
 *
 * 只做一次的設定：
 *   1. 在 Google 試算表「1440-紀錄」→ 擴充功能 → Apps Script，把這整份貼上取代原本內容，存檔
 *   2. 上方函式選單選 setup → 執行 → 第一次會要求授權
 *   3. 部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」→ 誰可以存取「所有人」
 *   4. 打開部署後的網址一次，網址會自動寫回試算表「設定」分頁，B7 就是專屬連結
 *
 * 其他可以從編輯器執行的函式：
 *   rotateKey()             密鑰外流時換一組新的（換完要重新貼專屬連結）
 *   rebuildFromFilenames()  Sheet 壞了或誤刪時，從 Drive 的 photos/ 檔名重建整份紀錄
 *
 * 網頁 App 用 POST 送 JSON（Content-Type 用 text/plain 才能過 CORS）：
 *   { key, action: 'ping' }
 *   { key, action: 'list' }                         → { ok, columns, rows: [[date, minute, taken_at, file_id, thumb_id, lit, cheat, note, file_name], ...] }
 *                                                     App 打開時拿一次，狀態（這格有沒有、今天拍了沒）都從這份清單算
 *   { key, action: 'upload', date, minute, taken_at, cheat, photo(base64), thumb(base64), note }
 *                                                   → { ok, lit, cheat, row }
 *   { key, action: 'thumbs', ids: [thumb_id, ...] } → { ok, thumbs: { id: base64, ... } }（一次最多 60 張）
 *   { key, action: 'photo', id: file_id }           → { ok, data: base64, name }
 *
 * 規則都在這裡判斷，手機端算錯也蓋不掉：
 *   lit   = 這一分鐘還沒有點亮的照片
 *   cheat = 當天已經有紀錄（這是今天第二張以後）
 */

var PAGES_URL = 'https://chchch0384.github.io/1440/';
var ROOT_FOLDER = '1440';
var SHEET_TITLE = '1440-紀錄';
var RECORDS = '紀錄';
var SETTINGS = '設定';
var HEADERS = ['date', 'minute', 'taken_at', 'file_id', 'thumb_id', 'lit', 'cheat', 'note', 'file_name'];
var THUMB_BATCH = 60;

var props_ = PropertiesService.getScriptProperties();

// ───────────── 設定 ─────────────

function setup() {
  var root = findOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER);
  var photos = findOrCreateFolder_(root, 'photos');
  var thumbs = findOrCreateFolder_(root, 'thumbs');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = props_.getProperty('SHEET_ID');
    if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
    if (!ss) {
      ss = SpreadsheetApp.create(SHEET_TITLE);
      DriveApp.getFileById(ss.getId()).moveTo(root);
    }
  }

  var key = props_.getProperty('KEY') || makeKey_();
  props_.setProperties({ KEY: key, SHEET_ID: ss.getId(), PHOTOS_ID: photos.getId(), THUMBS_ID: thumbs.getId() });

  var rec = ss.getSheetByName(RECORDS);
  if (!rec) {
    var first = ss.getSheets()[0];
    if (ss.getSheets().length === 1 && first.getLastRow() === 0) { first.setName(RECORDS); rec = first; }
    else rec = ss.insertSheet(RECORDS);
  }
  if (rec.getLastRow() === 0) {
    rec.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    rec.setFrozenRows(1);
  }
  rec.getRange(1, 1, rec.getMaxRows(), 3).setNumberFormat('@');

  var set = ss.getSheetByName(SETTINGS) || ss.insertSheet(SETTINGS);
  writeSettings_(set, key, root, photos, thumbs);
  Logger.log('setup 完成。密鑰與專屬連結在試算表「' + SETTINGS + '」分頁。');
}

function writeSettings_(sh, key, root, photos, thumbs) {
  var webUrl = String(sh.getRange('B4').getValue() || '');
  if (webUrl.slice(0, 8) !== 'https://') webUrl = '（部署後，打開一次網頁應用程式的網址，這格會自動填好）';
  sh.clear();
  sh.getRange('A1').setValue('1440 設定').setFontWeight('bold').setFontSize(14);
  sh.getRange('A3:B3').setValues([['密鑰 key', key]]);
  sh.getRange('A4:B4').setValues([['網頁應用程式網址', webUrl]]);
  sh.getRange('A5:B5').setValues([['GitHub Pages 網址', PAGES_URL]]);
  sh.getRange('A7').setValue('專屬連結').setFontWeight('bold');
  sh.getRange('B7').setFormula('=IF(LEFT(B4,8)<>"https://","↑ 先完成上面的 B4",B5&"#k="&B3&"&api="&B4)');
  sh.getRange('A9:B9').setValues([['Drive 資料夾', root.getUrl()]]);
  sh.getRange('A10:B10').setValues([['照片 photos/', photos.getUrl()]]);
  sh.getRange('A11:B11').setValues([['縮圖 thumbs/', thumbs.getUrl()]]);
  sh.getRange('A13').setValue('專屬連結等同密碼。存進 iPhone「密碼」App 或備忘錄，再從主畫面的 1440 App 貼上一次即可。');
  sh.getRange('A3:A11').setFontColor('#666666');
  sh.setColumnWidth(1, 160);
  sh.setColumnWidth(2, 640);
}

function rotateKey() {
  var key = makeKey_();
  props_.setProperty('KEY', key);
  var set = getSpreadsheet_().getSheetByName(SETTINGS);
  if (set) set.getRange('B3').setValue(key);
  Logger.log('已換新密鑰，請到「' + SETTINGS + '」分頁重新複製專屬連結。');
}

function makeKey_() {
  return Utilities.getUuid().replace(/-/g, '');
}

// ───────────── 網頁應用程式入口 ─────────────

function doGet(e) {
  recordWebAppUrl_();
  if (e && e.parameter && e.parameter.format === 'json') return json_({ ok: true, app: '1440' });
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font:18px/1.6 -apple-system,system-ui,sans-serif;padding:24px">' +
    '<p>1440 收件員運作中 ✅</p>' +
    '<p>網址已寫回試算表。回到「' + SETTINGS + '」分頁，B7 就是專屬連結。</p></body>'
  );
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  var key = props_.getProperty('KEY');
  if (!key) return json_({ ok: false, error: 'not_setup' });
  if (!req || String(req.key || '') !== key) return json_({ ok: false, error: 'bad_key' });

  try {
    switch (req.action) {
      case 'ping':   return json_({ ok: true, time: new Date().toISOString() });
      case 'list':   return json_({ ok: true, columns: HEADERS, rows: listRows_() });
      case 'upload': return json_(upload_(req));
      case 'thumbs': return json_({ ok: true, thumbs: getThumbs_(req.ids) });
      case 'photo':  return json_(getPhoto_(req.id));
      default:       return json_({ ok: false, error: 'bad_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function recordWebAppUrl_() {
  try {
    var url = ScriptApp.getService().getUrl();
    if (!url || !/\/exec$/.test(url)) return;
    var set = getSpreadsheet_().getSheetByName(SETTINGS);
    if (set && set.getRange('B4').getValue() !== url) set.getRange('B4').setValue(url);
  } catch (err) {}
}

// ───────────── 上傳 ─────────────

function upload_(req) {
  var date = String(req.date || '');
  var minute = String(req.minute || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(minute)) return { ok: false, error: 'bad_minute' };
  if (!req.photo) return { ok: false, error: 'no_photo' };
  var takenAt = String(req.taken_at || (date + 'T' + minute + ':00'));
  var note = String(req.note || '');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getRecords_();
    var rows = readRows_(sheet);
    var lit = !rows.some(function (r) { return r.minute === minute && r.lit; });
    var todayHasRows = rows.some(function (r) { return r.date === date; });
    var cheat = todayHasRows || req.cheat === true || String(req.cheat).toLowerCase() === 'true';

    var photos = DriveApp.getFolderById(props_.getProperty('PHOTOS_ID'));
    var thumbs = DriveApp.getFolderById(props_.getProperty('THUMBS_ID'));
    var base = date + '_' + minute.replace(':', '') + (cheat ? '_cheat' : '');
    var name = base + '.jpg';
    for (var n = 2; photos.getFilesByName(name).hasNext(); n++) name = base + '_' + n + '.jpg';

    var file = photos.createFile(blob_(req.photo, name));
    var thumbId = '';
    if (req.thumb) thumbId = thumbs.createFile(blob_(req.thumb, name)).getId();

    var row = [date, minute, takenAt, file.getId(), thumbId, lit, cheat, note, name];
    appendRow_(sheet, row);
    return { ok: true, lit: lit, cheat: cheat, row: row };
  } finally {
    lock.releaseLock();
  }
}

function blob_(b64, name) {
  var s = String(b64);
  var comma = s.indexOf(',');
  if (s.slice(0, 5) === 'data:' && comma > -1) s = s.slice(comma + 1);
  return Utilities.newBlob(Utilities.base64Decode(s), 'image/jpeg', name);
}

function appendRow_(sheet, values) {
  var r = sheet.getLastRow() + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  sheet.getRange(r, 1, 1, 3).setNumberFormat('@');
  sheet.getRange(r, 1, 1, values.length).setValues([values]);
}

// ───────────── 讀取 ─────────────

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  return values.filter(function (v) { return v[0] !== '' && v[0] !== null; }).map(function (v) {
    return {
      date: asDate_(v[0], tz),
      minute: asMinute_(v[1], tz),
      taken_at: asText_(v[2], tz),
      file_id: String(v[3] || ''),
      thumb_id: String(v[4] || ''),
      lit: asBool_(v[5]),
      cheat: asBool_(v[6]),
      note: String(v[7] || ''),
      file_name: String(v[8] || '')
    };
  });
}

function listRows_() {
  return readRows_(getRecords_()).map(function (r) {
    return [r.date, r.minute, r.taken_at, r.file_id, r.thumb_id, r.lit ? 1 : 0, r.cheat ? 1 : 0, r.note, r.file_name];
  });
}

function getThumbs_(ids) {
  var out = {};
  if (!Array.isArray(ids)) return out;
  var folderId = props_.getProperty('THUMBS_ID');
  ids.slice(0, THUMB_BATCH).forEach(function (id) {
    try {
      var f = DriveApp.getFileById(String(id));
      if (!inFolder_(f, folderId)) return;
      out[id] = Utilities.base64Encode(f.getBlob().getBytes());
    } catch (err) {}
  });
  return out;
}

function getPhoto_(id) {
  if (!id) return { ok: false, error: 'no_id' };
  var f = DriveApp.getFileById(String(id));
  if (!inFolder_(f, props_.getProperty('PHOTOS_ID'))) return { ok: false, error: 'not_ours' };
  return { ok: true, id: String(id), name: f.getName(), mime: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

// ───────────── 從檔名重建 ─────────────

function rebuildFromFilenames() {
  var photos = DriveApp.getFolderById(props_.getProperty('PHOTOS_ID'));
  var thumbs = DriveApp.getFolderById(props_.getProperty('THUMBS_ID'));

  var thumbByName = {};
  var it = thumbs.getFiles();
  while (it.hasNext()) { var t = it.next(); thumbByName[t.getName()] = t.getId(); }

  var re = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(_cheat)?(?:_(\d+))?\.jpe?g$/i;
  var items = [];
  it = photos.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var m = re.exec(f.getName());
    if (!m) continue;
    items.push({
      date: m[1], minute: m[2] + ':' + m[3], cheat: !!m[4], seq: m[5] ? parseInt(m[5], 10) : 1,
      id: f.getId(), thumb: thumbByName[f.getName()] || '', name: f.getName()
    });
  }
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.minute !== b.minute) return a.minute < b.minute ? -1 : 1;
    if (a.cheat !== b.cheat) return a.cheat ? 1 : -1;
    return a.seq - b.seq;
  });

  var seen = {};
  var rows = items.map(function (x) {
    var lit = !seen[x.minute];
    seen[x.minute] = true;
    return [x.date, x.minute, x.date + 'T' + x.minute + ':00', x.id, x.thumb, lit, x.cheat, '', x.name];
  });

  var sheet = getRecords_();
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).clearContent();
  if (rows.length) {
    var need = rows.length + 1 - sheet.getMaxRows();
    if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
    sheet.getRange(2, 1, rows.length, 3).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }
  Logger.log('重建完成：' + rows.length + ' 筆，點亮 ' + Object.keys(seen).length + ' 格。');
}

// ───────────── 小工具 ─────────────

function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = props_.getProperty('SHEET_ID');
  if (!id) throw new Error('請先執行 setup()');
  return SpreadsheetApp.openById(id);
}

function getRecords_() {
  var sh = getSpreadsheet_().getSheetByName(RECORDS);
  if (!sh) throw new Error('找不到「' + RECORDS + '」分頁，請先執行 setup()');
  return sh;
}

function findOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function inFolder_(file, folderId) {
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return true;
  return false;
}

function asDate_(v, tz) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v); }
function asMinute_(v, tz) { return v instanceof Date ? Utilities.formatDate(v, tz, 'HH:mm') : String(v); }
function asText_(v, tz) { return v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : String(v); }
function asBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
