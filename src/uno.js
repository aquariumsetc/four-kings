import { DurableObject } from "cloudflare:workers";

// ---------- Ultium UNO: rules (server-side, authoritative) ----------
const COLS = ["R", "Y", "G", "B"];
const CNAME = { R: "red", Y: "yellow", G: "green", B: "blue" };
const WILDS = ["wild", "w4", "steal", "pass", "mirror", "cust"];
const ACTION = ["skip", "rev", "d2", ...WILDS];
const DRAWS = ["d2", "w4", "mirror"];
const START_BAL = 1000;
const NEXT_MS = 20000;   // game over: next game after this (if auto-next)
const NUDGE_MS = 15000;  // idle player: phone nudges this long before auto-move
const MAX_PLAYS = 800;   // safety net: a game this long finishes itself (fewest cards wins)
// new tables start on the Party preset (see PRESETS below)
const RULES = { multi: true, stack: true, playPicked: true, steal: true, pass: true, mirror: false, drawUntil: false, official: false, callUno: false, useCustoms: true };
// one-tap rule sets. "official" follows the printed rules: draw one and only that card may be played,
// no stacking, +4 only without a card of the current colour, and call UNO or get caught for 2.
const PRESETS = {
  official: { multi: false, stack: false, playPicked: false, steal: false, pass: false, mirror: false, drawUntil: false, official: true, callUno: true, useCustoms: false },
  party: { multi: true, stack: true, playPicked: true, steal: true, pass: true, mirror: false, drawUntil: false, official: false, callUno: false, useCustoms: true },
  chaos: { multi: true, stack: true, playPicked: true, steal: true, pass: true, mirror: true, drawUntil: false, official: false, callUno: false, useCustoms: true },
};
const BOT_NAMES = ["Robo Rita", "Dealer Dan", "Lucky Lou", "Queenie", "Ace Alvarez", "Blackjack Bea", "Shuffle Sam"];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function fresh() {
  return {
    phase: "lobby", players: [], deck: [], pile: [], colour: null, dir: 1, turn: 0, first: 0, drawStack: 0, drew: false,
    pot: 0, stake: 20, turnMs: 60000, autoNext: true, rules: { ...RULES }, customs: ["", "", "", ""],
    game: 0, winner: null, note: "", event: null, ledger: {}, turnAt: 0, overAt: 0, nextId: 1, v: 0,
  };
}
const shuffle = (d) => { for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; };
function buildDeck(st) {
  const d = [], add = (c, v, t) => d.push({ id: st.nextId++, c, v, ...(t !== undefined ? { t } : {}) });
  for (const c of COLS) {
    add(c, "0");
    for (let n = 1; n <= 9; n++) { add(c, String(n)); add(c, String(n)); }
    for (const v of ["skip", "rev", "d2"]) { add(c, v); add(c, v); }
  }
  for (let k = 0; k < 4; k++) { add("W", "wild"); add("W", "w4"); }
  if (st.rules.steal) { add("W", "steal"); add("W", "steal"); }
  if (st.rules.pass) { add("W", "pass"); add("W", "pass"); }
  if (st.rules.mirror) { add("W", "mirror"); add("W", "mirror"); }
  if (st.rules.useCustoms !== false) st.customs.forEach((txt, i) => { if (txt && txt.trim()) { add("W", "cust", i); add("W", "cust", i); } });
  return shuffle(d);
}
const isWild = (c) => WILDS.includes(c.v);
const same = (a, b) => a.c === b.c && a.v === b.v && a.t === b.t;
const top = (st) => st.pile.length ? st.pile[st.pile.length - 1].c : null;
const ins = (st) => st.players.map((p, i) => i).filter((i) => st.players[i].in);
const pidx = (st, id) => st.players.findIndex((p) => p.id === id);
const cardName = (c) => (c.c === "W" ? "" : CNAME[c.c] + " ") + ({ skip: "skip", rev: "reverse", d2: "draw two", wild: "wild", w4: "wild draw four", steal: "steal a hand", pass: "everyone pass left", mirror: "copy my hand", cust: "custom wild" }[c.v] || c.v);
const points = (h) => h.reduce((a, c) => a + (/^\d$/.test(c.v) ? +c.v : isWild(c) ? 50 : 20), 0);

