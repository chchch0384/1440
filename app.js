/* 1440 — 網頁 App（路 C：按「拍」叫出原生相機） */
(function () {
'use strict';

var LONG_EDGE = 3000, MEDIUM = 1200, THUMB = 200;
var JPEG_Q = 0.88, MEDIUM_Q = 0.85, THUMB_Q = 0.8;
var THUMB_BATCH = 60, MEDIUM_KEEP = 50, REFRESH_MS = 10 * 60 * 1000;

// ───────────── 小工具 ─────────────

var $ = function (id) { return document.getElementById(id); };
function two(n) { return (n < 10 ? '0' : '') + n; }
function fmtDate(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
function fmtMinute(d) { return two(d.getHours()) + ':' + two(d.getMinutes()); }
function fmtISO(d) {
  var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  off = Math.abs(off);
  return fmtDate(d) + 'T' + fmtMinute(d) + ':' + two(d.getSeconds()) + sign + two(Math.floor(off / 60)) + ':' + two(off % 60);
}
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'TRUE' || v === 'true'; }
function errMsg(e) { return String((e && e.message) || e || '未知錯誤'); }
var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

var toastTimer = null;
function toast(msg, ms) {
  var t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2500);
}
window.addEventListener('error', function (e) { toast('錯誤：' + (e.message || '未知'), 5000); });

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

function call(action, data) {
  var body = { key: cfg.k, action: action };
  if (data) Object.keys(data).forEach(function (k) { body[k] = data[k]; });
  // credentials: 'omit' 不帶 Google 登入 cookie，免得 Safari 被導到登入頁或帳號選擇頁
  return fetch(cfg.api, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
    credentials: 'omit', redirect: 'follow', cache: 'no-store'
  }).catch(function (e) {
    throw new Error('網路連不到收件員（' + errMsg(e) + '）');
  }).then(function (r) {
    return r.text().then(function (t) {
      var j;
      try { j = JSON.parse(t); } catch (e) {
        var peek = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error('收件員回的不是資料（HTTP ' + r.status + '，' + (r.url || '').split('?')[0].slice(0, 60) + '）：' + (peek || '空白'));
      }
      if (!j || !j.ok) throw new Error((j && (j.message || j.error)) || '回應格式錯誤');
      return j;
    });
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
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error); };
    });
  });
}
function idbGet(store, key) { return idb(store, 'readonly', function (s) { return s.get(key); }); }
function idbPut(store, key, val) { return idb(store, 'readwrite', function (s) { s.put(val, key); }); }
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
    im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('無法讀取照片')); };
    im.src = u;
  });
}
function resizeToBlob(img, max, q, square) {
  var w = img.naturalWidth, h = img.naturalHeight;
  var c = document.createElement('canvas'), ctx = c.getContext('2d');
  if (square) {
    var s = Math.min(w, h);
    c.width = c.height = max;
    ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, max, max);
  } else {
    var scale = Math.min(1, max / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return new Promise(function (res, rej) {
    c.toBlob(function (b) { if (b) res(b); else rej(new Error('照片轉檔失敗')); }, 'image/jpeg', q);
  });
}

// ───────────── 畫面切換 ─────────────

var current = null, stack = [];
function show(id) {
  if (current === id) return;
  if (current) $(current).hidden = true;
  $(id).hidden = false;
  current = id;
  window.scrollTo(0, 0);
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
  }).catch(function (e) { toast('打不開暫存：' + errMsg(e), 4000); showShoot(false); });
}

// ───────────── 設定畫面 ─────────────

function showSetup() {
  show('scr-setup');
  $('setup-warn').hidden = standalone;
  $('setup-msg').textContent = '';
}
$('setup-save').onclick = function () {
  var c = parseLink($('setup-link').value);
  var msg = $('setup-msg');
  if (!c) { msg.textContent = '這串少了東西。專屬連結要包含 #k=… 和 &api=https://script.google.com/…'; return; }
  msg.textContent = '測試連線中…';
  $('setup-save').disabled = true;
  var old = cfg; cfg = c;
  call('ping').then(function () {
    saveCfg(c);
    msg.textContent = '連上了 ✅';
    $('setup-link').value = '';
    return boot();
  }).catch(function (e) {
    cfg = old;
    msg.textContent = '連不上：' + errMsg(e) + '。檢查 Apps Script 有沒有部署成「所有人」、密鑰對不對。';
  }).then(function () { $('setup-save').disabled = false; });
};
$('wall-resetup').onclick = function () { showSetup(); };

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
function tick() {
  var d = new Date(), m = fmtMinute(d);
  $('clock').textContent = m;
  if (current !== 'scr-shoot') return;
  var owned = !!byMinute[m];
  var el = $('minute-status');
  el.textContent = owned ? '⚪ ' + m + ' 已擁有' : '🟢 ' + m + ' 空的';
  el.className = 'minute-status ' + (owned ? 'owned' : 'free');
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
  setPendingUI('處理照片中…', meta.minute);
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
    setPendingUI('照片處理失敗', errMsg(e));
    $('pending-actions').hidden = false;
  });
}

function showPending(p) {
  stack = [];
  show('scr-pending');
  $('pending-ask').hidden = true; $('pending-actions').hidden = true;
  setPendingImg(p.medium || p.photo);
  if (p.status === 'confirmed') return upload(p);
  return decide(p);
}

