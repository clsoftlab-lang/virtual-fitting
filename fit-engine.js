// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CLSOFTLAB (씨엘소프트랩), Dr. Lee Il-guk (이일국)
//
// fit-engine.js — 규칙/기하 기반 사이즈·핏 추정 엔진
// =====================================================================
// 이 모듈은 머신러닝이나 3D 스캔 없이, 공개된 인체 계측 근사식과
// 의류 사이즈표를 비교하여 "부위별 여유(ease)"를 계산하고 추천 사이즈와
// 핏 배지(넉넉/적당/타이트)를 산출한다. 모든 계산은 결정론적이며
// 문서화되어 있어 Node 환경에서 단위 테스트가 가능하다.
//
// 핵심 개념
//   1) estimateBody(profile): 키/몸무게/성별/체형 → 신체 둘레 추정치(cm)
//   2) evaluateSize(body, garment, size): 부위별 ease = 의류치수 - 신체치수
//   3) classifyEase(): ease 를 권장 여유 밴드와 비교해 tight/good/loose 분류
//   4) recommendSize(): 전체 사이즈 중 penalty(권장 밴드 이탈량) 최소 사이즈 선택
// =====================================================================

/**
 * 신체 둘레 추정 계수.
 * body 부위 = A[gender] * height(cm) + B * (weight - idealWeight) + typeAdj
 * idealWeight 는 BMI 22 기준 이상 체중(kg). dW = 실제-이상.
 * 계수는 공개 인체계측 경향(키 비례 + 체중 편차 보정)을 근사한 값으로,
 * 상용 3D 스캔이 아닌 "설명 가능한 규칙 기반" 추정치임을 명시한다.
 */
export const BODY_COEFFS = {
  men:   { chest: 0.514, waist: 0.420, hip: 0.510, shoulder: 0.245, sleeve: 0.345, thigh: 0.290, topLen: 0.400, botLen: 0.600 },
  women: { chest: 0.530, waist: 0.400, hip: 0.560, shoulder: 0.205, sleeve: 0.315, thigh: 0.310, topLen: 0.375, botLen: 0.585 },
};

// 체중 편차(kg당) 둘레 증가 계수 — 성별 공통.
export const WEIGHT_COEFFS = { chest: 0.60, waist: 0.80, hip: 0.55, shoulder: 0.05, sleeve: 0.02, thigh: 0.30 };

// 체형(bodyType)별 보정치(cm). standard=0 기준.
export const BODY_TYPE_ADJ = {
  slim:     { chest: -3, waist: -4, hip: -3, thigh: -2, shoulder: -1 }, // 마른형
  standard: { chest:  0, waist:  0, hip:  0, thigh:  0, shoulder:  0 }, // 표준형
  athletic: { chest:  3, waist: -2, hip:  0, thigh:  2, shoulder:  2 }, // 운동/근육형
  curvy:    { chest:  2, waist:  1, hip:  4, thigh:  3, shoulder:  0 }, // 굴곡형
  plus:     { chest:  5, waist:  7, hip:  5, thigh:  4, shoulder:  1 }, // 통통형
};

// 카테고리별 부위 목록.
export const CATEGORY_REGIONS = {
  top:   ['chest', 'waist', 'shoulder', 'sleeve', 'length'],
  outer: ['chest', 'waist', 'shoulder', 'sleeve', 'length'],
  dress: ['chest', 'waist', 'hip', 'length'],
  bottom:['waist', 'hip', 'thigh', 'length'],
};

// 부위 한글 라벨.
export const REGION_LABELS = {
  chest: '가슴', waist: '허리', hip: '엉덩이', shoulder: '어깨',
  sleeve: '소매', thigh: '허벅지', length: '기장',
};

/**
 * 권장 여유(ease) 밴드(cm). [min, max] 안이면 '적당'.
 * min 미만 = 타이트, max 초과 = 넉넉. 카테고리별로 다르다.
 * length 는 기장 여유(의류길이 - 신체목표길이).
 */
