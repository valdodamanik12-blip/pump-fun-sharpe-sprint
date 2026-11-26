// Strategy for the pump.fun Sharpe sprint: Sharpe-first, conservative.
//
// Idea: only trade curves with real depth (enough real SOL in the curve
// that our capped order is meaningful and exits are cheap), buy a sharp
// short-term dip while the longer trend is still intact and buyers are
// returning, take a small fixed-size position, and leave quickly — bank a
// few percent when it is offered, cut a few percent when it is not, and
// never sit in a loser.
// Many small, short, diversified round trips keep the hourly equity curve
// smooth, which is what the ranking rewards.
//
// Everything here is a pure function of the feed: no clock, no randomness,
// no environment. The same replay always produces the same orders.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000n;

// --- sizing / fee model -------------------------------------------------
// Fees are ~95 + 30 bps of curve fees per side plus a fixed tx fee, so a
// round trip needs roughly a 3% price move just to break even. Exits are
// set beyond that; entries are sized so the fixed fee stays a small share.
const ORDER_LAMPORTS = 80_000_000n; // 0.08 SOL per entry: fixed tx fee drags less
const MIN_ORDER_LAMPORTS = 12_000_000n; // above the 0.01 SOL round-trip bar
const TAKE_PROFIT = 0.06; // net-of-fees gain that banks the position
const STOP_LOSS = -0.04; // net-of-fees loss that cuts the position
const TRAIL_ARM = 0.03; // trailing exit arms once this far in profit
const TRAIL_GIVEBACK = 0.015; // and fires when this much is given back
const TRAIL_FLOOR = 0.01; // a trailing exit never fires below this profit
const MAX_HOLD_SLOTS = 500; // time exit: do not camp in a coin
const STALE_EXIT_SLOTS = 200; // earlier time exit when already near flat

// --- entry filters --------------------------------------------------------
// Revision after the first grade: chasing a rising price over the last
// couple of dozen trades bought local tops and churned fees. Entries now
// buy a *dip* instead — a short, sharp pullback inside a longer trend that
// is still intact, with buyers already stepping back in — and bank the
// bounce. One trip per mint keeps the churn (and the fee bill) down.
const MIN_TRADES = 15;
const MIN_REAL_QUOTE = 5_000_000_000n; // 5 SOL of real reserve
const DIP_MIN = -0.12; // short-window pullback at least this deep...
const DIP_MAX = -0.025; // ...but at least 2.5%, so there is a bounce to earn
const TREND_MIN = 0.0; // long window must actually be up, not merely not collapsed
const TREND_MAX = 0.6; // and must not be a blow-off top either
const MIN_BUY_PRESSURE = 0.55; // buyers clearly returning on the dip
const MIN_REAL_QUOTE_V3 = 8_000_000_000n; // deeper curves only: cheaper exits
const SHORT_TRADES = 8;
const LONG_TRADES = 40;
const REENTRY_COOLDOWN_SLOTS = 250;
const MAX_TRIPS_PER_MINT = 1;

// --- risk -----------------------------------------------------------------
const DRAWDOWN_HALT = 0.12; // stop opening positions past this drawdown
const MAX_BATCH_ORDERS = 16;

interface TradeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  price: number; // virtual quote per token after the trade
}

interface MintStats {
  ticks: TradeTick[];
  trades: number;
  lastSlot: number;
  trips: number;
  lastExitSlot: number;
}

interface OpenInfo {
  sinceSlot: number;
  peakPnl: number; // best net PnL seen, for the trailing exit
}

export class Strategy {
  private stats = new Map<Pubkey, MintStats>();
  private open = new Map<Pubkey, OpenInfo>();
  private roundTripped = new Set<Pubkey>();
  private peakEquity = 0n;
  private initialEquity = 0n;

  onHello(state: BotState): void {
    this.initialEquity = BigInt(state.hello.capital.lamports);
    this.peakEquity = this.initialEquity;
  }

