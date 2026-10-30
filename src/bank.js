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

// The GameBank: ONE shared wallet of coins per player name, usable across every game.
// Players claim a wallet with a name + password. The banker (a PIN) tops wallets up with coins
// after a player sends real money. The bank keeps each player's balance, total coins put in,
// total won and total lost over time, plus a running history. One global instance ("bank").
export class GameBank extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.S = null;
    ctx.blockConcurrencyWhile(async () => {
      this.S = (await ctx.storage.get("bank")) || { adminHash: "", players: {} };
    });
  }
  async save() { await this.ctx.storage.put("bank", this.S); }
  view(w) {
    return { name: w.name, balance: money(w.balance), totalIn: money(w.totalIn), totalWon: money(w.totalWon), totalLost: money(w.totalLost), net: money(w.totalWon - w.totalLost), history: (w.history || []).slice(-40).reverse() };
  }
  async adminOk(pin) { return !!this.S.adminHash && (await sha(pin)) === this.S.adminHash; }

  async fetch(req) {
    if (req.method !== "POST") return json({ ok: false, err: "POST only" }, 405);
    let m; try { m = await req.json(); } catch (e) { return json({ ok: false, err: "bad request" }, 400); }
    const S = this.S;

    // ----- player: claim a new wallet, or open an existing one (name + password) -----
    if (m.op === "claim" || m.op === "me") {
      const key = norm(m.name);
      if (!key) return json({ ok: false, err: "Enter a name." });
      const pass = String(m.pass || "");
      if (pass.length < 3) return json({ ok: false, err: "Password needs at least 3 characters." });
      const ph = await sha(key + ":" + pass);
      let w = S.players[key];
      if (!w) {
        if (m.op === "me") return json({ ok: false, err: "No wallet with that name yet." });
        w = S.players[key] = { name: String(m.name).trim().slice(0, 24), passHash: ph, balance: 0, totalIn: 0, totalWon: 0, totalLost: 0, created: now(), history: [] };
        await this.save();
        return json({ ok: true, created: true, wallet: this.view(w) });
      }
      if (w.passHash !== ph) return json({ ok: false, err: "Wrong password for that name." });
      return json({ ok: true, wallet: this.view(w) });
    }

    // ----- banker: first-time PIN set -----
    if (m.op === "status") return json({ ok: true, pinSet: !!S.adminHash });
    if (m.op === "setpin") {
      if (S.adminHash) return json({ ok: false, err: "The bank PIN is already set." });
      const pin = String(m.pin || "");
      if (!/^\d{4,8}$/.test(pin)) return json({ ok: false, err: "Choose a PIN of 4\u20138 digits." });
      S.adminHash = await sha(pin); await this.save();
      return json({ ok: true, set: true });
    }

    // ----- everything below needs the banker PIN -----
    const adminOps = ["ledger", "topup", "adjust", "resetpass"];
    if (adminOps.includes(m.op)) {
      if (!S.adminHash) return json({ ok: false, err: "No bank PIN set yet.", noPin: true });
      if (!(await this.adminOk(String(m.pin || "")))) return json({ ok: false, err: "Wrong bank PIN." });
    }

    if (m.op === "ledger") {
      const list = Object.values(S.players).map((w) => ({ name: w.name, balance: money(w.balance), totalIn: money(w.totalIn), totalWon: money(w.totalWon), totalLost: money(w.totalLost), net: money(w.totalWon - w.totalLost) }));
      list.sort((a, b) => b.balance - a.balance);
      return json({ ok: true, players: list });
    }

    if (m.op === "topup" || m.op === "adjust") {
      const w = S.players[norm(m.name)];
      if (!w) return json({ ok: false, err: "No wallet with that name." });
      const amt = money(m.amt);
      if (!amt) return json({ ok: false, err: "Enter an amount." });
      if (m.op === "topup" && amt <= 0) return json({ ok: false, err: "A top-up must be positive." });
      w.balance = money(Math.max(0, w.balance + amt));
      if (amt > 0) w.totalIn = money(w.totalIn + amt);
      (w.history = w.history || []).push({ t: m.op === "topup" ? "topup" : "adjust", amt, bal: w.balance, at: now(), note: String(m.note || "").slice(0, 60) });
      if (w.history.length > 250) w.history = w.history.slice(-250);
      await this.save();
      return json({ ok: true, name: w.name, balance: w.balance });
    }

    if (m.op === "resetpass") {
      const key = norm(m.name), w = S.players[key];
      if (!w) return json({ ok: false, err: "No wallet with that name." });
      const np = String(m.newpass || "");
      if (np.length < 3) return json({ ok: false, err: "New password too short." });
      w.passHash = await sha(key + ":" + np); await this.save();
      return json({ ok: true });
    }

    // ----- game hook (used when the games are wired to the wallet): move coins, record win/loss -----
    if (m.op === "settle") {
      const w = S.players[norm(m.name)];
      if (!w) return json({ ok: false, err: "No wallet." });
      const d = money(m.delta);
      w.balance = money(Math.max(0, w.balance + d));
      if (d > 0) w.totalWon = money(w.totalWon + d); else if (d < 0) w.totalLost = money(w.totalLost - d);
      (w.history = w.history || []).push({ t: d >= 0 ? "win" : "loss", amt: d, bal: w.balance, at: now(), note: String(m.reason || "").slice(0, 60) });
      if (w.history.length > 250) w.history = w.history.slice(-250);
      await this.save();
      return json({ ok: true, balance: w.balance });
    }

    return json({ ok: false, err: "Unknown request." });
  }
}
