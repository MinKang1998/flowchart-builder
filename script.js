'use strict';
// ═══════════════════════════════════════════════════════════════════
//  FlowChart Builder – script.js
// ═══════════════════════════════════════════════════════════════════

const svg          = document.getElementById('canvas');
const shapesLayer  = document.getElementById('shapes-layer');
const connsLayer   = document.getElementById('connections-layer');
const tempLayer    = document.getElementById('temp-layer');
const textEditor   = document.getElementById('text-editor');
const ctxMenu      = document.getElementById('context-menu');
const tableBody    = document.getElementById('table-body');
const tableCount   = document.getElementById('table-count');

let shapes      = [];   // { id, type, x, y, w, h, text, subject, el, labelDiv }
let connections = [];   // { id, fromId, toId, fromPtIdx, toPtIdx, label, path, hitPath, labelBg, labelTxt, el }
let selectedId  = null; // { type:'shape'|'conn', id }
let ctxTargetId = null;
let nextId      = 1;

// ── Shape defaults ─────────────────────────────────────────────────
const DEFAULTS = {
  rect:    { w: 130, h: 60 },
  diamond: { w: 130, h: 80 },
  oval:    { w: 130, h: 54 },
};

// ── SVG coordinate helper ──────────────────────────────────────────
function svgPt(cx, cy) {
  const r = svg.getBoundingClientRect();
  return { x: cx - r.left, y: cy - r.top };
}

// ═══════════════════════════════════════════════════════════════════
//  PANEL DRAG → DROP
// ═══════════════════════════════════════════════════════════════════
let panelDragType = null;

document.querySelectorAll('.shape-item').forEach(item => {
  item.addEventListener('dragstart', e => {
    panelDragType = item.dataset.type;
    e.dataTransfer.effectAllowed = 'copy';
  });
  item.addEventListener('dragend', () => { panelDragType = null; });
});

svg.addEventListener('dragover', e => { e.preventDefault(); svg.classList.add('drag-over'); });
svg.addEventListener('dragleave', () => svg.classList.remove('drag-over'));
svg.addEventListener('drop', e => {
  e.preventDefault();
  svg.classList.remove('drag-over');
  if (!panelDragType) return;
  const p = svgPt(e.clientX, e.clientY);
  const d = DEFAULTS[panelDragType];
  createShape(panelDragType, p.x - d.w / 2, p.y - d.h / 2);
});

// ═══════════════════════════════════════════════════════════════════
//  CREATE / RENDER SHAPE
// ═══════════════════════════════════════════════════════════════════
function createShape(type, x, y, text = '', subject = null) {
  const id = 's' + nextId++;
  const { w, h } = DEFAULTS[type];
  const shape = { id, type, x, y, w, h, text, subject };
  shapes.push(shape);
  renderShape(shape);
  refreshTable();
  return shape;
}

function renderShape(shape) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('shape-group');
  g.dataset.id = shape.id;

  // Body element
  let body;
  if (shape.type === 'rect') {
    body = svgEl('rect', { rx:6, ry:6, x:shape.x, y:shape.y, width:shape.w, height:shape.h });
    body.classList.add('shape-body', 'shape-rect');
  } else if (shape.type === 'diamond') {
    body = svgEl('polygon', { points: diamondPts(shape) });
    body.classList.add('shape-body', 'shape-diamond');
  } else {
    body = svgEl('ellipse', {
      cx: shape.x + shape.w/2, cy: shape.y + shape.h/2,
      rx: shape.w/2, ry: shape.h/2
    });
    body.classList.add('shape-body', 'shape-oval');
  }
  g.appendChild(body);

  // Label via foreignObject (supports word-wrap)
  const fo = svgEl('foreignObject', {
    x: shape.x + 6, y: shape.y + 4,
    width: shape.w - 12, height: shape.h - 8
  });
  fo.style.overflow = 'visible';
  fo.style.pointerEvents = 'none';
  const div = document.createElement('div');
  div.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:#1e293b;font-family:inherit;word-break:break-word;line-height:1.3;pointer-events:none;user-select:none;';
  div.textContent = shape.text;
  fo.appendChild(div);
  g.appendChild(fo);

  // Subject badge (emoji indicator top-right)
  const badge = svgEl('text', {
    x: shape.x + shape.w - 6, y: shape.y + 12,
    'text-anchor': 'end', 'dominant-baseline': 'auto',
    'font-size': '11'
  });
  badge.classList.add('subject-badge');
  badge.textContent = subjectEmoji(shape.subject);
  g.appendChild(badge);

  // Connect points (top / right / bottom / left)
  [[.5,0],[1,.5],[.5,1],[0,.5]].forEach(([rx,ry], i) => {
    const cp = svgEl('circle', {
      cx: shape.x + shape.w*rx,
      cy: shape.y + shape.h*ry,
      r: 6
    });
    cp.classList.add('connect-point');
    cp.dataset.shapeId = shape.id;
    cp.dataset.ptIdx   = i;
    g.appendChild(cp);
    wireConnectPoint(cp, shape, i);
  });

  applySubjectClass(g, shape.subject);
  wireShapeEvents(g, shape);
  shapesLayer.appendChild(g);

  shape.el       = g;
  shape.labelDiv = div;
  shape.badge    = badge;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
  return el;
}

