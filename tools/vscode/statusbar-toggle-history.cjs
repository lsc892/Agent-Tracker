// 기존 workbench 패치의 주입 코드를 복원해 업그레이드 대상과 대조한다.

// Preserve the historical v3/v4 function verbatim to verify upgrades safely.
function configureQuotaHover(item, summary) {
  item._agentTrackerSummary = summary;
  if (item._agentTrackerHoverConfigured) return;
  item._agentTrackerHoverConfigured = true;
  const delegate = item.hoverDelegate;
  item.hoverDelegate = {
    get delay() { return delegate.delay; },
    get placement() { return delegate.placement; },
    get showNativeHover() { return delegate.showNativeHover; },
    showHover(options, focus) {
      if (item._agentTrackerSummary !== undefined && !focus) {
        if (item.hoverService.getStickyHover(item.container)) return undefined;
        options = { ...options, content: item._agentTrackerSummary };
      }
      return delegate.showHover(options, focus);
    },
    onDidHideHover() { delegate.onDidHideHover?.(); },
  };
  const stop = event => {
    if (item._agentTrackerSummary !== undefined && item.hoverService.getStickyHover(item.container)) event.stopImmediatePropagation();
  };
  for (const type of ['mouseover', 'focus']) item.container.addEventListener(type, stop, { capture: true });
  item._register({ dispose() {
    for (const type of ['mouseover', 'focus']) item.container.removeEventListener(type, stop, { capture: true });
  } });
}

// Preserve the historical v5 function verbatim to verify upgrades safely.
function configureQuotaCardHover(item) {
  item._agentTrackerQuotaHover = true;
  if (item._agentTrackerCardHoverConfigured) return;
  item._agentTrackerCardHoverConfigured = true;
  const delegate = item.hoverDelegate;
  item.hoverDelegate = {
    get delay() { return delegate.delay; },
    get placement() { return delegate.placement; },
    get showNativeHover() { return delegate.showNativeHover; },
    showHover(options, focus) {
      if (item._agentTrackerQuotaHover && !focus && item.hoverService.getStickyHover(item.container)) return undefined;
      return delegate.showHover(options, focus);
    },
    onDidHideHover() { delegate.onDidHideHover?.(); },
  };
  const stop = event => {
    if (item._agentTrackerQuotaHover && item.hoverService.getStickyHover(item.container)) event.stopImmediatePropagation();
  };
  for (const type of ['mouseover', 'focus']) item.container.addEventListener(type, stop, { capture: true });
  item._register({ dispose() {
    for (const type of ['mouseover', 'focus']) item.container.removeEventListener(type, stop, { capture: true });
  } });
}

// Preserve the v6 renderer and divider source used in the historical patch.
function configureQuotaCardToggle(item, toggle) {
  if (item._agentTrackerCardToggleConfigured) return;
  item._agentTrackerCardToggleConfigured = true;
  const { container, labelContainer, hoverService, executeCommand } = item;
  const handlesQuota = () => item.entry?.command === toggle;
  const isCardVisible = () => hoverService._hoverStack.some(({ hover, options: { target } }) =>
    !hover.isDisposed && (target === container || target.targetElements?.includes(container)));

  // Keep the visible card alive until the click runs, before VS Code's mousedown dismissal.
  const holdUntilClick = event => {
    if (event.button === 0 && handlesQuota() && labelContainer.contains(event.target) && isCardVisible()) {
      event.stopImmediatePropagation();
    }
  };
  const ignoreInternalMouseOver = event => {
    if (handlesQuota() && (event.relatedTarget?.nodeType && container.contains(event.relatedTarget) || hoverService.getStickyHover(container))) {
      event.stopImmediatePropagation();
    }
  };
  const capture = { capture: true };
  container.addEventListener('mousedown', holdUntilClick, capture);
  container.addEventListener('mouseover', ignoreInternalMouseOver, capture);
  item._register({ dispose() {
    container.removeEventListener('mousedown', holdUntilClick, capture);
    container.removeEventListener('mouseover', ignoreInternalMouseOver, capture);
  } });

  item.executeCommand = function (command, wasPinned) {
    const wasOpen = command === toggle && handlesQuota() ? wasPinned || isCardVisible() : wasPinned;
    return executeCommand.call(this, command, wasOpen);
  };
}

// Keep the v4–v6 style source independent of changes to the current view.
function configureQuotaDividers(item) {
  const document = item.container.ownerDocument;
  const id = 'agent-tracker-quota-divider-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '.monaco-hover:has(a[data-href="command:agentTracker.openSettings"]) hr{border-top:2px solid #888888;border-bottom:0;height:2px;margin:8px -8px;}';
  document.head.appendChild(style);
}

function getHistoricalInjections({ argument, symbol, condition, mapping, extensionId, end }) {
  const clickOnly = `if(!this._agentTrackerClickOnly){this._agentTrackerClickOnly=true;const stop=event=>{if(this.entry?.extensionId===${JSON.stringify(extensionId)}&&this.entry?.command===${symbol})event.stopImmediatePropagation();};for(const type of ["mouseover","focus"])this.container.addEventListener(type,stop,{capture:true});this._register({dispose:()=>{for(const type of ["mouseover","focus"])this.container.removeEventListener(type,stop,{capture:true});}});}`;
  const summarySource = configureQuotaHover.toString().replace(/\r\n/g, '\n');
  const cardSource = configureQuotaCardHover.toString().replace(/\r\n/g, '\n');
  const toggleSource = configureQuotaCardToggle.toString().replace(/\r\n/g, '\n');
  const dividerSource = configureQuotaDividers.toString().replace(/\r\n/g, '\n');
  const summary = `(${summarySource})(this,${argument}.ariaLabel??${argument}.name??"");`;
  const divider = `(${dividerSource})(this);`;
  const versions = [
    [1, `if(${condition}){${mapping}}`],
    [2, `if(${condition}){${mapping}${clickOnly}}`],
    [3, `if(${condition}){${summary}${mapping}}else{this._agentTrackerSummary=undefined;}`],
    [4, `if(${condition}){${summary}${mapping}${divider}}else{this._agentTrackerSummary=undefined;}`],
    [5, `if(${condition}){(${cardSource})(this);${mapping}${divider}}else{this._agentTrackerQuotaHover=false;}`],
    [6, `if(${condition}){(${toggleSource})(this,${symbol});${mapping}${divider}}`],
  ];
  return versions.map(([version, body]) => `/*agent-tracker:statusbar-toggle:v${version}*/${body}${end}`);
}

module.exports = { getHistoricalInjections };
