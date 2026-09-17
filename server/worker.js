// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// server/worker.js — Cloudflare Workers 변형 (무인 · 무료 호스팅)
// =====================================================================
// index.mjs 와 "동일한 태스크 라우팅 · 모델/캐싱 규칙"을 쓰되, SDK 대신
// Anthropic REST(POST /v1/messages)를 직접 호출한다. Workers 무료 티어에서
// 관리 서버 없이 상시 동작한다(무인). 키는 Worker 시크릿에만 존재한다:
//   wrangler secret put ANTHROPIC_API_KEY
//
// 응답: Claude 응답 텍스트를 SSE 로 릴레이(스트리밍)한다. 비스트림도 가능.
// 비용 가드레일: IP당 분당 레이트리밋 + 월 토큰 예산(인메모리, 아이솔레이트
//   범위). 강한 보장이 필요하면 KV/Durable Objects 로 승격하라. 초과 시
//   429 {fallback:true} → 프론트가 mock 으로 자동 폴백.
// =====================================================================

import { TASK_SYSTEM, TASK_MAX_TOKENS, buildUserPrompt, buildAnthropicBody } from './prompts.mjs';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// 인메모리 가드레일(아이솔레이트 범위). 강한 보장은 KV/Durable Objects 사용.
const hits = new Map();
let budget = { month: monthKey(), tokens: 0 };
function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; }
function rateLimited(ip, perMin) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => t > now - 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > perMin;
}
function budgetExceeded(cap) {
  const m = monthKey();
  if (m !== budget.month) budget = { month: m, tokens: 0 };
  return budget.tokens >= cap;
}
function addUsage(u) {
  if (!u) return;
  budget.tokens += (u.input_tokens || 0) + (u.output_tokens || 0)
    + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.CORS_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
}

function json(status, obj, env) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(200, { ok: true, model: (env && env.AI_MODEL) || 'claude-haiku-4-5' }, env);
    }
    if (request.method !== 'POST' || url.pathname !== '/api/ai') {
      return json(404, { error: 'not found' }, env);
    }

    const model = (env && env.AI_MODEL) || 'claude-haiku-4-5';
    const effort = (env && env.AI_EFFORT) || 'low';
    const perMin = Number(env && env.AI_RATE_LIMIT_PER_MIN) || 20;
    const cap = Number(env && env.AI_MONTHLY_TOKEN_CAP) || 2_000_000;

    // 비용 가드레일 → 초과 시 429 {fallback:true} (프론트 자동 폴백, 무인).
    const ip = request.headers.get('cf-connecting-ip')
      || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip, perMin)) return json(429, { fallback: true }, env);
    if (budgetExceeded(cap)) return json(429, { fallback: true }, env);

    let task, payload;
    try {
      const parsed = await request.json();
      task = parsed.task; payload = parsed.payload || {};
    } catch {
      return json(400, { error: '잘못된 요청 본문(JSON)입니다.' }, env);
    }

    const system = TASK_SYSTEM[task];
    if (!system) return json(400, { error: `지원하지 않는 task: ${task}` }, env);
    if (!env || !env.ANTHROPIC_API_KEY) return json(500, { error: 'ANTHROPIC_API_KEY 시크릿 미설정' }, env);

    const body = buildAnthropicBody({
      model,
      system,
      messages: [{ role: 'user', content: buildUserPrompt(task, payload) }],
      maxTokens: TASK_MAX_TOKENS[task] || 700,
      effort,
    });
    body.stream = true; // SSE 로 받아 텍스트만 릴레이

    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      // 업스트림 실패 → 프론트가 mock 으로 폴백하도록 429 {fallback:true}.
      return json(429, { fallback: true }, env);
    }

    // Anthropic SSE 를 파싱해 텍스트 델타만 평문으로 릴레이한다.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') { controller.close(); return; }
            try {
              const evt = JSON.parse(data);
              if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                controller.enqueue(encoder.encode(evt.delta.text));
              } else if (evt.type === 'message_delta' && evt.usage) {
                addUsage(evt.usage);
              } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
                addUsage(evt.message.usage);
              }
            } catch { /* keep-alive/기타 라인 무시 */ }
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...cors },
    });
  },
};