// can this card go on the pile right now?
function playable(st, c) {
  const t = top(st);
  if (st.picking) return false;
  // after a pickup you may play one of those cards, but not a draw card (it would just bounce straight back)
  if (st.picked && (!st.picked.includes(c.id) || DRAWS.includes(c.v))) return false;
  if (st.drawStack > 0) {
    if (!st.rules.stack) return false;
    return c.v === "w4" || (c.v === "d2" && t && t.v === "d2");
  }
  // official rules: after drawing, only the card you drew may be played
  if (st.rules.official && st.drew && st.drawnId && c.id !== st.drawnId) return false;
  // official rules: a +4 only when you hold nothing of the current colour
  if (st.rules.official && c.v === "w4") { const p = st.players[st.turn]; if (p && p.hand.some((x) => x.c === st.colour)) return false; }
  if (isWild(c)) return true;
  return c.c === st.colour || (t && c.v === t.v);
}
// step from seat i in the current direction to the next player still in the game
function step(st, i, dir = st.dir) { const n = st.players.length; let j = i; for (let k = 0; k < n; k++) { j = (j + dir + n) % n; if (st.players[j].in) return j; } return i; }
function drawCards(st, i, n) {
  const p = st.players[i], got = [];
  for (let k = 0; k < n; k++) {
    if (!st.deck.length) { const keep = st.pile.pop(); st.deck = shuffle(st.pile.map((x) => x.c)); st.pile = keep ? [keep] : []; }
    if (!st.deck.length) break;
    const c = st.deck.pop(); p.hand.push(c); got.push(c);
  }
  return got;
}
// deck empty and nobody has played for three full rounds: the game can't go anywhere, so the fewest cards wins
function stalled(st, i) {
  st.noPlay = (st.noPlay || 0) + 1;
  if (!st.deck.length && st.pile.length <= 1 && st.noPlay >= 3 * ins(st).length) { endGame(st, fewest(st), "fewest cards: no cards left to draw and nobody could play"); return true; }
  return false;
}
function setTurn(st, i) { st.turn = i; st.drew = false; st.drawnId = 0; st.picking = false; st.picked = null; st.pickTotal = 0; st.turnAt = Date.now(); }

function startGame(st) {
  st.game++; st.plays = 0; st.noPlay = 0; st.unoCalled = {}; st.catchable = -1; st.phase = "play"; st.pile = []; st.dir = 1; st.drawStack = 0; st.picking = false; st.picked = null; st.winner = null; st.event = null; st.overAt = 0;
  const sitting = [];
  st.players.forEach((p) => {
    p.hand = []; p.left = false; p.queued = false; p.startBal = p.balance;
    if (p.bot && p.balance < st.stake) { p.balance += START_BAL; p.rebuys = (p.rebuys || 0) + 1; p.startBal = p.balance; }
    p.in = p.balance >= st.stake; if (!p.in) { sitting.push(p.name); return; }
    p.balance -= st.stake; st.pot += st.stake;
  });
  st.deck = buildDeck(st);
  const seats = ins(st);
  for (let k = 0; k < 7; k++) for (const i of seats) drawCards(st, i, 1);
  // first card: a plain number card
  let c; for (;;) { c = st.deck.pop(); if (/^\d$/.test(c.v)) break; st.deck.unshift(c); }
  st.pile = [{ c, who: -1 }]; st.colour = c.c;
  while (!st.players[st.first].in) st.first = (st.first + 1) % st.players.length;
  setTurn(st, st.first);
  st.note = sitting.length ? `${sitting.join(", ")} can't cover the $${st.stake} stake and ${sitting.length > 1 ? "are" : "is"} sitting out.` : "";
}
function endGame(st, winners, why) {
  const won = Math.floor(st.pot / winners.length);
  winners.forEach((i) => (st.players[i].balance += won));
  st.players[winners[0]].balance += st.pot - won * winners.length;
  st.winner = { idx: winners, won, why }; st.pot = 0; st.phase = "over"; st.overAt = Date.now(); st.drawStack = 0;
  st.event = { t: "win", who: winners, won, why, at: Date.now() };
  st.first = (st.first + 1) % st.players.length;
  if (!st.players.some((p) => p.bot)) {
    st.players.forEach((p, i) => {
      if (!(p.in || p.left) || p.startBal === undefined) return;
      const L = st.ledger[p.id] || { name: p.name, games: 0, wins: 0, net: 0 };
      L.name = p.name; L.games++; if (winners.includes(i)) L.wins++; L.net += p.balance - p.startBal; st.ledger[p.id] = L;
    });
  }
}
// "Finish the game": whoever holds the fewest cards right now wins (ties share the pot)
function fewest(st) { const seats = ins(st), min = Math.min(...seats.map((i) => st.players[i].hand.length)); return seats.filter((i) => st.players[i].hand.length === min); }
function finishNow(st) { endGame(st, fewest(st), "fewest cards when the game was finished"); }

