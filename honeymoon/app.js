'use strict';
// ════════════════════════════════════════════════════════════════
//  app.js – 허니문 플래너 메인 로직
//   일정표 CRUD + 드래그 순서변경 · 지도 동선 · 첨부(IndexedDB) · AI 챗봇
// ════════════════════════════════════════════════════════════════

(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const CAT = {
    sight:    { emoji: '📸', label: '명소' },
    food:     { emoji: '🍜', label: '맛집' },
    shopping: { emoji: '🛍', label: '쇼핑' },
    hotel:    { emoji: '🏨', label: '숙소' },
    transport:{ emoji: '🚕', label: '이동' },
    etc:      { emoji: '📌', label: '기타' },
  };
  const catColor = c => HMap.CAT_COLOR[c] || HMap.CAT_COLOR.etc;

  let trip = Store.loadTrip();
  const save = () => Store.saveTrip(trip);

  // 일정표에 이미 적힌 DAY 라벨·날짜로 목적지/기간을 유추 (별도 입력칸 없이)
  function tripSummary() {
    const labels = [...new Set(trip.days.map(d => (d.label || '').trim()).filter(Boolean))];
    const dates = trip.days.map(d => d.date).filter(Boolean).sort();
    return {
      destination: labels.join(', '),
      dateRange: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '',
    };
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  // ════════════════════════════════════════════════════════════
  //  탭 전환
  // ════════════════════════════════════════════════════════════
  function setTab(name) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.add('hidden'));
    $('#panel-' + name).classList.remove('hidden');
    if (name === 'map') { renderMap(); }
  }
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ════════════════════════════════════════════════════════════
  //  자동 정렬: DAY는 날짜순, 각 DAY 안은 시간순 (안정 정렬)
  //   · 날짜/시간이 없는 항목은 뒤로, 기존 상대순서는 유지
  // ════════════════════════════════════════════════════════════
  function sortTrip() {
    const dk = s => (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : '9999-99-99';
    const tk = s => (s && /^\d{2}:\d{2}$/.test(s)) ? s : '99:99';
    trip.days.sort((a, b) => dk(a.date).localeCompare(dk(b.date)));
    trip.days.forEach(d => {
      d.items.sort((a, b) => tk(a.time).localeCompare(tk(b.time)));
    });
  }

  // ════════════════════════════════════════════════════════════
  //  일정표 렌더링 — 시간표(가로: 날짜, 세로: 30분 단위) 그리드
  // ════════════════════════════════════════════════════════════
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  const SLOT_COUNT = 48; // 00:00~23:30, 30분 단위

  function slotIndex(time) {
    if (!/^\d{2}:\d{2}$/.test(time || '')) return -1; // 시간 미정
    const [h, m] = time.split(':').map(Number);
    return Math.min(SLOT_COUNT - 1, h * 2 + (m >= 30 ? 1 : 0));
  }
  function slotLabel(i) {
    const h = String(Math.floor(i / 2)).padStart(2, '0');
    const m = i % 2 === 0 ? '00' : '30';
    return `${h}:${m}`;
  }
  // 항목이 차지하는 슬롯 수 (종료 시간이 시작 시간보다 뒤일 때만 범위로 인정)
  function itemSpan(item, startSlot) {
    const ei = slotIndex(item.endTime);
    if (ei === -1 || ei <= startSlot) return 1;
    return Math.min(ei, SLOT_COUNT) - startSlot;
  }
  // 종료 날짜가 시작 날짜보다 뒤인, 자정을 넘기는 일정인지 (항공편 등)
  function crossesDay(item, day) {
    return !!(day.date && item.endDate && /^\d{4}-\d{2}-\d{2}$/.test(item.endDate) &&
      item.endDate > day.date && slotIndex(item.endTime) !== -1);
  }

  function renderItinerary() {
    sortTrip();
    save();
    const wrap = $('#days-container');
    wrap.innerHTML = '';
    $('#itinerary-empty').classList.toggle('hidden', trip.days.length > 0);
    if (!trip.days.length) return;

    // DAY별 30분 슬롯에 항목 배치, 시간 미정 항목은 별도 버킷
    // 종료 시간이 있는 항목(예: 항공편)은 시작 슬롯에 { item, span }으로 담아
    // 이어지는 여러 슬롯을 rowspan 하나의 칸으로 합쳐서 그린다.
    // 종료 날짜가 다음날 이후(자정을 넘김)이면 출발일엔 "그날 끝까지" 칸을,
    // 도착일엔 "00:00부터 도착 시간까지" 칸을 각각 만들어 두 날짜에 걸쳐 이어 보이게 한다.
    const byDay = trip.days.map(day => {
      const slots = Array.from({ length: SLOT_COUNT }, () => []);
      const consumed = new Array(SLOT_COUNT).fill(false); // 앞선 rowspan에 이미 덮인 슬롯
      const unscheduled = [];
      day.items.forEach(item => {
        const si = slotIndex(item.time);
        if (si === -1) { unscheduled.push(item); return; }
        if (crossesDay(item, day)) {
          slots[si].push({ item, span: SLOT_COUNT - si, kind: 'crossStart', ownerDayId: day.id });
        } else {
          const span = itemSpan(item, si);
          slots[si].push({ item, span, kind: span > 1 ? 'range' : 'point', ownerDayId: day.id });
        }
      });
      return { day, slots, consumed, unscheduled };
    });

    // 자정을 넘기는 항목의 "도착일" 칸을 대상 DAY의 00:00 슬롯에 추가
    byDay.forEach(({ day }) => {
      day.items.forEach(item => {
        if (!crossesDay(item, day)) return;
        const target = byDay.find(b => b.day.date === item.endDate);
        if (!target) return; // 도착 날짜가 일정표 범위 밖이면 출발 쪽 칸만 표시
        const ei = slotIndex(item.endTime);
        target.slots[0].push({ item, span: Math.max(1, ei), kind: 'crossEnd', ownerDayId: day.id });
      });
    });

    const table = document.createElement('table');
    table.className = 'w-full border-collapse text-xs';

    // ── 헤더: 날짜가 가로로 나열 ──
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML =
      `<th class="sticky top-0 left-0 z-30 bg-slate-100 border border-slate-200 w-14 min-w-[56px] text-[10px] text-slate-400">시간</th>`;
    byDay.forEach(({ day }, di) => {
      let dateBig = '', dow = '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
        const [y, m, d] = day.date.split('-').map(Number);
        dateBig = `${m}/${d}`;
        dow = WEEKDAY[new Date(y, m - 1, d).getDay()];
      }
      const th = document.createElement('th');
      th.className = 'sticky top-0 z-20 bg-rose-50 border border-rose-100 align-top px-1 py-1.5 w-[130px] min-w-[130px] font-normal';
      th.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-bold text-rose-400">DAY ${di + 1}</span>
          <button class="day-del text-slate-300 hover:text-red-500 text-sm leading-none px-1" data-day="${day.id}" title="날짜 삭제">&times;</button>
        </div>
        <div class="text-sm font-extrabold text-slate-800 tabular-nums text-left">
          ${esc(dateBig)}${dow ? ` <span class="text-[10px] font-medium text-slate-400">(${dow})</span>` : ''}
        </div>
        <input type="date" value="${esc(day.date || '')}" data-day="${day.id}"
          class="day-date text-[10px] w-full mt-1 px-1 py-0.5 rounded border border-slate-200 bg-white outline-none"/>
        <input type="text" value="${esc(day.label || '')}" placeholder="도시" data-day="${day.id}"
          class="day-label text-[10px] w-full mt-1 px-1 py-0.5 rounded border border-slate-200 outline-none font-semibold text-slate-600"/>`;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // ── 본문: 30분 단위 세로 슬롯 ──
    const tbody = document.createElement('tbody');

    // 시간 미정 행 (맨 위)
    const unsRow = document.createElement('tr');
    unsRow.innerHTML =
      `<td class="sticky left-0 z-10 bg-amber-50 border border-slate-200 text-center text-[10px] text-amber-500 font-bold">미정</td>`;
    byDay.forEach(({ day, unscheduled }) => {
      const td = document.createElement('td');
      td.className = 'border border-slate-100 bg-amber-50/40 align-top p-0.5 cursor-pointer hover:bg-amber-50';
      unscheduled.forEach(item => td.appendChild(renderCellItem(day.id, item, 'point')));
      td.addEventListener('click', e => {
        if (e.target.closest('.cell-item')) return;
        openItemModal(day.id, null, { time: '' });
      });
      unsRow.appendChild(td);
    });
    tbody.appendChild(unsRow);

    for (let s = 0; s < SLOT_COUNT; s++) {
      const onHour = s % 2 === 0;
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="sticky left-0 z-10 ${onHour ? 'bg-slate-100 font-bold text-slate-500' : 'bg-slate-50 text-slate-300'} border border-slate-200 text-center text-[10px] tabular-nums">${onHour ? slotLabel(s) : ''}</td>`;
      byDay.forEach(({ day, slots, consumed }) => {
        if (consumed[s]) return; // 이전 행의 rowspan이 이 칸을 이미 덮고 있음
        const entries = slots[s];
        const rowspan = entries.length ? Math.max(1, ...entries.map(e => e.span)) : 1;
        if (rowspan > 1) {
          for (let k = 1; k < rowspan && s + k < SLOT_COUNT; k++) consumed[s + k] = true;
        }
        const td = document.createElement('td');
        if (rowspan > 1) td.rowSpan = rowspan;
        td.className = `border border-slate-100 align-top p-0.5 cursor-pointer hover:bg-rose-50/50 min-h-[24px] ${onHour ? 'border-t-slate-300' : ''}`;
        entries.forEach(({ item, kind, ownerDayId }) => td.appendChild(renderCellItem(ownerDayId, item, kind)));
        td.addEventListener('click', e => {
          if (e.target.closest('.cell-item')) return;
          openItemModal(day.id, null, { time: slotLabel(s) });
        });
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'overflow-auto';
    scrollWrap.style.maxHeight = '75vh';
    scrollWrap.appendChild(table);
    wrap.appendChild(scrollWrap);
  }

  // kind: 'point'(단일 시점) | 'range'(같은 날 시작~종료) |
  //       'crossStart'(자정 넘겨 다음날로 이어짐) | 'crossEnd'(전날에서 넘어옴)
  function renderCellItem(ownerDayId, item, kind) {
    const c = CAT[item.category] || CAT.etc;
    const color = catColor(item.category);
    const el = document.createElement('div');
    const spanning = kind !== 'point';
    el.className = 'cell-item text-[10px] leading-tight rounded px-1 py-0.5 mb-0.5 border-l-2 hover:opacity-75 ' +
      (spanning ? 'h-full' : 'truncate');
    el.style.borderLeftColor = color;
    el.style.background = color + '1c';
    el.dataset.item = item.id;
    el.dataset.day = ownerDayId;
    const titleStr = item.title || '(제목 없음)';
    const startsWithEmoji = /^\p{Extended_Pictographic}/u.test(titleStr);
    const label = (startsWithEmoji ? '' : c.emoji + ' ') + titleStr;
    const rangeText = `${item.time || ''}–${item.endTime || ''}`;
    if (kind === 'range') {
      el.innerHTML = `<div class="font-semibold">${esc(label)}</div>` +
        `<div class="text-slate-500">${esc(item.time)} – ${esc(item.endTime)}</div>`;
    } else if (kind === 'crossStart') {
      el.innerHTML = `<div class="font-semibold">${esc(label)}</div>` +
        `<div class="text-slate-500">${esc(item.time)} → 익일 ${esc(item.endTime)}</div>`;
    } else if (kind === 'crossEnd') {
      el.innerHTML = `<div class="text-slate-400 text-[9px]">전날 ${esc(item.time)} 출발 →</div>` +
        `<div class="font-semibold">${esc(label)}</div>` +
        `<div class="text-slate-500">~ ${esc(item.endTime)} 도착</div>`;
    } else {
      el.textContent = label;
    }
    el.title = titleStr + (item.place ? ` · ${item.place}` : '') + (spanning ? ` · ${rangeText}` : '');
    el.addEventListener('click', e => {
      e.stopPropagation();
      openItemModal(ownerDayId, item.id);
    });
    return el;
  }

  // 날짜 라벨/날짜/삭제 이벤트 (위임)
  $('#days-container').addEventListener('input', e => {
    const id = e.target.dataset.day;
    if (!id) return;
    const day = trip.days.find(d => d.id === id);
    if (!day) return;
    // 라벨은 입력 중 저장만 (재렌더 시 포커스 유지)
    if (e.target.classList.contains('day-label')) { day.label = e.target.value; save(); }
  });
  // 날짜 변경은 즉시 날짜순 재정렬
  $('#days-container').addEventListener('change', e => {
    const id = e.target.dataset.day;
    if (!id) return;
    const day = trip.days.find(d => d.id === id);
    if (!day) return;
    if (e.target.classList.contains('day-date')) {
      day.date = e.target.value;
      save();
      renderItinerary();
    }
  });
  $('#days-container').addEventListener('click', e => {
    const delBtn = e.target.closest('.day-del');
    if (delBtn) {
      if (confirm('이 날짜와 포함된 일정을 삭제할까요?')) {
        trip.days = trip.days.filter(d => d.id !== delBtn.dataset.day);
        save(); renderItinerary();
      }
    }
  });

  $('#btn-add-day').addEventListener('click', () => {
    trip.days.push({ id: Store.uid(), label: '', date: '', items: [] });
    save(); renderItinerary();
  });

  // ── 예약·바우처·항공권 사진/PDF → 자동 일정 추가 (멀티모달) ───
  const VALID_CATS = ['transport', 'hotel', 'food', 'sight', 'shopping', 'etc'];

  function needKeyOrPrompt() {
    if (AI.hasKey()) return true;
    alert('예약·바우처 자동입력은 AI 기능이라 Claude API 키가 필요해요. 설정에서 키를 입력해 주세요.');
    openSettings();
    return false;
  }

  $('#btn-add-flight').addEventListener('click', () => {
    if (!needKeyOrPrompt()) return;
    $('#flight-file-input').click();
  });
  $('#flight-file-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await handleDocFiles(files);
  });

  // 드래그앤드롭 영역
  const dropZone = $('#drop-zone');
  if (dropZone) {
    dropZone.addEventListener('click', () => { if (needKeyOrPrompt()) $('#flight-file-input').click(); });
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.add('border-sky-500', 'bg-sky-100');
    }));
    ['dragleave', 'dragend'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('border-sky-500', 'bg-sky-100');
    }));
    dropZone.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('border-sky-500', 'bg-sky-100');
      const files = Array.from(e.dataTransfer?.files || [])
        .filter(f => /^image\//.test(f.type) || f.type === 'application/pdf');
      if (!files.length) { alert('이미지 또는 PDF 파일만 올릴 수 있어요.'); return; }
      if (!needKeyOrPrompt()) return;
      await handleDocFiles(files);
    });
  }

  async function handleDocFiles(files) {
    const busy = showBusy(`📄 예약 자료 ${files.length}개를 분석하고 있어요...`);
    let added = 0, failed = 0, none = 0, authError = null;
    try {
      for (const file of files) {
        try {
          const { entries } = await AI.extractReservation(file);
          if (!entries.length) { none++; continue; }
          for (const en of entries) {
            const it = await createEntryItem(en, file);
            // 항목이 생기는 즉시 저장 — 이후 파일에서 오류가 나도
            // 이미 인식된 일정은 사라지지 않도록 보장
            if (it) { added++; save(); }
          }
        } catch (err) {
          if (err.message === 'NO_KEY' || err.message === 'AUTH') { authError = err; break; }
          failed++;
        }
      }
    } finally {
      renderItinerary();
      hideBusy(busy);
    }
    setTab('itinerary');
    if (authError) {
      alert((added ? `✅ 일정 ${added}건은 저장됐어요.\n` : '') +
        '⚠️ API 키가 없거나 올바르지 않아요. 설정에서 확인해 주세요.');
      openSettings();
      return;
    }
    const msgs = [];
    if (added) msgs.push(`✅ 일정 ${added}건을 추가했어요! 시간·위치를 확인해 주세요.`);
    if (none)  msgs.push(`ℹ️ ${none}개 파일에서는 예약 정보를 찾지 못했어요.`);
    if (failed) msgs.push(`⚠️ ${failed}개 파일 분석에 실패했어요.`);
    alert(msgs.join('\n') || '추가된 일정이 없어요.');
  }

  async function createEntryItem(en, file) {
    const date = normDate(en.date);
    // 같은 날짜의 DAY가 있으면 재사용, 없으면 새로 생성
    let day = date ? trip.days.find(d => d.date === date) : null;
    if (!day) {
      day = { id: Store.uid(), date: date || '', label: en.city || '', items: [] };
      trip.days.push(day);
    } else if (!day.label && en.city) {
      day.label = en.city;
    }

    const category = VALID_CATS.includes(en.category) ? en.category : 'etc';
    const notes = (en.notes || '').trim();
    const conf  = (en.confirmation || '').trim();
    const fullNotes = [notes, conf ? `예약번호: ${conf}` : ''].filter(Boolean).join('\n');

    const time = normTime(en.time);
    const endTimeRaw = normTime(en.endTime);
    const endDateRaw = normDate(en.endDate);
    let endTime = '', endDate = '';
    if (endTimeRaw && time) {
      if (endDateRaw && date && endDateRaw > date) { endTime = endTimeRaw; endDate = endDateRaw; }
      else if (endTimeRaw > time) { endTime = endTimeRaw; }
    }
    const item = {
      id: Store.uid(),
      category,
      time,
      endTime, endDate,
      title: (en.title || '').trim() || '(예약)',
      place: (en.place || en.city || '').trim(),
      notes: fullNotes,
      attachments: [],
    };
    day.items.push(item);

    // 장소 지오코딩 (best-effort)
    try {
      const q = (en.place || '').trim() || (en.city ? en.city.trim() : '');
      if (q) {
        const r = await HMap.geocode(q);
        if (r && r.length) {
          item.lat = r[0].lat; item.lng = r[0].lng;
          if (!item.place) item.place = r[0].name;
        }
      }
    } catch { /* 지오코딩 실패는 무시 */ }

    // 원본 예약 파일 첨부
    try {
      await Store.putAttachment(item.id, file);
      item.attachments = await Store.listAttachments(item.id);
    } catch { /* 첨부 실패는 무시 */ }

    return item;
  }

  function normDate(s) {
    if (!s) return '';
    const m = String(s).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
  }
  function normTime(s) {
    if (!s) return '';
    const m = String(s).match(/(\d{1,2}):(\d{2})/);
    return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : '';
  }

  // 전체 화면 로딩 오버레이
  function showBusy(msg) {
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[2200] bg-black/40 flex items-center justify-center';
    el.innerHTML =
      `<div class="bg-white rounded-xl px-5 py-4 shadow-lg text-sm text-slate-700 flex items-center gap-3">
        <span class="typing"><span></span><span></span><span></span></span>
        <span>${esc(msg)}</span>
      </div>`;
    document.body.appendChild(el);
    return el;
  }
  function hideBusy(el) { if (el) el.remove(); }

  // ════════════════════════════════════════════════════════════
  //  일정 편집 모달
  // ════════════════════════════════════════════════════════════
  let editing = { dayId: null, itemId: null, chosenPlace: null };

  function openItemModal(dayId, itemId, prefill = {}) {
    editing = { dayId, itemId, chosenPlace: null };
    const day = trip.days.find(d => d.id === dayId);
    const item = itemId ? day.items.find(i => i.id === itemId) : null;

    $('#item-modal-title').textContent = item ? '일정 편집' : '일정 추가';
    $('#item-time').value = item ? (item.time || '') : (prefill.time ?? '');
    $('#item-end-time').value = item ? (item.endTime || '') : (prefill.endTime ?? '');
    $('#item-end-date').value = item ? (item.endDate || '') : (prefill.endDate ?? '');
    $('#item-category').value = item?.category || 'sight';
    $('#item-title').value = item?.title || '';
    $('#item-notes').value = item?.notes || '';
    $('#item-place-query').value = item?.place || '';
    $('#item-place-results').innerHTML = '';
    $('#item-delete').classList.toggle('hidden', !item);

    // 기존 위치 표시
    const chosen = $('#item-place-chosen');
    if (item && typeof item.lat === 'number') {
      editing.chosenPlace = { name: item.place, lat: item.lat, lng: item.lng };
      chosen.textContent = `📍 위치 지정됨: ${item.place || ''}`;
      chosen.classList.remove('hidden');
    } else {
      chosen.classList.add('hidden');
    }

    renderAttachmentList();
    $('#item-modal').classList.remove('hidden');
  }
  function closeItemModal() { $('#item-modal').classList.add('hidden'); }
  $('#item-close').addEventListener('click', closeItemModal);

  // 위치 검색
  $('#item-place-search').addEventListener('click', doGeocode);
  $('#item-place-query').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doGeocode(); }
  });
  async function doGeocode() {
    const q = $('#item-place-query').value.trim();
    const box = $('#item-place-results');
    if (!q) return;
    box.innerHTML = `<div class="text-[11px] text-slate-400 px-1">검색 중...</div>`;
    try {
      const results = await HMap.geocode(q);
      if (!results.length) { box.innerHTML = `<div class="text-[11px] text-slate-400 px-1">결과 없음</div>`; return; }
      box.innerHTML = '';
      results.forEach(r => {
        const el = document.createElement('div');
        el.className = 'place-result';
        el.textContent = r.name;
        el.addEventListener('click', () => {
          editing.chosenPlace = { name: r.name, lat: r.lat, lng: r.lng };
          const shortName = r.name.split(',').slice(0, 2).join(', ');
          $('#item-place-query').value = shortName;
          const chosen = $('#item-place-chosen');
          chosen.textContent = `📍 위치 지정됨: ${shortName}`;
          chosen.classList.remove('hidden');
          box.innerHTML = '';
        });
        box.appendChild(el);
      });
    } catch (err) {
      box.innerHTML = `<div class="text-[11px] text-red-400 px-1">검색 실패: ${esc(err.message)}</div>`;
    }
  }

  // 첨부 파일
  $('#item-file-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    // 아이템이 아직 없으면 임시 저장 위해 먼저 생성 필요 → 저장 시점에 연결.
    // 여기서는 편집중 itemId가 있어야 첨부 가능하므로, 없으면 먼저 아이템 저장.
    if (!editing.itemId) {
      const created = commitItem({ silent: true });
      if (!created) return;
    }
    for (const f of files) {
      try { await Store.putAttachment(editing.itemId, f); }
      catch (err) { alert('첨부 저장 실패: ' + err.message); }
    }
    e.target.value = '';
    // 일정 카드의 첨부 개수 갱신
    const day = trip.days.find(d => d.id === editing.dayId);
    const it = day && day.items.find(i => i.id === editing.itemId);
    if (it) { it.attachments = await Store.listAttachments(it.id); save(); }
    await renderAttachmentList();
    renderItinerary();
  });

  async function renderAttachmentList() {
    const box = $('#item-attachments');
    box.innerHTML = '';
    if (!editing.itemId) {
      box.innerHTML = `<div class="text-[11px] text-slate-300">일정을 저장하면 파일을 첨부할 수 있어요</div>`;
      return;
    }
    const atts = await Store.listAttachments(editing.itemId);
    if (!atts.length) {
      box.innerHTML = `<div class="text-[11px] text-slate-300">첨부 없음</div>`;
      return;
    }
    atts.forEach(a => {
      const el = document.createElement('div');
      el.className = 'flex items-center gap-2 text-xs bg-slate-50 rounded-lg px-2 py-1.5';
      const isImg = (a.type || '').startsWith('image/');
      el.innerHTML = `
        <span>${isImg ? '🖼' : '📄'}</span>
        <span class="flex-1 truncate text-slate-600">${esc(a.name)}</span>
        <button class="att-view text-rose-500 hover:underline" data-id="${a.id}">보기</button>
        <button class="att-del text-slate-400 hover:text-red-500" data-id="${a.id}">삭제</button>`;
      box.appendChild(el);
    });
  }

  $('#item-attachments').addEventListener('click', async e => {
    const view = e.target.closest('.att-view');
    const del = e.target.closest('.att-del');
    if (view) return previewAttachment(view.dataset.id);
    if (del) {
      await Store.deleteAttachment(del.dataset.id);
      await renderAttachmentList();
      renderItinerary();
    }
  });

  async function previewAttachment(id) {
    const rec = await Store.getAttachment(id);
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    const content = $('#preview-content');
    if ((rec.type || '').startsWith('image/')) {
      content.innerHTML = `<img src="${url}" class="rounded-lg max-w-full max-h-[90vh]"/>`;
    } else if (rec.type === 'application/pdf') {
      content.innerHTML = `<iframe src="${url}" class="bg-white rounded-lg" style="width:80vw;height:85vh;border:none"></iframe>`;
    } else {
      content.innerHTML = `<a href="${url}" download="${esc(rec.name)}" class="text-white underline">${esc(rec.name)} 다운로드</a>`;
    }
    $('#preview-modal').classList.remove('hidden');
  }

  // 아이템 저장/삭제
  function commitItem({ silent } = {}) {
    const title = $('#item-title').value.trim();
    if (!title && !silent) { $('#item-title').focus(); return null; }
    const day = trip.days.find(d => d.id === editing.dayId);
    if (!day) return null;

    let item = editing.itemId ? day.items.find(i => i.id === editing.itemId) : null;
    if (!item) {
      item = { id: Store.uid(), attachments: [] };
      day.items.push(item);
      editing.itemId = item.id;
    }
    item.time = $('#item-time').value;
    const endTime = $('#item-end-time').value;
    const endDateInput = $('#item-end-date').value;
    if (!endTime) {
      item.endTime = ''; item.endDate = '';
    } else if (endDateInput && day.date && endDateInput !== day.date) {
      // 자정을 넘기는 범위: 종료 날짜가 시작 날짜보다 뒤일 때만 인정
      if (endDateInput > day.date) { item.endTime = endTime; item.endDate = endDateInput; }
      else { item.endTime = ''; item.endDate = ''; }
    } else {
      // 같은 날짜 범위: 종료 시간이 시작 시간보다 뒤일 때만 인정
      item.endTime = (item.time && endTime > item.time) ? endTime : '';
      item.endDate = '';
    }
    item.category = $('#item-category').value;
    item.title = title;
    item.notes = $('#item-notes').value.trim();
    item.place = $('#item-place-query').value.trim();
    if (editing.chosenPlace) {
      item.lat = editing.chosenPlace.lat;
      item.lng = editing.chosenPlace.lng;
      if (!item.place) item.place = editing.chosenPlace.name;
    } else if (!item.place) {
      delete item.lat; delete item.lng;
    }
    save();
    return item;
  }

  $('#item-save').addEventListener('click', async () => {
    const it = commitItem({});
    if (!it) return;
    // 첨부 개수 갱신용
    it.attachments = await Store.listAttachments(it.id);
    save();
    renderItinerary();
    closeItemModal();
  });

  $('#item-delete').addEventListener('click', async () => {
    if (!editing.itemId) return;
    if (!confirm('이 일정을 삭제할까요?')) return;
    const day = trip.days.find(d => d.id === editing.dayId);
    // 첨부도 정리
    const atts = await Store.listAttachments(editing.itemId);
    for (const a of atts) await Store.deleteAttachment(a.id);
    day.items = day.items.filter(i => i.id !== editing.itemId);
    save();
    renderItinerary();
    closeItemModal();
  });

  // ════════════════════════════════════════════════════════════
  //  지도 동선
  // ════════════════════════════════════════════════════════════
  function buildMapDayFilter() {
    const sel = $('#map-day-filter');
    const cur = sel.value;
    sel.innerHTML = '<option value="all">전체 일정 동선</option>';
    trip.days.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `DAY ${i + 1}${d.label ? ' · ' + d.label : ''}`;
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
  $('#map-day-filter').addEventListener('change', renderMap);

  function renderMap() {
    buildMapDayFilter();
    const filter = $('#map-day-filter').value;
    const points = [];
    let n = 0;
    trip.days.forEach((d, di) => {
      if (filter !== 'all' && d.id !== filter) return;
      d.items.forEach(it => {
        if (typeof it.lat === 'number' && typeof it.lng === 'number') {
          n++;
          points.push({
            n, lat: it.lat, lng: it.lng,
            title: it.title, category: it.category,
            dayLabel: `DAY ${di + 1}${d.label ? ' · ' + d.label : ''} ${it.time || ''}`.trim(),
          });
        }
      });
    });
    HMap.render(points);
  }

  // ════════════════════════════════════════════════════════════
  //  설정 모달
  // ════════════════════════════════════════════════════════════
  function openSettings() {
    const s = Store.loadSettings();
    $('#settings-apikey').value = s.apiKey || '';
    $('#settings-model').value = s.model || '';
    $('#settings-websearch').checked = s.webSearch !== false;
    $('#settings-modal').classList.remove('hidden');
  }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-save').addEventListener('click', () => {
    Store.saveSettings({
      apiKey: $('#settings-apikey').value.trim(),
      model: $('#settings-model').value.trim(),
      webSearch: $('#settings-websearch').checked,
    });
    $('#settings-modal').classList.add('hidden');
    refreshChatKeyState();
  });
  $('#settings-clear-key').addEventListener('click', () => {
    const s = Store.loadSettings();
    delete s.apiKey;
    Store.saveSettings(s);
    $('#settings-apikey').value = '';
    refreshChatKeyState();
    alert('저장된 API 키를 이 브라우저에서 삭제했습니다.');
  });
  $('#settings-reset-trip').addEventListener('click', async () => {
    if (!confirm('지금 일정을 지우고 처음 예시 일정으로 되돌릴까요? 되돌릴 수 없어요.')) return;
    for (const day of trip.days) {
      for (const item of day.items) {
        const atts = await Store.listAttachments(item.id);
        for (const a of atts) await Store.deleteAttachment(a.id);
      }
    }
    Store.saveTrip(Store.emptyTrip());  // 저장소를 완전히 비움
    trip = Store.loadTrip();            // 비어있으므로 loadTrip이 자동으로 기본 일정을 다시 채워줌
    save();
    renderItinerary();
    $('#settings-modal').classList.add('hidden');
    alert('일정을 기본 예시 일정으로 초기화했어요.');
  });

  // ════════════════════════════════════════════════════════════
  //  AI 추천 모달 (탭이 아닌 플로팅 버튼으로 열림)
  // ════════════════════════════════════════════════════════════
  function openAiModal() {
    refreshChatKeyState();
    $('#ai-modal').classList.remove('hidden');
    setTimeout(() => $('#chat-input').focus(), 50);
  }
  function closeAiModal() { $('#ai-modal').classList.add('hidden'); }
  $('#btn-open-ai').addEventListener('click', openAiModal);
  $('#ai-modal-close').addEventListener('click', closeAiModal);

  // ════════════════════════════════════════════════════════════
  //  AI 챗봇
  // ════════════════════════════════════════════════════════════
  const chatHistory = [];   // {role, content}

  function refreshChatKeyState() {
    const noKey = !AI.hasKey();
    $('#chat-nokey').classList.toggle('hidden', !noKey);
    $('#chat-send').disabled = false;
  }

  function appendChat(role, text, opts = {}) {
    const log = $('#chat-log');
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (role === 'user' ? 'chat-user' : 'chat-ai');
    if (opts.html) el.innerHTML = text;
    else el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // 아주 가벼운 마크다운(링크/굵게/줄바꿈)만 처리
  function lightMd(t) {
    return esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  async function sendChat(text) {
    if (!text.trim()) return;
    if (!AI.hasKey()) { openSettings(); return; }

    appendChat('user', text);
    chatHistory.push({ role: 'user', content: text });
    $('#chat-input').value = '';
    $('#chat-send').disabled = true;

    const typing = appendChat('ai', '<span class="typing"><span></span><span></span><span></span></span>', { html: true });

    try {
      const s = Store.loadSettings();
      const reply = await AI.ask(chatHistory, trip, { webSearch: s.webSearch !== false });
      typing.innerHTML = lightMd(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
    } catch (err) {
      let msg;
      if (err.message === 'NO_KEY' || err.message === 'AUTH')
        msg = '⚠️ API 키가 없거나 올바르지 않습니다. 설정 ⚙️에서 키를 확인하세요.';
      else
        msg = '⚠️ 오류: ' + err.message;
      typing.textContent = msg;
      // 실패한 user 턴은 히스토리에서 제거해 재시도 가능하게
      chatHistory.pop();
    } finally {
      $('#chat-send').disabled = false;
    }
  }

  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    sendChat($('#chat-input').value);
  });

  $$('.quick-chip').forEach(chip => chip.addEventListener('click', () => {
    const theme = chip.dataset.q;
    const dest = tripSummary().destination || '이번 여행지';
    const prompt = `${dest}에서 신혼부부에게 추천하는 ${theme} 몇 곳을 알려줘. 위치와 추천 이유도 간단히.`;
    $('#chat-input').value = prompt;
    $('#chat-input').focus();
  }));

  // ════════════════════════════════════════════════════════════
  //  초기화
  // ════════════════════════════════════════════════════════════
  renderItinerary();
  refreshChatKeyState();
  setTab('itinerary');

  // 첫 방문 안내 (일정이 비어있을 때 — 보통 초기화 직후)
  if (!trip.days.length) {
    appendChat('ai',
      '안녕하세요! 신혼여행 계획을 도와드릴게요 💕\n\n' +
      '🗓 일정표에서 + 날짜(DAY) 추가로 하루하루 일정을 만들어 보세요. ' +
      '📄 예약·바우처 자동입력 버튼(또는 드래그앤드롭)으로 항공권·숙소 예약서를 올리면 AI가 자동으로 일정을 채워줘요.\n\n' +
      '각 일정에 위치를 지정하면 🗺 동선 지도 탭에서 순서대로 표시되고, 바우처·사진·PDF도 첨부할 수 있어요.\n\n' +
      '이 버튼(✨)을 누르면 언제든 AI 추천을 받을 수 있어요. 쓰려면 ⚙️ 설정에서 Claude API 키를 입력해 주세요.');
  }
})();
