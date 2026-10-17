import { DurableObject } from "cloudflare:workers";

// ---------- game rules (server-side, authoritative) ----------
const SUITS = ["S", "H", "D", "C"];
const RED = { S: false, H: true, D: true, C: false };
const NAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RN = { 1: "A", 11: "J", 12: "Q" };
const CLAIM_MS = 5000;
const rname = (r) => RN[r] || String(r);

function fresh() {
  return {
    phase: "lobby", players: [], kings: { S: 0, H: 0, D: 0, C: 0 }, pot: 0, first: 0, game: 0,
    dead: [], spare: [], swapIdx: 0, leader: 0, colour: null, runSuit: null, run: [], nextRank: 0,
    calledAt: 0, note: "", winner: null, v: 0,
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
const swapOrder = (st, k) => (st.first + k) % st.players.length;
const canDealAll = (st) => st.players.length >= 2 && st.players.every((p) => p.placed && p.king && p.bet >= 10 && p.balance >= 2 * p.bet);

function dealInto(st) {
  st.players.forEach((p) => { p.balance -= 2 * p.bet; st.pot += p.bet; st.kings[p.king] += p.bet; });
  const d = deck(), n = st.players.length, hands = Array.from({ length: n + 1 }, () => []);
  d.forEach((c, i) => hands[i % (n + 1)].push(c));
  st.players.forEach((p, i) => (p.hand = sortHand(hands[i])));
  st.spare = sortHand(hands[n]); st.dead = []; st.swapIdx = 0; st.phase = "swap"; st.note = ""; st.run = []; st.colour = null;
}
function startPlay(st) { st.leader = st.first; st.colour = null; st.run = []; st.phase = "play"; }
function leadOptions(st, i) {
  const h = st.players[i].hand, want = st.colour;
  const suitsOf = (col) => SUITS.filter((s) => (col === "red") === RED[s]);
  let suits = want ? suitsOf(want) : SUITS;
  let avail = suits.filter((s) => h.some((c) => c.s === s));
  if (want && !avail.length) avail = suitsOf(want === "red" ? "black" : "red").filter((s) => h.some((c) => c.s === s));
  return avail.map((s) => ({ s, low: h.filter((c) => c.s === s).sort((a, b) => a.r - b.r)[0] }));
}
function playFrom(st, who, r) {
  const p = st.players[who], suit = st.runSuit; let note = "";
  for (;;) {
    const ci = p.hand.findIndex((c) => c.s === suit && c.r === r); if (ci < 0) break;
    const c = p.hand.splice(ci, 1)[0]; st.run.push({ c, who });
    if (c.r === 12) { const won = st.kings[suit]; st.kings[suit] = 0; p.balance += won; note = `${p.name} played the queen and takes $${won} from the king of ${NAME[suit]}.`; }
    if (p.hand.length === 0) { const won = st.pot; st.pot = 0; p.balance += won; st.winner = { idx: who, won }; st.note = note; st.leader = who; st.phase = "over"; st.first = (st.first + 1) % st.players.length; return; }
    if (c.r === 12) { endRun(st, who, note); return; }
    r++;
  }
  st.nextRank = r; st.leader = who; st.phase = "claim"; st.calledAt = Date.now(); st.note = note;
}
function endRun(st, who, note) { st.leader = who; st.colour = RED[st.runSuit] ? "black" : "red"; st.note = note; st.phase = "play"; }

// ---------- bots ----------
const BOT_NAMES = ["Robo Rita", "Dealer Dan", "Lucky Lou", "Queenie", "Ace Alvarez", "Blackjack Bea", "Shuffle Sam"];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function botPending(st) {
  // which bot (index) needs to act now, or -1
  if (st.phase === "ante") return st.players.findIndex((p) => p.bot && !p.placed);
  if (st.phase === "swap") { const i = swapOrder(st, st.swapIdx); return st.players[i].bot ? i : -1; }
  if (st.phase === "play") return st.players[st.leader].bot ? st.leader : -1;
  if (st.phase === "claim") return st.players.findIndex((p) => p.bot && p.hand.some((c) => c.s === st.runSuit && c.r === st.nextRank));
  return -1;
}
function botDelay(st) { return st.phase === "claim" ? rnd(700, 2200) : st.phase === "play" ? rnd(900, 1800) : rnd(600, 1400); }
function botAct(st, i) {
  const p = st.players[i];
  if (st.phase === "ante") {
    const max = Math.max(10, Math.floor(p.balance / 20) * 10);
    p.king = SUITS[rnd(0, 3)]; p.bet = Math.min(max, [10, 10, 20, 30][rnd(0, 3)]); p.placed = true;
    if (canDealAll(st)) dealInto(st);
  } else if (st.phase === "swap") {
    const h = p.hand, queens = h.filter((c) => c.r === 12).length, high = h.filter((c) => c.r >= 9).length;
    const swap = queens === 0 && high <= 2 && Math.random() < 0.6;
    if (swap) { st.dead = p.hand; p.hand = st.spare; st.spare = []; st.note = `${p.name} swapped for the spare hand.`; startPlay(st); }
    else { st.swapIdx++; if (st.swapIdx >= st.players.length) { st.dead = st.spare; st.spare = []; st.note = "Nobody swapped, so the spare hand is set aside."; startPlay(st); } }
  } else if (st.phase === "play") {
    const opts = leadOptions(st, i); if (!opts.length) return;
    // prefer the suit where it can lay the longest run from its lowest card, bonus if that run reaches the queen
    const score = (o) => { let r = o.low.r, n = 0; while (p.hand.some((c) => c.s === o.s && c.r === r)) { n++; r++; } return n * 2 + (r === 13 ? 5 : 0) + Math.random(); };
    const best = opts.sort((a, b) => score(b) - score(a))[0];
    st.run = []; st.runSuit = best.s; st.note = ""; playFrom(st, i, best.low.r);
  } else if (st.phase === "claim") {
    playFrom(st, i, st.nextRank);
  }
}

// ---------- Durable Object: one per table code ----------
export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.S = null;
    ctx.blockConcurrencyWhile(async () => { this.S = (await ctx.storage.get("state")) || fresh(); });
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(req.url);
    const pid = (url.searchParams.get("pid") || "").slice(0, 40);
    const role = url.searchParams.get("role") === "table" ? "table" : "hand";
    const sid = crypto.randomUUID().slice(0, 8);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid, role, sid, video: false });
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
    const isHost = role === "table" || (st.players.length && st.players[0].id === pid);
    let changed = false, err = "";
    const i = pidx(st, pid);
    switch (m.t) {
      case "hello": this.send(ws); return;
      case "join": {
        if (!pid) break;
        if (st.phase !== "lobby" && st.phase !== "over") { err = "A game is in progress; join when it finishes."; break; }
        const name = String(m.name || "Player").trim().slice(0, 18) || "Player";
        if (i >= 0) { st.players[i].name = name; changed = true; break; }
        if (st.players.length >= 8) { err = "The table is full."; break; }
        st.players.push({ id: pid, name, balance: 1000, bet: 10, king: null, placed: false, hand: [] }); changed = true; break;
      }
      case "leave": if ((st.phase === "lobby" || st.phase === "over") && i >= 0) { st.players.splice(i, 1); st.first = 0; changed = true; } break;
      case "addbot": {
        if (!isHost || (st.phase !== "lobby" && st.phase !== "over") || st.players.length >= 8) break;
        const used = new Set(st.players.map((p) => p.name)); const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${st.players.length + 1}`;
        st.players.push({ id: "bot-" + crypto.randomUUID().slice(0, 6), name, bot: true, balance: 1000, bet: 10, king: null, placed: false, hand: [] }); changed = true; break;
      }
      case "removebot": {
        if (!isHost || (st.phase !== "lobby" && st.phase !== "over")) break;
        const bi = st.players.map((p) => p.bot).lastIndexOf(true); if (bi >= 0) { st.players.splice(bi, 1); st.first = 0; changed = true; } break;
      }
      case "start": if (isHost && st.phase === "lobby" && st.players.length >= 2) { this.beginAnte(st); changed = true; } break;
      case "next": if (isHost && st.phase === "over") { this.beginAnte(st); changed = true; } break;
      case "reset": if (isHost) { this.S = fresh(); await this.ctx.storage.deleteAlarm(); changed = true; } break;
      case "bet": {
        if (i < 0 || st.phase !== "ante") break;
        const p = st.players[i], bet = Math.round(Number(m.bet) / 10) * 10;
        if (!SUITS.includes(m.king) || !(bet >= 10) || p.balance < 2 * bet) { err = "That bet isn't allowed."; break; }
        p.king = m.king; p.bet = bet; p.placed = true;
        if (canDealAll(st)) dealInto(st);
        changed = true; break;
      }
      case "swap": {
        if (st.phase !== "swap") break;
        const turn = swapOrder(st, st.swapIdx); if (st.players[turn].id !== pid) break;
        if (m.swap) { st.dead = st.players[turn].hand; st.players[turn].hand = st.spare; st.spare = []; st.note = `${st.players[turn].name} swapped for the spare hand.`; startPlay(st); }
        else { st.swapIdx++; if (st.swapIdx >= st.players.length) { st.dead = st.spare; st.spare = []; st.note = "Nobody swapped, so the spare hand is set aside."; startPlay(st); } }
        changed = true; break;
      }
      case "lead": {
        if (st.phase !== "play" || st.players[st.leader].id !== pid) break;
        const o = leadOptions(st, st.leader).find((x) => x.s === m.suit); if (!o) break;
        st.run = []; st.runSuit = m.suit; st.note = ""; playFrom(st, st.leader, o.low.r); changed = true; break;
      }
      case "claim": {
        if (st.phase !== "claim" || i < 0) break;
        if (!st.players[i].hand.some((c) => c.s === st.runSuit && c.r === st.nextRank)) { err = `You don't have the ${rname(st.nextRank)}${SYM[st.runSuit]}.`; break; }
        playFrom(st, i, st.nextRank); changed = true; break;
      }
      case "stop": if (isHost && st.phase === "claim") { this.stopRun(st); changed = true; } break;
    }
    if (err) ws.send(JSON.stringify({ t: "err", msg: err }));
    if (changed) await this.commit();
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} this.broadcast(); }
  async webSocketError(ws) { try { ws.close(); } catch {} this.broadcast(); }
  broadcast() { for (const ws of this.ctx.getWebSockets()) { if (ws.readyState === 1) this.send(ws); } }

  async alarm() {
    const st = this.S, now = Date.now(); let changed = false;
    if (st.phase === "claim" && now >= st.calledAt + CLAIM_MS - 50) { this.stopRun(st); changed = true; }
    else if (now >= (st.botAt || 0) - 50) { const i = botPending(st); if (i >= 0) { botAct(st, i); changed = true; } st.botAt = 0; }
    if (changed) await this.commit(); else await this.schedule();
  }

  async schedule() {
    const st = this.S, times = [];
    if (st.phase === "claim") times.push(st.calledAt + CLAIM_MS);
    const bi = botPending(st);
    if (bi >= 0) { if (!st.botAt || st.botAt < Date.now() - 10000) st.botAt = Date.now() + botDelay(st); times.push(st.botAt); } else st.botAt = 0;
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times)); else await this.ctx.storage.deleteAlarm();
  }

  beginAnte(st) {
    st.game++; st.phase = "ante"; st.run = []; st.note = ""; st.winner = null; st.dead = []; st.spare = [];
    st.players.forEach((p) => { p.placed = false; p.king = null; p.hand = []; p.bet = Math.max(10, Math.min(p.bet || 10, Math.floor(p.balance / 20) * 10 || 10)); });
  }
  stopRun(st) { endRun(st, st.leader, `Nobody played the ${rname(st.nextRank)}${SYM[st.runSuit]}, so the run stops.`); }

  async commit() {
    const st = this.S; st.v++; st.botAt = 0;
    await this.schedule();
    await this.ctx.storage.put("state", st);
    this.broadcast();
  }

  // Each socket gets only what it may see: its own hand, everyone else's card count.
  send(ws) {
    const { pid, role, sid } = ws.deserializeAttachment() || {};
    const st = this.S;
    const peers = this.ctx.getWebSockets().map((w) => { const a = w.deserializeAttachment() || {}; const p = st.players.find((x) => x.id === a.pid); return { sid: a.sid, role: a.role, video: !!a.video, name: a.role === "table" ? "Table" : p ? p.name : "Guest" }; });
    const view = {
      ...st, dead: undefined, spareCount: st.spare.length, spare: undefined,
      players: st.players.map((p) => ({ id: p.id, name: p.name, bot: !!p.bot, balance: p.balance, bet: p.bet, king: p.king, placed: p.placed, cards: p.hand.length, hand: role === "hand" && p.id === pid ? p.hand : undefined })),
      you: pid, sid, peers, host: role === "table" || (st.players.length > 0 && st.players[0].id === pid), serverNow: Date.now(),
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
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{3,8})$/);
    if (m) {
      const id = env.TABLE.idFromName(m[1].toUpperCase());
      return env.TABLE.get(id).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};