export const EASE_PROFILES = {
  top:    { chest: [6, 16],  waist: [4, 22], shoulder: [-1, 3], sleeve: [-2, 3], length: [-3, 7] },
  outer:  { chest: [10, 24], waist: [8, 28], shoulder: [0, 5],  sleeve: [-1, 4], length: [-2, 10] },
  dress:  { chest: [4, 14],  waist: [4, 16], hip: [3, 14],      length: [-4, 8] },
  bottom: { waist: [0, 5],   hip: [2, 9],    thigh: [2, 9],     length: [-2, 4] },
};

// penalty 가중치 — 상체는 가슴, 하체는 허리가 지배적.
export const REGION_WEIGHTS = {
  chest: 1.0, waist: 0.9, hip: 0.8, shoulder: 0.7, thigh: 0.6, sleeve: 0.4, length: 0.4,
};

// 카테고리별 대표 부위(핏 배지 산출 기준).
export const PRIMARY_REGION = { top: 'chest', outer: 'chest', dress: 'chest', bottom: 'waist' };

const round1 = (n) => Math.round(n * 10) / 10;

/** BMI 22 기준 이상 체중(kg). */
export function idealWeight(heightCm) {
  const h = heightCm / 100;
  return 22 * h * h;
}

/** 성별 계수 반환(men/women/그 외=평균). */
function coeffsFor(gender) {
  if (gender === 'men') return BODY_COEFFS.men;
  if (gender === 'women') return BODY_COEFFS.women;
  // unisex / other → 남녀 평균
  const m = BODY_COEFFS.men, w = BODY_COEFFS.women, avg = {};
  for (const k of Object.keys(m)) avg[k] = (m[k] + w[k]) / 2;
  return avg;
}

/**
 * 신체 프로파일 → 추정 신체 둘레(cm).
 * @param {{height:number, weight:number, gender:string, bodyType:string}} profile
 * @returns {{chest,waist,hip,shoulder,sleeve,thigh,topLen,botLen,height,weight,bmi,gender,bodyType}}
 */
export function estimateBody(profile) {
  const h = Number(profile.height);
  const w = Number(profile.weight);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) {
    throw new Error('estimateBody: height/weight 는 양수여야 합니다.');
  }
  const gender = profile.gender || 'unisex';
  const bodyType = profile.bodyType || 'standard';
  const A = coeffsFor(gender);
  const B = WEIGHT_COEFFS;
  const T = BODY_TYPE_ADJ[bodyType] || BODY_TYPE_ADJ.standard;
  const dW = w - idealWeight(h);
  const bmi = w / ((h / 100) * (h / 100));

  const chest    = A.chest * h + B.chest * dW + T.chest;
  const waist    = A.waist * h + B.waist * dW + T.waist;
  const hip      = A.hip   * h + B.hip   * dW + T.hip;
  const shoulder = A.shoulder * h + B.shoulder * dW + T.shoulder;
  const sleeve   = A.sleeve * h + B.sleeve * dW;
  const thigh    = A.thigh * h + B.thigh * dW + T.thigh;
  const topLen   = A.topLen * h;   // 상의 기준 기장(신체 목표)
  const botLen   = A.botLen * h;   // 하의 기준 총장(신체 목표)

  return {
    chest: round1(chest), waist: round1(waist), hip: round1(hip),
    shoulder: round1(shoulder), sleeve: round1(sleeve), thigh: round1(thigh),
    topLen: round1(topLen), botLen: round1(botLen),
    height: h, weight: w, bmi: round1(bmi), gender, bodyType,
  };
}

/** 신체의 해당 부위 목표 치수. length 는 카테고리에 따라 상/하의 기준 길이. */
function bodyTargetFor(body, region, category) {
  if (region === 'length') return category === 'bottom' ? body.botLen : body.topLen;
  return body[region];
}

/**
 * ease(cm) 와 권장 밴드를 비교해 핏 등급 분류.
 * @returns {{fit:'tight'|'good'|'loose', deviation:number}}
 *   deviation: 밴드 이탈량(cm, good 이면 0).
 */
