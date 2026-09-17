// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// server/index.mjs — 가상 피팅 AI 백엔드 프록시 (Anthropic Claude)
// =====================================================================
// 브라우저는 절대 Claude 키를 갖지 않는다. 프론트(ai/ai.js)는 이 서버의
// POST /api/ai 로 {task, payload} 만 보내고, 서버가 유일하게 키를 쥔 채
// Claude 를 호출해 텍스트를 스트리밍으로 되돌려준다.
//
//   - 모델: claude-opus-5, 적응형 사고(thinking: adaptive), 스트리밍
//   - 키: process.env.ANTHROPIC_API_KEY (하드코딩 금지 — .env 참고)
//   - 그라운딩: fit-engine.js 로 추천/여유를 실제 계산해 프롬프트에 주입
//     (실 데이터 집계 → LLM grounded)
//
// 실행: `npm start` (server/ 에서). 사전에 `npm install` 필요.
// =====================================================================

import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { estimateBody, recommendSize, evaluateSize, REGION_LABELS, FIT_BADGE_KO } from '../fit-engine.js';

const PORT = Number(process.env.PORT) || 8787;
const MODEL = 'claude-opus-5';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY 가 설정되지 않았습니다. server/.env 를 확인하세요.');
}

// 키는 SDK 가 process.env.ANTHROPIC_API_KEY 에서 읽는다. 절대 하드코딩 금지.
const client = new Anthropic();

const CATEGORY_KO = { top: '상의', bottom: '하의', outer: '아우터', dress: '원피스' };

// ---------------------------------------------------------------------------
// 태스크별 시스템 프롬프트
// ---------------------------------------------------------------------------
const BASE_SYSTEM = [
  '당신은 "가상 피팅 룸"의 한국어 스타일리스트 AI 입니다.',
  '규칙 기반 fit-engine 이 계산한 추천 사이즈·부위별 여유(ease)·핏 점수를 근거(grounding)로만 사용해',
  '정확하고 신뢰할 수 있는 조언을 제공합니다. 근거에 없는 수치를 지어내지 마세요.',
  '항상 한국어로, 간결하고 실용적으로 답합니다. 브랜드/가격/사이즈는 제공된 데이터만 인용합니다.',
].join(' ');

const TASK_SYSTEM = {
  'style-chat':    BASE_SYSTEM + ' 사용자의 신체정보와 요청에 맞춰 상품과 사이즈를 추천하세요.',
  'fit-explain':   BASE_SYSTEM + ' 추천 사이즈와 부위별 여유를 자연스러운 문장으로 설명하세요.',
  'outfit-coordi': BASE_SYSTEM + ' 상황에 맞는 상·하의(또는 원피스)+아우터 코디를 제안하세요.',
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

  const pool = (garments || []).slice(0, 40).map((g) => groundGarment(body, g)).join('\n');
  return `${bodyLine}\n카탈로그 핏 계산:\n${pool}`;
}

function buildUserPrompt(task, payload) {
  const grounding = buildGrounding(task, payload);
  const { message, situation } = payload || {};
  let ask = '';
  if (task === 'style-chat') ask = `사용자 요청: ${message || '나에게 잘 맞는 옷을 추천해줘'}`;
  else if (task === 'fit-explain') ask = '위 대상 상품의 핏을 자연어로 설명해줘.';
  else if (task === 'outfit-coordi') ask = `상황: ${situation || '주말·캐주얼'} 에 맞는 코디를 제안해줘.`;
  return `${ask}\n\n[근거 데이터]\n${grounding}`;
}

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: MODEL }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/ai') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let task, payload;
  try {
    const parsed = JSON.parse(await readBody(req));
    task = parsed.task;
    payload = parsed.payload || {};
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '잘못된 요청 본문(JSON)입니다.' }));
    return;
  }

  const system = TASK_SYSTEM[task];
  if (!system) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `지원하지 않는 task: ${task}` }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });

  try {
    const messages = [{ role: 'user', content: buildUserPrompt(task, payload) }];
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system,
      messages,
    });
    stream.on('text', (text) => res.write(text));
    await stream.finalMessage(); // 완결 대기(스트림 helper).
    res.end();
  } catch (err) {
    console.error('[ai] Claude 호출 실패:', err && err.message ? err.message : err);
    if (!res.writableEnded) res.end('\n[오류] AI 응답 생성에 실패했습니다.');
  }
});

server.listen(PORT, () => {
  console.log(`가상 피팅 AI 프록시 실행: http://localhost:${PORT}  (POST /api/ai, model=${MODEL})`);
});
