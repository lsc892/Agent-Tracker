// 기존 교대 측정 실행기를 재사용해 두 번 읽기와 단일 읽기 winner 후보를 비교한다.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '../..');
const runner = join(__dirname, 'streaming-winner-ab.cjs');
const args = process.argv.slice(2), outputArg = args.find(value => value.startsWith('--output='));
if (!outputArg) throw new Error('--output=<new JSON> is required');
const output = resolve(outputArg.slice(9));
const run = spawnSync(process.execPath, ['--no-warnings', runner, ...args], { stdio: 'inherit', windowsHide: true });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
const report = JSON.parse(fs.readFileSync(output, 'utf8'));
report.scope = 'A=frozen worktree immediately before this change, source-evidence pass then winner pass; B=one original read, source-local winner DTO updates with loser vectors discarded, then final grouping of surviving DTOs. Legacy zero-model compatibility is verified separately.';
report.wrapperSha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
report.command = `node --no-warnings tests/benchmarks/single-pass-winner-ab.cjs ${args.join(' ')}`;
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const markdownPath = output.replace(/\.json$/i, '.md');
let markdown = fs.readFileSync(markdownPath, 'utf8');
markdown = markdown.replace('# 스트리밍 winner A/B 테스트', '# 단일 읽기 winner A/B 테스트');
markdown = markdown.replace(/가정:.*\n\n개선 방향:.*\n/u,
  '가정: 사용자는 선행 유효성 근거 읽기를 제거하고 파일 한 번 읽기 → 동일 그룹 winner 비교 → 더 좋은 후보의 DTO 갱신 → 패자 폐기를 요청했다. 두 번째 파일 읽기를 없애면 읽기·파싱 비용이 줄어들 것으로 예상했다.\n\n개선 방향: A = 변경 직전 작업 트리의 두 번 읽기 구현, B = 단일 읽기에서 원본별 winner를 갱신하고 남은 DTO를 최종 그룹으로 병합하는 구현. 원본 캐시를 유지하던 더 이전 제품과의 비교는 별도 과거 측정이다. 모델 기록의 경계 정합성은 본문에서 별도로 적는다.\n');
fs.writeFileSync(markdownPath, markdown);
console.log(`Comparison wrapper completed; workspace=${root}`);