// play one or more identical cards. opts: { colour, target }
function play(st, i, ids, opts = {}) {
  const p = st.players[i];
  if (st.phase !== "play" || st.turn !== i) return "It isn't your turn.";
  const cards = ids.map((id) => p.hand.find((c) => c.id === id));
  if (!cards.length || cards.some((c) => !c) || new Set(ids).size !== ids.length) return "Pick a card first.";
  if (cards.length > 1 && (!st.rules.multi || !cards.every((c) => same(c, cards[0])))) return "You can only play several cards if they're identical.";
  if (st.picked && !ids.every((id) => st.picked.includes(id))) return "Play one of the cards you just picked up.";
  const c0 = cards[0];
  if (st.catchable >= 0 && st.catchable !== i) st.catchable = -1; // the next play closes the window to catch someone
  if (!playable(st, c0)) return st.drawStack ? `Stack a matching draw card or take the ${st.drawStack}.` : "That card doesn't match.";
  if (isWild(c0) && !COLS.includes(opts.colour)) return "Choose a colour.";
  const needsTarget = c0.v === "steal";
  let target = -1;
  if (needsTarget) { target = pidx(st, opts.target); if (target < 0 || target === i || !st.players[target].in) return "Choose who to swap hands with."; }

  const k = cards.length, n = st.players.length;
  p.hand = p.hand.filter((c) => !ids.includes(c.id));
  cards.forEach((c) => st.pile.push({ c, who: i }));
  if (st.pile.length > 30) st.pile.splice(0, st.pile.length - 30).forEach((x) => st.deck.unshift(x.c));
  st.colour = isWild(c0) ? opts.colour : c0.c;
  const ev = { t: "play", who: i, v: c0.v, c: c0.c, k, colour: st.colour, dirFrom: st.dir, at: Date.now() };
  let skips = 0, note = "";

  if (c0.v === "skip") { skips = k; note = k > 1 ? `${k} players skipped.` : "Next player skipped."; }
  if (c0.v === "rev") {
    for (let r = 0; r < k; r++) st.dir *= -1;
    ev.revs = k;
    note = k > 1 ? `${k} reverses: play now goes ${st.dir === 1 ? "clockwise" : "anticlockwise"}.` : `Reverse! Play now goes ${st.dir === 1 ? "clockwise" : "anticlockwise"}.`;
  }
  if (c0.v === "d2" || c0.v === "w4") st.drawStack += (c0.v === "d2" ? 2 : 4) * k;
  // playing your last card wins straight away, before any swap or pass happens
  if (!p.hand.length) { st.event = ev; st.note = ""; endGame(st, [i], "played their last card"); return ""; }
  if (c0.v === "mirror") { const n = p.hand.length * k; st.drawStack += n; ev.mirror = n; note = `${p.name} holds ${p.hand.length} card${p.hand.length === 1 ? "" : "s"}, so the next player picks up ${n}.`; }
  if (needsTarget) {
    const t = st.players[target]; [p.hand, t.hand] = [t.hand, p.hand];
    ev.target = target; note = `${p.name} swapped hands with ${t.name}.`;
  }
  if (c0.v === "pass") {
    const seats = ins(st);
    const times = k % seats.length;
    for (let r = 0; r < times; r++) { const h = seats.map((s) => st.players[s].hand); seats.forEach((s, x) => (st.players[seats[(x + 1) % seats.length]].hand = h[x])); }
    ev.passed = k; note = times ? `Everyone passes their hand to the left${k > 1 ? ` ${k} times` : ""}!` : "Everyone passes… and it comes all the way round!";
  }
  if (c0.v === "cust") { ev.text = st.customs[c0.t] || ""; note = ev.text; }
  if (isWild(c0) && !note) note = `Colour is now ${CNAME[st.colour]}.`;
  st.event = ev; st.note = note;


  let nxt = step(st, i);
  for (let s = 0; s < skips; s++) nxt = step(st, nxt);
  // two players: skips and reverses give the same player another turn
  if (ins(st).length === 2 && (c0.v === "rev" || c0.v === "skip")) nxt = i;
  st.noPlay = 0;
  setTurn(st, nxt);
  if (p.hand.length === 1) {
    st.event.one = i;
    if (st.rules.callUno && !(st.unoCalled || {})[p.id]) st.catchable = i; // forgot to call UNO: anyone can catch them
  }
  if (st.unoCalled) delete st.unoCalled[p.id];
  if (++st.plays >= MAX_PLAYS) endGame(st, fewest(st), "fewest cards: the game hit 800 plays");
  return "";
}
// draw: take the stack, or draw (one / until playable), then may play or pass
function draw(st, i) {
  if (st.phase !== "play" || st.turn !== i) return "It isn't your turn.";
  const p = st.players[i];
  if (st.drawStack > 0) {
    // one card per tap; the game waits until they've picked up the lot
    if (!st.picking) { st.picking = true; st.pickTotal = st.drawStack; st.pickedSoFar = []; }
    const got = drawCards(st, i, 1); if (!got.length) { st.pickTotal -= st.drawStack; st.drawStack = 0; } else st.drawStack -= 1; st.pickedSoFar.push(...got.map((c) => c.id)); st.turnAt = Date.now();
    const done = st.pickTotal - st.drawStack;
    st.note = `${p.name} is picking up: ${done} of ${st.pickTotal}.`;
    if (st.drawStack > 0) return "";
    st.picking = false; st.event = { t: "pickup", who: i, n: st.pickTotal, at: Date.now() }; st.note = `${p.name} picked up ${st.pickTotal}${got.length ? "" : " (the deck ran out)"}.`;
    const picked = st.pickedSoFar.filter((id) => p.hand.some((c) => c.id === id)); st.pickedSoFar = [];
    if (st.rules.playPicked) {
      st.picked = picked; st.drew = true;
      if (p.hand.some((c) => playable(st, c))) { st.note += " They can play one of them."; return ""; }
    }
    setTurn(st, step(st, i)); return "";
  }
  if (st.drew) return "You've drawn already: play a card or pass.";
  if (st.catchable >= 0 && st.catchable !== i) st.catchable = -1;
  let got = drawCards(st, i, 1);
  if (st.rules.drawUntil) { let guard = 0; while (got.length && !playable(st, got[got.length - 1]) && guard++ < 60) { const more = drawCards(st, i, 1); if (!more.length) break; got = got.concat(more); } }
  st.drew = true; st.drawnId = got.length ? got[got.length - 1].id : 0; st.note = `${p.name} drew ${got.length > 1 ? got.length + " cards" : "a card"}.`;
  if (!p.hand.some((c) => playable(st, c))) { if (stalled(st, i)) return ""; setTurn(st, step(st, i)); st.note += " No play, so the turn passes."; }
  return "";
}
function pass(st, i) { if (st.phase !== "play" || st.turn !== i || !st.drew || st.picking) return "Draw first."; st.note = `${st.players[i].name} passes.`; if (stalled(st, i)) return ""; setTurn(st, step(st, i)); return ""; }
// UNO calls: say it on your second-last card (or before anyone catches you on your last)
function callUno(st, i) {
  const p = st.players[i]; if (st.phase !== "play" || !p.in || p.hand.length > 2) return "Call UNO when you're down to two cards.";
  st.unoCalled = st.unoCalled || {}; st.unoCalled[p.id] = true;
  if (st.catchable === i) st.catchable = -1;
  st.event = { t: "uno", who: i, at: Date.now() }; return "";
}
function catchUno(st, i) {
  const c = st.catchable; if (st.phase !== "play" || c < 0 || c === i) return "Nobody to catch.";
  const got = drawCards(st, c, 2); st.catchable = -1;
  st.note = `${st.players[i].name} caught ${st.players[c].name} not calling UNO! +${got.length}.`;
  st.event = { t: "caught", who: c, by: i, n: got.length, at: Date.now() }; return "";
}
// leave mid-game: cards go back in the deck, the stake stays in the pot
function leaveGame(st, i) {
  const p = st.players[i]; if (!p.in) return;
  st.deck = shuffle(st.deck.concat(p.hand)); p.hand = []; p.in = false; p.left = true;
  st.note = `${p.name} left the game.`;
  const left = ins(st);
  if (left.length === 1) { endGame(st, left, "was the last player left"); return; }
  if (st.turn === i) setTurn(st, step(st, i));
}

