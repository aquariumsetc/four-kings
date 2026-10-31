import { DurableObject } from "cloudflare:workers";

// ---- helpers ----
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const now = () => Date.now();
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }

const WKEY = (key) => "w:" + key;        // one storage value per wallet, so the ~128 KB per-value limit is per player, never shared (handoff gotcha: don't stuff the whole bank in one blob)
const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const MAX_TOKENS = 8;   // a handful of devices can stay signed in to one wallet at once; the oldest token drops off
const MAX_HISTORY = 200; // per wallet; net-per-hand settlement means ~1 entry per hand, so this is plenty

// The GameBank: ONE shared wallet of coins per player name, usable across every game.
// Players claim a wallet with a name + password (which mints a per-device sign-in TOKEN).
// The banker (a PIN) tops wallets up with coins after a player sends real money.
// Coins move during play only via the INTERNAL "settle" op — never from the browser:
//   - it is kept off the public /bankapi surface (the Worker route allow-lists public ops),
//   - it requires the shared BANK_SECRET (server-only; settle fails closed if it's unset),
//   - and it requires the player's sign-in token, so a device can only move its own wallet.
// Storage: one value per wallet under "w:<name>", plus "admin" for the PIN hash. A one-time
// migration splits the old single "bank" blob into those per-wallet keys on first load.
export class GameBank extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.adminHash = "";
    ctx.blockConcurrencyWhile(async () => {
      const legacy = await ctx.storage.get("bank"); // one-time migration from the single blob
      if (legacy) {
        this.adminHash = legacy.adminHash || "";
        await ctx.storage.put("admin", { adminHash: this.adminHash });
        for (const key in (legacy.players || {})) {
          const w = legacy.players[key]; w.tokens = w.tokens || [];
          await ctx.storage.put(WKEY(key), w);
        }
        await ctx.storage.delete("bank");
      } else {
        this.adminHash = ((await ctx.storage.get("admin")) || {}).adminHash || "";
      }
    });
  }

  async getW(key) { return (await this.ctx.storage.get(WKEY(key))) || null; }
  async putW(key, w) { await this.ctx.storage.put(WKEY(key), w); }
  async setAdmin(hash) { this.adminHash = hash; await this.ctx.storage.put("admin", { adminHash: hash }); }
  view(w) {
    return { name: w.name, balance: money(w.balance), totalIn: money(w.totalIn), totalWon: money(w.totalWon), totalLost: money(w.totalLost), net: money(w.totalWon - w.totalLost), history: (w.history || []).slice(-40).reverse() };
  }
  async adminOk(pin) { return !!this.adminHash && (await sha(pin)) === this.adminHash; }
  pushHist(w, e) { (w.history = w.history || []).push(e); if (w.history.length > MAX_HISTORY) w.history = w.history.slice(-MAX_HISTORY); }

  async fetch(req) {
    if (req.method !== "POST") return json({ ok: false, err: "POST only" }, 405);
    let m; try { m = await req.json(); } catch (e) { return json({ ok: false, err: "bad request" }, 400); }

    // ===== INTERNAL op (never reachable from the browser; the /bankapi route blocks it) =====
    // settle: a game Durable Object moves coins for one player and records the win/loss.
    if (m.op === "settle") {
      const secret = this.env && this.env.BANK_SECRET;
      if (!secret) return json({ ok: false, err: "Bank not configured: set BANK_SECRET.", noSecret: true });
      if (String(m.secret || "") !== String(secret)) return json({ ok: false, err: "settle refused" });
      const key = norm(m.name), w = await this.getW(key);
      if (!w) return json({ ok: false, err: "No wallet." });
      if (!m.token || !(w.tokens || []).includes(String(m.token))) return json({ ok: false, err: "Wallet not signed in on this device." });
      const d = money(m.delta);
      w.balance = money(Math.max(0, w.balance + d));
      if (d > 0) w.totalWon = money(w.totalWon + d); else if (d < 0) w.totalLost = money(w.totalLost - d);
      this.pushHist(w, { t: d >= 0 ? "win" : "loss", amt: d, bal: w.balance, at: now(), note: String(m.reason || "").slice(0, 60) });
      await this.putW(key, w);
      return json({ ok: true, balance: w.balance });
    }

    // ===== player: claim a new wallet, or open an existing one (name + password) -> sign-in token =====
    if (m.op === "claim" || m.op === "me") {
      const key = norm(m.name);
      if (!key) return json({ ok: false, err: "Enter a name." });
      const pass = String(m.pass || "");
      if (pass.length < 3) return json({ ok: false, err: "Password needs at least 3 characters." });
      const ph = await sha(key + ":" + pass);
      let w = await this.getW(key), created = false;
      if (!w) {
        if (m.op === "me") return json({ ok: false, err: "No wallet with that name yet." });
        w = { name: String(m.name).trim().slice(0, 24), passHash: ph, balance: 0, totalIn: 0, totalWon: 0, totalLost: 0, created: now(), history: [], tokens: [] };
        created = true;
      } else if (w.passHash !== ph) {
        return json({ ok: false, err: "Wrong password for that name." });
      }
      const token = newToken();
      w.tokens = [...(w.tokens || []), token].slice(-MAX_TOKENS);
      await this.putW(key, w);
      return json({ ok: true, created, token, wallet: this.view(w) });
    }

    // ===== balance read for a signed-in device (used by the games at join / hand start) =====
    if (m.op === "bal") {
      const key = norm(m.name), w = await this.getW(key);
      if (!w) return json({ ok: false, err: "No wallet." });
      if (!m.token || !(w.tokens || []).includes(String(m.token))) return json({ ok: false, err: "Not signed in." });
      return json({ ok: true, balance: money(w.balance) });
    }

    // ===== banker: first-time PIN set =====
    if (m.op === "status") return json({ ok: true, pinSet: !!this.adminHash });
    if (m.op === "setpin") {
      if (this.adminHash) return json({ ok: false, err: "The bank PIN is already set." });
      const pin = String(m.pin || "");
      if (!/^\d{4,8}$/.test(pin)) return json({ ok: false, err: "Choose a PIN of 4\u20138 digits." });
      await this.setAdmin(await sha(pin));
      return json({ ok: true, set: true });
    }

    // ===== everything below needs the banker PIN =====
    const adminOps = ["ledger", "topup", "adjust", "resetpass", "topupall"];
    if (adminOps.includes(m.op)) {
      if (!this.adminHash) return json({ ok: false, err: "No bank PIN set yet.", noPin: true });
      if (!(await this.adminOk(String(m.pin || "")))) return json({ ok: false, err: "Wrong bank PIN." });
    }

    if (m.op === "ledger") {
      const map = await this.ctx.storage.list({ prefix: "w:" });
      const list = [];
      for (const w of map.values()) list.push({ name: w.name, balance: money(w.balance), totalIn: money(w.totalIn), totalWon: money(w.totalWon), totalLost: money(w.totalLost), net: money(w.totalWon - w.totalLost) });
      list.sort((a, b) => b.balance - a.balance);
      return json({ ok: true, players: list });
    }

    if (m.op === "topup" || m.op === "adjust") {
      const key = norm(m.name), w = await this.getW(key);
      if (!w) return json({ ok: false, err: "No wallet with that name." });
      const amt = money(m.amt);
      if (!amt) return json({ ok: false, err: "Enter an amount." });
      if (m.op === "topup" && amt <= 0) return json({ ok: false, err: "A top-up must be positive." });
      w.balance = money(Math.max(0, w.balance + amt));
      if (amt > 0) w.totalIn = money(w.totalIn + amt);
      this.pushHist(w, { t: m.op === "topup" ? "topup" : "adjust", amt, bal: w.balance, at: now(), note: String(m.note || "").slice(0, 60) });
      await this.putW(key, w);
      return json({ ok: true, name: w.name, balance: w.balance });
    }

    if (m.op === "topupall") {
      const amt = money(m.amt);
      if (!amt || amt <= 0) return json({ ok: false, err: "Enter a positive amount." });
      const map = await this.ctx.storage.list({ prefix: "w:" });
      let n = 0;
      for (const [k, w] of map) {
        w.balance = money(w.balance + amt); w.totalIn = money(w.totalIn + amt);
        this.pushHist(w, { t: "topup", amt, bal: w.balance, at: now(), note: "all players" });
        await this.ctx.storage.put(k, w); n++;
      }
      return json({ ok: true, count: n });
    }

    if (m.op === "resetpass") {
      const key = norm(m.name), w = await this.getW(key);
      if (!w) return json({ ok: false, err: "No wallet with that name." });
      const np = String(m.newpass || "");
      if (np.length < 3) return json({ ok: false, err: "New password too short." });
      w.passHash = await sha(key + ":" + np); await this.putW(key, w);
      return json({ ok: true });
    }

    return json({ ok: false, err: "Unknown request." });
  }
}
