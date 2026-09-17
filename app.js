// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// app.js — 가상 피팅 룸 SPA (no-build, ES module)
// 신체정보 입력 → 아바타 스케일링 → 카탈로그/필터 → 상세 핏 분석 → 비교/찜

import {
  estimateBody, recommendSize, evaluateSize,
  REGION_LABELS, FIT_BADGE_KO, CATEGORY_REGIONS,
} from './fit-engine.js';
import { askAI, AI_TASKS, situationList } from './ai/ai.js';
import { AI_ENDPOINT } from './ai/config.js';

// ---------------------------------------------------------------------------
// 상태 & 저장소
// ---------------------------------------------------------------------------
const LS_KEY = 'vfit.state.v1';
const CATEGORY_LABELS = { top: '상의', bottom: '하의', outer: '아우터', dress: '원피스' };

const DEFAULT_PROFILE = { height: 175, weight: 70, gender: 'men', bodyType: 'standard' };

const state = {
  profile: { ...DEFAULT_PROFILE },
  wishlist: [],
  compare: [],
  view: 'catalog',
  filters: { q: '', category: '', gender: '', size: '', fitOnly: false },
  theme: null,
};

let GARMENTS = [];
let BODY_MODELS = null;

/** localStorage 안전 로드. */
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.profile) state.profile = { ...DEFAULT_PROFILE, ...data.profile };
    if (Array.isArray(data.wishlist)) state.wishlist = data.wishlist;
    if (Array.isArray(data.compare)) state.compare = data.compare;
    if (data.theme) state.theme = data.theme;
  } catch (err) {
    console.warn('상태 로드 실패(무시):', err);
  }
}

/** localStorage 안전 저장. */
function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      profile: state.profile, wishlist: state.wishlist,
      compare: state.compare, theme: state.theme,
    }));
  } catch (err) {
    console.warn('상태 저장 실패(무시):', err);
  }
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const won = (n) => n.toLocaleString('ko-KR') + '원';
const fitClass = (fit) => `fit-${fit}`;

// ---------------------------------------------------------------------------
// 아바타 SVG (신체 둘레에 비례해 스케일링)
// ---------------------------------------------------------------------------
/**
 * 신체 추정치 → 실루엣 반너비(px). 캔버스 cx=100 기준.
 */
function silhouette(body) {
  const cx = 100;
  const yScale = Math.max(0.86, Math.min(1.14, 1 + (body.height - 172) / 260));
  const H = (y) => 40 + (y - 40) * yScale; // 머리(40) 고정 후 아래로 스케일
  return {
    cx,
    head: { cy: 40, r: 25 },
    yNeck: H(66), yShoulder: H(86), yChest: H(122),
    yWaist: H(176), yHip: H(212), yKnee: H(316), yAnkle: H(404),
    shoulderHalf: Math.max(26, body.shoulder * 0.85),
    chestHalf:    Math.max(24, body.chest * 0.30),
    waistHalf:    Math.max(20, body.waist * 0.30),
    hipHalf:      Math.max(24, body.hip * 0.30),
    thighHalf:    Math.max(11, body.thigh * 0.17),
  };
}

/**
 * 아바타 + (선택) 의류 오버레이 SVG 문자열.
 * @param {object} body estimateBody 결과
 * @param {object|null} overlay { category, lengthCm, fit } 착장 미리보기
 */
