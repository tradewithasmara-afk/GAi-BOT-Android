// GAi BOT — Binance multi-coin live-candle scanner
// Manual signals only. No order placement.
let MARKET='spot';
let SYMBOL='BTCUSDT';
let SYMBOL_LIST=[];
const DEFAULT_SYMBOL='BTCUSDT';
const TRACE_MS=10000;
const SIGNAL_AT_MS=11000;
const POLL_MS=1000;
const DATA_TIMEOUT_MS=3000;
const LIMIT=250;
const INTERVALS=['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
let currentInterval='15m', history=[], live=null, ws=null, reconnectTimer=null, scan=null, ui=null, overlay=null, scanBox=null, lastPrice=0, traceSamples=[], wsLastUpdate=0, traceLive=true;

async function loadSymbols(){
  const id=Math.random().toString(36).slice(2);
  return new Promise((resolve,reject)=>{
    let done=false;
    const timer=setTimeout(()=>finish(null,new Error('Symbol list timeout')),5000);
    const finish=(v,e)=>{if(done)return;done=true;clearTimeout(timer);chrome.runtime.onMessage.removeListener(listener);e?reject(e):resolve(v);};
    function listener(msg){if(msg.action!=='symbols_response'||msg.requestId!==id)return;msg.error?finish(null,new Error(msg.error)):finish(msg.data||[]);}
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({action:'get_symbols',requestId:id,market:MARKET}).catch(e=>finish(null,e));
  });
}
function cleanBinanceSymbol(value){
  const clean=String(value||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  if(!clean)return null;
  // Binance symbols normally end in one of these quote assets.
  if(/(?:USDT|USDC|FDUSD|BUSD|BTC|ETH|BNB)$/.test(clean)) return clean;
  return null;
}
function detectBinanceSymbol(){
  try{
    const path=decodeURIComponent(location.pathname||'');
    // Futures pages are commonly /en/futures/BTCUSDT or /en/futures/BTCUSDT_PERP.
    const fm=path.match(/\/futures\/([^/?#]+)/i);
    if(fm){
      const raw=fm[1].replace(/_PERP$/i,'');
      const sym=cleanBinanceSymbol(raw);
      if(sym)return sym;
    }
    // Spot pages are commonly /en/trade/BTC_USDT (and sometimes BTCUSDT).
    const sm=path.match(/\/(?:trade|spot)\/([^/?#]+)/i);
    if(sm){
      const sym=cleanBinanceSymbol(sm[1].replace(/[_-]/g,''));
      if(sym)return sym;
    }
    // Query-string fallbacks used by some Binance routes.
    const q=new URLSearchParams(location.search);
    for(const key of ['symbol','pair','contract']){
      const value=q.get(key);
      const sym=cleanBinanceSymbol(value);
      if(sym)return sym;
    }
    // Last-resort: inspect the page title for e.g. "BTCUSDT Perpetual".
    const title=String(document.title||'');
    const tm=title.match(/\b([A-Z0-9]{2,20}(?:USDT|USDC|FDUSD|BUSD))\b/i);
    if(tm)return cleanBinanceSymbol(tm[1]);
  }catch{}
  return null;
}
function detectMarket(){
  try{
    const path=String(location.pathname||'').toLowerCase();
    if(/\/futures(?:\/|$)/.test(path) || /\bfutures\b/.test(path)) return 'futures';
    if(/\/(?:trade|spot)(?:\/|$)/.test(path)) return 'spot';
    const saved=document.documentElement?.dataset?.gaiMarket;
    if(saved) return String(saved).toLowerCase()==='futures'?'futures':'spot';
  }catch{}
  return MARKET;
}
async function setMarket(market){
  market=String(market||'spot').toLowerCase()==='futures'?'futures':'spot';
  if(market===MARKET)return;
  MARKET=market;
  const data=await loadSymbols();
  SYMBOL_LIST=Array.isArray(data)?data:[];
  const detected=detectBinanceSymbol();
  SYMBOL=detected && SYMBOL_LIST.some(x=>x.symbol===detected)?detected:(SYMBOL_LIST[0]?.symbol||'BTCUSDT');
  await new Promise(r=>chrome.storage.local.set({selectedMarket:MARKET,selectedSymbol:SYMBOL},r));
  traceSamples=[];history=[];live=null;lastPrice=0;
  if(scan){clearInterval(scan.timer);clearInterval(scan.poll);clearTimeout(scan.signalTimer);scan=null;}
  updateMarketSelector();updateSymbolSelector();
  try{await loadHistory(currentInterval);}catch{}
  connectWS();updateMarket();
}
function updateMarketSelector(){
  const sel=ui?.querySelector('#gai-market-select'); if(!sel)return;
  sel.value=MARKET;
}
async function initSymbols(){
  try{
    const detectedMarket=detectMarket();
    const saved=await new Promise(r=>chrome.storage.local.get({selectedMarket:detectedMarket,selectedSymbol:DEFAULT_SYMBOL},r));
    MARKET=saved.selectedMarket||detectedMarket||'spot';
    const detected=detectBinanceSymbol();
    SYMBOL=detected || saved.selectedSymbol || DEFAULT_SYMBOL;
    const data=await loadSymbols();
    SYMBOL_LIST=Array.isArray(data)?data:[];
    if(!SYMBOL_LIST.some(x=>x.symbol===SYMBOL)) SYMBOL=SYMBOL_LIST[0]?.symbol||DEFAULT_SYMBOL;
    await new Promise(r=>chrome.storage.local.set({selectedMarket:MARKET,selectedSymbol:SYMBOL},r));
    updateMarketSelector();updateSymbolSelector();
  }catch{updateMarketSelector();updateSymbolSelector();}
}
async function setSymbol(symbol){
  symbol=String(symbol||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!symbol||symbol===SYMBOL)return;
  SYMBOL=symbol;
  await new Promise(r=>chrome.storage.local.set({selectedSymbol:SYMBOL},r));
  traceSamples=[]; history=[]; live=null; lastPrice=0;
  if(scan){clearInterval(scan.timer);clearInterval(scan.poll);clearTimeout(scan.signalTimer);scan=null;}
  connectWS();
  try{await loadHistory(currentInterval);setStatus(`${SYMBOL} · LIVE · Ready`);}catch(e){setStatus(`${SYMBOL} · Data retry`);}
  updateMarket();
}
function updateSymbolSelector(){
  if(!ui)return;
  const sel=ui.querySelector('#gai-symbol'); if(!sel)return;
  const list=SYMBOL_LIST.length?SYMBOL_LIST:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'}];
  sel.innerHTML=list.map(x=>`<option value="${x.symbol}" ${x.symbol===SYMBOL?'selected':''}>${x.baseAsset||x.symbol.replace(/USDT$/,'')} / ${x.quoteAsset||'USDT'}</option>`).join('');
  sel.value=SYMBOL;
}
const send=(action,payload={})=>{try{chrome.runtime.sendMessage({action,...payload}).catch(()=>{});}catch{}};
const fmt=v=>Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:2}):'—';
const label=i=>i==='1M'?'1M':i.toUpperCase();
function ema(a,p){if(a.length<p)return null;const k=2/(p+1);let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<a.length;i++)e=a[i]*k+e*(1-k);return e;}
function rsi(a,p=14){if(a.length<=p)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}return al===0?100:100-100/(1+ag/al);}
function atr(a,p=14){if(a.length<p+1)return null;const tr=[];for(let i=1;i<a.length;i++)tr.push(Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close)));return tr.slice(-p).reduce((x,y)=>x+y,0)/p;}
function normalize(k,closedOverride){if(!Array.isArray(k)||k.length<7)return null;const [t,o,h,l,c,,x]=k;const n=[t,o,h,l,c].map(Number);if(n.some(v=>!Number.isFinite(v)))return null;return{time:n[0]/1000,open:n[1],high:n[2],low:n[3],close:n[4],closed:closedOverride??Boolean(x)};}

async function requestKlines(interval,limit=LIMIT){
  const id=Math.random().toString(36).slice(2);
  const data=await new Promise((resolve,reject)=>{
    let done=false;
    const timer=setTimeout(()=>finish(null,new Error('Market-data timeout')),DATA_TIMEOUT_MS);
    const finish=(v,e)=>{if(done)return;done=true;clearTimeout(timer);chrome.runtime.onMessage.removeListener(listener);e?reject(e):resolve(v);};
    function listener(msg){if(msg.action!=='klines_response'||msg.requestId!==id)return;msg.error?finish(null,new Error(msg.error)):finish(msg.data||[]);}
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({action:'get_klines',requestId:id,symbol:SYMBOL,interval,limit,market:MARKET}).catch(e=>finish(null,e));
  });
  if(Array.isArray(data)&&data.length)return data;
  throw new Error('No Binance live market data');
}
async function loadHistory(interval){
  const raw=await requestKlines(interval,LIMIT);
  const parsed=raw.map((k,i)=>normalize(k,i<raw.length-1)).filter(Boolean);
  if(parsed.length<30)throw new Error('Not enough ${SYMBOL} candle data');
  history=parsed.slice(0,-1);live=parsed.at(-1);live.closed=false;lastPrice=live.close;renderAll();
}
function pushTraceSample(candle){
  if(!traceLive||!candle)return;
  const now=Date.now();
  const last=traceSamples.at(-1);
  if(!last||now-last.t>=700||Math.abs(last.price-candle.close)>0){
    traceSamples.push({t:now,price:candle.close,high:candle.high,low:candle.low,open:candle.open});
    traceSamples=traceSamples.slice(-20);
  }
}
function applyLiveCandle(candle){
  if(!candle)return;
  lastPrice=candle.close;
  wsLastUpdate=Date.now();
  if(candle.closed){
    history=[...history.filter(x=>x.time!==candle.time),candle].sort((a,b)=>a.time-b.time).slice(-LIMIT);
    live=null;
  }else{
    // Keep ONE continuously changing object for the currently forming candle.
    // Every Binance kline update replaces the same candle by its candle-open time.
    live={...candle,closed:false};
  }
  pushTraceSample(live);
  renderAll();
}
function connectWS(){
  if(ws){try{ws.close();}catch{}} ws=null; clearTimeout(reconnectTimer);
  const int=currentInterval;
  const urls=MARKET==='futures' ? [
    `wss://fstream.binance.com/market/ws/${SYMBOL.toLowerCase()}@kline_${int}`,
    `wss://fstream.binance.com/ws/${SYMBOL.toLowerCase()}@kline_${int}`
  ] : [
    `wss://data-stream.binance.vision/ws/${SYMBOL.toLowerCase()}@kline_${int}`,
    `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@kline_${int}`
  ];
  let n=0;
  const open=()=>{
    wsLastUpdate=0;
    if(int!==currentInterval)return;
    const u=urls[n++%urls.length];
    try{ws=new WebSocket(u);}catch(e){setStatus('WebSocket retry…');return reconnectTimer=setTimeout(open,1500);}
    ws.onopen=()=>{setStatus((MARKET==='futures'?'FUTURES ':'SPOT ')+'LIVE CANDLE · '+label(int));send('binance_status',{status:'live',interval:label(int)});};
    ws.onmessage=e=>{
      try{
        const d=JSON.parse(e.data);
        const k=d?.k||d?.data?.k;
        if(!k)return;
        const c=normalize([k.t,k.o,k.h,k.l,k.c,k.v,k.x],Boolean(k.x));
        if(c)applyLiveCandle(c);
      }catch{}
    };
    ws.onerror=()=>{setStatus('WebSocket reconnecting…');try{ws.close();}catch{}};
    ws.onclose=()=>{if(int===currentInterval)reconnectTimer=setTimeout(open,1500);};
  };
  open();
}
async function refreshLiveOnce(){
  try{
    const raw=await requestKlines(currentInterval,2);
    const p=raw.map((k,i)=>normalize(k,i<raw.length-1)).filter(Boolean);
    if(!p.length)return false;
    const last={...p.at(-1),closed:false};
    if(p.length>1){
      const prev={...p.at(-2),closed:true};
      history=[...history.filter(x=>x.time!==prev.time),prev].sort((a,b)=>a.time-b.time).slice(-LIMIT);
    }
    // REST is only a fallback. Do not let a slower REST response overwrite
    // a newer WebSocket update for the same candle.
    if(!wsLastUpdate || Date.now()-wsLastUpdate>1500 || !live || last.time!==live.time){
      applyLiveCandle(last);
    }
    return true;
  }catch{return false;}
}

function avg(values){
  const xs=values.filter(Number.isFinite);
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
}
function candleBody(c){return Math.abs(c.close-c.open);}
function candleRange(c){return Math.max(0,c.high-c.low);}
function bodyRatio(c){const r=candleRange(c);return r?candleBody(c)/r:0;}
function getSwingPoints(a,window=2){
  const highs=[],lows=[];
  for(let i=window;i<a.length-window;i++){
    const c=a[i];
    let hi=true,lo=true;
    for(let j=1;j<=window;j++){
      if(c.high<=a[i-j].high||c.high<=a[i+j].high)hi=false;
      if(c.low>=a[i-j].low||c.low>=a[i+j].low)lo=false;
    }
    if(hi)highs.push({index:i,price:c.high});
    if(lo)lows.push({index:i,price:c.low});
  }
  return {highs,lows};
}
function detectMarketStructure(a){
  const {highs,lows}=getSwingPoints(a,2);
  const h=highs.slice(-3),l=lows.slice(-3);
  if(h.length>=2&&l.length>=2){
    const bullish=h.at(-1).price>h.at(-2).price && l.at(-1).price>l.at(-2).price;
    const bearish=h.at(-1).price<h.at(-2).price && l.at(-1).price<l.at(-2).price;
    return {bull:bullish,bear:bearish,highs:h,lows:l};
  }
  const recent=a.slice(-12),mid=a.slice(-24,-12);
  const r=avg(recent.map(x=>x.close)),m=avg(mid.map(x=>x.close));
  return {bull:r>m,bear:r<m,highs:h,lows:l};
}
function detectLiquiditySweep8(a,lookback=20){
  if(a.length<lookback+2)return {bull:false,bear:false,level:null};
  const last=a.at(-1), prior=a.slice(-(lookback+1),-1);
  const hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));
  return {bull:last.low<lo&&last.close>lo,bear:last.high>hi&&last.close<hi,level:last.low<lo?lo:last.high>hi?hi:null};
}
function detectPriceAction(a){
  if(a.length<3)return {bull:false,bear:false,label:'NONE'};
  const c=a.at(-1),p=a.at(-2),range=candleRange(c),body=candleBody(c);
  const lower=Math.min(c.open,c.close)-c.low,upper=c.high-Math.max(c.open,c.close);
  const bullEngulf=c.close>c.open&&p.close<p.open&&c.open<=p.close&&c.close>=p.open;
  const bearEngulf=c.close<c.open&&p.close>p.open&&c.open>=p.close&&c.close<=p.open;
  const hammer=c.close>=c.open&&lower>=Math.max(body*1.5,range*.35)&&upper<=range*.25;
  const shoot=c.close<=c.open&&upper>=Math.max(body*1.5,range*.35)&&lower<=range*.25;
  const strongBull=c.close>c.open&&bodyRatio(c)>=.6&&c.close>=c.low+range*.7;
  const strongBear=c.close<c.open&&bodyRatio(c)>=.6&&c.close<=c.low+range*.3;
  return {bull:bullEngulf||hammer||strongBull,bear:bearEngulf||shoot||strongBear,label:bullEngulf?'Bullish Engulfing':bearEngulf?'Bearish Engulfing':hammer?'Bullish Rejection':shoot?'Bearish Rejection':strongBull?'Strong Bullish Candle':strongBear?'Strong Bearish Candle':'NONE'};
}
function detectVolumeConfirmation(a,lookback=20){
  if(a.length<lookback+2)return {bull:false,bear:false,ratio:0};
  const last=a.at(-1),base=avg(a.slice(-(lookback+1),-1).map(x=>Number(x.volume)));
  const ratio=base?Number(last.volume)/base:0;
  const strong=ratio>=1.05;
  return {bull:strong&&last.close>last.open,bear:strong&&last.close<last.open,ratio};
}
function detectSupportResistance(a,atrValue){
  const {highs,lows}=getSwingPoints(a,2),last=a.at(-1),tol=Math.max(atrValue*.45,last.close*.0008);
  const supports=lows.map(x=>x.price).filter(p=>p<=last.high+tol).sort((x,y)=>Math.abs(last.close-x)-Math.abs(last.close-y));
  const resistances=highs.map(x=>x.price).filter(p=>p>=last.low-tol).sort((x,y)=>Math.abs(last.close-x)-Math.abs(last.close-y));
  const support=supports[0],resistance=resistances[0];
  const bull=Number.isFinite(support)&&Math.abs(last.low-support)<=tol&&last.close>support;
  const bear=Number.isFinite(resistance)&&Math.abs(last.high-resistance)<=tol&&last.close<resistance;
  return {bull,bear,support:bull?support:null,resistance:bear?resistance:null};
}
function detectOrderBlock(a,atrValue){
  const last=a.at(-1),look=a.slice(Math.max(0,a.length-14),-1),tol=Math.max(atrValue*.35,last.close*.0007);
  let bull=null,bear=null;
  for(let i=look.length-1;i>=0;i--){
    const c=look[i];
    if(!bull&&c.close<c.open){
      const after=look.slice(i+1).concat([last]).slice(0,3);
      if(after.some(x=>x.close>c.high&&candleBody(x)>=candleBody(c)*1.2)) bull={low:Math.min(c.open,c.close),high:Math.max(c.open,c.close)};
    }
    if(!bear&&c.close>c.open){
      const after=look.slice(i+1).concat([last]).slice(0,3);
      if(after.some(x=>x.close<c.low&&candleBody(x)>=candleBody(c)*1.2)) bear={low:Math.min(c.open,c.close),high:Math.max(c.open,c.close)};
    }
  }
  const inZone=z=>z&&last.low<=z.high+tol&&last.high>=z.low-tol;
  return {bull:inZone(bull),bear:inZone(bear),bullZone:bull,bearZone:bear};
}
function detectFVG(a,atrValue){
  if(a.length<3)return {bull:false,bear:false,bullZone:null,bearZone:null};
  const last=a.at(-1),tol=Math.max(atrValue*.35,last.close*.0007);
  let bullZone=null,bearZone=null;
  for(let i=a.length-3;i>=Math.max(0,a.length-12);i--){
    const x=a[i],z=a[i+2];
    if(!bullZone&&x.high<z.low)bullZone={low:x.high,high:z.low};
    if(!bearZone&&x.low>z.high)bearZone={low:z.high,high:x.low};
  }
  const inZone=z=>z&&last.low<=z.high+tol&&last.high>=z.low-tol;
  return {bull:inZone(bullZone),bear:inZone(bearZone),bullZone,bearZone};
}
function detectBreakoutRetest(a,lookback=15){
  if(a.length<lookback+3)return {bull:false,bear:false};
  const last=a.at(-1),prev=a.at(-2),prior=a.slice(-(lookback+2),-2);
  const hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));
  const bull=(prev.close<=hi&&last.close>hi)||(last.low<=hi&&last.close>hi&&prev.close>hi);
  const bear=(prev.close>=lo&&last.close<lo)||(last.high>=lo&&last.close<lo&&prev.close<lo);
  return {bull,bear,high:hi,low:lo};
}
function makeSignal(startPrice,samples){
  // Always analyze at least the latest 100 candles from the chart-selected
  // symbol/timeframe. The live forming candle is included as an extra candle.
  const all=[...history]; if(live)all.push(live);
  const closedCount=history.length;
  if(closedCount<100)return makeFallbackSignal(startPrice,samples,live);
  const analysis=all.slice(-101);
  const atrValue=atr(analysis,14);
  if(!atrValue)return makeFallbackSignal(startPrice,samples,live);

  // Eight strategies are evaluated on the same 100+ candle analysis window
  // and their directional evidence is combined into one final signal.
  const ms=detectMarketStructure(analysis),sweep=detectLiquiditySweep8(analysis),pa=detectPriceAction(analysis),vol=detectVolumeConfirmation(analysis),sr=detectSupportResistance(analysis,atrValue),ob=detectOrderBlock(analysis,atrValue),fvg=detectFVG(analysis,atrValue),br=detectBreakoutRetest(analysis);
  const bullZone=ob.bull||fvg.bull||sr.bull, bearZone=ob.bear||fvg.bear||sr.bear;
  const coreBull=ms.bull&&pa.bull&&vol.bull&&bullZone;
  const coreBear=ms.bear&&pa.bear&&vol.bear&&bearZone;
  const bullScore=(ms.bull?2:0)+(sweep.bull?1:0)+(pa.bull?2:0)+(vol.bull?2:0)+(sr.bull?1:0)+(ob.bull?1:0)+(fvg.bull?1:0)+(br.bull?1:0);
  const bearScore=(ms.bear?2:0)+(sweep.bear?1:0)+(pa.bear?2:0)+(vol.bear?2:0)+(sr.bear?1:0)+(ob.bear?1:0)+(fvg.bear?1:0)+(br.bear?1:0);
  // Final 8-strategy engine: every 5s scan evaluates all eight strategies.
  // Core signal gate follows the requested rule; Liquidity Sweep and Breakout + Retest
  // remain explicit confirmations and are included in the final strategy state.
  let direction;
  if(coreBull&&!coreBear) direction='UP';
  else if(coreBear&&!coreBull) direction='DOWN';
  else direction=bullScore>=bearScore?'UP':'DOWN';
  const score=direction==='UP'?bullScore:bearScore;
  const core=direction==='UP'?coreBull:coreBear;
  const strategyConfirmations=direction==='UP'
    ? [ms.bull,sweep.bull,pa.bull,vol.bull,sr.bull,ob.bull,fvg.bull,br.bull].filter(Boolean).length
    : [ms.bear,sweep.bear,pa.bear,vol.bear,sr.bear,ob.bear,fvg.bear,br.bear].filter(Boolean).length;
  const confidence=Math.min(96,Math.max(55,Math.round(55+(score/12)*41+(core?7:0))));
  const entry=analysis.at(-1).close,risk=Math.max(atrValue,entry*.001);
  const evidence=[
    ms.bull&&direction==='UP'?'Market Structure bullish':ms.bear&&direction==='DOWN'?'Market Structure bearish':null,
    sweep.bull&&direction==='UP'?'Liquidity Sweep bullish':sweep.bear&&direction==='DOWN'?'Liquidity Sweep bearish':null,
    pa.bull&&direction==='UP'?`Price Action ${pa.label}`:pa.bear&&direction==='DOWN'?`Price Action ${pa.label}`:null,
    vol.bull&&direction==='UP'?`Volume ${vol.ratio.toFixed(1)}x`:vol.bear&&direction==='DOWN'?`Volume ${vol.ratio.toFixed(1)}x`:null,
    sr.bull&&direction==='UP'?'Support level':sr.bear&&direction==='DOWN'?'Resistance level':null,
    ob.bull&&direction==='UP'?'Bullish Order Block':ob.bear&&direction==='DOWN'?'Bearish Order Block':null,
    fvg.bull&&direction==='UP'?'Bullish FVG':fvg.bear&&direction==='DOWN'?'Bearish FVG':null,
    br.bull&&direction==='UP'?'Breakout + Retest bullish':br.bear&&direction==='DOWN'?'Breakout + Retest bearish':null
  ].filter(Boolean);
  const traceFirst=Number(samples[0]?.price||startPrice||entry),traceLast=Number(samples.at(-1)?.price||entry),traceMove=traceLast-traceFirst;
  return {direction,confidence,reason:`${label(currentInterval)} · ${core?'CORE CONFIRMED':'DIRECTIONAL BIAS'} · ${evidence.slice(0,5).join(' · ')}${traceMove?' · 5s trace '+(traceMove>=0?'+':'')+traceMove.toFixed(2):''}`,interval:label(currentInterval),symbol:formatSymbol(SYMBOL),entry,tp1:direction==='UP'?entry+risk:entry-risk,tp2:direction==='UP'?entry+risk*1.5:entry-risk*1.5,sl:direction==='UP'?entry-risk:entry+risk,atr:risk,timestamp:Date.now(),scanSeconds:10,signalAtSeconds:11,candlesAnalyzed:analysis.length,closedCandlesAnalyzed:closedCount,strategy:{marketStructure:ms,sweep,priceAction:pa,volume:vol,supportResistance:sr,orderBlock:ob,fvg,breakoutRetest:br,coreConfirmed:core,confirmations:strategyConfirmations,totalStrategies:8}};
}

