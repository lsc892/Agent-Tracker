// 제품 파서와 독립적으로 서버 quota 기대 값과 표시의 일치를 검증한다.
'use strict';

/** 실계정 QA 실패를 원문 데이터가 없는 고정 오류 코드로 전달한다. */
class QaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(condition, code = 'reference-protocol') {
  if (!condition) throw new QaError(code);
}
function identifier(value) {
  // [검증 정책] 보고 대상 ID는 정해진 문자 집합과 길이 안에서만 허용한다.
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(value));
  return value;
}
function percent(value) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return value;
}
function epochSeconds(value) {
  // [시간 정책] 서버의 초 단위 초기화 시각을 밀리초로 맞추고 누락은 null로 둔다.
  if (value == null) return null;
  requireValue(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e12);
  return value * 1000;
}
/**
 * 책임: 실제 Claude 서버 응답으로부터 제품 파서와 독립적인 기대 값을 만든다.
 * 알고리즘: usage 창을 직접 순회해 ID·사용률·초기화 날짜·창 개수를 검증하고 비교에 필요한 필드만 정규화한다.
 */
function expectedClaude(body) {
  requireValue(record(body));
  // [파싱 정책] 유효한 사용률이 있는 Claude 창만 고르고 이름 접두사에서 기간을 읽는다.
  const windows = Object.entries(body).filter(([, row]) => record(row) && row.utilization != null).map(([id, row]) => {
    let resetsAt = null;
    if (row.resets_at != null) {
      requireValue(typeof row.resets_at === 'string');
      resetsAt = Date.parse(row.resets_at);
      requireValue(Number.isFinite(resetsAt));
    }
    return { id: identifier(id), usedPercent: percent(row.utilization), resetsAt,
      windowDurationMins: id.startsWith('five_hour') ? 300 : id.startsWith('seven_day') ? 10080 : null };
  });
  requireValue(windows.length > 0 && windows.length <= 100);
  return { provider: 'claude', windows };
}
/**
 * 책임: 실제 Codex 응답의 한도와 초기화 크레딧 기대 값을 독립 계산한다.
 * 알고리즘: 명시 한도 맵을 우선하고 창별 초 단위를 변환하며 크레딧 개수는 서버 필드, 만료는 유효 항목의 최솟값을 사용한다.
 */
function expectedCodex(body) {
  requireValue(record(body));
  // [파싱 정책] 한도 ID별 목록을 우선하고 없으면 단일 Codex 한도를 사용한다.
  const buckets = body.rateLimitsByLimitId == null ? { codex: body.rateLimits } : body.rateLimitsByLimitId;
  requireValue(record(buckets));
  const windows = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    requireValue(record(bucket));
    const limitId = identifier(typeof bucket.limitId === 'string' ? bucket.limitId : key);
    for (const period of ['primary', 'secondary']) {
      const row = bucket[period];
      if (row == null) continue;
      requireValue(record(row));
      const minutes = row.windowDurationMins ?? null;
      requireValue(minutes === null || (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0));
      windows.push({ id: `${limitId}:${period}`, limitId, usedPercent: percent(row.usedPercent),
        resetsAt: epochSeconds(row.resetsAt), windowDurationMins: minutes });
    }
  }
  requireValue(windows.length > 0 && windows.length <= 100);
  const expected = { provider: 'codex', windows };
  // [집계 정책] 서버의 가용 개수와 지원되는 크레딧 중 가장 이른 만료를 별도로 보존한다.
  const credits = body.rateLimitResetCredits;
  if (record(credits) && Number.isSafeInteger(credits.availableCount) && credits.availableCount >= 0) {
    const expiry = credits.availableCount > 0 && Array.isArray(credits.credits) ? credits.credits
      .filter(row => record(row) && row.status === 'available' && row.resetType === 'codexRateLimits'
        && typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) && row.expiresAt >= 0 && row.expiresAt <= 8.64e12)
      .map(row => row.expiresAt * 1000) : [];
    expected.rateLimitResetCredits = { availableCount: credits.availableCount,
      nextExpiresAt: expiry.length ? Math.min(...expiry) : null };
  }
  return expected;
}
/**
 * 책임: 제품의 quota 결과가 같은 서버 응답과 정확히 일치하는지 확인한다.
 * 알고리즘: 제공자·창 개수·ID 유일성을 확인하고 각 사용률·시각·기간·크레딧 필드를 기대 값과 엄격 비교한다.
 */
