'use strict';
// ════════════════════════════════════════════════════════════════
//  editor.js  —  Flowchart editor
//  · 빈 공간 드래그 = 캔버스 이동 (pan)
//  · Space + 드래그 = 올가미 선택 (lasso)
//  · Ctrl+C / Ctrl+V = 복사 / 붙여넣기
//  · Ctrl + 도형 드래그 = 복제 이동
//  · Ctrl+Z = 실행 취소 (undo, 50단계)
//  · 화살표 곡선 = 연결점 방향 기반 베지어 (수직/수평 모두 자연스럽게)
// ════════════════════════════════════════════════════════════════

// ── DOM ───────────────────────────────────────────────────────
const svg             = document.getElementById('canvas');
const viewport        = document.getElementById('viewport');
const highlightsLayer = document.getElementById('highlights-layer');
const shapesLayer     = document.getElementById('shapes-layer');
const connsLayer      = document.getElementById('connections-layer');
const tempLayer       = document.getElementById('temp-layer');
const textEditor  = document.getElementById('text-editor');
const ctxMenu     = document.getElementById('context-menu');
const tableBody   = document.getElementById('table-body');
const tableCount  = document.getElementById('table-count');

// ── State ─────────────────────────────────────────────────────
let shapes      = [];
let connections = [];
let selectedIds = new Set();   // shape/conn ids
let ctxTargetId = null;
let nextId      = 1;
let projectId   = null;
let saveTimer   = null;
let readOnly    = false;  // true when mode=view

// ── Clipboard (copy/paste) ─────────────────────────────────────
let clipboard   = null; // { shapes, connections }

// ── Undo history ──────────────────────────────────────────────
const HIST_MAX  = 50;
let history     = [];
let histIdx     = -1;

function snapshot() {
  return JSON.stringify({
    shapes: shapes.map(s => {
      const o = {id:s.id,type:s.type,x:Math.round(s.x),y:Math.round(s.y),w:s.w,h:s.h,text:s.text||'',subject:s.subject||null};
      if (s.bold)      o.bold      = s.bold;
      if (s.fontSize)  o.fontSize  = s.fontSize;
      if (s.textColor) o.textColor = s.textColor;
      if (s.type==='highlight' || s.type==='text') {
        const defStroke = s.type==='text' ? '#94a3b8' : '#3b82f6';
        const defWidth  = s.type==='text' ? 1 : 2;
        o.strokeColor = s.strokeColor||defStroke; o.strokeWidth = s.strokeWidth||defWidth;
        o.dashType = s.dashType||'dashed'; o.glow = s.glow||false;
        if (s.fillColor) o.fillColor = s.fillColor;
      }
      return o;
    }),
    connections: connections.map(c => ({
      id:c.id, fromId:c.fromId, toId:c.toId,
      fromPtIdx:c.fromPtIdx, toPtIdx:c.toPtIdx, label:c.label
    }))
  });
}

function pushHistory() {
  history.splice(histIdx + 1);          // drop redo tail
  history.push(snapshot());
  if (history.length > HIST_MAX) history.shift();
  histIdx = history.length - 1;
}

function undo() {
  if (histIdx <= 0) { showToast('더 이상 되돌릴 내용이 없습니다'); return; }
  histIdx--;
  restoreSnapshot(JSON.parse(history[histIdx]));
  showToast('실행 취소 ↩');
}

function restoreSnapshot(data) {
  shapes.forEach(s => s.el?.remove());
  connections.forEach(c => c.el?.remove());
  shapes = []; connections = [];
  let maxN = 0;
  (data.shapes || []).forEach(s => {
    const shape = { ...s }; shapes.push(shape); renderShape(shape);
    const n = parseInt(s.id.slice(1)); if (!isNaN(n) && n > maxN) maxN = n;
  });
  (data.connections || []).forEach(c => {
    const conn = { ...c }; connections.push(conn); renderConnection(conn);
    const n = parseInt(c.id.slice(1)); if (!isNaN(n) && n > maxN) maxN = n;
  });
  nextId = maxN + 1;
  clearSel(); refreshTable(); setSaveStatus('saving'); scheduleSave();
}

// ════════════════════════════════════════════════════════════════
//  Viewport  (pan / zoom)
// ════════════════════════════════════════════════════════════════
const vp = { scale: 1, tx: 0, ty: 0 };

function applyVP() {
  viewport.setAttribute('transform', `translate(${vp.tx},${vp.ty}) scale(${vp.scale})`);
  const pct = Math.round(vp.scale * 100) + '%';
  document.getElementById('zoom-indicator').textContent = pct;
  document.getElementById('btn-zoom-reset').textContent = pct;
}

function svgOff(cx, cy)    { const r=svg.getBoundingClientRect(); return {x:cx-r.left, y:cy-r.top}; }
function toCanvas(sx, sy)  { return { x:(sx-vp.tx)/vp.scale, y:(sy-vp.ty)/vp.scale }; }
function toSvgPx(cx, cy)   { return { x:cx*vp.scale+vp.tx,   y:cy*vp.scale+vp.ty   }; }

function zoomAt(sx, sy, factor) {
  const ns = Math.max(0.12, Math.min(5, vp.scale * factor));
  const r  = ns / vp.scale;
  vp.tx = sx - r*(sx - vp.tx);
  vp.ty = sy - r*(sy - vp.ty);
  vp.scale = ns;
  applyVP();
}

// ── Mouse wheel zoom ───────────────────────────────────────────
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const {x,y} = svgOff(e.clientX, e.clientY);
  zoomAt(x, y, e.deltaY < 0 ? 1.12 : 1/1.12);
}, { passive: false });

// ── Zoom buttons ───────────────────────────────────────────────
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  const r=svg.getBoundingClientRect(); zoomAt(r.width/2,r.height/2,1.25);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  const r=svg.getBoundingClientRect(); zoomAt(r.width/2,r.height/2,1/1.25);
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  vp.scale=1; vp.tx=0; vp.ty=0; applyVP();
});
document.getElementById('btn-fit').addEventListener('click', fitToScreen);

function fitToScreen() {
  if (!shapes.length) { vp.scale=1; vp.tx=40; vp.ty=40; applyVP(); return; }
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  shapes.forEach(s => { x0=Math.min(x0,s.x);y0=Math.min(y0,s.y);x1=Math.max(x1,s.x+s.w);y1=Math.max(y1,s.y+s.h); });
  const r=svg.getBoundingClientRect(), pad=60;
  vp.scale = Math.max(0.12, Math.min(5, Math.min((r.width-pad*2)/(x1-x0),(r.height-pad*2)/(y1-y0))));
  vp.tx = pad - x0*vp.scale; vp.ty = pad - y0*vp.scale;
  applyVP();
}

// ════════════════════════════════════════════════════════════════
//  Pan & Lasso  (unified mousedown on SVG background)
// ════════════════════════════════════════════════════════════════
let spaceDown = false;
let svgDragging = false; // tracking background drag state

document.addEventListener('keydown', e => {
  if (e.key === ' ' && !spaceDown) {
    if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
    e.preventDefault();
    spaceDown = true;
    svg.style.cursor = 'crosshair';
  }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; svg.style.cursor = ''; }
});

// ── SVG background mousedown: pan OR lasso ─────────────────────
svg.addEventListener('mousedown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  const tgt = e.target;
  const isBackground = tgt===svg || tgt.id==='grid-bg' ||
    tgt.getAttribute?.('fill')==='url(#grid)';
  if (!isBackground) return;

  closeCtx();
  const {x:sx, y:sy} = svgOff(e.clientX, e.clientY);

  if (spaceDown) {
    // ── LASSO ────────────────────────────────────────────
    e.preventDefault();
    startLasso(sx, sy);
  } else {
    // ── PAN ──────────────────────────────────────────────
    e.preventDefault();
    clearSel();
    startPan(sx, sy);
  }
});

// ── Pan ────────────────────────────────────────────────────────
let panActive = false, panAnchor = null;