function formatSymbol(s){const m=String(s||'').match(/^(.+?)(USDT|USDC|FDUSD|BUSD|TUSD|BTC|ETH|BNB)$/);return m?`${m[1]}/${m[2]}`:String(s||'—');}
function getBaseAsset(symbol){
  const s=String(symbol||'').toUpperCase();
  return s.replace(/(USDT|USDC|FDUSD|BUSD|TUSD|BTC|ETH|BNB)$/,'') || s;
}
function logoCandidates(base){
  const b=encodeURIComponent(String(base||'').toUpperCase());
  const bl=encodeURIComponent(String(base||'').toLowerCase());
  // Use Binance's own static asset logos first, then public fallbacks for
  // newly listed assets that may not yet exist in the older icon package.
  return [
    `https://bin.bnbstatic.com/static/assets/logos/${b}.png`,
    `https://bin.bnbstatic.com/static/assets/logos/${bl}.png`,
    `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@latest/128/color/${bl}.png`,
    `https://cryptoicons.org/api/icon/${bl}/200`
  ];
}
function setCoinLogo(img,symbol){
  if(!img)return;
  const base=getBaseAsset(symbol);
  if(img.dataset.base===base && img.dataset.logoReady==='1')return;
  img.dataset.base=base; img.dataset.logoReady='0'; img.dataset.logoTry='0';
  const urls=logoCandidates(base);
  const tryNext=()=>{
    const i=Number(img.dataset.logoTry||0);
    if(i>=urls.length){img.src=chrome.runtime.getURL('icons/icon48.png');img.dataset.logoReady='1';return;}
    img.dataset.logoTry=String(i+1);
    img.src=urls[i];
  };
  img.onerror=tryNext;
  img.onload=()=>{img.dataset.logoReady='1';};
  tryNext();
  img.alt=base.toUpperCase();
}
function setStatus(s){if(ui){const el=ui.querySelector('#gai-status');if(el)el.textContent=s;}}
function renderAll(){
  if(!ui||!live)return;
  const priceEl=ui.querySelector('#gai-price'); if(priceEl) priceEl.textContent=fmt(live.close);
  const scanPriceEl=scanBox?.querySelector('#gai-scan-price'); if(scanPriceEl) scanPriceEl.textContent=fmt(live.close);
  const scanStatusEl=scanBox?.querySelector('#gai-scan-status'); if(scanStatusEl && scan) scanStatusEl.textContent=`SCANNING · ${Math.max(0,Math.ceil((TRACE_MS-(Date.now()-scan.start))/1000))}s`;
  const nameEl=ui.querySelector('#gai-coin-name'); if(nameEl) nameEl.textContent=formatSymbol(SYMBOL);
  const logoEl=ui.querySelector('#gai-coin-logo');
  if(logoEl) setCoinLogo(logoEl,SYMBOL);
  ui.querySelector('#gai-ohlc').textContent='';
}
function drawLiveCandle(){
  if(!ui)return;
  const wrap=ui.querySelector('#gai-candle-chart');
  if(!wrap)return;
  const candles=[...history.slice(-5), ...(live?[live]:[])].filter(Boolean);
  if(!candles.length){wrap.innerHTML='<div class="gai-chart-empty">Waiting for live market data…</div>';return;}
  const W=300,H=118,pad={l:8,r:8,t:8,b:15};
  const vals=candles.flatMap(c=>[Number(c.high),Number(c.low)]).filter(Number.isFinite);
  let min=Math.min(...vals),max=Math.max(...vals); if(!(max>min)){max=min+1;min=min-1;}
  const range=max-min, extra=range*0.08; min-=extra; max+=extra;
  const xStep=(W-pad.l-pad.r)/Math.max(candles.length,1);
  const bodyW=Math.max(7,Math.min(18,xStep*.52));
  const y=v=>pad.t+(max-v)/(max-min)*(H-pad.t-pad.b);
  const x=i=>pad.l+xStep*i+xStep/2;
  const fmtShort=v=>{if(!Number.isFinite(v))return ''; if(v>=1000)return (v/1000).toFixed(1)+'k'; if(v>=1)return v.toFixed(2); return v.toPrecision(3);};
  const parts=[];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="7" fill="#171b25"/>`);
  for(let g=1;g<=3;g++){const gy=pad.t+(H-pad.t-pad.b)*g/4;parts.push(`<line x1="${pad.l}" y1="${gy}" x2="${W-pad.r}" y2="${gy}" stroke="#2a3040" stroke-width="1"/>`);}
  candles.forEach((c,i)=>{
    const o=Number(c.open),h=Number(c.high),l=Number(c.low),cl=Number(c.close); if(![o,h,l,cl].every(Number.isFinite))return;
    const up=cl>=o, bodyTop=y(Math.max(o,cl)), bodyBottom=y(Math.min(o,cl));
    const bh=Math.max(2,bodyBottom-bodyTop), xx=x(i), left=xx-bodyW/2;
    const cls=up?'up':'down';
    parts.push(`<line x1="${xx}" y1="${y(h)}" x2="${xx}" y2="${y(l)}" class="wick ${cls}"/>`);
    parts.push(`<rect x="${left}" y="${bodyTop}" width="${bodyW}" height="${bh}" rx="1.5" class="body ${cls}"/>`);
    if(i===candles.length-1)parts.push(`<circle cx="${xx}" cy="${y(cl)}" r="2.5" class="live-dot"/>`);
  });
  const last=candles[candles.length-1];
  parts.push(`<text x="${W-pad.r}" y="12" text-anchor="end" class="price-label">${fmtShort(Number(last.close))}</text>`);
  parts.push(`<text x="${pad.l}" y="${H-3}" class="candle-label">5 CLOSED + LIVE</text>`);
  wrap.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Live market candlestick chart">${parts.join('')}</svg><div class="gai-live-tag">LIVE</div>`;
}
function progress(elapsed){
  const remaining=Math.max(0,Math.ceil((TRACE_MS-elapsed)/1000));
  const status=elapsed<TRACE_MS?`SCANNING · ${remaining}s`:`10s COMPLETE · SIGNAL`;
  if(scanBox){
    const fill=scanBox.querySelector('#gai-scan-fill'); if(fill) fill.style.setProperty('--scan-progress',Math.min(100,elapsed/TRACE_MS*100)+'%');
    const timer=scanBox.querySelector('#gai-scan-time'); if(timer) timer.textContent=String(remaining);
    const st=scanBox.querySelector('#gai-scan-status'); if(st) st.textContent=status;
    const price=scanBox.querySelector('#gai-scan-price'); if(price && Number.isFinite(Number(lastPrice))) price.textContent=fmt(lastPrice);
  }
  if(ui){
    setStatus(status);
    ui.querySelector('#gai-bar').style.width=Math.min(100,elapsed/TRACE_MS*100)+'%';
    ui.querySelector('#gai-timer')?.textContent && (ui.querySelector('#gai-timer').textContent=`00:${String(remaining).padStart(2,'0')}`);
    ui.querySelector('#gai-direction').textContent='SCANNING…';
    ui.querySelector('#gai-direction').className='gai-wait';
    ui.querySelector('#gai-levels').style.display='none';
    ui.querySelector('#gai-reason').style.display='none';
  }
  renderAll();updateTraceOverlay();
}

