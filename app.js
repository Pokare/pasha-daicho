/* パシャ台帳 — 撮るだけで工事写真台帳（ブラウザ完結・外部API不使用） */
'use strict';

/* ================================================================
 * 定数・ユーティリティ
 * ================================================================ */
const SETTINGS_KEY = 'pasha.settings.v1';
const PHOTOS_KEY = 'pasha.photos.v1';
const KOUSYU_PRESETS = ['土工', '型枠', '鉄筋', '仕上げ', '設備', '安全管理'];
const DEFAULT_BB = { x: 0.03, y: 0.97, scale: 0.40, visible: true };
const BOARD_GREEN = '#17563F';
const BOARD_EDGE = '#0E3B2B';
const FONT_STACK = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
const THUMB_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"%3E%3Crect width="4" height="3" fill="%23D1D5DB"/%3E%3C/svg%3E';

const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, '0');
const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// 非表示タブではrAFが発火しないため、タイムアウトと競争させる
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const fin = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 60);
});
const YOUBI = ['日', '月', '火', '水', '木', '金', '土'];

const fmtSlash = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
const fmtJP = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
const ymdKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtMD = (d) => `${d.getMonth() + 1}/${d.getDate()}(${YOUBI[d.getDay()]})`;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================
 * 状態・永続化
 * ================================================================ */
let settings = {
  projectName: '',
  contractor: '',
  kousyuPresets: KOUSYU_PRESETS.slice(),
  last: { kousyu: KOUSYU_PRESETS[0], location: '' },
  locationHistory: [],
};
let photos = []; // メタ配列。画像BlobはIndexedDB

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) settings = Object.assign(settings, s);
    if (!settings.last) settings.last = { kousyu: KOUSYU_PRESETS[0], location: '' };
    if (!Array.isArray(settings.kousyuPresets) || !settings.kousyuPresets.length) {
      settings.kousyuPresets = KOUSYU_PRESETS.slice();
    }
  } catch (e) { /* 壊れていたら初期値 */ }
  try {
    const p = JSON.parse(localStorage.getItem(PHOTOS_KEY) || 'null');
    if (Array.isArray(p)) photos = p;
  } catch (e) { photos = []; }
}
function persistSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function persistPhotos() { localStorage.setItem(PHOTOS_KEY, JSON.stringify(photos)); }

function pushLocationHistory(loc) {
  if (!loc) return;
  settings.locationHistory = [loc].concat(settings.locationHistory.filter((l) => l !== loc)).slice(0, 10);
}

/* ---------------- IndexedDB（画像Blob） ---------------- */
let db = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pasha', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('images', { keyPath: 'id' }); };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(rec) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('idb unavailable')); return; }
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function idbGet(id) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(null); return; }
    const tx = db.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function idbDel(id) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* サムネイルのobjectURLキャッシュ */
const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  try {
    const rec = await idbGet(id);
    if (rec && rec.thumb) {
      const url = URL.createObjectURL(rec.thumb);
      thumbUrls.set(id, url);
      return url;
    }
  } catch (e) { /* fallthrough */ }
  return THUMB_PLACEHOLDER;
}
function revokeThumb(id) {
  const url = thumbUrls.get(id);
  if (url) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
}

/* ================================================================
 * EXIF DateTimeOriginal 自前ミニパーサ（先頭128KBのみ走査）
 * ================================================================ */
async function parseExifDateTime(file) {
  try {
    const buf = await file.slice(0, 131072).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) break;
      const size = v.getUint16(off + 2);
      if (marker === 0xFFE1 && off + 10 <= v.byteLength &&
          v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {
        return parseTiffDate(v, off + 10);
      }
      if (marker === 0xFFDA) break; // 画像データ開始
      off += 2 + size;
    }
  } catch (e) { /* EXIFなし扱い */ }
  return null;
}
function parseTiffDate(v, t) {
  try {
    const little = v.getUint16(t) === 0x4949;
    const g16 = (o) => v.getUint16(t + o, little);
    const g32 = (o) => v.getUint32(t + o, little);
    if (g16(2) !== 42) return null;
    const ifd0 = g32(4);
    let exifOff = 0;
    const n = g16(ifd0);
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (g16(e) === 0x8769) { exifOff = g32(e + 8); break; }
    }
    if (!exifOff) return null;
    const m = g16(exifOff);
    for (let i = 0; i < m; i++) {
      const e = exifOff + 2 + i * 12;
      if (g16(e) === 0x9003) { // DateTimeOriginal
        const count = g32(e + 4);
        const strOff = count > 4 ? g32(e + 8) : e + 8;
        let s = '';
        for (let j = 0; j < Math.min(count, 20); j++) {
          const c = v.getUint8(t + strOff + j);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        const mm = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        if (mm) {
          const d = new Date(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]);
          if (!isNaN(d)) return d;
        }
        return null;
      }
    }
  } catch (e) { /* 途中で失敗したら諦める */ }
  return null;
}

/* ================================================================
 * 画像ユーティリティ
 * ================================================================ */
