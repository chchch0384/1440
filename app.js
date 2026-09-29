/* 1440 — 網頁 App（路 C：按「拍」叫出原生相機） */
(function () {
'use strict';

var LONG_EDGE = 3000, MEDIUM = 1200, THUMB = 200;
var JPEG_Q = 0.88, MEDIUM_Q = 0.85, THUMB_Q = 0.8;
var THUMB_BATCH = 60, MEDIUM_KEEP = 50, REFRESH_MS = 10 * 60 * 1000;

// ───────────── 小工具 ─────────────

var $ = function (id) { return document.getElementById(id); };
var ACCENT = '#ff8a2b', ACCENT_DIM = '#5a3312';   // 唯一的強調色，跟 style.css 的 --accent 一樣
function two(n) { return (n < 10 ? '0' : '') + n; }
// 底片相機的日期印字：'26 9 29  15:21
function stampText(date, minute) {
  var p = String(date || '').split('-');
  if (p.length !== 3) return minute || '';
  return "'" + p[0].slice(2) + ' ' + (+p[1]) + ' ' + (+p[2]) + '  ' + minute;
}
function fmtDate(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
function fmtMinute(d) { return two(d.getHours()) + ':' + two(d.getMinutes()); }
function fmtISO(d) {
  var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  off = Math.abs(off);
  return fmtDate(d) + 'T' + fmtMinute(d) + ':' + two(d.getSeconds()) + sign + two(Math.floor(off / 60)) + ':' + two(off % 60);
}
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'TRUE' || v === 'true'; }
function errMsg(e) { return String((e && (e.message || e.name)) || e || 'Unknown error (maybe out of storage)'); }
var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

var toastTimer = null;
function toast(msg, ms) {
  var t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2500);
}
window.addEventListener('error', function (e) { toast('Error: ' + (e.message || 'unknown'), 5000); });

// ───────────── 設定（專屬連結） ─────────────

var cfg = null;
function loadCfg() {
  try { cfg = JSON.parse(localStorage.getItem('cfg') || 'null'); } catch (e) { cfg = null; }
  if (!(cfg && cfg.k && cfg.api)) cfg = null;
  return !!cfg;
}
function saveCfg(c) { cfg = c; try { localStorage.setItem('cfg', JSON.stringify(c)); } catch (e) {} }
function parseLink(text) {
  text = String(text || '').trim();
  var i = text.indexOf('#');
  if (i < 0) return null;
  var p = new URLSearchParams(text.slice(i + 1));
  var k = p.get('k'), api = p.get('api');
  if (!k || !api) return null;
  var okApi = api.indexOf('https://script.google.com/') === 0 || api.indexOf('http://localhost') === 0 || api.indexOf('http://127.0.0.1') === 0;
  if (!okApi) return null;
  return { k: k, api: api };
}

// ───────────── 跟 Apps Script 說話 ─────────────
// 用 text/plain 送 JSON，瀏覽器就不會先送 CORS 預檢，Apps Script 才收得到。

// 連線有兩條路：
//   fetch：一般的 POST（text/plain 才不會觸發 CORS 預檢）
//   備援：讀取用 JSONP（<script> 載入）、上傳用表單送進隱藏 iframe 再用 uid 查
// iPhone Safari 有時會擋掉跨網域 fetch，擋到一次就記住，之後直接走備援。
var transport = (function () { try { return localStorage.getItem('transport') || 'fetch'; } catch (e) { return 'fetch'; } })();
function setTransport(t) { transport = t; try { localStorage.setItem('transport', t); } catch (e) {} }

function ServerError(msg) { var e = new Error(msg); e.server = true; return e; }
var SERVER_MSG = {
  bad_key: 'Wrong key. Copy the whole link from cell B7 again.',
  not_setup: 'Server not set up. Run setup in Apps Script.',
  bad_action: 'Server is outdated. Paste the new Code.gs and deploy a new version.',
  upload_needs_post: 'Server misconfigured.'
};
function checkReply(j) {
  if (!j || !j.ok) throw ServerError((j && (j.message || SERVER_MSG[j.error] || j.error)) || 'Bad response');
  return j;
}

function call(action, data) {
  var body = { key: cfg.k, action: action };
  if (data) Object.keys(data).forEach(function (k) { body[k] = data[k]; });
  if (transport === 'alt') return callAlt(body);
  return callFetch(body).catch(function (e) {
    if (e.server) throw e;
    // fetch 這條路壞了，換備援再試一次；備援通了就記住
    return callAlt(body).then(function (j) { setTransport('alt'); return j; }, function (e2) {
      throw new Error('Both connections failed. fetch: ' + errMsg(e) + '; fallback: ' + errMsg(e2));
    });
  });
}

function callFetch(body) {
  return fetch(cfg.api, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
    credentials: 'omit', redirect: 'follow', cache: 'no-store'
  }).then(function (r) {
    return r.text().then(function (t) {
      var j;
      try { j = JSON.parse(t); } catch (e) {
        var peek = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        throw new Error('Not data (HTTP ' + r.status + ')' + (peek ? ': ' + peek : ''));
      }
      return checkReply(j);
    });
  });
}