function showSignal(s){
  if(!ui)return;
  ui.querySelector('#gai-direction').textContent=s.direction==='UP'?'UP ↑':'DOWN ↓';
  ui.querySelector('#gai-direction').className=s.direction==='UP'?'gai-up':'gai-down';
  setStatus(`SIGNAL · 11th second · ${s.interval}`);
  ui.querySelector('#gai-levels').innerHTML=`<div class="gai-signal-levels-title">TRADE LEVELS · SEPARATE</div><div class="gai-level-grid"><div class="gai-entry-card"><span>ENTRY</span><b>${fmt(s.entry)}</b></div></div><div class="gai-level-separate"><div class="gai-tp1-card"><span>TP1</span><b>${fmt(s.tp1)}</b></div><div class="gai-tp2-card"><span>TP2</span><b>${fmt(s.tp2)}</b></div><div class="gai-sl-card"><span>SL</span><b>${fmt(s.sl)}</b></div></div>`; ui.querySelector('#gai-levels').style.display='block'; ui.querySelector('#gai-reason').style.display='block';
  ui.querySelector('#gai-reason').textContent=`${s.reason} · Risk ${fmt(s.atr)}`;
  updateTraceOverlay(true); send('signal_update',{signal:s,candle:live});

  // The scanning panel disappears after the signal. A separate result popup
  // is shown so LONG/SHORT, ENTRY, TP1, TP2 and SL are immediately visible.
  setTimeout(()=>showFinalSignalPopup(s),250);
}
function showScanOverlay(){
  if(scanBox) scanBox.remove();
  const oldStyle=document.getElementById('gai-scan-overlay-style'); if(oldStyle) oldStyle.remove();
  const st=document.createElement('style'); st.id='gai-scan-overlay-style';
  st.textContent=`
  #gai-scan-overlay{position:fixed;z-index:2147483647;inset:0;width:100%;height:100vh;height:100dvh;min-width:260px;min-height:100vh;pointer-events:none;color:#fff;font:10px Arial,sans-serif}
  #gai-scan-overlay .gai-chart-scan-frame{position:absolute;inset:0;border-top:0;border-bottom:0;border-left:0;border-right:0;border-radius:0;background:linear-gradient(90deg,rgba(255,214,0,.025),rgba(255,214,0,.10),rgba(255,214,0,.025));box-shadow:inset 0 0 35px rgba(255,215,0,.06),0 0 18px rgba(255,215,0,.08);overflow:hidden}
  #gai-scan-overlay .gai-grid{position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,215,0,.09) 1px,transparent 1px),linear-gradient(rgba(255,215,0,.07) 1px,transparent 1px);background-size:25% 25%;opacity:.55}
  #gai-scan-overlay .gai-scan-beam{position:absolute;top:-2%;bottom:-2%;left:0;width:3px;background:linear-gradient(180deg,transparent,#fff000 12%,#fff000 88%,transparent);box-shadow:0 0 10px #ffe600,0 0 28px rgba(255,220,0,.85);animation:gaiChartSweep 2.2s linear infinite}
  #gai-scan-overlay .gai-scan-glow{position:absolute;top:0;bottom:0;left:-18%;width:36%;background:linear-gradient(90deg,transparent,rgba(255,226,0,.11),transparent);animation:gaiChartGlow 2.2s linear infinite}
  #gai-scan-overlay .gai-corner{display:none}
  #gai-scan-overlay .c1{left:-1px;top:-1px;border-width:3px 0 0 3px}.gai-corner.c2{right:-1px;top:-1px;border-width:3px 3px 0 0}.gai-corner.c3{left:-1px;bottom:-1px;border-width:0 0 3px 3px}.gai-corner.c4{right:-1px;bottom:-1px;border-width:0 3px 3px 0}
  #gai-scan-overlay .gai-scan-tag{position:absolute;left:50%;top:-16px;transform:translateX(-50%);padding:5px 11px;border:1px solid rgba(255,225,0,.8);border-radius:18px;background:rgba(10,14,20,.92);color:#ffe600;font-size:10px;font-weight:900;white-space:nowrap;box-shadow:0 0 15px rgba(255,220,0,.18)}
  #gai-scan-overlay .gai-scan-tag .pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ffe600;box-shadow:0 0 8px #ffe600;margin-right:5px;animation:gaiPulse 1s infinite}
  @keyframes gaiChartSweep{0%{left:0}100%{left:calc(100% - 3px)}}@keyframes gaiChartGlow{0%{left:-36%}100%{left:100%}}@keyframes gaiPulse{50%{opacity:.35;transform:scale(.72)}}`;
  document.documentElement.appendChild(st);
  scanBox=document.createElement('div'); scanBox.id='gai-scan-overlay';
  scanBox.innerHTML=`<div class="gai-chart-scan-frame"><div class="gai-grid"></div><div class="gai-scan-glow"></div><div class="gai-scan-beam"></div><div class="gai-corner c1"></div><div class="gai-corner c2"></div><div class="gai-corner c3"></div><div class="gai-corner c4"></div><div class="gai-scan-tag"><span class="pulse"></span>SCANNING · <span id="gai-scan-time">10</span>s</div></div>`;
  document.body.appendChild(scanBox);
}
function removeScanOverlay(){
  if(scanBox){scanBox.remove();scanBox=null;}
  document.getElementById('gai-scan-overlay-style')?.remove();
}
function showFinalSignalPopup(s){
  const old=document.querySelector('#gai-final-signal');
  if(old)old.remove();
  const styleId='gai-final-signal-style';
  document.getElementById(styleId)?.remove();
  const st=document.createElement('style'); st.id=styleId;
  st.textContent=`#gai-final-signal{position:fixed;z-index:2147483647;left:50%;top:50%;transform:translate(-50%,-50%);width:210px;background:#11151e;color:#fff;border:1px solid #3b4355;border-radius:14px;padding:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);font:11px Arial,sans-serif;animation:gaiSignalIn .18s ease-out}.gai-final-head{display:flex;justify-content:space-between;align-items:center;font-size:8px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.7px}.gai-final-close{border:0;background:#252b37;color:#fff;border-radius:5px;width:20px;height:20px;cursor:pointer;font-size:14px}.gai-final-direction{text-align:center;font-size:25px;font-weight:900;padding:8px 4px;margin:7px 0;border-radius:9px;background:#1b2230}.gai-final-direction.long{color:#39e58c;border:1px solid #267d56}.gai-final-direction.short{color:#ff665c;border:1px solid #8c3a36}.gai-final-entry{background:#202632;border:1px solid #394052;border-radius:8px;padding:8px;text-align:center;margin-bottom:6px}.gai-final-entry span,.gai-final-level span{display:block;color:#9aa4b2;font-size:7px;font-weight:800;letter-spacing:.6px}.gai-final-entry b{display:block;font-size:13px;margin-top:3px}.gai-final-levels{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.gai-final-level{background:#171c26;border:1px solid #303746;border-radius:7px;padding:7px 3px;text-align:center}.gai-final-level b{display:block;font-size:9px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gai-final-level.tp{border-color:#267d56}.gai-final-level.tp b{color:#39e58c}.gai-final-level.sl{border-color:#8c3a36}.gai-final-level.sl b{color:#ff665c}.gai-final-meta{text-align:center;color:#7f899b;font-size:7px;margin-top:7px}@keyframes gaiSignalIn{from{opacity:0;transform:translate(-50%,-46%) scale(.98)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}`;
  document.documentElement.append(st);
  const box=document.createElement('div');box.id='gai-final-signal';
  const dir=s.direction==='UP'?'LONG ↑':'SHORT ↓';
  box.innerHTML=`<div class="gai-final-head"><span>${s.symbol || formatSymbol(SYMBOL)} · ${s.interval} · SIGNAL</span><button class="gai-final-close" title="Close">×</button></div><div class="gai-final-direction ${s.direction==='UP'?'long':'short'}">${dir}</div><div class="gai-final-entry"><span>ENTRY</span><b>${fmt(s.entry)}</b></div><div class="gai-final-levels"><div class="gai-final-level tp"><span>TP1</span><b>${fmt(s.tp1)}</b></div><div class="gai-final-level tp"><span>TP2</span><b>${fmt(s.tp2)}</b></div><div class="gai-final-level sl"><span>SL</span><b>${fmt(s.sl)}</b></div></div><div class="gai-final-meta">Signal generated from live candle scan</div>`;
  document.body.appendChild(box);
  box.querySelector('.gai-final-close').addEventListener('click',()=>{box.remove();st.remove();});
  if(ui){ui.remove();ui=null;}
  const os=document.querySelector('#gai-trace-overlay-style'); if(os)os.remove();
  if(overlay){overlay.remove();overlay=null;}
}

