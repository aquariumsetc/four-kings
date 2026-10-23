import { DurableObject } from "cloudflare:workers";
export { UnoTable } from "./uno.js";

// ---------- game rules (server-side, authoritative) ----------
const SUITS = ["S", "H", "D", "C"];
const RED = { S: false, H: true, D: true, C: false };
const NAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RN = { 1: "A", 11: "J", 12: "Q" };
const CLAIM_MS = 5000;
// flow timings
const DEAD_STOP_MS = 2000;     // nobody holds the next card: short beat, then the run stops
const AUTO_LEAD_MS = 1800;     // the leader has only one legal card: play it after this beat
const IDLE_MIN_MS = 30000;     // a human who doesn't act on their lead / swap turn gets this long (or the card timer, if longer)
const DEAL_GRACE_MS = 6000;    // everyone has bet: deal after this
const CARRY_GRACE_MS = 10000;  // bets carried over from last game: time to change them
const STRAGGLER_MS = 45000;    // some players still betting: deal without them after this
const JOIN_GRACE_MS = 20000;   // someone joins during betting: give them at least this long
const SWAP_RACE_MS = 12000;    // fastest-finger swap window
const NEXT_MS = 15000;         // game over: next game starts after this (if auto-next is on)
const MIN_BET = 10, START_BAL = 1000;
const rname = (r) => RN[r] || String(r);