function startPan(sx, sy) {
  panActive = true;
  panAnchor = { x: sx - vp.tx, y: sy - vp.ty };
  svg.style.cursor = 'grabbing';
  svgDragging = true;
}

window.addEventListener('mousemove', e => {
  if (!panActive && !lassoActive) return;
  const {x,y} = svgOff(e.clientX, e.clientY);
  if (panActive) {
    vp.tx = x - panAnchor.x; vp.ty = y - panAnchor.y;
    applyVP();
  }
  if (lassoActive) updateLasso(x, y);
});

window.addEventListener('mouseup', e => {
  if (panActive) {
    panActive = false; panAnchor = null;
    svg.style.cursor = spaceDown ? 'crosshair' : '';
    svgDragging = false;
  }
  if (lassoActive) endLasso();
});

// Middle mouse always pans
svg.addEventListener('mousedown', e => {
  if (e.button !== 1) return;
  e.preventDefault();
  const {x,y} = svgOff(e.clientX, e.clientY);
  startPan(x, y);
}, true);

// ── Lasso ──────────────────────────────────────────────────────
let lassoActive = false;
let lassoStart  = null;   // canvas coords
let lassoRect   = null;   // SVG rect element

function startLasso(sx, sy) {
  lassoActive = true;
  lassoStart  = toCanvas(sx, sy);
  lassoRect   = mkSvg('rect', {
    x: lassoStart.x, y: lassoStart.y, width: 0, height: 0,
    fill: 'rgba(59,130,246,0.08)', stroke: '#3b82f6',
    'stroke-width': '1', 'stroke-dasharray': '4 2'
  });
  tempLayer.appendChild(lassoRect);
}

function updateLasso(sx, sy) {
  if (!lassoRect || !lassoStart) return;
  const c  = toCanvas(sx, sy);
  const rx = Math.min(lassoStart.x, c.x);
  const ry = Math.min(lassoStart.y, c.y);
  const rw = Math.abs(c.x - lassoStart.x);
  const rh = Math.abs(c.y - lassoStart.y);
  lassoRect.setAttribute('x', rx);
  lassoRect.setAttribute('y', ry);
  lassoRect.setAttribute('width',  rw);
  lassoRect.setAttribute('height', rh);
}

function endLasso() {
  lassoActive = false;
  if (!lassoRect) return;
  const rx = parseFloat(lassoRect.getAttribute('x'));
  const ry = parseFloat(lassoRect.getAttribute('y'));
  const rw = parseFloat(lassoRect.getAttribute('width'));
  const rh = parseFloat(lassoRect.getAttribute('height'));
  lassoRect.remove(); lassoRect = null; lassoStart = null;
  svg.style.cursor = 'crosshair'; // space still held

  if (rw < 4 && rh < 4) return; // tiny drag = ignore

  clearSel();
  // Select shapes whose bounding box overlaps lasso
  shapes.forEach(s => {
    if (s.x < rx+rw && s.x+s.w > rx && s.y < ry+rh && s.y+s.h > ry) {
      selectedIds.add(s.id);
      s.el.classList.add('selected');
    }
  });
  // Select connections where both endpoints are selected
  connections.forEach(c => {
    if (selectedIds.has(c.fromId) && selectedIds.has(c.toId)) {
      selectedIds.add(c.id);
      c.path?.classList.add('selected');
    }
  });

  const cnt = [...selectedIds].filter(id => shapes.find(s=>s.id===id)).length;
  if (cnt > 0) showToast(`${cnt}개 도형 선택됨  —  Ctrl+C로 복사`);
}

// ════════════════════════════════════════════════════════════════
//  Shape defaults
// ════════════════════════════════════════════════════════════════
const DEFAULTS = { rect:{w:130,h:60}, diamond:{w:130,h:80}, oval:{w:130,h:54}, text:{w:160,h:48}, highlight:{w:220,h:140} };

// ── Panel drag → drop ─────────────────────────────────────────
let panelDragType = null;
document.querySelectorAll('.shape-item').forEach(item => {
  item.addEventListener('dragstart', e => { panelDragType = item.dataset.type; e.dataTransfer.effectAllowed='copy'; });
  item.addEventListener('dragend',   () => { panelDragType=null; });
});
svg.addEventListener('dragover', e => { e.preventDefault(); svg.classList.add('drag-over'); });
svg.addEventListener('dragleave', () => svg.classList.remove('drag-over'));
svg.addEventListener('drop', e => {
  e.preventDefault(); svg.classList.remove('drag-over');
  if (!panelDragType || readOnly) return;
  const {x:sx,y:sy} = svgOff(e.clientX, e.clientY);
  const c = toCanvas(sx, sy);
  const d = DEFAULTS[panelDragType];
  pushHistory();
  createShape(panelDragType, c.x-d.w/2, c.y-d.h/2);
});

// ════════════════════════════════════════════════════════════════
//  Shape create / render
// ════════════════════════════════════════════════════════════════
function createShape(type, x, y, text='', subject=null) {
  const id = 's' + nextId++;
  const {w,h} = DEFAULTS[type];
  const shape = {id, type, x, y, w, h, text, subject, bold:false, fontSize:null, textColor:null};
  if (type === 'highlight' || type === 'text') {
    shape.strokeColor = type === 'text' ? '#94a3b8' : '#3b82f6';
    shape.strokeWidth = type === 'text' ? 1 : 2;
    shape.dashType = 'dashed'; shape.fillColor = null; shape.glow = false;
  }
  shapes.push(shape);
  renderShape(shape);
  refreshTable(); scheduleSave();
  return shape;
}

function renderShape(shape) {
  const g = mkSvg('g');
  g.classList.add('shape-group');
  g.dataset.id = shape.id;

  let body;
  if (shape.type==='highlight') {
    // 올가미: hit-bg 넓은 여유 영역
    const HP=10;
    const hitBg=mkSvg('rect',{x:shape.x-HP,y:shape.y-HP,width:shape.w+HP*2,height:shape.h+HP*2,rx:10,ry:10});
    hitBg.style.cssText='fill:transparent;stroke:none;pointer-events:all;';
    hitBg.classList.add('shape-hit-bg');
    g.appendChild(hitBg);
    body = mkSvg('rect',{rx:8,ry:8,x:shape.x,y:shape.y,width:shape.w,height:shape.h});
    body.classList.add('shape-body','shape-highlight');
    applyBorderStyle(body, shape);
  } else if (shape.type==='text') {
    body = mkSvg('rect',{rx:4,ry:4,x:shape.x,y:shape.y,width:shape.w,height:shape.h});
    body.classList.add('shape-body','shape-text');
    applyBorderStyle(body, shape);
  } else if (shape.type==='rect') {
    body = mkSvg('rect',{rx:6,ry:6,x:shape.x,y:shape.y,width:shape.w,height:shape.h});
    body.classList.add('shape-body','shape-rect');
  } else if (shape.type==='diamond') {
    body = mkSvg('polygon',{points:dpts(shape)});
    body.classList.add('shape-body','shape-diamond');
  } else {
    body = mkSvg('ellipse',{cx:shape.x+shape.w/2,cy:shape.y+shape.h/2,rx:shape.w/2,ry:shape.h/2});
    body.classList.add('shape-body','shape-oval');
  }
  g.appendChild(body);

  const foX = shape.type==='highlight' ? shape.x+10 : shape.x+4;
  const foY = shape.type==='highlight' ? shape.y+8  : shape.y+4;
  const foW = shape.type==='highlight' ? shape.w-20 : shape.w-8;
  const foH = shape.type==='highlight' ? 28         : shape.h-8;
  const fo = mkSvg('foreignObject',{x:foX,y:foY,width:foW,height:foH});
  fo.style.overflow='visible'; fo.style.pointerEvents='none';
  const div = document.createElement('div');
  const fs = shape.fontSize || (shape.type==='text'||shape.type==='highlight' ? 14 : 12);
  const fw = shape.bold ? '700' : (shape.type==='text' ? '400' : shape.type==='highlight' ? '600' : '600');
  const fc = shape.textColor || (shape.type==='highlight' ? (shape.strokeColor||'#3b82f6') : '#1e293b');
  const align = shape.type==='highlight' ? 'flex-start' : 'center';
  div.style.cssText=`width:100%;height:100%;display:flex;align-items:${align};justify-content:flex-start;text-align:left;font-size:${fs}px;font-weight:${fw};color:${fc};font-family:inherit;word-break:break-word;line-height:1.25;pointer-events:none;user-select:none;${shape.type==='highlight'?'':'text-align:center;justify-content:center;'}`;
  div.textContent = shape.text;
  fo.appendChild(div); g.appendChild(fo);

  const badge = mkSvg('text',{x:shape.x+shape.w-5,y:shape.y+13,'text-anchor':'end','font-size':'11'});
  badge.classList.add('subject-badge');
  badge.textContent = subjEmoji(shape.subject);
  g.appendChild(badge);

  if (shape.type !== 'text' && shape.type !== 'highlight') {
    [[.5,0],[1,.5],[.5,1],[0,.5]].forEach(([rx,ry],i) => {
      const cp=mkSvg('circle',{cx:shape.x+shape.w*rx,cy:shape.y+shape.h*ry,r:6});
      cp.classList.add('connect-point');
      cp.dataset.shapeId=shape.id; cp.dataset.ptIdx=i;
      g.appendChild(cp); wireCp(cp,shape,i);
    });
  }

  if (shape.type === 'text' || shape.type === 'highlight') {
    const rh = mkSvg('rect',{x:shape.x+shape.w-7,y:shape.y+shape.h-7,width:8,height:8,rx:2});
    rh.classList.add('resize-handle');
    g.appendChild(rh);
    wireResizeHandle(rh, shape);
  }

  applySubjClass(g, shape.subject);
  wireShapeEvents(g, shape);
  // highlight은 다른 도형 뒤에 렌더링
  if (shape.type === 'highlight') highlightsLayer.appendChild(g);
  else shapesLayer.appendChild(g);
  shape.el=g; shape.labelDiv=div; shape.badge=badge;
}