async function fileToBitmap(fileOrBlob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { return await createImageBitmap(fileOrBlob); } catch (e2) { /* imgへ */ }
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
function srcSize(src) {
  return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
}
function drawToCanvas(src, maxLong) {
  const { w, h } = srcSize(src);
  const scale = Math.min(1, maxLong / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
function canvasToBlob(cv, q = 0.85) {
  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', q);
  });
}

/* ================================================================
 * 電子小黒板の合成（勝負どころ）
 * ================================================================ */
function boardGeom(W, H, bb) {
  const mg = Math.max(8, Math.round(W * 0.01));
  let bw = Math.max(W * bb.scale, 260);
  bw = Math.min(bw, W - mg * 2);
  const rowH = bw * 0.115;
  const bh = rowH * 5;
  let bx = clamp(W * bb.x, mg, Math.max(mg, W - bw - mg));
  let by = clamp(H * bb.y - bh, mg, Math.max(mg, H - bh - mg));
  return { bx, by, bw, bh, rowH };
}

function boardFont(px, weight = 700) {
  return `${weight} ${Math.max(9, Math.round(px))}px ${FONT_STACK}`;
}

function drawFitText(ctx, text, x, cy, maxW, basePx, align) {
  if (!text) return;
  let size = basePx;
  const minPx = basePx * 0.5;
  ctx.font = boardFont(size);
  while (ctx.measureText(text).width > maxW && size > minPx) {
    size -= 1;
    ctx.font = boardFont(size);
  }
  let t = text;
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
  if (t !== text) t = t.slice(0, -1) + '…';
  let tx = x;
  if (align === 'center') tx = x + (maxW - ctx.measureText(t).width) / 2;
  ctx.textBaseline = 'middle';
  ctx.fillText(t, tx, cy);
}

/* src(canvas/bitmap)に黒板を合成して canvas を返す。target再利用可 */
function composeBlackboard(src, meta, target) {
  const { w: W, h: H } = srcSize(src);
  const cv = target || document.createElement('canvas');
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(src, 0, 0, W, H);
  const bb = meta.blackboard || DEFAULT_BB;
  if (bb.visible === false) return cv;

  const { bx, by, bw, bh, rowH } = boardGeom(W, H, bb);

  // 外縁 → 盤面 → 白枠
  const edge = Math.max(1.5, bw * 0.006);
  ctx.fillStyle = BOARD_EDGE;
  ctx.fillRect(bx - edge, by - edge, bw + edge * 2, bh + edge * 2);
  ctx.fillStyle = BOARD_GREEN;
  ctx.fillRect(bx, by, bw, bh);
  const frame = Math.max(2, bw * 0.012);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = frame;
  ctx.strokeRect(bx + frame / 2, by + frame / 2, bw - frame, bh - frame);

  // 罫線
  ctx.lineWidth = Math.max(1, bw * 0.0045);
  ctx.beginPath();
  for (let i = 1; i < 5; i++) {
    ctx.moveTo(bx + frame, by + rowH * i);
    ctx.lineTo(bx + bw - frame, by + rowH * i);
  }
  const labelW = bw * 0.24;
  ctx.moveTo(bx + labelW, by + frame);
  ctx.lineTo(bx + labelW, by + bh - frame);
  ctx.stroke();

  // 文字（白の太ゴシック。チョーク風は使わない）
  const rows = [
    ['工事名', settings.projectName || ''],
    ['工　種', meta.kousyu || ''],
    ['測点・場所', meta.location || ''],
    ['施工日', fmtJP(new Date(meta.takenAt))],
    ['施工者', settings.contractor || ''],
  ];
  ctx.fillStyle = '#FFFFFF';
  const basePx = rowH * 0.42;
  const padIn = bw * 0.03;
  rows.forEach(([label, value], i) => {
    const cy = by + rowH * i + rowH / 2;
    drawFitText(ctx, label, bx + padIn * 0.6, cy, labelW - padIn * 1.2, basePx * 0.9, 'center');
    drawFitText(ctx, value, bx + labelW + padIn, cy, bw - labelW - padIn * 2, basePx, 'left');
  });
  return cv;
}

/* ================================================================
 * 写真の追加（共通パイプライン）
 * ================================================================ */
function groupKeyOf(p) { return p.kousyu + '|' + ymdKey(new Date(p.takenAt)); }
function sameGroup(a, b) { return groupKeyOf(a) === groupKeyOf(b); }

async function addCanvasPhoto(fullCv, takenAt, overrides) {
  const o = overrides || {};
  const meta = {
    id: uid(),
    takenAt: takenAt.toISOString(),
    kousyu: o.kousyu != null ? o.kousyu : (settings.last.kousyu || KOUSYU_PRESETS[0]),
    location: o.location != null ? o.location : (settings.last.location || ''),
    blackboard: Object.assign({}, DEFAULT_BB),
    order: 0,
    source: o.source || 'camera',
  };
  const composedCv = composeBlackboard(fullCv, meta);
  const fullBlob = await canvasToBlob(fullCv, 0.85);
  const composedBlob = await canvasToBlob(composedCv, 0.85);
  const thumbBlob = await canvasToBlob(drawToCanvas(composedCv, 400), 0.8);
  meta.order = photos.filter((p) => sameGroup(p, meta)).length;
  await idbPut({ id: meta.id, full: fullBlob, composed: composedBlob, thumb: thumbBlob });
  photos.push(meta);
  return meta;
}

async function addPhotoFromFile(file, overrides) {
  const o = overrides || {};
  const takenAt = o.takenAt
    ? new Date(o.takenAt)
    : (await parseExifDateTime(file)) || new Date(file.lastModified || Date.now());
  const bmp = await fileToBitmap(file);
  const fullCv = drawToCanvas(bmp, 1600);
  if (bmp.close) bmp.close();
  return addCanvasPhoto(fullCv, takenAt, o);
}

/* ================================================================
 * グルーピング
 * ================================================================ */
function kousyuIndex(k) {
  const i = settings.kousyuPresets.indexOf(k);
  return i === -1 ? settings.kousyuPresets.length : i;
}
function buildGroups() {
  const map = new Map();
  for (const p of photos) {
    const key = groupKeyOf(p);
    if (!map.has(key)) {
      map.set(key, { key, kousyu: p.kousyu, dateKey: ymdKey(new Date(p.takenAt)), photos: [] });
    }
    map.get(key).photos.push(p);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.photos.sort((a, b) => (a.order - b.order) || (new Date(a.takenAt) - new Date(b.takenAt)));
    g.photos.forEach((p, i) => { p.order = i; }); // 正規化
  }
  groups.sort((a, b) => {
    const ia = kousyuIndex(a.kousyu), ib = kousyuIndex(b.kousyu);
    if (ia !== ib) return ia - ib;
    return a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0;
  });
  return groups;
}

/* ================================================================
 * DOM参照
 * ================================================================ */
const el = {
  projectBarName: $('#project-bar-name'),
  homeChips: $('#kousyu-chips'),
  locationInput: $('#location-input'),
  locationList: $('#location-list'),
  cameraInput: $('#camera-input'),
  albumInput: $('#album-input'),
  loadSamples: $('#load-samples'),
  recentCard: $('#recent-card'),
  recentThumbs: $('#recent-thumbs'),
  gotoGallery: $('#goto-gallery'),
  galleryTitle: $('#gallery-title'),
  galleryGroups: $('#gallery-groups'),
  makePdfBtn: $('#make-pdf-btn'),
  pdfProgress: $('#pdf-progress'),
  pdfProgressText: $('#pdf-progress-text'),
  pdfResult: $('#pdf-result'),
  pdfStats: $('#pdf-stats'),
  pdfPages: $('#pdf-pages'),
  printPages: $('#print-pages'),
  modalPreview: $('#modal-preview'),
  pvCanvas: $('#pv-canvas'),
  pvHint: $('#pv-hint'),
  pvScale: $('#pv-scale'),
  pvVisible: $('#pv-visible'),
  pvChips: $('#pv-chips'),
  pvLocation: $('#pv-location'),
  pvSave: $('#pv-save'),
  pvCancel: $('#pv-cancel'),
  pvDelete: $('#pv-delete'),
  modalPrice: $('#modal-price'),
  setupOverlay: $('#setup-overlay'),
  setupProject: $('#setup-project'),
  setupContractor: $('#setup-contractor'),
  toast: $('#toast'),
};

/* ================================================================
 * トースト
 * ================================================================ */
let toastTimer = null;
function showToast(msg, sticky) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (!sticky) toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}
function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  el.toast.hidden = true;
}

