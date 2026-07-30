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
    const dest = trip.destination || '(목적지 미정)';
    const dates = (trip.startDate || trip.endDate)
      ? `${trip.startDate || '?'} ~ ${trip.endDate || '?'}` : '(일정 미정)';
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

  return { ask, hasKey, MODEL };
})();