// ── helpers ────────────────────────────────────────────────────
function mkSvg(tag, attrs={}) {
  const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));
  return el;
}
function dpts(s) { const cx=s.x+s.w/2,cy=s.y+s.h/2; return `${cx},${s.y} ${s.x+s.w},${cy} ${cx},${s.y+s.h} ${s.x},${cy}`; }
function cpCoord(s,i) { return [[s.x+s.w*.5,s.y],[s.x+s.w,s.y+s.h*.5],[s.x+s.w*.5,s.y+s.h],[s.x,s.y+s.h*.5]][i]; }
function subjEmoji(s) { return s==='human'?'👤':s==='ai'?'🤖':''; }
function applySubjClass(g,s) { g.classList.remove('subject-human','subject-ai'); if(s==='human')g.classList.add('subject-human'); if(s==='ai')g.classList.add('subject-ai'); }

const DASH_MAP = { solid:'none', dashed:'10 5', dotted:'2 6', dashdot:'10 4 2 4' };
function applyBorderStyle(el, shape) {
  el.setAttribute('stroke',         shape.strokeColor || '#3b82f6');
  el.setAttribute('stroke-width',   shape.strokeWidth || 2);
  el.setAttribute('stroke-dasharray', DASH_MAP[shape.dashType||'dashed'] || '10 5');
  if (shape.fillColor) {
    el.setAttribute('fill', shape.fillColor);
    el.setAttribute('fill-opacity', '0.12');
  } else {
    el.setAttribute('fill', 'none');
    el.removeAttribute('fill-opacity');
  }
  if (shape.glow) {
    el.classList.add('has-glow');
    el.style.setProperty('--glow-c', shape.strokeColor || '#3b82f6');
  } else {
    el.classList.remove('has-glow');
    el.style.removeProperty('--glow-c');
  }
}

function syncShapeDOM(shape) {
  const g=shape.el, body=g.querySelector('.shape-body'), fo=g.querySelector('foreignObject');
  if(shape.type==='highlight'||shape.type==='text'||shape.type==='rect'){
    body.setAttribute('x',shape.x); body.setAttribute('y',shape.y);
    body.setAttribute('width',shape.w); body.setAttribute('height',shape.h);
    if(shape.type==='highlight') applyBorderStyle(body, shape);
  } else if(shape.type==='diamond'){ body.setAttribute('points',dpts(shape)); }
  else { body.setAttribute('cx',shape.x+shape.w/2); body.setAttribute('cy',shape.y+shape.h/2); }

  // foreignObject position & size
  if (shape.type==='highlight') {
    fo.setAttribute('x',shape.x+10); fo.setAttribute('y',shape.y+8);
    fo.setAttribute('width',shape.w-20); fo.setAttribute('height',28);
  } else {
    fo.setAttribute('x',shape.x+4); fo.setAttribute('y',shape.y+4);
    fo.setAttribute('width',shape.w-8); fo.setAttribute('height',shape.h-8);
  }

  // 올가미/텍스트 테두리 스타일 재적용
  if (shape.type==='highlight'||shape.type==='text') applyBorderStyle(body, shape);

  if (shape.labelDiv) {
    const fs = shape.fontSize || (shape.type==='text'||shape.type==='highlight' ? 14 : 12);
    const fw = shape.bold ? '700' : (shape.type==='text' ? '400' : '600');
    const fc = shape.textColor || (shape.type==='highlight' ? (shape.strokeColor||'#3b82f6') : '#1e293b');
    shape.labelDiv.style.fontSize   = fs+'px';
    shape.labelDiv.style.fontWeight = fw;
    shape.labelDiv.style.color      = fc;
  }
  shape.badge.setAttribute('x',shape.x+shape.w-5); shape.badge.setAttribute('y',shape.y+13);
  // connect-point 동기화 (노드 전용)
  g.querySelectorAll('.connect-point').forEach((cp,i)=>{ const[cx,cy]=cpCoord(shape,i); cp.setAttribute('cx',cx); cp.setAttribute('cy',cy); });
  // 올가미 hit-bg 동기화
  const hitBg=g.querySelector('.shape-hit-bg');
  if(hitBg&&shape.type==='highlight'){ const HP=10; hitBg.setAttribute('x',shape.x-HP); hitBg.setAttribute('y',shape.y-HP); hitBg.setAttribute('width',shape.w+HP*2); hitBg.setAttribute('height',shape.h+HP*2); }
  const rh=g.querySelector('.resize-handle');
  if(rh){ rh.setAttribute('x',shape.x+shape.w-7); rh.setAttribute('y',shape.y+shape.h-7); }
  connections.forEach(c=>{ if(c.fromId===shape.id||c.toId===shape.id) syncConnDOM(c); });
}

