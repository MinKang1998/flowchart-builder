'use strict';
// ════════════════════════════════════════════════════════════════
//  store.js – 로컬 저장 계층
//   · 일정 데이터  → localStorage  (JSON)
//   · 첨부파일     → IndexedDB     (Blob: 사진 / PDF)
//   · 설정         → localStorage  (API 키 등, 브라우저에만 저장)
// ════════════════════════════════════════════════════════════════

const Store = (() => {
  const TRIP_KEY     = 'honeymoon_trip_v1';
  const SETTINGS_KEY = 'honeymoon_settings_v1';
  const DB_NAME      = 'honeymoon_files';
  const DB_STORE     = 'attachments';

  // ── ID 생성 ────────────────────────────────────────────────────
  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID()
                       : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  // ── 기본 여행 데이터 ───────────────────────────────────────────
  function emptyTrip() {
    return {
      destination: '',
      startDate: '',
      endDate: '',
      partners: '',       // 예: "민 & 강"
      days: [],           // [{ id, label, date, items:[...] }]
    };
  }

  // ── 여행 데이터 로드/저장 ──────────────────────────────────────
  function loadTrip() {
    try {
      const raw = localStorage.getItem(TRIP_KEY);
      if (!raw) return emptyTrip();
      const t = JSON.parse(raw);
      // 최소 필드 보정
      t.days = Array.isArray(t.days) ? t.days : [];
      t.days.forEach(d => { d.items = Array.isArray(d.items) ? d.items : []; });
      return Object.assign(emptyTrip(), t);
    } catch (e) {
      console.warn('여행 데이터 파싱 실패, 새로 시작합니다.', e);
      return emptyTrip();
    }
  }

  function saveTrip(trip) {
    localStorage.setItem(TRIP_KEY, JSON.stringify(trip));
  }

  // ── 설정(로컬 전용) ────────────────────────────────────────────
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch { return {}; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  // ── IndexedDB (첨부파일) ───────────────────────────────────────
  let _dbPromise = null;
  function db() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(DB_STORE)) {
          d.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode) {
    return db().then(d => d.transaction(DB_STORE, mode).objectStore(DB_STORE));
  }

  // 첨부 저장: {id, itemId, name, type, size, blob}
  async function putAttachment(itemId, file) {
    const id = uid();
    const rec = {
      id, itemId,
      name: file.name || 'file',
      type: file.type || 'application/octet-stream',
      size: file.size || 0,
      blob: file,          // Blob 자체 저장 (IndexedDB는 Blob 지원)
      createdAt: Date.now(),
    };
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = store.put(rec);
      r.onsuccess = () => resolve({ id, itemId, name: rec.name, type: rec.type, size: rec.size });
      r.onerror   = () => reject(r.error);
    });
  }

  async function getAttachment(id) {
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const r = store.get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = () => reject(r.error);
    });
  }

  async function listAttachments(itemId) {
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const out = [];
      const r = store.openCursor();
      r.onsuccess = () => {
        const cur = r.result;
        if (cur) {
          if (cur.value.itemId === itemId) {
            const { id, name, type, size } = cur.value;
            out.push({ id, name, type, size });
          }
          cur.continue();
        } else resolve(out);
      };
      r.onerror = () => reject(r.error);
    });
  }

  async function deleteAttachment(id) {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = store.delete(id);
      r.onsuccess = () => resolve();
      r.onerror   = () => reject(r.error);
    });
  }

  return {
    uid, emptyTrip,
    loadTrip, saveTrip,
    loadSettings, saveSettings,
    putAttachment, getAttachment, listAttachments, deleteAttachment,
  };
})();
