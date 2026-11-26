// 상태 표시줄 사용량 카드의 구분선 스타일을 렌더러에 추가한다.
// [표시 정책] 설정 링크가 들어 있는 사용량 호버에만 구분선 스타일을 적용하고 문서별로 한 번 설치한다.
function configureQuotaDividers(item) {
  const document = item.container.ownerDocument;
  const id = 'agent-tracker-quota-divider-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '.monaco-hover:has(a[data-href="command:agentTracker.openSettings"]) hr{border-top:2px solid #888888;border-bottom:0;height:2px;margin:8px -8px;}';
  document.head.appendChild(style);
}

module.exports = { configureQuotaDividers };
