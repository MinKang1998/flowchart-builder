'use strict';
// ════════════════════════════════════════════════════════════════
//  editor.js  –  Flowchart editor with pan/zoom
// ════════════════════════════════════════════════════════════════

// ── DOM refs ──────────────────────────────────────────────────
const svg          = document.getElementById('canvas');
const viewport     = document.getElementById('viewport');
const shapesLayer  = document.getElementById('shapes-layer');
const connsLayer   = document.getElementById('connections-layer');
const tempLayer    = document.getElementById('temp-layer');
const textEditor   = document.getElementById('text-editor');
const ctxMenu      = document.getElementById('context-menu');
const tableBody    = document.getElementById('table-body');
const tableCount   = document.getElementById('table-count');

// ── App state ─────────────────────────────────────────────────
let shapes      = [];
let connections = [];
let selectedId  = null;   // { type, id }
let ctxTargetId = null;
let nextId      = 1;
let projectId   = null;
let saveTimer   = null;

// ── Viewport (pan/zoom) ───────────────────────────────────────
const vp = { scale: 1, tx: 0, ty: 0 };

function applyVP() {
  viewport.setAttribute('transform', `translate(${vp.tx},${vp.ty}) scale(${vp.scale})`);
  const pct = Math.round(vp.scale * 100) + '%';
  document.getElementById('zoom-indicator').textContent = pct;
  document.getElementById('btn-zoom-reset').textContent = pct;
}

/** Convert client XY → SVG element coordinates */
function svgOffset(cx, cy) {
  const r = svg.getBoundingClientRect();
  return { x: cx - r.left, y: cy - r.top };
}

/** Convert SVG element coords → canvas (viewport) coords */
function toCanvas(sx, sy) {
  return { x: (sx - vp.tx) / vp.scale, y: (sy - vp.ty) / vp.scale };
}

/** Convert canvas coords → SVG element coords */
function toSvg(cx, cy) {
  return { x: cx * vp.scale + vp.tx, y: cy * vp.scale + vp.ty };
}

/** Zoom around a point in SVG-element coordinates */
function zoomAt(sx, sy, factor) {
  const newScale = Math.max(0.12, Math.min(5, vp.scale * factor));
  const ratio = newScale / vp.scale;
  vp.tx = sx - ratio * (sx - vp.tx);
  vp.ty = sy - ratio * (sy - vp.ty);
  vp.scale = newScale;
  applyVP();
}

// ── Pan ───────────────────────────────────────────────────────
let panning = false, panStart = null;

function startPan(svgX, svgY) {
  panning = true;
  panStart = { x: svgX - vp.tx, y: svgY - vp.ty };
  svg.classList.add('panning');
}
function doPan(svgX, svgY) {
  if (!panning || !panStart) return;
  vp.tx = svgX - panStart.x;
  vp.ty = svgY - panStart.y;
  applyVP();
}
function endPan() {
  panning = false;
  panStart = null;
  svg.classList.remove('panning');
}

// ── Wheel zoom ────────────────────────────────────────────────
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const { x, y } = svgOffset(e.clientX, e.clientY);
  zoomAt(x, y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// ── Middle mouse + Space pan ──────────────────────────────────
let spaceDown = false;

document.addEventListener('keydown', e => {
  if (e.key === ' ' && !spaceDown && textEditor.style.display === 'none') {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    spaceDown = true;
    svg.classList.add('pan-ready');
  }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') {
    spaceDown = false;
    if (!panning) svg.classList.remove('pan-ready');
  }
});

svg.addEventListener('mousedown', e => {
  const { x, y } = svgOffset(e.clientX, e.clientY);
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    startPan(x, y);
    return;
  }
  if (e.button === 0) {
    const tgt = e.target;
    if (tgt === svg || tgt.getAttribute?.('fill') === 'url(#grid)' || tgt.id === 'grid-bg') {
      clearSel(); closeCtx();
    }
  }
});

window.addEventListener('mousemove', e => {
  if (!panning) return;
  const { x, y } = svgOffset(e.clientX, e.clientY);
  doPan(x, y);
});

