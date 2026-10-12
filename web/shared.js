// Shared between the service (Node) and the UI (browser).
// The whole app state changes only through these small operations, so the
// service, the desktop window and any browser tab can replay each other's edits.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BurrowShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUSES = ['todo', 'doing', 'done', 'parked'];
  const VERSION = 2;
  // A concept is the set of cards (one per board) that share a conceptId.
  // These fields are the concept itself; position, links and `context` stay per board.
  const CONCEPT_FIELDS = ['title', 'urls', 'note', 'tags', 'status', 'doneAt', 'parkedAt'];
  const RANK = { todo: 0, parked: 0, doing: 1, done: 2 };

  function emptyState() {
    return {
      version: VERSION,
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
      version: VERSION,
      boards: s.boards && typeof s.boards === 'object' ? s.boards : {},
      cards: s.cards && typeof s.cards === 'object' ? s.cards : {},
      links: s.links && typeof s.links === 'object' ? s.links : {},
      settings: Object.assign({}, base.settings, s.settings || {}),
    };
    for (const id in out.cards) {
      const c = out.cards[id];
      if (!STATUSES.includes(c.status)) c.status = 'todo';
      migrateCard(c);
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

  // Version 1 cards had one `url`; now a card keeps every page it was read on, primary first.
  function migrateCard(c) {
    if (typeof c.url === 'string' || !Array.isArray(c.urls)) {
      const urls = Array.isArray(c.urls) ? c.urls : [];
      if (typeof c.url === 'string' && c.url && !urls.some((u) => u.url === c.url)) urls.unshift({ url: c.url, title: c.title || '', visitedAt: c.createdAt || null });
      c.urls = urls;
      delete c.url;
    }
    return c;
  }

  const primaryUrl = (c) => (c && c.urls && c.urls[0] && c.urls[0].url) || '';

  // Apply one op in place. Returns true if something changed.
  function applyOp(s, op) {
    switch (op.t) {
      case 'card.put': {
        const c = op.card;
        if (!c || !c.id || !s.boards[c.boardId]) return false;
        const prev = s.cards[c.id];
        if ('url' in c) { // an op from an older client
          const legacy = c.url; delete c.url;
          if (!('urls' in c)) c.urls = legacy ? [{ url: legacy, title: c.title || (prev && prev.title) || '', visitedAt: Date.now() }, ...((prev && prev.urls) || []).filter((u) => u.url !== legacy)] : ((prev && prev.urls) || []).slice(1);
        }
        const next = Object.assign({}, prev || {}, c);
        if (!Array.isArray(next.urls)) next.urls = [];
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
  function findConcept(s, card, boardId) {
    const url = typeof card.url === 'string' ? card.url : primaryUrl(card);
    const tk = titleKey(card.title), uk = url ? urlKey(url) : '';
    if (tk.length < 2 && !uk) return null;
    let best = null;
    for (const c of Object.values(s.cards)) {
      if (c.boardId === boardId) continue;
      if (!((tk.length >= 2 && titleKey(c.title) === tk) || (uk && (c.urls || []).some((u) => urlKey(u.url) === uk)))) continue;
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

  // The ops that undo `op`, computed against the state before it is applied.
  function inverseOf(s, op) {
    const copy = (o) => JSON.parse(JSON.stringify(o));
    switch (op.t) {
      case 'card.put': {
        const prev = s.cards[op.card.id];
        if (!prev) return [{ t: 'card.del', id: op.card.id }];
        const back = copy(prev);
        for (const k in op.card) if (!(k in prev)) back[k] = null;
        return [{ t: 'card.put', card: back }];
      }
      case 'card.del': {
        const prev = s.cards[op.id];
        if (!prev) return [];
        const ls = Object.values(s.links).filter((l) => l.from === op.id || l.to === op.id);
        const out = [{ t: 'card.put', card: copy(prev) }, ...ls.map((l) => ({ t: 'link.put', link: { ...l } }))];
        const b = Object.values(s.boards).find((x) => x.focusId === op.id);
        if (b) out.push({ t: 'board.put', board: { id: b.id, focusId: op.id } });
        return out;
      }
      case 'link.put': {
        const prev = s.links[op.link.id];
        return prev ? [{ t: 'link.put', link: { ...prev } }] : [{ t: 'link.del', id: op.link.id }];
      }
      case 'link.del': {
        const prev = s.links[op.id];
        return prev ? [{ t: 'link.put', link: { ...prev } }] : [];
      }
      case 'board.put': {
        const prev = s.boards[op.board.id];
        return prev ? [{ t: 'board.put', board: { ...prev } }] : [{ t: 'board.del', id: op.board.id }];
      }
      case 'board.del': {
        const prev = s.boards[op.id];
        if (!prev) return [];
        const cs = Object.values(s.cards).filter((c) => c.boardId === op.id);
        const ids = new Set(cs.map((c) => c.id));
        const ls = Object.values(s.links).filter((l) => ids.has(l.from));
        return [{ t: 'board.put', board: { ...prev } }, ...cs.map((c) => ({ t: 'card.put', card: copy(c) })), ...ls.map((l) => ({ t: 'link.put', link: { ...l } })),
          { t: 'settings.put', settings: { activeBoardId: s.settings.activeBoardId } }];
      }
      case 'settings.put': {
        const back = {};
        for (const k in op.settings) back[k] = s.settings[k] ?? null;
        return [{ t: 'settings.put', settings: back }];
      }
    }
    return [];
  }

  // Apply ops and return the inverse that undoes all of them.
  function applyWithInverse(s, ops) {
    const inverse = [];
    for (const op of ops) { inverse.unshift(...inverseOf(s, op)); applyOp(s, op); }
    return inverse;
  }

  const parentsOf = (s, id) => Object.values(s.links).filter((l) => l.to === id && s.cards[l.from]).sort((a, b) => (a.id < b.id ? -1 : 1)).map((l) => s.cards[l.from]);
  const kidsOf = (s, id) => Object.values(s.links).filter((l) => l.from === id && s.cards[l.to]).map((l) => s.cards[l.to]);

  // Top-level card first, `id` last. With several parents it follows `prefer[cardId]` (the way you came)
  // when that is still a parent, otherwise the first-made link.
  function trailOf(s, id, prefer) {
    const out = []; const seen = new Set();
    let c = s.cards[id];
    while (c && !seen.has(c.id)) {
      seen.add(c.id); out.unshift(c);
      const ps = parentsOf(s, c.id);
      c = (prefer && ps.find((p) => p.id === prefer[c.id])) || ps[0];
    }
    return out;
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

  // New cards are titled in title case: "list of properties" -> "List of Properties". Words that already
  // carry capitals inside (BFS, iPhone) or look like code, notation or a URL are left as they are.
  const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'of', 'on', 'in', 'at', 'to', 'by', 'as', 'via', 'per', 'vs', 'with', 'from', 'into', 'onto', 'over', 'than']);
  function titleCase(title) {
    const parts = String(title || '').split(/(\s+)/);
    const words = parts.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
    const first = words[0], last = words[words.length - 1];
    let afterBreak = false, depth = 0;
    return parts.map((w, i) => {
      if (!/\S/.test(w)) return w;
      const force = i === first || i === last || afterBreak;
      afterBreak = /[:.!?—–]$/.test(w) || w === '-';
      // "O(n log n)" is notation; "(see below)" is prose.
      const math = depth > 0 || /^[^(\s]+\(/.test(w);
      if (math) depth = Math.max(0, depth + (w.match(/\(/g) || []).length - (w.match(/\)/g) || []).length);
      if (math || /[./_@\\=<>]\p{L}/u.test(w) || /\p{Lu}/u.test(w.slice(1))) return w;
      return w.split('-').map((part, k) => {
        const m = part.match(/^([^\p{L}\p{N}]*)(\p{L})(.*)$/u);
        if (!m) return part;
        const bare = (m[2] + m[3]).toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '');
        if (!force && k === 0 && SMALL_WORDS.has(bare)) return part.toLowerCase();
        return m[1] + m[2].toUpperCase() + m[3];
      }).join('-');
    }).join('');
  }

  return { titleCase, STATUSES, VERSION, CONCEPT_FIELDS, migrateCard, primaryUrl, inverseOf, applyWithInverse, parentsOf, kidsOf, trailOf, emptyState, uid, normalize, applyOp, cleanTitle, conceptCards, titleKey, urlKey, findConcept, joinOps, mergeRepeatedOps };
});
