// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// check.mjs — CI 검증 스크립트
//   1) 모든 JSON 파싱
//   2) 모든 JS 를 `node --check` 로 구문 검사
//   3) index.html 필수 요소 존재 확인
//   4) fit-engine 단위 테스트 (알려진 입력 → 기대 추천 사이즈/핏 배지)
//   5) AI 레이어: ai/·server/ node --check, AI_ENDPOINT 기본 빈 값,
//      커밋된 실제 API 키 부재, mock 세 태스크 응답 생성
// 실패 시 프로세스 종료코드 1.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  estimateBody, recommendSize, evaluateSize, classifyEase, idealWeight,
} from './fit-engine.js';
import { AI_ENDPOINT } from './ai/config.js';
import { askAI, AI_TASKS } from './ai/ai.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`);
}
function near(name, actual, expected, tol = 0.05) {
  ok(name, Math.abs(actual - expected) <= tol, `기대 ~${expected}, 실제 ${actual}`);
}

// 재귀 파일 수집(간단 필터)
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.github'].includes(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);

// ---------------------------------------------------------------------------
console.log('\n[1] JSON 파싱');
const jsonFiles = files.filter((f) => f.endsWith('.json'));
let garments = [];
for (const f of jsonFiles) {
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    ok(`parse ${f.replace(ROOT, '.')}`, true);
    if (f.endsWith('garments.json')) garments = data.garments;
  } catch (err) {
    ok(`parse ${f.replace(ROOT, '.')}`, false, err.message);
  }
}
ok('garments.json 항목 30개 이상', garments.length >= 30, `현재 ${garments.length}`);
ok('모든 garment 에 sizes 존재', garments.every((g) => g.sizes && Object.keys(g.sizes).length >= 2));
ok('모든 garment 유효 카테고리', garments.every((g) => ['top', 'bottom', 'outer', 'dress'].includes(g.category)));

// ---------------------------------------------------------------------------
console.log('\n[2] node --check (JS 구문)');
const jsFiles = files.filter((f) => /\.(m?js)$/.test(f));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    ok(`--check ${f.replace(ROOT, '.')}`, true);
  } catch (err) {
    ok(`--check ${f.replace(ROOT, '.')}`, false, String(err.stderr || err).slice(0, 200));
  }
}

// ---------------------------------------------------------------------------
console.log('\n[3] index.html 필수 요소');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const required = [
  'id="app"', 'id="profile-form"', 'id="inp-height"', 'id="inp-weight"',
  'id="sel-gender"', 'id="sel-bodyType"', 'id="avatar-container"',
  'id="catalog-grid"', 'id="filter-category"', 'id="compare-view"',
  'id="wishlist-view"', 'id="garment-detail"', 'id="theme-toggle"', 'id="reset-btn"',
  'id="view-ai"', 'data-view="ai"', 'id="ai-chat-form"', 'id="ai-chat-input"', 'id="ai-codi-situations"',
  'type="module"', 'app.js', 'styles.css',
];
for (const token of required) ok(`index.html 포함: ${token}`, html.includes(token));

// ---------------------------------------------------------------------------
console.log('\n[4] fit-engine 단위 테스트');
const byId = (id) => {
  const g = garments.find((x) => x.id === id);
  if (!g) throw new Error(`테스트 대상 없음: ${id}`);
  return g;
};

// 4-1 idealWeight (BMI 22)
near('idealWeight(175)=67.4', idealWeight(175), 67.375, 0.01);

// 4-2 estimateBody 결정론 (공식 고정)
const bStd = estimateBody({ height: 175, weight: 70, gender: 'men', bodyType: 'standard' });
near('남 175/70 표준 가슴=91.5', bStd.chest, 91.5, 0.05);
near('남 175/70 표준 허리=75.6', bStd.waist, 75.6, 0.05);

// 4-3 체중 단조성: 무거울수록 가슴 둘레 큼
const light = estimateBody({ height: 175, weight: 60, gender: 'men', bodyType: 'standard' });
const heavy = estimateBody({ height: 175, weight: 90, gender: 'men', bodyType: 'standard' });
ok('체중↑ ⇒ 가슴둘레↑ (단조성)', heavy.chest > bStd.chest && bStd.chest > light.chest);

// 4-4 classifyEase 경계
eq('ease 10 in [6,16] = good', classifyEase(10, [6, 16]).fit, 'good');
eq('ease 2  in [6,16] = tight', classifyEase(2, [6, 16]).fit, 'tight');
eq('ease 20 in [6,16] = loose', classifyEase(20, [6, 16]).fit, 'loose');

