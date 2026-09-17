// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// ai/config.js — AI 레이어 설정
// =====================================================================
// AI_ENDPOINT 가 빈 문자열("")이면 브라우저 내장 MockProvider(결정론적 데모)
// 로 동작합니다. 실제 Claude 연동 시에는 server/ 백엔드 프록시를 배포하고
// 그 URL(예: "https://내서버/api/ai")을 여기에 넣으세요.
//
// ⚠️ 보안: 이 파일에는 절대 API 키를 넣지 마세요. 키는 서버 전용입니다.
//    (브라우저·저장소에 노출 금지 — server/.env 의 ANTHROPIC_API_KEY 만 사용)
// =====================================================================

export const AI_ENDPOINT = "";
