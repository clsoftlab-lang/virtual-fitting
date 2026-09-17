// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// ai/ai.js — 플러그블 AI 레이어 (데모=mock / 실서비스=백엔드 프록시)
// =====================================================================
// askAI(task, payload, {onToken}) 하나로 세 가지 AI 기능을 제공한다.
//   - AI_ENDPOINT 가 비어있으면(config.js) → 결정론적 한글 MockProvider.
//     실제 카탈로그(garments) + fit-engine.js 을 그대로 재사용해 근거 있는
//     추천/설명을 생성한다(그라운딩). LLM·키·네트워크가 필요 없다.
//   - AI_ENDPOINT 가 있으면 → 그 URL 로 {task, payload} 를 POST 하고
//     서버가 스트리밍하는 텍스트를 onToken 으로 흘려보낸다.
//
// ⚠️ 이 파일과 브라우저 어디에도 API 키가 없다. 키는 server/ 백엔드 전용.
// =====================================================================

import { AI_ENDPOINT } from './config.js';
import {
  estimateBody, recommendSize, evaluateSize,
  REGION_LABELS, FIT_BADGE_KO,
} from '../fit-engine.js';

// 태스크 식별자 — app.js 와 server/index.mjs 가 공유한다.
export const AI_TASKS = Object.freeze({
  CHAT:    'style-chat',    // (1) AI 스타일·핏 상담 챗봇
  EXPLAIN: 'fit-explain',   // (2) 핏 결과 자연어 설명
  CODI:    'outfit-coordi', // (3) 상황별 코디 추천
  DIGEST:  'style-digest',  // (4) 체형 맞춤 추천 착장 Top 3 (자동 생성)
});

// 카테고리 한글 라벨(로컬 표기).
const CATEGORY_KO = { top: '상의', bottom: '하의', outer: '아우터', dress: '원피스' };
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------
/**
 * 통합 AI 호출.
 * @param {string} task AI_TASKS 중 하나
 * @param {object} payload { profile, garments, message?, situation?, garment?, size? }
 * @param {{onToken?:(chunk:string)=>void}} opts 토큰 스트림 콜백(선택)
 * @returns {Promise<string>} 전체 응답 텍스트
 */
export async function askAI(task, payload = {}, { onToken } = {}) {
  // ── 데모 경로: 내장 MockProvider (결정론적) ──────────────────────────
  if (!AI_ENDPOINT) {
    return runMock(task, payload, onToken);
  }

  // ── 실서비스 경로: 백엔드 프록시로 POST 후 스트림 수신 ───────────────
  // 무인(無人) 원칙: 프록시 실패/429{fallback:true}/네트워크 오류 시
  // 내장 mock 으로 자동 폴백하여 앱이 절대 멈추지 않는다.
  let streamed = false;
  let full = '';
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, payload }),
    });

    // 429: 예산/레이트리밋 초과 → mock 폴백(무인).
    if (res.status === 429) return runMock(task, payload, onToken);
    if (!res.ok) throw new Error(`AI 요청 실패: HTTP ${res.status}`);

    if (!res.body || typeof res.body.getReader !== 'function') {
      // 스트림 미지원 환경 폴백: 전체 텍스트 한 번에.
      full = await res.text();
      if (onToken) onToken(full);
      return full;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      full += chunk;
      streamed = true;
      if (onToken) onToken(chunk);
    }
    return full;
  } catch (err) {
    // 이미 일부 토큰을 스트리밍했다면 중복 방지를 위해 받은 만큼만 반환.
    if (streamed) return full;
    // 아직 아무것도 못 받았으면 mock 으로 자동 폴백.
    return runMock(task, payload, onToken);
  }
}

/** 내장 mock 실행 + (선택) 스트리밍 UX. */
async function runMock(task, payload, onToken) {
  const text = mockProvider(task, payload);
  if (onToken) await streamString(text, onToken);
  return text;
}

/** 문자열을 작은 조각으로 흘려보내 스트리밍 UX 를 흉내낸다(데모 전용). */
async function streamString(text, onToken) {
  const STEP = 3;
  for (let i = 0; i < text.length; i += STEP) {
    onToken(text.slice(i, i + STEP));
    await new Promise((r) => setTimeout(r, 9));
  }
}

// ---------------------------------------------------------------------------
// MockProvider — 결정론적 한글 생성 (fit-engine + 카탈로그 재사용)
// ---------------------------------------------------------------------------
function mockProvider(task, payload) {
  switch (task) {
    case AI_TASKS.CHAT:    return mockChat(payload);
    case AI_TASKS.EXPLAIN: return mockExplain(payload);
    case AI_TASKS.CODI:    return mockCodi(payload);
    case AI_TASKS.DIGEST:  return mockDigest(payload);
    default:               return `지원하지 않는 AI 요청입니다: ${String(task)}`;
  }
}

