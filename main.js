/**** Crypto → RUB: Coinbase → Kraken → Bitfinex + USD/RUB ЦБ РФ ****/
/* Таблица: https://docs.google.com/spreadsheets/d/ВАШАТАБЛИЦА */

const SPREADSHEET_ID = 'ВАШАТАБЛИЦА'; // твой ID
const SHEET_NAME     = 'Crypto';   // лист куда пишем
const DECIMALS       = 2;          // округление цены в ₽; null = без
const CACHE_TTL_SEC  = 60;         // кэш цен на 60 сек (ScriptCache)

/* Алиасы → базовый символ */
const ALIASES = {
  btc:'BTC', xbt:'BTC', bitcoin:'BTC',
  eth:'ETH', ether:'ETH', ethereum:'ETH',
  sol:'SOL', solana:'SOL',
  bnb:'BNB', xrp:'XRP', doge:'DOGE',
  ton:'TON', toncoin:'TON',
  trx:'TRX', ada:'ADA', dot:'DOT',
  usdt:'USDT', usdc:'USDC'
};

/* ===================== Главная функция (вешай на триггер) ===================== */
function CRYPTO_UPDATE_RUB() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ensureSheet_(ss, SHEET_NAME);

  // читаем ввод пользователя
  const inputs = readIds_(sh);               // A2:A
  const bases  = inputs.map(normalizeBase_); // BTC, ETH, SOL...

  const uniqueBases = [...new Set(bases.filter(Boolean))];
  if (uniqueBases.length === 0) {
    sh.getRange('A2:A5').setValues([['btc'],['eth'],['sol'],['usdt']]);
    SpreadsheetApp.flush();
    return CRYPTO_UPDATE_RUB();
  }

  // курс USD/RUB по ЦБ
  const usdRub = getUSDRUB_CBR_();

  // прошлые ₽, чтобы не затирать пустотой при временных сбоях
  const prevRub = readColumn_(sh, 2, 4, Math.max(inputs.length, 1)); // D колонка

  // тянем USD-цены по монетам, кроме стейблов
  const needUsd = uniqueBases.filter(b => b !== 'USDT' && b !== 'USDC');
  const usdMap = fetchUSDPricesMulti_(needUsd); // Map base -> {price, source}

  const now = new Date();
  const out = []; // [input, base, source, price_rub, updated_at, status]

  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    const base = bases[i];
    let rubValue = '';
    let status = 'OK';
    let source = '';

    if (!base) {
      status = 'BAD_ALIAS';
    } else if (base === 'USDT' || base === 'USDC') {
      rubValue = usdRub;
      source = 'CBR';
      status = 'OK_STABLECOIN';
    } else {
      const rec = usdMap.get(base);
      if (rec && typeof rec.price === 'number' && isFinite(rec.price)) {
        rubValue = rec.price * usdRub;
        source = rec.source + '+CBR';
      } else {
        // нет цены ни у одного провайдера — оставим предыдущее значение
        const prev = prevRub[i];
        rubValue = prev === '' ? '' : Number(prev);
        source = 'STALE';
        status = 'STALE_OR_MISSING';
      }
    }

    if (rubValue !== '' && DECIMALS != null) rubValue = Number(Number(rubValue).toFixed(DECIMALS));
    out.push([raw || '', base || '', source, rubValue, now, status]);
  }

  writeTable_(sh, out);
}

/* ===================== Получение USD-цены с fallback ===================== */
// На каждую монету пытаемся: Coinbase → Kraken → Bitfinex.
// Есть кэш на базовый символ, чтобы не долбить API.
function fetchUSDPricesMulti_(bases) {
  const out = new Map();
  if (!bases.length) return out;

  const cache = CacheService.getScriptCache();
  const need = [];

  // проверить кэш построчно
  for (const b of bases) {
    const k = 'usd|' + b;
    const c = cache.get(k);
    if (c) {
      const rec = JSON.parse(c); // {price, source}
      out.set(b, rec);
    } else {
      need.push(b);
    }
  }

  // для тех, кого нет в кэше — вытягиваем по одному с паузой
  for (const b of need) {
    let price = null;
    let source = '';

    // 1) Coinbase
    price = getUSDPriceCoinbase_(b);
    if (isFinite(price)) { source = 'Coinbase'; putCache_(cache, b, price, source); out.set(b, {price, source}); Utilities.sleep(80); continue; }

    // 2) Kraken
    price = getUSDPriceKraken_(b);
    if (isFinite(price)) { source = 'Kraken'; putCache_(cache, b, price, source); out.set(b, {price, source}); Utilities.sleep(80); continue; }

    // 3) Bitfinex
    price = getUSDPriceBitfinex_(b);
    if (isFinite(price)) { source = 'Bitfinex'; putCache_(cache, b, price, source); out.set(b, {price, source}); Utilities.sleep(80); continue; }

    // не нашли
    out.set(b, null);
    Utilities.sleep(50);
  }

  return out;
}

function putCache_(cache, base, price, source) {
  cache.put('usd|' + base, JSON.stringify({price, source}), CACHE_TTL_SEC);
}

/* ----- Coinbase: /v2/prices/{BASE}-USD/spot ----- */
function getUSDPriceCoinbase_(base) {
  const url = 'https://api.coinbase.com/v2/prices/' + encodeURIComponent(base + '-USD') + '/spot';
  try {
    const resp = UrlFetchApp.fetch(url, { method:'get', muteHttpExceptions:true, headers:{accept:'application/json','User-Agent':'gsheets-crypto'} });
    if (resp.getResponseCode() !== 200) return null;
    const json = JSON.parse(resp.getContentText());
    const amt = Number(json?.data?.amount);
    return isFinite(amt) ? amt : null;
  } catch (_) { return null; }
}