function compareSnapshot(snapshot, expected) {
  requireValue(snapshot?.provider === expected.provider && Number.isFinite(snapshot.fetchedAt), 'snapshot-mismatch');
  requireValue(Array.isArray(snapshot.windows) && snapshot.windows.length === expected.windows.length, 'snapshot-mismatch');
  // [검증 정책] 응답 창을 ID로 대조하고 각 창의 수치와 초기화 필드가 정확히 일치하는지 확인한다.
  const ids = new Set();
  for (const row of expected.windows) {
    const actual = snapshot.windows.find(window => window.id === row.id);
    requireValue(actual && !ids.has(actual.id), 'snapshot-mismatch');
    ids.add(actual.id);
    for (const field of ['usedPercent', 'resetsAt', 'windowDurationMins', 'limitId']) {
      requireValue(actual[field] === row[field], 'snapshot-mismatch');
    }
    requireValue(actual.current === row.usedPercent && actual.maximum === 100, 'snapshot-mismatch');
  }
  for (const field of ['availableCount', 'nextExpiresAt']) {
    requireValue(snapshot.rateLimitResetCredits?.[field] === expected.rateLimitResetCredits?.[field], 'snapshot-mismatch');
  }
}
/**
 * 책임: quota 표시 모드별 백분율과 막대가 서버 값과 맞는지 검증한다.
 * 알고리즘: 상세·간단 및 사용·잔여 조합을 순회해 선택 창의 반올림 백분율·10단계 막대를 독립 계산하고 표시 결과에서 추출한 값과 비교한다.
 */
function checkPresentation(snapshot, expected, present) {
  const state = { provider: snapshot.provider, snapshot, status: 'ready', refreshing: false,
    lastSuccessAt: snapshot.fetchedAt, error: null, nextAllowedAt: 0 };
  // [표시 정책] Codex 기본 한도를 우선하고 창 이름 또는 분 단위 기간으로 5시간·주간 창을 찾는다.
  const codex = expected.windows.filter(row => row.limitId === 'codex');
  const windows = codex.length ? codex : expected.windows;
  const five = windows.find(row => row.id === 'five_hour') ?? windows.find(row => row.windowDurationMins === 300);
  const week = windows.find(row => row.id === 'seven_day') ?? windows.find(row => row.windowDurationMins === 10080);
  const result = {};
  // [검증 정책] 화면 모드 조합별로 기대 백분율과 열 단계 막대를 계산해 출력과 대조한다.
  for (const detail of ['detailed', 'compact']) {
    const selected = detail === 'compact' ? (five ? [five] : []) : five || week ? [week, five].filter(Boolean) : windows.slice(0, 2);
    for (const mode of ['used', 'remaining']) {
      const view = present(state, mode, detail, snapshot.fetchedAt);
      const numbers = [...view.text.matchAll(/(\d+)% (?:사용|남음)/g)].map(match => Number(match[1]));
      const wanted = selected.map(row => {
        const used = Math.max(0, Math.min(100, row.usedPercent));
        return Math.round(mode === 'used' ? used : 100 - used);
      });
      requireValue(JSON.stringify(numbers) === JSON.stringify(wanted), 'presentation-mismatch');
      const bars = [...view.text.matchAll(/\$\(agent-tracker-quota-(\d+)\)/g)].map(match => Number(match[1]));
      const wantedBars = selected.map(row => {
        const used = Math.max(0, Math.min(100, row.usedPercent));
        return Math.round((mode === 'used' ? used : 100 - used) / 10);
      });
      requireValue(JSON.stringify(bars) === JSON.stringify(wantedBars), 'presentation-mismatch');
      result[`${detail}-${mode}`] = numbers;
    }
  }
  return result;
}
module.exports = { QaError, requireValue, expectedClaude, expectedCodex, compareSnapshot, checkPresentation };