/* ================================================================
 * 画面遷移
 * ================================================================ */
function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = true;
  $('#screen-' + name).hidden = false;
  window.scrollTo(0, 0);
}

/* ================================================================
 * ホーム描画
 * ================================================================ */
function renderChips(container, selected, onSelect) {
  container.innerHTML = '';
  for (const k of settings.kousyuPresets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (k === selected ? ' selected' : '');
    b.textContent = k;
    b.addEventListener('click', () => onSelect(k));
    container.appendChild(b);
  }
}

function renderLocationList() {
  el.locationList.innerHTML = '';
  for (const loc of settings.locationHistory) {
    const opt = document.createElement('option');
    opt.value = loc;
    el.locationList.appendChild(opt);
  }
}

async function renderHome() {
  el.projectBarName.textContent = settings.projectName || '工事名を設定';
  renderChips(el.homeChips, settings.last.kousyu, (k) => {
    settings.last.kousyu = k;
    persistSettings();
    renderHome();
  });
  if (document.activeElement !== el.locationInput) {
    el.locationInput.value = settings.last.location || '';
  }
  renderLocationList();

  const n = photos.length;
  el.gotoGallery.textContent = `台帳を見る（${n}枚）`;
  el.gotoGallery.disabled = n === 0;

  const recent = photos.slice(-3).reverse();
  el.recentCard.hidden = recent.length === 0;
  el.recentThumbs.innerHTML = '';
  await Promise.all(recent.map((p) => thumbUrl(p.id))); // サムネを並列先読み
  for (const p of recent) {
    const img = document.createElement('img');
    img.alt = p.kousyu;
    img.src = await thumbUrl(p.id);
    img.addEventListener('click', () => openPreviewExisting(p.id));
    el.recentThumbs.appendChild(img);
  }
}

/* ================================================================
 * M1: プレビュー（新規撮影 / 既存編集）
 * ================================================================ */
let pv = null; // { mode, meta, fullCv }
let pvRaf = 0;
let pvDrag = null;

function pvRequestRender() {
  if (pvRaf) return;
  pvRaf = requestAnimationFrame(() => {
    pvRaf = 0;
    if (pv) composeBlackboard(pv.fullCv, pv.meta, el.pvCanvas);
  });
}

function openPvModal() {
  el.pvScale.value = Math.round((pv.meta.blackboard.scale || 0.4) * 100);
  el.pvVisible.checked = pv.meta.blackboard.visible !== false;
  el.pvLocation.value = pv.meta.location || '';
  el.pvDelete.hidden = pv.mode !== 'edit';
  openPvChipsRefresh(pv.meta.kousyu);
  el.pvHint.style.opacity = '1';
  el.modalPreview.hidden = false;
  composeBlackboard(pv.fullCv, pv.meta, el.pvCanvas);
  setTimeout(() => { el.pvHint.style.opacity = '0'; }, 3500);
}
function openPvChipsRefresh(k) {
  renderChips(el.pvChips, k, (k2) => {
    pv.meta.kousyu = k2;
    openPvChipsRefresh(k2);
    pvRequestRender();
  });
}

async function openPreviewNew(file) {
  showToast('写真を読み込み中…', true);
  try {
    const takenAt = (await parseExifDateTime(file)) || new Date(file.lastModified || Date.now());
    const bmp = await fileToBitmap(file);
    const fullCv = drawToCanvas(bmp, 1600);
    if (bmp.close) bmp.close();
    pv = {
      mode: 'new',
      fullCv,
      meta: {
        id: uid(),
        takenAt: takenAt.toISOString(),
        kousyu: settings.last.kousyu || KOUSYU_PRESETS[0],
        location: settings.last.location || '',
        blackboard: Object.assign({}, DEFAULT_BB),
        order: 0,
        source: 'camera',
      },
    };
    hideToast();
    openPvModal();
  } catch (e) {
    hideToast();
    showToast('写真の読み込みに失敗しました');
  }
}

async function openPreviewExisting(id) {
  const idx = photos.findIndex((p) => p.id === id);
  if (idx === -1) return;
  showToast('読み込み中…', true);
  try {
    const rec = await idbGet(id);
    if (!rec) { hideToast(); showToast('画像データが見つかりません'); return; }
    const bmp = await fileToBitmap(rec.full);
    const fullCv = drawToCanvas(bmp, 1600);
    if (bmp.close) bmp.close();
    const metaCopy = JSON.parse(JSON.stringify(photos[idx]));
    if (!metaCopy.blackboard) metaCopy.blackboard = Object.assign({}, DEFAULT_BB);
    pv = { mode: 'edit', fullCv, meta: metaCopy };
    hideToast();
    openPvModal();
  } catch (e) {
    hideToast();
    showToast('読み込みに失敗しました');
  }
}

function closePv() {
  el.modalPreview.hidden = true;
  pv = null;
  pvDrag = null;
}

async function pvSaveHandler() {
  if (!pv) return;
  el.pvSave.disabled = true;
  try {
    const meta = pv.meta;
    meta.location = el.pvLocation.value.trim();
    const composedCv = composeBlackboard(pv.fullCv, meta);
    const composedBlob = await canvasToBlob(composedCv, 0.85);
    const thumbBlob = await canvasToBlob(drawToCanvas(composedCv, 400), 0.8);

    if (pv.mode === 'new') {
      const fullBlob = await canvasToBlob(pv.fullCv, 0.85);
      meta.order = photos.filter((p) => sameGroup(p, meta)).length;
      await idbPut({ id: meta.id, full: fullBlob, composed: composedBlob, thumb: thumbBlob });
      photos.push(meta);
    } else {
      const rec = await idbGet(meta.id);
      await idbPut({ id: meta.id, full: rec ? rec.full : composedBlob, composed: composedBlob, thumb: thumbBlob });
      const idx = photos.findIndex((p) => p.id === meta.id);
      if (idx !== -1) {
        // 工種や日付が変わってグループ移動した場合は新グループの末尾に付ける
        if (!sameGroup(photos[idx], meta)) {
          meta.order = photos.filter((p) => p.id !== meta.id && sameGroup(p, meta)).length;
        }
        photos[idx] = meta;
      }
      revokeThumb(meta.id);
    }
    settings.last.kousyu = meta.kousyu;
    if (meta.location) { settings.last.location = meta.location; pushLocationHistory(meta.location); }
    persistSettings();
    persistPhotos();
    const isNew = pv.mode === 'new';
    closePv();
    showToast(isNew ? '黒板を合成して保存しました' : '黒板を更新しました');
    renderAll();
  } catch (e) {
    showToast('保存に失敗しました');
  } finally {
    el.pvSave.disabled = false;
  }
}

