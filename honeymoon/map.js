'use strict';
// ════════════════════════════════════════════════════════════════
//  map.js – Leaflet 지도 + 동선(순서) 표시 + Nominatim 지오코딩
//   외부 서버/키 불필요. OpenStreetMap 타일 + 무료 Nominatim 검색.
// ════════════════════════════════════════════════════════════════

const HMap = (() => {
  let map = null;
  let markerLayer = null;
  let routeLayer = null;
  let inited = false;

  function ensure() {
    if (inited) return;
    map = L.map('map', { zoomControl: true }).setView([37.5665, 126.9780], 3); // 초기: 서울
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    routeLayer  = L.layerGroup().addTo(map);
    inited = true;
  }

  // 지도 컨테이너가 뒤늦게 보이면 크기 재계산 필요
  function refresh() {
    if (map) setTimeout(() => map.invalidateSize(), 60);
  }

  // 번호가 매겨진 마커 아이콘
  function numberIcon(n, color) {
    return L.divIcon({
      className: 'hm-num-marker',
      html: `<div class="hm-pin" style="background:${color}">${n}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16],
    });
  }

  const CAT_COLOR = {
    food:     '#ef4444',
    sight:    '#3b82f6',
    shopping: '#a855f7',
    hotel:    '#f59e0b',
    transport:'#10b981',
    etc:      '#64748b',
  };

  // points: [{ n, lat, lng, title, category, dayLabel }]
  function render(points) {
    ensure();
    markerLayer.clearLayers();
    routeLayer.clearLayers();

    const valid = points.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
    if (!valid.length) { refresh(); return; }

    const latlngs = [];
    valid.forEach(p => {
      const color = CAT_COLOR[p.category] || CAT_COLOR.etc;
      const m = L.marker([p.lat, p.lng], { icon: numberIcon(p.n, color) });
      m.bindPopup(
        `<b>${p.n}. ${escapeHtml(p.title || '(제목 없음)')}</b>` +
        (p.dayLabel ? `<br><span style="color:#64748b">${escapeHtml(p.dayLabel)}</span>` : '')
      );
      m.addTo(markerLayer);
      latlngs.push([p.lat, p.lng]);
    });

    if (latlngs.length >= 2) {
      L.polyline(latlngs, {
        color: '#2563eb', weight: 3, opacity: 0.7, dashArray: '6 8',
      }).addTo(routeLayer);
    }

    try {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 15 });
    } catch { /* single point 등 */ }
    refresh();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ── Nominatim 지오코딩 (장소명 → 좌표) ─────────────────────────
  async function geocode(query) {
    if (!query || !query.trim()) return [];
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ko&q='
              + encodeURIComponent(query.trim());
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('지오코딩 요청 실패 (' + res.status + ')');
    const data = await res.json();
    return data.map(d => ({
      name: d.display_name,
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
    }));
  }

  return { render, refresh, geocode, CAT_COLOR };
})();