window.addEventListener('mouseup', e => {
  if (panning) {
    endPan();
    if (spaceDown) svg.classList.add('pan-ready');
    else svg.classList.remove('pan-ready');
  }
});

// Zoom buttons
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  const r = svg.getBoundingClientRect();
  zoomAt(r.width/2, r.height/2, 1.25);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  const r = svg.getBoundingClientRect();
  zoomAt(r.width/2, r.height/2, 1/1.25);
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  vp.scale = 1; vp.tx = 0; vp.ty = 0; applyVP();
});
document.getElementById('btn-fit').addEventListener('click', fitToScreen);

function fitToScreen() {
  if (!shapes.length) { vp.scale=1; vp.tx=40; vp.ty=40; applyVP(); return; }
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  shapes.forEach(s => {
    minX=Math.min(minX,s.x); minY=Math.min(minY,s.y);
    maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h);
  });
  const r   = svg.getBoundingClientRect();
  const pad = 60;
  const scaleX = (r.width  - pad*2) / (maxX - minX);
  const scaleY = (r.height - pad*2) / (maxY - minY);
  vp.scale = Math.max(0.12, Math.min(5, Math.min(scaleX, scaleY)));
  vp.tx = pad - minX * vp.scale;
  vp.ty = pad - minY * vp.scale;
  applyVP();
}

// ════════════════════════════════════════════════════════════════
//  Shape defaults
// ════════════════════════════════════════════════════════════════
const DEFAULTS = { rect:{w:130,h:60}, diamond:{w:130,h:80}, oval:{w:130,h:54} };

// ── Panel drag → drop ─────────────────────────────────────────
let panelDragType = null;
document.querySelectorAll('.shape-item').forEach(item => {
  item.addEventListener('dragstart', e => { panelDragType = item.dataset.type; e.dataTransfer.effectAllowed='copy'; });
  item.addEventListener('dragend',   () => { panelDragType = null; });
});
svg.addEventListener('dragover', e => { e.preventDefault(); svg.classList.add('drag-over'); });
svg.addEventListener('dragleave', () => svg.classList.remove('drag-over'));
svg.addEventListener('drop', e => {
  e.preventDefault(); svg.classList.remove('drag-over');
  if (!panelDragType) return;
  const { x, y } = svgOffset(e.clientX, e.clientY);
  const c = toCanvas(x, y);
  const d = DEFAULTS[panelDragType];
  createShape(panelDragType, c.x - d.w/2, c.y - d.h/2);
});

// ════════════════════════════════════════════════════════════════
//  Create / render shape
// ════════════════════════════════════════════════════════════════
function createShape(type, x, y, text='', subject=null) {
  const id = 's' + nextId++;
  const { w, h } = DEFAULTS[type];
  const shape = { id, type, x, y, w, h, text, subject };
  shapes.push(shape);
  renderShape(shape);
  refreshTable();
  scheduleSave();
  return shape;
}

function renderShape(shape) {
  const g = mkSvg('g');
  g.classList.add('shape-group');
  g.dataset.id = shape.id;

  // body
  let body;
  if (shape.type === 'rect') {
    body = mkSvg('rect', { rx:6,ry:6, x:shape.x,y:shape.y, width:shape.w,height:shape.h });
    body.classList.add('shape-body','shape-rect');
  } else if (shape.type === 'diamond') {
    body = mkSvg('polygon', { points: dpts(shape) });
    body.classList.add('shape-body','shape-diamond');
  } else {
    body = mkSvg('ellipse', { cx:shape.x+shape.w/2,cy:shape.y+shape.h/2, rx:shape.w/2,ry:shape.h/2 });
    body.classList.add('shape-body','shape-oval');
  }
  g.appendChild(body);

  // foreignObject label (word-wrap support)
  const fo = mkSvg('foreignObject', { x:shape.x+5,y:shape.y+3, width:shape.w-10,height:shape.h-6 });
  fo.style.overflow = 'visible'; fo.style.pointerEvents = 'none';
  const div = document.createElement('div');
  div.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:#1e293b;font-family:inherit;word-break:break-word;line-height:1.25;pointer-events:none;user-select:none;';
  div.textContent = shape.text;
  fo.appendChild(div); g.appendChild(fo);

  // subject badge
  const badge = mkSvg('text', { x:shape.x+shape.w-5, y:shape.y+13, 'text-anchor':'end', 'font-size':'11' });
  badge.classList.add('subject-badge');
  badge.textContent = subjEmoji(shape.subject);
  g.appendChild(badge);

  // connect points
  [[.5,0],[1,.5],[.5,1],[0,.5]].forEach(([rx,ry], i) => {
    const cp = mkSvg('circle', { cx:shape.x+shape.w*rx, cy:shape.y+shape.h*ry, r:6 });
    cp.classList.add('connect-point');
    cp.dataset.shapeId = shape.id; cp.dataset.ptIdx = i;
    g.appendChild(cp);
    wireCp(cp, shape, i);
  });

  applySubjClass(g, shape.subject);
  wireShapeEvents(g, shape);
  shapesLayer.appendChild(g);
  shape.el = g; shape.labelDiv = div; shape.badge = badge;
}

