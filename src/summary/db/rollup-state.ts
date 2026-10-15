/** Mergeable states shared by persistent daily tables and exact raw boundary queries. */
export interface RollupState {
  name: string;
  expression: string;
  type: 'INTEGER' | 'REAL' | 'TEXT';
  merge: 'SUM' | 'MAX' | 'MIN';
}

const states: RollupState[] = [];
const add = (name: string, expression: string, type: RollupState['type'] = 'INTEGER', merge: RollupState['merge'] = 'SUM'): void => {
  states.push({ name, expression, type, merge });
};
const recorded = '(total_tokens > 0 OR has_model = 1)';
for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) add(field, `SUM(${field})`);
add('turn_count', 'COUNT(*)');
add('completed_turns', "SUM(status = 'completed')");
add('recorded_turns', `SUM(${recorded})`);
add('recorded_completed_turns', `SUM(status = 'completed' AND ${recorded})`);
for (const field of ['cache_write_input_tokens', 'cache_read_input_tokens']) {
  add(field, `coalesce(SUM(${field}),0)`);
  add(`${field}_known`, `COUNT(${field})`);
}
for (const [prefix, condition] of [['c', "status = 'completed'"], ['r', `status = 'completed' AND ${recorded}`]]) {
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens', 'duration_ms']) {
    // AVG(duration_ms) uses floating-point accumulation in the raw query as well.
    const value = field === 'duration_ms' ? '1.0 * duration_ms' : field;
    add(`${prefix}_${field}`, `coalesce(SUM(CASE WHEN ${condition} THEN ${value} END),0)`, field === 'duration_ms' ? 'REAL' : 'INTEGER');
    if (field.startsWith('cache_') || field === 'duration_ms') add(`${prefix}_${field}_known`, `COUNT(CASE WHEN ${condition} THEN ${field} END)`);
  }
  for (const quality of ['exact', 'derived', 'approximate']) add(`${prefix}_${quality}`, `SUM(${condition} AND duration_quality = '${quality}')`);
  add(`${prefix}_duration_missing`, `SUM(${condition} AND duration_ms IS NULL)`);
}
add('unknown_time_turns', 'SUM(started_at_ms IS NULL)');
add('stale_turns', 'SUM(last_error IS NOT NULL)');
add('last_successful_update', 'MAX(updated_at)', 'TEXT', 'MAX');
add('min_started_at_ms', 'MIN(started_at_ms)', 'INTEGER', 'MIN');

export const ROLLUP_STATES: readonly RollupState[] = states;
export const ROLLUP_FORMAT_VERSION = 1;
export const ROLLUP_TABLES = { provider: 'usage_request_daily', model: 'usage_model_daily' } as const;

/** Empty derived tables are migrated immediately; facts are materialized only on first use. */
export const SCHEMA_ROLLUP_SQL = `
CREATE TABLE IF NOT EXISTS usage_rollup_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  timezone TEXT NOT NULL,
  format_version INTEGER NOT NULL
);
${(['provider', 'model'] as const).map(by => `
CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLES[by]} (
  provider TEXT NOT NULL,
  project_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  ${by === 'model' ? 'model TEXT, model_key TEXT NOT NULL,' : ''}
  ${states.map(state => `${state.name} ${state.type}`).join(',\n  ')},
  PRIMARY KEY(provider, session_id, project_key, local_day${by === 'model' ? ', model_key' : ''})
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_${ROLLUP_TABLES[by]}_day ON ${ROLLUP_TABLES[by]}(local_day, provider);
CREATE INDEX IF NOT EXISTS idx_${ROLLUP_TABLES[by]}_project_day ON ${ROLLUP_TABLES[by]}(provider, project_key, local_day);
`).join('')}`;