function buildAvatarSVG(body, overlay = null) {
  const s = silhouette(body);
  const cx = s.cx;
  const skin = 'var(--surface-2)';
  const stroke = 'var(--border)';

  // 몸통 외곽선 (오른쪽 → 왼쪽 미러)
  const torso = [
    `${cx - s.shoulderHalf},${s.yShoulder}`,
    `${cx - s.chestHalf},${s.yChest}`,
    `${cx - s.waistHalf},${s.yWaist}`,
    `${cx - s.hipHalf},${s.yHip}`,
    `${cx + s.hipHalf},${s.yHip}`,
    `${cx + s.waistHalf},${s.yWaist}`,
    `${cx + s.chestHalf},${s.yChest}`,
    `${cx + s.shoulderHalf},${s.yShoulder}`,
  ].join(' ');

  // 다리
  const inseam = 6;
  const leftLeg = [
    `${cx - s.hipHalf},${s.yHip}`, `${cx - inseam},${s.yHip}`,
    `${cx - inseam},${s.yAnkle}`, `${cx - s.thighHalf * 2 + inseam},${s.yAnkle}`,
  ].join(' ');
  const rightLeg = [
    `${cx + inseam},${s.yHip}`, `${cx + s.hipHalf},${s.yHip}`,
    `${cx + s.thighHalf * 2 - inseam},${s.yAnkle}`, `${cx + inseam},${s.yAnkle}`,
  ].join(' ');

  // 팔
  const armW = 12;
  const leftArm = `M ${cx - s.shoulderHalf},${s.yShoulder + 2} q -14,40 -8,${s.yWaist - s.yShoulder} l ${armW},2 q -2,-40 6,-${s.yWaist - s.yShoulder - 8} z`;
  const rightArm = `M ${cx + s.shoulderHalf},${s.yShoulder + 2} q 14,40 8,${s.yWaist - s.yShoulder} l -${armW},2 q 2,-40 -6,-${s.yWaist - s.yShoulder - 8} z`;

  let overlaySVG = '';
  if (overlay) {
    overlaySVG = buildGarmentOverlay(s, overlay);
  }

  return `
  <svg viewBox="0 0 200 430" xmlns="http://www.w3.org/2000/svg" role="img">
    <g fill="${skin}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round">
      <circle cx="${cx}" cy="${s.head.cy}" r="${s.head.r}" />
      <rect x="${cx - 9}" y="${s.yNeck - 8}" width="18" height="16" rx="4" />
      <path d="${leftArm}" />
      <path d="${rightArm}" />
      <polygon points="${leftLeg}" />
      <polygon points="${rightLeg}" />
      <polygon points="${torso}" />
    </g>
    ${overlaySVG}
  </svg>`;
}

/** 의류 오버레이(핏 색상으로 반투명 착장). */
function buildGarmentOverlay(s, overlay) {
  const cx = s.cx;
  const colorMap = { good: 'var(--fit-good)', tight: 'var(--fit-tight)', loose: 'var(--fit-loose)' };
  const color = colorMap[overlay.fit] || colorMap.good;
  const isBottom = overlay.category === 'bottom';
  const isDress = overlay.category === 'dress';
  const pad = overlay.fit === 'loose' ? 6 : overlay.fit === 'tight' ? -2 : 2;

  if (isBottom) {
    // 허리~기장(길이 비례) 하의
    const yTop = s.yWaist - 2;
    const lenRatio = Math.max(0.25, Math.min(1, (overlay.lengthCm || 100) / 110));
    const yBottom = s.yHip + (s.yAnkle - s.yHip) * lenRatio;
    const inseam = 6;
    const left = `${cx - s.hipHalf - pad},${yTop} ${cx - inseam},${yTop} ${cx - inseam},${yBottom} ${cx - s.thighHalf * 2 + inseam - pad},${yBottom}`;
    const right = `${cx + inseam},${yTop} ${cx + s.hipHalf + pad},${yTop} ${cx + s.thighHalf * 2 - inseam + pad},${yBottom} ${cx + inseam},${yBottom}`;
    return `<g fill="${color}" fill-opacity="0.4" stroke="${color}" stroke-width="1.5">
      <polygon points="${left}" /><polygon points="${right}" /></g>`;
  }

  // 상의 / 아우터 / 원피스: 어깨~기장 비례
  const yTop = s.yShoulder - 3;
  const topMax = isDress ? s.yAnkle : s.yHip + 18;
  const lenRatio = Math.max(0.3, Math.min(1, (overlay.lengthCm || 68) / (isDress ? 116 : 78)));
  const yBottom = yTop + (topMax - yTop) * lenRatio;
  const halfTop = s.shoulderHalf + pad;
  const halfMid = Math.max(s.chestHalf, s.waistHalf) + pad;
  const poly = [
    `${cx - halfTop},${yTop}`, `${cx - halfMid},${(yTop + yBottom) / 2}`,
    `${cx - halfMid + 2},${yBottom}`, `${cx + halfMid - 2},${yBottom}`,
    `${cx + halfMid},${(yTop + yBottom) / 2}`, `${cx + halfTop},${yTop}`,
  ].join(' ');
  return `<g fill="${color}" fill-opacity="0.42" stroke="${color}" stroke-width="1.5">
    <polygon points="${poly}" /></g>`;
}