// helpers
function mkSvg(tag, attrs={}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,v));
  return el;
}
function dpts(s) {
  const cx=s.x+s.w/2,cy=s.y+s.h/2;
  return `${cx},${s.y} ${s.x+s.w},${cy} ${cx},${s.y+s.h} ${s.x},${cy}`;
}
function cpCoord(s, i) {
  return [[s.x+s.w*.5,s.y],[s.x+s.w,s.y+s.h*.5],[s.x+s.w*.5,s.y+s.h],[s.x,s.y+s.h*.5]][i];
}
function subjEmoji(s) { return s==='human'?'👤': s==='ai'?'🤖':''; }
function applySubjClass(g, s) {
  g.classList.remove('subject-human','subject-ai');
  if (s==='human') g.classList.add('subject-human');
  if (s==='ai')    g.classList.add('subject-ai');
}

// ── Sync DOM after move ───────────────────────────────────────
function syncShapeDOM(shape) {
  const g     = shape.el;
  const body  = g.querySelector('.shape-body');
  const fo    = g.querySelector('foreignObject');
  if (shape.type==='rect') {
    body.setAttribute('x',shape.x); body.setAttribute('y',shape.y);
  } else if (shape.type==='diamond') {
    body.setAttribute('points',dpts(shape));
  } else {
    body.setAttribute('cx',shape.x+shape.w/2); body.setAttribute('cy',shape.y+shape.h/2);
  }
  fo.setAttribute('x',shape.x+5); fo.setAttribute('y',shape.y+3);
  shape.badge.setAttribute('x',shape.x+shape.w-5);
  shape.badge.setAttribute('y',shape.y+13);
  g.querySelectorAll('.connect-point').forEach((cp,i) => {
    const [cx,cy]=cpCoord(shape,i);
    cp.setAttribute('cx',cx); cp.setAttribute('cy',cy);
  });
  connections.forEach(c => { if (c.fromId===shape.id||c.toId===shape.id) syncConnDOM(c); });
}

// ════════════════════════════════════════════════════════════════
//  Shape events
// ════════════════════════════════════════════════════════════════
function wireShapeEvents(g, shape) {
  let drag=false, ox=0, oy=0;

  g.addEventListener('mousedown', e => {
    if (panning || spaceDown) return;
    if (e.target.classList.contains('connect-point')) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    closeCtx();
    selectShape(shape.id);
    drag = true;
    const { x:sx, y:sy } = svgOffset(e.clientX, e.clientY);
    const c = toCanvas(sx, sy);
    ox = c.x - shape.x; oy = c.y - shape.y;

    const onMove = ev => {
      if (!drag) return;
      const { x:sx2, y:sy2 } = svgOffset(ev.clientX, ev.clientY);
      const p = toCanvas(sx2, sy2);
      shape.x = p.x - ox; shape.y = p.y - oy;
      syncShapeDOM(shape);
    };
    const onUp = () => {
      drag = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      scheduleSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });

  g.addEventListener('dblclick', e => {
    if (e.target.classList.contains('connect-point')) return;
    openTextEditor(shape);
  });

  g.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    selectShape(shape.id);
    openCtx(e.clientX, e.clientY, shape);
  });
}