// ---------- bots ----------
function botMove(st, i) {
  const p = st.players[i];
  if (st.rules.callUno) {
    if (st.catchable >= 0 && st.catchable !== i && Math.random() < 0.7) catchUno(st, i);
    if (p.hand.length === 2 && Math.random() < 0.85) { st.unoCalled = st.unoCalled || {}; st.unoCalled[p.id] = true; }
  }
  const opts = p.hand.filter((c) => playable(st, c));
  if (!opts.length) { if (st.drew) pass(st, i); else draw(st, i); return; }
  const score = (c) => (isWild(c) ? 0 : 10) + (c.c === st.colour ? 3 : 0) + (ACTION.includes(c.v) ? 2 : 0);
  const c = opts.sort((a, b) => score(b) - score(a))[0];
  const ids = st.rules.multi ? p.hand.filter((x) => same(x, c)).map((x) => x.id) : [c.id];
  const counts = {}; p.hand.forEach((x) => { if (x.c !== "W") counts[x.c] = (counts[x.c] || 0) + 1; });
  const colour = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || COLS[rnd(0, 3)];
  const others = ins(st).filter((s) => s !== i).sort((a, b) => st.players[a].hand.length - st.players[b].hand.length);
  const err = play(st, i, ids, { colour, target: st.players[others[0]]?.id });
  if (err) { if (st.drew) pass(st, i); else draw(st, i); }
}

