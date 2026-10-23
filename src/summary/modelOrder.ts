// Official release dates, checked 2026-10-21. Keep aliases and snapshots on the same model line.
// https://platform.claude.com/docs/en/release-notes/overview
// https://developers.openai.com/api/docs/changelog
// https://openai.com/index/gpt-5-1-codex-max/
// https://openai.com/index/introducing-gpt-5-2-codex/
// https://openai.com/index/introducing-gpt-5-3-codex/
const releases: Record<string, number> = {
  'claude-haiku-5-5': 20261007, 'claude-sonnet-5-5': 20260928, 'claude-opus-5-5': 20260922,
  'claude-fable-5-1': 20260901, 'claude-mythos-5-1': 20260901,
  'claude-opus-5': 20260724, 'claude-sonnet-5': 20260630, 'claude-opus-4-8': 20260528,
  'claude-opus-4-7': 20260416, 'claude-sonnet-4-6': 20260217, 'claude-opus-4-6': 20260205,
  'claude-opus-4-5': 20251124, 'claude-haiku-4-5': 20251015, 'claude-sonnet-4-5': 20250929,
  'claude-opus-4-1': 20250805, 'claude-opus-4': 20250522, 'claude-sonnet-4': 20250522,
  'gpt-6.1-sol': 20260929, 'gpt-6-sol': 20260922, 'gpt-6-luna': 20260922, 'gpt-6-astra': 20260903,
  'gpt-5.6': 20260709, 'gpt-5.6-sol': 20260709, 'gpt-5.6-terra': 20260709, 'gpt-5.6-luna': 20260709,
  'gpt-5.5': 20260424, 'gpt-5.5-pro': 20260424, 'gpt-5.4-mini': 20260317, 'gpt-5.4-nano': 20260317,
  'gpt-5.4': 20260305, 'gpt-5.4-pro': 20260305, 'gpt-5.3-codex': 20260205,
  'gpt-5.2-codex': 20251218, 'gpt-5.2': 20251211, 'gpt-5.1-codex-max': 20251119,
  'gpt-5.1': 20251113, 'gpt-5.1-codex': 20251113, 'gpt-5.1-codex-mini': 20251113,
};

function modelId(model: string): string {
  return model.toLowerCase().replace(/-latest$/, '').replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '');
}

/**
 * 책임: 모델 정렬에 사용할 출시일 또는 snapshot 날짜를 찾는다.
 * 알고리즘: alias·날짜 접미사를 정규화해 등록 출시일을 우선 조회하고 없으면 모델명의 날짜를 해석한다.
 */
export function modelRelease(model: string): number | null {
  const id = modelId(model);
  if (Object.hasOwn(releases, id)) return releases[id];
  const snapshot = model.match(/-(\d{4})-?(\d{2})-?(\d{2})$/);
  return snapshot ? Number(snapshot.slice(1).join('')) : null;
}

/**
 * 책임: 출시일이 같거나 없는 모델에도 숫자 버전을 구분하는 정렬 키를 만든다.
 * 알고리즘: 정규화한 모델명의 각 숫자 구간을 12자리로 0 채워 문자열 비교가 숫자 순서를 따르게 한다.
 */
export function modelOrderKey(model: string): string {
  return modelId(model).replace(/\d+/g, value => value.padStart(12, '0'));
}
