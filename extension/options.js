const DEFAULTS = { prompt: true, crumb: true };
const ids = Object.keys(DEFAULTS);
browser.storage.local.get(['burrowSettings', 'burrow']).then((r) => {
  const s = { ...DEFAULTS, ...((r.burrow && r.burrow.settings) || {}), ...(r.burrowSettings || {}) };
  for (const id of ids) document.getElementById(id).checked = !!s[id];
});
for (const id of ids) {
  document.getElementById(id).addEventListener('change', () => {
    const s = {}; for (const k of ids) s[k] = document.getElementById(k).checked;
    browser.storage.local.set({ burrowSettings: s });
  });
}
