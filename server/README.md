<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국) -->

# 가상 피팅 AI 백엔드 프록시

프론트엔드(브라우저)가 **절대 Claude API 키를 갖지 않도록** 하는 얇은 서버 프록시입니다.
브라우저는 이 서버의 `POST /api/ai` 로 `{task, payload}` 만 보내고, 서버가 유일하게 키를 쥔 채
Anthropic Claude 를 호출하여 텍스트를 **스트리밍**으로 되돌려줍니다.

> **API 키는 서버 전용입니다. 브라우저나 저장소에 절대 넣지 마세요.**

두 가지 배포 방식이 있습니다.
- **Node 프록시**(`index.mjs`) — 직접 호스팅.
- **Cloudflare Workers**(`worker.js`) — 무료 티어, 관리 서버 없이 상시 동작(무인).

## 동작 개요 (무인 · 저비용)

- 모델: **비용 우선 기본값 `claude-haiku-4-5`** — `AI_MODEL` 로 `claude-sonnet-5`,
  `claude-opus-5` 로 상향하면 품질↑·비용↑.
- **프롬프트 캐싱**: 안정적인 시스템 프롬프트를 `cache_control: { type: "ephemeral" }` 로 전송해
  반복 호출 비용을 낮춥니다.
- **출력 상한**: 태스크별 modest `max_tokens`(~700).
- **비용 가드레일**: IP당 분당 레이트리밋(`AI_RATE_LIMIT_PER_MIN`, 기본 20) + 월 토큰 예산
  (`AI_MONTHLY_TOKEN_CAP`, 기본 2,000,000). 초과 시 `429 {"fallback":true}` → 프론트가 mock 으로 자동 폴백.
- **thinking/effort**: Haiku 계열엔 미전송(400 방지). 그 외 모델엔 `thinking:{type:"adaptive"}`
  + `output_config:{effort: AI_EFFORT}`(기본 `low`).
- 키: `process.env.ANTHROPIC_API_KEY` (하드코딩 금지)
- 그라운딩: 요청이 오면 서버가 `../fit-engine.js` 로 추천 사이즈·부위별 여유·핏 점수를
  **실제로 계산**해 프롬프트에 근거로 주입합니다(실 데이터 집계 → LLM grounded). 라우팅/그라운딩/
  요청본문 규칙은 `prompts.mjs` 에 공용화되어 Node 프록시와 Worker 가 동일하게 사용합니다.
- 지원 task: `style-chat`(상담 챗봇), `fit-explain`(핏 설명), `outfit-coordi`(코디 추천),
  `style-digest`(체형 맞춤 추천 착장 Top 3 자동 요약)

## 설치 및 실행 (Node 프록시)

```bash
cd server
cp .env.example .env      # ANTHROPIC_API_KEY 를 실제 키로 채우기
npm install               # @anthropic-ai/sdk 설치
npm start                 # http://localhost:8787 에서 실행
```

## 무료 배포 (Cloudflare Workers · 무인)

관리할 서버가 없습니다. 무료 티어로 배포하고 키는 시크릿으로만 둡니다.

```bash
cd server
npm i -g wrangler         # 최초 1회
wrangler login
wrangler secret put ANTHROPIC_API_KEY   # 키를 시크릿으로 주입(저장소·코드에 남지 않음)
wrangler deploy           # worker.js 배포 → https://virtual-fitting-ai.<계정>.workers.dev
```

배포 후 프론트 `ai/config.js` 의 `AI_ENDPOINT` 를 `https://…workers.dev/api/ai` 로 설정합니다.
모델/예산은 `wrangler.toml` 의 `[vars]`(또는 `wrangler secret`/대시보드)로 조정합니다.
엔드포인트가 죽거나 예산을 초과해도 프론트는 mock 으로 자동 폴백하므로 앱이 멈추지 않습니다(무인).

## 프론트 연결

`ai/config.js` 의 `AI_ENDPOINT` 를 이 서버의 `/api/ai` URL 로 설정하면
프론트가 mock 대신 실제 Claude 를 사용합니다.

```js
// ai/config.js
export const AI_ENDPOINT = "http://localhost:8787/api/ai"; // 운영에선 배포 도메인
```

`AI_ENDPOINT` 가 빈 문자열("")이면 프론트는 서버 없이 내장 mock 으로 동작합니다(데모 기본값).

## 엔드포인트

| 메서드 | 경로       | 설명                                            |
| ------ | ---------- | ----------------------------------------------- |
| POST   | `/api/ai`  | `{task, payload}` → Claude 응답 텍스트 스트림   |
| GET    | `/health`  | `{ ok: true, model }` 상태 확인                 |
| OPTIONS| `/api/ai`  | CORS preflight                                  |

요청 예:

```bash
curl -N -X POST http://localhost:8787/api/ai \
  -H 'content-type: application/json' \
  -d '{"task":"fit-explain","payload":{"profile":{"height":175,"weight":70,"gender":"men","bodyType":"standard"},"garment":{ ... },"size":"M"}}'
```

## 보안 메모

- `.env` 는 `.gitignore` 로 제외됩니다. 절대 커밋하지 마세요.
- 운영에서는 `CORS_ORIGIN` 을 프론트 도메인으로 좁히세요(기본 `*`).
- 이 서버 외 어디에도 키가 존재하지 않아야 합니다.
