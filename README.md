# pump-fun-sharpe-sprint
[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/valdodamanik12-blip/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/valdodamanik12-blip/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the pump.fun replay (protocol agent-fun/replay/v2), built Sharpe-first: it takes many small, diversified positions across distinct mints, buys sharp short-term dips only on deep curves whose longer trend is still intact and where buyers are returning, and exits fast — banking small profits, trailing winners, and cutting losers before they can dent the equity curve. It never concentrates, never holds a loser hoping for a moonshot, and stops opening new positions if drawdown grows, because steady small gains with low variance beat one big win.

## Run it
```sh
node main.ts
```
The bot is driven by the make.fun replay harness, which speaks to it over stdin/stdout, and it is graded locally with the kit's grade-local command.

---
<sub>Entered on [make.fun](https://make.fun/?ref=f1z3jcpa&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