function fresh() {
  return {
    phase: "lobby", players: [], kings: { S: 0, H: 0, D: 0, C: 0 }, pot: 0, first: 0, game: 0,
    dead: [], spare: [], swapIdx: 0, swapAns: {}, leader: 0, colour: null, runSuit: null, run: [], nextRank: 0,
    calledAt: 0, turnAt: 0, swapEnd: 0, overAt: 0, note: "", winner: null, v: 0,
    claimMs: CLAIM_MS, swapMode: "race", autoNext: true, ledger: {},
  };
}
function deck() {
  const d = [];
  for (const s of SUITS) for (let r = 1; r <= 12; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const sortHand = (h) => h.sort((a, b) => SUITS.indexOf(a.s) - SUITS.indexOf(b.s) || a.r - b.r);
const pidx = (st, id) => st.players.findIndex((p) => p.id === id);
const betTotal = (p) => Object.values(p.bets || {}).reduce((a, b) => a + b, 0);
const broke = (p) => p.balance < 2 * MIN_BET;
const idleMs = (st) => Math.max(IDLE_MIN_MS, st.claimMs || CLAIM_MS);
// players dealt into this game, in turn order starting from the first player
const inOrder = (st) => { const n = st.players.length, out = []; for (let k = 0; k < n; k++) { const i = (st.first + k) % n; if (st.players[i].in) out.push(i); } return out; };
const swapTurn = (st) => inOrder(st)[st.swapIdx];
const holderOf = (st, s, r) => st.players.findIndex((p) => p.in && p.hand.some((c) => c.s === s && c.r === r));

// bets: { S: 20, H: 10 } — one or two kings, multiples of $10, matched in the centre
function cleanBets(raw, balance) {
  if (!raw || typeof raw !== "object") return null;
  const bets = {};
  for (const s of SUITS) { const v = Math.round(Number(raw[s] || 0) / 10) * 10; if (v > 0) bets[s] = v; }
  const n = Object.keys(bets).length, total = Object.values(bets).reduce((a, b) => a + b, 0);
  if (n < 1 || n > 2 || Object.values(bets).some((v) => v < MIN_BET) || total > balance / 2) return null;
  return bets;
}
// last game's bet, trimmed to what the player can still afford
function carryBets(p) {
  const prev = p.bets || {}, keys = Object.keys(prev); if (!keys.length || broke(p)) return null;
  let total = betTotal({ bets: prev }); const step = keys.length === 2 ? 20 : 10;
  const max = Math.floor(p.balance / 2 / step) * step;
  if (total > max) total = max;
  if (total < step) return keys.length === 2 ? cleanBets({ [keys[0]]: 10 }, p.balance) : null;
  const o = {}; keys.forEach((k) => (o[k] = total / keys.length)); return cleanBets(o, p.balance);
}
const placedCount = (st) => st.players.filter((p) => p.placed).length;
const canDeal = (st) => placedCount(st) >= 2;
// when should the cards be dealt? Called after anything changes during betting.
function updateDealAt(st, graceMs) {
  const now = Date.now(), elig = st.players.filter((p) => !broke(p)), placed = placedCount(st);
  if (placed < 2) { st.dealAt = 0; return; }
  if (placed === elig.length) { const t = now + (graceMs || DEAL_GRACE_MS); st.dealAt = st.dealAt ? Math.min(st.dealAt, t) : t; }
  else if (!st.dealAt) st.dealAt = now + Math.max(STRAGGLER_MS, st.claimMs || CLAIM_MS);
}

function dealInto(st) {
  const sitting = [];
  st.players.forEach((p) => {
    p.in = !!p.placed; p.hand = []; p.gq = 0;
    if (!p.in) { p.bets = p.bets || {}; if (!broke(p)) sitting.push(p.name); return; }
    const t = betTotal(p); p.balance -= 2 * t; st.pot += t; for (const s in p.bets) st.kings[s] += p.bets[s];
  });
  st.dealAt = 0;
  const ids = st.players.map((p, i) => i).filter((i) => st.players[i].in);
  const d = deck(), n = ids.length, hands = Array.from({ length: n + 1 }, () => []);
  d.forEach((c, i) => hands[i % (n + 1)].push(c));
  ids.forEach((pi, k) => (st.players[pi].hand = sortHand(hands[k])));
  st.spare = sortHand(hands[n]); st.dead = []; st.swapIdx = 0; st.swapAns = {}; st.phase = "swap"; st.run = []; st.colour = null;
  st.turnAt = Date.now(); st.swapEnd = Date.now() + (st.claimMs >= 30000 ? 30000 : SWAP_RACE_MS);
  st.note = sitting.length ? `${sitting.join(", ")} ${sitting.length > 1 ? "are" : "is"} sitting this game out.` : "";
}
function takeSpare(st, i) { const p = st.players[i]; st.dead = p.hand; p.hand = st.spare; st.spare = []; st.note = `${p.name} swapped for the spare hand.`; startPlay(st); }
function noSwap(st) { st.dead = st.spare; st.spare = []; st.note = "Nobody swapped, so the spare hand is set aside."; startPlay(st); }
// a player says keep (or times out); move the swap along
function keepHand(st, i) {
  if (st.swapMode === "turn") { st.swapIdx++; st.turnAt = Date.now(); if (st.swapIdx >= inOrder(st).length) noSwap(st); }
  else { st.swapAns[st.players[i].id] = "keep"; if (inOrder(st).every((j) => st.swapAns[st.players[j].id])) noSwap(st); }
}
function startPlay(st) {
  st.leader = st.first; while (!st.players[st.leader].in) st.leader = (st.leader + 1) % st.players.length;
  st.colour = null; st.run = []; st.phase = "play"; st.turnAt = Date.now();
}
function leadOptions(st, i) {
  const p = st.players[i]; if (!p.in) return [];
  const h = p.hand, want = st.colour;
  const suitsOf = (col) => SUITS.filter((s) => (col === "red") === RED[s]);
  const suits = want ? suitsOf(want) : SUITS;
  const avail = suits.filter((s) => h.some((c) => c.s === s));
  return avail.map((s) => ({ s, low: h.filter((c) => c.s === s).sort((a, b) => a.r - b.r)[0] }));
}
// the lead a sensible player would make: the suit with the longest run from its lowest card, bonus if it reaches the queen
function bestLead(st, i) {
  const p = st.players[i], opts = leadOptions(st, i);
  const score = (o) => { let r = o.low.r, n = 0; while (p.hand.some((c) => c.s === o.s && c.r === r)) { n++; r++; } return n * 2 + (r === 13 ? 5 : 0) + Math.random(); };
  return opts.sort((a, b) => score(b) - score(a))[0];
}
function doLead(st, i, o) { st.run = []; st.runSuit = o.s; st.note = ""; playFrom(st, i, o.low.r); }
// One card per tap: play the card of rank r, then call for the next one, even if this same player holds it.
function playFrom(st, who, r) {
  const p = st.players[who], suit = st.runSuit; let note = "";
  const ci = p.hand.findIndex((c) => c.s === suit && c.r === r); if (ci < 0) return;
  const c = p.hand.splice(ci, 1)[0]; st.run.push({ c, who });
  if (c.r === 12) { const won = st.kings[suit]; st.kings[suit] = 0; p.balance += won; p.gq = (p.gq || 0) + 1; note = `${p.name} played the queen and takes $${won} from the king of ${NAME[suit]}.`; st.event = { t: "queen", who, suit, won, at: Date.now() }; }
  if (p.hand.length === 0) { const won = st.pot; st.pot = 0; p.balance += won; st.winner = { idx: who, won }; st.note = note; st.leader = who; endGame(st); st.event = { t: "out", who, won, at: Date.now() }; return; }
  if (c.r === 12) { endRun(st, who, note); return; }
  st.nextRank = r + 1; st.leader = who; st.phase = "claim"; st.calledAt = Date.now(); st.note = note;
}
// back to "waiting for players" after a game: nothing is dealt, money on the kings and in the centre stays put
function toLobby(st) { if (st.phase !== "over") return; st.phase = "lobby"; st.run = []; st.note = ""; st.winner = null; st.dead = []; st.spare = []; st.swapAns = {}; st.dealAt = 0; st.overAt = 0; st.players.forEach((p) => { p.hand = []; p.in = false; p.placed = false; p.carried = false; }); }
function endGame(st) { st.phase = "over"; st.overAt = Date.now(); st.first = (st.first + 1) % st.players.length; recordGame(st); }
function endRun(st, who, note) { st.leader = who; st.colour = RED[st.runSuit] ? "black" : "red"; st.note = note; st.phase = "play"; st.turnAt = Date.now(); settleLeader(st); }
// The leader must lead the required colour. With none, the lead passes to the next player;
// if it comes all the way round, the game ends and the centre and kings carry over.
function settleLeader(st) {
  const n = st.players.length; let tries = 0;
  while (tries < n) {
    const p = st.players[st.leader];
    if (p.in && leadOptions(st, st.leader).length) break;
    if (p.in) st.note = (st.note ? st.note + " " : "") + `${p.name} has no ${st.colour} card and passes.`;
    st.leader = (st.leader + 1) % n; tries++;
  }
  if (tries >= n) {
    st.note = `Nobody can lead a ${st.colour} card, so the game ends. The centre and the kings carry over.`;
    st.winner = null; endGame(st);
  }
}
function stopRun(st) {
  const dead = holderOf(st, st.runSuit, st.nextRank) < 0, c = `${rname(st.nextRank)}${SYM[st.runSuit]}`;
  endRun(st, st.leader, dead ? `Nobody has the ${c}, so the run stops.` : `Nobody played the ${c}, so the run stops.`);
}
// Season scoreboard: only games with no bots at the table count.
function recordGame(st) {
  if (st.players.some((p) => p.bot)) return;
  st.ledger = st.ledger || {};
  st.players.forEach((p, i) => {
    if (!p.in) return;
    const L = st.ledger[p.id] || { name: p.name, games: 0, wins: 0, queens: 0, net: 0 };
    L.name = p.name; L.games++; if (st.winner && st.winner.idx === i) L.wins++; L.queens += p.gq || 0; L.net += p.balance - (p.startBal ?? p.balance);
    st.ledger[p.id] = L;
  });
}

// ---------- deadlines: everything the table waits for has a time limit ----------
function deadlines(st) {
  const d = {};
  if (st.phase === "claim") d.claimBy = st.calledAt + (holderOf(st, st.runSuit, st.nextRank) >= 0 ? st.claimMs || CLAIM_MS : DEAD_STOP_MS);
  if (st.phase === "ante" && st.dealAt) d.dealBy = st.dealAt;
  if (st.phase === "swap") {
    if (st.swapMode === "turn") { const t = st.players[swapTurn(st)]; if (t && !t.bot) d.swapBy = st.turnAt + idleMs(st); }
    else d.swapBy = st.swapEnd;
  }
  if (st.phase === "play") {
    const p = st.players[st.leader];
    if (p && p.in && !p.bot) d.leadBy = st.turnAt + (leadOptions(st, st.leader).length === 1 ? AUTO_LEAD_MS : idleMs(st));
  }
  if (st.phase === "over" && st.autoNext !== false && st.overAt) d.nextBy = st.overAt + NEXT_MS;
  return d;
}

// ---------- bots (and humans who switched on auto-play, for claims only) ----------
const BOT_NAMES = ["Robo Rita", "Dealer Dan", "Lucky Lou", "Queenie", "Ace Alvarez", "Blackjack Bea", "Shuffle Sam"];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function botPending(st) {
  // which player (index) the bot logic should act for now, or -1
  if (st.phase === "ante") return st.players.findIndex((p) => p.bot && !p.placed && !broke(p));
  if (st.phase === "swap") {
    if (st.swapMode === "turn") { const i = swapTurn(st); return i !== undefined && st.players[i].bot ? i : -1; }
    return inOrder(st).find((i) => st.players[i].bot && !st.swapAns[st.players[i].id]) ?? -1;
  }
  if (st.phase === "play") return st.players[st.leader].bot ? st.leader : -1;
  if (st.phase === "claim") { const h = holderOf(st, st.runSuit, st.nextRank); return h >= 0 && (st.players[h].bot || st.players[h].auto) ? h : -1; }
  return -1;
}
function botDelay(st) {
  if (st.phase === "claim") return rnd(700, 2200);
  if (st.phase === "play") return rnd(900, 1800);
  if (st.phase === "swap" && st.swapMode !== "turn") return rnd(2500, 7000); // give humans a fair shot at the race
  return rnd(600, 1400);
}
function botAct(st, i) {
  const p = st.players[i];
  if (st.phase === "ante") {
    const max = Math.max(10, Math.floor(p.balance / 20) * 10);
    const stake = Math.min(max, [10, 10, 20, 30, 40][rnd(0, 4)]);
    const a = SUITS[rnd(0, 3)]; let b = SUITS[rnd(0, 3)];
    if (stake >= 20 && b !== a && Math.random() < 0.35) p.bets = { [a]: stake / 2, [b]: stake / 2 }; else p.bets = { [a]: stake };
    p.placed = true; updateDealAt(st);
  } else if (st.phase === "swap") {
    const h = p.hand, queens = h.filter((c) => c.r === 12).length, high = h.filter((c) => c.r >= 9).length;
    if (queens === 0 && high <= 2 && Math.random() < 0.6 && st.spare.length) takeSpare(st, i); else keepHand(st, i);
  } else if (st.phase === "play") {
    const best = bestLead(st, i); if (best) doLead(st, i, best);
  } else if (st.phase === "claim") {
    playFrom(st, i, st.nextRank);
  }
}

// ---------- Durable Object: one per table code ----------
export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.S = null;
    ctx.blockConcurrencyWhile(async () => {
      const st = (await ctx.storage.get("state")) || fresh();
      // tables created before a field existed
      st.claimMs ??= CLAIM_MS; st.swapMode ??= "race"; st.autoNext ??= true; st.ledger ??= {}; st.swapAns ??= {};
      if (st.phase !== "lobby" && st.phase !== "ante") st.players.forEach((p) => { p.in ??= true; });
      this.S = st;
    });
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(req.url);
    const pid = (url.searchParams.get("pid") || "").slice(0, 40);
    const want = url.searchParams.get("role"), role = want === "table" ? "table" : "hand", creator = want === "table" || want === "both"; // the device that set up the table runs it
    const sid = crypto.randomUUID().slice(0, 8);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid, role, creator, sid, video: false });
    if (creator && this.S.goto) { delete this.S.goto; await this.ctx.storage.put("state", this.S); } // the table is here now
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const { pid, role } = att;
    const st = this.S;
    // --- video signalling: relayed between sockets, never touches game state ---
    if (m.t === "video") { att.video = !!m.on; ws.serializeAttachment(att); this.broadcast(); return; }
    if (m.t === "rtc") {
      for (const other of this.ctx.getWebSockets()) {
        const o = other.deserializeAttachment() || {};
        if (o.sid === m.to) { try { other.send(JSON.stringify({ t: "rtc", from: att.sid, data: m.data })); } catch {} }
      }
      return;
    }
    // the table device runs the game; the first player only stands in when no table device is connected
    const isHost = role === "table" || att.creator || (!this.tablePresent() && st.players.length && st.players[0].id === pid);
    let changed = false, err = "";
    const i = pidx(st, pid), me = i >= 0 ? st.players[i] : null;
    const between = st.phase === "lobby" || st.phase === "over";
    switch (m.t) {
      case "hello": this.send(ws); return;
      case "join": {
        if (!pid) break;
        const name = String(m.name || "Player").trim().slice(0, 18) || "Player";
        if (me) { me.name = name; changed = true; break; }
        if (st.players.length >= 8) { err = "The table is full."; break; }
        // joining mid-game: you're seated now and dealt in at the next game
        st.players.push({ id: pid, name, balance: START_BAL, bets: {}, placed: false, hand: [], startBal: START_BAL, auto: !!m.auto, in: false });
        if (st.phase === "ante") { if (st.dealAt) st.dealAt = Math.max(st.dealAt, Date.now() + JOIN_GRACE_MS); updateDealAt(st); }
        changed = true; break;
      }
      case "leave": if (me && (between || st.phase === "ante" || !me.in)) { st.players.splice(i, 1); st.first = 0; if (st.leader > i) st.leader--; st.run.forEach((x) => { if (x.who > i) x.who--; }); changed = true; } break;
      case "switchgame": if (isHost && between && m.to === "uno") { st.goto = { to: "uno", at: Date.now(), bots: st.players.filter((p) => p.bot).length, layout: st.layout || "table" }; st.lounge = false; toLobby(st); changed = true; } break;
      // Game Night room: the host brings everyone back to the video lounge between games (balances and the scoreboard are kept, bots are let go)
      case "toroom": if (isHost && between) { toLobby(st); st.players = st.players.filter((p) => !p.bot); st.first = 0; st.lounge = true; st.layout = "phones"; delete st.goto; changed = true; } break;
      case "addbot": {
        if (!isHost || !between || st.players.length >= 8) break;
        const used = new Set(st.players.map((p) => p.name)); const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${st.players.length + 1}`;
        st.players.push({ id: "bot-" + crypto.randomUUID().slice(0, 6), name, bot: true, balance: START_BAL, bets: {}, placed: false, hand: [] }); changed = true; break;
      }
      case "removebot": {
        if (!isHost || !between) break;
        const bi = st.players.map((p) => p.bot).lastIndexOf(true); if (bi >= 0) { st.players.splice(bi, 1); st.first = 0; changed = true; } break;
      }
      case "start": if (isHost && st.phase === "lobby" && st.players.length >= 2) { this.beginAnte(st); changed = true; } break;
      // anyone at the table can move on to the next game
      case "next": if ((me || role === "table") && st.phase === "over") { this.beginAnte(st); changed = true; } break;
      case "reset": if (isHost) { this.S = fresh(); Object.assign(this.S, { claimMs: st.claimMs, swapMode: st.swapMode, autoNext: st.autoNext }); await this.ctx.storage.deleteAlarm(); changed = true; } break;
      case "rebuy": {
        if (!me || !broke(me) || !(between || st.phase === "ante")) break;
        me.balance += START_BAL; me.rebuys = (me.rebuys || 0) + 1; if (st.phase === "ante") me.startBal = (me.startBal ?? 0) + START_BAL;
        if (st.phase === "ante") { if (st.dealAt) st.dealAt = Math.max(st.dealAt, Date.now() + JOIN_GRACE_MS); updateDealAt(st); }
        changed = true; break;
      }
      case "bet": {
        if (!me || st.phase !== "ante") break;
        const bets = cleanBets(m.bets, me.balance);
        if (!bets) { err = "That bet isn't allowed."; break; }
        me.bets = bets; me.placed = true; me.carried = false; updateDealAt(st);
        changed = true; break;
      }
      case "deal": if (isHost && st.phase === "ante" && canDeal(st)) { dealInto(st); changed = true; } break;
      case "swap": {
        if (st.phase !== "swap" || !me || !me.in) break;
        if (st.swapMode === "turn") {
          if (swapTurn(st) !== i) break;
          if (m.swap) takeSpare(st, i); else keepHand(st, i);
        } else {
          if (st.swapAns[pid]) break;
          if (m.swap && st.spare.length) takeSpare(st, i); else keepHand(st, i);
        }
        changed = true; break;
      }
      case "lead": {
        if (st.phase !== "play" || st.players[st.leader].id !== pid) break;
        const o = leadOptions(st, st.leader).find((x) => x.s === m.suit); if (!o) break;
        doLead(st, st.leader, o); changed = true; break;
      }
      case "claim": {
        if (st.phase !== "claim" || !me) break;
        if (!me.hand.some((c) => c.s === st.runSuit && c.r === st.nextRank)) { err = `You don't have the ${rname(st.nextRank)}${SYM[st.runSuit]}.`; break; }
        playFrom(st, i, st.nextRank); changed = true; break;
      }
      case "autoplay": if (me && !me.bot && me.auto !== !!m.on) { me.auto = !!m.on; changed = true; } break;
      case "stop": if (isHost && st.phase === "claim") { stopRun(st); changed = true; } break;
      case "clearboard": if (isHost) { st.ledger = {}; changed = true; } break;
      case "settings": {
        if (!isHost) break;
        if ([5000, 30000, 300000].includes(Number(m.claimMs))) { st.claimMs = Number(m.claimMs); changed = true; }
        if (["race", "turn"].includes(m.swapMode) && st.phase !== "swap") { st.swapMode = m.swapMode; changed = true; }
        if (typeof m.autoNext === "boolean") { st.autoNext = m.autoNext; if (st.phase === "over") st.overAt = Date.now(); changed = true; }
        if (["table", "phones"].includes(m.layout)) { st.layout = m.layout; changed = true; }
        if (typeof m.lounge === "boolean" && st.phase === "lobby") { st.lounge = m.lounge; changed = true; } // Game Night room: video chat before a game is picked
        break;
      }
    }
    if (err) ws.send(JSON.stringify({ t: "err", msg: err }));
    if (changed) await this.commit();
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} this.broadcast(); }
  async webSocketError(ws) { try { ws.close(); } catch {} this.broadcast(); }
  tablePresent() { return this.ctx.getWebSockets().some((w) => w.readyState === 1 && (w.deserializeAttachment() || {}).creator); }
  broadcast() { for (const ws of this.ctx.getWebSockets()) { if (ws.readyState === 1) this.send(ws); } }

  async alarm() {
    const st = this.S, now = Date.now(), d = deadlines(st), due = (t) => t && now >= t - 50; let changed = false;
    if (due(d.claimBy)) { stopRun(st); changed = true; }
    else if (due(d.dealBy)) { if (canDeal(st)) dealInto(st); else st.dealAt = 0; changed = true; }
    else if (due(d.swapBy)) {
      if (st.swapMode === "turn") { const t = swapTurn(st); st.note = `${st.players[t].name} kept their hand.`; keepHand(st, t); }
      else noSwap(st);
      changed = true;
    }
    else if (due(d.leadBy)) {
      const multi = leadOptions(st, st.leader).length > 1, who = st.players[st.leader].name, best = bestLead(st, st.leader);
      if (best) { doLead(st, st.leader, best); if (multi) st.note = (st.note ? st.note + " " : "") + `${who} took a while, so their lowest ${NAME[best.s]} went down.`; changed = true; }
    }
    else if (due(d.nextBy)) { this.beginAnte(st); changed = true; }
    else if (now >= (st.botAt || 0) - 50) { const i = botPending(st); if (i >= 0) { botAct(st, i); changed = true; } st.botAt = 0; }
    if (changed) await this.commit(); else await this.schedule();
  }

  async schedule() {
    const st = this.S, times = Object.values(deadlines(st)).filter(Boolean);
    const bi = botPending(st);
    if (bi >= 0) { if (!st.botAt || st.botAt < Date.now() - 10000) st.botAt = Date.now() + botDelay(st); times.push(st.botAt); } else st.botAt = 0;
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, Math.min(...times))); else await this.ctx.storage.deleteAlarm();
  }

  beginAnte(st) {
    st.game++; st.phase = "ante"; st.run = []; st.note = ""; st.winner = null; st.dead = []; st.spare = []; st.dealAt = 0; st.overAt = 0;
    let carried = 0;
    st.players.forEach((p) => {
      if (p.bot && broke(p)) { p.balance += START_BAL; p.rebuys = (p.rebuys || 0) + 1; }
      p.hand = []; p.gq = 0; p.startBal = p.balance; p.in = false;
      const keep = p.bot ? null : carryBets(p);
      if (keep) { p.bets = keep; p.placed = true; p.carried = true; carried++; } else { p.bets = p.bot ? {} : p.bets || {}; p.placed = false; p.carried = false; }
    });
    if (carried) updateDealAt(st, CARRY_GRACE_MS);
  }

  async commit() {
    const st = this.S; st.v++; st.botAt = 0;
    await this.schedule();
    await this.ctx.storage.put("state", st);
    this.broadcast();
  }

  // Each socket gets only what it may see: its own hand, everyone else's card count.
  send(ws) {
    const { pid, role, sid, creator } = ws.deserializeAttachment() || {};
    const st = this.S, d = deadlines(st); const tablePresent = this.tablePresent();
    const peers = this.ctx.getWebSockets().map((w) => { const a = w.deserializeAttachment() || {}; const p = st.players.find((x) => x.id === a.pid); return { sid: a.sid, role: a.role, video: !!a.video, name: a.role === "table" ? "Table" : p ? p.name : "Guest" }; });
    const view = {
      ...st, dead: undefined, spareCount: st.spare.length, spare: undefined, swapAns: undefined, botAt: undefined,
      swapTurn: st.phase === "swap" && st.swapMode === "turn" ? swapTurn(st) : null,
      players: st.players.map((p) => ({
        id: p.id, name: p.name, bot: !!p.bot, auto: !!p.auto, balance: p.balance, bets: p.bets || {}, bet: betTotal(p), placed: p.placed, carried: !!p.carried,
        broke: broke(p), in: !!p.in, rebuys: p.rebuys || 0, kept: !!(st.swapAns || {})[p.id],
        cards: p.hand.length, hand: role === "hand" && p.id === pid ? p.hand : undefined,
      })),
      canDeal: canDeal(st), claimMs: st.claimMs || CLAIM_MS, ledger: st.ledger || {}, you: pid, sid, peers,
      host: role === "table" || !!creator || (!tablePresent && st.players.length > 0 && st.players[0].id === pid), serverNow: Date.now(),
      // claim deadline is deliberately not sent; the others are public anyway
      swapBy: d.swapBy || 0, nextBy: d.nextBy || 0,
      // only the leader's own phone learns how long they have (and whether their lead is forced)
      ...(role === "hand" && st.phase === "play" && st.players[st.leader]?.id === pid ? { leadBy: d.leadBy || 0, forced: leadOptions(st, st.leader).length === 1 } : { leadBy: 0, forced: false }),
    };
    try { ws.send(JSON.stringify({ t: "state", s: view })); } catch {}
  }
}

// ---------- ICE servers: Cloudflare STUN always; TURN when TURN_KEY_ID / TURN_KEY_TOKEN secrets are set ----------
let iceCache = { until: 0, body: null };
async function iceServers(env) {
  const stunOnly = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return Response.json(stunOnly);
  if (iceCache.body && Date.now() < iceCache.until) return Response.json(iceCache.body);
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST", headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) return Response.json(stunOnly);
    const body = await r.json(); iceCache = { until: Date.now() + 6 * 3600 * 1000, body };
    return Response.json(body);
  } catch { return Response.json(stunOnly); }
}

// ---------- Worker: route /ws/CODE to that table's Durable Object ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ice") return iceServers(env);
    const u = url.pathname.match(/^\/uws\/([A-Za-z0-9]{3,8})$/);
    if (u) return env.UNO.get(env.UNO.idFromName(u[1].toUpperCase())).fetch(req);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/);
    if (m) {
      const id = env.TABLE.idFromName(m[1].toUpperCase());
      return env.TABLE.get(id).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};