// ---------- Durable Object: one per UNO table code ----------
export class UnoTable extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.S = null;
    ctx.blockConcurrencyWhile(async () => { const st = (await ctx.storage.get("state")) || fresh(); st.rules = { ...RULES, ...st.rules }; this.S = st; });
  }
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(req.url);
    const pid = (url.searchParams.get("pid") || "").slice(0, 40), want = url.searchParams.get("role"), role = want === "table" ? "table" : "hand", creator = want === "table" || want === "both"; // the device that set up the table runs it
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ pid, role, creator, sid: crypto.randomUUID().slice(0, 8), video: false });
    if (creator && this.S.goto) { delete this.S.goto; await this.ctx.storage.put("state", this.S); } // the table is here now
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {}, { pid, role } = att;
    // video signalling: relayed between sockets, never touches game state
    if (m.t === "video") { att.video = !!m.on; ws.serializeAttachment(att); this.broadcast(); return; }
    if (m.t === "rtc") {
      for (const other of this.ctx.getWebSockets()) { const o = other.deserializeAttachment() || {}; if (o.sid === m.to) { try { other.send(JSON.stringify({ t: "rtc", from: att.sid, data: m.data })); } catch {} } }
      return;
    }
    const st = this.S, i = pidx(st, pid), me = i >= 0 ? st.players[i] : null;
    // the table device runs the game; the first player only stands in when no table device is connected
    const isHost = role === "table" || att.creator || (!this.tablePresent() && st.players.length && st.players[0].id === pid);
    const between = st.phase === "lobby" || st.phase === "over";
    let changed = true, err = "";
    switch (m.t) {
      case "hello": this.send(ws); return;
      case "join": {
        if (!pid) return;
        const name = String(m.name || "Player").trim().slice(0, 18) || "Player";
        if (me) { me.name = name; break; }
        if (st.players.length >= 10) { err = "The table is full."; changed = false; break; }
        // joining mid-game: you're seated now and dealt in at the next game
        st.players.push({ id: pid, name, balance: START_BAL, hand: [], in: false, queued: st.phase === "play" }); break;
      }
      case "leave": if (me && (between || !me.in)) { st.players.splice(i, 1); st.first = 0; if (st.turn > i) st.turn--; } else changed = false; break;
      case "uno": if (me) err = callUno(st, i); if (err) changed = false; break;
      case "catch": if (me) err = catchUno(st, i); if (err) changed = false; break;
      case "switchgame": if (isHost && between && ["fk"].includes(m.to)) { st.goto = { to: m.to, at: Date.now(), bots: st.players.filter((p) => p.bot).length }; } else changed = false; break;
      case "quit": if (st.phase === "play" && me && me.in) leaveGame(st, i); else changed = false; break;
      case "addbot": {
        if (!isHost || !between || st.players.length >= 10) { changed = false; break; }
        const used = new Set(st.players.map((p) => p.name));
        st.players.push({ id: "bot-" + crypto.randomUUID().slice(0, 6), name: BOT_NAMES.find((n) => !used.has(n)) || "Bot", bot: true, balance: START_BAL, hand: [], in: false }); break;
      }
      case "removebot": { const b = st.players.map((p) => p.bot).lastIndexOf(true); if (isHost && between && b >= 0) { st.players.splice(b, 1); st.first = 0; } else changed = false; break; }
      case "start": case "next":
        if ((m.t === "start" ? isHost && st.phase === "lobby" : st.phase === "over" && (me || role === "table")) && st.players.filter((p) => p.balance >= st.stake || p.bot).length >= 2) startGame(st);
        else { changed = false; if (m.t === "start") err = "Need at least two players who can cover the stake."; }
        break;
      case "rebuy": if (me && me.balance < st.stake && st.phase !== "play") { me.balance += START_BAL; me.rebuys = (me.rebuys || 0) + 1; } else changed = false; break;
      case "play": if (me) err = play(st, i, (m.ids || []).map(Number), { colour: m.colour, target: m.target }); if (err) changed = false; break;
      case "draw": if (me) err = draw(st, i); if (err) changed = false; break;
      case "pass": if (me) err = pass(st, i); if (err) changed = false; break;
      case "finish": if (isHost && st.phase === "play") finishNow(st); else changed = false; break;
      case "reset": if (isHost) { const keep = { stake: st.stake, turnMs: st.turnMs, autoNext: st.autoNext, rules: st.rules, customs: st.customs }; this.S = Object.assign(fresh(), keep); } break;
      case "clearboard": if (isHost) st.ledger = {}; break;
      case "settings": {
        if (!isHost) { changed = false; break; }
        if ([10, 20, 50, 100].includes(+m.stake) && st.phase !== "play") st.stake = +m.stake;
        if ([30000, 60000, 0].includes(m.turnMs)) st.turnMs = m.turnMs;
        if (typeof m.autoNext === "boolean") { st.autoNext = m.autoNext; if (st.phase === "over") st.overAt = Date.now(); }
        if (m.rule && m.rule in RULES && st.phase !== "play") st.rules[m.rule] = !!m.on;
        if (m.preset && PRESETS[m.preset] && st.phase !== "play") st.rules = { ...PRESETS[m.preset] };
        if (["table", "phones"].includes(m.layout)) st.layout = m.layout; // iPad in the middle, or everyone on their own device
        if (Array.isArray(m.customs) && st.phase !== "play") st.customs = [0, 1, 2, 3].map((k) => String(m.customs[k] || "").slice(0, 60));
        break;
      }
      default: changed = false;
    }
    if (err) ws.send(JSON.stringify({ t: "err", msg: err }));
    if (changed) await this.commit();
  }
  async webSocketClose(ws) { try { ws.close(); } catch {} this.broadcast(); }
  async webSocketError(ws) { try { ws.close(); } catch {} this.broadcast(); }
  tablePresent() { return this.ctx.getWebSockets().some((w) => w.readyState === 1 && (w.deserializeAttachment() || {}).creator); }
  broadcast() { for (const ws of this.ctx.getWebSockets()) if (ws.readyState === 1) this.send(ws); }

  // timers: bots, idle humans, auto-next
  due(st) {
    if (st.phase === "over") return st.autoNext && st.overAt ? st.overAt + NEXT_MS : 0;
    if (st.phase !== "play") return 0;
    const p = st.players[st.turn];
    if (p.bot) return st.turnAt + (st.picking || (st.drawStack && !p.hand.some((c) => playable(st, c))) ? rnd(350, 650) : rnd(1200, 2400));
    return st.turnMs ? st.turnAt + st.turnMs : 0;
  }
  async alarm() {
    const st = this.S;
    if (st.phase === "over" && st.autoNext && Date.now() >= st.overAt + NEXT_MS - 50) { if (st.players.filter((p) => p.balance >= st.stake || p.bot).length >= 2) startGame(st); else st.overAt = 0; }
    else if (st.phase === "play" && Date.now() >= (st.wakeAt || 0) - 50) {
      const p = st.players[st.turn];
      if (p.bot) botMove(st, st.turn);
      else { const was = p.name; let g = 0; while (st.phase === "play" && st.players[st.turn].id === p.id && (st.drawStack || st.picking) && g++ < 200) draw(st, st.turn); if (st.phase === "play" && st.players[st.turn].id === p.id && !st.drew) draw(st, st.turn); if (st.phase === "play" && st.players[st.turn].id === p.id && st.drew) pass(st, st.turn); st.note = `${was} took too long, so they drew and passed.`; }
    }
    await this.commit();
  }
  async commit() {
    const st = this.S; st.v++;
    const t = this.due(st); st.wakeAt = t;
    if (t) await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, t)); else await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("state", st);
    this.broadcast();
  }
  send(ws) {
    const { pid, role, sid, creator } = ws.deserializeAttachment() || {}, st = this.S; const tablePresent = this.tablePresent();
    const peers = this.ctx.getWebSockets().map((w) => { const a = w.deserializeAttachment() || {}; const p = st.players.find((x) => x.id === a.pid); return { sid: a.sid, role: a.role, video: !!a.video, name: a.role === "table" ? "Table" : p ? p.name : "Guest" }; });
    const view = {
      ...st, deck: undefined, deckCount: st.deck.length, pile: st.pile.slice(-8), wakeAt: undefined, pickedSoFar: undefined,
      players: st.players.map((p) => ({ id: p.id, name: p.name, bot: !!p.bot, balance: p.balance, in: !!p.in, left: !!p.left, queued: !!p.queued, rebuys: p.rebuys || 0, cards: p.hand.length, hand: role === "hand" && p.id === pid ? p.hand : undefined })),
      you: pid, sid, peers, host: role === "table" || !!creator || (!tablePresent && st.players.length > 0 && st.players[0].id === pid), serverNow: Date.now(),
      turnBy: st.phase === "play" && st.turnMs && !st.players[st.turn]?.bot ? st.turnAt + st.turnMs : 0,
      canPlay: role === "hand" && st.phase === "play" && st.players[st.turn]?.id === pid ? st.players[st.turn].hand.filter((c) => playable(st, c)).map((c) => c.id) : [],
    };
    try { ws.send(JSON.stringify({ t: "state", s: view })); } catch {}
  }
}
export { fresh, buildDeck, playable, play, draw, pass, startGame, finishNow, leaveGame, botMove, step, callUno, catchUno, PRESETS, NUDGE_MS };
