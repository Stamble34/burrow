// Shared between the service (Node) and the UI (browser).
// The whole app state changes only through these small operations, so the
// service, the desktop window and any browser tab can replay each other's edits.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurrowShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUSES = ['todo', 'doing', 'done'];
  // A concept is the set of cards (one per board) that share a conceptId.
  // These fields are the concept itself; position and links stay per board.
  const CONCEPT_FIELDS = ['title', 'url', 'note', 'status', 'doneAt'];
  const RANK = { todo: 0, doing: 1, done: 2 };

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
        const prev = s.cards[c.id];
        const next = Object.assign({}, prev || {}, c);
        s.cards[c.id] = next;
        if (next.conceptId) {
          const sibs = conceptCards(s, next.conceptId).filter((o) => o.id !== next.id);
          if (sibs.length) {
            if (!prev || prev.conceptId !== next.conceptId) {
              // Joining a concept: the card takes on what is already known about it.
              for (const f of CONCEPT_FIELDS) next[f] = sibs[0][f];
            } else {
              for (const f of CONCEPT_FIELDS) if (f in c) for (const o of sibs) o[f] = c[f];
            }
          }
        }
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

  function conceptCards(s, conceptId) {
    return conceptId ? Object.values(s.cards).filter((c) => c.conceptId === conceptId) : [];
  }

  // "Linked list", "linked  list!" and "Linked-List" are the same concept.
  function titleKey(title) {
    return String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function urlKey(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search;
    } catch (e) { return ''; }
  }

  // The best-known card on another board that is the same concept as this title/url.
  function findConcept(s, { title, url }, boardId) {
    const tk = titleKey(title), uk = url ? urlKey(url) : '';
    if (tk.length < 2 && !uk) return null;
    let best = null;
    for (const c of Object.values(s.cards)) {
      if (c.boardId === boardId) continue;
      if (!((tk.length >= 2 && titleKey(c.title) === tk) || (uk && c.url && urlKey(c.url) === uk))) continue;
      if (!best || RANK[c.status] > RANK[best.status]) best = c;
    }
    return best;
  }

  // Ops that make `card` (not yet part of a concept) share the concept of `match`.
  function joinOps(match, card) {
    const conceptId = match.conceptId || uid('k_');
    const ops = [];
    if (!match.conceptId) ops.push({ t: 'card.put', card: { id: match.id, boardId: match.boardId, conceptId } });
    ops.push({ t: 'card.put', card: { id: card.id, boardId: card.boardId, conceptId } });
    return ops;
  }

  // Ops that link every repeated title found across boards into one concept (for data that predates concepts).
  function mergeRepeatedOps(s) {
    const groups = new Map();
    for (const c of Object.values(s.cards)) {
      const k = titleKey(c.title);
      if (k.length < 2) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const ops = []; let concepts = 0, cards = 0;
    for (const list of groups.values()) {
      const perBoard = new Map();
      for (const c of list) if (!perBoard.has(c.boardId)) perBoard.set(c.boardId, c);
      const picked = [...perBoard.values()];
      const conceptId = (picked.find((c) => c.conceptId) || {}).conceptId || uid('k_');
      const todo = picked.filter((c) => c.conceptId !== conceptId && !c.conceptId);
      if (!todo.length) continue;
      const members = picked.filter((c) => c.conceptId === conceptId || !c.conceptId);
      if (members.length < 2) continue;
      const best = members.reduce((a, c) => (RANK[c.status] > RANK[a.status] ? c : a));
      for (const c of members) if (c.conceptId !== conceptId) ops.push({ t: 'card.put', card: { id: c.id, boardId: c.boardId, conceptId } });
      ops.push({ t: 'card.put', card: { id: best.id, boardId: best.boardId, status: best.status, doneAt: best.doneAt || null } });
      concepts++; cards += todo.length;
    }
    return { ops, concepts, cards };
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

  return { STATUSES, CONCEPT_FIELDS, emptyState, uid, normalize, applyOp, cleanTitle, conceptCards, titleKey, urlKey, findConcept, joinOps, mergeRepeatedOps };
});