function callAlt(body) {
  return body.action === 'upload' ? uploadAlt(body) : jsonp(body);
}

var jsonpSeq = 0;
function jsonp(body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var name = '__1440cb' + Date.now().toString(36) + (jsonpSeq++);
    var s = document.createElement('script');
    var timer = setTimeout(function () { finish(); reject(new Error('Fallback timed out')); }, timeoutMs || 25000);
    function finish() { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); }
    window[name] = function (j) { finish(); try { resolve(checkReply(j)); } catch (e) { reject(e); } };
    s.onerror = function () { finish(); reject(new Error('Fallback failed to load')); };
    s.src = cfg.api + (cfg.api.indexOf('?') < 0 ? '?' : '&') + 'cb=' + name + '&p=' + encodeURIComponent(JSON.stringify(body)) + '&_=' + Date.now();
    document.head.appendChild(s);
  });
}

// 表單 POST 送進隱藏 iframe（看不到回應），再用 uid 反覆查有沒有存進去
function uploadAlt(body) {
  if (!body.uid) return Promise.reject(new Error('Missing uid'));
  return new Promise(function (resolve) {
    var name = 'up' + Date.now();
    var ifr = document.createElement('iframe');
    ifr.name = name; ifr.style.display = 'none';
    var form = document.createElement('form');
    form.method = 'POST'; form.action = cfg.api; form.target = name; form.style.display = 'none';
    var field = document.createElement('textarea');
    field.name = 'payload'; field.value = JSON.stringify(body);
    form.appendChild(field);
    document.body.appendChild(ifr); document.body.appendChild(form);
    var done = false;
    function cleanup() { if (done) return; done = true; setTimeout(function () { ifr.remove(); form.remove(); }, 1000); resolve(); }
    ifr.onload = cleanup;
    setTimeout(cleanup, 60000);
    form.submit();
  }).then(function () {
    return pollUid(body.uid, 10);
  });
}
function pollUid(uid, tries) {
  return jsonp({ key: cfg.k, action: 'find', uid: uid }).then(function (j) {
    if (j.row) return { ok: true, lit: truthy(j.row[5]), cheat: truthy(j.row[6]), row: j.row };
    if (tries <= 1) throw new Error('Sent, but not received yet. Will retry.');
    return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { return pollUid(uid, tries - 1); });
  });
}

// ───────────── IndexedDB：縮圖快取、暫存照片、中圖 ─────────────

var dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise(function (res, rej) {
    var req = indexedDB.open('1440', 1);
    req.onupgradeneeded = function () {
      var d = req.result;
      ['thumbs', 'pending', 'medium', 'misc'].forEach(function (n) { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
    };
    req.onsuccess = function () { res(req.result); };
    req.onerror = function () { rej(req.error); };
  });
  return dbp;
}
function idb(store, mode, fn) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var tx = d.transaction(store, mode);
      var req = fn(tx.objectStore(store));
      tx.oncomplete = function () { res(req ? req.result : undefined); };
      tx.onerror = function () { rej(tx.error || new Error('Could not save to phone storage')); };
      tx.onabort = function () { rej(tx.error || new Error('Phone storage write was interrupted')); };
    });
  });
}
// Blob 直接存進 IndexedDB 在部分 Safari/WebKit 會失敗，所以一律轉成 ArrayBuffer 存、讀出來再變回 Blob
function blobToBuf(b) {
  if (b.arrayBuffer) return b.arrayBuffer();
  return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsArrayBuffer(b); });
}
function packVal(v) {
  if (v instanceof Blob) return blobToBuf(v).then(function (buf) { return { __blob: buf, type: v.type }; });
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    var out = {}, jobs = [];
    Object.keys(v).forEach(function (k) {
      if (v[k] instanceof Blob) jobs.push(packVal(v[k]).then(function (x) { out[k] = x; }));
      else out[k] = v[k];
    });
    return Promise.all(jobs).then(function () { return out; });
  }
  return Promise.resolve(v);
}
function unpackVal(v) {
  if (v && v.__blob) return new Blob([v.__blob], { type: v.type || 'image/jpeg' });
  if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach(function (k) { if (v[k] && v[k].__blob) v[k] = unpackVal(v[k]); });
  return v;
}
function idbGet(store, key) { return idb(store, 'readonly', function (s) { return s.get(key); }).then(unpackVal); }
function idbPut(store, key, val) { return packVal(val).then(function (pv) { return idb(store, 'readwrite', function (s) { s.put(pv, key); }); }); }
function idbDel(store, key) { return idb(store, 'readwrite', function (s) { s.delete(key); }); }
function idbKeys(store) { return idb(store, 'readonly', function (s) { return s.getAllKeys(); }); }

