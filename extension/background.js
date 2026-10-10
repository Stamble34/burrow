// Burrow capture extension for Zen / Firefox.
// Sends the current page (or a right-clicked link) to the Burrow service, which adds it
// as a prerequisite of the card you have selected in Burrow.
const API = 'http://127.0.0.1:7417';

function flash(text, color) {
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setBadgeText({ text });
  setTimeout(() => browser.browserAction.setBadgeText({ text: '' }), 2500);
}

function notify(title, message) {
  browser.notifications.create('burrow-' + Date.now(), {
    type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-96.png'), title, message,
  });
}

async function capture(url, title) {
  if (!/^https?:|^file:/.test(url || '')) {
    flash('!', '#ff8f8f');
    notify('Burrow', 'This page can’t be added. Only web pages and files can.');
    return;
  }
  try {
    const res = await fetch(API + '/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, title }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    flash('✓', '#7ef0c0');
    const where = d.parent ? `under “${d.parent.title}”` : `on “${d.board.name}”`;
    notify(d.existing ? 'Already in Burrow' : 'Added to Burrow', `${d.card.title}\n${where}`);
  } catch (e) {
    flash('!', '#ff8f8f');
    notify('Burrow isn’t running', 'Start it with: systemctl --user start burrow');
  }
}

async function captureActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) capture(tab.url, tab.title);
}

browser.browserAction.onClicked.addListener(captureActiveTab);
browser.commands.onCommand.addListener((cmd) => { if (cmd === 'capture-page') captureActiveTab(); });

browser.contextMenus.create({ id: 'burrow-link', title: 'Add link to Burrow', contexts: ['link'] });
browser.contextMenus.create({ id: 'burrow-page', title: 'Add page to Burrow', contexts: ['page'] });
browser.contextMenus.create({ id: 'burrow-open', title: 'Open Burrow', contexts: ['browser_action'] });

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'burrow-link') {
    // Link text is a good title; leave it empty for bare URLs so the service fetches the real title.
    const text = (info.linkText || '').replace(/\s+/g, ' ').trim();
    const vague = text.length < 4 || text === info.linkUrl || /^(here|link|this|source|more|read more|\[\d+\])$/i.test(text);
    capture(info.linkUrl, vague ? '' : text);
  }
  if (info.menuItemId === 'burrow-page') capture(tab.url, tab.title);
  if (info.menuItemId === 'burrow-open') browser.tabs.create({ url: API + '/' });
});
