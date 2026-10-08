import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { createTitleFixture, closeTitleFixture, titleRows, titleVariantSql, verifyTitleRows, withoutTitleIndex,
  type TitleScenario } from '../fixtures/request-title-ab';

for (const scenario of ['long-session', 'mixed-sessions'] as TitleScenario[]) {
  test(`title A/B preserves all summary columns and expected values for 2000 cases: ${scenario}`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'agent-tracker-title-test-'));
    const fixture = createTitleFixture(directory, scenario);
    try {
      fixture.staging.prepareSummaries();
      const original = titleRows(fixture);
      verifyTitleRows(fixture, original);
      const connection = fixture.database.connection;
      assert.ok(connection.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='component_request_title'").get());
      const plan = connection.prepare(`EXPLAIN QUERY PLAN ${fixture.originalSql.split('CREATE TEMP TABLE prepared_turns AS')[1]}`)
        .all().map(row => String(row.detail));
      assert.ok(plan.some(detail => detail.includes('component_request_title')), 'Production title lookup must use its partial index');
      connection.exec(withoutTitleIndex(fixture.originalSql));
      assert.deepEqual(titleRows(fixture), original, 'Production index must preserve the pre-index result');
      for (const variant of ['partial-index', 'combined-aggregate'] as const) {
        fixture.database.connection.exec(titleVariantSql(fixture.originalSql, variant));
        const actual = titleRows(fixture);
        verifyTitleRows(fixture, actual);
        assert.deepEqual(actual, original, `${variant} must preserve every existing summary column`);
      }
    } finally {
      closeTitleFixture(fixture);
      // Only delete the exact mkdtemp directory after checking its absolute parent and prefix.
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('agent-tracker-title-test-'));
      await rm(directory, { recursive:true, force:true });
    }
  });
}