// ───────────── 紀錄清單 ─────────────

var raw = [];        // Apps Script 回傳的原始陣列，直接存 localStorage
var rows = [];       // 展開成物件
var byMinute = {};   // 'HH:MM' → 那格點亮的那一列
var rowsAt = 0;
var bookDirty = true;

function setRows(list) {
  raw = list || [];
  rows = raw.map(function (r) {
    return { date: r[0], minute: r[1], taken_at: r[2], file_id: r[3], thumb_id: r[4], lit: truthy(r[5]), cheat: truthy(r[6]), note: r[7], file_name: r[8] };
  });
  byMinute = {};
  rows.forEach(function (r) { if (r.lit && !byMinute[r.minute]) byMinute[r.minute] = r; });
  bookDirty = true;
}
function todayRows() { var t = fmtDate(new Date()); return rows.filter(function (r) { return r.date === t; }); }
function litCount() { return Object.keys(byMinute).length; }
function hourCount(h) {
  var n = 0, hh = two(h);
  for (var m = 0; m < 60; m++) if (byMinute[hh + ':' + two(m)]) n++;
  return n;
}
function loadRowsCache() {
  try {
    var c = JSON.parse(localStorage.getItem('rows') || 'null');
    if (c && c.rows) { setRows(c.rows); rowsAt = c.at || 0; }
  } catch (e) {}
}
function saveRowsCache() {
  rowsAt = Date.now();
  try { localStorage.setItem('rows', JSON.stringify({ rows: raw, at: rowsAt })); } catch (e) {}
}
function refreshRows() {
  return call('list').then(function (j) {
    setRows(j.rows);
    saveRowsCache();
    return syncThumbs();
  });
}

// ───────────── 縮圖快取：只補抓清單有、手機沒有的 ─────────────

var thumbURL = {};
function syncThumbs() {
  return idbKeys('thumbs').then(function (keys) {
    var have = {};
    keys.forEach(function (k) { have[k] = 1; });
    var need = [], seen = {};
    rows.forEach(function (r) { if (r.thumb_id && !have[r.thumb_id] && !seen[r.thumb_id]) { seen[r.thumb_id] = 1; need.push(r.thumb_id); } });
    return fetchThumbs(need);
  });
}
function fetchThumbs(ids) {
  if (!ids.length) return Promise.resolve();
  var batch = ids.slice(0, THUMB_BATCH), rest = ids.slice(THUMB_BATCH);
  return call('thumbs', { ids: batch }).then(function (j) {
    var puts = Object.keys(j.thumbs || {}).map(function (id) { return idbPut('thumbs', id, b64ToBlob(j.thumbs[id], 'image/jpeg')); });
    return Promise.all(puts);
  }).then(function () {
    onThumbsArrived();
    return fetchThumbs(rest);
  });
}
function onThumbsArrived() {
  if (current === 'scr-wall') drawWallThumbs();
  if (current === 'scr-book') loadVisiblePages();
}
function b64ToBlob(b64, mime) {
  var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
  for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function blobToB64(blob) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = function () { rej(fr.error); };
    fr.readAsDataURL(blob);
  });
}
function getThumbURL(id) {
  if (!id) return Promise.resolve(null);
  if (thumbURL[id]) return Promise.resolve(thumbURL[id]);
  return idbGet('thumbs', id).then(function (b) {
    if (!b) return null;
    thumbURL[id] = URL.createObjectURL(b);
    return thumbURL[id];
  });
}

// ───────────── 圖片處理：canvas 縮圖 ─────────────

