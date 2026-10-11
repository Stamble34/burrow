// Fallback for pages where content scripts can't run (PDF viewer, addons.mozilla.org, …):
// the same question in a small popup window, which takes focus.
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const answer = (choice) => browser.runtime.sendMessage({ t: 'promptAnswer', tabId, choice }).finally(() => window.close());

browser.runtime.sendMessage({ t: 'promptData', tabId }).then((p) => {
  if (!p) return window.close();
  document.getElementById('q').innerHTML = `Add <b>“${esc(p.title)}”</b> under <b>“${esc(p.parent)}”</b>?`;
  document.getElementById('sib').lastChild.textContent = ` Next to “${p.parent}”`;
  if (p.note) { const n = document.getElementById('note'); n.textContent = p.note; n.hidden = false; }
  document.body.focus();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); answer(e.shiftKey ? 'sibling' : 'child'); }
  else if (e.key === 'Escape') { e.preventDefault(); answer('ignore'); }
});
document.addEventListener('click', (e) => { const b = e.target.closest('button[data-c]'); if (b) answer(b.dataset.c); });