/** 프로파일 한 줄 요약. */
function profileLine(profile) {
  const b = estimateBody(profile);
  const g = { men: '남성', women: '여성', unisex: '성별 미지정' }[profile.gender] || '성별 미지정';
  const t = { slim: '마른형', standard: '표준형', athletic: '운동형', curvy: '굴곡형', plus: '통통형' }[profile.bodyType] || '표준형';
  return `키 ${b.height}cm · 몸무게 ${b.weight}kg · ${g} · ${t} (추정 가슴 ${b.chest} / 허리 ${b.waist} / 엉덩이 ${b.hip}cm)`;
}

/** 대표 부위 여유를 근거 문장으로. */
function reasonFor(ev) {
  const d = ev.detail[ev.primaryRegion];
  if (!d) return `전체 핏 ${ev.badgeKo}`;
  const dir = d.ease >= 0 ? `+${d.ease}` : `${d.ease}`;
  return `${d.label} 여유 ${dir}cm(${FIT_BADGE_KO[d.fit]})`;
}

// 메시지에서 카테고리/서브타입 힌트 추출.
const CAT_KEYWORDS = [
  ['bottom', ['하의', '바지', '팬츠', '청바지', '데님', '슬랙스', '치노', '조거', '레깅스', '반바지', '스커트', '카고']],
  ['outer',  ['아우터', '자켓', '재킷', '코트', '패딩', '가디건', '블레이저', '점퍼', '바람막이', '베스트']],
  ['dress',  ['원피스', '드레스']],
  ['top',    ['상의', '티셔츠', '티', '셔츠', '니트', '후드', '맨투맨', '블라우스', '폴로', '스웨트']],
];

function detectCategory(msg) {
  const m = String(msg || '');
  for (const [cat, kws] of CAT_KEYWORDS) if (kws.some((k) => m.includes(k))) return cat;
  return '';
}

// 핏 성향 힌트: "넉넉/오버핏" vs "타이트/슬림".
function detectFitPref(msg) {
  const m = String(msg || '');
  if (/(넉넉|루즈|오버|박시|여유)/.test(m)) return 'loose';
  if (/(타이트|슬림|딱|꽉)/.test(m)) return 'tight';
  return '';
}

/** garment 배열에서 프로파일 기준 최적 사이즈/핏을 계산해 순위화. */
function rankByFit(profile, garments) {
  return garments
    .map((g) => ({ g, r: recommendSize(profile, g) }))
    .filter((x) => x.r && x.r.best)
    .sort((a, b) => (b.r.best.score - a.r.best.score) || (a.g.price - b.g.price));
}

// ── (1) 스타일·핏 상담 챗봇 ────────────────────────────────────────────
function mockChat(payload) {
  const { profile, message = '', garments = [] } = payload;
  if (!profile || !garments.length) return '신체정보와 카탈로그 데이터가 필요합니다.';

  const cat = detectCategory(message);
  const fitPref = detectFitPref(message);
  let pool = cat ? garments.filter((g) => g.category === cat) : garments.slice();
  if (!pool.length) pool = garments.slice();

  let ranked = rankByFit(profile, pool);
  // 핏 성향이 있으면 대표 부위가 그 성향에 가까운 상품을 우선.
  if (fitPref) {
    const match = ranked.filter((x) => x.r.best.badge === fitPref);
    if (match.length) ranked = match.concat(ranked.filter((x) => x.r.best.badge !== fitPref));
  }
  const top = ranked.slice(0, 3);

  const head = cat
    ? `${profileLine(profile)} 기준으로 '${CATEGORY_KO[cat]}' 카테고리를 살펴봤어요.`
    : `${profileLine(profile)} 기준으로 카탈로그 전체에서 잘 맞는 상품을 골랐어요.`;

  const lines = top.map((x, i) => {
    const { g, r } = x;
    const ev = r.best;
    return `${i + 1}) ${g.name} · ${g.brand} (${CATEGORY_KO[g.category]}, ${won(g.price)})\n`
      + `   → 추천 ${r.recommended} · ${ev.badgeKo} (핏 점수 ${ev.score}/100) · ${reasonFor(ev)}`;
  });

  // 대표 상품의 보조 부위 코멘트 하나.
  let tip = '';
  if (top[0]) {
    const ev = top[0].r.best;
    const off = Object.values(ev.detail).find((d) => d.fit !== 'good');
    if (off) {
      const move = off.fit === 'tight' ? '한 치수 올리는 것' : '한 치수 내리는 것';
      tip = `\n\n팁: '${top[0].g.name}' 은(는) ${off.label}이(가) ${FIT_BADGE_KO[off.fit]}이라, 더 딱 맞게 입으려면 ${move}도 고려해 보세요.`;
    } else {
      tip = `\n\n팁: '${top[0].g.name}' 은(는) 부위별 여유가 모두 권장 범위 안이라 사이즈 실패 확률이 낮아요.`;
    }
  }

  const pref = fitPref ? `\n(요청하신 '${fitPref === 'loose' ? '넉넉한' : '타이트한'}' 핏을 우선 반영했어요.)` : '';
  return `${head}${pref}\n\n${lines.join('\n\n')}${tip}\n\n더 좁혀드릴까요? 예: "출근용", "넉넉한 하의", "데이트룩" 처럼 상황·핏을 알려주세요.`;
}