function loadImage(blob) {
  return new Promise(function (res, rej) {
    var u = URL.createObjectURL(blob), im = new Image();
    im.onload = function () { URL.revokeObjectURL(u); res(im); };
    im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('Cannot read photo')); };
    im.src = u;
  });
}
function resizeToBlob(img, max, q, square) {
  var w = img.naturalWidth, h = img.naturalHeight;
  var c = document.createElement('canvas'), ctx = c.getContext('2d');
  if (square) {
    // 縮圖：3:4 直式，高 = max，從中間裁
    var tw = Math.round(max * 3 / 4), th = max, sw = w, sh = w * 4 / 3;
    if (sh > h) { sh = h; sw = h * 3 / 4; }
    c.width = tw; c.height = th;
    ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, tw, th);
  } else {
    var scale = Math.min(1, max / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return new Promise(function (res, rej) {
    c.toBlob(function (b) { if (b) res(b); else rej(new Error('Photo conversion failed')); }, 'image/jpeg', q);
  });
}

// ───────────── 畫面切換 ─────────────

var current = null, stack = [];
function show(id) {
  if (current === id) return;
  if (current) { $(current).hidden = true; $(current).classList.remove('in'); }
  var el = $(id);
  el.hidden = false;
  current = id;
  window.scrollTo(0, 0);
  requestAnimationFrame(function () { el.classList.add('in'); });
}
function go(id) { if (current) stack.push(current); show(id); }
function back() {
  var prev = stack.pop();
  if (prev === 'scr-wall' || prev === 'scr-book') show(prev);
  else { stack = []; home(); }
}
Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (b) { b.onclick = back; });

// 首頁：有暫存 → 待上傳；今天拍過 → 今天；否則 → 拍照
function home() {
  stack = [];
  return getPending().then(function (p) {
    if (p) return showPending(p);
    var t = todayRows();
    if (t.length) return showToday(t);
    return showShoot(false);
  }).catch(function (e) { toast('Cannot open saved photo: ' + errMsg(e), 4000); showShoot(false); });
}

// ───────────── 設定畫面 ─────────────

function showSetup() {
  show('scr-setup');
  $('setup-warn').hidden = standalone;
  $('setup-msg').textContent = '';
  $('setup-cancel').hidden = !cfg;
}
$('setup-save').onclick = function () {
  var c = parseLink($('setup-link').value);
  var msg = $('setup-msg');
  if (!c) { msg.textContent = 'That link is incomplete. It needs #k=… and &api=https://script.google.com/…'; return; }
  msg.textContent = 'Connecting…';
  $('setup-save').disabled = true;
  var old = cfg; cfg = c;
  setTransport('fetch');
  call('ping').then(function () {
    saveCfg(c);
    msg.textContent = 'Connected ✅';
    $('setup-link').value = '';
    return boot();
  }).catch(function (e) {
    cfg = old;
    msg.textContent = 'Cannot connect: ' + errMsg(e);
  }).then(function () { $('setup-save').disabled = false; });
};
$('setup-cancel').onclick = function () { home(); };

// 長按時鐘 1 秒 → 重新設定專屬連結（藏起來，不佔畫面）
(function () {
  var timer = 0, el = $('clock');
  function start() {
    timer = setTimeout(function () {
      timer = 0;
      if (confirm('Set up the private link again?')) showSetup();
    }, 1000);
  }
  function stop() { if (timer) { clearTimeout(timer); timer = 0; } }
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', stop);
  el.addEventListener('touchcancel', stop);
  el.addEventListener('touchmove', stop);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
})();

// ───────────── 拍照畫面 ─────────────

var cheatMode = false;
function showShoot(cheat) {
  cheatMode = !!cheat;
  $('cheat-banner').hidden = !cheatMode;
  $('shoot-cancel-cheat').hidden = !cheatMode;
  $('btn-shoot').disabled = false;
  show('scr-shoot');
  tick();
}
var lastWallMinute = '';
function tick() {
  var d = new Date(), m = fmtMinute(d);
  $('clock').textContent = m;
  if (current === 'scr-wall' && m !== lastWallMinute) { lastWallMinute = m; drawWallMarkers(); }
  if (current !== 'scr-shoot') return;
  var owned = !!byMinute[m];
  var el = $('minute-status');
  el.textContent = m + (owned ? ' taken' : ' free');
  el.className = 'minute-status ' + (owned ? 'owned' : 'free');
  $('hour-progress').textContent = 'This hour ' + hourCount(d.getHours()) + '/60';
}
setInterval(tick, 1000);

$('btn-shoot').onclick = function () { $('file').value = ''; $('file').click(); };
$('shoot-cancel-cheat').onclick = function () { cheatMode = false; home(); };
$('shoot-wall').onclick = function () { showWall(); };