function diamondPts(s) {
  const cx = s.x + s.w/2, cy = s.y + s.h/2;
  return `${cx},${s.y} ${s.x+s.w},${cy} ${cx},${s.y+s.h} ${s.x},${cy}`;
}

function cpCoords(shape, idx) {
  const pts = [
    [shape.x + shape.w*.5, shape.y             ],
    [shape.x + shape.w,    shape.y + shape.h*.5 ],
    [shape.x + shape.w*.5, shape.y + shape.h    ],
    [shape.x,              shape.y + shape.h*.5 ],
  ];
  return pts[idx];
}

function subjectEmoji(subject) {
  if (subject === 'human') return '👤';
  if (subject === 'ai')    return '🤖';
  return '';
}

function applySubjectClass(g, subject) {
  g.classList.remove('subject-human', 'subject-ai');
  if (subject === 'human') g.classList.add('subject-human');
  if (subject === 'ai')    g.classList.add('subject-ai');
}

// ── Update shape positions after move ─────────────────────────────
function syncShapeDOM(shape) {
  const g = shape.el;
  const body = g.querySelector('.shape-body');
  const fo   = g.querySelector('foreignObject');
  const badge = shape.badge;

  if (shape.type === 'rect') {
    body.setAttribute('x', shape.x); body.setAttribute('y', shape.y);
  } else if (shape.type === 'diamond') {
    body.setAttribute('points', diamondPts(shape));
  } else {
    body.setAttribute('cx', shape.x + shape.w/2);
    body.setAttribute('cy', shape.y + shape.h/2);
  }
  fo.setAttribute('x', shape.x + 6);
  fo.setAttribute('y', shape.y + 4);
  badge.setAttribute('x', shape.x + shape.w - 6);
  badge.setAttribute('y', shape.y + 12);

  g.querySelectorAll('.connect-point').forEach((cp, i) => {
    const [cx,cy] = cpCoords(shape, i);
    cp.setAttribute('cx', cx); cp.setAttribute('cy', cy);
  });
  connections.forEach(c => {
    if (c.fromId === shape.id || c.toId === shape.id) syncConnDOM(c);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SHAPE EVENTS (drag-move, dblclick, right-click)
// ═══════════════════════════════════════════════════════════════════
function wireShapeEvents(g, shape) {
  let drag = false, ox = 0, oy = 0, moved = false;

  g.addEventListener('mousedown', e => {
    if (e.target.classList.contains('connect-point')) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    closeContextMenu();
    selectShape(shape.id);
    drag = true; moved = false;
    const p = svgPt(e.clientX, e.clientY);
    ox = p.x - shape.x; oy = p.y - shape.y;

    const onMove = ev => {
      if (!drag) return;
      moved = true;
      const pp = svgPt(ev.clientX, ev.clientY);
      shape.x = pp.x - ox; shape.y = pp.y - oy;
      syncShapeDOM(shape);
    };
    const onUp = () => {
      drag = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });

  g.addEventListener('dblclick', e => {
    if (e.target.classList.contains('connect-point')) return;
    openTextEditor(shape);
  });

  g.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    selectShape(shape.id);
    openContextMenu(e.clientX, e.clientY, shape);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT EDITOR
// ═══════════════════════════════════════════════════════════════════
let editingShape = null;

function openTextEditor(shape) {
  editingShape = shape;
  const sr  = svg.getBoundingClientRect();
  const cr  = document.getElementById('canvas-container').getBoundingClientRect();
  textEditor.style.left    = (sr.left - cr.left + shape.x) + 'px';
  textEditor.style.top     = (sr.top  - cr.top  + shape.y) + 'px';
  textEditor.style.width   = shape.w + 'px';
  textEditor.style.height  = shape.h + 'px';
  textEditor.style.display = 'block';
  textEditor.value = shape.text;
  textEditor.focus(); textEditor.select();
}

function closeTextEditor(cancel = false) {
  if (!editingShape) return;
  if (!cancel) {
    editingShape.text = textEditor.value.trim();
    editingShape.labelDiv.textContent = editingShape.text;
    refreshTable();
  }
  textEditor.style.display = 'none';
  editingShape = null;
}

textEditor.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(); }
  if (e.key === 'Escape') closeTextEditor(true);
});
textEditor.addEventListener('blur', () => closeTextEditor());

// ═══════════════════════════════════════════════════════════════════
//  CONNECT POINT → DRAG TO CREATE CONNECTION
// ═══════════════════════════════════════════════════════════════════
function wireConnectPoint(cp, shape, ptIdx) {
  cp.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const [fx, fy] = cpCoords(shape, ptIdx);
    const line = svgEl('line', { x1:fx, y1:fy, x2:fx, y2:fy });
    line.classList.add('temp-line');
    tempLayer.appendChild(line);

    const onMove = ev => {
      const p = svgPt(ev.clientX, ev.clientY);
      line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);
    };
    const onUp = ev => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      line.remove();
      const p = svgPt(ev.clientX, ev.clientY);
      const target = shapeAt(p.x, p.y);
      if (target && target.id !== shape.id) {
        const toPtIdx = nearestCp(target, p.x, p.y);
        createConnection(shape, ptIdx, target, toPtIdx);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });
}

