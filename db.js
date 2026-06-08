'use strict';
// ════════════════════════════════════════════════════════════════
//  db.js  –  Shared storage via Firebase Firestore
//  Requires: firebase-config.js + Firebase compat SDK loaded first
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

  // ── CRUD ──────────────────────────────────────────────────────
  async function listProjects() {
    const snap = await col.orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function getProject(id) {
    const doc = await col.doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async function createProject({ name, description = '', owner = '', password = '' }) {
    const id          = crypto.randomUUID();
    const passwordHash = await hashPw(password);
    const now         = new Date().toISOString();
    const data = {
      name, description, owner, passwordHash,
      createdAt: now, updatedAt: now,
      shapeCount: 0, shapes: [], connections: []
    };
    await col.doc(id).set(data);
    setAuthed(id); // creator gets edit rights for this session
    return { id, ...data };
  }

  async function saveCanvas(id, { shapes, connections }) {
    await col.doc(id).update({
      shapes, connections,
      shapeCount: shapes.length,
      updatedAt: new Date().toISOString()
    });
  }

  async function loadCanvas(id) {
    const doc = await col.doc(id).get();
    if (!doc.exists) return { shapes: [], connections: [] };
    const d = doc.data();
    return { shapes: d.shapes || [], connections: d.connections || [] };
  }

  async function deleteProject(id) {
    await col.doc(id).delete();
  }

  // Returns true if password matches (or project has no password)
  async function verifyPassword(id, pw) {
    const p = await getProject(id);
    if (!p) return false;
    if (!p.passwordHash) { setAuthed(id); return true; } // no password = open
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

  // Real-time listener for project list; returns unsubscribe function
  function subscribeProjects(callback) {
    return col.orderBy('updatedAt', 'desc').onSnapshot(snap => {
      callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }

  return {
    listProjects, getProject, createProject,
    saveCanvas, loadCanvas, deleteProject,
    verifyPassword, getStats,
    isAuthed, setAuthed,
    subscribeProjects
  };
})();
