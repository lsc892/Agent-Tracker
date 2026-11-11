// 변경 전 선택기의 child 기여를 원본 spawn 매핑으로 옮겨 부모 DTO 결과와 대조한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');

async function main() {
  const workspace = path.resolve(process.argv[2]);
  const snapshot = JSON.parse(fs.readFileSync(path.join(workspace, 'current/snapshot.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(workspace, 'current/parent-root-mapping.json'), 'utf8'));
  assert.equal(snapshot.sha256, mapping.inputSha256);
  const product = path.join(workspace, 'products/A');
  const children = new Map(mapping.children.filter(child => child.rootless).map(child => [child.identity.sessionId, child]));
  const turns = require(path.join(product, 'dist/src/summary/aggregation/turns'));
  const originalMaterialize = turns.materialize;
  const excludedParents = new Set();
  const key = row => JSON.stringify([row.provider, row.session_id, row.root_turn_id]);
  let exposedChildAbortedRoots = 0;
  // A의 parser·winner·복사 판정은 유지하고, child-aborted 기여만 관측 가능하게 한다.
  turns.materialize = (roots, ...args) => {
    const values = [...roots];
    for (const root of values) {
      if (root.outcome?.event.status !== 'aborted') continue;
      if (root.provider === 'codex' && children.has(root.session)) {
        root.outcome = { ...root.outcome, event: { ...root.outcome.event, status: 'in_progress' } };
        exposedChildAbortedRoots++;
      } else excludedParents.add(JSON.stringify([root.provider, root.session, root.rootId]));
    }
    return originalMaterialize(values, ...args);
  };
  const { SummaryDatabase } = require(path.join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(path.join(product, 'dist/src/summary/scanner'));
  const dbPath = path.join(workspace, `oracle-child-usage-${Date.now()}.sqlite`);
  assert.equal(fs.existsSync(dbPath), false, 'Never reuse oracle state');
  const oracle = new SummaryDatabase(dbPath);
  const refreshed = await refreshSummary(oracle, { dbPath, roots: snapshot.roots, timezone: 'Asia/Seoul' });
  assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false);
  const a = new DatabaseSync(path.join(workspace, 'runs/pair--1/A/summary.sqlite'), { readOnly: true });
  const b = new DatabaseSync(path.join(workspace, 'runs/pair--1/B/summary.sqlite'), { readOnly: true });
  const all = db => db.prepare('SELECT * FROM turn_summary').all();
  const aRows = all(a), rawChildRows = all(oracle.connection).filter(row => row.provider === 'codex' && children.has(row.session_id));
  const expected = new Map(aRows.filter(row => row.provider !== 'codex' || !children.has(row.session_id)).map(row => [key(row), { ...row }]));
  const manifests = a.prepare("SELECT source_identity,session_id FROM manifest WHERE provider='codex'").all();
  const sessionMap = new Map(manifests.filter(row => row.source_identity).map(row => [JSON.parse(row.source_identity)[0], row.session_id]));
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens', 'total_tokens'];
  const expectedModels = new Map();
  const modelFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens'];
  function addModels(db, row, target) {
    for (const model of db.prepare('SELECT * FROM turn_model_usage WHERE turn_id=?').all(row.id)) {
      const id = JSON.stringify([target.provider, target.session_id, target.root_turn_id, model.model]);
      let sum = expectedModels.get(id);
      if (!sum) expectedModels.set(id, sum = Object.fromEntries(modelFields.map(field => [field, 0])));
      for (const field of modelFields) sum[field] += model[field] ?? 0;
    }
  }
  for (const row of expected.values()) addModels(a, row, row);
  let childRowsMerged = 0, childRowsExcludedWithParent = 0, childTokensExcludedWithParent = 0;
  const missingParents = [];
  for (const row of rawChildRows) {
    const binding = children.get(row.session_id).finalBinding;
    assert.ok(binding, 'A child usage requires raw parent binding');
    const id = JSON.stringify(['codex', sessionMap.get(binding.parentThreadId), binding.parentRootId]);
    const target = expected.get(id);
    if (!target) {
      childRowsExcludedWithParent++; childTokensExcludedWithParent += row.total_tokens;
      missingParents.push({ keySha256: createHash('sha256').update(id).digest('hex'), tokens: row.total_tokens, parentAborted: excludedParents.has(id) });
      assert.ok(excludedParents.has(id), 'Unrecorded parent must be an explicitly aborted root');
      continue;
    }
    childRowsMerged++;
    for (const field of fields) target[field] = (target[field] ?? 0) + (row[field] ?? 0);
    addModels(oracle.connection, row, target);
  }
  const actual = new Map(all(b).map(row => [key(row), row]));
  assert.equal(actual.size, expected.size);
  for (const [id, row] of expected) {
    const target = actual.get(id); assert.ok(target);
    for (const field of fields) assert.equal(target[field] ?? 0, row[field] ?? 0, `Parent request ${field}`);
  }
  const bModels = b.prepare(`SELECT t.provider,t.session_id,t.root_turn_id,u.*
    FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id`).all();
  assert.equal(bModels.length, expectedModels.size);
  for (const row of bModels) {
    const target = expectedModels.get(JSON.stringify([row.provider, row.session_id, row.root_turn_id, row.model])); assert.ok(target);
    for (const field of modelFields) assert.equal(row[field] ?? 0, target[field], `Parent model ${field}`);
  }
  const aChildren = aRows.filter(row => row.provider === 'codex' && children.has(row.session_id));
  const tokenSum = rows => rows.reduce((sum, row) => sum + row.total_tokens, 0);
  const result = { inputSha256: snapshot.sha256, mappingSha256: createHash('sha256').update(fs.readFileSync(path.join(workspace, 'current/parent-root-mapping.json'))).digest('hex'),
    method: 'Unmodified A parser, source winner and eligibility. A materialize child-aborted exclusion is bypassed in memory only to expose usage. Independent raw spawn/agent_path mapping moves every child contribution to its parent; the parent aborted policy still applies.',
    baselineChildRequests: aChildren.length, baselineChildTokens: tokenSum(aChildren), rawChildRequests: rawChildRows.length,
    rawChildTokens: tokenSum(rawChildRows), exposedChildAbortedRoots, childAbortedTokens: tokenSum(rawChildRows) - tokenSum(aChildren),
    childRowsMerged, childRowsExcludedWithParent, childTokensExcludedWithParent, allExcludedParentsExplicitlyAborted: true,
    expectedRequests: expected.size, actualRequests: actual.size, expectedTokens: tokenSum([...expected.values()]), actualTokens: tokenSum([...actual.values()]),
    perParentTokenCacheVectorsMatch: true, perParentModelTokenCacheVectorsMatch: true, expectedModelRows: expectedModels.size,
    noChildStandaloneRows: [...actual.values()].every(row => row.provider !== 'codex' || !children.has(row.session_id)),
    excludedParentContributions: missingParents };
  fs.writeFileSync(path.join(workspace, 'parent-dto-oracle-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  oracle.close(); a.close(); b.close();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