// ════════════════════════════════════════════════════════════════
//  Text editor
// ════════════════════════════════════════════════════════════════
let editingShape = null;

function openTextEditor(shape) {
  editingShape = shape;
  const container = document.getElementById('canvas-container');
  const cr  = container.getBoundingClientRect();
  const sr  = svg.getBoundingClientRect();
  // Shape top-left in SVG element coords
  const { x: sx, y: sy } = toSvg(shape.x, shape.y);
  const left = sx + (sr.left - cr.left);
  const top  = sy + (sr.top  - cr.top);
  const w    = shape.w * vp.scale;
  const h    = shape.h * vp.scale;

  textEditor.style.left     = left + 'px';
  textEditor.style.top      = top  + 'px';
  textEditor.style.width    = w    + 'px';
  textEditor.style.height   = h    + 'px';
  textEditor.style.fontSize = Math.max(10, Math.round(12 * vp.scale)) + 'px';
  textEditor.style.display  = 'block';
  textEditor.value = shape.text;
  textEditor.focus(); textEditor.select();
}

function closeTextEditor(cancel=false) {
  if (!editingShape) return;
  if (!cancel) {
    editingShape.text = textEditor.value.trim();
    editingShape.labelDiv.textContent = editingShape.text;
    refreshTable(); scheduleSave();
  }
  textEditor.style.display = 'none';
  editingShape = null;
}

textEditor.addEventListener('keydown', e => {
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(); }
  if (e.key==='Escape') closeTextEditor(true);
});
textEditor.addEventListener('blur', () => closeTextEditor());

// ════════════════════════════════════════════════════════════════
//  Connect points → drag to create connection
// ════════════════════════════════════════════════════════════════
function wireCp(cp, shape, ptIdx) {
  cp.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const [fx,fy] = cpCoord(shape, ptIdx);
    const line = mkSvg('line',{x1:fx,y1:fy,x2:fx,y2:fy});
    line.classList.add('temp-line');
    tempLayer.appendChild(line);

    const onMove = ev => {
      const { x:sx, y:sy } = svgOffset(ev.clientX, ev.clientY);
      const c = toCanvas(sx, sy);
      line.setAttribute('x2',c.x); line.setAttribute('y2',c.y);
    };
    const onUp = ev => {
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',  onUp);
      line.remove();
      const { x:sx, y:sy } = svgOffset(ev.clientX, ev.clientY);
      const c = toCanvas(sx, sy);
      const target = shapeAt(c.x, c.y);
      if (target && target.id !== shape.id) {
        createConnection(shape, ptIdx, target, nearestCp(target, c.x, c.y));
      }
    };
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',  onUp);
  });
}

function shapeAt(cx, cy) {
  for (let i=shapes.length-1; i>=0; i--) {
    const s=shapes[i];
    if (cx>=s.x && cx<=s.x+s.w && cy>=s.y && cy<=s.y+s.h) return s;
  }
  return null;
}

function nearestCp(shape, cx, cy) {
  let minD=Infinity, idx=0;
  for (let i=0;i<4;i++) {
    const [x,y]=cpCoord(shape,i);
    const d=Math.hypot(x-cx,y-cy);
    if (d<minD) {minD=d;idx=i;}
  }
  return idx;
}

// ════════════════════════════════════════════════════════════════
//  Connections
// ════════════════════════════════════════════════════════════════
function createConnection(fromShape, fromPtIdx, toShape, toPtIdx) {
  if (connections.find(c=>c.fromId===fromShape.id&&c.toId===toShape.id&&c.fromPtIdx===fromPtIdx&&c.toPtIdx===toPtIdx)) return;
  const id    = 'c' + nextId++;
  const isDmd = fromShape.type === 'diamond';
  const count = connections.filter(c=>c.fromId===fromShape.id).length;
  const label = isDmd ? (count===0?'Y':'N') : null;
  const conn  = {id, fromId:fromShape.id, toId:toShape.id, fromPtIdx, toPtIdx, label};
  connections.push(conn);
  renderConnection(conn);
  refreshTable(); scheduleSave();
}