function findChartRect(){
  const els=[...document.querySelectorAll('canvas,svg')].filter(el=>{const r=el.getBoundingClientRect();return r.width>280&&r.height>180&&r.bottom>80&&r.top<innerHeight;});
  if(!els.length)return null;
  els.sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height);
  const r=els[0].getBoundingClientRect();
  return {left:Math.max(0,r.left),top:Math.max(0,r.top),width:Math.min(innerWidth,r.width),height:Math.min(innerHeight-r.top,r.height)};
}
function ensureTraceOverlay(){return null;}
function updateTraceOverlay(signal=false){return;}
function stopScan(){
  if(!scan)return false;
  clearInterval(scan.timer); clearInterval(scan.poll); clearTimeout(scan.signalTimer);
  scan=null;
  removeScanOverlay();
  if(ui){
    ui.style.display='flex';
    const btn=ui.querySelector('#gai-scan');
    if(btn){btn.disabled=false;btn.textContent='START SCAN · 10s';}
    setStatus('SCAN PAUSED');
    ui.querySelector('#gai-bar').style.width='0%';
    ui.querySelector('#gai-direction').textContent='READY';
    ui.querySelector('#gai-direction').className='gai-wait';
    ui.querySelector('#gai-levels').style.display='none';
    ui.querySelector('#gai-reason').style.display='none';
  }
  updateTraceOverlay(false);
  return true;
}
async function startScan(){
  if(!ui)return;
  if(scan){ stopScan(); return {stopped:true}; }
  const btn=ui.querySelector('#gai-scan');
  btn.disabled=false; traceSamples=[];
  btn.textContent='STOP SCAN';
  btn.classList.add('gai-stop');
  ui.querySelector('#gai-bar').style.width='0%';
  ui.querySelector('#gai-direction').textContent='SCANNING…';
  setStatus('SCANNING LIVE CANDLE…');
  try{
    showScanOverlay();
    if(ui) ui.style.display='none';
    const chosen=ui.querySelector('#gai-tf')?.value;
    if(chosen)currentInterval=chosen;
    updateMarket();

    // Start the scan clock IMMEDIATELY on click. Do not wait for REST/WebSocket data.
    // The existing live candle is used instantly when available; background refresh
    // continues through the poll loop so a slow connection never delays scan start.
    const start=Date.now();
    const startCandle=live;
    const startPrice=Number(startCandle?.close||lastPrice||0);
    if(startCandle){
      traceSamples.push({t:start,price:startCandle.close,high:startCandle.high,low:startCandle.low,open:startCandle.open});
    }

    // Keep market data connected/refreshed in the background. These calls no longer
    // block the scan start or make the user wait before the timer begins.
    connectWS();
    refreshLiveOnce().catch(()=>{});
    if(history.length<30) loadHistory(currentInterval).catch(()=>{});

    const poll=setInterval(async()=>{
      // WebSocket is the live trace source. REST only rescues a stale/disconnected stream.
      if(Date.now()-wsLastUpdate>1800){
        await refreshLiveOnce();
      }else if(live){
        pushTraceSample(live);
        renderAll();
      }
    },POLL_MS);
    const timer=setInterval(()=>{
      const elapsed=Date.now()-start;
      if(elapsed<=TRACE_MS) progress(elapsed);
    },100);

    const signalTimer=setTimeout(async()=>{
      clearInterval(timer); clearInterval(poll);
      await refreshLiveOnce();
      // Give the WebSocket one last moment to update the live candle.
      if(live) pushTraceSample(live);
      ui.querySelector('#gai-bar').style.width='100%';
      setStatus('10s COMPLETE · SIGNAL');
      removeScanOverlay();
      try{
        const s=makeSignal(startPrice,traceSamples);
        showSignal(s);
      }catch(e){
        // Never leave the user without a result if historical indicators are unavailable.
        const s=makeFallbackSignal(startPrice,traceSamples,live);
        showSignal(s);
      }
      scan=null; btn.disabled=false; btn.textContent='START SCAN · 10s'; btn.classList.remove('gai-stop');
    },SIGNAL_AT_MS);
    scan={timer,poll,signalTimer,active:true,start};
    btn.textContent='STOP SCAN';
    progress(0);
  }catch(e){
    scan=null; removeScanOverlay(); if(ui) ui.style.display='flex'; btn.disabled=false; btn.textContent='START SCAN · 10s'; btn.classList.remove('gai-stop');
    setStatus('SCAN ERROR · '+e.message);
    ui.querySelector('#gai-direction').textContent='NO DATA'; if(overlay)overlay.style.display='none';
    send('signal_error',{error:e.message});
  }
}
function makeFallbackSignal(startPrice,samples,candle){
  const end=Number(samples.at(-1)?.price||candle?.close||startPrice);
  const first=Number(samples[0]?.price||startPrice);
  const move=end-first;
  let up=move>0;
  if(Math.abs(move)<Math.max(first*0.00005,0.5)) up=(Number(candle?.close||end)>=Number(candle?.open||first));
  const entry=end;
  const range=Math.max(
    Math.abs(Number(candle?.high||entry)-Number(candle?.low||entry)),
    entry*0.001
  );
  const risk=range*0.65;
  return {
    direction:up?'UP':'DOWN', confidence:55,
    reason:`${label(currentInterval)} · 10s live-price trace ${move>=0?'+':''}${move.toFixed(2)}`,
    interval:label(currentInterval),symbol:formatSymbol(SYMBOL),entry,
    tp1:up?entry+risk:entry-risk,
    tp2:up?entry+risk*1.5:entry-risk*1.5,
    sl:up?entry-risk:entry+risk,atr:risk,timestamp:Date.now(),scanSeconds:10,signalAtSeconds:11
  };
}
function detectBinanceInterval(){
  const map={
    '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m',
    '1h':'1h','2h':'2h','4h':'4h','6h':'6h','8h':'8h','12h':'12h',
    '1d':'1d','3d':'3d','1w':'1w','1M':'1M'
  };
  const norm=v=>String(v||'').trim().replace(/\s+/g,'').replace(/分钟/g,'m').replace(/小时/g,'h').replace(/天/g,'d').replace(/周/g,'w');
  const keyFor=v=>{
    const t=norm(v);
    if(t==='1M') return '1M';
    const low=t.toLowerCase();
    return Object.keys(map).find(k=>k!=='1M' && k.toLowerCase()===low)||null;
  };
  const candidates=[];
  const els=document.querySelectorAll('button,[role="button"],[data-testid],[aria-label]');
  for(const el of els){
    const vals=[el.textContent,el.getAttribute('aria-label'),el.getAttribute('data-testid')];
    for(const raw of vals){
      const key=keyFor(raw); if(!key) continue;
      let active=false, node=el;
      for(let depth=0;node&&depth<5;depth++,node=node.parentElement){
        const state=[node.getAttribute('aria-selected'),node.getAttribute('aria-pressed'),node.getAttribute('data-state'),node.getAttribute('data-active'),node.className||''].join(' ');
        if(/(^|[\s_-])(true|active|selected|current)([\s_-]|$)/i.test(state)){active=true;break;}
      }
      candidates.push({key,active,el});
    }
  }
  const active=candidates.find(x=>x.active);
  if(active) return active.key;

  // Binance's mobile chart can expose the selected timeframe without an
  // aria-selected/active attribute. Prefer the visually emphasized control,
  // but only among the actual timeframe buttons (never arbitrary div/span text).
  for(const c of candidates){
    let node=c.el;
    for(let depth=0;node&&depth<4;depth++,node=node.parentElement){
      const cs=getComputedStyle(node);
      const text=norm(node.textContent);
      if(keyFor(text)!==c.key) continue;
      const color=(cs.color||'').replace(/\s+/g,'');
      const bg=(cs.backgroundColor||'').replace(/\s+/g,'');
      const border=(cs.borderBottomColor||'').replace(/\s+/g,'');
      const fw=parseInt(cs.fontWeight||'400',10)||400;
      if(fw>=600 && (bg!=='rgba(0,0,0,0)' || border!=='rgba(0,0,0,0)' || color.includes('240,185,11'))){
        return c.key;
      }
    }
  }
  return null;
}