// 那格空的 → 直接上傳；已擁有 → 問一句
function decide(p) {
  if (p.status === 'new' && byMinute[p.minute]) {
    setPendingUI(p.minute + ' 已擁有', '這一分鐘已經點亮過了');
    $('pending-ask-text').textContent = p.minute + ' 已經有了，還是要記錄嗎？';
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
  if (!confirm('確定放棄這張？照片會從手機刪掉。')) return;
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
    setPendingUI('待上傳', '現在沒有網路。有網路時再打開 App 會自動補傳。');
    $('pending-actions').hidden = false;
    return persist;
  }
  setPendingUI('上傳中…', p.minute + (p.cheat ? ' · 作弊' : ''));
  return persist.then(function () {
    return Promise.all([blobToB64(p.photo), blobToB64(p.thumb)]);
  }).then(function (b) {
    return call('upload', { date: p.date, minute: p.minute, taken_at: p.taken_at, cheat: !!p.cheat, photo: b[0], thumb: b[1] });
  }).then(function (j) {
    var r = j.row;
    raw.push(r); setRows(raw); saveRowsCache();
    var jobs = [idbDel('pending', 'current')];
    if (r[4]) jobs.push(idbPut('thumbs', r[4], p.thumb));
    if (r[8]) jobs.push(putMedium(r[8], p.medium));
    return Promise.all(jobs).then(function () {
      uploading = false;
      toast(truthy(r[5]) ? '收進 ' + p.minute + ' ✨' : p.minute + ' 已擁有，存成額外照片');
      return home();
    });
  }).catch(function (e) {
    uploading = false;
    setPendingUI('待上傳', '上傳沒成功：' + errMsg(e) + '。照片還在手機裡。');
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
    }).catch(function (e) { toast('抓原圖失敗：' + errMsg(e), 4000); });
  });
}

// ───────────── 今天已經拍過 ─────────────

function showToday(t) {
  var last = t[t.length - 1];
  show('scr-today');
  var tags = [];
  if (!last.lit) tags.push('額外照片');
  if (last.cheat) tags.push('作弊');
  $('today-title').textContent = '今天 ' + last.minute + (tags.length ? ' · ' + tags.join(' · ') : '');
  $('today-sub').textContent = t.length > 1 ? '今天記了 ' + t.length + ' 個瞬間' : '';
  showPhotoInto($('today-img'), last);
}
$('today-wall').onclick = function () { showWall(); };
$('today-book').onclick = function () { showBook(new Date().getHours()); };
$('today-cheat').onclick = function () {
  if (confirm('今天已經點亮了，確定要作弊嗎？')) showShoot(true);
};

// ───────────── 總覽：24 欄 × 60 列拼貼 ─────────────

var CELL = 12;
function showWall() {
  go('scr-wall');
  renderWall();
}
function renderWall() {
  var canvas = $('wall');
  var maxW = window.innerWidth - 32, maxH = window.innerHeight - 150;
  CELL = Math.max(6, Math.min(Math.floor(maxW / 24), Math.floor(maxH / 60)));
  var dpr = window.devicePixelRatio || 1;
  canvas.style.width = CELL * 24 + 'px';
  canvas.style.height = CELL * 60 + 'px';
  canvas.width = CELL * 24 * dpr;
  canvas.height = CELL * 60 * dpr;
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, CELL * 24, CELL * 60);
  ctx.fillStyle = '#3a3a3c';
  Object.keys(byMinute).forEach(function (m) {
    ctx.fillRect(+m.slice(0, 2) * CELL, +m.slice(3) * CELL, CELL - 1, CELL - 1);
  });
  var labels = $('wall-labels');
  labels.style.width = CELL * 24 + 'px';
  labels.innerHTML = '';
  for (var h = 0; h < 24; h++) { var s = document.createElement('span'); s.textContent = h % 6 === 0 ? h : ''; labels.appendChild(s); }
  $('wall-progress').textContent = '已收集 ' + litCount() + ' / 1440';
  drawWallThumbs();
}

// 拼貼存成一張圖片快取，之後只補畫新格子
var wallDrawing = false;
function drawWallThumbs() {
  if (wallDrawing) return;
  wallDrawing = true;
  var canvas = $('wall'), ctx = canvas.getContext('2d');
  var drawn = {};
  idbGet('misc', 'mosaic').then(function (m) {
    if (!(m && m.cell === CELL && m.blob)) return;
    return loadImage(m.blob).then(function (im) {
      ctx.drawImage(im, 0, 0, CELL * 24, CELL * 60);
      drawn = m.drawn || {};
      // 格子換了照片（例如重建後）就先蓋回色塊
      Object.keys(drawn).forEach(function (id) {
        var mn = drawn[id];
        if (!byMinute[mn] || byMinute[mn].thumb_id !== id) {
          ctx.fillStyle = byMinute[mn] ? '#3a3a3c' : '#111';
          ctx.fillRect(+mn.slice(0, 2) * CELL, +mn.slice(3) * CELL, CELL - 1, CELL - 1);
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
    canvas.toBlob(function (b) { if (b) idbPut('misc', 'mosaic', { cell: CELL, blob: b, drawn: drawn }); }, 'image/jpeg', 0.9);
  }).catch(function (e) { wallDrawing = false; toast('畫總覽失敗：' + errMsg(e), 4000); });
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
              ctx.drawImage(im, +mn.slice(0, 2) * CELL, +mn.slice(3) * CELL, CELL - 1, CELL - 1);
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
  var h = Math.floor((e.clientX - rect.left) / CELL);
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
  var n = 0;
  for (var m = 0; m < 60; m++) if (byMinute[two(h) + ':' + two(m)]) n++;
  $('book-title').textContent = h + ' 點 · 已收 ' + n + ' / 60';
}
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
  if (r.cheat) tags.push('作弊');
  if (extra) tags.push('同一分鐘還有 ' + extra + ' 張');
  $('view-sub').textContent = tags.join(' · ');
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
  }).catch(function (e) { toast('同步失敗：' + errMsg(e), 4000); });
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