function renderConnection(conn) {
  const g = document.createElementNS('http://www.w3.org/2000/svg','g');
  g.dataset.connId = conn.id;

  const path = mkSvg('path');
  path.classList.add('connection');
  if (conn.label!==null) path.classList.add('yn-line');
  g.appendChild(path);

  const hit = mkSvg('path');
  hit.style.cssText = 'fill:none;stroke:transparent;stroke-width:14;cursor:pointer;';
  g.appendChild(hit);

  g.addEventListener('click', e => { e.stopPropagation(); selectConn(conn.id); });

  conn.path=path; conn.hitPath=hit;

  if (conn.label!==null) {
    const bg  = mkSvg('rect',{width:22,height:16,rx:3});
    bg.classList.add('conn-label-bg');
    const txt = mkSvg('text');
    txt.classList.add('conn-label-text');
    txt.textContent = conn.label;
    applyYNStyle(bg,txt,conn.label);
    bg.addEventListener('click', e => { e.stopPropagation(); toggleLabel(conn); });
    g.appendChild(bg); g.appendChild(txt);
    conn.labelBg=bg; conn.labelTxt=txt;
  }

  conn.el = g;
  connsLayer.appendChild(g);
  syncConnDOM(conn);
}

function applyYNStyle(bg,txt,label) {
  bg.classList.remove('yn-yes','yn-no'); txt.classList.remove('yn-yes','yn-no');
  if (label==='Y'){bg.classList.add('yn-yes');txt.classList.add('yn-yes');}
  if (label==='N'){bg.classList.add('yn-no'); txt.classList.add('yn-no');}
}

function toggleLabel(conn) {
  if (conn.label==='Y') conn.label='N';
  else if (conn.label==='N') conn.label='Y';
  else return;
  conn.labelTxt.textContent = conn.label;
  applyYNStyle(conn.labelBg,conn.labelTxt,conn.label);
  refreshTable(); scheduleSave();
}

function syncConnDOM(conn) {
  const fs=shapes.find(s=>s.id===conn.fromId);
  const ts=shapes.find(s=>s.id===conn.toId);
  if (!fs||!ts||!conn.path) return;
  const [x1,y1]=cpCoord(fs,conn.fromPtIdx);
  const [x2,y2]=cpCoord(ts,conn.toPtIdx);
  const dx=x2-x1;
  const d=`M ${x1} ${y1} C ${x1+dx*.4} ${y1}, ${x2-dx*.4} ${y2}, ${x2} ${y2}`;
  conn.path.setAttribute('d',d); conn.hitPath.setAttribute('d',d);
  if (conn.labelBg) {
    const mx=(x1+x2)/2, my=(y1+y2)/2;
    conn.labelBg.setAttribute('x',mx-11); conn.labelBg.setAttribute('y',my-8);
    conn.labelTxt.setAttribute('x',mx);   conn.labelTxt.setAttribute('y',my);
  }
}

// ════════════════════════════════════════════════════════════════
//  Selection
// ════════════════════════════════════════════════════════════════
function selectShape(id) {
  clearSel(); selectedId={type:'shape',id};
  shapes.find(s=>s.id===id)?.el.classList.add('selected');
}
function selectConn(id) {
  clearSel(); selectedId={type:'conn',id};
  connections.find(c=>c.id===id)?.path.classList.add('selected');
}
function clearSel() {
  shapes.forEach(s=>s.el.classList.remove('selected'));
  connections.forEach(c=>c.path?.classList.remove('selected'));
  selectedId=null;
}

// ════════════════════════════════════════════════════════════════
//  Context menu (subject assignment)
// ════════════════════════════════════════════════════════════════
function openCtx(cx, cy, shape) {
  ctxTargetId = shape.id;
  document.getElementById('ctx-shape-name').textContent =
    (shape.text||'(텍스트 없음)') + ' — ' + typeLabel(shape.type);
  document.getElementById('ctx-human').classList.toggle('active', shape.subject==='human');
  document.getElementById('ctx-ai').classList.toggle('active',    shape.subject==='ai');
  const vw=window.innerWidth, vh=window.innerHeight, mw=210, mh=240;
  ctxMenu.style.left = (cx+mw>vw ? cx-mw : cx) + 'px';
  ctxMenu.style.top  = (cy+mh>vh ? cy-mh : cy) + 'px';
  ctxMenu.classList.remove('hidden');
}
function closeCtx() { ctxMenu.classList.add('hidden'); ctxTargetId=null; }