function bindChartTimeframeClicks(){
  if(window.__gaiTfClickBound) return;
  window.__gaiTfClickBound=true;
  document.addEventListener('click',e=>{
    if(scan||!ui) return;
    let el=e.target;
    for(let depth=0;el&&depth<5;depth++,el=el.parentElement){
      const vals=[el.textContent,el.getAttribute?.('aria-label'),el.getAttribute?.('data-testid')];
      for(const raw of vals){
        const t=String(raw||'').trim().replace(/\s+/g,'').replace(/分钟/g,'m').replace(/小时/g,'h').replace(/天/g,'d').replace(/周/g,'w');
        const match=['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'].find(x=>x==='1M'?t==='1M':x.toLowerCase()===t.toLowerCase());
        if(match){
          setTimeout(()=>{
            if(scan||!ui) return;
            if(currentInterval!==match){
              currentInterval=match;
              updateMarket();
              loadHistory(currentInterval).then(()=>connectWS()).catch(()=>connectWS());
            } else updateMarket();
          },120);
          return;
        }
      }
    }
  },true);
}

function syncChartInterval(){
  if(scan||!ui) return;
  const detected=detectBinanceInterval();
  if(!detected || detected===currentInterval) return;
  currentInterval=detected;
  updateMarket();
  setStatus(`CHART TIMEFRAME · ${label(currentInterval)}`);
  loadHistory(currentInterval).then(()=>connectWS()).catch(()=>connectWS());
}
function updateMarket(){if(ui){ui.querySelector('#gai-market').textContent=`${MARKET.toUpperCase()} · ${formatSymbol(SYMBOL)} · ${label(currentInterval)} · LIVE`;ui.querySelector('#gai-price').textContent=live?`${formatSymbol(SYMBOL)} LIVE PRICE ${fmt(live.close)}`:`${formatSymbol(SYMBOL)} LIVE PRICE —`; const tf=ui.querySelector('#gai-tf');if(tf)tf.value=currentInterval;}}
function buildUI(){
  if(ui||!/^(www\.|m\.)?binance\.(com|bh)$/i.test(location.hostname))return;
  ui=document.createElement('div');ui.id='gai-btc-screen-ui';
  ui.innerHTML=`<div class="gai-move-handle" id="gai-move" title="Move"><i></i></div><div class="gai-scroll"><div class="gai-market" id="gai-market">${formatSymbol(SYMBOL)} · AUTO · LIVE</div><div class="gai-row"><div class="gai-tf-title"><span>MARKET TYPE</span></div><select id="gai-market-select"><option value="spot">SPOT</option><option value="futures">FUTURES · PERPETUAL</option></select></div><div class="gai-row"><div class="gai-tf-title"><span>COIN</span></div><select id="gai-symbol"><option>${formatSymbol(SYMBOL)}</option></select></div><div class="gai-row"><div class="gai-tf-title">CHART TF <span id="gai-sync">AUTO</span></div><select id="gai-tf">${INTERVALS.map(x=>`<option value="${x}" ${x===currentInterval?'selected':''}>${label(x)}</option>`).join('')}</select></div><div class="gai-coin-card"><img id="gai-coin-logo" class="gai-coin-logo" src="" alt="coin"><div class="gai-coin-info"><div id="gai-coin-name" class="gai-coin-name">${formatSymbol(SYMBOL)}</div><div class="gai-live-label">LIVE PRICE</div><div id="gai-price" class="gai-price">—</div></div></div><div class="gai-bar-bg"><div id="gai-bar"></div></div><button id="gai-scan">START SCAN · 5s</button><div id="gai-status">Ready — press TRACE</div><div id="gai-direction">—</div><div class="gai-ohlc" id="gai-ohlc" aria-hidden="true"></div><div class="gai-levels" id="gai-levels">Entry — · TP1 — · TP2 — · SL —</div><div id="gai-reason" style="display:none"></div></div><div class="gai-resize-handle" id="gai-resize" title="Resize"><i></i></div>`;
  const st=document.createElement('style');st.textContent=`#gai-btc-screen-ui{position:fixed;z-index:2147483647;right:8px;top:70px;width:155px;height:360px;min-width:120px;min-height:180px;max-width:min(320px,90vw);max-height:80vh;background:#151922;color:#fff;border:1px solid #394052;border-radius:12px;padding:6px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:11px Arial,sans-serif;user-select:none;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}#gai-btc-screen-ui.gai-small{width:125px;height:300px;font-size:7px}#gai-btc-screen-ui.gai-large{width:205px;height:440px;font-size:10px}#gai-btc-screen-ui .gai-move-handle{height:10px;min-height:10px;display:flex;align-items:center;justify-content:center;cursor:move;touch-action:none;margin-bottom:2px}#gai-btc-screen-ui .gai-move-handle i{display:block;width:24px;height:3px;border-radius:4px;background:#596273;box-shadow:0 0 0 1px #394052}#gai-btc-screen-ui .gai-move-handle:active i{background:#8dff16}#gai-btc-screen-ui .gai-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:2px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}#gai-btc-screen-ui .gai-scroll::-webkit-scrollbar{width:4px}#gai-btc-screen-ui .gai-scroll::-webkit-scrollbar-thumb{background:#596273;border-radius:4px}#gai-btc-screen-ui .gai-resize-handle{height:13px;min-height:13px;display:flex;align-items:center;justify-content:center;cursor:nwse-resize;touch-action:none;margin-top:3px}#gai-btc-screen-ui .gai-resize-handle i{display:block;width:30px;height:5px;border-radius:5px;background:#596273;box-shadow:0 0 0 1px #394052}.gai-market{margin-top:2px;color:#f0b90b;font-size:6px}.gai-row{margin:3px 0}.gai-tf-title{display:flex;justify-content:space-between;color:#9aa4b2;font-size:8px;margin-bottom:3px}.gai-tf-title span{color:#8dff16;font-weight:800}.gai-row select{width:100%;background:#202532;color:#fff;border:1px solid #394052;border-radius:5px;padding:5px}.gai-quick{display:flex;gap:3px;margin-top:4px}.gai-quick button{flex:1;background:#202532;color:#fff;border:1px solid #394052;border-radius:4px;padding:3px 0;font-size:8px;cursor:pointer}.gai-quick button:hover{border-color:#8dff16;color:#8dff16}.gai-coin-card{display:flex;align-items:center;gap:10px;margin:5px 0 7px;padding:9px;background:#1b1f2a;border:1px solid #303746;border-radius:9px}.gai-coin-logo{width:38px;height:38px;border-radius:50%;object-fit:contain;background:#202532;border:1px solid #394052;padding:3px}.gai-coin-info{min-width:0;flex:1}.gai-coin-name{color:#fff;font-size:11px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gai-live-label{color:#8b95a6;font-size:6px;font-weight:800;letter-spacing:.6px;margin-top:3px}.gai-price{margin-top:2px;color:#f0f3f7;font-size:14px;font-weight:900;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gai-timer{position:absolute;right:5px;top:5px;background:#343a4b;color:#fff;border-radius:5px;padding:3px 5px;font-size:9px;font-weight:800;font-variant-numeric:tabular-nums}#gai-scan{width:100%;padding:5px;border:0;border-radius:6px;background:#8dff16;color:#0d1608;font-weight:900;cursor:pointer;margin-top:6px}#gai-scan.gai-stop{background:#ef4444;color:#fff}#gai-scan:disabled{opacity:.55}.gai-bar-bg{height:5px;background:#252b37;border-radius:4px;margin:5px 0}.gai-bar-bg div{height:100%;width:0;background:#8dff16;border-radius:4px}#gai-status{margin-top:3px;color:#9aa4b2;font-size:8px}#gai-direction{margin-top:4px;text-align:center;font-size:14px;font-weight:900;padding:5px;border-radius:6px;background:#202532}.gai-up{color:#22c55e}.gai-down{color:#ef4444}.gai-wait{color:#a7ff35}.gai-ohlc{display:none}.gai-levels{display:none;margin-top:6px;padding:6px;background:#10141d;border:1px solid #394052;border-radius:7px;color:#e6e9ef;font-size:8px;line-height:1.45}.gai-signal-levels-title{font-size:7px;color:#9aa4b2;font-weight:800;letter-spacing:.7px;text-align:center;margin-bottom:5px}.gai-level-grid{display:grid;grid-template-columns:1fr;gap:3px}.gai-level-grid>div{background:#202532;border:1px solid #303746;border-radius:5px;padding:5px 4px;text-align:center}.gai-level-grid span,.gai-level-separate span{display:block;color:#9aa4b2;font-size:6px;font-weight:800;letter-spacing:.5px}.gai-level-grid b,.gai-level-separate b{display:block;color:#fff;font-size:8px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gai-level-separate{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:4px}.gai-level-separate>div{background:#202532;border:1px solid #303746;border-radius:5px;padding:6px 2px;text-align:center}.gai-tp1-card,.gai-tp2-card{border-color:#1f9d61!important}.gai-tp1-card b,.gai-tp2-card b{color:#39d98a!important}.gai-sl-card{border-color:#a33b35!important}.gai-sl-card b{color:#ff6b5e!important}.gai-reason{display:none;margin-top:5px;color:#b7bfcc;font-size:7px;line-height:1.35}#gai-status,#gai-direction,#gai-ohlc,#gai-levels,#gai-reason{display:none!important}`;
  document.documentElement.append(st,ui);
  ui.querySelector('#gai-scan').addEventListener('click',startScan);
  ui.querySelector('#gai-market-select').addEventListener('change',e=>setMarket(e.target.value));
  ui.querySelector('#gai-symbol').addEventListener('change',e=>setSymbol(e.target.value));
  updateSymbolSelector();
  ui.querySelector('#gai-tf').addEventListener('change',async e=>{if(scan)return;currentInterval=e.target.value;updateMarket();try{await loadHistory(currentInterval);connectWS();}catch(x){setStatus('Data retry: '+x.message);}});
  enableResize();enableMove();restoreUIState();updateMarket();
}

