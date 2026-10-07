import { escapeHtml } from './presentation';

export function colorSettingsHtml(scriptUri:string,styleUri:string,cspSource:string,nonce:string):string {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}';">
<title>Agent Tracker 색상</title><link rel="stylesheet" href="${escapeHtml(styleUri)}"></head>
<body><header><div><p class="eyebrow">AGENT TRACKER</p><h1>상태 표시줄 색상</h1><p class="muted">로고·잔량 막대·글자와 새로고침 버튼에 적용합니다.</p></div></header>
<main><form id="color-settings" class="color-settings">
<label>색상 모드<select id="color-mode"><option value="automatic">자동</option><option value="white">흰색</option><option value="black">검은색</option><option value="custom">사용자 지정</option></select></label>
<p class="muted note">자동은 현재 VS Code 테마와 작업공간의 상태 표시줄 색상을 따릅니다.</p>
<div class="color-inputs"><label>색상 선택<input id="color-picker" type="color" value="#ffffff" aria-label="색상 견본을 클릭해 선택"></label><label>HEX 색상<input id="color-hex" type="text" value="#ffffff" placeholder="#abc 또는 #aabbcc" maxlength="9" spellcheck="false" autocomplete="off"></label></div>
<label>불투명도 <output id="color-opacity-value">100%</output><input id="color-opacity" type="range" min="0" max="255" value="255" step="1"></label>
<p class="muted note">색상 견본을 클릭하거나 #RGB·#RGBA·#RRGGBB·#RRGGBBAA 값을 입력하면 사용자 지정 모드로 전환됩니다.</p>
<p class="muted">미리 보기</p><div id="color-preview" class="color-preview">Claude ▰ 33% 사용　│　Codex ▰ 69% 사용　↻</div>
<label>저장 위치<select id="color-target"><option value="user">사용자 — 모든 창</option><option value="workspace">현재 작업공간</option></select></label><p class="muted note">작업공간에 지정한 값은 사용자 설정보다 우선합니다.</p>
<p id="color-status" role="status" aria-live="polite"></p><button id="color-apply" type="submit">적용</button>
</form></main><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}

