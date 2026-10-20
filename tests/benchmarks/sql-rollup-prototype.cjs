// Benchmark-only materialized aggregate candidate. Nothing in src imports this file.
const assert = require('node:assert/strict');
const { buildUsageQuery, buildUsageCountQuery, buildQueryFilter } = require('../../dist/src/summary/db/queries');
const { calendarPeriod, periodBounds } = require('../../dist/src/summary/db/timezone');

const TIMEZONE = 'Asia/Seoul';
const DAY = 86400000;
const tables = { provider: 'bench_request_daily', model: 'bench_model_daily' };
const recorded = '(total_tokens > 0 OR has_model = 1)';
const states = [];
const add = (name, sql, type = 'INTEGER', merge = 'SUM') => states.push({ name, sql, type, merge });
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
    add(`${prefix}_${field}`, `coalesce(SUM(CASE WHEN ${condition} THEN ${field} END),0)`);
    if (field.startsWith('cache_') || field === 'duration_ms') add(`${prefix}_${field}_known`, `COUNT(CASE WHEN ${condition} THEN ${field} END)`);
  }
  for (const quality of ['exact', 'derived', 'approximate']) add(`${prefix}_${quality}`, `SUM(${condition} AND duration_quality = '${quality}')`);
  add(`${prefix}_duration_missing`, `SUM(${condition} AND duration_ms IS NULL)`);
}
add('unknown_time_turns', 'SUM(started_at_ms IS NULL)');
add('stale_turns', 'SUM(last_error IS NOT NULL)');
add('last_successful_update', 'MAX(updated_at)', 'TEXT', 'MAX');

function rawSource(by) {
  const sql = buildUsageQuery({}, 'total', TIMEZONE, by).sql;
  const match = /\n    FROM ([\s\S]*) AS turn_summary\n    WHERE /.exec(sql);
  assert.ok(match, 'Production source SQL shape changed');
  return match[1];
}

function aggregateSource(by, where = '1=1') {
  const model = by === 'model' ? ", model, CASE WHEN model IS NULL THEN 'N' ELSE 'V' || model END AS model_key" : '';
  const groups = `provider, project_key, session_id, local_day${by === 'model' ? ', model_key' : ''}`;
  return `SELECT provider,project_key,session_id,coalesce(agent_tracker_period(started_at_ms,'${TIMEZONE}','day'),'') AS local_day${model},
    ${states.map(state => `${state.sql} AS ${state.name}`).join(',\n    ')}
    FROM ${rawSource(by)} AS turn_summary WHERE ${where} GROUP BY ${groups}`;
}

function install(db) {
  for (const by of ['provider', 'model']) {
    const table = tables[by];
    db.connection.exec(`CREATE TABLE ${table} (
      provider TEXT NOT NULL,project_key TEXT NOT NULL,session_id TEXT NOT NULL,local_day TEXT NOT NULL,
      ${by === 'model' ? 'model TEXT,model_key TEXT NOT NULL,' : ''}
      ${states.map(state => `${state.name} ${state.type}`).join(',')},
      PRIMARY KEY(provider,session_id,project_key,local_day${by === 'model' ? ',model_key' : ''})
    ) WITHOUT ROWID;
    CREATE INDEX ${table}_day ON ${table}(local_day,provider);
    CREATE INDEX ${table}_project_day ON ${table}(provider,project_key,local_day);`);
  }
}

function refresh(db, sessions) {
  const filtered = sessions !== undefined;
  if (filtered && sessions.length === 0) return;
  let where = '1=1', values = [];
  if (filtered) {
    // A row-value set preserves session-prefix seeks and avoids a correlated full facts scan.
    db.connection.exec('CREATE TEMP TABLE IF NOT EXISTS bench_changed_sessions(provider TEXT,session_id TEXT,PRIMARY KEY(provider,session_id)) WITHOUT ROWID; DELETE FROM bench_changed_sessions');
    const insert = db.connection.prepare('INSERT INTO bench_changed_sessions VALUES (?,?)');
    for (const session of sessions) insert.run(session.provider, session.session_id);
    where = '(provider,session_id) IN (SELECT provider,session_id FROM bench_changed_sessions)';
  }
  for (const by of ['provider', 'model']) {
    const table = tables[by];
    db.connection.exec(`DELETE FROM ${table}${filtered ? ` WHERE ${where}` : ''}`);
    db.connection.prepare(`INSERT INTO ${table} ${aggregateSource(by, where)}`).run(...values);
  }
}