// 4-5 evaluateSize: ease = 의류 - 신체 (부호 확인)
const evT = evaluateSize(bStd, byId('top-tee-001'), 'M');
near('tee-001 M 가슴 ease = 14.5', evT.detail.chest.ease, 14.5, 0.05);

// 4-6 추천 사이즈: 큰 체형 남성 → 상의 XL (적당)
const bigMan = { height: 188, weight: 95, gender: 'men', bodyType: 'athletic' };
const rBig = recommendSize(bigMan, byId('top-tee-001'));
eq('큰 남성 → tee-001 추천 XL', rBig.recommended, 'XL');
eq('큰 남성 → tee-001 핏 적당(good)', rBig.best.badge, 'good');

// 4-7 작은 체형 남성 → 박시한 티셔츠는 넉넉(loose)
const rSmall = recommendSize({ height: 165, weight: 55, gender: 'men', bodyType: 'slim' }, byId('top-tee-001'));
eq('작은 남성 → tee-001 핏 넉넉(loose)', rSmall.best.badge, 'loose');

// 4-8 하의 추천: 남 178/74 표준 → 슬림데님 M (적당)
const rJean = recommendSize({ height: 178, weight: 74, gender: 'men', bodyType: 'standard' }, byId('bot-jean-001'));
eq('남 178/74 → 슬림데님 추천 M', rJean.recommended, 'M');
eq('남 178/74 → 슬림데님 허리 적당(good)', rJean.best.badge, 'good');

// 4-9 하의 추천: 여 168/72 굴곡형 → 와이드데님 L
const rWide = recommendSize({ height: 168, weight: 72, gender: 'women', bodyType: 'curvy' }, byId('bot-jean-002'));
eq('여 168/72 굴곡 → 와이드데님 추천 L', rWide.recommended, 'L');

// 4-10 모든 garment 에 대해 추천이 유효 사이즈 키인지
let recValid = true;
for (const g of garments) {
  const r = recommendSize(bStd, g);
  if (!Object.keys(g.sizes).includes(r.recommended)) { recValid = false; break; }
}
ok('전 상품 추천 사이즈가 유효 키', recValid);

// ---------------------------------------------------------------------------
console.log('\n[5] AI 레이어');

// 5-1 AI_ENDPOINT 기본값은 빈 문자열(브라우저 mock 모드, 키 미노출)
eq('AI_ENDPOINT 기본값 빈 문자열', AI_ENDPOINT, '');

// 5-2 ai/ 및 server/ 하위 모든 JS 를 명시적으로 node --check
const rel = (f) => f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
const aiFiles = files.filter((f) => /\.(m?js)$/.test(f) && /^(ai|server)\//.test(rel(f)));
ok('ai/·server/ JS 파일 3개 이상', aiFiles.length >= 3, `현재 ${aiFiles.length}`);
for (const f of aiFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    ok(`--check ${rel(f)}`, true);
  } catch (err) {
    ok(`--check ${rel(f)}`, false, String(err.stderr || err).slice(0, 200));
  }
}

// 5-3 커밋된 실제 API 키 부재 — 진짜 키 형식만 매칭(README 의 "sk-ant…" 언급은 오탐 아님)
const KEY_RE = new RegExp("sk-" + "ant-[A-Za-z0-9_-]{20,}");
let leaked = null;
for (const f of files) {
  let content;
  try { content = readFileSync(f, 'utf8'); } catch { continue; }
  if (KEY_RE.test(content)) { leaked = rel(f); break; }
}
ok('커밋된 실제 API 키 없음', leaked === null, leaked ? `발견: ${leaked}` : '');

// 5-4 mock 세 태스크가 한글 응답을 결정론적으로 생성(핏 엔진 그라운딩)
const aiProfile = { height: 175, weight: 70, gender: 'men', bodyType: 'standard' };
const exp = await askAI(AI_TASKS.EXPLAIN, { profile: aiProfile, garment: byId('top-tee-001'), size: 'M' });
ok('mock EXPLAIN 응답 생성', typeof exp === 'string' && exp.length > 40 && exp.includes('여유'));
const chat = await askAI(AI_TASKS.CHAT, { profile: aiProfile, message: '셔츠 추천해줘', garments });
ok('mock CHAT 응답 생성', typeof chat === 'string' && chat.includes('추천'));
const codi = await askAI(AI_TASKS.CODI, { profile: aiProfile, situation: 'office', garments });
ok('mock CODI 응답 생성', typeof codi === 'string' && codi.length > 40);

// ---------------------------------------------------------------------------
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
if (fail > 0) {
  console.error('실패 항목:\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('모든 검증 통과 ✅');