/** 카테고리 썸네일 아이콘. */
function thumbIcon(category) {
  const c = 'var(--text-dim)';
  const icons = {
    top: `<path d="M20 8 L35 4 L50 12 L64 4 L80 8 L74 26 L62 22 L62 60 L38 60 L38 22 L26 26 Z"/>`,
    outer: `<path d="M22 6 L38 2 L50 10 L62 2 L78 6 L72 30 L60 26 L60 62 L40 62 L40 26 L28 30 Z M50 12 L50 60"/>`,
    bottom: `<path d="M30 6 L70 6 L66 60 L54 60 L50 26 L46 60 L34 60 Z"/>`,
    dress: `<path d="M34 6 L50 2 L66 6 L58 22 L72 62 L28 62 L42 22 Z"/>`,
  };
  return `<svg viewBox="0 0 100 68" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round">${icons[category] || icons.top}</svg>`;
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------
function renderProfileControls() {
  const { genders, bodyTypes, presets } = BODY_MODELS;
  $('#sel-gender').innerHTML = genders.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join('');
  $('#sel-bodyType').innerHTML = bodyTypes.map((b) => `<option value="${b.id}">${esc(b.label)}</option>`).join('');
  $('#sel-preset').innerHTML = '<option value="">직접 입력</option>' +
    presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');

  // 필터 셀렉트
  $('#filter-category').innerHTML = '<option value="">전체 카테고리</option>' +
    Object.entries(CATEGORY_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#filter-gender').innerHTML = '<option value="">전체 성별</option>' +
    genders.filter((g) => g.id !== 'unisex').map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join('');
  const allSizes = ['XS', 'S', 'M', 'L', 'XL'];
  $('#filter-size').innerHTML = '<option value="">전체 사이즈</option>' +
    allSizes.map((s) => `<option value="${s}">${s} 보유</option>`).join('');

  syncProfileInputs();
}

function syncProfileInputs() {
  $('#inp-height').value = state.profile.height;
  $('#inp-weight').value = state.profile.weight;
  $('#sel-gender').value = state.profile.gender;
  $('#sel-bodyType').value = state.profile.bodyType;
}

function renderAvatar() {
  const body = estimateBody(state.profile);
  $('#avatar-container').innerHTML = buildAvatarSVG(body);
  $('#body-summary').innerHTML = `
    <div class="metric"><b>${body.chest}</b><span>가슴 cm</span></div>
    <div class="metric"><b>${body.waist}</b><span>허리 cm</span></div>
    <div class="metric"><b>${body.hip}</b><span>엉덩이 cm</span></div>
    <div class="metric"><b>${body.shoulder}</b><span>어깨 cm</span></div>
    <div class="metric"><b>${body.thigh}</b><span>허벅지 cm</span></div>
    <div class="metric"><b>${body.bmi}</b><span>BMI</span></div>`;
}

function filteredGarments() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return GARMENTS.filter((g) => {
    if (f.category && g.category !== f.category) return false;
    if (f.gender && g.gender !== f.gender && g.gender !== 'unisex') return false;
    if (f.size && !Object.keys(g.sizes).includes(f.size)) return false;
    if (q && !(`${g.name} ${g.brand} ${g.subtype}`.toLowerCase().includes(q))) return false;
    if (f.fitOnly) {
      const r = recommendSize(state.profile, g);
      if (!r.best || r.best.badge !== 'good') return false;
    }
    return true;
  });
}

function renderCatalog() {
  const list = filteredGarments();
  $('#catalog-count').textContent = `${list.length}개 상품`;
  const grid = $('#catalog-grid');
  if (!list.length) {
    grid.innerHTML = `<p class="empty" style="grid-column:1/-1">조건에 맞는 상품이 없습니다.</p>`;
    return;
  }
  grid.innerHTML = list.map((g) => {
    const r = recommendSize(state.profile, g);
    const badge = r.best ? r.best.badge : 'good';
    const rec = r.recommended || '-';
    return `
    <article class="card" data-id="${g.id}" tabindex="0">
      <div class="thumb">${thumbIcon(g.category)}</div>
      <div class="body">
        <span class="brand">${esc(g.brand)} · ${CATEGORY_LABELS[g.category]}</span>
        <span class="name">${esc(g.name)}</span>
        <span class="price">${won(g.price)}</span>
        <span class="rec">
          <span class="size-badge">${rec}</span>
          <span class="fit-badge ${fitClass(badge)}">${FIT_BADGE_KO[badge]}</span>
        </span>
      </div>
    </article>`;
  }).join('');
}

function renderCounts() {
  $('#wishlist-count').textContent = state.wishlist.length;
  $('#compare-count').textContent = state.compare.length;
}

// ---------------------------------------------------------------------------
// 자동 기능: 내 체형 맞춤 추천 착장 Top 3
// 신체정보 로드/변경 시 fit-engine + askAI(DIGEST) 로 자동 생성한다.
// 오프라인 mock 으로도 동작하며, 실서비스에서 실패해도 mock 으로 자동 폴백된다.
// ---------------------------------------------------------------------------
let digestTimer = null;
let digestSeq = 0;

function scheduleAutoDigest(delay = 500) {
  clearTimeout(digestTimer);
  digestTimer = setTimeout(renderAutoDigest, delay);
}

async function renderAutoDigest() {
  const box = $('#auto-digest');
  if (!box || !GARMENTS.length) return;
  const seq = ++digestSeq; // 프로파일이 다시 바뀌면 이전 스트림 결과는 버린다.
  box.hidden = false;
  box.innerHTML = `
    <div class="digest-head"><span class="pill ai-pill">AI</span> 내 체형 맞춤 추천 착장 Top 3</div>
    <p class="digest-body" id="auto-digest-body">추천을 생성하는 중…</p>`;
  const out = $('#auto-digest-body');
  try {
    let first = true;
    await askAI(
      AI_TASKS.DIGEST,
      { profile: state.profile, garments: GARMENTS },
      { onToken: (t) => {
        if (seq !== digestSeq) return;      // 최신 요청만 반영
        if (first) { out.textContent = ''; first = false; }
        out.textContent += t;
      } },
    );
  } catch (err) {
    if (seq === digestSeq) out.textContent = '추천을 불러오지 못했습니다.';
  }
}

// ---- 상세 다이얼로그 -------------------------------------------------------
let detailSelectedSize = null;

function openDetail(id) {
  const g = GARMENTS.find((x) => x.id === id);
  if (!g) return;
  const r = recommendSize(state.profile, g);
  detailSelectedSize = r.recommended || Object.keys(g.sizes)[0];
  renderDetail(g, r);
  $('#detail-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  $('#detail-backdrop').hidden = true;
  document.body.style.overflow = '';
}

function renderDetail(g, r) {
  const body = r.body;
  const ev = evaluateSize(body, g, detailSelectedSize);
  const regions = (CATEGORY_REGIONS[g.category] || CATEGORY_REGIONS.top).filter((rg) => g.sizes[detailSelectedSize][rg] != null);

  // 사이즈표 (본문 여유 포함)
  const sizeKeys = Object.keys(g.sizes);
  const header = `<tr><th>부위</th>${sizeKeys.map((s) => `<th>${s}${s === r.recommended ? ' ★' : ''}</th>`).join('')}</tr>`;
  const rows = regions.map((rg) => {
    const cells = sizeKeys.map((s) => {
      const e = evaluateSize(body, g, s).detail[rg];
      return `<td>${g.sizes[s][rg]}<br><small class="${e.ease >= 0 ? 'ease-pos' : 'ease-neg'}">${e.ease >= 0 ? '+' : ''}${e.ease}</small></td>`;
    }).join('');
    return `<tr class="ease-row"><td>${REGION_LABELS[rg]}</td>${cells}</tr>`;
  }).join('');

  const sizeButtons = sizeKeys.map((s) => `
    <button class="btn ${s === detailSelectedSize ? '' : 'secondary'}" data-size="${s}" style="padding:6px 12px">${s}</button>`).join('');

  const regionList = regions.map((rg) => {
    const d = ev.detail[rg];
    return `<li>
      <span>${REGION_LABELS[rg]}</span>
      <span class="rl-ease">여유 ${d.ease >= 0 ? '+' : ''}${d.ease}cm</span>
      <span class="fit-badge ${fitClass(d.fit)}">${FIT_BADGE_KO[d.fit]}</span>
    </li>`;
  }).join('');

  const inWish = state.wishlist.includes(g.id);
  const inCompare = state.compare.includes(g.id);

  $('#garment-detail').innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(g.name)}</h2>
        <p class="brand" style="color:var(--text-dim);margin:2px 0">${esc(g.brand)} · ${CATEGORY_LABELS[g.category]} · ${esc(g.subtype)} · ${won(g.price)}</p>
      </div>
      <button class="close-x" id="detail-close" aria-label="닫기">×</button>
    </div>
    <div class="detail-grid">
      <div>
        <div class="detail-avatar">${buildAvatarSVG(body, { category: g.category, lengthCm: g.sizes[detailSelectedSize].length, fit: ev.badge })}</div>
        <div class="chips">${g.colors.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        <p style="font-size:12px;color:var(--text-dim)">소재: ${esc(g.material)} · 신축성: ${esc(g.stretch)}</p>
      </div>
      <div>
        <div class="rec-box">
          <div>추천 사이즈</div>
          <div class="big">${r.recommended || '-'}</div>
          <div>선택 사이즈 <b>${detailSelectedSize}</b> 전체 핏:
            <span class="fit-badge ${fitClass(ev.badge)}">${ev.badgeKo}</span>
            <span style="color:var(--text-dim);font-size:12px"> (핏 점수 ${ev.score})</span>
          </div>
        </div>
        <div class="chips">${sizeButtons}</div>
        <ul class="region-list">${regionList}</ul>
        <div class="btn-row">
          <button class="btn ${inWish ? 'secondary' : ''}" id="detail-wish">${inWish ? '찜 해제' : '♥ 찜하기'}</button>
          <button class="btn secondary" id="detail-compare" ${inCompare ? 'disabled' : ''}>${inCompare ? '비교함에 있음' : '비교 담기'}</button>
          <button class="btn secondary" id="detail-ai-explain">🤖 AI 핏 설명</button>
        </div>
        <div id="detail-ai-out" class="ai-explain-out" hidden></div>
      </div>
    </div>
    <h3 style="margin:18px 0 8px;font-size:14px">사이즈표 (cm) · 아래 숫자는 내 치수 대비 여유</h3>
    <div class="table-wrap"><table class="size-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:11px;color:var(--text-dim);margin-top:8px">여유(ease) = 의류 실측 − 내 추정 치수. 음수(빨강)=몸보다 작음/타이트, 양수(파랑)=여유.</p>
  `;

  $('#detail-close').onclick = closeDetail;
  $$('[data-size]', $('#garment-detail')).forEach((btn) => {
    btn.onclick = () => { detailSelectedSize = btn.dataset.size; renderDetail(g, r); };
  });
  $('#detail-wish').onclick = () => { toggleWish(g.id); renderDetail(g, r); };
  $('#detail-compare').onclick = () => { addCompare(g.id); renderDetail(g, r); };
  $('#detail-ai-explain').onclick = async () => {
    const out = $('#detail-ai-out');
    const btn = $('#detail-ai-explain');
    out.hidden = false;
    out.textContent = 'AI가 핏을 설명하는 중…';
    btn.disabled = true;
    try {
      out.textContent = '';
      await askAI(
        AI_TASKS.EXPLAIN,
        { profile: state.profile, garment: g, size: detailSelectedSize },
        { onToken: (t) => { out.textContent += t; } },
      );
    } catch (err) {
      out.textContent = 'AI 설명을 불러오지 못했습니다: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// AI 스타일리스트 뷰 (챗봇 + 상황별 코디)
// ---------------------------------------------------------------------------
let aiViewReady = false;

function aiProviderNote() {
  return AI_ENDPOINT
    ? '실서비스 모드: 백엔드 프록시를 통해 Claude 가 응답합니다. (API 키는 서버 전용)'
    : '데모 모드: 브라우저 내장 mock 이 핏 엔진 계산을 근거로 응답합니다. 실제 Claude 연동은 server/ 배포 후 ai/config.js 의 AI_ENDPOINT 설정.';
}

function renderAiView() {
  $('#ai-provider-note').textContent = aiProviderNote();
  if (aiViewReady) return;
  aiViewReady = true;

  // 상황 버튼
  const box = $('#ai-codi-situations');
  box.innerHTML = situationList()
    .map((s) => `<button class="btn secondary ai-sit-btn" data-sit="${s.id}">${esc(s.label)}</button>`).join('');
  $$('[data-sit]', box).forEach((b) => { b.onclick = () => runCodi(b.dataset.sit, b); });

  // 챗봇
  appendChat('ai', '안녕하세요! 신체정보 기준으로 옷을 추천해 드릴게요. 무엇을 찾으세요? 예: "출근용 셔츠", "넉넉한 하의", "데이트룩".');
  $('#ai-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
}

function appendChat(who, text) {
  const log = $('#ai-chat-log');
  const row = document.createElement('div');
  row.className = `ai-msg ai-msg-${who}`;
  row.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

async function sendChat() {
  const input = $('#ai-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  appendChat('user', msg);
  const out = appendChat('ai', '생각 중…');
  $('#ai-chat-send').disabled = true;
  try {
    out.textContent = '';
    await askAI(
      AI_TASKS.CHAT,
      { profile: state.profile, message: msg, garments: GARMENTS },
      { onToken: (t) => { out.textContent += t; $('#ai-chat-log').scrollTop = $('#ai-chat-log').scrollHeight; } },
    );
  } catch (err) {
    out.textContent = '응답 실패: ' + err.message;
  } finally {
    $('#ai-chat-send').disabled = false;
  }
}

async function runCodi(situation, btn) {
  const out = $('#ai-codi-result');
  out.hidden = false;
  out.textContent = 'AI가 코디를 구성하는 중…';
  $$('.ai-sit-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  try {
    out.textContent = '';
    await askAI(
      AI_TASKS.CODI,
      { profile: state.profile, situation, garments: GARMENTS },
      { onToken: (t) => { out.textContent += t; } },
    );
  } catch (err) {
    out.textContent = '코디 추천 실패: ' + err.message;
  }
}

// ---- 비교 / 찜 -------------------------------------------------------------
function toggleWish(id) {
  const i = state.wishlist.indexOf(id);
  if (i >= 0) state.wishlist.splice(i, 1); else state.wishlist.push(id);
  saveState(); renderCounts(); renderWishlist();
}

function addCompare(id) {
  if (state.compare.includes(id)) return;
  if (state.compare.length >= 4) { alert('비교는 최대 4개까지 가능합니다.'); return; }
  state.compare.push(id);
  saveState(); renderCounts(); renderCompare();
}

function removeCompare(id) {
  state.compare = state.compare.filter((x) => x !== id);
  saveState(); renderCounts(); renderCompare();
}

function renderCompare() {
  const box = $('#compare-view');
  if (!state.compare.length) {
    box.innerHTML = `<p class="empty">비교할 상품이 없습니다. 상세 화면에서 "비교 담기"를 눌러보세요.</p>`;
    return;
  }
  box.innerHTML = state.compare.map((id) => {
    const g = GARMENTS.find((x) => x.id === id);
    if (!g) return '';
    const r = recommendSize(state.profile, g);
    const ev = r.best;
    const regions = Object.values(ev.detail).map((d) =>
      `<li><span>${d.label}</span><span class="fit-badge ${fitClass(d.fit)}">${FIT_BADGE_KO[d.fit]}</span></li>`).join('');
    return `
    <div class="compare-card">
      <div class="thumb" style="aspect-ratio:3/4;background:var(--surface-2);border-radius:10px;display:flex;align-items:center;justify-content:center">${thumbIcon(g.category)}</div>
      <h3 style="font-size:14px;margin:10px 0 2px">${esc(g.name)}</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:0">${esc(g.brand)} · ${won(g.price)}</p>
      <div class="rec-box" style="margin:10px 0">
        <div>추천 <span class="size-badge" style="background:var(--brand);color:#fff;border-radius:6px;padding:2px 8px;font-weight:700">${r.recommended}</span>
        <span class="fit-badge ${fitClass(ev.badge)}">${ev.badgeKo}</span></div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px">핏 점수 ${ev.score}/100</div>
      </div>
      <ul class="region-list">${regions}</ul>
      <div class="btn-row">
        <button class="btn secondary" data-open="${g.id}">상세</button>
        <button class="btn secondary" data-rmcompare="${g.id}">빼기</button>
      </div>
    </div>`;
  }).join('');
  $$('[data-rmcompare]', box).forEach((b) => b.onclick = () => removeCompare(b.dataset.rmcompare));
  $$('[data-open]', box).forEach((b) => b.onclick = () => openDetail(b.dataset.open));
}

function renderWishlist() {
  const box = $('#wishlist-view');
  if (!state.wishlist.length) {
    box.innerHTML = `<p class="empty">찜한 상품이 없습니다.</p>`;
    return;
  }
  box.innerHTML = state.wishlist.map((id) => {
    const g = GARMENTS.find((x) => x.id === id);
    if (!g) return '';
    const r = recommendSize(state.profile, g);
    const ev = r.best;
    return `
    <div class="wish-card">
      <div style="display:flex;gap:12px">
        <div class="thumb" style="width:70px;aspect-ratio:3/4;background:var(--surface-2);border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none">${thumbIcon(g.category)}</div>
        <div style="flex:1">
          <h3 style="font-size:14px;margin:0 0 2px">${esc(g.name)}</h3>
          <p style="color:var(--text-dim);font-size:12px;margin:0 0 6px">${esc(g.brand)} · ${won(g.price)}</p>
          <span class="size-badge" style="background:var(--brand);color:#fff;border-radius:6px;padding:2px 8px;font-weight:700">${r.recommended}</span>
          <span class="fit-badge ${fitClass(ev.badge)}">${ev.badgeKo}</span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn secondary" data-open="${g.id}">상세</button>
        <button class="btn secondary" data-unwish="${g.id}">찜 해제</button>
      </div>
    </div>`;
  }).join('');
  $$('[data-unwish]', box).forEach((b) => b.onclick = () => toggleWish(b.dataset.unwish));
  $$('[data-open]', box).forEach((b) => b.onclick = () => openDetail(b.dataset.open));
}

// ---------------------------------------------------------------------------
// 뷰 전환 & 이벤트
// ---------------------------------------------------------------------------
function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  if (view === 'compare') renderCompare();
  if (view === 'wishlist') renderWishlist();
  if (view === 'ai') renderAiView();
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'light') root.setAttribute('data-theme', 'light');
  else if (state.theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

function onProfileChange() {
  state.profile.height = Number($('#inp-height').value) || DEFAULT_PROFILE.height;
  state.profile.weight = Number($('#inp-weight').value) || DEFAULT_PROFILE.weight;
  state.profile.gender = $('#sel-gender').value;
  state.profile.bodyType = $('#sel-bodyType').value;
  saveState();
  renderAvatar();
  renderCatalog();
  scheduleAutoDigest();
  if (state.view === 'compare') renderCompare();
  if (state.view === 'wishlist') renderWishlist();
}

function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  ['#inp-height', '#inp-weight', '#sel-gender', '#sel-bodyType'].forEach((sel) => {
    $(sel).addEventListener('input', () => { $('#sel-preset').value = ''; onProfileChange(); });
  });

  $('#sel-preset').addEventListener('change', (e) => {
    const p = BODY_MODELS.presets.find((x) => x.id === e.target.value);
    if (!p) return;
    state.profile = { height: p.height, weight: p.weight, gender: p.gender, bodyType: p.bodyType };
    syncProfileInputs(); onProfileChange();
  });

  // 필터
  $('#search').addEventListener('input', (e) => { state.filters.q = e.target.value; renderCatalog(); });
  $('#filter-category').addEventListener('change', (e) => { state.filters.category = e.target.value; renderCatalog(); });
  $('#filter-gender').addEventListener('change', (e) => { state.filters.gender = e.target.value; renderCatalog(); });
  $('#filter-size').addEventListener('change', (e) => { state.filters.size = e.target.value; renderCatalog(); });
  $('#filter-fit').addEventListener('change', (e) => { state.filters.fitOnly = e.target.checked; renderCatalog(); });

  // 카드 클릭
  $('#catalog-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card'); if (card) openDetail(card.dataset.id);
  });
  $('#catalog-grid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const card = e.target.closest('.card'); if (card) openDetail(card.dataset.id); }
  });

  // 다이얼로그 백드롭
  $('#detail-backdrop').addEventListener('click', (e) => { if (e.target.id === 'detail-backdrop') closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  // 테마 / 리셋
  $('#theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    state.theme = isDark ? 'light' : 'dark';
    applyTheme(); saveState();
  });
  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('신체정보·찜·비교를 모두 초기화할까요?')) return;
    try { localStorage.removeItem(LS_KEY); } catch (_) { /* ignore */ }
    state.profile = { ...DEFAULT_PROFILE };
    state.wishlist = []; state.compare = []; state.theme = null;
    state.filters = { q: '', category: '', gender: '', size: '', fitOnly: false };
    applyTheme(); syncProfileInputs();
    $('#search').value = ''; $('#filter-category').value = ''; $('#filter-gender').value = '';
    $('#filter-size').value = ''; $('#filter-fit').checked = false; $('#sel-preset').value = '';
    renderAvatar(); renderCatalog(); renderCounts(); switchView('catalog');
    renderAutoDigest();
  });
}

// ---------------------------------------------------------------------------
// 부트스트랩
// ---------------------------------------------------------------------------
async function init() {
  loadState();
  applyTheme();
  try {
    const [gRes, bRes] = await Promise.all([
      fetch('./data/garments.json'),
      fetch('./data/body-models.json'),
    ]);
    if (!gRes.ok || !bRes.ok) throw new Error('데이터 로드 실패');
    GARMENTS = (await gRes.json()).garments;
    BODY_MODELS = await bRes.json();
  } catch (err) {
    document.querySelector('.content').innerHTML =
      `<p class="empty">데이터를 불러오지 못했습니다. 로컬 서버(http://)로 열어주세요.<br><small>${esc(err.message)}</small></p>`;
    console.error(err);
    return;
  }
  renderProfileControls();
  renderAvatar();
  renderCatalog();
  renderCounts();
  bindEvents();
  renderAutoDigest(); // 로드 즉시 체형 맞춤 추천 Top 3 자동 생성
}

init();