// ── (4) 체형 맞춤 추천 착장 Top 3 (자동 생성) ──────────────────────────
// 신체정보 로드 시 fit-engine 으로 카탈로그 전체를 채점해 상위 3개를 요약한다.
// 카테고리 다양성을 살짝 반영하되(같은 카테고리 최대 2개), 핏 점수를 우선한다.
function mockDigest(payload) {
  const { profile, garments = [] } = payload;
  if (!profile || !garments.length) return '신체정보를 입력하면 체형 맞춤 추천을 보여드려요.';

  const ranked = rankByFit(profile, garments);
  if (!ranked.length) return '추천할 상품을 찾지 못했어요. 신체정보를 확인해 주세요.';

  // 카테고리 편중 방지: 동일 카테고리는 최대 2개까지.
  const catCount = {};
  const picks = [];
  for (const x of ranked) {
    const c = x.g.category;
    if ((catCount[c] || 0) >= 2) continue;
    catCount[c] = (catCount[c] || 0) + 1;
    picks.push(x);
    if (picks.length >= 3) break;
  }
  while (picks.length < 3 && ranked[picks.length]) picks.push(ranked[picks.length]);

  const lines = picks.map((x, i) => {
    const { g, r } = x;
    const ev = r.best;
    return `${i + 1}) ${g.name} · ${g.brand} (${CATEGORY_KO[g.category]}) — 추천 ${r.recommended} · ${ev.badgeKo} (핏 ${ev.score}/100) · ${reasonFor(ev)} · ${won(g.price)}`;
  });

  return `${profileLine(profile)} 기준, 지금 체형에 가장 잘 맞는 착장 Top 3 예요.\n\n${lines.join('\n')}\n\n`
    + '카탈로그에서 마음에 드는 상품을 눌러 상세 핏과 사이즈표를 확인해 보세요.';
}

// ── (2) 핏 결과 자연어 설명 ────────────────────────────────────────────
function mockExplain(payload) {
  const { profile, garment, size } = payload;
  if (!profile || !garment) return '설명할 상품과 신체정보가 필요합니다.';

  const body = estimateBody(profile);
  const r = recommendSize(body, garment);
  const targetSize = size || r.recommended || Object.keys(garment.sizes)[0];
  const ev = evaluateSize(body, garment, targetSize);

  const isRec = targetSize === r.recommended;
  const opening = isRec
    ? `${garment.name}(${garment.brand})은(는) 지금 신체정보에 추천 사이즈 ${targetSize} 입니다.`
    : `${garment.name}(${garment.brand}) ${targetSize} 사이즈를 살펴봤어요. (참고로 추천 사이즈는 ${r.recommended} 입니다.)`;

  const parts = Object.values(ev.detail).map((d) => {
    const dir = d.ease >= 0 ? `+${d.ease}` : `${d.ease}`;
    const nuance = d.fit === 'good'
      ? '권장 여유 범위 안이라 편안합니다'
      : d.fit === 'tight'
        ? `권장보다 ${d.deviation}cm 부족해 다소 조입니다`
        : `권장보다 ${d.deviation}cm 남아 넉넉합니다`;
    return `· ${d.label}: 여유 ${dir}cm — ${nuance}`;
  });

  const overall = `전체 핏은 '${ev.badgeKo}'(대표 부위 ${REGION_LABELS[ev.primaryRegion] || ev.primaryRegion} 기준), 핏 점수는 ${ev.score}/100 입니다.`;
  const advice = ev.badge === 'good'
    ? '이 사이즈면 무난하게 잘 맞습니다.'
    : ev.badge === 'tight'
      ? '조이는 느낌이 싫다면 한 치수 올리는 걸 권합니다.'
      : '헐렁한 느낌이 싫다면 한 치수 내리는 걸 권합니다.';

  return `${opening}\n\n${overall}\n\n부위별 상세:\n${parts.join('\n')}\n\n${advice}\n`
    + `(여유 = 의류 실측 − 내 추정 치수. 규칙 기반 근사이며 실제 착용감과 다를 수 있습니다.)`;
}