export function classifyEase(ease, band) {
  const [min, max] = band;
  if (ease < min) return { fit: 'tight', deviation: round1(min - ease) };
  if (ease > max) return { fit: 'loose', deviation: round1(ease - max) };
  return { fit: 'good', deviation: 0 };
}

export const FIT_BADGE_KO = { tight: '타이트', good: '적당', loose: '넉넉' };

/**
 * 특정 사이즈에 대한 부위별 핏 평가.
 * @param {object} bodyOrProfile estimateBody 결과 또는 프로파일
 * @param {object} garment 카탈로그 항목(sizes 포함)
 * @param {string} size 사이즈 키
 */
export function evaluateSize(bodyOrProfile, garment, size) {
  const body = bodyOrProfile.chest != null && bodyOrProfile.topLen != null
    ? bodyOrProfile : estimateBody(bodyOrProfile);
  const chart = garment.sizes[size];
  if (!chart) throw new Error(`evaluateSize: '${garment.id}' 에 사이즈 '${size}' 없음`);
  const category = garment.category;
  const easeProfile = EASE_PROFILES[category] || EASE_PROFILES.top;
  const regions = (CATEGORY_REGIONS[category] || CATEGORY_REGIONS.top)
    .filter((r) => chart[r] != null && easeProfile[r] != null);

  const detail = {};
  let penalty = 0;
  for (const region of regions) {
    const bodyVal = bodyTargetFor(body, region, category);
    const ease = round1(chart[region] - bodyVal);
    const band = easeProfile[region];
    const { fit, deviation } = classifyEase(ease, band);
    penalty += deviation * (REGION_WEIGHTS[region] || 0.5);
    detail[region] = { region, label: REGION_LABELS[region], garment: chart[region], body: round1(bodyVal), ease, band, fit, deviation };
  }

  const primary = PRIMARY_REGION[category] || 'chest';
  const primaryFit = detail[primary] ? detail[primary].fit : 'good';
  const score = Math.max(0, Math.round(100 - penalty * 4));

  return {
    size,
    category,
    detail,
    penalty: round1(penalty),
    score,
    primaryRegion: primary,
    badge: primaryFit,          // 'tight' | 'good' | 'loose'
    badgeKo: FIT_BADGE_KO[primaryFit],
  };
}

/**
 * 의류 전체 사이즈를 평가하고 추천 사이즈를 결정.
 * 추천 = penalty 최소. 동점이면 good 부위 많은 쪽, 그다음 사이즈표 순서(작은 쪽).
 * @returns {{recommended:string|null, best:object|null, evaluations:object[]}}
 */
export function recommendSize(profile, garment) {
  const body = profile.chest != null && profile.topLen != null ? profile : estimateBody(profile);
  const sizeKeys = Object.keys(garment.sizes);
  const evaluations = sizeKeys.map((s) => evaluateSize(body, garment, s));

  const goodCount = (ev) => Object.values(ev.detail).filter((d) => d.fit === 'good').length;

  let best = null;
  evaluations.forEach((ev, idx) => {
    if (!best) { best = { ev, idx }; return; }
    if (ev.penalty < best.ev.penalty - 1e-9) { best = { ev, idx }; return; }
    if (Math.abs(ev.penalty - best.ev.penalty) <= 1e-9) {
      const g = goodCount(ev), bg = goodCount(best.ev);
      if (g > bg) best = { ev, idx };          // good 부위 더 많은 쪽
      // 동점이면 먼저 나온(작은) 사이즈 유지
    }
  });

  return {
    recommended: best ? best.ev.size : null,
    best: best ? best.ev : null,
    evaluations,
    body,
  };
}

// 기본 내보내기(브라우저 편의).
export default {
  BODY_COEFFS, WEIGHT_COEFFS, BODY_TYPE_ADJ, CATEGORY_REGIONS, REGION_LABELS,
  EASE_PROFILES, REGION_WEIGHTS, PRIMARY_REGION, FIT_BADGE_KO,
  idealWeight, estimateBody, classifyEase, evaluateSize, recommendSize,
};