function effectiveFilter(filter, groupBy) {
  return ['day', 'month'].includes(groupBy) && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter;
}

function sources(filter, groupBy, by) {
  const f = effectiveFilter(filter, groupBy);
  buildQueryFilter(f); // Preserve the product's integer/range validation before decomposing dates.
  const dimensions = { ...f, fromMs: undefined, toMs: undefined, unknownTime: undefined };
  const base = buildQueryFilter(dimensions);
  const knownAllowed = f.unknownTime !== 'only';
  const unknownAllowed = f.unknownTime === 'only' || f.unknownTime === 'include'
    || f.unknownTime !== 'exclude' && f.fromMs === undefined && f.toMs === undefined;
  let start, end;
  if (f.fromMs !== undefined) {
    const bounds = periodBounds(calendarPeriod(f.fromMs, TIMEZONE, 'day'), TIMEZONE);
    start = f.fromMs === bounds.fromMs ? bounds.fromMs : bounds.toMs;
  }
  if (f.toMs !== undefined) end = periodBounds(calendarPeriod(f.toMs, TIMEZONE, 'day'), TIMEZONE).fromMs;
  const dayStart = start === undefined ? undefined : calendarPeriod(start, TIMEZONE, 'day');
  const dayEnd = end === undefined ? undefined : calendarPeriod(end, TIMEZONE, 'day');
  const full = ["local_day <> ''"];
  const fullValues = [];
  if (!knownAllowed || start !== undefined && end !== undefined && start >= end) full.push('0=1');
  else {
    if (dayStart !== undefined) { full.push('local_day >= ?'); fullValues.push(dayStart); }
    if (dayEnd !== undefined) { full.push('local_day < ?'); fullValues.push(dayEnd); }
  }
  const whole = `(${full.join(' AND ')})`;
  const rollupWhere = `${base.sql} AND (${whole}${unknownAllowed ? " OR local_day = ''" : ''})`;
  const rollupValues = [...base.values, ...fullValues];
  const columns = `provider,project_key,session_id,local_day${by === 'model' ? ',model,model_key' : ''},${states.map(s => s.name).join(',')}`;
  let sql = `SELECT ${columns} FROM ${tables[by]} AS turn_summary WHERE ${rollupWhere}`;
  const values = [...rollupValues];
  let boundary;
  // Full rollup days and exact raw boundary ranges are disjoint. Unknown time stays in the rollup.
  if (knownAllowed && (f.fromMs !== undefined && start !== f.fromMs || f.toMs !== undefined && end !== f.toMs)) {
    const raw = buildQueryFilter({ ...f, unknownTime: 'exclude' });
    const outside = [];
    const outsideValues = [];
    if (start !== undefined) { outside.push('started_at_ms < ?'); outsideValues.push(start); }
    if (end !== undefined) { outside.push('started_at_ms >= ?'); outsideValues.push(end); }
    boundary = { where: `${raw.sql} AND (${outside.join(' OR ')})`, values: [...raw.values, ...outsideValues] };
    sql += ` UNION ALL ${aggregateSource(by, boundary.where)}`;
    values.push(...boundary.values);
  }
  return { sql, values, rollupWhere, rollupValues, boundary };
}

function mergeMetrics(excludeEmptyUsage) {
  const sum = field => `SUM(${field})`;
  const average = (field, denominator) => `1.0 * SUM(${field}) / NULLIF(SUM(${denominator}),0)`;
  const prefix = excludeEmptyUsage ? 'r' : 'c';
  const denominator = excludeEmptyUsage ? 'recorded_completed_turns' : 'completed_turns';
  return [
    ...['input_tokens', 'output_tokens'].map(field => `${sum(field)} AS ${field}`),
    ...['cache_write_input_tokens', 'cache_read_input_tokens'].map(field => `CASE WHEN ${sum(`${field}_known`)} = ${sum('turn_count')} THEN ${sum(field)} END AS ${field}`),
    ...['total_tokens','turn_count','completed_turns','recorded_turns','recorded_completed_turns'].map(field => `${sum(field)} AS ${field}`),
    ...[['total_tokens','avg_tokens_per_turn'],['input_tokens','avg_input_tokens'],['output_tokens','avg_output_tokens']].map(([field, alias]) => `${average(`${prefix}_${field}`,denominator)} AS ${alias}`),
    ...['cache_write_input_tokens','cache_read_input_tokens'].map(field => `CASE WHEN ${sum(`${prefix}_${field}_known`)}=${sum(denominator)} THEN ${average(`${prefix}_${field}`,denominator)} END AS avg_${field}`),
    `${average(`${prefix}_duration_ms`,`${prefix}_duration_ms_known`)} AS avg_duration_ms`,
    `${sum(`${prefix}_duration_ms_known`)} AS turns_with_duration`,
    ...['exact','derived','approximate'].map(quality => `${sum(`${prefix}_${quality}`)} AS ${quality}_duration_turns`),
    `${sum(`${prefix}_duration_missing`)} AS missing_duration_turns`,
    ...['unknown_time_turns','stale_turns'].map(field => `${sum(field)} AS ${field}`),
    'MAX(last_successful_update) AS last_successful_update',
  ].join(',\n');
}