/* ----- Kraken: /0/public/Ticker?pair=XXXXXX ----- */
function getUSDPriceKraken_(base) {
  // на Kraken BTC = XBT
  const b = (base === 'BTC') ? 'XBT' : base;
  const url = 'https://api.kraken.com/0/public/Ticker?pair=' + encodeURIComponent(b + 'USD');
  try {
    const resp = UrlFetchApp.fetch(url, { method:'get', muteHttpExceptions:true, headers:{accept:'application/json'} });
    if (resp.getResponseCode() !== 200) return null;
    const json = JSON.parse(resp.getContentText());
    const res = json?.result;
    const key = res && Object.keys(res)[0];
    const last = key ? Number(res[key]?.c?.[0]) : NaN; // c[0] — last trade price
    return isFinite(last) ? last : null;
  } catch (_) { return null; }
}

/* ----- Bitfinex: /v2/ticker/t{BASE}USD ----- */
function getUSDPriceBitfinex_(base) {
  const url = 'https://api-pub.bitfinex.com/v2/ticker/' + encodeURIComponent('t' + base + 'USD');
  try {
    const resp = UrlFetchApp.fetch(url, { method:'get', muteHttpExceptions:true, headers:{accept:'application/json'} });
    if (resp.getResponseCode() !== 200) return null;
    const arr = JSON.parse(resp.getContentText());
    // массив: [BID, ..., LAST_PRICE=idx6, ...]
    const last = Array.isArray(arr) ? Number(arr[6]) : NaN;
    return isFinite(last) ? last : null;
  } catch (_) { return null; }
}

/* ===================== Курс USD/RUB (ЦБ РФ) ===================== */
function getUSDRUB_CBR_() {
  const url = 'https://www.cbr.ru/scripts/XML_daily.asp';
  const resp = UrlFetchApp.fetch(url, { method:'get', muteHttpExceptions:true, headers:{accept:'application/xml,text/xml'} });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) throw new Error('CBR ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0,200));
  const doc = XmlService.parse(resp.getContentText());
  const root = doc.getRootElement(); // ValCurs
  const items = root.getChildren('Valute');
  for (const v of items) {
    const ch = v.getChildText('CharCode');
    if (String(ch).toUpperCase() === 'USD') {
      const nominal = Number(v.getChildText('Nominal') || '1');
      const valueStr = String(v.getChildText('Value') || '0').replace(',', '.');
      const value = Number(valueStr);
      if (!isFinite(value) || !isFinite(nominal) || nominal === 0) break;
      return value / nominal;
    }
  }
  throw new Error('CBR: USD not found');
}

/* ===================== Табличные утилиты ===================== */
function ensureSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,6).setValues([['id_or_alias','resolved_base','source','price_rub','updated_at','status']]);
    sh.setFrozenRows(1);
    sh.getRange('A1:F1').setFontWeight('bold');
    sh.autoResizeColumns(1, 6);
    sh.getRange('A2:A5').setValues([['btc'],['eth'],['sol'],['usdt']]);
  } else {
    const h = sh.getRange(1,1,1,6).getValues()[0].join('|');
    if (h.indexOf('price_rub') === -1) {
      sh.getRange(1,1,1,6).setValues([['id_or_alias','resolved_base','source','price_rub','updated_at','status']]);
    }
  }
  return sh;
}

function readIds_(sh) {
  const values = sh.getRange(2,1,Math.max(1000, sh.getMaxRows()-1),1).getValues().flat();
  let end = values.length;
  while (end > 0 && String(values[end-1]||'').trim() === '') end--;
  return values.slice(0,end).map(s => String(s||'').trim()).filter(Boolean);
}

function readColumn_(sh, row, col, n) {
  const vals = sh.getRange(row, col, n, 1).getValues().flat();
  return vals.map(v => (v === '' || v == null) ? '' : Number(v));
}

function writeTable_(sh, rows) {
  const f = sh.getFilter();
  if (f) f.remove();

  const n = rows.length;
  if (n === 0) { sh.getRange('D2:D').clearContent(); return; }

  sh.getRange(2,1,n,rows[0].length).setValues(rows);

  // подчистим хвост
  const last = sh.getLastRow();
  const targetLast = 1 + n;
  if (last > targetLast) sh.getRange(targetLast+1, 1, last - targetLast, 6).clearContent();

  // форматы
  sh.getRange(2,4,n,1).setNumberFormat('#,##0.00 [$₽-ru-RU]');
  sh.getRange(2,5,n,1).setNumberFormat('yyyy-mm-dd HH:mm:ss');

  // новый фильтр
  sh.getRange(1,1,1+n,6).createFilter();
  sh.autoResizeColumns(1, 6);
}

/* ===================== Нормализация ввода ===================== */
// "btc", "BTC/USDT", "btc-usdt", "BTCUSDT" → "BTC"
function normalizeBase_(s) {
  if (!s) return '';
  let k = String(s).trim().toUpperCase();
  k = k.replace(/\s+/g, '');
  k = k.replace(/[-/]/g, ''); // BTC-USDT → BTCUSDT
  if (k.endsWith('USDT')) k = k.slice(0, -4);
  if (k.endsWith('USD'))  k = k.slice(0, -3);
  const low = k.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  if (/^[A-Z0-9]{2,10}$/.test(k)) return k;
  return '';
}