// ════════════════════════════════════════════════════════════════
//  Shape events
// ════════════════════════════════════════════════════════════════
function wireShapeEvents(g, shape) {
  if (readOnly) return;
  let drag=false, didMove=false;

  g.addEventListener('mousedown', e => {
    if (panActive || spaceDown || lassoActive) return;
    if (e.target.classList.contains('connect-point')) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    closeCtx();

    const isCtrl = e.ctrlKey || e.metaKey;

    // Update selection state before deciding drag mode
    if (isCtrl) {
      // Ctrl+click: add/remove this shape from selection (multi-select)
      toggleSelectShape(shape.id);
    } else {
      // Normal click: if shape not yet selected, switch to it alone
      if (!selectedIds.has(shape.id)) { clearSel(); addSelectShape(shape.id); }
    }

    const {x:sx,y:sy}=svgOff(e.clientX,e.clientY);
    const c=toCanvas(sx,sy);

    // Decide drag mode on mousemove (not on mousedown),
    // so a plain Ctrl+click without drag just changes selection.
    let movers = null;
    let ctrlDuplicated = false;
    drag=true; didMove=false;

    const onMove = ev => {
      if (!drag) return;
      const {x:sx2,y:sy2}=svgOff(ev.clientX,ev.clientY);
      const p=toCanvas(sx2,sy2);

      // Initialise movers on first actual movement
      if (!movers) {
        if (isCtrl && !ctrlDuplicated && selectedIds.size > 0) {
          // Ctrl+drag → duplicate selected, then drag the copies
          pushHistory();
          const { newShapes } = duplicateSelected();
          clearSel();
          newShapes.forEach(s => { selectedIds.add(s.id); s.el.classList.add('selected'); });
          movers = newShapes.map(s => ({ s, ox: c.x-s.x, oy: c.y-s.y }));
          ctrlDuplicated = true;
          showToast(`${newShapes.length}개 복제됨 — 드래그로 이동`);
        } else {
          movers = [...selectedIds]
            .map(id => shapes.find(s=>s.id===id)).filter(Boolean)
            .map(s => ({ s, ox: c.x-s.x, oy: c.y-s.y }));
        }
      }

      didMove=true;
      movers.forEach(({s,ox:ox2,oy:oy2})=>{ s.x=p.x-ox2; s.y=p.y-oy2; syncShapeDOM(s); });
    };
    const onUp = () => {
      drag=false;
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',  onUp);
      if (didMove) { pushHistory(); scheduleSave(); }
    };
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',  onUp);
  });

  g.addEventListener('dblclick', e => {
    if (e.target.classList.contains('connect-point')) return;
    openTextEditor(shape);
  });

  g.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    if (!selectedIds.has(shape.id)) { clearSel(); addSelectShape(shape.id); }
    ctxTargetId = shape.id;
    openCtx(e.clientX, e.clientY, shape);
  });
}

// ── Selection helpers ──────────────────────────────────────────
function addSelectShape(id) {
  selectedIds.add(id);
  shapes.find(s=>s.id===id)?.el.classList.add('selected');
}
function toggleSelectShape(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    shapes.find(s=>s.id===id)?.el.classList.remove('selected');
  } else {
    addSelectShape(id);
  }
}
function clearSel() {
  selectedIds.forEach(id => {
    shapes.find(s=>s.id===id)?.el.classList.remove('selected');
    connections.find(c=>c.id===id)?.path?.classList.remove('selected');
  });
  selectedIds.clear();
}
function selectConn(id) {
  clearSel();
  selectedIds.add(id);
  connections.find(c=>c.id===id)?.path?.classList.add('selected');
}

// ════════════════════════════════════════════════════════════════
//  Resize handle (text box)
// ════════════════════════════════════════════════════════════════
function wireResizeHandle(handle, shape) {
  if (readOnly) return;
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const {x:sx0,y:sy0} = svgOff(e.clientX, e.clientY);
    const c0 = toCanvas(sx0, sy0);
    const origW = shape.w, origH = shape.h;
    pushHistory();
    const onMove = ev => {
      const {x:sx,y:sy} = svgOff(ev.clientX, ev.clientY);
      const c = toCanvas(sx, sy);
      shape.w = Math.max(60, origW + (c.x - c0.x));
      shape.h = Math.max(28, origH + (c.y - c0.y));
      syncShapeDOM(shape);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      scheduleSave();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ════════════════════════════════════════════════════════════════
//  Text editor
// ════════════════════════════════════════════════════════════════
let editingShape = null;

function openTextEditor(shape) {
  editingShape = shape;
  const container=document.getElementById('canvas-container');
  const cr=container.getBoundingClientRect(), sr=svg.getBoundingClientRect();
  const {x:sx,y:sy}=toSvgPx(shape.x,shape.y);
  textEditor.style.left    = sx+(sr.left-cr.left)+'px';
  textEditor.style.top     = sy+(sr.top-cr.top)+'px';
  textEditor.style.width   = shape.w*vp.scale+'px';
  textEditor.style.height  = shape.h*vp.scale+'px';
  textEditor.style.fontSize= Math.max(10,Math.round(12*vp.scale))+'px';
  textEditor.style.display = 'block';
  textEditor.value=shape.text; textEditor.focus(); textEditor.select();
}

function closeTextEditor(cancel=false) {
  if (!editingShape) return;
  if (!cancel && editingShape.text !== textEditor.value.trim()) {
    pushHistory();
    editingShape.text=textEditor.value.trim();
    editingShape.labelDiv.textContent=editingShape.text;
    refreshTable(); scheduleSave();
  }
  textEditor.style.display='none'; editingShape=null;
}

textEditor.addEventListener('keydown', e => {
  if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();closeTextEditor();}
  if (e.key==='Escape') closeTextEditor(true);
});
textEditor.addEventListener('blur', ()=>closeTextEditor());

// ════════════════════════════════════════════════════════════════
//  Connect points
// ════════════════════════════════════════════════════════════════
// 스냅 반경: 캔버스 좌표 기준 px
const CP_SNAP_R   = 44;  // CP 직접 스냅 반경
const SHAPE_SNAP_R = 28; // 도형 경계 넘어서도 인식하는 여유

function wireCp(cp, shape, ptIdx) {
  if (readOnly) return;
  cp.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const [fx,fy]=cpCoord(shape,ptIdx);
    const line=mkSvg('line',{x1:fx,y1:fy,x2:fx,y2:fy});
    line.classList.add('temp-line'); tempLayer.appendChild(line);

    let snapTarget=null;
    let snapHighlight=null; // 현재 하이라이트된 CP 시각 요소

    function clearSnapHL() {
      if (snapHighlight) {
        snapHighlight.setAttribute('r','6');
        snapHighlight.style.fill='';
        snapHighlight.style.opacity='';
        snapHighlight = null;
      }
    }

    const onMove=ev=>{
      const {x:sx,y:sy}=svgOff(ev.clientX,ev.clientY);
      const c=toCanvas(sx,sy);

      // 가장 가까운 CP 탐색 (스냅 반경 내)
      let bestD=CP_SNAP_R, newSnap=null;
      shapes.forEach(s=>{
        if(s.id===shape.id||s.type==='highlight'||s.type==='text') return;
        for(let i=0;i<4;i++){
          const[cx,cy]=cpCoord(s,i);
          const d=Math.hypot(c.x-cx,c.y-cy);
          if(d<bestD){ bestD=d; newSnap={shape:s,ptIdx:i,cx,cy}; }
        }
      });

      // 스냅 대상 변경 시 하이라이트 업데이트
      if(newSnap!==snapTarget){
        clearSnapHL();
        snapTarget=newSnap;
        if(snapTarget){
          // 대상 도형의 시각 CP 찾기
          const cps=snapTarget.shape.el?.querySelectorAll('.connect-point');
          if(cps&&cps[snapTarget.ptIdx]){
            snapHighlight=cps[snapTarget.ptIdx];
            snapHighlight.setAttribute('r','10');
            snapHighlight.style.fill='#2563eb';
            snapHighlight.style.opacity='1';
          }
        }
      }

      if(snapTarget){
        line.setAttribute('x2',snapTarget.cx);
        line.setAttribute('y2',snapTarget.cy);
      } else {
        line.setAttribute('x2',c.x);
        line.setAttribute('y2',c.y);
      }
    };

    const onUp=ev=>{
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
      clearSnapHL();
      line.remove();

      if(snapTarget){
        pushHistory();
        createConnection(shape,ptIdx,snapTarget.shape,snapTarget.ptIdx);
        return;
      }
      // 스냅 없으면 도형 경계 + 여유값으로 폴백
      const {x:sx,y:sy}=svgOff(ev.clientX,ev.clientY);
      const c=toCanvas(sx,sy);
      const target=shapeAtPadded(c.x,c.y,SHAPE_SNAP_R);
      if(target&&target.id!==shape.id){
        pushHistory();
        createConnection(shape,ptIdx,target,smartTargetCp(shape,ptIdx,target));
      }
    };
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  });
}