function resizeUI(dir){if(!ui)return;const sizes=['gai-small','gai-medium','gai-large'];let i=sizes.findIndex(x=>ui.classList.contains(x));if(i<0)i=1;i=Math.max(0,Math.min(2,i+dir));ui.classList.remove(...sizes);ui.classList.add(sizes[i]);chrome.storage.local.set({gaiSize:sizes[i]});}
function restoreUIState(){chrome.storage.local.get({gaiSize:'gai-small',gaiPos:null,gaiRect:null},d=>{if(!ui)return;ui.classList.add(d.gaiSize||'gai-small');if(d.gaiRect){ui.style.width=d.gaiRect.width+'px';ui.style.height=d.gaiRect.height+'px';}if(d.gaiPos){ui.style.left=d.gaiPos.left+'px';ui.style.top=d.gaiPos.top+'px';ui.style.right='auto';}});}
function enableResize(){const h=ui.querySelector('#gai-resize');let resizing=false,startX=0,startY=0,startW=0,startH=0;h.addEventListener('pointerdown',e=>{resizing=true;const r=ui.getBoundingClientRect();startX=e.clientX;startY=e.clientY;startW=r.width;startH=r.height;h.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();});h.addEventListener('pointermove',e=>{if(!resizing||!ui)return;const maxW=Math.min(320,innerWidth*0.9),maxH=Math.min(innerHeight*0.8,Math.max(180,innerHeight-20));const w=Math.max(120,Math.min(maxW,startW+(e.clientX-startX)));const ht=Math.max(180,Math.min(maxH,startH+(e.clientY-startY)));ui.style.width=w+'px';ui.style.height=ht+'px';});const stop=()=>{if(!resizing||!ui)return;resizing=false;chrome.storage.local.set({gaiRect:{width:ui.getBoundingClientRect().width,height:ui.getBoundingClientRect().height}});};h.addEventListener('pointerup',stop);h.addEventListener('pointercancel',stop);}
function enableMove(){const h=ui.querySelector('#gai-move');if(!h)return;let moving=false,startX=0,startY=0,startL=0,startT=0;h.addEventListener('pointerdown',e=>{moving=true;const r=ui.getBoundingClientRect();startX=e.clientX;startY=e.clientY;startL=r.left;startT=r.top;ui.style.right='auto';h.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();});h.addEventListener('pointermove',e=>{if(!moving||!ui)return;const maxL=Math.max(0,innerWidth-ui.offsetWidth);const maxT=Math.max(0,innerHeight-ui.offsetHeight);const l=Math.max(0,Math.min(maxL,startL+(e.clientX-startX)));const t=Math.max(0,Math.min(maxT,startT+(e.clientY-startY)));ui.style.left=l+'px';ui.style.top=t+'px';});const stop=()=>{if(!moving||!ui)return;moving=false;const r=ui.getBoundingClientRect();chrome.storage.local.set({gaiPos:{left:r.left,top:r.top}});};h.addEventListener('pointerup',stop);h.addEventListener('pointercancel',stop);}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{if(msg.action==='analyze'){startScan().then(r=>sendResponse({ok:true,...(r||{})})).catch(e=>sendResponse({ok:false,error:e.message}));return true;}});
setTimeout(async()=>{bindChartTimeframeClicks();buildUI();await initSymbols();const detectedSymbol=detectBinanceSymbol();if(detectedSymbol && detectedSymbol!==SYMBOL){await setSymbol(detectedSymbol);}const detected=detectBinanceInterval();if(detected)currentInterval=detected;updateMarket();try{await loadHistory(currentInterval);connectWS();}catch{setStatus(`Ready · ${label(currentInterval)} · press TRACE`);}setInterval(()=>{if(!scan){const ds=detectBinanceSymbol();if(ds && ds!==SYMBOL){setSymbol(ds).catch(()=>{});}syncChartInterval();refreshLiveOnce();}},1500);},1200);