$('file').onchange = function () {
  var f = this.files && this.files[0];
  if (!f) return;
  // 格子看檔案時間（iPhone 寫入照片的那一刻，比快門晚幾秒）；
  // 檔案時間怪怪的（例如超過 10 分鐘前）就改用照片回到 App 的現在時間
  var now = Date.now(), lm = f.lastModified;
  var age = now - lm;
  var t = new Date(lm && age >= 0 && age < 10 * 60 * 1000 ? lm : now);
  $('btn-shoot').disabled = true;
  processPhoto(f, { id: 'p' + now, date: fmtDate(t), minute: fmtMinute(t), taken_at: fmtISO(t), cheat: cheatMode });
};

// ───────────── 處理 → 暫存 → 上傳 ─────────────

var pendingURL = null;
function setPendingImg(blob) {
  if (pendingURL) URL.revokeObjectURL(pendingURL);
  pendingURL = URL.createObjectURL(blob);
  $('pending-img').src = pendingURL;
}
function setPendingUI(title, sub) {
  $('pending-title').textContent = title;
  $('pending-sub').textContent = sub || '';
}
function getPending() { return idbGet('pending', 'current'); }

function processPhoto(file, meta) {
  stack = [];
  show('scr-pending');
  $('pending-ask').hidden = true; $('pending-actions').hidden = true;
  setPendingImg(file);
  setPendingUI('Processing…', meta.minute);
  $('pending-stamp').textContent = stampText(meta.date, meta.minute);
  var img;
  return loadImage(file).then(function (im) {
    img = im;
    return resizeToBlob(img, LONG_EDGE, JPEG_Q, false);
  }).then(function (photo) {
    return resizeToBlob(img, MEDIUM, MEDIUM_Q, false).then(function (medium) {
      return resizeToBlob(img, THUMB, THUMB_Q, true).then(function (thumb) {
        return { photo: photo, medium: medium, thumb: thumb };
      });
    });
  }).then(function (b) {
    img = null;
    var p = { id: meta.id, date: meta.date, minute: meta.minute, taken_at: meta.taken_at, cheat: meta.cheat, status: 'new', photo: b.photo, medium: b.medium, thumb: b.thumb };
    return idbPut('pending', 'current', p).then(function () {
      setPendingImg(p.medium);
      return decide(p);
    });
  }).catch(function (e) {
    setPendingUI('Processing failed', errMsg(e));
    $('pending-actions').hidden = false;
  });
}

function showPending(p) {
  stack = [];
  show('scr-pending');
  $('pending-ask').hidden = true; $('pending-actions').hidden = true;
  setPendingImg(p.medium || p.photo);
  $('pending-stamp').textContent = stampText(p.date, p.minute);
  if (p.status === 'confirmed') return upload(p);
  return decide(p);
}

// 那格空的 → 直接上傳；已擁有 → 問一句
function decide(p) {
  if (p.status === 'new' && byMinute[p.minute]) {
    setPendingUI(p.minute + ' taken', 'This minute is already lit');
    $('pending-ask-text').textContent = p.minute + ' is taken. Keep this one anyway?';
    $('pending-ask').hidden = false;
    return;
  }
  return upload(p);
}
$('pending-retake').onclick = function () {
  idbDel('pending', 'current').then(function () { showShoot(cheatMode); });
};
$('pending-keep').onclick = function () {
  getPending().then(function (p) {
    if (!p) return home();
    p.status = 'confirmed';
    return idbPut('pending', 'current', p).then(function () { return upload(p); });
  });
};
$('pending-retry').onclick = function () {
  getPending().then(function (p) { if (p) upload(p); else home(); });
};
$('pending-discard').onclick = function () {
  if (!confirm('Discard this photo? It will be deleted from your phone.')) return;
  idbDel('pending', 'current').then(function () { home(); });
};

