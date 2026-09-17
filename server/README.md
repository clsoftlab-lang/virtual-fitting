<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국) -->

# 가상 피팅 AI 백엔드 프록시

프론트엔드(브라우저)가 **절대 Claude API 키를 갖지 않도록** 하는 얇은 서버 프록시입니다.
브라우저는 이 서버의 `POST /api/ai` 로 `{task, payload}` 만 보내고, 서버가 유일하게 키를 쥔 채
Anthropic Claude(`claude-opus-5`)를 호출하여 텍스트를 **스트리밍**으로 되돌려줍니다.

> **API 키는 서버 전용입니다. 브라우저나 저장소에 절대 넣지 마세요.**

## 동작 개요

- 모델: `claude-opus-5`, 적응형 사고(`thinking: { type: "adaptive" }`), 스트리밍
- 키: `process.env.ANTHROPIC_API_KEY` (하드코딩 금지)
- 그라운딩: 요청이 오면 서버가 `../fit-engine.js` 로 추천 사이즈·부위별 여유·핏 점수를
  **실제로 계산**해 프롬프트에 근거로 주입합니다(실 데이터 집계 → LLM grounded).
- 지원 task: `style-chat`(상담 챗봇), `fit-explain`(핏 설명), `outfit-coordi`(코디 추천)

## 설치 및 실행

```bash
cd server
cp .env.example .env      # ANTHROPIC_API_KEY 를 실제 키로 채우기
npm install               # @anthropic-ai/sdk 설치
npm start                 # http://localhost:8787 에서 실행
```

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