function shapeAt(cx,cy) {
  for(let i=shapes.length-1;i>=0;i--){const s=shapes[i];if(s.type==='highlight'||s.type==='text')continue;if(cx>=s.x&&cx<=s.x+s.w&&cy>=s.y&&cy<=s.y+s.h)return s;}
  return null;
}
// 연결선 드롭 시 사용 — 도형 경계 밖 pad px까지 인식
function shapeAtPadded(cx,cy,pad){
  for(let i=shapes.length-1;i>=0;i--){const s=shapes[i];if(s.type==='highlight'||s.type==='text')continue;if(cx>=s.x-pad&&cx<=s.x+s.w+pad&&cy>=s.y-pad&&cy<=s.y+s.h+pad)return s;}
  return null;
}
function nearestCp(shape,cx,cy) {
  let minD=Infinity,idx=0;
  for(let i=0;i<4;i++){const[x,y]=cpCoord(shape,i);const d=Math.hypot(x-cx,y-cy);if(d<minD){minD=d;idx=i;}}
  return idx;
}

// Pick the target CP whose outward normal best faces toward the source CP
function smartTargetCp(fromShape, fromPtIdx, toShape) {
  const [sx, sy] = cpCoord(fromShape, fromPtIdx);
  const tcx = toShape.x + toShape.w / 2, tcy = toShape.y + toShape.h / 2;
  const dx = sx - tcx, dy = sy - tcy;
  const len = Math.hypot(dx, dy) || 1;
  let best = 0, maxDot = -Infinity;
  CP_DIR.forEach(([nx, ny], i) => {
    const dot = nx * dx / len + ny * dy / len;
    if (dot > maxDot) { maxDot = dot; best = i; }
  });
  return best;
}

// ════════════════════════════════════════════════════════════════
//  Connections
// ════════════════════════════════════════════════════════════════
function createConnection(fromShape, fromPtIdx, toShape, toPtIdx) {
  if (connections.find(c=>c.fromId===fromShape.id&&c.toId===toShape.id&&c.fromPtIdx===fromPtIdx&&c.toPtIdx===toPtIdx)) return;
  const id='c'+nextId++;
  const isDmd=fromShape.type==='diamond';
  const count=connections.filter(c=>c.fromId===fromShape.id).length;
  const label=isDmd?(count===0?'Y':'N'):null;
  const conn={id,fromId:fromShape.id,toId:toShape.id,fromPtIdx,toPtIdx,label};
  connections.push(conn); renderConnection(conn); refreshTable(); scheduleSave();
}

function renderConnection(conn) {
  const g=document.createElementNS('http://www.w3.org/2000/svg','g');
  g.dataset.connId=conn.id;
  const path=mkSvg('path'); path.classList.add('connection');
  if (conn.label!==null) path.classList.add('yn-line');
  g.appendChild(path);
  const hit=mkSvg('path'); hit.style.cssText='fill:none;stroke:transparent;stroke-width:14;cursor:pointer;';
  g.appendChild(hit);
  g.addEventListener('click',e=>{e.stopPropagation();selectConn(conn.id);});
  conn.path=path; conn.hitPath=hit;
  if (conn.label!==null) {
    const bg=mkSvg('rect',{width:22,height:16,rx:3}); bg.classList.add('conn-label-bg');
    const txt=mkSvg('text'); txt.classList.add('conn-label-text'); txt.textContent=conn.label;
    applyYNStyle(bg,txt,conn.label);
    bg.addEventListener('click',e=>{e.stopPropagation();pushHistory();toggleLabel(conn);});
    g.appendChild(bg); g.appendChild(txt); conn.labelBg=bg; conn.labelTxt=txt;
  }
  conn.el=g; connsLayer.appendChild(g); syncConnDOM(conn);
}

function applyYNStyle(bg,txt,label) {
  bg.classList.remove('yn-yes','yn-no'); txt.classList.remove('yn-yes','yn-no');
  if(label==='Y'){bg.classList.add('yn-yes');txt.classList.add('yn-yes');}
  if(label==='N'){bg.classList.add('yn-no');txt.classList.add('yn-no');}
}
function toggleLabel(conn) {
  conn.label=conn.label==='Y'?'N':'Y';
  conn.labelTxt.textContent=conn.label; applyYNStyle(conn.labelBg,conn.labelTxt,conn.label);
  refreshTable(); scheduleSave();
}

// Outward-normal direction per connection-point index: top right bottom left
const CP_DIR = [[0,-1],[1,0],[0,1],[-1,0]];

