# GAi BOT — 8-Strategy Signal Engine

The signal engine uses these eight strategies:

1. Market Structure — trend/direction
2. Liquidity Sweep — liquidity grab
3. Price Action — candle confirmation
4. Volume Confirmation — move strength
5. Support & Resistance — key levels
6. Order Block — supply/demand zone
7. FVG (Fair Value Gap) — imbalance/entry zone
8. Breakout + Retest — breakout confirmation

## Signal gate

**UP:** bullish market structure + bullish price-action confirmation + bullish volume + a valid bullish Order Block, FVG, or Support level.

**DOWN:** bearish market structure + bearish price-action confirmation + bearish volume + a valid bearish Order Block, FVG, or Resistance level.

Liquidity Sweep and Breakout + Retest are additional confirmations. The extension remains manual-only and does not place Binance orders.
