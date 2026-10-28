# GAi BOT Android — Floating Binance 8-Strategy Scanner

This Android project converts the existing GAi BOT Binance scanner into a native Android app with a floating overlay. The overlay can remain above Binance, screen sharing, or another app after the user grants Android's **Display over other apps** permission.

## Included
- 10-second live-candle scan button.
- LONG/SHORT result after the scan.
- ENTRY, TP1, TP2 and SL planning levels.
- The same eight-strategy engine from the supplied extension:
  1. Market Structure
  2. Liquidity Sweep
  3. Price Action
  4. Volume Confirmation
  5. Support & Resistance
  6. Order Block
  7. FVG
  8. Breakout + Retest
- Spot/Futures market selector.
- Binance USDT coin list and live price.
- Coin logo for the selected asset.
- Timeframe selector.
- Floating popup that stays visible while another app is open.
- No Binance order placement; signals are informational/manual.
- Original extension source preserved under `extension-original/`.
- GitHub Actions workflow at `.github/workflows/build-apk.yml`.

## Build APK on GitHub
1. Create a GitHub repository and upload this project.
2. Push to `main`/`master`, or open **Actions → Build GAi BOT APK → Run workflow**.
3. Download the `GAi-BOT-debug-apk` artifact from the workflow run.

## Android permissions
The app needs Internet access for Binance public market data and **Display over other apps** for the floating popup. Keep the foreground notification enabled so Android can keep the overlay service alive.

## Important
Crypto signals are not guaranteed. TP/SL values are planning levels generated from the existing strategy engine; they are not financial advice and the app does not place trades automatically.
