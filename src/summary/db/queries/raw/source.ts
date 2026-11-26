// 이전 DB의 일별 이관과 기존 SQL 검증에 필요한 스레드 열을 구성한다.
import type { UsageBasis } from '../common/types';

export const RECORDED_USAGE = '(total_tokens > 0 OR has_model = 1)';

const TURN_DIMENSIONS = 't.provider, t.project_key, t.session_id, t.started_at_ms, t.duration_ms, t.duration_quality, t.status';

const HAS_MODEL = `EXISTS(
        SELECT 1 FROM turn_model_usage m WHERE m.turn_id = t.id AND m.model <> ''
      ) AS has_model`;

// #region 모델별 원본 열

// [집계 정책] NULL은 사용량 기록 부재, 빈 문자열은 기록된 사용량의 모델 미상을 뜻한다.
const MODEL_NAME = `CASE
  WHEN coalesce(m.model, '') = ''
    AND coalesce(m.input_tokens + m.output_tokens, t.total_tokens) = 0
  THEN NULL
  ELSE coalesce(m.model, '')
END AS model`;

// [집계 정책] 모델 행이 없을 때 요청 토큰을 사용하고 모델 행이 있으면 해당 행의 캐시 값을 보존한다.
const MODEL_TOKENS = `
  coalesce(m.input_tokens, t.input_tokens) AS input_tokens,
  coalesce(m.output_tokens, t.output_tokens) AS output_tokens,
  CASE
    WHEN m.turn_id IS NULL THEN t.cache_write_input_tokens
    ELSE m.cache_write_input_tokens
  END AS cache_write_input_tokens,
  CASE
    WHEN m.turn_id IS NULL THEN t.cache_read_input_tokens
    ELSE m.cache_read_input_tokens
  END AS cache_read_input_tokens`;

const MODEL_USAGE = `
      coalesce(m.model, '') <> '' AS has_model,
      ${MODEL_NAME},
      ${MODEL_TOKENS},
      coalesce(m.input_tokens + m.output_tokens, t.total_tokens) AS total_tokens`;

const MODEL_COSTS = `
  coalesce(c.billing_mode, 'unknown') AS billing_mode,
  CASE
    WHEN c.billing_mode = 'subscription' THEN 0
    WHEN c.billing_mode = 'api' THEN m.estimated_cost_usd
  END AS cost_usd,
  CASE
    WHEN c.billing_mode = 'subscription'
      OR c.billing_mode = 'api' AND m.estimated_cost_usd IS NOT NULL
    THEN 0
    ELSE 1
  END AS unknown_costs`;

function modelTurns(costs: boolean): string {
  // [SQL 조회 정책] 모델 행이 없는 요청도 LEFT JOIN으로 유지하고 비용이 필요할 때만 비용 표를 조인한다.
  return `(
    SELECT
      ${TURN_DIMENSIONS},
      ${MODEL_USAGE}${costs ? `, ${MODEL_COSTS}` : ''}
    FROM turn_summary t
    LEFT JOIN turn_model_usage m ON m.turn_id = t.id
    ${costs ? 'LEFT JOIN turn_costs c ON c.turn_id = t.id' : ''}
  )`;
}

// #endregion

// #region 제공자·모델 공통 원본과 이름

/**
 * 책임: 제공자·모델 기준 집계가 사용할 요청 원본 projection을 만든다.
 * 알고리즘: 모델 기준은 LEFT JOIN으로 기록 부재·모델 미상을 보존하고 제공자 기준은 요청을 유지하며 비용 열은 요청될 때만 연결한다.
 */
export function usageTurns(costs = false, by: UsageBasis = 'provider'): string {
  // [집계 정책] 모델 기준은 모델 행으로 펼치고 제공자 기준은 요청마다 한 행을 유지한다.
  if (by === 'model') return modelTurns(costs);
  if (by !== 'provider') throw new RangeError('Unknown usage grouping basis');

  // [결제 정책] 제공자 조회는 비용 옵션이 켜진 경우에만 요청 비용과 결제 방식을 읽는다.
  const source = costs ? `(
    SELECT
      t.*,
      c.cost_usd,
      coalesce(c.unknown_costs, 1) AS unknown_costs,
      coalesce(c.billing_mode, 'unknown') AS billing_mode
    FROM turn_summary t
    LEFT JOIN turn_costs c ON c.turn_id = t.id
  )` : 'turn_summary';
  return `(
    SELECT
      t.*,
      ${HAS_MODEL}
    FROM ${source} t
  )`;
}

/** 일별 이관은 사용량 열과 결제 방식에 독립적인 API 추정치만 읽는다. */
export function rollupUsageTurns(by: UsageBasis): string {
  // [집계 정책] 모델별 이관에서는 비용 표본을 모델 행마다 하나씩 기록한다.
  if (by === 'model') return `(
    SELECT
      ${TURN_DIMENSIONS},
      ${MODEL_USAGE},
      m.estimated_cost_usd AS api_cost_usd,
      m.estimated_cost_usd IS NULL AS api_unknown_costs,
      1 AS cost_components,
      coalesce(c.billing_mode, 'unknown') AS default_billing_mode
    FROM turn_summary t
    LEFT JOIN turn_model_usage m ON m.turn_id = t.id
    LEFT JOIN turn_costs c ON c.turn_id = t.id
  )`;

  // [집계 정책] 제공자별 이관에서는 모델의 API 추정치와 표본 수를 요청별로 먼저 합산한다.
  return `(
    SELECT
      ${TURN_DIMENSIONS},
      t.input_tokens, t.output_tokens, t.total_tokens, t.cache_write_input_tokens, t.cache_read_input_tokens,
      coalesce(m.has_model, 0) AS has_model,
      m.api_cost_usd,
      coalesce(m.api_unknown_costs, 1) AS api_unknown_costs,
      coalesce(m.cost_components, 1) AS cost_components,
      coalesce(c.billing_mode, 'unknown') AS default_billing_mode
    FROM turn_summary t
    LEFT JOIN (
      SELECT turn_id, MAX(model <> '') AS has_model, SUM(estimated_cost_usd) AS api_cost_usd,
        COUNT(*) - COUNT(estimated_cost_usd) AS api_unknown_costs, COUNT(*) AS cost_components
      FROM turn_model_usage
      GROUP BY turn_id
    ) m ON m.turn_id = t.id
    LEFT JOIN turn_costs c ON c.turn_id = t.id
  )`;
}

// #endregion
