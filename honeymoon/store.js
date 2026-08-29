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

  // ── 기본 시드 일정 (저장된 데이터가 전혀 없을 때만 채워짐) ──────
  //   1/24 LA 도착 → 라스베가스·그랜드캐니언 → 칸쿤 → 뉴욕 → 인천
  //   연도는 명시되지 않아 다음 1/24(2027년) 기준으로 채움 — DAY의
  //   날짜 입력칸에서 언제든 수정 가능.
  function seedTrip() {
    const mk = (date, label) => ({ id: uid(), date, label, items: [] });
    const days = [
      mk('2027-01-24', 'LA'),
      mk('2027-01-25', '라스베가스'),
      mk('2027-01-26', '라스베가스'),
      mk('2027-01-27', '라스베가스'),
      mk('2027-01-28', '칸쿤'),
      mk('2027-01-29', '칸쿤'),
      mk('2027-01-30', '칸쿤'),
      mk('2027-01-31', '칸쿤'),
      mk('2027-02-01', '칸쿤'),
      mk('2027-02-02', '뉴욕'),
      mk('2027-02-03', '뉴욕'),
      mk('2027-02-04', '뉴욕'),
      mk('2027-02-05', '인천'),
    ];
    const byDate = d => days.find(x => x.date === d);
    const addItem = (date, item) => byDate(date).items.push({ id: uid(), attachments: [], ...item });

    addItem('2027-01-24', {
      time: '08:30', category: 'transport', title: '✈️ LA 도착',
      place: 'Los Angeles International Airport', lat: 33.9416, lng: -118.4085, notes: '',
    });
    addItem('2027-01-26', {
      time: '', category: 'sight', title: '📸 그랜드캐니언 투어',
      place: 'Grand Canyon', lat: 36.1069, lng: -112.1129,
      notes: '라스베가스 기점 당일 투어 — 1/25~27 중 편한 날로 조정하세요',
    });
    addItem('2027-01-27', {
      time: '20:00', category: 'transport', title: '🚕 칸쿤으로 이동',
      place: '', notes: '1/27 밤 또는 1/28 오전 중 이동 — 항공권 확정되면 날짜·시간을 수정하세요',
    });
    addItem('2027-02-01', {
      time: '20:00', category: 'transport', title: '🚕 뉴욕으로 이동',
      place: '', notes: '2/1 밤 또는 2/2 오전 중 이동 — 항공권 확정되면 날짜·시간을 수정하세요',
    });
    addItem('2027-02-04', {
      time: '12:00', category: 'transport', title: '✈️ 뉴욕 → 인천',
      place: 'John F. Kennedy International Airport', lat: 40.6413, lng: -73.7781, notes: '',
    });
    addItem('2027-02-05', {
      time: '17:45', category: 'transport', title: '🛬 인천 도착',
      place: '인천국제공항', lat: 37.4602, lng: 126.4407, notes: '',
    });

    return Object.assign(emptyTrip(), { days });
  }

  // ── 여행 데이터 로드/저장 ──────────────────────────────────────
  //   저장된 일정이 아예 없거나(raw 없음) DAY가 0개면 항상 기본
  //   시드를 채운다 — 예전에 빈 상태로 저장된 적이 있어도(예:
  //   {"days":[]}) 다시 비어있다면 시드가 보이도록 함.
  function loadTrip() {
    try {
      const raw = localStorage.getItem(TRIP_KEY);
      if (!raw) return seedTrip();
      const t = JSON.parse(raw);
      // 최소 필드 보정
      t.days = Array.isArray(t.days) ? t.days : [];
      t.days.forEach(d => { d.items = Array.isArray(d.items) ? d.items : []; });
      if (t.days.length === 0) return seedTrip();
      return Object.assign(emptyTrip(), t);
    } catch (e) {
      console.warn('여행 데이터 파싱 실패, 기본 일정으로 시작합니다.', e);
      return seedTrip();
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
