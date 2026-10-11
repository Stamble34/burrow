const DEFAULTS = { prompt: true, crumb: true, engine: 'google' };
const ids = Object.keys(DEFAULTS);
const read = (id) => { const el = document.getElementById(id); return el.type === 'checkbox' ? el.checked : el.value; };
const write = (id, v) => { const el = document.getElementById(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
browser.storage.local.get(['burrowSettings', 'burrow']).then((r) => {
  const s = { ...DEFAULTS, ...((r.burrow && r.burrow.settings) || {}), ...(r.burrowSettings || {}) };
  for (const id of ids) write(id, s[id]);
});
for (const id of ids) {
  document.getElementById(id).addEventListener('change', () => {
    const s = {}; for (const k of ids) s[k] = read(k);
    browser.storage.local.set({ burrowSettings: s });
  });
}