async function pvDeleteHandler() {
  if (!pv || pv.mode !== 'edit') return;
  if (!confirm('この写真を削除しますか？')) return;
  const id = pv.meta.id;
  await idbDel(id);
  revokeThumb(id);
  photos = photos.filter((p) => p.id !== id);
  persistPhotos();
  closePv();
  showToast('写真を削除しました');
  renderAll();
}

/* 黒板ドラッグ */
function pvPointFromEvent(e) {
  const r = el.pvCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * el.pvCanvas.width) / r.width,
    y: ((e.clientY - r.top) * el.pvCanvas.height) / r.height,
  };
}
function bindPvDrag() {
  el.pvCanvas.addEventListener('pointerdown', (e) => {
    if (!pv || pv.meta.blackboard.visible === false) return;
    const p = pvPointFromEvent(e);
    const W = el.pvCanvas.width, H = el.pvCanvas.height;
    const g = boardGeom(W, H, pv.meta.blackboard);
    const pad = Math.max(20, g.bw * 0.06);
    if (p.x >= g.bx - pad && p.x <= g.bx + g.bw + pad && p.y >= g.by - pad && p.y <= g.by + g.bh + pad) {
      pvDrag = { dx: p.x - g.bx, dy: p.y - (g.by + g.bh) };
      try { el.pvCanvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベント等 */ }
      el.pvHint.style.opacity = '0';
      e.preventDefault();
    }
  });
  el.pvCanvas.addEventListener('pointermove', (e) => {
    if (!pv || !pvDrag) return;
    const p = pvPointFromEvent(e);
    const W = el.pvCanvas.width, H = el.pvCanvas.height;
    pv.meta.blackboard.x = clamp((p.x - pvDrag.dx) / W, 0, 1);
    pv.meta.blackboard.y = clamp((p.y - pvDrag.dy) / H, 0, 1);
    pvRequestRender();
  });
  const end = () => { pvDrag = null; };
  el.pvCanvas.addEventListener('pointerup', end);
  el.pvCanvas.addEventListener('pointercancel', end);
}

/* ================================================================
 * 画面B: ギャラリー
 * ================================================================ */
async function renderGallery() {
  const groups = buildGroups();
  el.galleryTitle.textContent = settings.projectName || '台帳';
  el.makePdfBtn.textContent = `台帳PDFを作成（${photos.length}枚）`;
  el.makePdfBtn.disabled = photos.length === 0;
  el.galleryGroups.innerHTML = '';

  for (const g of groups) {
    const header = document.createElement('div');
    header.className = 'group-header';
    const d = new Date(g.dateKey + 'T00:00:00');
    header.innerHTML =
      `<span class="group-kousyu"></span><span class="group-date"></span><span class="group-badge"></span>`;
    header.querySelector('.group-kousyu').textContent = g.kousyu;
    header.querySelector('.group-date').textContent = fmtMD(d);
    header.querySelector('.group-badge').textContent = `${g.photos.length}枚`;
    el.galleryGroups.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'group-grid';
    await Promise.all(g.photos.map((p) => thumbUrl(p.id))); // サムネを並列先読み
    for (let i = 0; i < g.photos.length; i++) {
      const p = g.photos[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gthumb';
      const img = document.createElement('img');
      img.alt = `${p.kousyu} ${p.location}`;
      img.src = await thumbUrl(p.id);
      btn.appendChild(img);
      btn.addEventListener('click', () => openPreviewExisting(p.id));

      const ob = document.createElement('span');
      ob.className = 'order-btns';
      if (i > 0) ob.appendChild(orderBtn('↑', () => moveInGroup(g, i, -1)));
      if (i < g.photos.length - 1) ob.appendChild(orderBtn('↓', () => moveInGroup(g, i, +1)));
      if (ob.childNodes.length) btn.appendChild(ob);

      grid.appendChild(btn);
    }
    el.galleryGroups.appendChild(grid);
  }
}
function orderBtn(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'order-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function moveInGroup(g, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= g.photos.length) return;
  const a = g.photos[i], b = g.photos[j];
  const tmp = a.order; a.order = b.order; b.order = tmp;
  persistPhotos();
  renderGallery();
}

/* ================================================================
 * PDF生成（Canvas描画 → jsPDF。日本語フォント埋め込み不要方式）
 * ================================================================ */
const PAGE_W = 1240, PAGE_H = 1754; // A4 @150dpi 相当
let lastPdf = null;
let lastPdfUrl = null;

function mkPage() {
  const cv = document.createElement('canvas');
  cv.width = PAGE_W; cv.height = PAGE_H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  return { cv, ctx };
}
function pageFont(ctx, px, weight = 400) {
  ctx.font = `${weight} ${px}px ${FONT_STACK}`;
}
function fitFillText(ctx, text, x, y, maxW, basePx, weight = 400, align = 'left') {
  if (!text) return;
  let size = basePx;
  pageFont(ctx, size, weight);
  while (ctx.measureText(text).width > maxW && size > basePx * 0.5) {
    size -= 1;
    pageFont(ctx, size, weight);
  }
  let t = text;
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
  if (t !== text) t = t.slice(0, -1) + '…';
  let tx = x;
  if (align === 'center') tx = x + (maxW - ctx.measureText(t).width) / 2;
  if (align === 'right') tx = x + maxW - ctx.measureText(t).width;
  ctx.fillText(t, tx, y);
}

function renderCover(flat) {
  const { cv, ctx } = mkPage();
  // 二重罫線の枠
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 4;
  ctx.strokeRect(52, 52, PAGE_W - 104, PAGE_H - 104);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(66, 66, PAGE_W - 132, PAGE_H - 132);

  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'middle';
  fitFillText(ctx, '工 事 写 真 台 帳', 170, 470, PAGE_W - 340, 96, 700, 'center');
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(320, 560); ctx.lineTo(PAGE_W - 320, 560);
  ctx.stroke();

  const dates = flat.map((p) => new Date(p.takenAt)).sort((a, b) => a - b);
  const kikan = dates.length
    ? (ymdKey(dates[0]) === ymdKey(dates[dates.length - 1])
        ? fmtSlash(dates[0])
        : `${fmtSlash(dates[0])} 〜 ${fmtSlash(dates[dates.length - 1])}`)
    : '';
  const rows = [
    ['工 事 名', settings.projectName || ''],
    ['工　　期', kikan],
    ['施 工 者', settings.contractor || ''],
    ['写真枚数', `${flat.length} 枚`],
  ];
  const tX = 220, tW = PAGE_W - 440, rowH = 92, tY = 780;
  const labelW = 240;
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tX, tY, tW, rowH * rows.length);
  ctx.beginPath();
  for (let i = 1; i < rows.length; i++) {
    ctx.moveTo(tX, tY + rowH * i); ctx.lineTo(tX + tW, tY + rowH * i);
  }
  ctx.moveTo(tX + labelW, tY); ctx.lineTo(tX + labelW, tY + rowH * rows.length);
  ctx.stroke();
  rows.forEach(([label, value], i) => {
    const cy = tY + rowH * i + rowH / 2;
    ctx.fillStyle = '#333333';
    fitFillText(ctx, label, tX + 24, cy, labelW - 48, 30, 700, 'center');
    ctx.fillStyle = '#111111';
    fitFillText(ctx, value, tX + labelW + 28, cy, tW - labelW - 56, 34, 600, 'left');
  });

  ctx.fillStyle = '#666666';
  fitFillText(ctx, `作成日：${fmtSlash(new Date())}`, 220, 1560, PAGE_W - 440, 26, 400, 'center');
  ctx.fillStyle = '#9AA3AC';
  fitFillText(ctx, 'パシャ台帳で作成', 220, 1620, PAGE_W - 440, 20, 400, 'center');
  return cv;
}

