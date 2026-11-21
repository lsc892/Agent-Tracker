// 상태 표시줄 사용량 카드의 호버와 클릭 고정을 연결한다.
function configureQuotaCardToggle(item, toggle) {
  if (item._agentTrackerCardToggleConfigured) return;
  item._agentTrackerCardToggleConfigured = true;
  const { container, labelContainer, hoverService } = item;
  const handlesQuota = () => item.entry?.command === toggle;

  // VS Code's click command can pin a temporary hover if mousedown leaves it open.
  const holdUntilClick = event => {
    if (event.button !== 0 || !handlesQuota() || !labelContainer.contains(event.target)) return;
    const cardIsVisible = hoverService._hoverStack.some(({ hover, options: { target } }) =>
      !hover.isDisposed && (target === container || target.targetElements?.includes(container)));
    if (cardIsVisible) event.stopImmediatePropagation();
  };
  const ignoreInternalMouseOver = event => {
    if (!handlesQuota()) return;
    const previousTarget = event.relatedTarget;
    const insideItem = previousTarget?.nodeType && container.contains(previousTarget);
    if (insideItem || hoverService.getStickyHover(container)) event.stopImmediatePropagation();
  };

  const capture = { capture: true };
  container.addEventListener('mousedown', holdUntilClick, capture);
  container.addEventListener('mouseover', ignoreInternalMouseOver, capture);
  item._register({ dispose() {
    container.removeEventListener('mousedown', holdUntilClick, capture);
    container.removeEventListener('mouseover', ignoreInternalMouseOver, capture);
  } });
}

module.exports = { configureQuotaCardToggle };
