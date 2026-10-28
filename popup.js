// ============================================================
// GAi BOT - Binance Multi-Coin Manual Signal Popup
// ============================================================
const directionEl = document.getElementById("direction");
const reasonEl = document.getElementById("reason");
const analyzeBtn = document.getElementById("analyzeBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logList = document.getElementById("logList");
const clearLogEl = document.getElementById("clearLog");
const marketEl = document.getElementById("market");
const confidenceEl = document.getElementById("confidence");
const levelsEl = document.getElementById("levels");
let scanActive = false;

function setLevelsVisible(visible) {
  if (levelsEl) levelsEl.classList.toggle("show", !!visible);
}

function getActiveTab() {
  return chrome.tabs.query({active:true, currentWindow:true}).then(tabs => tabs[0]);
}

function renderSignal(signal) {
  if (!signal) { setLevelsVisible(false); return; }
  directionEl.textContent = signal.direction || "—";
  directionEl.className = "direction " + (signal.direction || "");
  reasonEl.textContent = signal.reason || "—";
  marketEl.textContent = `${signal.symbol || "BTC/USDT"} · ${signal.interval || "4H"}`;
  confidenceEl.textContent = Number.isFinite(signal.confidence) ? `${signal.confidence}% confidence` : "—";
  const fmt = v => (v === undefined || v === null || v === "" || Number.isNaN(Number(v))) ? "—" : Number(v).toLocaleString(undefined,{maximumFractionDigits:2});
  const entryVal=document.getElementById("entryVal"), tp1Val=document.getElementById("tp1Val"), tp2Val=document.getElementById("tp2Val"), slVal=document.getElementById("slVal");
  if(entryVal) entryVal.textContent=fmt(signal.entry);
  if(tp1Val) tp1Val.textContent=fmt(signal.tp1);
  if(tp2Val) tp2Val.textContent=fmt(signal.tp2);
  if(slVal) slVal.textContent=fmt(signal.sl);
  setLevelsVisible(true);
}

function renderLog(log) {
  if (!log?.length) {
    logList.innerHTML = '<div class="log-empty">No manual confirmations logged</div>';
    return;
  }
  logList.innerHTML = log.map(e => `<div class="log-entry"><span class="dir-${e.direction}">${e.direction}</span><span>${e.loggedAt || ""}</span></div>`).join("");
}

analyzeBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id || !/(?:^|\.)binance\.(?:com|bh)$/i.test(new URL(tab.url || "").hostname)) {
    statusText.textContent = "open Binance and select a market";
    return;
  }
  statusText.textContent = scanActive ? "stopping..." : "scanning...";
  analyzeBtn.textContent = scanActive ? "Stopping…" : "STOP SCAN";
  setLevelsVisible(false);
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {action:"analyze"});
    if (res?.stopped) {
      scanActive = false;
      analyzeBtn.textContent = "START SCAN · 10s";
      statusText.textContent = "scan stopped";
      statusDot.classList.add("live");
      return;
    }
    if (res?.signal) {
      scanActive = false;
      analyzeBtn.textContent = "START SCAN · 10s";
      renderSignal(res.signal);
      statusDot.classList.add("live");
      statusText.textContent = "live · Binance · 10s live candle";
    } else { scanActive = false; analyzeBtn.textContent = "START SCAN · 10s"; statusText.textContent = res?.error || "Market data not ready"; }
  } catch (_) {
    setLevelsVisible(false);
    scanActive = false; analyzeBtn.textContent = "START SCAN · 10s"; statusText.textContent = "refresh Binance tab";
  }
});

clearLogEl.addEventListener("click", () => {
  chrome.storage.local.set({manualLog:[]});
  renderLog([]);
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === "signal_update" && msg.signal) {
    renderSignal(msg.signal);
    statusDot.classList.add("live");
    statusText.textContent = "live · Binance · 10s live candle";
  }
  if (msg.action === "binance_status") statusText.textContent = msg.status === "live" ? "live · Binance" : msg.status;
  if (msg.action === "signal_error") { setLevelsVisible(false); statusText.textContent = msg.error; }
});

chrome.storage.local.get({latestSignal:null, manualLog:[]}, data => {
  renderSignal(data.latestSignal);
  renderLog(data.manualLog);
  if (data.latestSignal) { statusDot.classList.add("live"); statusText.textContent = "live · Binance · 10s live candle"; }
});