var uploading = false;
function upload(p) {
  if (uploading) return;
  uploading = true;
  $('pending-ask').hidden = true; $('pending-actions').hidden = true;
  var persist = Promise.resolve();
  if (p.status !== 'confirmed') { p.status = 'confirmed'; persist = idbPut('pending', 'current', p); }
  if (navigator.onLine === false) {
    uploading = false;
    setPendingUI('Waiting to upload', 'No connection. It will upload next time you open the app online.');
    $('pending-actions').hidden = false;
    return persist;
  }
  setPendingUI('Uploading…', p.minute + (p.cheat ? ' · cheat' : ''));
  return persist.then(function () {
    return Promise.all([blobToB64(p.photo), blobToB64(p.thumb)]);
  }).then(function (b) {
    return call('upload', { uid: p.id, date: p.date, minute: p.minute, taken_at: p.taken_at, cheat: !!p.cheat, photo: b[0], thumb: b[1] });
  }).then(function (j) {
    var r = j.row;
    raw.push(r); setRows(raw); saveRowsCache();
    var jobs = [idbDel('pending', 'current')];
    if (r[4]) jobs.push(idbPut('thumbs', r[4], p.thumb));
    if (r[8]) jobs.push(putMedium(r[8], p.medium));
    return Promise.all(jobs).then(function () {
      uploading = false;
      toast(truthy(r[5]) ? p.minute + ' lit ✨' : p.minute + ' taken, saved as extra');
      return home();
    });
  }).catch(function (e) {
    uploading = false;
    setPendingUI('Waiting to upload', 'Upload failed: ' + errMsg(e) + '. The photo is still on your phone.');
    $('pending-actions').hidden = false;
  });
}

// 中圖快取只留最近 50 張
function putMedium(name, blob) {
  return idbPut('medium', name, blob).then(function () { return idbKeys('medium'); }).then(function (keys) {
    keys.sort();
    var extra = keys.length - MEDIUM_KEEP;
    if (extra <= 0) return;
    return Promise.all(keys.slice(0, extra).map(function (k) { return idbDel('medium', k); }));
  });
}

// 顯示一張照片：中圖快取 → 沒有就先放縮圖、再去抓原圖
var photoReq = 0;
function showPhotoInto(img, r) {
  var my = ++photoReq;
  img.removeAttribute('src');
  return idbGet('medium', r.file_name).then(function (b) {
    if (b) { if (my === photoReq) img.src = URL.createObjectURL(b); return; }
    return getThumbURL(r.thumb_id).then(function (u) {
      if (u && my === photoReq) img.src = u;
      return call('photo', { id: r.file_id });
    }).then(function (j) {
      return loadImage(b64ToBlob(j.data, 'image/jpeg'));
    }).then(function (im) {
      return resizeToBlob(im, MEDIUM, MEDIUM_Q, false);
    }).then(function (m) {
      return putMedium(r.file_name, m).then(function () { if (my === photoReq) img.src = URL.createObjectURL(m); });
    }).catch(function (e) { toast('Could not load photo: ' + errMsg(e), 4000); });
  });
}

// ───────────── 今天已經拍過 ─────────────

function showToday(t) {
  var last = t[t.length - 1];
  show('scr-today');
  var tags = [];
  if (!last.lit) tags.push('extra');
  if (last.cheat) tags.push('cheat');
  // 標題只放時間，標記和張數放下面那行，大字才不會折行
  $('today-title').textContent = 'Today ' + last.minute;
  if (t.length > 1) tags.push(t.length + ' moments today');
  $('today-sub').textContent = tags.join(' · ');
  $('today-stamp').textContent = stampText(last.date, last.minute);
  showPhotoInto($('today-img'), last);
}
$('today-wall').onclick = function () { showWall(); };
$('today-book').onclick = function () { showBook(new Date().getHours()); };
$('today-cheat').onclick = function () {
  if (confirm('Already lit today. Cheat?')) showShoot(true);
};

// ───────────── 總覽：24 欄 × 60 列拼貼 ─────────────
// 寬度撐滿畫面、高度量實際剩下的空間；格子可以比高寬一點，縮圖從中間裁

var CW = 12, CH = 12;
function showWall() {
  go('scr-wall');
  renderWall();
}
function cellX(mn) { return +mn.slice(0, 2) * CW; }
function cellY(mn) { return +mn.slice(3) * CH; }
function renderWall() {
  var canvas = $('wall'), scr = $('scr-wall'), cs = getComputedStyle(scr);
  var maxW = scr.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  var top = $('wall-wrap').getBoundingClientRect().top;
  var maxH = window.innerHeight - top - parseFloat(cs.paddingBottom);
  CW = Math.max(6, Math.floor(maxW / 24 * 2) / 2);
  CH = Math.max(6, Math.min(CW, Math.floor(maxH / 60 * 2) / 2));
  var W = CW * 24, H = CH * 60;
  var dpr = window.devicePixelRatio || 1;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  $('wall-wrap').style.width = W + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ACCENT_DIM;
  Object.keys(byMinute).forEach(function (m) { ctx.fillRect(cellX(m), cellY(m), CW - 1, CH - 1); });
  var labels = $('wall-labels');
  labels.style.width = W + 'px';
  labels.innerHTML = '';
  for (var h = 0; h < 24; h++) { var s = document.createElement('span'); s.textContent = h % 6 === 0 ? h : ''; labels.appendChild(s); }
  $('wall-progress').textContent = litCount() + '/1440';
  lastWallMinute = '';
  drawWallMarkers();
  drawWallThumbs();
}