async function renderPhotoPage(items, pageNo, totalPages) {
  const { cv, ctx } = mkPage();
  const M = 60;
  // ヘッダー
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'middle';
  fitFillText(ctx, '工事写真台帳', M, 84, 400, 28, 700, 'left');
  ctx.fillStyle = '#444444';
  fitFillText(ctx, `${settings.projectName || ''}`, M + 260, 86, PAGE_W - M * 2 - 420, 24, 400, 'left');
  fitFillText(ctx, `${pageNo} / ${totalPages}`, PAGE_W - M - 160, 86, 160, 24, 400, 'right');
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(M, 112); ctx.lineTo(PAGE_W - M, 112);
  ctx.stroke();

  const top = 130, gap = 20;
  const slotH = Math.floor((PAGE_H - M - top - gap * 2) / 3);
  const slotW = PAGE_W - M * 2;

  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const y = top + i * (slotH + gap);
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 2;
    ctx.strokeRect(M, y, slotW, slotH);

    const photoW = Math.floor(slotW * 0.58);
    // 写真（contain）
    try {
      const rec = await idbGet(p.id);
      if (rec && rec.composed) {
        const bmp = await fileToBitmap(rec.composed);
        const { w, h } = srcSize(bmp);
        const areaX = M + 12, areaY = y + 12, areaW = photoW - 24, areaH = slotH - 24;
        const s = Math.min(areaW / w, areaH / h);
        const dw = w * s, dh = h * s;
        const dx = areaX + (areaW - dw) / 2, dy = areaY + (areaH - dh) / 2;
        ctx.drawImage(bmp, dx, dy, dw, dh);
        ctx.strokeStyle = '#888888';
        ctx.lineWidth = 1;
        ctx.strokeRect(dx, dy, dw, dh);
        if (bmp.close) bmp.close();
      }
    } catch (e) { /* 写真欠損時は枠のみ */ }

    // 仕切り
    const divX = M + photoW;
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(divX, y); ctx.lineTo(divX, y + slotH);
    ctx.stroke();

    // 右側の表
    const rows = [
      ['工事名', settings.projectName || ''],
      ['工　種', p.kousyu || ''],
      ['測点・場所', p.location || ''],
      ['施工日', fmtSlash(new Date(p.takenAt))],
      ['施工者', settings.contractor || ''],
    ];
    const rH = slotH / 5;
    const labelW = 150;
    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 1; r < 5; r++) {
      ctx.moveTo(divX, y + rH * r); ctx.lineTo(M + slotW, y + rH * r);
    }
    ctx.moveTo(divX + labelW, y); ctx.lineTo(divX + labelW, y + slotH);
    ctx.stroke();
    rows.forEach(([label, value], r) => {
      const cy = y + rH * r + rH / 2;
      ctx.fillStyle = '#444444';
      fitFillText(ctx, label, divX + 12, cy, labelW - 24, 20, 700, 'center');
      ctx.fillStyle = '#111111';
      fitFillText(ctx, value, divX + labelW + 14, cy, M + slotW - divX - labelW - 28, 23, 500, 'left');
    });
  }
  return cv;
}

async function makePdf() {
  if (!photos.length) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDFライブラリの読み込みに失敗しました。印刷をご利用ください');
    return;
  }
  showScreen('pdf');
  el.pdfResult.hidden = true;
  el.pdfProgress.hidden = false;
  el.pdfProgressText.textContent = '台帳を組版中…';
  await nextFrame();

  const t0 = performance.now();
  try {
    const groups = buildGroups();
    const flat = groups.flatMap((g) => g.photos);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const pageUrls = [];

    const coverUrl = renderCover(flat).toDataURL('image/jpeg', 0.85);
    pdf.addImage(coverUrl, 'JPEG', 0, 0, 210, 297);
    pageUrls.push(coverUrl);

    const pageChunks = chunk(flat, 3);
    for (let ci = 0; ci < pageChunks.length; ci++) {
      el.pdfProgressText.textContent = `台帳を組版中… ${ci + 1}/${pageChunks.length}ページ`;
      await nextFrame();
      const cv = await renderPhotoPage(pageChunks[ci], ci + 1, pageChunks.length);
      const url = cv.toDataURL('image/jpeg', 0.85);
      pdf.addPage();
      pdf.addImage(url, 'JPEG', 0, 0, 210, 297);
      pageUrls.push(url);
    }

    lastPdf = pdf;
    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = pdf.output('bloburl');

    const secs = Math.max(0.1, (performance.now() - t0) / 1000).toFixed(1);
    el.pdfStats.textContent = `写真 ${flat.length}枚 ／ ${pageUrls.length}ページ ／ ${secs}秒で生成`;

    el.pdfPages.innerHTML = '';
    el.printPages.innerHTML = '';
    for (const url of pageUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '台帳ページ';
      el.pdfPages.appendChild(img);
      el.printPages.appendChild(img.cloneNode());
    }

    el.pdfProgress.hidden = true;
    el.pdfResult.hidden = false;
  } catch (e) {
    el.pdfProgress.hidden = true;
    showToast('PDF生成に失敗しました');
    showScreen('gallery');
  }
}