document.addEventListener('click',   e => { if (!ctxMenu.contains(e.target)) closeCtx(); });
document.addEventListener('keydown', e => { if (e.key==='Escape') closeCtx(); });

function setSubject(subj) {
  if (!ctxTargetId) return;
  const s=shapes.find(sh=>sh.id===ctxTargetId);
  if (!s) return;
  s.subject=subj; s.badge.textContent=subjEmoji(subj);
  applySubjClass(s.el,subj);
  closeCtx(); refreshTable(); scheduleSave();
}

document.getElementById('ctx-human').addEventListener('click', ()=>setSubject('human'));
document.getElementById('ctx-ai').addEventListener('click',    ()=>setSubject('ai'));
document.getElementById('ctx-clear').addEventListener('click', ()=>setSubject(null));
document.getElementById('ctx-edit').addEventListener('click',  ()=>{ const s=shapes.find(sh=>sh.id===ctxTargetId); closeCtx(); if(s) openTextEditor(s); });
document.getElementById('ctx-delete').addEventListener('click',()=>{ closeCtx(); deleteSelected(); });

// ════════════════════════════════════════════════════════════════
//  Table
// ════════════════════════════════════════════════════════════════
function typeLabel(t) { return t==='rect'?'일반 프로세스':t==='diamond'?'의사결정':'시작/종료'; }

function getFollowups(shape) {
  const outs=connections.filter(c=>c.fromId===shape.id);
  if (!outs.length) return '<span class="text-slate-300">—</span>';
  return outs.map(c=>{
    const ts=shapes.find(s=>s.id===c.toId);
    const name=ts?(ts.text||'(unnamed)'):'?';
    const lbl=c.label?` <span class="px-1 rounded text-[9px] font-bold ${c.label==='Y'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-600'}">${c.label}</span>`:'';
    return `→ ${name}${lbl}`;
  }).join('  ');
}

function refreshTable() {
  const count   = shapes.length;
  const human   = shapes.filter(s=>s.subject==='human').length;
  const ai      = shapes.filter(s=>s.subject==='ai').length;
  tableCount.textContent = count+'개';
  document.getElementById('stat-human').childNodes[1].textContent = ' 사람 '+human;
  document.getElementById('stat-ai').childNodes[1].textContent    = ' AI '+ai;

  if (!count) {
    tableBody.innerHTML='<tr><td colspan="5" class="px-3 py-5 text-center text-slate-400 text-xs">캔버스에 도형을 추가하면 자동 정리됩니다.</td></tr>';
    return;
  }
  tableBody.innerHTML = shapes.map((s,i)=>{
    const row = s.subject==='human'?'row-human':s.subject==='ai'?'row-ai':'';
    const typeBadge = s.type==='diamond'
      ?'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">◇ 의사결정</span>'
      :s.type==='oval'
      ?'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700">⬭ 시작/종료</span>'
      :'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600">□ 프로세스</span>';
    const subjBadge = s.subject==='human'
      ?'<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">👤 사람</span>'
      :s.subject==='ai'
      ?'<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700">🤖 AI</span>'
      :'<span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-400">미지정</span>';
    return `<tr class="${row} cursor-pointer transition-colors" data-sid="${s.id}">
      <td class="px-3 py-1.5 text-slate-400 font-mono text-[11px]">${String(i+1).padStart(2,'0')}</td>
      <td class="px-3 py-1.5 font-semibold text-slate-800 text-xs">${s.text||'<span class="text-slate-300 italic">미입력</span>'}</td>
      <td class="px-3 py-1.5">${typeBadge}</td>
      <td class="px-3 py-1.5">${subjBadge}</td>
      <td class="px-3 py-1.5 text-xs text-slate-600">${getFollowups(s)}</td>
    </tr>`;
  }).join('');
  tableBody.querySelectorAll('tr[data-sid]').forEach(tr=>{
    tr.addEventListener('click',()=>selectShape(tr.dataset.sid));
  });
}