function build(filter, groupBy, timezone, by, sortBy) {
  buildQueryFilter(filter);
  const invalidCalendarRange = [filter.fromMs,filter.toMs].some(ms => ms !== undefined && !Number.isFinite(new Date(ms).getTime()));
  if (timezone !== TIMEZONE || filter.includeCosts || invalidCalendarRange) return {
    mode: 'raw-fallback', reason: timezone !== TIMEZONE ? 'rollup materialized only for Asia/Seoul' : filter.includeCosts ? 'billing/cost states excluded from this prototype' : 'epoch range outside JavaScript calendar support',
    rows: buildUsageQuery(filter,groupBy,timezone,by,sortBy), count: buildUsageCountQuery(filter,groupBy,timezone,by),
  };
  const source = sources(filter,groupBy,by);
  const project = ['project','session'].includes(groupBy), session = groupBy === 'session', calendar = ['day','month'].includes(groupBy);
  const period = groupBy === 'day' ? "NULLIF(local_day,'')" : groupBy === 'month' ? "substr(NULLIF(local_day,''),1,7)" : 'NULL';
  const groups = ['provider', ...(by === 'model' ? ['model'] : []), ...(project ? ['project_key'] : []), ...(session ? ['session_id'] : []), ...(calendar ? ['period'] : [])];
  const dimensions = ['provider', ...(by === 'model' ? ['model'] : []), project ? 'project_key' : 'NULL AS project_key',
    project ? '(SELECT project_name FROM projects p WHERE p.project_key=turn_summary.project_key) AS project_name' : 'NULL AS project_name',
    session ? 'session_id' : 'NULL AS session_id',
    session ? '(SELECT session_name FROM sessions s WHERE s.provider=turn_summary.provider AND s.session_id=turn_summary.session_id) AS session_name' : 'NULL AS session_name',
    session ? '(SELECT MIN(t.started_at_ms) FROM turn_summary t WHERE t.provider=turn_summary.provider AND t.session_id=turn_summary.session_id) AS session_started_at_ms' : 'NULL AS session_started_at_ms', `${period} AS period`];
  const unknown = [...(calendar ? ['period IS NULL'] : []), ...(by === 'model' ? ["coalesce(model,'') = ''"] : [])];
  const unknownOrder = unknown.length > 1 ? `(${unknown.join(' OR ')}), ${unknown.join(', ')}, ` : unknown.length ? `${unknown[0]}, ` : '';
  const metrics = { tokens:'total_tokens',requests:'turn_count',averageTokens:'avg_tokens_per_turn',averageDuration:'avg_duration_ms' };
  const order = sortBy ? `${metrics[sortBy]} DESC, ${groups.join(',')}` : groups.join(',');
  return { mode: source.boundary ? 'rollup-plus-raw-boundaries' : 'rollup', source,
    rows: { sql:`SELECT ${dimensions.join(',')},${mergeMetrics(filter.excludeEmptyUsage)} FROM (${source.sql}) AS turn_summary GROUP BY ${groups.join(',')} ORDER BY ${unknownOrder}${order} LIMIT ? OFFSET ?`,values:source.values },
    count:{ sql:`SELECT COUNT(*) AS count FROM (SELECT ${period} AS period FROM (${source.sql}) AS turn_summary GROUP BY ${groups.join(',')})`,values:source.values },
  };
}

module.exports = { TIMEZONE, DAY, tables, states, rawSource, install, refresh, sources, build };
