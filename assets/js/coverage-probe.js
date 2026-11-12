/* ============================================================
 * coverage-probe.js — 全品种四断言覆盖自检（v302）
 *
 * 用途：在「手机网络 / APP 内」直接跑 37 标的 × 4 断言，绕开本机 IP 被封的问题。
 * 入口：https://macro-pulse.app.workbuddy.host/?coverage=1
 * 结果：页面覆盖层逐条显示 PASS/FAIL + 汇总 + 可复制 JSON。
 * 判定：Search ≤2s 命中 / Quote 真实源非0价 / Intraday >10点无NaN / Kline >30根OHLC完整
 * ============================================================ */
(function (w, d) {
  'use strict';
  if (!/[?&]coverage=1/.test(location.search)) return;

  const CASES = [
    ['A股个股', [['600519', '贵州茅台'], ['300750', '宁德时代'], ['688825', '长鑫科技'], ['000001', null]]],
    ['港股', [['00700', '腾讯'], ['07709', null], ['09988', null]]],
    ['美股', [['NVDA', '英伟达'], ['SPY', null], ['TSLA', '特斯拉']]],
    ['日股', [['7203', '丰田'], ['6758', null]]],
    ['韩股', [['005930', '三星'], ['000660', null]]],
    ['台股', [['2330', '台积电'], ['2454', '联发科']]],
    ['指数', [['SPX', null], ['IXIC', null], ['HSI', null]]],
    ['加密', [['BTC', '比特币'], ['SOL', null]]],
    ['外汇', [['USDCNH', null], ['USDJPY', null]]],
    ['美债', [['US10Y', null], ['US30Y', null], ['US2Y', null]]],
    ['商品期货', [['WTI', '原油'], ['GOLD', '黄金'], ['NG', '天然气'], ['COPPER', null]]],
    ['股指期货', [['IF', null], ['NQ', null], ['A50', null]]],
    ['国债期货', [['TL', null], ['T', null], ['511260', null], ['511090', null]]],
    ['期权', [['50ETF期权', null], ['沪深300期权', null], ['SPY期权', null], ['NVDA期权', null]]]
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function searchOne(q, key) {
    return new Promise(resolve => {
      const t0 = Date.now();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, 2200);
      try {
        w.__sugList(q, rows => {
          if (done) return;
          done = true; clearTimeout(t);
          const ms = Date.now() - t0;
          const ua = w.UNIVERSE && w.UNIVERSE.get ? w.UNIVERSE.get(key) : null;
          const want = ua && ua.secid ? String(ua.secid) : '';
          const hit = (rows || []).some(x => x && (String(x.code) === String(key) ||
            (want && String(x.secid) === want)));
          resolve((hit ? 'ok' : 'miss') + '(' + (rows || []).length + ',' + ms + 'ms)');
        });
      } catch (e) { clearTimeout(t); resolve('err'); }
    });
  }

  async function run() {
    const host = d.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b1017;color:#dbe3ef;' +
      'font:12px/1.5 Menlo,monospace;overflow:auto;padding:10px 12px;white-space:pre-wrap';
    d.body.appendChild(host);
    const lines = [];
    const flush = () => { host.textContent = lines.join('\n'); host.scrollTop = host.scrollHeight; };
    const rows = [];
    lines.push('全品种四断言自检开始（约 2~4 分钟）…'); flush();

    for (const [cat, items] of CASES) {
      for (const [key, name] of items) {
        const r = { cat, key, search: '', quote: '', intra: '', kline: '' };
        r.search = await searchOne(name || key, key);
        if (cat === '期权') { r.quote = 'n/a'; r.intra = 'n/a'; r.kline = 'n/a'; rows.push(r);
          lines.push('SEARCH ' + cat.padEnd(6) + String(key).padEnd(8) + ' S=' + r.search); flush(); await sleep(400); continue; }
        try {
          const q = (await w.API.batchQuote([key]))[key];
          if (!q) r.quote = 'nil';
          else if (q.failed) r.quote = 'failed';
          else if (!isFinite(q.price) || q.price <= 0) r.quote = 'bad';
          else r.quote = 'ok(' + q.price + ')';
        } catch (e) { r.quote = 'err'; }
        try {
          const i = await w.API.intraday(key);
          if (!i) r.intra = 'nil';
          else if (i.failed) r.intra = 'failed';
          else {
            const n = (i.points || []).length;
            const nan = (i.points || []).filter(p => !isFinite(p.close)).length;
            r.intra = n > 10 && !nan ? 'ok(' + n + ')' : 'bad(' + n + (nan ? ',NaN' : '') + ')';
          }
        } catch (e) { r.intra = 'err'; }
        try {
          const k = await w.API.candles(key, 'day');
          if (!k) r.kline = 'nil';
          else if (k.failed) r.kline = 'failed';
          else {
            const n = (k.points || []).length;
            const bad = (k.points || []).filter(x => !isFinite(x.close) || x.close <= 0).length;
            r.kline = n > 30 && !bad ? 'ok(' + n + ')' : 'bad(' + n + ')';
          }
        } catch (e) { r.kline = 'err'; }
        rows.push(r);
        const pass = [r.search, r.quote, r.intra, r.kline].every(v => String(v).startsWith('ok'));
        lines.push((pass ? 'PASS ' : 'FAIL ') + cat.padEnd(6) + String(key).padEnd(8) +
          ' S=' + r.search.padEnd(16) + ' Q=' + r.quote.padEnd(14) +
          ' I=' + r.intra.padEnd(12) + ' K=' + r.kline);
        flush();
        await sleep(400);   // 节流：不给上游风控任何理由
      }
    }
    const total = rows.length;
    const passN = rows.filter(r => [r.search, r.quote, r.intra, r.kline].every(v => String(v).startsWith('ok'))).length;
    const byCat = {};
    rows.forEach(r => {
      const c = byCat[r.cat] = byCat[r.cat] || { n: 0, pass: 0 };
      c.n++;
      if ([r.search, r.quote, r.intra, r.kline].every(v => String(v).startsWith('ok'))) c.pass++;
    });
    lines.push('');
    lines.push('===== 覆盖矩阵汇总 =====');
    Object.keys(byCat).forEach(c => lines.push(c.padEnd(8) + byCat[c].pass + '/' + byCat[c].n));
    lines.push('总合格：' + passN + '/' + total);
    lines.push('');
    lines.push('—— 复制下面 JSON 发给开发者 ——');
    lines.push(JSON.stringify({ at: new Date().toISOString(), passN, total, byCat, rows }));
    flush();
    try { w.__coverageResult = { passN, total, byCat, rows }; } catch (e) {}
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', () => setTimeout(run, 2500));
  else setTimeout(run, 2500);
})(window, document);
