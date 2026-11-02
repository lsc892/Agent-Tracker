// 제공자·모델 기준의 요청 원본과 이름·비용 projection을 구성한다.
import type { UsageBasis } from '../common/types';

export const RECORDED_USAGE = '(total_tokens > 0 OR has_model = 1)';

// #region 모델별 원본 열

// NULL means usage was not recorded; '' means recorded usage has an unknown model.
const MODEL_NAME = `CASE
  WHEN coalesce(m.model, '') = ''
    AND coalesce(m.input_tokens + m.output_tokens, t.total_tokens) = 0
  THEN NULL
  ELSE coalesce(m.model, '')
END AS model`;

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
  const costColumns = costs ? `, ${MODEL_COSTS}` : '';
  const costJoin = costs ? 'LEFT JOIN turn_costs c ON c.turn_id = t.id' : '';
  return `(
    SELECT
      t.id,
      t.provider,
      t.project_key,
      t.session_id,
      t.root_turn_id,
      t.request_title,
      coalesce(m.model, '') <> '' AS has_model,
      t.started_at_ms,
      t.completed_at_ms,
      t.duration_ms,
      t.duration_quality,
      t.status,
      t.quality_flags,
      t.diagnostic_file_id,
      t.diagnostic_offset,
      t.last_error,
      t.updated_at,
      ${MODEL_NAME},
      ${MODEL_TOKENS},
      coalesce(m.input_tokens + m.output_tokens, t.total_tokens) AS total_tokens${costColumns}
    FROM turn_summary t
    LEFT JOIN turn_model_usage m ON m.turn_id = t.id
    ${costJoin}
  )`;
}

// #endregion

// #region 제공자·모델 공통 원본과 이름

/**
 * 책임: 제공자·모델 기준 집계가 사용할 요청 원본 projection을 만든다.
 * 알고리즘: 모델 기준은 LEFT JOIN으로 기록 부재·모델 미상을 보존하고 제공자 기준은 요청을 유지하며 비용 열은 요청될 때만 연결한다.
 */
export function usageTurns(costs = false, by: UsageBasis = 'provider'): string {
  if (by === 'model') return modelTurns(costs);
  if (by !== 'provider') throw new RangeError('Unknown usage grouping basis');

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
      EXISTS(
        SELECT 1
        FROM turn_model_usage m
        WHERE m.turn_id = t.id AND m.model <> ''
      ) AS has_model
    FROM ${source} t
  )`;
}

export function namedTurns(costs = false, by: UsageBasis = 'provider'): string {
  return `(
    SELECT
      t.*,
      p.project_name,
      s.session_name
    FROM ${usageTurns(costs, by)} t
    JOIN projects p ON p.project_key = t.project_key
    JOIN sessions s ON s.provider = t.provider AND s.session_id = t.session_id
  )`;
}

// #endregion
