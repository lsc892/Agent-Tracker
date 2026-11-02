// 인덱스 전용 실험의 원시 JSON에서 비교 표와 재현 조건을 생성한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { basename, dirname, relative, resolve } = require('node:path');
const { sha } = require('./index-only-fixtures.cjs');
const n = v => v == null ? '미측정' : v.toLocaleString('en-US');
const ms = v => v.toFixed(3);
const pct = (a, b) => ((b / a - 1) * 100).toFixed(1) + '%';
const range = s => s.samples.length === 1 ? `${ms(s.median)} (단회)` : `${ms(s.median)} (${ms(s.p10)}–${ms(s.p90)})`;
const table = (header, rows) => `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`;
function stagingPlan() {
  const { SummaryDatabase } = require('../../dist/src/summary/db');
  const { SummaryStaging } = require('../../dist/src/summary/staging');
  const db = new SummaryDatabase(':memory:'), staging = new SummaryStaging(db.connection);
  try {
    const match = SummaryStaging.prototype.finishComponent.toString().match(/exec\(`([\s\S]*?)`\)/);
    assert.ok(match, 'Current component cleanup SQL must be captured verbatim');
    return { note: 'Separate diagnostic on a fresh empty in-memory product TEMP schema; no time or loop/visit counters measured.',
      sqlite: db.connection.prepare('SELECT sqlite_version() v').get().v,
      stagingSourceSha256: sha(fs.readFileSync(resolve(__dirname, '../../src/summary/staging.ts'))),
      queries: match[1].split(';').map(sql => sql.trim()).filter(Boolean).map(sql => ({ sql,
        plan: db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() })) };
  } finally { staging.close(); db.close(); }
}
function markdown(r, path) {
  const link = target => relative(dirname(path), resolve(__dirname, '../..', target)).replaceAll('\\', '/');
  const initial = d => d.writes.find(w => w.name.endsWith('-initial'));
  const scope = d => d.name.startsWith('large') ? '9,950→10,000 파일' : '250→300 파일';
  const anomalies = r.datasets.flatMap(d => d.writes.flatMap(w => ['A', 'B'].flatMap(v => {
    const metric = ['refresh', 'firstQuery', 'setup'].find(key => { const s = w.variants[v][key]; return s.samples.length > 1 && s.max > s.median * 5 && s.max - s.median > 1000; });
    return metric ? [[d.name, w.name, v, metric, ms(w.variants[v][metric].median), ms(w.variants[v][metric].max)]] : [];
  })));
  const interpretations = r.datasets.flatMap(d => {
    const q = d.reads.find(v => v.id === 'Q1' && v.period === 'all');
    const w = initial(d), a = d.space.A, b = d.space.B;
    const objects = (s, re) => s.objects?.filter(o => re.test(o.name)).reduce((sum, o) => sum + o.bytes, 0);
    const rollup = objects(a, /usage_/), oldIndex = objects(a, /^idx_summary_/), newIndex = objects(b, /^bench_/);
    const parse = v => w.variants[v].samples.map(s => s.readParseMs).sort((a, b) => a - b)[Math.floor(w.measuredCount / 2)];
    const paragraphs = [
      `- **${d.name}**: Q1 전체 범위 입력은 논리 모델 사실 ${n(q.inputModelFacts)}행, 결과 ${n(q.groups)}그룹이다. 페이지 A ${ms(q.variants.A.page.median)}ms → B ${ms(q.variants.B.page.median)}ms, B가 빠른 쌍 ${q.pagePaired.bFasterPairs}/${q.variants.A.page.samples.length}이다. 범위 인덱스가 전체 기간의 집계 입력을 줄이지 못한다는 가설을 SQL·계획이 뒷받침한다. B는 전체 범위의 raw facts와 모델 JOIN을 처리하며, SQL의 시간대 버킷 함수를 매 조회에서 적용한다. A는 저장한 local_day와 집계 상태를 병합한다. 이것은 SQL·계획에 근거한 원인 설명이며 실제 VM 방문 카운터를 측정한 결과는 아니다.`,
    ];
    if (w) paragraphs.push(`  최초 refresh A ${ms(w.variants.A.refresh.median)}ms, B ${ms(w.variants.B.refresh.median)}ms이고 원본 읽기·parser 구간은 각각 ${ms(parse('A'))}/${ms(parse('B'))}ms다. 세션 저장은 ${ms(w.variants.A.store.median)}/${ms(w.variants.B.store.median)}ms다. 저장 비용 감소가 전체 수집을 지배하는지 이 단계 비중과 반복 범위를 함께 봐야 한다. ${w.measuredCount === 1 ? '이 값은 단회 관측이며 편차·우열의 반복 재현성을 판정하지 않는다.' : '값은 반복 중앙값이다.'}`);
    else paragraphs.push('  사용자 지시에 따라 대량 최초 수집은 정상 10,000세션의 A/B 각 1회로 제한했다. 이 긴 세션 상태는 그 완성 DB를 backup하고 한 세션만 1,000요청으로 갱신해 준비했다. 별도의 대량 긴 세션 W1은 수행하지 않았으며 W1 시간으로 표시하지 않는다.');
    if (rollup !== undefined) paragraphs.push(`  A의 집계 테이블·인덱스는 ${n(rollup)} bytes, 요청 보조 인덱스는 ${n(oldIndex)} bytes이며 B의 여섯 요청 인덱스는 ${n(newIndex)} bytes다. 집계 제거분에서 인덱스 증분 ${n(newIndex - oldIndex)} bytes 등을 지불한 뒤 전체 DB는 ${n(b.fileBytes - a.fileBytes)} bytes (${pct(a.fileBytes, b.fileBytes)}) 변했다. 테이블 삭제만큼 순공간이 줄 것이라는 예상과 다른 이유를 이 객체 비용이 설명한다. 페이지 패킹·freelist도 달라질 수 있어 두 객체 차이의 합을 전체 파일 차이와 같다고 가정하지 않는다.`);
    const append = d.writes.find(w => w.name === 'append-1');
    if (append) paragraphs.push(`  긴 세션 +1은 refresh A ${ms(append.variants.A.refresh.median)}ms, B ${ms(append.variants.B.refresh.median)}ms다. 별도 진단의 WAL은 A ${n(append.diagnostics.A.walBytesAtRefreshEnd)}, B ${n(append.diagnostics.B.walBytesAtRefreshEnd)} bytes이며 TEMP 관측 최대 할당은 ${n(append.diagnostics.A.tempMaxAllocatedBytes)}/${n(append.diagnostics.B.tempMaxAllocatedBytes)} bytes다. B는 기존 ${n(d.counts.maxSessionRequests)}요청 세션을 전체 교체하고 A는 차이 비교 경로를 사용한다. 저장 시 TEMP 테이블 종류는 ${append.diagnostics.A.tempTables.length}개에서 ${append.diagnostics.B.tempTables.length}개로 줄었다. ${append.diagnostics.A.walBytesAtRefreshEnd === append.diagnostics.B.walBytesAtRefreshEnd ? '이 케이스의 WAL 파일 길이는 같았다. 자동 checkpoint를 유지했으므로 파일 길이만으로 누적 쓰기 증폭 유무를 판단하지 않는다.' : 'B의 WAL 파일 길이가 더 컸지만 이 차이는 누적 디스크 쓰기량의 차이를 뜻하지 않는다.'} SQL 구조와 직접 변경 수는 diagnostics에 따로 남겼다.`);
    return [...paragraphs, ''];
  });
  const lines = [
    '# 현재 구조와 인덱스 전용 저장소 A/B 실측', '',
    `측정: ${r.startedSeoul} ~ ${r.completedSeoul}, Asia/Seoul. [원시 JSON](${basename(path, '.md')}.json).`, '',
    ...(r.method.userOverride ? [`사용자 범위 조정: 조회·증분을 우선하고 대량 최초 수집은 A/B 각 1회로 제한했다. 초기 실행에서 완료한 실제·300·500 자료는 그대로 보존했다. 중단된 10,000세션 준비 실행은 표본에 넣지 않았다. 조정 후 실행 시작은 ${r.focusedStartedSeoul}이다.`, ''] : []),
    '## 판단', '',
    '이번 실험은 제품 교체 없이 진행했다. B는 저장 구조를 단순화하는 대안으로 검토할 수 있지만, 인덱스가 GROUP BY의 입력 합산을 없애지는 않는다. 아래의 절대 지연·갱신·공간을 함께 보고 선택해야 한다. 사용 빈도를 가정한 임의의 종합 점수는 만들지 않았다.', '',
    'A는 현재 제품의 사실 테이블·일별 집계 2개·집계 metadata 1개·세션 교체 TEMP·큰 세션 차이 비교를 그대로 쓴다. B는 동일한 사실 테이블과 PK를 유지하고 일별 집계 3개를 제거하며, 인덱스로 대상 세션을 찾아 DELETE/INSERT한다. 저장용 TEMP 대신 작은 JS 집합을 쓴다. 실제 수집기와 parser, 수집·중복 제거·세션 연결용 staging TEMP는 양쪽 공통이다. **수집기까지 TEMP가 전혀 없는 제품 구현을 검증한 결과는 아니다.**', '',
    '관리 단순화를 우선한 사용자 요구에는 B가 전환 후보가 된다. 영속 테이블은 11개에서 8개로 줄고 저장용 TEMP·차이 비교·집계 유지 코드를 제거할 수 있다. 다만 전역 범위의 반복 조회 지연과 긴 세션의 쓰기 증폭을 받아들일 수 있어야 한다. 전역 집계의 최소 지연이 우선이면 A를 유지한다. 실제 읽기/갱신 빈도나 UI 지연 예산을 임의로 정하지 않았으며, B의 여섯 인덱스를 최종 최소 구성으로 확정하지 않았다.', '',
    '사용자가 요청한 두 전체 설계의 A/B다. B는 인덱스만 더한 통제군이 아니라 조회 소스·집계 유지·저장 알고리즘도 함께 바꾸는 복합 후보다. 따라서 차이를 “인덱스 6개만의 효과”로 해석하지 않는다. PK 순서 변경은 이번 요청 범위에서 제외했다.', '',
    '예시의 createdAt→started_at_ms, websiteId→project_key, sessionId→(provider,session_id)로 대응했다. eventName은 이 제품에 없어 status로 대체했다. 모델은 요청 하나에 여러 개일 수 있어 기존 turn_model_usage 사실 테이블과 (turn_id,model) PK를 유지한다. 원래 요청 보조 인덱스 2개는 아래 6개로 교체했다. manifest 등 다른 사실 테이블의 인덱스와 모든 PK는 유지했다.', '',
    '```sql', ...r.method.indexDDL.split('\n').filter(line => line.startsWith('CREATE INDEX')), '```', '',
    'project 단독 인덱스와 project+날짜 등에는 접두사 중복이 있다. 이번에는 사용자가 제시한 형태의 비용을 포함했고 최소 인덱스 집합을 고르는 별도 실험은 하지 않았다. SQLite도 한 인덱스가 다른 인덱스의 접두사인 경우 중복 제거를 검토하도록 설명한다. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html#_multi_column_indices).', '',
    '## 고정한 가설과 의미', '',
    ...r.method.hypotheses.map(v => `- ${v}`), '',
    'F=원본 파일 수, B=원본 bytes, S=제공자×세션, N=요청 facts, M=모델 facts, R=집계 행이다. 수집 비용은 F/B/파싱 이벤트에, 원본 집계는 필터를 통과한 모델 facts M에, 사전 집계는 R에 영향을 받는다. 좁은 범위의 인덱스 탐색은 대략 log N+해당 범위 처리이며 전체 범위의 합산은 입력 행에 비례한다. SQLite의 정렬·그룹 B-tree 비용과 결과 materialize도 포함한다.', '',
    '합계에는 모든 상태와 빈 요청을 포함한다. 평균만 완료 요청에 한정하고 excludeEmptyUsage=true이면 기록된 사용량이 있는 완료 요청을 분모로 삼는다. 모델이 여러 개인 요청은 모델별 사실로 나누며, 빈 모델·미기록·알려진 0 사용량을 구분한다. total_tokens=input+output이고 캐시 필드를 다시 더하지 않는다. 캐시가 하나라도 NULL이면 해당 합계/평균은 제품 규칙에 맞춰 NULL을 유지한다. 날짜는 Asia/Seoul, 필터는 [from,to)다. 기본 성능 비교는 미상 시간을 제외하며 별도 정확성 fixture는 include/only도 검사한다.', '',
    'Q1=전체 프로젝트 일×제공자×모델 평균, Q2=선택 프로젝트 월×제공자×모델 평균, Q3=같은 프로젝트 월×제공자×모델×세션 총량이다. Q1/Q2 페이지 시간은 실제 queryUsagePage의 100행+전체 그룹 COUNT, SQL 준비·snapshot·metadata 확인을 포함한다. Q3는 공개 API에 월×세션 조합이 없어 양쪽 실제 builder의 그룹 차원만 동일하게 확장했다. full 시간은 준비한 SQL로 모든 그룹+COUNT를 반환한다. 첫 100행만 반환해도 집계 입력 100행만 읽는 것은 아니다.', '',
    '## 입력과 저장 공간', '',
    table(['입력', 'P', 'S', 'N 요청', 'M 모델', 'F 파일', '원본 bytes', '최대 세션 요청'], r.datasets.map(d => [d.name, n(d.counts.projects), n(d.counts.sessions), n(d.counts.requests), n(d.counts.models), n(d.input.files), n(d.input.bytes), n(d.counts.maxSessionRequests)])), '',
    '기본 합성 자료는 세션당 1파일·1요청, 긴 세션은 동일한 S에서 한 세션만 1,000요청이다. 10,000세션은 100프로젝트×100세션이며 10프로젝트×다수 요청으로 대체하지 않았다. 양 제공자·각 2모델·3개월을 결정적으로 섞고 일부 요청은 두 모델을 쓴다. 생성식 자체가 seed이며 입력 SHA-256과 실제 소스·빌드 해시는 JSON에 있다. 실제 자료는 한 번 고정한 로컬 사본이며 합성 결과와 구분했다.', '',
    table(['입력', 'A DB bytes', 'B DB bytes', 'B−A bytes', '공간 증감', 'A 파생 행', 'B 파생 행', 'A/B 인덱스 수'], r.datasets.map(d => {
      const a = d.space.A, b = d.space.B;
      const derived = s => s.tables.filter(t => t.name.startsWith('usage_')).reduce((sum, t) => sum + t.rows, 0);
      return [d.name, n(a.fileBytes), n(b.fileBytes), n(b.fileBytes - a.fileBytes), pct(a.fileBytes, b.fileBytes), n(derived(a)), n(derived(b)), `${a.indexes.length}/${b.indexes.length}`];
    })), '',
    '공간은 같은 TRUNCATE checkpoint 이후 정상 사용 DB 파일과 page_count/freelist를 조사했다. VACUUM은 수행하지 않았다. 테이블별 NULL 포함/제외 저장 값 수·행 수, 실제 DDL·index_xinfo와 dbstat 지원 여부는 JSON의 space에 있다. B의 추가 사전 집계 값은 0이지만 인덱스 공간은 0이 아니다. 이미 존재하는 fact/model/name/manifest/cost/capability 테이블은 삭제하지 않았다.', '',
    '## 가설과 실제 결과가 다른 이유', '', ...interpretations,
    '## 조회: 실제 페이지 100행+COUNT', '',
    '시간 단위는 ms, 괄호는 P10–P90이다. 각 케이스는 준비 실행 2회 후 독립 배치 9개, 각 배치는 3회 평균이다. AB/BA 순차 교대이며 중앙값을 비교한다. 작은 표본의 백분위는 정밀한 꼬리 지연 추정치가 아니다. 결과가 0그룹인 경우도 그대로 표시한다.', '',
    table(['입력', '조회', '기간', '논리 모델 입력/그룹', 'A ms', 'B ms', 'B−A ms', 'B 빠른 쌍'], r.datasets.flatMap(d => d.reads.filter(q => q.period !== 'month').map(q => [d.name, q.id, q.period, `${n(q.inputModelFacts)}/${n(q.groups)}`, range(q.variants.A.page), range(q.variants.B.page), ms(q.variants.B.page.median - q.variants.A.page.median), `${q.pagePaired.bFasterPairs}/${q.variants.A.page.samples.length}`]))), '',
    '초기 실행기의 month 범위는 UTC 월 증가로 계산해 31일인 달에서 마지막 하루가 빠질 수 있었다. 그 표본은 원시 JSON에 원래 SQL·파라미터 그대로 남겼으며 완전한 달 실측으로 사용하지 않는다. 아래는 제품 periodBounds로 정확한 [월 1일, 다음 달 1일)을 계산해 다시 수행한 별도 조회 실험이다. 수집·증분과 전체 기간 표본에는 이 경계 오류가 영향을 주지 않는다.', '',
    ...(r.monthCorrection ? [table(['입력', '정확한 달 조회', '입력/그룹', 'A ms', 'B ms', 'B 빠른 쌍'], r.monthCorrection.datasets.flatMap(d => d.reads.map(q => [d.name, q.id, `${q.inputModelFacts}/${q.groups}`, range(q.variants.A.page), range(q.variants.B.page), `${q.pagePaired.bFasterPairs}/${q.variants.A.page.samples.length}`]))), '',
      `[정확한 달 원시 결과](${basename(path, '.md')}-month.json). 실제·300·500 자료는 원래 고정 DB의 읽기 전용 SQLite backup을 썼다. 대량·긴 세션은 같은 결정적 JSONL을 실제 parser에 통과시키고 정규화·저장을 한 묶음으로 수행해 조회용 facts를 준비했다. 이 준비는 제품 W1 시간으로 보고하지 않는다. 원래 데이터의 프로젝트·세션·요청·모델 수, 총 토큰과 전체 기간 그룹·토큰 합계를 대조했다. 이 추가 실험은 동일 facts 사본을 A/B로 나눴으며 원래 B의 파일 패킹까지 복원한 것은 아니다.`, ''] : []),
    '추가 조회용 합성 입력은 root ID에 세션 접두사를 일대일로 붙였다. 서로 다른 세션의 동명 root를 일괄 정규화 때 반복 탐색하는 비용을 피하기 위한 준비 단계 선택이며, 조회 차원인 제공자·세션·모델·시간·토큰은 바꾸지 않았다. 이 재명명과 묶음 저장은 원래 최초 수집·증분 표본에는 적용하지 않았다.', '',
    '동일한 케이스의 모든 그룹+COUNT prepared SQL 시간·원시 배치·짝별 차이·최소/최대는 JSON의 reads.full에 있다. Q2/Q3는 사실 수가 가장 큰 대표 프로젝트 하나를 고정했다. 기간은 earliest month의 1일, 월 중간 3일과 1시간, 완전한 달, 월 중간~다음 달 중간의 시각 경계, 전체, 빈 미래 범위다. 파라미터의 실제 프로젝트 경로는 <selected-project>로 마스킹했다.', '',
    '계획의 SEARCH는 일부 범위를 찾는 전략이고 SCAN USING INDEX도 전체 순회일 수 있다. USE TEMP B-TREE는 GROUP BY/ORDER BY용 내부 임시 구조다. B에서 명시적 CREATE TEMP TABLE을 없애도 이 내부 정렬 구조까지 없어진다는 뜻은 아니다. [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html). 실제 방문 횟수는 계획 문구로 추정하지 않았다.', '',
    '특히 A 계획의 SCAN turn_summary는 원본 요청 테이블이라는 뜻으로 읽으면 안 된다. A의 해당 SQL에서는 usage_model_daily 소스를 turn_summary라는 별칭으로 부른다. 실제 SQL의 FROM/JOIN 대상과 함께 확인했다. B의 t 별칭은 원본 turn_summary, m은 turn_model_usage다. 월 중간 경계 모드의 A에는 raw 경계 처리도 함께 들어간다.', '',
    `수집의 공통 component 정리 SQL도 [별도 계획](${basename(path, '.md')}-staging-plan.json)으로 보존했다. 현재 제품의 TEMP 스키마를 메모리에 새로 만들고 finishComponent의 실제 SQL을 그대로 EXPLAIN했으며 시간·방문 수는 측정하지 않았다. 일부 정리는 전체 scan_files나 affected를 바깥에서 순회한다. 독립 세션 S개에서 각 component마다 F파일 전체를 정리한다면 이 부분은 이론적으로 F×S 비용이 될 수 있다. 새 요청 테이블의 인덱스만으로 이 공통 TEMP 정리가 사라지지는 않는다. 이 계획은 원인 후보를 뒷받침하며 실제 대량 수집 내부 방문 수나 시간의 원인을 단독으로 확정하지 않는다.`, '',
    '## 최초 원본 읽기부터 COMMIT·첫 조회까지', '',
    table(['입력', 'A refresh ms', 'B refresh ms', 'A/B 저장 ms', 'A/B 첫 조회 ms', 'A/B refresh+첫 조회 ms', 'A/B setup 포함 준비 ms', '표본'], r.datasets.filter(d => initial(d)).map(d => {
      const w = initial(d), a = w.variants.A, b = w.variants.B;
      return [d.name, range(a.refresh), range(b.refresh), `${ms(a.store.median)}/${ms(b.store.median)}`, `${ms(a.firstQuery.median)}/${ms(b.firstQuery.median)}`, `${ms(a.readyTotal.median)}/${ms(b.readyTotal.median)}`, `${ms(a.setupThroughReady.median)}/${ms(b.setupThroughReady.median)}`, w.measuredCount];
    })), '',
    'refreshTotalMs는 실제 refreshSummary 진입부터 탐색·읽기·parser·정규화·저장·실제 COMMIT·함수 반환까지다. 최초 A 조회에는 lazy 집계 구축이 포함된다. refresh+첫 조회 및 setup 포함 값은 매 표본에서 직접 합친 뒤 중앙값을 구했으며 별도 중앙값끼리 더하지 않았다. setup은 빈 제품 스키마 생성 뒤 B의 실험 어댑터 DDL 적용까지 포함하므로 B 전용 설치기의 최적 비용을 추정한 값은 아니다.', '',
    'storeCallMs, readParseMs, normalizeMs, transactionMs와 beginWaitMs는 포함 관계가 있으므로 합산하지 않는다. 특히 store가 staging iterator를 소비하면서 정규화된 행을 읽고, readParse에는 parser의 이벤트 staging 쓰기도 들어간다. phases.scanning은 탐색·변경 확인·이름 metadata 처리 구간이며 순수 디스크 탐색만의 시간으로 부르지 않는다. 큰 진단은 별도 반복에서 수행했다.', '',
    '## 증분·무변경·긴 세션 갱신', '',
    table(['입력/기존 상태', '변화', 'A refresh ms', 'B refresh ms', 'A/B 저장 ms', 'B 빠른 쌍'], r.datasets.flatMap(d => d.writes.filter(w => !w.name.endsWith('-initial')).map(w => [
      `${d.name}${w.name === 'delta-50' ? ` (${scope(d)})` : ''}`, w.name, range(w.variants.A.refresh), range(w.variants.B.refresh), `${ms(w.variants.A.store.median)}/${ms(w.variants.B.store.median)}`, `${w.paired.bFasterPairs}/${w.measuredCount}`]))), '',
    '매 반복마다 동일한 사전 DB를 node:sqlite backup으로 복원했다. A는 사전 조회로 집계를 활성화한 상태이며 B는 같은 facts를 갖는다. 신규 파일 증분은 기본 250+50=300, 대량은 9,950+50=10,000이다. 실제 365파일의 증분은 그중 300파일을 고정해서 250→300으로 시험했다. 대량 사전 9,950세션은 완성 DB에서 독립된 마지막 50세션을 실제 삭제 API로 지워 만들었다. 이는 빈 DB에 9,950개를 적재한 것과 페이지 배치·freelist·통계 이력까지 같다는 뜻은 아니다. 같은 사전 상태를 매번 복원하므로 A/B의 50개 추가 동작을 비교할 수 있다. 긴 세션 append는 새 파일이 아니라 기존 한 파일을 수정해 +1/+31/+32/+33/+50을 각각 독립 수행한다. 기존 요청 하나 수정·삭제·전건 변경도 측정했다. 새 요청 수·토큰 합계를 독립 생성식으로 확인했다. 무변경은 bodyBytes=0·저장 호출=0을 검증했다.', '',
    '## 읽기·TEMP·WAL·추가 저장 비용', '',
    table(['입력', '변화', 'A/B 파싱 횟수', 'A/B 원본 읽기 bytes', 'A/B DB 반환 행/값', 'A/B 관측 TEMP 최대 할당 bytes', 'A/B refresh 종료 WAL bytes'], r.datasets.flatMap(d => d.writes.map(w => {
      const a = w.diagnostics.A, b = w.diagnostics.B;
      const returned = x => { if (!x.reads) return '미측정'; const s = Object.values(x.reads); return `${n(s.reduce((v, t) => v + t.rows, 0))}/${n(s.reduce((v, t) => v + t.valuesIncludingNull, 0))}`; };
      return [d.name, w.name, `${a.parsed}/${b.parsed}`, `${n(a.bodyBytes)}/${n(b.bodyBytes)}`, `${returned(a)}/${returned(b)}`, `${n(a.tempMaxAllocatedBytes)}/${n(b.tempMaxAllocatedBytes)}`, `${n(a.walBytesAtRefreshEnd)}/${n(b.walBytesAtRefreshEnd)}`];
    }))), '',
    'DB 반환 행/값은 실제 get/all/iterate가 애플리케이션에 반환한 행·열 수이며 NULL도 값 1개로 센다. 같은 행을 다시 받으면 다시 센다. manifest/metadata/기존 facts/수집 TEMP 등 테이블별 상세는 diagnostics.reads에 있다. INSERT SELECT·JOIN·FK·인덱스 내부 읽기는 이 숫자로 측정하지 못한다. 준비 호출 횟수나 EQP를 내부 방문 행으로 바꾸지 않았다.', '',
    'reads의 이름은 SQL에서 처음 나타나는 FROM 소스에 따른 문 분류다. JOIN·스칼라 하위 쿼리·집계가 섞이면 반환 행은 여러 소스의 계산 결과이므로 해당 테이블의 실제 방문 행 수로 해석하지 않는다. 개별 SELECT 실행 횟수는 별도 보존하지 않았고 반환 행·값만 집계했다.', '',
    '실제 250→300파일 증분에서는 양쪽 모두 51회 파싱·71,130,267 bytes 읽기가 관측되었다. 실제 수집기는 영향받은 세션의 기존 소스를 추가로 확장해 파싱하는 경로를 가지며, “새 50파일이므로 50개만 읽는다”고 가정하지 않았다. 수집 범위는 B에서도 동일했다. 또한 실제 자료의 대표 프로젝트가 전역 최초 날짜에 활동하지 않아 일부 좁은 기간은 0그룹이다. 이런 케이스의 시간으로 조회 우위를 판단하지 않는다.', '',
    'TEMP는 생성/COMMIT/저장 반환 시점의 SQLite temp.page_count 관측 최대다. 연속 샘플링이나 프로세스 peak RSS가 아니다. B에도 공통 수집 TEMP는 남는다. WAL은 동일한 시작 TRUNCATE 이후 refresh 반환 시 파일 길이이며 자동 checkpoint는 제품 설정을 유지한다. 누적 디스크 쓰기량이나 WAL 최대 크기로 해석하지 않는다. diagnostics.storageAfter는 갱신 후 같은 checkpoint 조건의 공간이다. total_changes는 TEMP와 cascade를 포함할 수 있으며 directStatementWrites는 run()의 직접 변경만 세므로 둘은 다른 지표다.', '',
    '대량 최초 수집은 사용자가 각 1회로 제한했으므로 별도 전체 수집 진단 반복을 하지 않았다. 해당 행의 DB 반환 행/값·TEMP 최대 할당은 미측정으로 남긴다. 계측 부하가 큰 진단을 단회 시간에 섞거나 0으로 보고하지 않았다. 원본 bytes·파싱 수·가벼운 단계 타이머·COMMIT 수·WAL·최종 저장 공간은 그 단회에서 관측했다.', '',
    `node:sqlite ${r.environment.node}, SQLite ${r.environment.sqlite}는 StatementSync의 scanstatus·stmt_status API를 노출하지 않아 VM_STEP·FULLSCAN_STEP·NLOOP/NVISIT는 미측정이다. 물리 I/O와 분리된 peak 메모리도 미측정이다. dbstat은 실행 시 지원 여부를 탐지했다.`, '',
    '## 정확성과 한계', '',
    `기본 자료별 Q1/Q2/Q3×6기간 전체 결과, 정수 토큰·건수, 전체 그룹 COUNT를 SQL과 독립적인 JS 집계로 대조했다. 평균 허용 오차는 상대 1e-9다. 별도 ${r.edgeCases.counts.requests}요청 fixture에 완료·진행·실패, 미기록/0 사용량, 빈 모델·두 모델, 미상 시간과 NULL 캐시를 포함했다. 모든 쓰기 반복의 요청·모델·도구·비용·이름·파일 진단 의미 해시, FK·integrity를 검사했다. 물리 ID·갱신 시각은 비교에서 제외했다. 원본 고정 사본 해시와 소스·빌드 해시를 종료 시 재검사했다.`, '',
    '정확한 달 재검증에는 추가 10요청 fixture를 두어 제공자 사이의 동일 session_id·model, 여러 모델, 연도 경계와 시작 포함/끝 제외, 빈 프로젝트를 검사했다. JS oracle 외에도 총 208토큰, 12월 전체 44토큰·2그룹, 연도 시작 1ms 범위 66토큰·4그룹, 1월 전체 76토큰·6그룹·완료 모델 표본 4개라는 고정 기대값을 직접 확인했다.', '',
    'OS 캐시는 비우지 않았다. 첫 실행은 새로운 DB에서의 첫 조회이며 디스크 cold IO가 아니다. 프로세스는 공유하되 후보를 동시에 돌리지 않았다. 조회 9배치·갱신 5표본이다. 실제·소량 최초 수집은 준비 실행 1쌍·5표본·별도 진단 1쌍이다. 대량 최초 수집은 사용자가 단회로 제한해 A→B 각 1회이며 준비 실행·추가 진단은 없다. 순서 편향과 단회 편차는 분리할 수 없고 대량 W1의 반복적인 우열을 주장하지 않는다. 500커밋마다 진행 출력한 소량의 콘솔 비용은 단회 시간에 포함된다. 대량 긴 세션은 완성 정상 DB의 한 세션을 갱신해 준비했다. 입력 생성·복원·해시·정확성·공간·계획 수집은 타이머 밖이다. 작은 절감과 반복 편차가 겹치는 케이스를 확정적인 개선으로 부르지 않는다.', '',
    ...(anomalies.length ? ['측정 도중 도구의 장시간 대기 구간이 관측됐다. 아래는 중앙값의 5배이면서 1초 이상 큰 원시 최댓값이다. 원인을 확정할 수 없어 표본을 삭제하지 않았다. 해당 케이스의 미세한 우열은 판단에 사용하지 않는다.', '',
      table(['입력', '변화', '후보', '지표', '중앙값 ms', '최대 ms'], anomalies), ''] : []),
    '소수 파일의 소스 삭제 보존·이동·재연결·비활성화 시 capability 보존과 취소/경쟁 writer 등 제품 전체의 기능 검증은 이번 후보에 대해 별도로 수행하지 않았다. 공유 parser를 재사용한 A/B이므로 parser의 모든 의미가 외부 정답과 검증되었다는 뜻도 아니다. 합성 입력의 요청/세션/토큰 총합은 별도 생성식으로 검증했다. 실제자료 결과는 두 구현의 전체 의미 해시와 비집계 facts 기반 oracle의 대조다.', '',
    '## 재현', '',
    `- HEAD: \`${r.revision}\`. 미커밋 상태는 JSON의 workingTreeAtStart에 기록했다. HEAD만을 현재 구현으로 가정하지 않았다.`,
    `- 환경: ${r.environment.platform}/${r.environment.arch}, ${r.environment.cpu}, Node ${r.environment.node}, SQLite ${r.environment.sqlite}. PRAGMA·compile options와 파일별 소스/빌드 SHA-256은 JSON 참고.`,
    `- 실행기: [초기 실행기](${link('tests/benchmarks/index-only.cjs')}), [범위 조정 실행기](${link('tests/benchmarks/index-only-focused.cjs')}), [달 경계 보정 실행기](${link('tests/benchmarks/index-only-month.cjs')}), [B 저장 어댑터](${link('tests/benchmarks/index-only-candidate.cjs')}), [고정 입력](${link('tests/benchmarks/index-only-fixtures.cjs')}).`,
    `- 조정한 범위 재실행: \`npm.cmd run build\` 후 \`node tests/benchmarks/index-only-focused.cjs --previous=docs/benchmarks/2026-10-31/DbTradeoff-index-only.json --output=docs/benchmarks/2026-10-31/DbTradeoff-index-only-focused-rerun.json\`. 실제·소량은 보존된 JSON에서 가져오고 코드/빌드 해시를 검증한 뒤 대량·긴 세션·경계를 다시 측정한다.`,
    '- 실제·소량을 새 원본으로 다시 수집하려면 원래 실행기의 `--real`을 사용한다. 원래 실행기는 대량 3표본까지 실행하는 기본 범위이며 조정한 실행기와 범위를 혼동하지 않는다. 원본이 바뀌면 입력 해시도 달라진다.',
    '- smoke: `node tests/benchmarks/index-only.cjs --smoke --output=tests/results/benchmarks/index-only-smoke-rerun.json`.',
    '- 정확한 달 재검증: `node tests/benchmarks/index-only-month.cjs --result=<완료한-focused.json> --workspace=<동일-입력의-원래-DB-사본-폴더> --output=<새-focused-month.json>`. 원래 실제·소량 DB 사본이 필요하다. 합성 정규화와 경계 fixture만 검증하는 smoke는 `node tests/benchmarks/index-only-month.cjs --smoke --output=tests/results/benchmarks/index-only-month-smoke-rerun.json`이다. 개인 원본은 공개하지 않으며 입력이 바뀌면 같은 실계정 숫자를 재현한다고 보장하지 않는다.',
    `- 문서 재생성: \`node tests/benchmarks/index-only-report.cjs ${relative(resolve(__dirname, '../..'), path).replaceAll('\\', '/').replace(/\.md$/, '.json')}\`. 기존 Markdown을 덮어쓰지 않는다.`,
    '- 검증: `npm.cmd run check`의 타입 검사·린트·374개 테스트 통과. 후보 smoke 및 실제 전체 실측에서도 정확성 검사를 통과했다. `git diff --check` 확인.', '',
    '사용 중인 통계 DB·설치 확장·로컬 원본은 변경하지 않았고 quota 서버는 호출하지 않았다. 개인 본문·제목·세션 ID·실제 프로젝트 경로는 결과에 기록하지 않았다. 완료된 실행기 자체의 임시 사본은 종료 시 정리했다. 중단된 초기 실행과 실패한 smoke의 임시 폴더 agent-tracker-index-only-4ZRk53, agent-tracker-index-only-f7EtDz, agent-tracker-index-only-w44mig는 자동 승인 검토가 재귀 삭제를 blocked by policy로 거절해 남아 있다. 4ZRk53에는 실제 로그 고정 사본과 실험 DB가 들어 있으므로 공개 산출물에 포함하지 않는다. 제품 기능을 바꾸지 않았으므로 기능 의사결정 일지는 추가하지 않았다.', '',
  ];
  return lines.join('\n');
}
if (require.main === module) {
  const input = resolve(process.argv[2]), output = input.replace(/\.json$/, '.md');
  assert.notEqual(input, output); assert.ok(!fs.existsSync(output), 'Markdown already exists');
  const report = JSON.parse(fs.readFileSync(input, 'utf8'));
  assert.ok(report.completedSeoul, 'Only completed measurements can be reported');
  const monthPath = output.replace(/\.md$/, '-month.json');
  assert.ok(fs.existsSync(monthPath), 'Run the corrected calendar-month replay before publishing');
  report.monthCorrection = JSON.parse(fs.readFileSync(monthPath, 'utf8'));
  assert.equal(report.monthCorrection.originalReportSha256, sha(fs.readFileSync(input)), 'Calendar replay must reference this exact report');
  assert.deepEqual(report.monthCorrection.datasets.map(d => d.name), report.datasets.map(d => d.name));
  const planPath = output.replace(/\.md$/, '-staging-plan.json');
  if (!fs.existsSync(planPath)) fs.writeFileSync(planPath, JSON.stringify(stagingPlan(), null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(output, markdown(report, output), { flag: 'wx' });
  console.log(JSON.stringify({ report: output, reportGeneratorSha256: sha(fs.readFileSync(__filename)) }));
}
module.exports = { markdown };
