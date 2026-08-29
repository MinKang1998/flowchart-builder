'use strict';
// ════════════════════════════════════════════════════════════════
//  ai.js – Claude 기반 여행 추천 챗봇
//   · 브라우저에서 Anthropic API 직접 호출
//     (anthropic-dangerous-direct-browser-access 헤더)
//   · web_search 서버 도구로 실시간 맛집/명소/쇼핑 검색·추천
//   · API 키는 사용자의 브라우저(localStorage)에만 저장됨
// ════════════════════════════════════════════════════════════════

const AI = (() => {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL   = 'claude-opus-4-8';   // 대화형 추천에 적합. 필요시 설정에서 변경 가능.

  function systemPrompt(trip) {
    // 별도 입력칸 없이, 일정표에 적힌 DAY 라벨·날짜로 목적지/기간을 유추
    const days = trip.days || [];
    const labels = [...new Set(days.map(d => (d.label || '').trim()).filter(Boolean))];
    const dateList = days.map(d => d.date).filter(Boolean).sort();
    const dest = labels.length ? labels.join(', ') : '(목적지 미정)';
    const dates = dateList.length ? `${dateList[0]} ~ ${dateList[dateList.length - 1]}` : '(일정 미정)';
    return [
      '당신은 신혼여행 플래너 전문 AI입니다. 사용자는 신혼여행을 준비하는 부부입니다.',
      `여행 목적지: ${dest}. 여행 기간: ${dates}.`,
      '역할:',
      '- 맛집, 명소, 쇼핑, 데이트 코스 등 신혼여행에 어울리는 장소를 추천합니다.',
      '- 최신 정보(영업 여부, 인기, 예약 필요 여부 등)가 중요할 땐 web_search 도구로 실제 검색해 근거를 확인하세요.',
      '- 커플/신혼 분위기, 로맨틱함, 동선 효율을 고려해 추천합니다.',
      '- 추천 장소는 이름 · 한줄 소개 · 위치(도시/지역) · 추천 이유를 간결하게 제시하세요.',
      '- 여러 곳을 추천할 땐 번호 목록으로 정리하고, 가능하면 테마(맛집/명소/쇼핑)를 함께 표기하세요.',
      '- 한국어로, 친근하고 명확하게 답합니다. 장황하지 않게 핵심 위주로.',
      '- 확실하지 않은 정보는 추측하지 말고 검색하거나 불확실함을 밝히세요.',
    ].join('\n');
  }

  // messages: [{role, content(text)}]
  // onText: 스트리밍 텍스트 조각 콜백 (선택)
  async function ask(messages, trip, opts = {}) {
    const settings = Store.loadSettings();
    const apiKey = settings.apiKey;
    if (!apiKey) throw new Error('NO_KEY');

    const useSearch = opts.webSearch !== false;
    const body = {
      model: settings.model || MODEL,
      max_tokens: 2048,
      system: systemPrompt(trip),
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    };
    if (useSearch) {
      // 실시간 장소 검색용 web search 서버 도구
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      if (res.status === 401) throw new Error('AUTH');
      throw new Error(`API 오류 ${res.status}: ${detail}`);
    }

    const data = await res.json();
    // content 블록 중 text만 이어붙임 (web_search_tool_result 등은 건너뜀)
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    return text || '(응답을 생성하지 못했습니다.)';
  }

  function hasKey() { return !!Store.loadSettings().apiKey; }

  // ── 파일 → base64 (data URL 접두어 제거) ──────────────────────
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // ── 관대한 JSON 파서 (코드펜스/앞뒤 텍스트 제거) ─────────────
  function parseJsonLoose(t) {
    if (!t) return null;
    let s = t.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(s); } catch {}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }

  // ── 예약/바우처/항공권 사진·PDF → 일정 항목 추출 (멀티모달 비전) ──
  //  항공권·숙소·맛집·투어·바우처 등 어떤 예약 문서든 일정으로 정리.
  async function extractReservation(file) {
    const settings = Store.loadSettings();
    const apiKey = settings.apiKey;
    if (!apiKey) throw new Error('NO_KEY');

    const b64 = await fileToBase64(file);
    const isPdf = (file.type || '').includes('pdf');
    const mediaBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: b64 } };

    const instruction = [
      '첨부한 이미지/문서는 여행 예약 관련 자료입니다. 예: 항공권(e-티켓/탑승권), 호텔·숙소 예약확인서,',
      '식당 예약, 투어·입장권·액티비티 바우처, 렌터카·교통 예약 등.',
      '내용을 읽고 여행 일정 항목으로 정리하세요. 아래 JSON 형식으로만 답하세요.',
      '설명 문장이나 코드펜스 없이 순수 JSON만 출력합니다.',
      '{',
      '  "entries": [',
      '    {',
      '      "category": "transport | hotel | food | sight | shopping | etc 중 하나",',
      '      "title": "간결한 제목. 맨 앞에 종류 이모지를 붙이세요(항공 ✈️, 숙소 🏨, 맛집 🍽, 투어·명소 📸, 쇼핑 🛍, 기타 📌). 예: \'✈️ 대한항공 KE931 인천→로마\', \'🏨 힐튼 로마 체크인\'",',
      '      "place": "장소명 또는 주소(공항/호텔/식당/장소). 지도 검색에 쓰이니 최대한 구체적으로",',
      '      "city": "도시",',
      '      "date": "YYYY-MM-DD (연도가 안 보이면 빈 문자열)",',
      '      "time": "HH:MM 24시간(체크인·출발·예약 시각 등, 없으면 빈 문자열)",',
      '      "endTime": "HH:MM 24시간. 항공편처럼 같은 날짜 안에서 끝나는 시각(도착 시각 등)이 있으면 적으세요. 자정을 넘기거나 모르면 빈 문자열",',
      '      "confirmation": "예약번호/바우처번호/PNR (없으면 빈 문자열)",',
      '      "notes": "핵심 정보를 줄바꿈으로. 항공: 도착시각·좌석. 숙소: 체크아웃 날짜·박수·객실. 식당/투어: 인원·옵션 등"',
      '    }',
      '  ]',
      '}',
      '규칙:',
      '- 항공권 왕복·경유는 각 구간을 별도 entry로. 출발 time과 도착 endTime을 함께 채워 하나의 이어진 칸으로 표시되게 하세요(같은 날짜 안에서 도착할 때만; 자정을 넘기면 endTime은 비워두세요).',
      '- 호텔은 체크인을 entry의 date/time으로 하고 체크아웃 정보는 notes에 적으세요.',
      '- 여러 예약이 한 문서에 있으면 각각 entry로 나누세요.',
      '- 여행 예약과 무관하거나 정보를 못 찾으면 {"entries": []} 를 반환하세요.',
    ].join('\n');

    const body = {
      model: settings.model || MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: [ mediaBlock, { type: 'text', text: instruction } ] }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      if (res.status === 401) throw new Error('AUTH');
      throw new Error(`API 오류 ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const json = parseJsonLoose(text);
    if (!json || !Array.isArray(json.entries)) return { entries: [] };
    return json;
  }

  return { ask, hasKey, extractReservation, MODEL };
})();
