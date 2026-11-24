/**
 * The Gift Auction — Google Apps Script web app.
 *
 * Two modes per present:
 *  - Live auction: open, rising bids with a countdown that resets on every bid.
 *  - Sealed bids: everyone bids secretly, the auctioneer reveals the highest.
 *
 * The auctioneer PIN is NOT stored in this file, so it never ends up in git.
 * Set it in the Apps Script editor: Project Settings > Script properties >
 * add property HOST_PIN with the PIN you want.
 */
var START = 100, STEP = 10, MIN = 10;
var LIVE_OPEN_MS = 20000;   // clock when bidding opens
var LIVE_RESET_MS = 15000;  // clock after every new bid
var LIVE_GRACE_MS = 1000;   // bids this late still count, to cover phone lag
var HISTORY_MAX = 40;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('The Gift Auction')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- storage (Script Properties, one key per part) ---------- */
function read_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    game: p.game ? JSON.parse(p.game) : freshGame_(),
    players: p.players ? JSON.parse(p.players) : {},
    bids: p.bids ? JSON.parse(p.bids) : {}
  };
}
function write_(s) {
  PropertiesService.getScriptProperties().setProperties({
    game: JSON.stringify(s.game),
    players: JSON.stringify(s.players),
    bids: JSON.stringify(s.bids)
  });
}
function freshGame_() {
  return { phase: 'lobby', mode: 'live', round: 0, sub: 0, present: '', eligible: [], results: [], reveal: null, live: null };
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- single entry point called from the page ---------- */
function api(req) {
  req = req || {};
  var id = String(req.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('Reload the page to join the auction.');
  var act = String(req.act || 'view');

  if (act === 'view') {
    var s = read_();
    if (liveExpired_(s)) {
      s = withLock_(function () {
        var t = read_();
        if (liveExpired_(t)) { finalizeLive_(t); write_(t); }
        return t;
      });
    }
    return view_(s, id, req.pin);
  }

  return withLock_(function () {
    var s = read_();
    if (liveExpired_(s)) { finalizeLive_(s); write_(s); }
    apply_(s, act, req, id);
    write_(s);
    return view_(s, id, req.pin);
  });
}

function hostPin_() { return PropertiesService.getScriptProperties().getProperty('HOST_PIN') || ''; }
function isHost_(pin) { var p = hostPin_(); return !!p && String(pin || '') === p; }

function winners_(s) {
  var w = {};
  (s.game.results || []).forEach(function (r) { if (r.winner) w[r.winner] = r; });
  return w;
}
function playerIds_(s) {
  return Object.keys(s.players).sort(function (a, b) {
    return (s.players[a].joinedAt || 0) - (s.players[b].joinedAt || 0);
  });
}
function remaining_(s) {
  var w = winners_(s);
  return playerIds_(s).filter(function (id) { return !w[id]; });
}
function eligible_(s) {
  return (s.game.eligible || []).filter(function (id) { return s.players[id]; });
}
function curBid_(s, id) {
  var b = s.bids[id], g = s.game;
  if (!b || b.round !== g.round || (b.sub || 0) !== (g.sub || 0)) return null;
  return b;
}
function nameOf_(s, id) { return (s.players[id] && s.players[id].name) || 'A bidder'; }

function award_(s, id, amount, list, drawn) {
  var g = s.game;
  g.results.push({ round: g.round, present: g.present, winner: id, amount: amount, mode: g.mode });
  g.phase = 'sold';
  g.reveal = { bids: list, winner: id, amount: amount, drawn: !!drawn };
}

/* ---------- live auction ---------- */
function freshLive_() {
  var now = Date.now();
  return { high: 0, leader: null, history: [], best: {}, endsAt: now + LIVE_OPEN_MS, startedAt: now };
}
function liveExpired_(s) {
  return s.game.phase === 'live' && s.game.live && Date.now() > s.game.live.endsAt + LIVE_GRACE_MS;
}
function finalizeLive_(s) {
  var g = s.game, L = g.live || {};
  if (!L.leader) { g.phase = 'nobid'; g.reveal = { bids: [] }; return; }
  var best = L.best || {};
  var list = Object.keys(best).map(function (pid) {
    return { id: pid, name: nameOf_(s, pid), amount: best[pid] };
  }).sort(function (a, b) { return b.amount - a.amount; });
  award_(s, L.leader, L.high, list, false);
}

function apply_(s, act, req, id) {
  var g = s.game;
  var hostActs = { open: 1, reveal: 1, rebid: 1, draw: 1, reopen: 1, unsold: 1, finish: 1, reset: 1, unlock: 1, hammer: 1 };
  if (hostActs[act] && !hostPin_()) throw new Error('No auctioneer PIN is set yet. Add a HOST_PIN script property in the Apps Script project settings.');
  if (hostActs[act] && !isHost_(req.pin)) throw new Error('That PIN is not right.');

  switch (act) {
    case 'unlock': return;

    case 'join': {
      var name = String(req.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!name) throw new Error('Type your name to join.');
      var prev = s.players[id];
      s.players[id] = { name: name, joinedAt: prev ? prev.joinedAt : Date.now() };
      return;
    }

    /* live mode: raise the current high bid */
    case 'raise': {
      if (!s.players[id]) throw new Error('Join the auction first.');
      if (g.phase !== 'live') throw new Error('Bidding on this present has closed.');
      if (eligible_(s).indexOf(id) < 0) throw new Error('You can’t bid on this present.');
      var L = g.live;
      if (L.leader === id) throw new Error('You’re already winning.');
      var a = Number(req.amount);
      if (!(a >= MIN && a <= START && a % STEP === 0)) throw new Error('Bids go up to $100 in $10 steps.');
      if (a <= L.high) throw new Error(nameOf_(s, L.leader) + ' just bid $' + L.high + '. Raise again if you want it.');
      var now = Date.now();
      L.high = a; L.leader = id;
      L.best[id] = a;
      L.history.push({ id: id, amount: a, at: now });
      if (L.history.length > HISTORY_MAX) L.history = L.history.slice(-HISTORY_MAX);
      L.endsAt = Math.max(L.endsAt, now + LIVE_RESET_MS);
      return;
    }
    case 'hammer': {
      if (g.phase === 'live') finalizeLive_(s);
      return;
    }

    /* sealed mode */
    case 'bid':
    case 'skip': {
      if (!s.players[id]) throw new Error('Join the auction first.');
      if (g.phase !== 'bidding' || eligible_(s).indexOf(id) < 0) throw new Error('Bidding isn’t open for you right now.');
      if (act === 'skip') {
        s.bids[id] = { round: g.round, sub: g.sub || 0, skip: true, amount: 0, at: Date.now() };
        return;
      }
      var b = Number(req.amount);
      if (!(b >= MIN && b <= START && b % STEP === 0)) throw new Error('Bids go from $10 to $100 in $10 steps.');
      s.bids[id] = { round: g.round, sub: g.sub || 0, amount: b, at: Date.now() };
      return;
    }
    case 'reveal': {
      if (g.phase !== 'bidding') return;
      var list = [];
      eligible_(s).forEach(function (pid) {
        var cb = curBid_(s, pid);
        if (cb && !cb.skip) list.push({ id: pid, name: nameOf_(s, pid), amount: Number(cb.amount) });
      });
      list.sort(function (x, y) { return y.amount - x.amount; });
      if (!list.length) { g.phase = 'nobid'; g.reveal = { bids: [] }; return; }
      var top = list[0].amount;
      var tied = list.filter(function (x) { return x.amount === top; }).map(function (x) { return x.id; });
      if (tied.length > 1) { g.phase = 'tie'; g.reveal = { bids: list, tied: tied, amount: top }; return; }
      award_(s, list[0].id, top, list, false);
      return;
    }
    case 'rebid': {
      if (g.phase !== 'tie') return;
      g.phase = 'bidding'; g.sub = (g.sub || 0) + 1; g.eligible = (g.reveal.tied || []).slice(); g.reveal = null;
      return;
    }
    case 'draw': {
      if (g.phase !== 'tie') return;
      var t = g.reveal.tied || [];
      if (!t.length) return;
      award_(s, t[Math.floor(Math.random() * t.length)], g.reveal.amount, g.reveal.bids || [], true);
      return;
    }

    /* shared */
    case 'open': {
      if (!playerIds_(s).length) throw new Error('Wait for at least one bidder to join.');
      if (g.phase !== 'lobby' && g.phase !== 'sold') return;
      var left = remaining_(s);
      if (!left.length) { g.phase = 'done'; g.reveal = null; return; }
      var round = g.results.length + 1;
      g.mode = req.mode === 'sealed' ? 'sealed' : 'live';
      g.round = round; g.sub = 0;
      g.present = String(req.present || '').trim().slice(0, 40) || ('Present ' + round);
      g.eligible = left; g.reveal = null;
      if (g.mode === 'live') { g.phase = 'live'; g.live = freshLive_(); }
      else { g.phase = 'bidding'; g.live = null; }
      return;
    }
    case 'reopen': {
      if (g.phase !== 'nobid') return;
      g.sub = (g.sub || 0) + 1; g.reveal = null;
      if (g.mode === 'live') { g.phase = 'live'; g.live = freshLive_(); }
      else g.phase = 'bidding';
      return;
    }
    case 'unsold': {
      if (g.phase !== 'nobid') return;
      g.results.push({ round: g.round, present: g.present, winner: null, amount: 0, mode: g.mode });
      g.phase = 'sold'; g.reveal = { bids: [], winner: null, amount: 0 };
      return;
    }
    case 'finish': { g.phase = 'done'; g.reveal = null; g.live = null; return; }
    case 'reset': { s.game = freshGame_(); s.players = {}; s.bids = {}; return; }
  }
  throw new Error('Unknown action.');
}

/* ---------- what each phone is allowed to see ---------- */
function view_(s, id, pin) {
  var host = isHost_(pin);
  var players = playerIds_(s).map(function (pid) {
    return { id: pid, name: s.players[pid].name, joinedAt: s.players[pid].joinedAt };
  });
  var decided = null;
  if (host && s.game.phase === 'bidding') {
    decided = {};
    eligible_(s).forEach(function (pid) {
      var b = curBid_(s, pid);
      if (b) decided[pid] = b.skip ? 'skip' : 'bid';
    });
  }
  // Live bids are public. Sealed bid amounts are never sent to anyone,
  // the auctioneer included, until the reveal.
  return {
    me: id, host: host, now: Date.now(), game: s.game, players: players,
    myBid: s.game.phase === 'bidding' ? curBid_(s, id) : null, decided: decided
  };
}
