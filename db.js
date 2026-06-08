'use strict';
// ════════════════════════════════════════════════════════════════
//  db.js  –  Project storage (localStorage + optional Firebase)
//  Projects live under localStorage keys:
//    fp_projects  →  JSON array of project metadata
//    fp_data_{id} →  JSON { shapes, connections }
// ════════════════════════════════════════════════════════════════

const DB = (() => {
  const META_KEY = 'fp_projects';
  const dataKey  = id => `fp_data_${id}`;

  /* ── helpers ─────────────────────────────────────────────── */
  function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '[]'); }
    catch { return []; }
  }
  function writeMeta(list) {
    localStorage.setItem(META_KEY, JSON.stringify(list));
  }

  /* ── CRUD ─────────────────────────────────────────────────── */
  function listProjects() {
    return readMeta().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function getProject(id) {
    return readMeta().find(p => p.id === id) || null;
  }

  function createProject({ name, description = '', owner = '' }) {
    const id  = self.crypto.randomUUID();
    const now = new Date().toISOString();
    const project = { id, name, description, owner, createdAt: now, updatedAt: now, shapeCount: 0 };
    const list = readMeta();
    list.unshift(project);
    writeMeta(list);
    localStorage.setItem(dataKey(id), JSON.stringify({ shapes: [], connections: [] }));
    return project;
  }

  function updateMeta(id, patch) {
    const list = readMeta();
    const i = list.findIndex(p => p.id === id);
    if (i >= 0) {
      list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
      writeMeta(list);
      return list[i];
    }
    return null;
  }

  function deleteProject(id) {
    writeMeta(readMeta().filter(p => p.id !== id));
    localStorage.removeItem(dataKey(id));
  }

  /* ── Canvas data ─────────────────────────────────────────── */
  function loadCanvas(id) {
    try { return JSON.parse(localStorage.getItem(dataKey(id)) || '{"shapes":[],"connections":[]}'); }
    catch { return { shapes: [], connections: [] }; }
  }

  function saveCanvas(id, { shapes, connections }) {
    localStorage.setItem(dataKey(id), JSON.stringify({ shapes, connections }));
    updateMeta(id, { shapeCount: shapes.length });
  }

  /* ── Import / Export (URL-share) ─────────────────────────── */
  function exportToString(id) {
    const meta = getProject(id);
    const data = loadCanvas(id);
    return btoa(unescape(encodeURIComponent(JSON.stringify({ meta, data }))));
  }

  function importFromString(encoded) {
    try {
      const { meta, data } = JSON.parse(decodeURIComponent(escape(atob(encoded))));
      if (!meta || !data) throw new Error('invalid');
      const id  = self.crypto.randomUUID();
      const now = new Date().toISOString();
      const project = { ...meta, id, createdAt: now, updatedAt: now };
      const list = readMeta();
      // avoid duplicate names
      if (list.some(p => p.id === meta.id)) project.name += ' (가져온 사본)';
      list.unshift(project);
      writeMeta(list);
      localStorage.setItem(dataKey(id), JSON.stringify(data));
      return project;
    } catch (e) {
      console.error('importFromString failed:', e);
      return null;
    }
  }

  /* ── Stats helper (for dashboard cards) ─────────────────── */
  function getStats(id) {
    const { shapes } = loadCanvas(id);
    const human = shapes.filter(s => s.subject === 'human').length;
    const ai    = shapes.filter(s => s.subject === 'ai').length;
    return { total: shapes.length, human, ai, unassigned: shapes.length - human - ai };
  }

  return { listProjects, getProject, createProject, updateMeta, deleteProject,
           loadCanvas, saveCanvas, exportToString, importFromString, getStats };
})();