// ════════════════════════════════════════════════════════════════
//  Delete
// ════════════════════════════════════════════════════════════════
function deleteSelected() {
  if (!selectedId) return;
  if (selectedId.type==='shape') {
    const idx=shapes.findIndex(s=>s.id===selectedId.id);
    if (idx<0) return;
    const sid=shapes[idx].id;
    shapes[idx].el.remove();
    shapes.splice(idx,1);
    connections.filter(c=>c.fromId===sid||c.toId===sid).forEach(c=>c.el?.remove());
    connections=connections.filter(c=>c.fromId!==sid&&c.toId!==sid);
  } else {
    const idx=connections.findIndex(c=>c.id===selectedId.id);
    if (idx<0) return;
    connections[idx].el?.remove();
    connections.splice(idx,1);
  }
  selectedId=null;
  refreshTable(); scheduleSave();
}

document.addEventListener('keydown', e => {
  if (textEditor.style.display!=='none') return;
  if ((e.key==='Delete'||e.key==='Backspace') && selectedId) {
    if (document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA') return;
    e.preventDefault(); deleteSelected();
  }
});
document.getElementById('btn-delete').addEventListener('click', deleteSelected);

// ════════════════════════════════════════════════════════════════
//  Save / Load  (localStorage via DB)
// ════════════════════════════════════════════════════════════════
function setSaveStatus(status) {
  const dot  = document.getElementById('save-dot');
  const text = document.getElementById('save-text');
  if (status==='saving') {
    dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse';
    text.textContent = '저장 중...';
  } else {
    dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
    text.textContent = '저장됨';
  }
}

function scheduleSave() {
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 800);
}

function doSave() {
  if (!projectId) return;
  const data = {
    shapes: shapes.map(s=>({ id:s.id, type:s.type, x:Math.round(s.x), y:Math.round(s.y), w:s.w, h:s.h, text:s.text, subject:s.subject })),
    connections: connections.map(c=>({ id:c.id, fromId:c.fromId, toId:c.toId, fromPtIdx:c.fromPtIdx, toPtIdx:c.toPtIdx, label:c.label }))
  };
  DB.saveCanvas(projectId, data);
  setSaveStatus('saved');
}

function loadCanvas(data) {
  // Clear
  shapes.forEach(s=>s.el?.remove());
  connections.forEach(c=>c.el?.remove());
  shapes=[]; connections=[];
  let maxId=0;

  // Shapes first
  (data.shapes||[]).forEach(s=>{
    const shape={...s};
    shapes.push(shape);
    renderShape(shape);
    const n=parseInt(s.id.slice(1));
    if (!isNaN(n) && n>maxId) maxId=n;
  });

  // Connections
  (data.connections||[]).forEach(c=>{
    const conn={...c};
    connections.push(conn);
    renderConnection(conn);
    const n=parseInt(c.id.slice(1));
    if (!isNaN(n) && n>maxId) maxId=n;
  });

  nextId = maxId+1;
  refreshTable();
}

// ════════════════════════════════════════════════════════════════
//  Share
// ════════════════════════════════════════════════════════════════
document.getElementById('btn-share').addEventListener('click', () => {
  if (!projectId) return;
  doSave();
  const encoded = DB.exportToString(projectId);
  const base = location.origin + location.pathname.replace('editor.html','') + 'index.html';
  const url  = base + `?import=${encoded}`;
  navigator.clipboard.writeText(url).then(() => showToast('공유 링크가 클립보드에 복사되었습니다 ✓'))
    .catch(() => prompt('공유 링크:', url));
});

// ════════════════════════════════════════════════════════════════
//  Export
// ════════════════════════════════════════════════════════════════
document.getElementById('btn-export-json').addEventListener('click', () => {
  doSave();
  const meta = DB.getProject(projectId) || {};
  const blob = new Blob([JSON.stringify({
    project: meta,
    shapes: shapes.map(s=>({...s, el:undefined, labelDiv:undefined, badge:undefined})),
    connections: connections.map(c=>({...c, path:undefined, hitPath:undefined, labelBg:undefined, labelTxt:undefined, el:undefined})),
    analysis: shapes.map((s,i)=>({
      seq:i+1, name:s.text||'(미입력)',
      type:typeLabel(s.type),
      subject:s.subject==='human'?'사람':s.subject==='ai'?'AI':'미지정',
      followups:connections.filter(c=>c.fromId===s.id).map(c=>({target:shapes.find(sh=>sh.id===c.toId)?.text||'?',label:c.label}))
    }))
  },null,2)],{type:'application/json'});
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:(meta.name||'flowchart')+'.json'});
  a.click(); URL.revokeObjectURL(a.href);
});

