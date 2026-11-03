// 비용 테이블 통합 전후의 벤치마크 입력·검증을 같은 논리 열로 읽는다.
const COST_COLUMNS = ['billing_mode', 'cost_usd', 'unknown_costs', 'pricing_version'];
const separateCosts = connection => !!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_costs'").get();

function costSource(connection) {
  return separateCosts(connection) ? 'turn_costs'
    : `(SELECT id AS turn_id,${COST_COLUMNS} FROM turn_summary WHERE pricing_version IS NOT NULL)`;
}

function requestSource(connection) {
  const columns = connection.prepare('PRAGMA table_info(turn_summary)').all().map(column => column.name)
    .filter(name => !COST_COLUMNS.includes(name));
  return `(SELECT ${columns} FROM turn_summary)`;
}

function initializeUnknownCosts(db, version) {
  if (separateCosts(db.connection)) {
    db.connection.prepare(`INSERT OR REPLACE INTO turn_costs SELECT t.id,'unknown',NULL,max(1,count(m.model)),?
      FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id GROUP BY t.id`).run(version);
  } else {
    db.connection.prepare(`UPDATE turn_summary SET billing_mode='unknown',cost_usd=NULL,unknown_costs=(
      SELECT max(1,count(*)) FROM turn_model_usage WHERE turn_id=turn_summary.id),pricing_version=?`).run(version);
  }
}

module.exports = { costSource, requestSource, initializeUnknownCosts };
