'use strict';
// ════════════════════════════════════════════════════════════════
//  db.js  –  Shared storage via Firebase Firestore
//  Requires: firebase-config.js + Firebase compat SDK loaded first
//
//  프로젝트 상태
//    status = 'draft'     → 작업실 (기본값, 생성 직후)
//    status = 'published' → 게시판 (발행 후)
// ════════════════════════════════════════════════════════════════

const DB = (() => {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  const fs  = firebase.firestore();
  const col = fs.collection('projects');

  // ── Password hashing (SHA-256 via WebCrypto) ──────────────────
  async function hashPw(pw) {
    if (!pw) return '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── Session-level auth cache ──────────────────────────────────
  function isAuthed(id)  { return sessionStorage.getItem('auth_' + id) === '1'; }
  function setAuthed(id) { sessionStorage.setItem('auth_' + id, '1'); }

  // ── Firestore-safe shape serialiser (removes undefined) ───────
  function serializeShape(s) {
    const out = {
      id: s.id, type: s.type,
      x: Math.round(s.x), y: Math.round(s.y),
      w: s.w, h: s.h,
      text:    s.text    || '',
      subject: s.subject || null
    };
    if (s.bold)      out.bold      = s.bold;
    if (s.fontSize)  out.fontSize  = s.fontSize;
    if (s.textColor) out.textColor = s.textColor;
    if (s.type === 'highlight' || s.type === 'text') {
      const defStroke = s.type === 'text' ? '#94a3b8' : '#3b82f6';
      const defWidth  = s.type === 'text' ? 1 : 2;
      out.strokeColor = s.strokeColor || defStroke;
      out.strokeWidth = s.strokeWidth || defWidth;
      out.dashType    = s.dashType    || 'dashed';
      out.glow        = s.glow        || false;
      if (s.fillColor) out.fillColor  = s.fillColor;
    }
    return out;
  }

  function serializeConn(c) {
    return {
      id: c.id, fromId: c.fromId, toId: c.toId,
      fromPtIdx: c.fromPtIdx, toPtIdx: c.toPtIdx,
      label: c.label != null ? c.label : null
    };
  }

  // ── CRUD ──────────────────────────────────────────────────────
  async function listProjects(status = null) {
    let q = col.orderBy('updatedAt', 'desc');
    const snap = await q.get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!status) return all;
    return all.filter(p => (p.status || 'draft') === status);
  }

  async function getProject(id) {
    const doc = await col.doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async function createProject({ name, description = '', owner = '', password = '' }) {
    const id           = crypto.randomUUID();
    const passwordHash = await hashPw(password);
    const now          = new Date().toISOString();
    const data = {
      name, description, owner, passwordHash,
      status: 'draft',           // 작업실에서 시작
      createdAt: now, updatedAt: now,
      shapeCount: 0, shapes: [], connections: []
    };
    await col.doc(id).set(data);
    setAuthed(id); // creator gets edit rights for this session
    return { id, ...data };
  }

  async function saveCanvas(id, { shapes, connections }) {
    await col.doc(id).update({
      shapes:      shapes.map(serializeShape),
      connections: connections.map(serializeConn),
      shapeCount:  shapes.length,
      updatedAt:   new Date().toISOString()
    });
  }

  // 작업실 → 게시판으로 발행
  async function publishProject(id) {
    await col.doc(id).update({
      status:    'published',
      publishedAt: new Date().toISOString()
    });
  }

  // 게시판 → 작업실로 회수
  async function unpublishProject(id) {
    await col.doc(id).update({ status: 'draft' });
  }

  async function loadCanvas(id) {
    const doc = await col.doc(id).get();
    if (!doc.exists) return { shapes: [], connections: [] };
    const d = doc.data();
    // label이 '' (빈 문자열)로 잘못 저장된 경우 null로 복원
    const conns = (d.connections || []).map(c => ({
      ...c, label: (c.label === '' || c.label == null) ? null : c.label
    }));
    return { shapes: d.shapes || [], connections: conns };
  }

  async function deleteProject(id) {
    await col.doc(id).delete();
  }

  // Returns true if password matches (or project has no password)
  async function verifyPassword(id, pw) {
    const p = await getProject(id);
    if (!p) return false;
    if (!p.passwordHash) { setAuthed(id); return true; }
    const hash = await hashPw(pw);
    const ok   = hash === p.passwordHash;
    if (ok) setAuthed(id);
    return ok;
  }

  function getStats(project) {
    const shapes = project.shapes || [];
    const human  = shapes.filter(s => s.subject === 'human').length;
    const ai     = shapes.filter(s => s.subject === 'ai').length;
    return { total: shapes.length, human, ai, unassigned: shapes.length - human - ai };
  }

  // Real-time listener; returns unsubscribe function
  function subscribeProjects(callback, status = null) {
    return col.orderBy('updatedAt', 'desc').onSnapshot(snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(status ? all.filter(p => (p.status || 'draft') === status) : all);
    });
  }

  return {
    listProjects, getProject, createProject,
    saveCanvas, loadCanvas, deleteProject,
    publishProject, unpublishProject,
    verifyPassword, getStats,
    isAuthed, setAuthed,
    subscribeProjects
  };
})();