document.getElementById('btn-export-png').addEventListener('click', () => {
  const ser  = new XMLSerializer().serializeToString(svg);
  const bb   = svg.getBoundingClientRect();
  const cvs  = Object.assign(document.createElement('canvas'),{width:bb.width,height:bb.height});
  const ctx  = cvs.getContext('2d');
  const blob = new Blob([ser],{type:'image/svg+xml;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  img.onload=()=>{
    ctx.fillStyle='#f8fafc'; ctx.fillRect(0,0,cvs.width,cvs.height);
    ctx.drawImage(img,0,0); URL.revokeObjectURL(url);
    const meta=DB.getProject(projectId)||{};
    const a=Object.assign(document.createElement('a'),{href:cvs.toDataURL('image/png'),download:(meta.name||'flowchart')+'.png'});
    a.click();
  };
  img.src=url;
});

// ════════════════════════════════════════════════════════════════
//  Clear button (toolbar delete — clear selection, not all)
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
//  Divider resize
// ════════════════════════════════════════════════════════════════
(()=>{
  const div=document.getElementById('divider');
  const tp=document.getElementById('table-panel');
  let dragging=false,sy=0,sh=0;
  div.addEventListener('mousedown',e=>{
    dragging=true; sy=e.clientY; sh=tp.getBoundingClientRect().height;
    document.body.style.cursor='row-resize'; document.body.style.userSelect='none';
  });
  window.addEventListener('mousemove',e=>{
    if (!dragging) return;
    const newH=Math.max(64,Math.min(window.innerHeight*.55, sh+(sy-e.clientY)));
    tp.style.height=newH+'px';
  });
  window.addEventListener('mouseup',()=>{
    dragging=false; document.body.style.cursor=''; document.body.style.userSelect='';
  });
})();

// ════════════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════════════
function showToast(msg) {
  const t=document.createElement('div');
  t.className='fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-slate-200 text-xs px-4 py-2.5 rounded-full shadow-xl z-[999] whitespace-nowrap';
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); },2500);
}

// ════════════════════════════════════════════════════════════════
//  Boot: read project from URL
// ════════════════════════════════════════════════════════════════
(function boot() {
  const params = new URLSearchParams(location.search);
  projectId    = params.get('id');
  const isNew  = params.get('new') === '1';

  if (!projectId) { location.href='index.html'; return; }

  const meta = DB.getProject(projectId);
  if (!meta) { location.href='index.html'; return; }

  document.title = meta.name + ' – FlowChart Builder';
  document.getElementById('project-name').textContent = meta.name;

  const data = DB.loadCanvas(projectId);

  if (isNew || !data.shapes.length) {
    // Demo flow for new projects
    const s1=createShape('oval',   100, 60, '시작',       'human');
    const s2=createShape('rect',   100,170, '업무 접수',  'human');
    const s3=createShape('diamond',100,290, '승인 필요?', 'human');
    const s4=createShape('rect',   290,250, '승인 요청',  'human');
    const s5=createShape('rect',   100,430, '처리 진행',  'ai');
    const s6=createShape('oval',   100,550, '종료',       'human');
    setTimeout(()=>{
      createConnection(s1,2,s2,0);
      createConnection(s2,2,s3,0);
      createConnection(s3,1,s4,3);
      createConnection(s3,2,s5,0);
      createConnection(s4,2,s5,1);
      createConnection(s5,2,s6,0);
    },30);
  } else {
    loadCanvas(data);
  }

  // Show pan hint briefly
  setTimeout(()=>{
    const hint=document.getElementById('pan-hint');
    hint.style.opacity='1';
    setTimeout(()=>{ hint.style.transition='opacity 1s'; hint.style.opacity='0'; },3000);
  },800);

  applyVP();
})();