export function dashboardHtml(scriptUri: string, styleUri: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}';">
<title>Agent Tracker</title><link rel="stylesheet" href="${escapeHtml(styleUri)}"></head>
<body><header><div><p class="eyebrow">AGENT TRACKER</p><h1>작업의 흐름을 한눈에</h1><p class="muted">Claude · Codex 요청별 사용 통계</p></div><button id="settings">설정</button></header>
<main><p id="configuration-warning" class="stale" role="status" hidden></p><p id="error" class="error" role="alert" hidden></p>
<section id="usage" aria-label="사용량 통계"><div class="section-title"><div><h2>사용량 통계</h2><p class="muted">사용량 통계 버튼으로 이 화면을 열 때 기록을 갱신합니다.</p></div><div class="actions"><button id="cancel-usage" hidden>취소</button></div></div>
<p id="usage-progress" role="status" aria-live="polite"></p>
<div class="segmented statistics-sections" role="group" aria-label="통계 구역"><button id="section-tokens" type="button" aria-pressed="true" aria-controls="token-section">토큰</button><button id="section-skills" type="button" aria-pressed="false" aria-controls="skill-section">Skill</button></div>
<form id="usage-filters" class="filters">
<label id="group-control">조회 단위<select id="group"><option value="day">일별</option><option value="month">월별</option><option value="project">프로젝트별</option><option value="session">세션별</option><option value="turn">사용자 요청별</option><option value="all">전체</option></select></label>
<label>제공자<select id="provider"><option value="">전체</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
<div id="chart-by-control" class="filter-toggle"><span>집계 기준</span><div class="segmented" role="group" aria-label="집계 기준"><button id="chart-provider" type="button" aria-pressed="true">제공자별</button><button id="chart-model" type="button" aria-pressed="false">모델별</button></div></div>
<label>시작일<input id="from-day" type="date"></label><label>종료일<input id="to-day" type="date"></label>
<div class="name-picker" id="project-picker"><span id="project-caption">프로젝트명</span><button id="project-name" type="button" aria-labelledby="project-caption project-name" aria-expanded="false" aria-controls="project-options">전체 프로젝트</button><div id="project-options" class="name-options" role="group" aria-label="프로젝트 목록" hidden><div id="project-list"></div><p id="project-list-status" class="muted" role="status"></p></div></div>
<div class="name-picker" id="session-picker"><span id="session-caption">세션명</span><button id="session-name" type="button" aria-labelledby="session-caption session-name" aria-expanded="false" aria-controls="session-options">전체 세션</button><div id="session-options" class="name-options" role="group" aria-label="세션 목록" hidden><div id="session-list"></div><p id="session-list-status" class="muted" role="status"></p></div></div><button type="submit">조회</button><button id="reset-filters" type="button">초기화</button></form>
<p id="timezone" class="muted"></p>
<div id="token-section">
<div class="cost-controls"><label id="billing-control" hidden>선택한 세션의 결제 방식 <select id="billing-mode"><option value="unknown">미확인</option><option value="subscription">구독 (0원)</option><option value="api">충전 API</option></select></label></div>
<p id="cost-note" class="muted note" hidden>구독 사용은 0원입니다. 충전 API는 기록의 모델·토큰과 표준 단가로 계산한 추정 비용(USD)이며 실제 청구액·충전 잔액과 다를 수 있습니다. 결제 방식이 미확인인 기록은 세션을 선택해 지정해 주세요. 세션 전체에 적용되며 저장 후 다시 열어도 유지됩니다. 단가가 없거나 토큰 구성이 미확인인 비용은 합산하지 않고 미확인으로 표시합니다. 도구 요금·할인·빠른 처리·긴 문맥·캐시 보관 기간별 추가 요금은 반영하지 않습니다.</p>
<section class="usage-chart" aria-label="사용량 도표"><div class="chart-heading"><h3 id="chart-title">총 토큰</h3><label>도표 지표 <select id="chart-metric"><option value="tokens">총 토큰</option><option value="requests">요청 수</option><option value="averageTokens">평균 토큰</option><option value="averageDuration">평균 시간</option></select></label></div><p id="chart-scope" class="muted"></p><ul id="chart-legend" class="chart-legend" aria-label="토큰 구성 색상 범례" hidden></ul><div id="usage-chart" class="chart-plot"></div><p id="chart-detail" class="chart-detail muted" aria-live="polite"></p></section>
<div id="usage-table" class="table-wrap"></div><div class="pagination"><button id="previous">이전</button><span id="page-label"></span><button id="next">다음</button></div><p id="coverage" class="muted"></p>
<p id="model-note" class="muted note" hidden>모델별 요청 수는 해당 모델을 사용한 요청 수이며 여러 모델을 쓴 요청은 각 모델에 포함합니다. 소요 시간과 평균 시간은 해당 모델을 포함한 요청 전체의 시간입니다. 표에는 모든 모델을 개별 표시합니다. 모델 정보와 토큰 사용량이 없는 요청은 ‘사용량 기록 없음’, 토큰은 있지만 모델을 확인할 수 없는 기록은 ‘모델 미상’으로 구분합니다.</p>
<p class="muted note">Input은 캐시를 제외한 입력, Output은 출력, Cache Write는 캐시 생성, Cache Read는 캐시 재사용 토큰입니다. 네 항목의 합이 총 토큰이며, 아직 확인하지 못한 캐시 수치는 —로 표시합니다.</p>
<p class="muted note">총 토큰에는 진행 중·실패한 요청의 사용량도 포함됩니다. 중단된 Codex 요청은 집계에서 제외합니다. 평균은 성공적으로 완료한 요청만 계산하며, 소요 시간을 알 수 없는 요청은 시간 평균에서 제외합니다. 요청의 시작일을 기준으로 집계합니다.</p></div>
<div id="skill-section" hidden><h3>Skill 사용 통계</h3>
<div id="skill-disabled" hidden><p class="muted">Skill 통계 집계가 꺼져 있습니다. 기존 데이터는 보존되며 설정에서 다시 켜면 AI 호출 기록도 포함해 재계산합니다.</p><button id="skill-settings" type="button">설정 열기</button></div>
<div id="skill-content">
${(['skill','subagent','plugin','model'] as const).map((category,index)=>`<section class="capability-statistics" aria-label="${['스킬','서브에이전트','플러그인','모델'][index]}별 사용 통계"><div class="chart-heading"><h3>${['스킬','서브에이전트','플러그인','모델'][index]}</h3><span id="${category}-total" class="muted"></span></div><div id="${category}-table" class="table-wrap"></div><div class="pagination"><button id="${category}-previous" type="button">이전</button><span id="${category}-page"></span><button id="${category}-next" type="button">다음</button></div></section>`).join('')}
<p class="muted note">사용자가 명시적으로 요청한 경우와 AI가 스스로 선택해 호출한 경우를 모두 집계합니다.</p>
<p class="muted note">선택한 제공자·프로젝트·세션·기간의 사용 횟수입니다. 비율은 각 분류의 전체 사용 횟수를 기준으로 계산하며 페이지를 바꿔도 분모는 유지됩니다. 기간은 사용자 요청 시작일을 따르며, 기간을 지정하면 시작 시각이 없는 요청은 제외합니다.</p>
<p class="muted note">스킬은 스킬 실행·설명 파일 읽기, 서브에이전트는 생성 호출, 플러그인은 소속 스킬·외부 도구 호출, 모델은 중복을 제거한 응답을 셉니다. 외부 도구는 MCP 서버명으로 표시합니다. Codex의 묶음 실행은 로그의 호출 코드 기준으로 세므로 실제 반복·조건부 실행 횟수와 다를 수 있습니다. 기록에서 확인되는 사용만 포함하며 모델 미상은 별도 표시합니다. 중단된 Codex 요청은 제외합니다.</p>
</div></div></section>
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
