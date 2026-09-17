// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// server/prompts.mjs — 태스크 라우팅 · 그라운딩 · Anthropic 요청 본문 빌더 (공용)
// =====================================================================
// index.mjs(Node SDK 프록시)와 worker.js(Cloudflare REST)가 "동일한 태스크
// 라우팅 · 모델/캐싱 규칙"을 공유하도록 이 모듈로 분리한다.
//   - buildUserPrompt: fit-engine 으로 실제 계산한 근거(grounding)를 프롬프트에 주입
//   - buildAnthropicBody: 모델/프롬프트캐싱/thinking·effort 규칙을 한 곳에서 결정
// process.env 를 직접 읽지 않는다(Worker 이식성). effort 는 인자로 받는다.
// =====================================================================

import { estimateBody, recommendSize, evaluateSize, FIT_BADGE_KO } from '../fit-engine.js';

export const CATEGORY_KO = { top: '상의', bottom: '하의', outer: '아우터', dress: '원피스' };

// 안정적인(캐시 가능한) 공통 시스템 프롬프트.
const BASE_SYSTEM = [
  '당신은 "가상 피팅 룸"의 한국어 스타일리스트 AI 입니다.',
  '규칙 기반 fit-engine 이 계산한 추천 사이즈·부위별 여유(ease)·핏 점수를 근거(grounding)로만 사용해',
  '정확하고 신뢰할 수 있는 조언을 제공합니다. 근거에 없는 수치를 지어내지 마세요.',
  '항상 한국어로, 간결하고 실용적으로 답합니다. 브랜드/가격/사이즈는 제공된 데이터만 인용합니다.',
].join(' ');

// 태스크별 시스템 프롬프트 (task 식별자는 ai/ai.js 와 공유).
export const TASK_SYSTEM = {
  'style-chat':    BASE_SYSTEM + ' 사용자의 신체정보와 요청에 맞춰 상품과 사이즈를 추천하세요.',
  'fit-explain':   BASE_SYSTEM + ' 추천 사이즈와 부위별 여유를 자연스러운 문장으로 설명하세요.',
  'outfit-coordi': BASE_SYSTEM + ' 상황에 맞는 상·하의(또는 원피스)+아우터 코디를 제안하세요.',
  'style-digest':  BASE_SYSTEM + ' 신체정보만으로 자동 생성하는 "내 체형 맞춤 추천 착장 Top 3" 요약을 만드세요.'
    + ' 핏 점수가 높은 상위 3개를 한 줄씩, 아이템·추천사이즈·핏·핵심 이유만 아주 간결하게 제시하세요.',
};

// 태스크별 출력 상한(비용 절감). 기본 700, 필요한 태스크만 소폭 상향.
export const TASK_MAX_TOKENS = {
  'style-chat': 700,
  'fit-explain': 600,
  'outfit-coordi': 800,
  'style-digest': 500,
};

// ---------------------------------------------------------------------------
// 그라운딩: fit-engine 으로 실제 계산해 텍스트 근거를 만든다.
// ---------------------------------------------------------------------------
function groundGarment(profile, g) {
  const r = recommendSize(profile, g);
  const ev = r.best;
  if (!ev) return `- ${g.name}(${g.brand}, ${CATEGORY_KO[g.category]}): 사이즈 정보 없음`;
  const regions = Object.values(ev.detail)
    .map((d) => `${d.label} ${d.ease >= 0 ? '+' : ''}${d.ease}cm(${FIT_BADGE_KO[d.fit]})`)
    .join(', ');
  return `- ${g.name}(${g.brand}, ${CATEGORY_KO[g.category]}, ${g.price}원): 추천 ${r.recommended}, 전체 ${ev.badgeKo}, 핏점수 ${ev.score}/100, [${regions}]`;
}

function buildGrounding(task, payload) {
  const { profile, garments = [], garment, size } = payload || {};
  if (!profile) return '신체정보 없음.';
  const body = estimateBody(profile);
  const bodyLine = `신체 추정: 가슴 ${body.chest}, 허리 ${body.waist}, 엉덩이 ${body.hip}, 어깨 ${body.shoulder}, 허벅지 ${body.thigh}cm, BMI ${body.bmi}.`;

  if (task === 'fit-explain' && garment) {
    const r = recommendSize(body, garment);
    const target = size || r.recommended;
    const ev = evaluateSize(body, garment, target);
    const regions = Object.values(ev.detail)
      .map((d) => `${d.label}: 여유 ${d.ease}cm, 권장 ${JSON.stringify(d.band)}, 판정 ${FIT_BADGE_KO[d.fit]}`)
      .join('; ');
    return `${bodyLine}\n대상: ${garment.name}(${garment.brand}) 사이즈 ${target}. 추천 사이즈 ${r.recommended}, 전체 ${ev.badgeKo}, 핏점수 ${ev.score}. 부위별 — ${regions}.`;
  }

  // style-digest 는 핏 점수 상위 근거를 우선 노출한다.
  let pool = (garments || []).slice();
  if (task === 'style-digest') {
    pool = pool
      .map((g) => ({ g, r: recommendSize(body, g) }))
      .filter((x) => x.r && x.r.best)
      .sort((a, b) => (b.r.best.score - a.r.best.score) || (a.g.price - b.g.price))
      .slice(0, 8)
      .map((x) => x.g);
  } else {
    pool = pool.slice(0, 40);
  }
  const lines = pool.map((g) => groundGarment(body, g)).join('\n');
  return `${bodyLine}\n카탈로그 핏 계산:\n${lines}`;
}

export function buildUserPrompt(task, payload) {
  const grounding = buildGrounding(task, payload);
  const { message, situation } = payload || {};
  let ask = '';
  if (task === 'style-chat') ask = `사용자 요청: ${message || '나에게 잘 맞는 옷을 추천해줘'}`;
  else if (task === 'fit-explain') ask = '위 대상 상품의 핏을 자연어로 설명해줘.';
  else if (task === 'outfit-coordi') ask = `상황: ${situation || '주말·캐주얼'} 에 맞는 코디를 제안해줘.`;
  else if (task === 'style-digest') ask = '내 체형에 가장 잘 맞는 착장 Top 3 를 간결하게(각 한 줄) 추천해줘.';
  return `${ask}\n\n[근거 데이터]\n${grounding}`;
}

// ---------------------------------------------------------------------------
// Anthropic 요청 본문 빌더 — 모델/프롬프트캐싱/thinking·effort 규칙을 한 곳에.
// SDK(client.messages.stream)와 REST(POST /v1/messages) 가 동일한 본문을 쓴다.
// ---------------------------------------------------------------------------
export function buildAnthropicBody({ model, system, messages, maxTokens = 700, effort = 'low' }) {
  const body = {
    model,
    max_tokens: maxTokens,
    // 프롬프트 캐싱: 안정적인 시스템 블록에 cache_control 을 달아 반복 호출 비용을 낮춘다.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  // Haiku 4.5 는 adaptive thinking / effort 를 받지 않는다(400 방지) → 미전송.
  if (!String(model).startsWith('claude-haiku')) {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort };
  }
  return body;
}