function shapeAt(x, y) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  }
  return null;
}

function nearestCp(shape, x, y) {
  let minD = Infinity, idx = 0;
  for (let i = 0; i < 4; i++) {
    const [cx,cy] = cpCoords(shape, i);
    const d = Math.hypot(cx-x, cy-y);
    if (d < minD) { minD = d; idx = i; }
  }
  return idx;
}

// ═══════════════════════════════════════════════════════════════════
//  CONNECTIONS
// ═══════════════════════════════════════════════════════════════════
function createConnection(fromShape, fromPtIdx, toShape, toPtIdx) {
  const dup = connections.find(c =>
    c.fromId === fromShape.id && c.toId === toShape.id &&
    c.fromPtIdx === fromPtIdx && c.toPtIdx === toPtIdx
  );
  if (dup) return;

  const id    = 'c' + nextId++;
  const isDmd = fromShape.type === 'diamond';
  const count = connections.filter(c => c.fromId === fromShape.id).length;
  const label = isDmd ? (count === 0 ? 'Y' : 'N') : null;

  const conn = { id, fromId: fromShape.id, toId: toShape.id, fromPtIdx, toPtIdx, label };
  connections.push(conn);
  renderConnection(conn);
  refreshTable();
}

function renderConnection(conn) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.dataset.connId = conn.id;

  const path = svgEl('path');
  path.classList.add('connection');
  if (conn.label !== null) path.classList.add('yn-line');
  g.appendChild(path);

  // wide invisible hit target
  const hit = svgEl('path');
  hit.style.cssText = 'fill:none;stroke:transparent;stroke-width:14;cursor:pointer;';
  g.appendChild(hit);

  g.addEventListener('click', e => { e.stopPropagation(); selectConn(conn.id); });

  conn.path    = path;
  conn.hitPath = hit;

  if (conn.label !== null) {
    const bg  = svgEl('rect', { width:22, height:16, rx:3 });
    bg.classList.add('conn-label-bg');
    const txt = svgEl('text');
    txt.classList.add('conn-label-text');
    txt.textContent = conn.label;
    applyYNStyle(bg, txt, conn.label);
    bg.addEventListener('click', e => { e.stopPropagation(); toggleLabel(conn); });
    g.appendChild(bg); g.appendChild(txt);
    conn.labelBg  = bg;
    conn.labelTxt = txt;
  }

  conn.el = g;
  connsLayer.appendChild(g);
  syncConnDOM(conn);
}