// 標記層：畫在另一張覆蓋的畫布上，不會被拼貼快取蓋掉
function drawWallMarkers() {
  var ov = $('wall-overlay'), dpr = window.devicePixelRatio || 1;
  var w = CW * 24, h = CH * 60;
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  ov.width = Math.round(w * dpr);
  ov.height = Math.round(h * dpr);
  var ctx = ov.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 今天拍的格子：細白框
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  todayRows().forEach(function (r) {
    ctx.strokeRect(cellX(r.minute) + .5, cellY(r.minute) + .5, CW - 2, CH - 2);
  });
  // 現在這一分鐘：琥珀色粗框
  var now = fmtMinute(new Date());
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(cellX(now) - .5, cellY(now) - .5, CW + 1, CH + 1);
}

// 縮圖是正方形，格子可能比較寬：從中間裁出同比例的一塊再畫
function drawThumb(ctx, im, x, y) {
  var w = CW - 1, h = CH - 1, iw = im.naturalWidth, ih = im.naturalHeight;
  var sw = iw, sh = iw * h / w;
  if (sh > ih) { sh = ih; sw = ih * w / h; }
  ctx.drawImage(im, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

// 拼貼存成一張圖片快取，之後只補畫新格子
var wallDrawing = false;
function drawWallThumbs() {
  if (wallDrawing) return;
  wallDrawing = true;
  var canvas = $('wall'), ctx = canvas.getContext('2d');
  var drawn = {}, sizeKey = CW + 'x' + CH;
  idbGet('misc', 'mosaic').then(function (m) {
    if (!(m && m.cell === sizeKey && m.blob)) return;
    return loadImage(m.blob).then(function (im) {
      ctx.drawImage(im, 0, 0, CW * 24, CH * 60);
      drawn = m.drawn || {};
      // 格子換了照片（例如重建後）就先蓋回色塊
      Object.keys(drawn).forEach(function (id) {
        var mn = drawn[id];
        if (!byMinute[mn] || byMinute[mn].thumb_id !== id) {
          ctx.fillStyle = byMinute[mn] ? ACCENT_DIM : '#0d0d0d';
          ctx.fillRect(cellX(mn), cellY(mn), CW - 1, CH - 1);
          delete drawn[id];
        }
      });
    }).catch(function () { drawn = {}; });
  }).then(function () {
    var todo = Object.keys(byMinute).filter(function (mn) { var r = byMinute[mn]; return r.thumb_id && drawn[r.thumb_id] !== mn; });
    return drawCells(ctx, todo, drawn);
  }).then(function (changed) {
    wallDrawing = false;
    if (!changed) return;
    canvas.toBlob(function (b) { if (b) idbPut('misc', 'mosaic', { cell: sizeKey, blob: b, drawn: drawn }); }, 'image/jpeg', 0.9);
  }).catch(function (e) { wallDrawing = false; toast('Wall failed: ' + errMsg(e), 4000); });
}
function drawCells(ctx, minutes, drawn) {
  var changed = false, i = 0;
  return new Promise(function (done) {
    (function next() {
      if (i >= minutes.length) return done(changed);
      var batch = minutes.slice(i, i + 24);
      i += 24;
      var chain = Promise.resolve();
      batch.forEach(function (mn) {
        chain = chain.then(function () {
          var r = byMinute[mn];
          return idbGet('thumbs', r.thumb_id).then(function (b) {
            if (!b) return;
            return loadImage(b).then(function (im) {
              drawThumb(ctx, im, cellX(mn), cellY(mn));
              drawn[r.thumb_id] = mn;
              changed = true;
            });
          }).catch(function () {});
        });
      });
      chain.then(function () { setTimeout(next, 0); });
    })();
  });
}
$('wall').onclick = function (e) {
  var rect = this.getBoundingClientRect();
  var h = Math.floor((e.clientX - rect.left) / CW);
  if (h >= 0 && h < 24) showBook(h);
};

// ───────────── 小時書：24 頁，一頁 60 格 ─────────────

var bookHour = 0, scrollRaf = 0;
function showBook(hour) {
  go('scr-book');
  var pages = $('book-pages');
  if (bookDirty || !pages.children.length) buildBook();
  bookHour = hour;
  updateBookTitle(hour);
  requestAnimationFrame(function () {
    pages.scrollLeft = hour * pages.clientWidth;
    loadVisiblePages();
  });
}
function buildBook() {
  var pages = $('book-pages');
  pages.innerHTML = '';
  for (var h = 0; h < 24; h++) {
    var pg = document.createElement('div');
    pg.className = 'page';
    var grid = document.createElement('div');
    grid.className = 'grid';
    for (var m = 0; m < 60; m++) {
      var mn = two(h) + ':' + two(m);
      var cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.minute = mn;
      var r = byMinute[mn];
      if (r) {
        cell.classList.add('lit');
        var im = document.createElement('img');
        im.alt = '';
        im.dataset.thumb = r.thumb_id || '';
        cell.appendChild(im);
      }
      var lab = document.createElement('span');
      lab.textContent = two(m);
      cell.appendChild(lab);
      grid.appendChild(cell);
    }
    pg.appendChild(grid);
    pages.appendChild(pg);
  }
  bookDirty = false;
}
function updateBookTitle(h) {
  $('book-title').textContent = two(h) + ':00 · ' + hourCount(h) + '/60';
  Array.prototype.forEach.call($('book-dots').children, function (b, i) {
    b.classList.toggle('on', i === h);
    b.classList.toggle('has', hourCount(i) > 0);
  });
}
function buildBookDots() {
  var d = $('book-dots');
  d.innerHTML = '';
  for (var h = 0; h < 24; h++) {
    var b = document.createElement('button');
    b.dataset.hour = h;
    b.setAttribute('aria-label', two(h) + ':00');
    d.appendChild(b);
  }
}
buildBookDots();
$('book-dots').addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('button') : null;
  if (!b) return;
  var pages = $('book-pages');
  pages.scrollTo({ left: +b.dataset.hour * pages.clientWidth, behavior: 'smooth' });
});
function loadVisiblePages() {
  var pages = $('book-pages').children;
  for (var h = Math.max(0, bookHour - 1); h <= Math.min(23, bookHour + 1); h++) {
    var imgs = pages[h] ? pages[h].querySelectorAll('img:not([src])') : [];
    Array.prototype.forEach.call(imgs, function (im) {
      getThumbURL(im.dataset.thumb).then(function (u) { if (u) im.src = u; });
    });
  }
}
$('book-pages').addEventListener('scroll', function () {
  if (scrollRaf) return;
  var pages = this;
  scrollRaf = requestAnimationFrame(function () {
    scrollRaf = 0;
    var h = Math.max(0, Math.min(23, Math.round(pages.scrollLeft / pages.clientWidth)));
    if (h !== bookHour) { bookHour = h; updateBookTitle(h); }
    loadVisiblePages();
  });
});
$('book-pages').addEventListener('click', function (e) {
  var cell = e.target.closest ? e.target.closest('.cell.lit') : null;
  if (!cell) return;
  var r = byMinute[cell.dataset.minute];
  if (r) showView(r);
});