// ── (3) 상황별 코디 추천 ───────────────────────────────────────────────
const SITUATIONS = [
  { id: 'office',  label: '출근·오피스', top: ['셔츠', '블라우스', '니트', '폴로'], bottom: ['슬랙스', '치노', '스커트'], outer: ['블레이저', '코트'], dress: false },
  { id: 'date',    label: '데이트',       top: ['니트', '블라우스', '셔츠'],         bottom: ['슬랙스', '스커트', '청바지'], outer: ['가디건', '자켓', '코트'], dress: true },
  { id: 'active',  label: '운동·액티브', top: ['맨투맨', '반팔 티셔츠', '긴팔'],    bottom: ['레깅스', '조거', '반바지'], outer: ['바람막이', '베스트'], dress: false },
  { id: 'weekend', label: '주말·캐주얼', top: ['후드', '맨투맨', '반팔 티셔츠', '긴팔'], bottom: ['청바지', '조거', '카고', '반바지'], outer: ['자켓', '바람막이', '베스트'], dress: false },
  { id: 'formal',  label: '격식·포멀',   top: ['셔츠', '블라우스'],                 bottom: ['슬랙스'], outer: ['블레이저', '코트'], dress: true },
];

export function situationList() {
  return SITUATIONS.map((s) => ({ id: s.id, label: s.label }));
}

function matchSubtype(g, wants) {
  return wants.some((w) => (g.subtype || '').includes(w) || (g.name || '').includes(w));
}

/** 후보 중 서브타입이 맞고 핏 점수가 가장 높은 상품 하나. */
function pickBest(profile, garments, category, wants) {
  let pool = garments.filter((g) => g.category === category && matchSubtype(g, wants));
  if (!pool.length) pool = garments.filter((g) => g.category === category);
  if (!pool.length) return null;
  return rankByFit(profile, pool)[0] || null;
}

function pieceLine(x) {
  const { g, r } = x;
  const ev = r.best;
  return `· ${CATEGORY_KO[g.category]}: ${g.name} (${g.brand}) — 추천 ${r.recommended} · ${ev.badgeKo} (핏 ${ev.score}) · ${won(g.price)}`;
}

function mockCodi(payload) {
  const { profile, situation, garments = [] } = payload;
  if (!profile || !garments.length) return '신체정보와 카탈로그 데이터가 필요합니다.';
  const sit = SITUATIONS.find((s) => s.id === situation) || SITUATIONS[0];

  const pieces = [];
  // 여성·데이트/포멀이면 원피스 단독 코디도 후보로.
  let dressPick = null;
  if (sit.dress) {
    const dressPool = garments.filter((g) => g.category === 'dress');
    if (dressPool.length) dressPick = rankByFit(profile, dressPool)[0] || null;
  }

  const topPick = pickBest(profile, garments, 'top', sit.top);
  const botPick = pickBest(profile, garments, 'bottom', sit.bottom);
  const outerPick = sit.outer ? pickBest(profile, garments, 'outer', sit.outer) : null;

  let total = 0;
  const useDress = dressPick && (!topPick || dressPick.r.best.score >= topPick.r.best.score);

  if (useDress) {
    pieces.push(pieceLine(dressPick)); total += dressPick.g.price;
    if (outerPick) { pieces.push(pieceLine(outerPick)); total += outerPick.g.price; }
  } else {
    if (topPick) { pieces.push(pieceLine(topPick)); total += topPick.g.price; }
    if (botPick) { pieces.push(pieceLine(botPick)); total += botPick.g.price; }
    if (outerPick) { pieces.push(pieceLine(outerPick)); total += outerPick.g.price; }
  }

  if (!pieces.length) return `'${sit.label}' 에 맞는 상품을 찾지 못했어요.`;

  const alt = useDress && topPick
    ? `\n\n대안(세퍼레이트): ${topPick.g.name} + ${botPick ? botPick.g.name : '하의'} 조합도 잘 어울려요.`
    : '';

  return `'${sit.label}' 상황 추천 코디예요.\n${profileLine(profile)}\n\n${pieces.join('\n')}\n\n예상 합계: ${won(total)}`
    + `\n각 아이템은 지금 신체정보 기준 추천 사이즈와 핏 점수로 골랐습니다.${alt}`;
}

// 기본 내보내기(편의).
export default { AI_TASKS, askAI, situationList };
