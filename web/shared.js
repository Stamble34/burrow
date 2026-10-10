// Shared between the service (Node) and the UI (browser).
// The whole app state changes only through these small operations, so the
// service, the desktop window and any browser tab can replay each other's edits.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurrowShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUSES = ['todo', 'doing', 'done'];

  function emptyState() {
    return {
      version: 1,
      boards: {},
      cards: {},
      links: {},
      settings: { accent: '#b8a4ff', activeBoardId: null },
    };
  }

  function uid(prefix) {
    const rnd = Math.random().toString(36).slice(2, 8);
    return (prefix || '') + Date.now().toString(36) + rnd;
  }

  // Ensure a loaded file has every field we expect (forward/backward safety).
  function normalize(s) {
    const base = emptyState();
    if (!s || typeof s !== 'object') return base;
    const out = {
      version: 1,
      boards: s.boards && typeof s.boards === 'object' ? s.boards : {},
      cards: s.cards && typeof s.cards === 'object' ? s.cards : {},
      links: s.links && typeof s.links === 'object' ? s.links : {},
      settings: Object.assign({}, base.settings, s.settings || {}),
    };
    for (const id in out.cards) {
      const c = out.cards[id];
      if (!STATUSES.includes(c.status)) c.status = 'todo';
      if (typeof c.x !== 'number') c.x = 0;
      if (typeof c.y !== 'number') c.y = 0;
      if (!out.boards[c.boardId]) delete out.cards[id];
    }
    for (const id in out.links) {
      const l = out.links[id];
      if (!out.cards[l.from] || !out.cards[l.to]) delete out.links[id];
    }
    if (!out.boards[out.settings.activeBoardId]) {
      const first = Object.values(out.boards).sort((a, b) => a.createdAt - b.createdAt)[0];
      out.settings.activeBoardId = first ? first.id : null;
    }
    return out;
  }

  // Apply one op in place. Returns true if something changed.
  function applyOp(s, op) {
    switch (op.t) {
      case 'card.put': {
        const c = op.card;
        if (!c || !c.id || !s.boards[c.boardId]) return false;
        s.cards[c.id] = Object.assign({}, s.cards[c.id] || {}, c);
        return true;
      }
      case 'card.del': {
        if (!s.cards[op.id]) return false;
        let parent = null;
        delete s.cards[op.id];
        for (const lid in s.links) {
          const l = s.links[lid];
          if (l.to === op.id && !parent && s.cards[l.from]) parent = l.from;
          if (l.from === op.id || l.to === op.id) delete s.links[lid];
        }
        // Captures keep going somewhere sensible: the card it was added under.
        for (const bid in s.boards) if (s.boards[bid].focusId === op.id) s.boards[bid].focusId = parent;
        return true;
      }
      case 'link.put': {
        const l = op.link;
        if (!l || !s.cards[l.from] || !s.cards[l.to] || l.from === l.to) return false;
        for (const lid in s.links) {
          const o = s.links[lid];
          if (lid !== l.id && o.from === l.from && o.to === l.to) return false; // no duplicates
        }
        s.links[l.id] = Object.assign({}, l);
        return true;
      }
      case 'link.del': {
        if (!s.links[op.id]) return false;
        delete s.links[op.id];
        return true;
      }
      case 'board.put': {
        const b = op.board;
        if (!b || !b.id) return false;
        s.boards[b.id] = Object.assign({}, s.boards[b.id] || {}, b);
        if (!s.settings.activeBoardId) s.settings.activeBoardId = b.id;
        return true;
      }
      case 'board.del': {
        if (!s.boards[op.id]) return false;
        delete s.boards[op.id];
        for (const cid in s.cards) if (s.cards[cid].boardId === op.id) applyOp(s, { t: 'card.del', id: cid });
        if (s.settings.activeBoardId === op.id) {
          const first = Object.values(s.boards).sort((a, b) => a.createdAt - b.createdAt)[0];
          s.settings.activeBoardId = first ? first.id : null;
        }
        return true;
      }
      case 'settings.put': {
        Object.assign(s.settings, op.settings || {});
        return true;
      }
      default:
        return false;
    }
  }

  // "Wikipedia: Linked list - Wikipedia" -> "Linked list"
  function cleanTitle(title, url) {
    let t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t && url) {
      try {
        const u = new URL(url);
        const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
        t = last.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '');
      } catch (e) { t = url; }
    }
    const seps = [' - ', ' | ', ' — ', ' – ', ' · ', ' :: '];
    for (const sep of seps) {
      const parts = t.split(sep);
      if (parts.length > 1 && parts[parts.length - 1].length <= 32 && parts.slice(0, -1).join(sep).length >= 3) {
        t = parts.slice(0, -1).join(sep).trim();
        break;
      }
    }
    return t.slice(0, 200) || 'Untitled';
  }

  return { STATUSES, emptyState, uid, normalize, applyOp, cleanTitle };
});
