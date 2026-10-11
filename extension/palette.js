// The palette in a small window, for pages where content scripts can't run (PDFs, about: pages, …).
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const pal = BurrowPalette.mount(document.body, {
  query: (q) => browser.runtime.sendMessage({ t: 'paletteQuery', q, tabId }),
  run: (item) => browser.runtime.sendMessage({ t: 'paletteRun', item, tabId }).finally(() => window.close()),
  onClose: () => setTimeout(() => window.close(), 50),
});
pal.open();
