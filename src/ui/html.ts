import { escapeHtml } from './presentation';

export function dashboardHtml(scriptUri: string, styleUri: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}';">
<title>Agent Tracker</title><link rel="stylesheet" href="${escapeHtml(styleUri)}"></head>
<body><header><div><p class="eyebrow">AGENT TRACKER</p><h1>작업의 흐름을 한눈에</h1><p class="muted">Claude · Codex 요청별 사용 통계</p></div><button id="settings">설정</button></header>
<nav aria-label="대시보드"><button data-tab="usage" aria-current="page">사용량 통계</button><button data-tab="diagnostics">진단</button></nav>
<main><p id="configuration-warning" class="stale" role="status" hidden></p><p id="error" class="error" role="alert" hidden></p>
<section id="usage" aria-label="사용량 통계"><div class="section-title"><div><h2>사용량 통계</h2><p class="muted">사용량 통계 버튼으로 이 화면을 열 때 기록을 갱신합니다.</p></div><div class="actions"><button id="cancel-usage" hidden>취소</button></div></div>
<p id="usage-progress" role="status" aria-live="polite"></p><form id="usage-filters" class="filters">
<label>조회 단위<select id="group"><option value="day">일별</option><option value="month">월별</option><option value="project">프로젝트별</option><option value="session">세션별</option><option value="turn">사용자 요청별</option><option value="all">전체</option></select></label>
<label>제공자<select id="provider"><option value="">전체</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
<label>시작일<input id="from-day" type="date"></label><label>종료일<input id="to-day" type="date"></label>
<label>프로젝트명<input id="project-name" type="text" placeholder="이름으로 검색"></label><label>세션명<input id="session-name" type="text" placeholder="이름으로 검색"></label><button type="submit">조회</button></form>
<p id="timezone" class="muted"></p>
<section class="usage-chart" aria-label="사용량 도표"><div class="chart-heading"><h3 id="chart-title">총 토큰</h3><label>도표 지표 <select id="chart-metric"><option value="tokens">총 토큰</option><option value="requests">요청 수</option><option value="averageTokens">평균 토큰</option><option value="averageDuration">평균 시간</option></select></label></div><p id="chart-scope" class="muted"></p><div id="chart-legend" class="chart-legend"></div><div id="usage-chart" class="chart-plot"></div><p id="chart-detail" class="chart-detail muted" aria-live="polite"></p></section>
<div id="usage-table" class="table-wrap"></div><div class="pagination"><button id="previous">이전</button><span id="page-label"></span><button id="next">다음</button></div><p id="coverage" class="muted"></p>
<p class="muted note">Input은 캐시를 제외한 입력, Output은 출력, Cache Write는 캐시 생성, Cache Read는 캐시 재사용 토큰입니다. 네 항목의 합이 총 토큰이며, 아직 확인하지 못한 캐시 수치는 —로 표시합니다.</p>
<p class="muted note">총 토큰에는 진행 중·실패한 요청의 사용량도 포함됩니다. 중단된 Codex 요청은 집계에서 제외합니다. 평균은 성공적으로 완료한 요청만 계산하며, 소요 시간을 알 수 없는 요청은 시간 평균에서 제외합니다. 요청의 시작일을 기준으로 집계합니다.</p></section>
<section id="diagnostics" aria-label="진단" hidden><div class="section-title"><div><h2>진단</h2><p class="muted">최근 파일 처리 상태와 이전 통계를 유지한 이유를 확인합니다.</p></div><button id="refresh-diagnostics">다시 조회</button></div><p id="diagnostic-counts"></p><div id="diagnostic-files" class="table-wrap"></div><div class="pagination"><button id="diagnostic-previous">이전</button><span id="diagnostic-page"></span><button id="diagnostic-next">다음</button></div><h3>확인이 필요한 요청</h3><div id="diagnostic-summaries" class="table-wrap"></div></section>
</main><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}