function pdfFileName() {
  const name = (settings.projectName || '工事').replace(/[\\\/:*?"<>|\s]+/g, '_');
  const d = new Date();
  return `工事写真台帳_${name}_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.pdf`;
}

/* ================================================================
 * サンプル現場写真（デモ保険。実ファイルが無ければCanvasで擬似生成）
 * ================================================================ */
const SAMPLE_PLAN = [
  { file: '01_dokou_zenkei.jpg',   kousyu: '土工',     location: '敷地全景',        takenAt: '2026-06-29T08:40:00' },
  { file: '02_dokou_negiri.jpg',   kousyu: '土工',     location: '根切り',          takenAt: '2026-06-29T09:15:00' },
  { file: '03_dokou_saiseki.jpg',  kousyu: '土工',     location: '砕石敷き',        takenAt: '2026-06-29T11:02:00' },
  { file: '04_dokou_tenatsu.jpg',  kousyu: '土工',     location: '転圧完了',        takenAt: '2026-06-29T14:30:00' },
  { file: '05_anzen_chourei.jpg',  kousyu: '安全管理', location: '朝礼・KY活動',    takenAt: '2026-06-29T08:10:00' },
  { file: '06_anzen_ashiba.jpg',   kousyu: '安全管理', location: '足場点検',        takenAt: '2026-06-29T13:20:00' },
  { file: '07_anzen_kakoi.jpg',    kousyu: '安全管理', location: '仮囲い養生',      takenAt: '2026-06-29T16:05:00' },
  { file: '08_kata_gaishuu.jpg',   kousyu: '型枠',     location: '基礎外周部',      takenAt: '2026-06-30T09:05:00' },
  { file: '09_kata_tatekomi.jpg',  kousyu: '型枠',     location: '型枠建込み',      takenAt: '2026-06-30T10:40:00' },
  { file: '10_kata_shime.jpg',     kousyu: '型枠',     location: '締固め確認',      takenAt: '2026-06-30T13:20:00' },
  { file: '11_tekkin_zenkei.jpg',  kousyu: '鉄筋',     location: '配筋全景',        takenAt: '2026-07-01T09:00:00' },
  { file: '12_tekkin_base.jpg',    kousyu: '鉄筋',     location: 'ベース配筋',      takenAt: '2026-07-01T09:40:00' },
  { file: '13_tekkin_spacer.jpg',  kousyu: '鉄筋',     location: 'スペーサー設置',  takenAt: '2026-07-01T10:30:00' },
  { file: '14_tekkin_kaburi.jpg',  kousyu: '鉄筋',     location: 'かぶり厚検査',    takenAt: '2026-07-01T11:45:00' },
  { file: '15_shiage_shitaji.jpg', kousyu: '仕上げ',   location: '左官下地処理',    takenAt: '2026-07-02T09:30:00' },
  { file: '16_shiage_sakan.jpg',   kousyu: '仕上げ',   location: '左官仕上げ',      takenAt: '2026-07-02T10:15:00' },
  { file: '17_shiage_youjou.jpg',  kousyu: '仕上げ',   location: '養生確認',        takenAt: '2026-07-02T13:00:00' },
  { file: '18_setsubi_kyusui.jpg', kousyu: '設備',     location: '給水配管',        takenAt: '2026-07-02T11:00:00' },
  { file: '19_setsubi_sleeve.jpg', kousyu: '設備',     location: 'スリーブ設置',    takenAt: '2026-07-02T14:10:00' },
  { file: '20_setsubi_koubai.jpg', kousyu: '設備',     location: '配管勾配確認',    takenAt: '2026-07-02T15:00:00' },
];

/* Canvas製の擬似現場写真（最終保険） */
function pseudoPhoto(entry, idx) {
  const W = 1600, H = 1200;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(idx * 7919 + 12345);
  const horizon = H * (0.5 + rng() * 0.08);

  // 空
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  const skyHue = 200 + rng() * 16;
  sky.addColorStop(0, `hsl(${skyHue}, 42%, ${72 + rng() * 8}%)`);
  sky.addColorStop(1, `hsl(${skyHue}, 30%, 88%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon);
  // 雲
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 3; i++) {
    const cx = rng() * W, cy = rng() * horizon * 0.6 + 40, r = 60 + rng() * 90;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.6, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 地面
  const gnd = ctx.createLinearGradient(0, horizon, 0, H);
  gnd.addColorStop(0, '#A79A85');
  gnd.addColorStop(1, '#7C7263');
  ctx.fillStyle = gnd;
  ctx.fillRect(0, horizon, W, H - horizon);
  // 地面の砂利テクスチャ
  for (let i = 0; i < 900; i++) {
    const gx = rng() * W, gy = horizon + rng() * (H - horizon);
    const g = 90 + Math.floor(rng() * 90);
    ctx.fillStyle = `rgba(${g},${g - 8},${g - 18},0.35)`;
    ctx.fillRect(gx, gy, 2 + rng() * 4, 1.5 + rng() * 3);
  }

  const dark = '#37474F';
  ctx.save();
  switch (entry.kousyu) {
    case '土工': {
      // 土の山
      ctx.fillStyle = '#6D5F4B';
      for (let i = 0; i < 2; i++) {
        const mx = W * (0.15 + rng() * 0.3) + i * W * 0.35, mw = 260 + rng() * 200;
        ctx.beginPath();
        ctx.moveTo(mx - mw / 2, horizon + 60);
        ctx.quadraticCurveTo(mx, horizon - 120 - rng() * 60, mx + mw / 2, horizon + 60);
        ctx.closePath();
        ctx.fill();
      }
      // ユンボ（シルエット）
      const ex = W * 0.62, ey = horizon - 10;
      ctx.fillStyle = dark;
      ctx.fillRect(ex, ey - 110, 210, 90);            // 車体
      ctx.fillRect(ex + 30, ey - 190, 110, 85);       // キャビン
      ctx.beginPath();                                 // ブーム
      ctx.moveTo(ex - 10, ey - 130);
      ctx.lineTo(ex - 200, ey - 260);
      ctx.lineTo(ex - 170, ey - 285);
      ctx.lineTo(ex + 20, ey - 165);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();                                 // アーム＋バケット
      ctx.moveTo(ex - 200, ey - 260);
      ctx.lineTo(ex - 280, ey - 90);
      ctx.lineTo(ex - 235, ey - 80);
      ctx.lineTo(ex - 170, ey - 240);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(ex - 265, ey - 60, 52, 34, 0.5, 0, Math.PI * 2);
      ctx.fill();
      // キャタピラ
      ctx.fillRect(ex - 20, ey - 26, 250, 40);
      ctx.fillStyle = '#263238';
      for (let i = 0; i < 6; i++) ctx.fillRect(ex - 10 + i * 40, ey - 22, 18, 32);
      break;
    }
    case '型枠': {
      // 合板パネルの列
      const baseY = horizon - 40;
      for (let i = 0; i < 7; i++) {
        const px = W * 0.06 + i * W * 0.13;
        ctx.fillStyle = `hsl(${28 + rng() * 8}, ${38 + rng() * 10}%, ${38 + rng() * 10}%)`;
        ctx.fillRect(px, baseY - 260, W * 0.115, 300);
        ctx.strokeStyle = '#5D4425';
        ctx.lineWidth = 4;
        ctx.strokeRect(px, baseY - 260, W * 0.115, 300);
      }
      // 端太材（横材）
      ctx.fillStyle = '#6B4F30';
      ctx.fillRect(W * 0.04, baseY - 220, W * 0.92, 26);
      ctx.fillRect(W * 0.04, baseY - 90, W * 0.92, 26);
      // サポート斜材
      ctx.strokeStyle = dark;
      ctx.lineWidth = 12;
      for (let i = 0; i < 4; i++) {
        const sx = W * (0.14 + i * 0.24);
        ctx.beginPath();
        ctx.moveTo(sx, baseY - 150);
        ctx.lineTo(sx + 150, horizon + 90);
        ctx.stroke();
      }
      break;
    }
    case '鉄筋': {
      // コンクリスラブ
      ctx.fillStyle = '#8D949B';
      ctx.fillRect(0, horizon - 20, W, H - horizon + 20);
      // 配筋グリッド（遠近感）
      ctx.strokeStyle = '#3E3128';
      for (let i = 0; i < 12; i++) {
        const t = i / 11;
        ctx.lineWidth = 5 + t * 5;
        const yy = (horizon + 10) + t * t * (H - horizon - 40);
        ctx.beginPath();
        ctx.moveTo(0, yy); ctx.lineTo(W, yy + (rng() - 0.5) * 14);
        ctx.stroke();
      }
      for (let i = 0; i < 14; i++) {
        const xx = (i / 13) * W;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(xx + (rng() - 0.5) * 10, horizon + 6);
        ctx.lineTo(W / 2 + (xx - W / 2) * 1.35, H);
        ctx.stroke();
      }
      // 立ち上がり筋
      ctx.strokeStyle = '#33291F';
      ctx.lineWidth = 8;
      for (let i = 0; i < 8; i++) {
        const xx = W * 0.12 + i * W * 0.11;
        ctx.beginPath();
        ctx.moveTo(xx, horizon + 40);
        ctx.lineTo(xx, horizon - 150 - rng() * 60);
        ctx.stroke();
      }
      break;
    }
    case '仕上げ': {
      // 室内壁
      ctx.fillStyle = '#CFC6B4';
      ctx.fillRect(0, 0, W, H);
      const wg = ctx.createLinearGradient(0, 0, W, 0);
      wg.addColorStop(0, 'rgba(0,0,0,0.10)');
      wg.addColorStop(0.5, 'rgba(0,0,0,0)');
      wg.addColorStop(1, 'rgba(0,0,0,0.14)');
      ctx.fillStyle = wg;
      ctx.fillRect(0, 0, W, H);
      // 床
      ctx.fillStyle = '#9A927F';
      ctx.fillRect(0, H * 0.78, W, H * 0.22);
      // コテむら（弧）
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 26;
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        ctx.arc(rng() * W, rng() * H * 0.7, 90 + rng() * 130, rng() * Math.PI, rng() * Math.PI + 1.6);
        ctx.stroke();
      }
      // 養生テープ
      ctx.fillStyle = '#7FB069';
      ctx.fillRect(0, H * 0.755, W, 24);
      break;
    }
    case '設備': {
      // 掘削溝
      ctx.fillStyle = '#5E5546';
      ctx.fillRect(0, horizon + 60, W, 220);
      ctx.fillStyle = '#4A4238';
      ctx.fillRect(0, horizon + 90, W, 160);
      // 塩ビ管
      const py = horizon + 168;
      ctx.strokeStyle = '#B9C4CC';
      ctx.lineWidth = 56;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(W * 0.05, py);
      ctx.lineTo(W * 0.68, py - 26);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(W * 0.68, py - 26);
      ctx.lineTo(W * 0.68, py - 210);
      ctx.stroke();
      // 管端
      ctx.fillStyle = '#8FA0AA';
      ctx.beginPath();
      ctx.ellipse(W * 0.05, py, 34, 34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#24313A';
      ctx.beginPath();
      ctx.ellipse(W * 0.05, py, 22, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8FA0AA';
      ctx.beginPath();
      ctx.ellipse(W * 0.68, py - 214, 32, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: { // 安全管理
      // 足場（縦横パイプ）
      ctx.strokeStyle = '#546E7A';
      ctx.lineWidth = 12;
      for (let i = 0; i < 6; i++) {
        const xx = W * 0.08 + i * W * 0.16;
        ctx.beginPath();
        ctx.moveTo(xx, 80); ctx.lineTo(xx, horizon + 60);
        ctx.stroke();
      }
      for (let i = 0; i < 4; i++) {
        const yy = 140 + i * 240;
        ctx.beginPath();
        ctx.moveTo(W * 0.04, yy); ctx.lineTo(W * 0.96, yy);
        ctx.stroke();
      }
      ctx.lineWidth = 7;
      for (let i = 0; i < 3; i++) {
        const xx = W * 0.08 + i * W * 0.32;
        ctx.beginPath();
        ctx.moveTo(xx, 140); ctx.lineTo(xx + W * 0.32, 620);
        ctx.stroke();
      }
      // カラーコーン
      for (let i = 0; i < 3; i++) {
        const cx = W * (0.2 + i * 0.28), cy = horizon + 90 + rng() * 60;
        ctx.fillStyle = '#E8641B';
        ctx.beginPath();
        ctx.moveTo(cx - 52, cy);
        ctx.lineTo(cx, cy - 130);
        ctx.lineTo(cx + 52, cy);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(cx - 30, cy - 72, 60, 20);
        ctx.fillStyle = '#C24E10';
        ctx.fillRect(cx - 66, cy - 6, 132, 14);
      }
    }
  }
  ctx.restore();

  // 粒状ノイズ＋ビネットで写真っぽく
  for (let i = 0; i < 700; i++) {
    const a = rng() * 0.05;
    ctx.fillStyle = rng() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(rng() * W, rng() * H, 2, 2);
  }
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  return cv;
}

async function loadSamples() {
  if (photos.some((p) => p.source === 'sample')) {
    if (!confirm('サンプルは読み込み済みです。読み込み直しますか？（既存のサンプルは置き換えます）')) return;
    const olds = photos.filter((p) => p.source === 'sample');
    for (const p of olds) {
      try { await idbDel(p.id); } catch (e) { /* 続行 */ }
      revokeThumb(p.id);
    }
    photos = photos.filter((p) => p.source !== 'sample');
    persistPhotos();
  }
  el.loadSamples.disabled = true;
  el.gotoGallery.disabled = true;
  try {
    for (let i = 0; i < SAMPLE_PLAN.length; i++) {
      const s = SAMPLE_PLAN[i];
      showToast(`サンプルを読み込み中… ${i + 1}/${SAMPLE_PLAN.length}`, true);
      let fullCv = null;
      try {
        const res = await fetch('samples/' + s.file);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0 && /image/.test(blob.type || 'image')) {
            const bmp = await fileToBitmap(blob);
            fullCv = drawToCanvas(bmp, 1600);
            if (bmp.close) bmp.close();
          }
        }
      } catch (e) { /* 実ファイルなし → 擬似生成 */ }
      if (!fullCv) fullCv = pseudoPhoto(s, i);
      await addCanvasPhoto(fullCv, new Date(s.takenAt), {
        kousyu: s.kousyu, location: s.location, source: 'sample',
      });
      await nextFrame();
    }
    persistPhotos();
    hideToast();
    const groups = buildGroups();
    showToast(`${SAMPLE_PLAN.length}枚を読み込み、${groups.length}グループに整理しました`);
    renderAll();
  } catch (e) {
    hideToast();
    showToast('サンプルの読み込みに失敗しました');
  } finally {
    el.loadSamples.disabled = false;
    el.gotoGallery.disabled = photos.length === 0;
  }
}

/* ================================================================
 * 初回設定・工事名変更
 * ================================================================ */
function openSetup() {
  el.setupProject.value = settings.projectName || '';
  el.setupContractor.value = settings.contractor || '';
  el.setupOverlay.hidden = false;
}
async function setupStart() {
  const name = el.setupProject.value.trim();
  if (!name) {
    el.setupProject.focus();
    showToast('工事名を入力してください');
    return;
  }
  const changed = settings.projectName !== name || settings.contractor !== el.setupContractor.value.trim();
  settings.projectName = name;
  settings.contractor = el.setupContractor.value.trim();
  persistSettings();
  el.setupOverlay.hidden = true;
  renderAll();
  // 工事名・施工者は黒板に焼き込まれているため、既存写真を再合成
  if (changed && photos.length) {
    showToast('黒板を更新中…', true);
    try {
      for (const p of photos) {
        const rec = await idbGet(p.id);
        if (!rec) continue;
        const bmp = await fileToBitmap(rec.full);
        const fullCv = drawToCanvas(bmp, 1600);
        if (bmp.close) bmp.close();
        const composedCv = composeBlackboard(fullCv, p);
        rec.composed = await canvasToBlob(composedCv, 0.85);
        rec.thumb = await canvasToBlob(drawToCanvas(composedCv, 400), 0.8);
        await idbPut(rec);
        revokeThumb(p.id);
      }
      hideToast();
      showToast(`${photos.length}枚の黒板を更新しました`);
      renderAll();
    } catch (e) {
      hideToast();
      showToast('一部の黒板更新に失敗しました');
    }
  }
}

/* ================================================================
 * 全体描画・イベント
 * ================================================================ */
function renderAll() {
  renderHome();
  if (!$('#screen-gallery').hidden) renderGallery();
}

function bindEvents() {
  // ホーム
  el.cameraInput.addEventListener('change', () => {
    const f = el.cameraInput.files && el.cameraInput.files[0];
    el.cameraInput.value = '';
    if (f) openPreviewNew(f);
  });
  el.albumInput.addEventListener('change', async () => {
    const files = [...(el.albumInput.files || [])];
    el.albumInput.value = '';
    if (!files.length) return;
    if (files.length === 1) { openPreviewNew(files[0]); return; }
    try {
      for (let i = 0; i < files.length; i++) {
        showToast(`取り込み中… ${i + 1}/${files.length}`, true);
        await addPhotoFromFile(files[i], {});
      }
      persistPhotos();
      hideToast();
      showToast(`${files.length}枚を取り込みました`);
      renderAll();
    } catch (e) {
      hideToast();
      showToast('取り込みに失敗した写真があります');
      persistPhotos();
      renderAll();
    }
  });
  el.loadSamples.addEventListener('click', loadSamples);
  el.locationInput.addEventListener('change', () => {
    settings.last.location = el.locationInput.value.trim();
    if (settings.last.location) pushLocationHistory(settings.last.location);
    persistSettings();
    renderLocationList();
  });
  el.gotoGallery.addEventListener('click', () => { showScreen('gallery'); renderGallery(); });

  // 戻る
  for (const b of document.querySelectorAll('.back-btn')) {
    b.addEventListener('click', () => {
      const to = b.dataset.back;
      showScreen(to);
      if (to === 'gallery') renderGallery(); else renderHome();
    });
  }

  // ギャラリー → PDF
  el.makePdfBtn.addEventListener('click', makePdf);
  $('#pdf-open').addEventListener('click', () => { if (lastPdfUrl) window.open(lastPdfUrl, '_blank'); });
  $('#pdf-download').addEventListener('click', () => { if (lastPdf) lastPdf.save(pdfFileName()); });
  $('#pdf-print').addEventListener('click', () => { window.print(); });

  // M1
  el.pvSave.addEventListener('click', pvSaveHandler);
  el.pvCancel.addEventListener('click', () => {
    if (pv && pv.mode === 'new' && !confirm('この写真を保存せずに閉じますか？')) return;
    closePv();
  });
  el.pvDelete.addEventListener('click', pvDeleteHandler);
  el.pvScale.addEventListener('input', () => {
    if (!pv) return;
    pv.meta.blackboard.scale = Number(el.pvScale.value) / 100;
    pvRequestRender();
  });
  el.pvVisible.addEventListener('change', () => {
    if (!pv) return;
    pv.meta.blackboard.visible = el.pvVisible.checked;
    pvRequestRender();
  });
  el.pvLocation.addEventListener('input', () => {
    if (!pv) return;
    pv.meta.location = el.pvLocation.value;
    pvRequestRender();
  });
  bindPvDrag();

  // 価格比較
  $('#price-btn').addEventListener('click', () => { el.modalPrice.hidden = false; });
  $('#price-close').addEventListener('click', () => { el.modalPrice.hidden = true; });
  el.modalPrice.addEventListener('click', (e) => {
    if (e.target === el.modalPrice) el.modalPrice.hidden = true;
  });

  // 設定
  $('#project-bar').addEventListener('click', openSetup);
  $('#setup-start').addEventListener('click', setupStart);
}

/* ================================================================
 * 起動
 * ================================================================ */
(async function init() {
  try {
    await idbOpen();
  } catch (e) {
    showToast('この端末ではデータ保存を利用できません');
  }
  loadState();
  bindEvents();
  showScreen('home');
  renderAll();
  if (!settings.projectName) openSetup();
})();
