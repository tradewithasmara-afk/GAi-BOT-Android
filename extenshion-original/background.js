// GAi BOT — Binance multi-coin public market-data bridge. Manual signals only.
const APIS=[
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];
async function apiGet(path){
  let lastErr='market data unavailable';
  for(const base of APIS){
    try{
      const r=await fetch(base+path,{cache:'no-store'});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j=await r.json();
      if(Array.isArray(j)) return j;
      throw new Error(j?.msg||'Invalid market data');
    }catch(e){lastErr=e?.message||lastErr;}
  }
  throw new Error(lastErr);
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  const market=String(msg.market||'spot').toLowerCase()==='futures'?'futures':'spot';
  const apiGetMarket=async(path)=>{
    if(market==='futures'){
      const bases=['https://fapi.binance.com','https://fapi.binance.com'];
      let lastErr='futures market data unavailable';
      for(const base of bases){try{const r=await fetch(base+path,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(Array.isArray(j)||j?.symbols)return j;throw new Error(j?.msg||'Invalid futures data');}catch(e){lastErr=e?.message||lastErr;}}
      throw new Error(lastErr);
    }
    return apiGet(path);
  };
  if(msg.action==='get_symbols'){
    const path=market==='futures'?'/fapi/v1/exchangeInfo':'/api/v3/exchangeInfo';
    apiGetMarket(path).then(j=>{
      const data=(j.symbols||[]).filter(x=>x.status==='TRADING' && x.quoteAsset==='USDT' && (market==='spot' || x.contractType==='PERPETUAL'))
        .map(x=>({symbol:x.symbol,baseAsset:x.baseAsset,quoteAsset:x.quoteAsset,market})).sort((a,b)=>a.baseAsset.localeCompare(b.baseAsset));
      sendResponse({action:'symbols_response',requestId:msg.requestId,data});
    }).catch(e=>sendResponse({action:'symbols_response',requestId:msg.requestId,error:e.message}));
    return true;
  }
  if(msg.action==='get_klines'||msg.action==='get_live_kline'){
    const interval=String(msg.interval||'1m');
    const limit=Math.max(1,Math.min(250,Number(msg.limit)||250));
    const symbol=String(msg.symbol||'BTCUSDT').toUpperCase();
    const path=market==='futures'
      ? `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
      : `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    apiGetMarket(path).then(data=>sendResponse({action:'klines_response',requestId:msg.requestId,data})).catch(e=>sendResponse({action:'klines_response',requestId:msg.requestId,error:e.message}));
    return true;
  }
  if(msg.action==='signal_update'){
    chrome.storage.local.set({latestSignal:msg.signal,latestCandle:msg.candle||null});
    chrome.runtime.sendMessage(msg).catch(()=>{});
  }
  if(msg.action==='binance_status'||msg.action==='signal_error') chrome.runtime.sendMessage(msg).catch(()=>{});
});
