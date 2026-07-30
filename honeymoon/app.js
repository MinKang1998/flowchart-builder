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

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  // ════════════════════════════════════════════════════════════
  //  여행 개요 필드
  // ════════════════════════════════════════════════════════════
  function hydrateHeader() {
    $('#trip-destination').value = trip.destination || '';
    $('#trip-start').value = trip.startDate || '';
    $('#trip-end').value = trip.endDate || '';
  }
  $('#trip-destination').addEventListener('input', e => { trip.destination = e.target.value; save(); });
  $('#trip-start').addEventListener('change', e => { trip.startDate = e.target.value; save(); });
  $('#trip-end').addEventListener('change', e => { trip.endDate = e.target.value; save(); });

  // ════════════════════════════════════════════════════════════
  //  탭 전환
  // ════════════════════════════════════════════════════════════
  function setTab(name) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.add('hidden'));
    $('#panel-' + name).classList.remove('hidden');
    if (name === 'map') { renderMap(); }
    if (name === 'ai')  { refreshChatKeyState(); }
  }
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ════════════════════════════════════════════════════════════
  //  일정표 렌더링
  // ════════════════════════════════════════════════════════════
  function renderItinerary() {
    const wrap = $('#days-container');
    wrap.innerHTML = '';
    $('#itinerary-empty').classList.toggle('hidden', trip.days.length > 0);

    trip.days.forEach((day, di) => {
      const card = document.createElement('div');
      card.className = 'bg-white rounded-2xl border border-rose-100 shadow-sm overflow-hidden';
      card.innerHTML = `
        <div class="flex items-center gap-2 px-4 py-3 bg-rose-50/60 border-b border-rose-100">
          <span class="text-sm font-bold text-rose-600">DAY ${di + 1}</span>
          <input type="date" value="${esc(day.date || '')}" data-day="${day.id}"
            class="day-date text-xs px-2 py-1 rounded border border-slate-200 bg-white outline-none"/>
          <input type="text" value="${esc(day.label || '')}" placeholder="예: 로마 시내"
            data-day="${day.id}"
            class="day-label flex-1 text-sm px-2 py-1 rounded border border-transparent hover:border-slate-200 focus:border-rose-300 outline-none font-medium"/>
          <button class="day-del text-slate-300 hover:text-red-500 text-lg leading-none px-1" data-day="${day.id}" title="날짜 삭제">&times;</button>
        </div>
        <div class="items-list divide-y divide-slate-100" data-day="${day.id}"></div>
        <button class="add-item w-full text-xs text-rose-500 hover:bg-rose-50 py-2.5 font-medium transition" data-day="${day.id}">
          + 일정 추가
        </button>`;
      wrap.appendChild(card);

      const list = $('.items-list', card);
      if (!day.items.length) {
        list.innerHTML = `<div class="px-4 py-4 text-xs text-slate-300 text-center">일정을 추가해 보세요</div>`;
      }
      day.items.forEach(item => list.appendChild(renderItemRow(day, item)));

      // 드래그 정렬
      new Sortable(list, {
        group: 'items',
        handle: '.drag-handle',
        animation: 150,
        onEnd: onSortEnd,
      });
    });
  }

  function renderItemRow(day, item) {
    const c = CAT[item.category] || CAT.etc;
    const row = document.createElement('div');
    row.className = 'item-row flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50 cursor-pointer';
    row.dataset.item = item.id;
    row.dataset.day = day.id;
    const hasLoc = typeof item.lat === 'number';
    const attCount = (item.attachments || []).length;
    row.innerHTML = `
      <span class="drag-handle cursor-grab text-slate-300 hover:text-slate-500 select-none px-1" title="드래그로 순서변경">⠿</span>
      <span class="text-xs text-slate-400 w-11 tabular-nums">${esc(item.time || '––:––')}</span>
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${catColor(item.category)}"></span>
      <span class="flex-1 min-w-0">
        <span class="text-sm text-slate-700 truncate block">${c.emoji} ${esc(item.title || '(제목 없음)')}</span>
        ${item.place ? `<span class="text-[11px] text-slate-400 truncate block">📍 ${esc(item.place)}</span>` : ''}
      </span>
      ${hasLoc ? '<span class="text-[10px] text-emerald-500" title="지도 표시됨">지도</span>' : ''}
      ${attCount ? `<span class="text-[10px] text-slate-400">📎${attCount}</span>` : ''}`;
    row.addEventListener('click', e => {
      if (e.target.closest('.drag-handle')) return;
      openItemModal(day.id, item.id);
    });
    return row;
  }

  // 드래그 후 데이터 재구성 (날짜 간 이동 포함)
  function onSortEnd() {
    const newDays = trip.days.map(d => ({ ...d, items: [] }));
    const byId = Object.fromEntries(newDays.map(d => [d.id, d]));
    const itemById = {};
    trip.days.forEach(d => d.items.forEach(it => { itemById[it.id] = it; }));

    $$('.items-list').forEach(list => {
      const dayId = list.dataset.day;
      $$('.item-row', list).forEach(row => {
        const it = itemById[row.dataset.item];
        if (it && byId[dayId]) byId[dayId].items.push(it);
      });
    });
    trip.days = newDays;
    save();
    renderItinerary();
  }

  // 날짜 라벨/날짜/삭제 이벤트 (위임)
  $('#days-container').addEventListener('input', e => {
    const id = e.target.dataset.day;
    if (!id) return;
    const day = trip.days.find(d => d.id === id);
    if (!day) return;
    if (e.target.classList.contains('day-label')) day.label = e.target.value;
    if (e.target.classList.contains('day-date'))  day.date = e.target.value;
    save();
  });
  $('#days-container').addEventListener('click', e => {
    const delBtn = e.target.closest('.day-del');
    if (delBtn) {
      if (confirm('이 날짜와 포함된 일정을 삭제할까요?')) {
        trip.days = trip.days.filter(d => d.id !== delBtn.dataset.day);
        save(); renderItinerary();
      }
      return;
    }
    const addBtn = e.target.closest('.add-item');
    if (addBtn) openItemModal(addBtn.dataset.day, null);
  });

  $('#btn-add-day').addEventListener('click', () => {
    trip.days.push({ id: Store.uid(), label: '', date: '', items: [] });
    save(); renderItinerary();
  });

  // ════════════════════════════════════════════════════════════
  //  일정 편집 모달
  // ════════════════════════════════════════════════════════════
  let editing = { dayId: null, itemId: null, chosenPlace: null };

  function openItemModal(dayId, itemId) {
    editing = { dayId, itemId, chosenPlace: null };
    const day = trip.days.find(d => d.id === dayId);
    const item = itemId ? day.items.find(i => i.id === itemId) : null;

    $('#item-modal-title').textContent = item ? '일정 편집' : '일정 추가';
    $('#item-time').value = item?.time || '';
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
    const dest = trip.destination || '이번 여행지';
    const prompt = `${dest}에서 신혼부부에게 추천하는 ${theme} 몇 곳을 알려줘. 위치와 추천 이유도 간단히.`;
    $('#chat-input').value = prompt;
    $('#chat-input').focus();
  }));

  // ════════════════════════════════════════════════════════════
  //  초기화
  // ════════════════════════════════════════════════════════════
  hydrateHeader();
  renderItinerary();
  refreshChatKeyState();
  setTab('itinerary');

  // 첫 방문 안내
  if (!trip.days.length && !trip.destination) {
    appendChat('ai',
      '안녕하세요! 신혼여행 계획을 도와드릴게요 💕\n\n' +
      '위에 목적지와 날짜를 적고, 🗓 일정표에서 하루하루 일정을 추가해 보세요. ' +
      '각 일정에 위치를 지정하면 🗺 지도에서 동선이 그려지고, 바우처·사진·PDF도 첨부할 수 있어요.\n\n' +
      'AI 추천을 쓰려면 ⚙️ 설정에서 Claude API 키를 입력해 주세요.');
  }
})();
