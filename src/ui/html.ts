import { escapeHtml } from './presentation';

export function dashboardHtml(scriptUri: string, styleUri: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}';">
<title>Agent Tracker</title><link rel="stylesheet" href="${escapeHtml(styleUri)}"></head>
<body><header><div><p class="eyebrow">AGENT TRACKER</p><h1>작업의 흐름을 한눈에</h1><p class="muted">Claude · Codex 요청별 사용 통계</p></div><button id="settings">설정</button></header>
<main><p id="configuration-warning" class="stale" role="status" hidden></p><p id="error" class="error" role="alert" hidden></p>
<section id="usage" aria-label="사용량 통계"><div class="section-title"><div><h2>사용량 통계</h2><p class="muted">사용량 통계 버튼으로 이 화면을 열 때 기록을 갱신합니다.</p></div><div class="actions"><button id="cancel-usage" hidden>취소</button></div></div>
<p id="usage-progress" role="status" aria-live="polite"></p><form id="usage-filters" class="filters">
<label>조회 단위<select id="group"><option value="day">일별</option><option value="month">월별</option><option value="project">프로젝트별</option><option value="session">세션별</option><option value="turn">사용자 요청별</option><option value="all">전체</option></select></label>
<label>제공자<select id="provider"><option value="">전체</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
<label>시작일<input id="from-day" type="date"></label><label>종료일<input id="to-day" type="date"></label>
<div class="name-picker" id="project-picker"><span id="project-caption">프로젝트명</span><button id="project-name" type="button" aria-labelledby="project-caption project-name" aria-expanded="false" aria-controls="project-options">전체 프로젝트</button><div id="project-options" class="name-options" role="group" aria-label="프로젝트 목록" hidden><div id="project-list"></div><p id="project-list-status" class="muted" role="status"></p></div></div>
<div class="name-picker" id="session-picker"><span id="session-caption">세션명</span><button id="session-name" type="button" aria-labelledby="session-caption session-name" aria-expanded="false" aria-controls="session-options">전체 세션</button><div id="session-options" class="name-options" role="group" aria-label="세션 목록" hidden><div id="session-list"></div><p id="session-list-status" class="muted" role="status"></p></div></div><button type="submit">조회</button></form>
<p id="timezone" class="muted"></p>
<section class="usage-chart" aria-label="사용량 도표"><div class="chart-heading"><h3 id="chart-title">총 토큰</h3><label>도표 지표 <select id="chart-metric"><option value="tokens">총 토큰</option><option value="requests">요청 수</option><option value="averageTokens">평균 토큰</option><option value="averageDuration">평균 시간</option></select></label></div><p id="chart-scope" class="muted"></p><div id="chart-legend" class="chart-legend"></div><div id="usage-chart" class="chart-plot"></div><p id="chart-detail" class="chart-detail muted" aria-live="polite"></p></section>
<div id="usage-table" class="table-wrap"></div><div class="pagination"><button id="previous">이전</button><span id="page-label"></span><button id="next">다음</button></div><p id="coverage" class="muted"></p>
<p class="muted note">Input은 캐시를 제외한 입력, Output은 출력, Cache Write는 캐시 생성, Cache Read는 캐시 재사용 토큰입니다. 네 항목의 합이 총 토큰이며, 아직 확인하지 못한 캐시 수치는 —로 표시합니다.</p>
<p class="muted note">총 토큰에는 진행 중·실패한 요청의 사용량도 포함됩니다. 중단된 Codex 요청은 집계에서 제외합니다. 평균은 성공적으로 완료한 요청만 계산하며, 소요 시간을 알 수 없는 요청은 시간 평균에서 제외합니다. 요청의 시작일을 기준으로 집계합니다.</p></section>
<footer class="dashboard-footer"><a id="open-diagnostics" href="#">데이터 확인</a></footer>
</main><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}

export function diagnosticsHtml(scriptUri: string, styleUri: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}';">
<title>Agent Tracker 데이터 확인</title><link rel="stylesheet" href="${escapeHtml(styleUri)}"></head>
<body><header><div><p class="eyebrow">AGENT TRACKER</p><h1>데이터 확인</h1><p class="muted">저장된 처리 상태를 조회합니다. 원본 확인·재집계는 사용량 통계 화면을 다시 열 때 진행합니다.</p></div><button id="settings">설정</button></header>
<main><p id="configuration-warning" class="stale" role="status" hidden></p><p id="error" class="error" role="alert" hidden></p>
<section id="diagnostics" aria-label="데이터 확인"><div class="section-title"><h2>파일 처리 상태</h2><button id="refresh-diagnostics" title="원본을 재검증하지 않고 저장된 상태만 다시 조회합니다.">다시 조회</button></div><p id="diagnostic-counts"></p><div id="diagnostic-files" class="table-wrap"></div><div class="pagination"><button id="diagnostic-previous">이전</button><span id="diagnostic-page"></span><button id="diagnostic-next">다음</button></div><h3>확인이 필요한 요청</h3><p class="muted note">품질 경고나 갱신 실패가 기록된 요청입니다. 경고만으로 통계에서 제외하지 않으며, 갱신에 실패한 요청은 이전 정상 수치를 유지합니다.</p><div id="diagnostic-summaries" class="table-wrap"></div></section>
</main><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}