function syncConnDOM(conn) {
  const fs=shapes.find(s=>s.id===conn.fromId), ts=shapes.find(s=>s.id===conn.toId);
  if(!fs||!ts||!conn.path) return;
  const [x1,y1]=cpCoord(fs,conn.fromPtIdx), [x2,y2]=cpCoord(ts,conn.toPtIdx);

  // For opposite-facing CPs (e.g. bottom→top) no hard minimum to prevent S-curves
  const rawDist = Math.hypot(x2-x1, y2-y1);
  const d1    = CP_DIR[conn.fromPtIdx];
  const d2    = CP_DIR[conn.toPtIdx];
  const oppFacing = d1[0]*d2[0] + d1[1]*d2[1] < 0;
  const dist  = oppFacing ? rawDist * 0.4 : Math.max(rawDist * 0.4, 40);
  const cx1   = x1 + d1[0]*dist;
  const cy1   = y1 + d1[1]*dist;
  const cx2   = x2 + d2[0]*dist;         // pull handle outward from target side
  const cy2   = y2 + d2[1]*dist;

  const d=`M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
  conn.path.setAttribute('d',d); conn.hitPath.setAttribute('d',d);
  if (conn.labelBg) {
    // Place label at cubic bezier midpoint (t=0.5)
    const mx=0.125*x1+0.375*cx1+0.375*cx2+0.125*x2;
    const my=0.125*y1+0.375*cy1+0.375*cy2+0.125*y2;
    conn.labelBg.setAttribute('x',mx-11); conn.labelBg.setAttribute('y',my-8);
    conn.labelTxt.setAttribute('x',mx);   conn.labelTxt.setAttribute('y',my);
  }
}

// ════════════════════════════════════════════════════════════════
//  Context menu
// ════════════════════════════════════════════════════════════════
function openCtx(cx,cy,shape) {
  ctxTargetId = shape.id;
  const isHighlight = shape.type === 'highlight';
  const isText      = shape.type === 'text';
  const isBorderShape = isHighlight || isText;
  const isShape     = ['rect','diamond','oval'].includes(shape.type);

  document.getElementById('ctx-shape-name').textContent =
    (shape.text||'(텍스트 없음)') + ' — ' + typeLabel(shape.type);

  // 섹션 show/hide
  document.getElementById('ctx-subject-section').classList.toggle('hidden', !isShape);
  document.getElementById('ctx-highlight-section').classList.toggle('hidden', !isBorderShape);

  // 수행 주체
  if (isShape) {
    document.getElementById('ctx-human').classList.toggle('active', shape.subject==='human');
    document.getElementById('ctx-ai').classList.toggle('active',    shape.subject==='ai');
  }

  // 텍스트 서식
  const fs = shape.fontSize || (isBorderShape ? 14 : 12);
  document.getElementById('ctx-font-size').textContent = fs;
  document.getElementById('ctx-bold').style.background = shape.bold ? '#e0e7ff' : '';
  document.getElementById('ctx-text-color').value = shape.textColor ||
    (isHighlight ? (shape.strokeColor||'#3b82f6') : '#1e293b');

  // 올가미/텍스트 테두리 스타일
  if (isBorderShape) {
    const defStroke = isText ? '#94a3b8' : '#3b82f6';
    document.getElementById('ctx-stroke-color').value = shape.strokeColor || defStroke;
    document.getElementById('ctx-fill-color').value   = shape.fillColor   || defStroke;
    document.getElementById('ctx-sw-val').textContent = shape.strokeWidth || (isText ? 1 : 2);
    document.getElementById('ctx-glow-toggle').classList.toggle('active', !!shape.glow);
    updateDashButtons(shape.dashType || 'dashed');
  }

  const vw=window.innerWidth, vh=window.innerHeight, mw=256, mh=isBorderShape?480:360;
  ctxMenu.style.left = (cx+mw>vw ? cx-mw : cx) + 'px';
  ctxMenu.style.top  = (cy+mh>vh ? cy-mh : cy) + 'px';
  ctxMenu.classList.remove('hidden');
}

function updateDashButtons(active) {
  ['solid','dashed','dotted','dashdot'].forEach(t => {
    document.getElementById('ctx-dash-'+t)?.classList.toggle('active', t === active);
  });
}
function closeCtx() { ctxMenu.classList.add('hidden'); ctxTargetId=null; }
document.addEventListener('click',  e=>{ if(!ctxMenu.contains(e.target)) closeCtx(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeCtx(); });

function setSubject(subj) {
  if (!ctxTargetId) return;
  pushHistory();
  const targets = new Set([ctxTargetId, ...selectedIds]);
  targets.forEach(id => {
    const s = shapes.find(sh=>sh.id===id); if(!s) return;
    s.subject=subj; s.badge.textContent=subjEmoji(subj); applySubjClass(s.el,subj);
  });
  closeCtx(); refreshTable(); scheduleSave();
}
document.getElementById('ctx-human').addEventListener('click',()=>setSubject('human'));
document.getElementById('ctx-ai').addEventListener('click',   ()=>setSubject('ai'));
document.getElementById('ctx-clear').addEventListener('click',()=>setSubject(null));
document.getElementById('ctx-edit').addEventListener('click', ()=>{ const s=shapes.find(sh=>sh.id===ctxTargetId); closeCtx(); if(s) openTextEditor(s); });
document.getElementById('ctx-delete').addEventListener('click',()=>{ closeCtx(); deleteSelected(); });

document.getElementById('ctx-bold').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory();
  s.bold = !s.bold;
  syncShapeDOM(s);
  document.getElementById('ctx-bold').style.background = s.bold ? '#e0e7ff' : '';
  scheduleSave();
});
document.getElementById('ctx-font-dec').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory();
  s.fontSize = Math.max(8, (s.fontSize || (s.type==='text' ? 14 : 12)) - 1);
  syncShapeDOM(s);
  document.getElementById('ctx-font-size').textContent = s.fontSize;
  scheduleSave();
});
document.getElementById('ctx-font-inc').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory();
  s.fontSize = Math.min(48, (s.fontSize || (s.type==='text'||s.type==='highlight' ? 14 : 12)) + 1);
  syncShapeDOM(s);
  document.getElementById('ctx-font-size').textContent = s.fontSize;
  scheduleSave();
});

// 글자 색
document.getElementById('ctx-text-color').addEventListener('input', e => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  s.textColor = e.target.value; syncShapeDOM(s); scheduleSave();
});
document.getElementById('ctx-text-color-reset').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  s.textColor = null; syncShapeDOM(s);
  document.getElementById('ctx-text-color').value =
    s.type==='highlight' ? (s.strokeColor||'#3b82f6') : '#1e293b';
  scheduleSave();
});

// ── 올가미 스타일 핸들러 ──────────────────────────────────────
['solid','dashed','dotted','dashdot'].forEach(type => {
  document.getElementById('ctx-dash-'+type)?.addEventListener('click', () => {
    const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
    pushHistory(); s.dashType = type;
    syncShapeDOM(s); updateDashButtons(type); scheduleSave();
  });
});

document.getElementById('ctx-sw-dec').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory(); s.strokeWidth = Math.max(1, (s.strokeWidth||2) - 1);
  document.getElementById('ctx-sw-val').textContent = s.strokeWidth;
  syncShapeDOM(s); scheduleSave();
});
document.getElementById('ctx-sw-inc').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory(); s.strokeWidth = Math.min(12, (s.strokeWidth||2) + 1);
  document.getElementById('ctx-sw-val').textContent = s.strokeWidth;
  syncShapeDOM(s); scheduleSave();
});

document.getElementById('ctx-stroke-color').addEventListener('input', e => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  s.strokeColor = e.target.value; syncShapeDOM(s); scheduleSave();
});
document.getElementById('ctx-fill-color').addEventListener('input', e => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  s.fillColor = e.target.value; syncShapeDOM(s); scheduleSave();
});
document.getElementById('ctx-fill-clear').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  s.fillColor = null; syncShapeDOM(s); scheduleSave();
});
document.getElementById('ctx-glow-toggle').addEventListener('click', () => {
  const s = shapes.find(sh=>sh.id===ctxTargetId); if (!s) return;
  pushHistory(); s.glow = !s.glow;
  syncShapeDOM(s);
  document.getElementById('ctx-glow-toggle').classList.toggle('active', s.glow);
  scheduleSave();
});

// ════════════════════════════════════════════════════════════════
//  Delete
// ════════════════════════════════════════════════════════════════
function deleteSelected() {
  if (!selectedIds.size) return;
  pushHistory();
  const shapeIds = new Set([...selectedIds].filter(id=>shapes.find(s=>s.id===id)));
  const connIds  = new Set([...selectedIds].filter(id=>connections.find(c=>c.id===id)));

  // Also delete connections attached to deleted shapes
  connections.forEach(c=>{ if(shapeIds.has(c.fromId)||shapeIds.has(c.toId)) connIds.add(c.id); });

  connIds.forEach(id=>{ const c=connections.find(x=>x.id===id); c?.el?.remove(); });
  shapeIds.forEach(id=>{ const s=shapes.find(x=>x.id===id); s?.el?.remove(); });
  connections = connections.filter(c=>!connIds.has(c.id));
  shapes      = shapes.filter(s=>!shapeIds.has(s.id));
  clearSel(); refreshTable(); scheduleSave();
}

document.getElementById('btn-delete').addEventListener('click', deleteSelected);

// ════════════════════════════════════════════════════════════════
//  Copy / Paste  (Ctrl+C / Ctrl+V)
// ════════════════════════════════════════════════════════════════
// Duplicate selected shapes (+ internal connections) in-place, return new objects
function duplicateSelected() {
  const selShapes = shapes.filter(s => selectedIds.has(s.id));
  const selIds    = new Set(selShapes.map(s => s.id));
  const selConns  = connections.filter(c => selIds.has(c.fromId) && selIds.has(c.toId));
  const idMap     = {};

  const newShapes = selShapes.map(s => {
    const newId = 's' + nextId++;
    idMap[s.id] = newId;
    return { id:newId, type:s.type, x:s.x, y:s.y, w:s.w, h:s.h, text:s.text, subject:s.subject };
  });
  const newConns = selConns.map(c => ({
    id:'c'+nextId++, fromId:idMap[c.fromId], toId:idMap[c.toId],
    fromPtIdx:c.fromPtIdx, toPtIdx:c.toPtIdx, label:c.label
  }));

  newShapes.forEach(s => { shapes.push(s); renderShape(s); });
  newConns.forEach(c  => { connections.push(c); renderConnection(c); });
  refreshTable();
  return { newShapes, idMap };
}

function copySelected() {
  const selShapes = shapes.filter(s=>selectedIds.has(s.id));
  if (!selShapes.length) return;
  const selShapeIds = new Set(selShapes.map(s=>s.id));
  const selConns = connections.filter(c=>selShapeIds.has(c.fromId)&&selShapeIds.has(c.toId));
  clipboard = {
    shapes: selShapes.map(s=>({id:s.id,type:s.type,x:s.x,y:s.y,w:s.w,h:s.h,text:s.text,subject:s.subject,bold:s.bold||undefined,fontSize:s.fontSize||undefined})),
    connections: selConns.map(c=>({id:c.id,fromId:c.fromId,toId:c.toId,fromPtIdx:c.fromPtIdx,toPtIdx:c.toPtIdx,label:c.label}))
  };
  showToast(`${selShapes.length}개 도형 복사됨  —  Ctrl+V로 붙여넣기`);
}

function pasteClipboard() {
  if (!clipboard || !clipboard.shapes.length) return;
  pushHistory();
  clearSel();
  const OFFSET = 40;
  const idMap  = {};
  clipboard.shapes.forEach(s => {
    const newId='s'+nextId++; idMap[s.id]=newId;
    const shape={...s, id:newId, x:s.x+OFFSET, y:s.y+OFFSET};
    shapes.push(shape); renderShape(shape);
    selectedIds.add(newId); shape.el.classList.add('selected');
  });
  clipboard.connections.forEach(c => {
    const newId='c'+nextId++;
    const conn={...c, id:newId, fromId:idMap[c.fromId], toId:idMap[c.toId]};
    connections.push(conn); renderConnection(conn);
  });
  // Shift clipboard for next paste
  clipboard = { ...clipboard, shapes: clipboard.shapes.map(s=>({...s, x:s.x+OFFSET, y:s.y+OFFSET})) };
  refreshTable(); scheduleSave();
  showToast('붙여넣기 완료');
}

// ════════════════════════════════════════════════════════════════
//  Keyboard shortcuts
//  NOTE: textEditor uses Tailwind 'hidden' class (display:none via CSS),
//  so style.display is '' not 'none' until explicitly set.
//  We use editingShape !== null to detect open state instead.
// ════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  // True when user is typing in a text field
  const inInput = editingShape !== null
    || e.target.tagName === 'INPUT'
    || e.target.tagName === 'TEXTAREA'
    || e.target.isContentEditable;

  // Allow Escape even in input (to close editor)
  if (e.key === 'Escape') { closeCtx(); if (inInput) closeTextEditor(true); else clearSel(); return; }

  if (inInput) return; // block all other shortcuts while typing
  if (readOnly)  return; // view mode — no edits

  // Delete / Backspace
  if ((e.key==='Delete'||e.key==='Backspace') && selectedIds.size) {
    e.preventDefault(); deleteSelected(); return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return; // remaining shortcuts all need Ctrl/Cmd

  // Undo  Ctrl+Z
  if ((e.key==='z'||e.key==='Z') && !e.shiftKey) {
    e.preventDefault(); undo(); return;
  }
  // Copy  Ctrl+C
  if (e.key==='c'||e.key==='C') {
    e.preventDefault(); copySelected(); return;
  }
  // Paste  Ctrl+V
  if (e.key==='v'||e.key==='V') {
    e.preventDefault(); pasteClipboard(); return;
  }
  // Select all  Ctrl+A
  if (e.key==='a'||e.key==='A') {
    e.preventDefault();
    clearSel();
    shapes.forEach(s=>{ selectedIds.add(s.id); s.el.classList.add('selected'); });
    showToast(`${shapes.length}개 도형 전체 선택`);
    return;
  }
});

// ════════════════════════════════════════════════════════════════
//  Table
// ════════════════════════════════════════════════════════════════
function typeLabel(t){ return t==='rect'?'일반 프로세스':t==='diamond'?'의사결정':t==='text'?'텍스트 상자':t==='highlight'?'올가미 상자':'시작/종료'; }

function getFollowups(shape) {
  const outs=connections.filter(c=>c.fromId===shape.id);
  if (!outs.length) return '<span class="text-slate-300">—</span>';
  return outs.map(c=>{
    const ts=shapes.find(s=>s.id===c.toId), name=ts?(ts.text||'(unnamed)'):'?';
    const lbl=c.label?` <span class="px-1 rounded text-[9px] font-bold ${c.label==='Y'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-600'}">${c.label}</span>`:'';
    return `→ ${name}${lbl}`;
  }).join('  ');
}

function refreshTable() {
  // text/highlight는 분석 테이블 제외
  const processShapes = shapes.filter(s=>s.type!=='text'&&s.type!=='highlight');
  const h=processShapes.filter(s=>s.subject==='human').length;
  const a=processShapes.filter(s=>s.subject==='ai').length;
  tableCount.textContent=processShapes.length+'개';
  const statH=document.getElementById('stat-human');
  const statA=document.getElementById('stat-ai');
  if (statH) statH.innerHTML=`<span class="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block"></span> 사람 ${h}`;
  if (statA) statA.innerHTML=`<span class="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block"></span> AI ${a}`;

  if (!processShapes.length) {
    tableBody.innerHTML='<tr><td colspan="5" class="px-3 py-5 text-center text-slate-400 text-xs">캔버스에 도형을 추가하면 자동 정리됩니다.</td></tr>';
    return;
  }
  tableBody.innerHTML=processShapes.map((s,i)=>{
    const row=s.subject==='human'?'row-human':s.subject==='ai'?'row-ai':'';
    const tb=s.type==='diamond'?'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">◇ 의사결정</span>':s.type==='oval'?'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700">⬭ 시작/종료</span>':'<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600">□ 프로세스</span>';
    const sb=s.subject==='human'?'<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">👤 사람</span>':s.subject==='ai'?'<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700">🤖 AI</span>':'<span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-400">미지정</span>';
    return `<tr class="${row} cursor-pointer transition-colors" data-sid="${s.id}">
      <td class="px-3 py-1.5 text-slate-400 font-mono text-[11px]">${String(i+1).padStart(2,'0')}</td>
      <td class="px-3 py-1.5 font-semibold text-slate-800 text-xs">${s.text||'<span class="text-slate-300 italic">미입력</span>'}</td>
      <td class="px-3 py-1.5">${tb}</td>
      <td class="px-3 py-1.5">${sb}</td>
      <td class="px-3 py-1.5 text-xs text-slate-600">${getFollowups(s)}</td>
    </tr>`;
  }).join('');
  tableBody.querySelectorAll('tr[data-sid]').forEach(tr=>{
    tr.addEventListener('click',()=>{ clearSel(); addSelectShape(tr.dataset.sid); });
  });
}

// ════════════════════════════════════════════════════════════════
//  Save / Load
// ════════════════════════════════════════════════════════════════
function setSaveStatus(s) {
  const dot=document.getElementById('save-dot'), txt=document.getElementById('save-text');
  if      (s==='saving'){ dot.className='w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse'; txt.textContent='저장 중...'; }
  else if (s==='error') { dot.className='w-1.5 h-1.5 rounded-full bg-red-500';                 txt.textContent='저장 실패'; }
  else                  { dot.className='w-1.5 h-1.5 rounded-full bg-emerald-400';              txt.textContent='저장됨'; }
}
function scheduleSave() {
  if (readOnly) return;
  setSaveStatus('saving'); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 800);
}
async function doSave() {
  if (!projectId || readOnly) return;
  try {
    await DB.saveCanvas(projectId, { shapes, connections });
    setSaveStatus('saved');
  } catch(e) {
    console.error('save failed', e);
    setSaveStatus('error');
    showToast('⚠️ 저장 실패 — 네트워크 또는 권한 문제');
  }
}

function loadCanvas(data) {
  shapes.forEach(s=>s.el?.remove()); connections.forEach(c=>c.el?.remove());
  shapes=[]; connections=[]; let maxN=0;
  (data.shapes||[]).forEach(s=>{ const shape={...s}; shapes.push(shape); renderShape(shape); const n=parseInt(s.id.slice(1)); if(!isNaN(n)&&n>maxN) maxN=n; });
  (data.connections||[]).forEach(c=>{ const conn={...c}; connections.push(conn); renderConnection(conn); const n=parseInt(c.id.slice(1)); if(!isNaN(n)&&n>maxN) maxN=n; });
  nextId=maxN+1; refreshTable();
}

// ════════════════════════════════════════════════════════════════
//  Share / Export
// ════════════════════════════════════════════════════════════════
document.getElementById('btn-share').addEventListener('click', async () => {
  if (!projectId) return;
  await doSave();
  const url = location.origin + location.pathname.replace('editor.html','') + `editor.html?id=${projectId}&mode=view`;
  navigator.clipboard.writeText(url).then(()=>showToast('열람 링크 복사됨 ✓ (누구나 열람 가능)')).catch(()=>prompt('열람 링크:',url));
});

document.getElementById('btn-export-json').addEventListener('click', async () => {
  await doSave();
  const meta = await DB.getProject(projectId) || {};
  const safeShapes = shapes.map(s => {
    const o = {id:s.id,type:s.type,x:Math.round(s.x),y:Math.round(s.y),w:s.w,h:s.h,text:s.text||'',subject:s.subject||null};
    if (s.bold)     o.bold     = s.bold;
    if (s.fontSize) o.fontSize = s.fontSize;
    return o;
  });
  const blob = new Blob([JSON.stringify({
    project: meta,
    shapes: safeShapes,
    connections: connections.map(c=>({id:c.id,fromId:c.fromId,toId:c.toId,fromPtIdx:c.fromPtIdx,toPtIdx:c.toPtIdx,label:c.label!=null?c.label:null})),
    analysis: shapes.map((s,i)=>({seq:i+1,name:s.text||'(미입력)',type:typeLabel(s.type),subject:s.subject==='human'?'사람':s.subject==='ai'?'AI':'미지정',followups:connections.filter(c=>c.fromId===s.id).map(c=>({target:shapes.find(sh=>sh.id===c.toId)?.text||'?',label:c.label}))}))
  },null,2)],{type:'application/json'});
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:(meta.name||'flowchart')+'.json'}); a.click(); URL.revokeObjectURL(a.href);
});

// ════════════════════════════════════════════════════════════════
//  Save As (다른 이름으로 저장)
// ════════════════════════════════════════════════════════════════
const modalSaveAs = document.getElementById('modal-save-as');

document.getElementById('btn-save-as').addEventListener('click', () => {
  document.getElementById('sa-name').value = '';
  document.getElementById('sa-desc').value = '';
  document.getElementById('sa-owner').value = '';
  document.getElementById('sa-password').value = '';
  modalSaveAs.classList.remove('hidden'); modalSaveAs.classList.add('flex');
  setTimeout(() => document.getElementById('sa-name').focus(), 50);
});
document.getElementById('sa-cancel').addEventListener('click', () => {
  modalSaveAs.classList.add('hidden'); modalSaveAs.classList.remove('flex');
});
document.getElementById('sa-confirm').addEventListener('click', async () => {
  const name = document.getElementById('sa-name').value.trim();
  if (!name) { document.getElementById('sa-name').focus(); return; }
  const password = document.getElementById('sa-password').value;
  if (!password) { document.getElementById('sa-password').focus(); return; }

  const btn = document.getElementById('sa-confirm');
  btn.disabled = true; btn.textContent = '저장 중...';
  try {
    const newProject = await DB.createProject({
      name,
      description: document.getElementById('sa-desc').value.trim(),
      owner:       document.getElementById('sa-owner').value.trim(),
      password
    });
    await DB.saveCanvas(newProject.id, {
      shapes, connections
    });
    modalSaveAs.classList.add('hidden'); modalSaveAs.classList.remove('flex');
    showToast(`"${name}" 으로 저장됨 ✓`);
  } catch(e) {
    showToast('저장 실패: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '저장';
  }
});

// ════════════════════════════════════════════════════════════════
//  발행 (작업실 → 게시판)
// ════════════════════════════════════════════════════════════════
document.getElementById('btn-publish')?.addEventListener('click', async () => {
  if (!projectId || readOnly) return;
  const meta = await DB.getProject(projectId);
  if (!meta) return;
  if ((meta.status || 'draft') === 'published') {
    if (!confirm('게시판에서 다시 작업실로 회수하시겠습니까?')) return;
    await DB.unpublishProject(projectId);
    updatePublishBtn('draft');
    showToast('작업실로 회수됨 ↩');
  } else {
    await doSave();
    await DB.publishProject(projectId);
    updatePublishBtn('published');
    showToast('🎉 게시판에 발행됨! 모두가 볼 수 있습니다.');
  }
});

function updatePublishBtn(status) {
  const btn = document.getElementById('btn-publish');
  if (!btn) return;
  if (status === 'published') {
    btn.textContent = '📌 발행 완료';
    btn.className = btn.className.replace(/bg-\S+/g, '').trim() + ' bg-emerald-600 hover:bg-emerald-500';
  } else {
    btn.textContent = '🚀 게시판 발행';
    btn.className = btn.className.replace(/bg-\S+/g, '').trim() + ' bg-violet-600 hover:bg-violet-500';
  }
}

// ════════════════════════════════════════════════════════════════
//  Divider resize
// ════════════════════════════════════════════════════════════════
(()=>{
  const div=document.getElementById('divider'),tp=document.getElementById('table-panel');
  let dr=false,sy=0,sh=0;
  div.addEventListener('mousedown',e=>{ dr=true;sy=e.clientY;sh=tp.getBoundingClientRect().height; document.body.style.cssText='cursor:row-resize;user-select:none;'; });
  window.addEventListener('mousemove',e=>{ if(!dr) return; tp.style.height=Math.max(64,Math.min(window.innerHeight*.55,sh+(sy-e.clientY)))+'px'; });
  window.addEventListener('mouseup',()=>{ dr=false; document.body.style.cssText=''; });
})();

// ════════════════════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════════════════════
function showToast(msg) {
  document.querySelectorAll('.fc-toast').forEach(t=>t.remove());
  const t=document.createElement('div');
  t.className='fc-toast fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-slate-200 text-xs px-4 py-2.5 rounded-full shadow-xl z-[999] whitespace-nowrap';
  t.textContent=msg; document.body.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(),300); },2200);
}

// ════════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════════
(async function boot() {
  const params  = new URLSearchParams(location.search);
  projectId     = params.get('id');
  const isNew   = params.get('new')  === '1';
  const mode    = params.get('mode') || 'edit'; // 'view' | 'edit'
  readOnly      = mode === 'view';

  if (!projectId) { location.href = 'index.html'; return; }

  const meta = await DB.getProject(projectId);
  if (!meta)  { location.href = 'index.html'; return; }

  document.title = meta.name + ' – FlowChart Builder';
  document.getElementById('project-name').textContent = meta.name;

  // 편집 모드인데 인증 안된 경우 → 열람 모드로 강등
  if (!readOnly && meta.passwordHash && !DB.isAuthed(projectId)) {
    readOnly = true;
  }

  // Show view-mode banner and hide edit-only UI
  if (readOnly) {
    const banner = document.getElementById('view-banner');
    if (banner) banner.classList.remove('hidden');
    document.getElementById('save-status')?.style.setProperty('display','none');
    document.getElementById('btn-delete')?.style.setProperty('display','none');
    document.getElementById('btn-share')?.style.setProperty('display','none');
    document.getElementById('btn-export-json')?.style.setProperty('display','none');
    document.getElementById('btn-publish')?.style.setProperty('display','none');
    document.getElementById('btn-save-as') && (document.getElementById('btn-save-as').style.display='none');
  } else {
    // 발행 버튼 초기 상태
    updatePublishBtn(meta.status || 'draft');
  }

  const data = await DB.loadCanvas(projectId);
  if (isNew || !data.shapes.length) {
    const s1=createShape('oval',    100, 60, '시작',    'human');
    const s2=createShape('rect',    100,170, '업무 접수','human');
    const s3=createShape('diamond', 100,290, '승인 필요?','human');
    const s4=createShape('rect',    290,250, '승인 요청','human');
    const s5=createShape('rect',    100,430, '처리 진행','ai');
    const s6=createShape('oval',    100,550, '종료',    'human');
    setTimeout(()=>{
      createConnection(s1,2,s2,0); createConnection(s2,2,s3,0);
      createConnection(s3,1,s4,3); createConnection(s3,2,s5,0);
      createConnection(s4,2,s5,smartTargetCp(s4,2,s5)); createConnection(s5,2,s6,0);
    }, 30);
  } else {
    loadCanvas(data);
  }

  // Hint
  setTimeout(() => {
    const h = document.getElementById('pan-hint');
    if (h) { h.style.opacity='1'; setTimeout(()=>{h.style.transition='opacity 1s';h.style.opacity='0';},3500); }
  }, 1000);

  // Push initial undo state
  setTimeout(() => { history=[snapshot()]; histIdx=0; }, 100);
  applyVP();

  // Save immediately on page leave
  if (!readOnly) window.addEventListener('beforeunload', doSave);
})();