  // Ingest this batch's events into the per-mint rolling windows.
  private ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      if (vt <= 0n) continue;
      const price = Number(vq) / Number(vt);
      let s = this.stats.get(e.mint);
      if (s === undefined) {
        s = { ticks: [], trades: 0, lastSlot: e.slot, trips: 0, lastExitSlot: -1_000_000 };
        this.stats.set(e.mint, s);
      }
      s.trades += 1;
      s.lastSlot = e.slot;
      s.ticks.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), price });
      if (s.ticks.length > 64) s.ticks.splice(0, s.ticks.length - 64);
    }
  }

  // Gross SOL the curve would pay for `tokens` right now (constant product
  // on the virtual reserves), before sell-side fees.
  private grossSellValue(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const c = state.curves.get(mint);
    if (c === undefined || tokens <= 0n) return 0n;
    const vt = c.virtual_token_reserves;
    const vq = c.virtual_quote_reserves;
    if (vt <= 0n || vq <= 0n) return 0n;
    return vq - (vt * vq) / (vt + tokens);
  }

  // Net SOL after the ~125 bps of sell fees and one tx fee.
  private netSellValue(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const gross = this.grossSellValue(state, mint, tokens);
    if (gross <= 0n) return 0n;
    const afterFees = (gross * 9875n) / 10_000n;
    const tx = state.txFeeLamports();
    return afterFees > tx ? afterFees - tx : 0n;
  }

  private equity(state: BotState): bigint {
    let eq = state.cash;
    for (const [mint, h] of state.positions) eq += this.netSellValue(state, mint, h.token_amount);
    return eq;
  }

  private hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.ingest(batch);
    const orders: OrderInput[] = [];

    // Track position lifetimes and completed round trips.
    for (const mint of state.positions.keys()) {
      if (!this.open.has(mint)) this.open.set(mint, { sinceSlot: batch.slot, peakPnl: -1 });
    }
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint) && !this.hasPending(state, mint, 'buy')) {
        this.open.delete(mint);
        this.roundTripped.add(mint);
        const s = this.stats.get(mint);
        if (s !== undefined) {
          s.trips += 1;
          s.lastExitSlot = batch.slot;
        }
      }
    }

    // Drawdown bookkeeping on the estimated equity curve.
    const eq = this.equity(state);
    if (eq > this.peakEquity) this.peakEquity = eq;
    const drawdown = this.peakEquity > 0n ? Number(this.peakEquity - eq) / Number(this.peakEquity) : 0;
    const haltEntries = drawdown > DRAWDOWN_HALT;

    // --- exits first: they free slots and protect the curve -------------
    for (const [mint, h] of state.positions) {
      if (orders.length >= MAX_BATCH_ORDERS) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (this.hasPending(state, mint, 'sell')) continue;
      const net = this.netSellValue(state, mint, h.token_amount);
      if (net <= 0n || h.cost_lamports <= 0n) continue;
      const pnl = Number(net - h.cost_lamports) / Number(h.cost_lamports);
      const info = this.open.get(mint);
      const held = info === undefined ? 0 : batch.slot - info.sinceSlot;
      if (info !== undefined && pnl > info.peakPnl) info.peakPnl = pnl;
      const peak = info === undefined ? pnl : info.peakPnl;
      const trailing = peak >= TRAIL_ARM && pnl >= TRAIL_FLOOR && pnl <= peak - TRAIL_GIVEBACK;
      const shouldExit =
        pnl >= TAKE_PROFIT ||
        pnl <= STOP_LOSS ||
        trailing ||
        held >= MAX_HOLD_SLOTS ||
        (held >= STALE_EXIT_SLOTS && pnl >= -0.005);
      if (shouldExit) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: 900 });
      }
    }

    // --- entries ---------------------------------------------------------
    if (!haltEntries) {
      const room = state.hello.caps.max_open_positions - state.committedPositionCount();
      if (room > 0) {
        const candidates = this.rankCandidates(state, batch.slot);
        let opened = 0;
        for (const mint of candidates) {
          if (opened >= room) break;
          if (orders.length >= MAX_BATCH_ORDERS) break;
          const cap = state.maxBuyLamports(mint);
          if (cap < MIN_ORDER_LAMPORTS) continue;
          let size = ORDER_LAMPORTS;
          if (size > cap) size = cap;
          // Keep a cash buffer so exits and fees never starve.
          const free = state.freeCashLamports() - pendingSpend(orders);
          if (free - size < LAMPORTS / 10n) continue;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: 500 });
          opened += 1;
        }
      }
    }
    return orders;
  }

  // Score live curves by recent momentum and buy pressure; deterministic
  // order (score desc, then mint asc) so replays match byte for byte.
  private rankCandidates(state: BotState, slot: number): Pubkey[] {
    const scored: { mint: Pubkey; score: number }[] = [];
    for (const [mint, curve] of state.curves) {
      if (curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (this.hasPending(state, mint, 'buy')) continue;
      const s = this.stats.get(mint);
      if (s === undefined) continue;
      if (s.trades < MIN_TRADES || curve.trades < MIN_TRADES) continue;
      if (curve.real_quote_reserves < MIN_REAL_QUOTE_V3) continue;
      if (s.trips >= MAX_TRIPS_PER_MINT) continue;
      if (slot - s.lastExitSlot < REENTRY_COOLDOWN_SLOTS && s.trips > 0) continue;
      if (slot - s.lastSlot > 60) continue; // only coins trading right now
      const longWin = s.ticks.slice(-LONG_TRADES);
      const shortWin = s.ticks.slice(-SHORT_TRADES);
      if (longWin.length < MIN_TRADES || shortWin.length < SHORT_TRADES) continue;
      const longFirst = longWin[0];
      const shortFirst = shortWin[0];
      const last = shortWin[shortWin.length - 1];
      if (longFirst === undefined || shortFirst === undefined || last === undefined) continue;
      if (longFirst.price <= 0 || shortFirst.price <= 0) continue;
      // The dip: price fell over the last few trades...
      const dip = last.price / shortFirst.price - 1;
      if (dip < DIP_MIN || dip > DIP_MAX) continue;
      // ...inside a longer trend that has not collapsed.
      const trend = last.price / longFirst.price - 1;
      if (trend < TREND_MIN || trend > TREND_MAX) continue;
      // Buyers must already be stepping back in on the short window.
      let buySol = 0n;
      let totalSol = 0n;
      for (const t of shortWin) {
        totalSol += t.sol;
        if (t.isBuy) buySol += t.sol;
      }
      if (totalSol <= 0n) continue;
      const pressure = Number(buySol) / Number(totalSol);
      if (pressure < MIN_BUY_PRESSURE) continue;
      // Prefer fresh round-trip mints (the guardrail needs 20 distinct),
      // then stronger returning pressure and a deeper (but bounded) dip.
      const freshBonus = this.roundTripped.has(mint) ? 0 : 0.5;
      const score = freshBonus + pressure - dip;
      scored.push({ mint, score });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    return scored.map((c) => c.mint);
  }
}

// SOL that orders already chosen in this reply would spend (buys + tx fees
// are approximated by the buy amounts alone; the buffer absorbs the rest).
function pendingSpend(orders: OrderInput[]): bigint {
  let sum = 0n;
  for (const o of orders) {
    if (o.side === 'buy') sum += BigInt(o.quote_lamports as bigint);
  }
  return sum;
}
