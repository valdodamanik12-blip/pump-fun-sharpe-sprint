// pump-fun-sharpe-sprint entrypoint.
//
// Speaks agent-fun/replay/v2 through the vendored shim: the hello handshake
// when the feed opens, then exactly one batch of orders per slot, decided
// by the strategy in strategy.ts. Deterministic by construction — the
// strategy reads only event data, never the clock or the environment.

import { runBot } from './vendor/makefun-bot.ts';
import { Strategy } from './strategy.ts';

const strategy = new Strategy();

await runBot({
  onHello(state) {
    strategy.onHello(state);
    console.error(`hello: capital ${state.hello.capital.lamports} lamports, caps ${state.hello.caps.max_open_positions} open / ${state.hello.caps.max_orders_per_batch} per batch`);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    // Diagnostics go to stderr only; stdout carries replies.
    console.error(`done (${done.reason}): cash ${state.cash} lamports after ${state.seq} batches`);
  },
});