// ───────────── 看單張 ─────────────

function showView(r) {
  go('scr-view');
  $('view-title').textContent = r.minute;
  var extra = rows.filter(function (x) { return x.minute === r.minute && x !== r; }).length;
  var tags = [r.date];
  if (r.cheat) tags.push('cheat');
  if (extra) tags.push(extra + ' more this minute');
  $('view-sub').textContent = tags.join(' · ');
  $('view-stamp').textContent = stampText(r.date, r.minute);
  showPhotoInto($('view-img'), r);
}

// ───────────── 啟動 ─────────────

function boot() {
  if (!loadCfg()) {
    var fromHash = parseLink(location.hash);
    if (fromHash) {
      saveCfg(fromHash);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  if (!cfg) return showSetup();
  loadRowsCache();
  return home().then(function () {
    return refreshRows().then(function () {
      if (current === 'scr-shoot' && !cheatMode && todayRows().length) return home();
      if (current === 'scr-today') return showToday(todayRows());
      if (current === 'scr-wall') renderWall();
      tick();
    });
  }).catch(function (e) { toast('Sync failed: ' + errMsg(e), 4000); });
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !cfg) return;
  tick();
  getPending().then(function (p) {
    if (p && p.status === 'confirmed' && !uploading) return showPending(p);
    if (Date.now() - rowsAt > REFRESH_MS) return refreshRows().then(function () { if (current === 'scr-shoot' || current === 'scr-today') home(); });
  }).catch(function () {});
});
window.addEventListener('online', function () {
  getPending().then(function (p) { if (p && p.status === 'confirmed' && !uploading) showPending(p); }).catch(function () {});
});

boot();
})();
