// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// server/index.mjs — 가상 피팅 AI 백엔드 프록시 (Anthropic Claude)
// =====================================================================
// 브라우저는 절대 Claude 키를 갖지 않는다. 프론트(ai/ai.js)는 이 서버의
// POST /api/ai 로 {task, payload} 만 보내고, 서버가 유일하게 키를 쥔 채
// Claude 를 호출해 텍스트를 스트리밍으로 되돌려준다.
//
// 무인 · 저비용 실 AI 원칙
//   - 모델: 비용 우선 기본값 claude-haiku-4-5 (AI_MODEL 로 상향 가능:
//           claude-sonnet-5 / claude-opus-5 → 더 높은 품질, 더 높은 비용)
//   - 프롬프트 캐싱: 안정적인 시스템 프롬프트를 cache_control:ephemeral 로 전송
//   - 출력 상한: 태스크별 modest max_tokens (~700)
//   - 비용 가드레일: IP당 분당 레이트리밋 + 월 토큰 예산 초과 시 429 {fallback:true}
//   - thinking/effort: Haiku 계열엔 미전송(400 방지), 그 외엔 adaptive + effort
//   - 키: process.env.ANTHROPIC_API_KEY 만 사용(하드코딩 금지 — .env 참고)
//   - 그라운딩: server/prompts.mjs 가 fit-engine.js 로 추천/여유를 실제 계산해 주입
//
// 실행: `npm start` (server/ 에서). 사전에 `npm install` 필요.
// =====================================================================

import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import {
  TASK_SYSTEM, TASK_MAX_TOKENS, buildUserPrompt, buildAnthropicBody,
} from './prompts.mjs';

const PORT = Number(process.env.PORT) || 8787;
// 비용 우선 기본값. AI_MODEL=claude-sonnet-5 또는 claude-opus-5 로 품질을 높일 수 있다.
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const AI_EFFORT = process.env.AI_EFFORT || 'low';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// 비용 가드레일 설정 ---------------------------------------------------------
const RATE_LIMIT_PER_MIN = Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20; // IP당 분당 요청 수
const MONTHLY_TOKEN_CAP = Number(process.env.AI_MONTHLY_TOKEN_CAP) || 2_000_000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY 가 설정되지 않았습니다. server/.env 를 확인하세요.');
}

// 키는 SDK 가 process.env.ANTHROPIC_API_KEY 에서 읽는다. 절대 하드코딩 금지.
const client = new Anthropic();

// ---------------------------------------------------------------------------
// 비용 가드레일: 인메모리 레이트리밋 + 월 토큰 예산
// ---------------------------------------------------------------------------
const hits = new Map(); // ip -> number[] (최근 요청 타임스탬프)
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_MIN;
}

let budget = { month: currentMonth(), tokens: 0 };
function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}
function budgetExceeded() {
  const m = currentMonth();
  if (m !== budget.month) budget = { month: m, tokens: 0 }; // 월 경계에서 리셋
  return budget.tokens >= MONTHLY_TOKEN_CAP;
}
function addUsage(usage) {
  if (!usage) return;
  const used = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  budget.tokens += used;
}

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function send429Fallback(res) {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ fallback: true }));
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: MODEL, monthTokens: budget.tokens, cap: MONTHLY_TOKEN_CAP }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/ai') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // 비용 가드레일: 초과 시 429 {fallback:true} → 프론트가 mock 으로 자동 폴백(무인).
  if (rateLimited(clientIp(req))) { send429Fallback(res); return; }
  if (budgetExceeded()) { send429Fallback(res); return; }

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
    const stream = client.messages.stream(buildAnthropicBody({
      model: MODEL,
      system,
      messages,
      maxTokens: TASK_MAX_TOKENS[task] || 700,
      effort: AI_EFFORT,
    }));
    stream.on('text', (text) => res.write(text));
    const finalMessage = await stream.finalMessage(); // 완결 대기(스트림 helper).
    addUsage(finalMessage && finalMessage.usage);     // 월 예산에 실제 토큰 사용량 누적
    res.end();
  } catch (err) {
    console.error('[ai] Claude 호출 실패:', err && err.message ? err.message : err);
    if (!res.writableEnded) res.end('\n[오류] AI 응답 생성에 실패했습니다.');
  }
});

server.listen(PORT, () => {
  console.log(`가상 피팅 AI 프록시 실행: http://localhost:${PORT}  (POST /api/ai, model=${MODEL})`);
});
