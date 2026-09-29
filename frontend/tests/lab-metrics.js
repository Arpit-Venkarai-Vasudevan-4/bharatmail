(() => {
  const value = { profile: 'Production assets; local API; no CPU throttling; browser lab sample', navigation: {}, supported: PerformanceObserver.supportedEntryTypes || [] };
  let report;
  function paint() { if (report) report.textContent = JSON.stringify(value); }
  function observe(type, visit, extra = {}) {
    if (!value.supported.includes(type)) return;
    new PerformanceObserver(list => { list.getEntries().forEach(visit); paint(); }).observe({ type, buffered: true, ...extra });
  }
  observe('paint', entry => { if (entry.name === 'first-contentful-paint') value.fcpMs = Math.round(entry.startTime); });
  observe('largest-contentful-paint', entry => { value.lcpMs = Math.round(entry.startTime); });
  observe('layout-shift', entry => { if (!entry.hadRecentInput) value.cls = +(Number(value.cls || 0) + entry.value).toFixed(4); });
  observe('event', entry => { if (entry.interactionId) value.largestObservedInteractionMs = Math.max(value.largestObservedInteractionMs || 0, entry.duration); }, { durationThreshold: 16 });
  document.addEventListener('DOMContentLoaded', () => {
    report = document.createElement('output'); report.id = 'lab-metrics'; report.setAttribute('aria-label', 'Development performance measurements');
    report.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:80px;overflow:auto;background:#fff;color:#173f35;z-index:99999;font:11px/1.4 monospace;padding:6px;border-top:1px solid #ccc';
    document.body.append(report);
    function sample() {
      if (!value.shellUsableMs && document.querySelector('.topbar button,form button[type=submit]')) value.shellUsableMs = Math.round(performance.now());
      if (!value.mailboxDataMs && document.querySelector('.message-row,.message-list .empty-state')) value.mailboxDataMs = Math.round(performance.now());
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) value.navigation = { type: nav.type, transferSize: nav.transferSize, domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd) };
      value.viewport = { width: innerWidth, height: innerHeight }; paint();
    }
    new MutationObserver(sample).observe(document.getElementById('root'), { childList: true, subtree: true }); sample();
    window.addEventListener('load', sample);
    window.addEventListener('resize', sample);
  });
})();