function applyYNStyle(bg, txt, label) {
  bg.classList.remove('yn-yes','yn-no');
  txt.classList.remove('yn-yes','yn-no');
  if (label==='Y') { bg.classList.add('yn-yes'); txt.classList.add('yn-yes'); }
  if (label==='N') { bg.classList.add('yn-no');  txt.classList.add('yn-no'); }
}

function toggleLabel(conn) {
  if (conn.label === 'Y') conn.label = 'N';
  else if (conn.label === 'N') conn.label = 'Y';
  else return;
  conn.labelTxt.textContent = conn.label;
  applyYNStyle(conn.labelBg, conn.labelTxt, conn.label);
  refreshTable();
}

function syncConnDOM(conn) {
  const fs = shapes.find(s => s.id === conn.fromId);
  const ts = shapes.find(s => s.id === conn.toId);
  if (!fs || !ts || !conn.path) return;

  const [x1,y1] = cpCoords(fs, conn.fromPtIdx);
  const [x2,y2] = cpCoords(ts, conn.toPtIdx);
  const dx = x2-x1, dy = y2-y1;
  const d = `M ${x1} ${y1} C ${x1+dx*.4} ${y1}, ${x2-dx*.4} ${y2}, ${x2} ${y2}`;

  conn.path.setAttribute('d', d);
  conn.hitPath.setAttribute('d', d);

  if (conn.labelBg && conn.labelTxt) {
    const mx = (x1+x2)/2, my = (y1+y2)/2;
    conn.labelBg.setAttribute('x',  mx - 11);
    conn.labelBg.setAttribute('y',  my - 8);
    conn.labelTxt.setAttribute('x', mx);
    conn.labelTxt.setAttribute('y', my);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SELECTION
// ═══════════════════════════════════════════════════════════════════
function selectShape(id) {
  clearSel();
  selectedId = { type:'shape', id };
  shapes.find(s => s.id === id)?.el.classList.add('selected');
}

function selectConn(id) {
  clearSel();
  selectedId = { type:'conn', id };
  connections.find(c => c.id === id)?.path.classList.add('selected');
}

function clearSel() {
  shapes.forEach(s => s.el.classList.remove('selected'));
  connections.forEach(c => c.path?.classList.remove('selected'));
  selectedId = null;
}

svg.addEventListener('mousedown', e => {
  if (e.target === svg || e.target.getAttribute?.('fill') === 'url(#grid)') {
    clearSel(); closeContextMenu();
  }
});

// ═══════════════════════════════════════════════════════════════════
//  CONTEXT MENU (right-click → subject assignment)
// ═══════════════════════════════════════════════════════════════════
function openContextMenu(cx, cy, shape) {
  ctxTargetId = shape.id;
  document.getElementById('ctx-shape-name').textContent =
    (shape.text || '(텍스트 없음)') + ' — ' + typeLabel(shape.type);

  // Highlight active subject
  document.getElementById('ctx-human').classList.toggle('active', shape.subject === 'human');
  document.getElementById('ctx-ai').classList.toggle('active',    shape.subject === 'ai');

  // Position
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 220, mh = 260;
  ctxMenu.style.left = (cx + mw > vw ? cx - mw : cx) + 'px';
  ctxMenu.style.top  = (cy + mh > vh ? cy - mh : cy) + 'px';
  ctxMenu.classList.remove('hidden');
}

function closeContextMenu() {
  ctxMenu.classList.add('hidden');
  ctxTargetId = null;
}

document.addEventListener('click', e => {
  if (!ctxMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeContextMenu();
});

function setSubject(subj) {
  if (!ctxTargetId) return;
  const shape = shapes.find(s => s.id === ctxTargetId);
  if (!shape) return;
  shape.subject = subj;
  shape.badge.textContent = subjectEmoji(subj);
  applySubjectClass(shape.el, subj);
  closeContextMenu();
  refreshTable();
}

document.getElementById('ctx-human').addEventListener('click', () => setSubject('human'));
document.getElementById('ctx-ai').addEventListener('click',    () => setSubject('ai'));
document.getElementById('ctx-clear-subject').addEventListener('click', () => setSubject(null));
document.getElementById('ctx-edit').addEventListener('click', () => {
  const shape = shapes.find(s => s.id === ctxTargetId);
  closeContextMenu();
  if (shape) openTextEditor(shape);
});
document.getElementById('ctx-delete').addEventListener('click', () => {
  closeContextMenu();
  deleteSelected();
});

// ═══════════════════════════════════════════════════════════════════
//  TABLE (real-time refresh)
// ═══════════════════════════════════════════════════════════════════
function typeLabel(type) {
  return type === 'rect' ? '일반 프로세스' : type === 'diamond' ? '의사결정' : '시작/종료';
}

function subjectLabel(subj) {
  if (subj === 'human') return '👤 사람';
  if (subj === 'ai')    return '🤖 AI';
  return '—';
}

function subjectBadgeHTML(subj) {
  if (subj === 'human')
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">👤 사람</span>';
  if (subj === 'ai')
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700">🤖 AI</span>';
  return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-400">미지정</span>';
}

function getFollowups(shape) {
  const outs = connections.filter(c => c.fromId === shape.id);
  if (!outs.length) return '<span class="text-slate-300 text-[10px]">—</span>';
  return outs.map(c => {
    const ts = shapes.find(s => s.id === c.toId);
    const name = ts ? (ts.text || '(unnamed)') : '?';
    const lbl  = c.label ? ` <span class="px-1 py-0.5 rounded text-[9px] font-bold ${c.label==='Y'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-600'}">${c.label}</span>` : '';
    return `<span class="inline-flex items-center gap-0.5 mr-1">→ ${name}${lbl}</span>`;
  }).join('');
}

function refreshTable() {
  if (!shapes.length) {
    tableBody.innerHTML = `<tr><td colspan="5" class="px-3 py-6 text-center text-slate-400 text-xs">캔버스에 도형을 추가하면 자동으로 표에 정리됩니다.</td></tr>`;
    tableCount.textContent = '0개';
    return;
  }

  tableCount.textContent = shapes.length + '개';

  tableBody.innerHTML = shapes.map((s, i) => {
    const rowCls = s.subject === 'human' ? 'row-human' : s.subject === 'ai' ? 'row-ai' : '';
    const typeBadge = s.type === 'diamond'
      ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">◇ 의사결정</span>'
      : s.type === 'oval'
      ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700">⬭ 시작/종료</span>'
      : '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600">□ 프로세스</span>';
    return `
      <tr class="${rowCls} cursor-pointer transition-colors" data-sid="${s.id}">
        <td class="px-3 py-2 text-slate-400 font-mono text-[11px]">${String(i+1).padStart(2,'0')}</td>
        <td class="px-3 py-2 font-medium text-slate-800 text-xs">${s.text || '<span class="text-slate-300 italic">미입력</span>'}</td>
        <td class="px-3 py-2">${typeBadge}</td>
        <td class="px-3 py-2">${subjectBadgeHTML(s.subject)}</td>
        <td class="px-3 py-2 text-xs text-slate-600">${getFollowups(s)}</td>
      </tr>`;
  }).join('');

  // Click row → select shape
  tableBody.querySelectorAll('tr[data-sid]').forEach(tr => {
    tr.addEventListener('click', () => selectShape(tr.dataset.sid));
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DELETE
// ═══════════════════════════════════════════════════════════════════
function deleteSelected() {
  if (!selectedId) return;
  if (selectedId.type === 'shape') {
    const idx = shapes.findIndex(s => s.id === selectedId.id);
    if (idx < 0) return;
    shapes[idx].el.remove();
    const sid = shapes[idx].id;
    shapes.splice(idx, 1);
    connections.filter(c => c.fromId === sid || c.toId === sid)
               .forEach(c => c.el?.remove());
    connections = connections.filter(c => c.fromId !== sid && c.toId !== sid);
  } else {
    const idx = connections.findIndex(c => c.id === selectedId.id);
    if (idx < 0) return;
    connections[idx].el?.remove();
    connections.splice(idx, 1);
  }
  selectedId = null;
  refreshTable();
}

svg.addEventListener('keydown', handleKey);
document.addEventListener('keydown', handleKey);
function handleKey(e) {
  if (textEditor.style.display !== 'none') return;
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
}

document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('모든 도형과 연결선을 삭제하시겠습니까?')) return;
  shapes.forEach(s => s.el.remove());
  connections.forEach(c => c.el?.remove());
  shapes = []; connections = []; selectedId = null;
  refreshTable();
});

// ═══════════════════════════════════════════════════════════════════
//  EXPORT – JSON
// ═══════════════════════════════════════════════════════════════════
document.getElementById('btn-export-json').addEventListener('click', () => {
  const data = {
    exportedAt: new Date().toISOString(),
    shapes: shapes.map(s => ({
      id: s.id, type: s.type, text: s.text, subject: s.subject,
      position: { x: Math.round(s.x), y: Math.round(s.y), w: s.w, h: s.h }
    })),
    connections: connections.map(c => ({
      id: c.id, from: c.fromId, to: c.toId,
      fromPoint: c.fromPtIdx, toPoint: c.toPtIdx, label: c.label
    })),
    analysis: shapes.map((s, i) => ({
      seq: i + 1,
      name: s.text || '(미입력)',
      type: typeLabel(s.type),
      subject: s.subject === 'human' ? '사람' : s.subject === 'ai' ? 'AI' : '미지정',
      followups: connections
        .filter(c => c.fromId === s.id)
        .map(c => {
          const ts = shapes.find(sh => sh.id === c.toId);
          return { target: ts?.text || '?', label: c.label };
        })
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'flowchart.json'
  });
  a.click(); URL.revokeObjectURL(a.href);
});

// ═══════════════════════════════════════════════════════════════════
//  EXPORT – PNG
// ═══════════════════════════════════════════════════════════════════
document.getElementById('btn-export-png').addEventListener('click', () => {
  const sr   = new XMLSerializer().serializeToString(svg);
  const bb   = svg.getBoundingClientRect();
  const cvs  = Object.assign(document.createElement('canvas'), { width: bb.width, height: bb.height });
  const ctx  = cvs.getContext('2d');
  const img  = new Image();
  const blob = new Blob([sr], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  img.onload = () => {
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const a = Object.assign(document.createElement('a'), {
      href: cvs.toDataURL('image/png'), download: 'flowchart.png'
    });
    a.click();
  };
  img.src = url;
});

// ═══════════════════════════════════════════════════════════════════
//  DIVIDER DRAG (resize table panel)
// ═══════════════════════════════════════════════════════════════════
(function() {
  const divider   = document.getElementById('divider');
  const tablePanel = document.getElementById('table-panel');
  let dragging = false, startY = 0, startH = 0;

  divider.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = tablePanel.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH  = Math.max(80, Math.min(window.innerHeight * .6, startH + delta));
    tablePanel.style.height = newH + 'px';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ═══════════════════════════════════════════════════════════════════
//  DEMO on load
// ═══════════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  const s1 = createShape('oval',    100,  50, '시작',      'human');
  const s2 = createShape('rect',    100, 160, '업무 접수',  'human');
  const s3 = createShape('diamond', 100, 280, '승인 필요?', 'human');
  const s4 = createShape('rect',    290, 240, '승인 요청',  'human');
  const s5 = createShape('rect',    100, 420, '처리 진행',  'ai');
  const s6 = createShape('rect',    290, 360, '반려 처리',  'ai');
  const s7 = createShape('oval',    100, 540, '종료',      'human');

  setTimeout(() => {
    createConnection(s1, 2, s2, 0);
    createConnection(s2, 2, s3, 0);
    createConnection(s3, 1, s4, 3);  // Yes →
    createConnection(s3, 2, s5, 0);  // No  ↓
    createConnection(s4, 2, s6, 0);
    createConnection(s5, 2, s7, 0);
    createConnection(s6, 3, s5, 1);
  }, 30);
});
