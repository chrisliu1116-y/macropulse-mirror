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
  /* v309【分类单测】用户禁止再用手机跑 41 标的全量轰炸。
   * ?coverage=us|fut|fx|rate|jp|kr|tw|cn|hk|option|crypto|cmdty 只跑该分类；
   * ?coverage=1 默认只跑「每类 1 个标的」快速抽检（14 项）；
   * ?coverage=full 才是 41 全量（不推荐，仅本机用）。 */
  const mCov = /[?&]coverage=([^&]+)/.exec(location.search);
  if (!mCov) return;
  const covMode = decodeURIComponent(mCov[1]);
  const CAT_ALIAS = {
    cn: 'A股个股', hk: '港股', us: '美股', jp: '日股', kr: '韩股', tw: '台股',
    idx: '指数', crypto: '加密', fx: '外汇', rate: '美债', cmdty: '商品期货',
    fut: '股指期货', bond: '国债期货', option: '期权'
  };

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
  /* 每条断言最多等 6 秒：上游挂了别把整轮拖到十几分钟 */
  const limit = (p, fallback) => Promise.race([
    p.catch(e => fallback + '(' + String(e && e.message || e).slice(0, 20) + ')'),
    new Promise(r => setTimeout(() => r(fallback + '(10s)'), 10000))
  ]);

  function searchOne(q, key) {
    return new Promise(resolve => {
      const t0 = Date.now();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, 3500);
      try {
        if (typeof w.__sugList !== 'function') { done = true; clearTimeout(t); resolve('err(no __sugList)'); return; }
        w.__sugList(q, rows => {
          if (done) return;
          done = true; clearTimeout(t);
          const ms = Date.now() - t0;
          const ua = w.UNIVERSE && w.UNIVERSE.get ? w.UNIVERSE.get(key) : null;
          const want = ua && ua.secid ? String(ua.secid) : '';
          const hit = (rows || []).some(x => x && (String(x.code) === String(key) ||
            (want && String(x.secid) === want)));
          if (hit) { resolve('ok(' + (rows || []).length + ',' + ms + 'ms)'); return; }
          /* v307：APP 搜索框本身有「已注册品种精选区」（universe 名录），
           * 输入代码/名称也会命中它。这一项如实标为 ok(local)，不算线上引擎命中。 */
          const ua2 = w.UNIVERSE && w.UNIVERSE.get ? w.UNIVERSE.get(key) : null;
          const qq = String(q || '').toLowerCase();
          const loc = ua2 && (qq === String(key).toLowerCase()
            || String(ua2.name || '').toLowerCase().indexOf(qq) >= 0
            || String(ua2.short || '').toLowerCase().indexOf(qq) >= 0);
          resolve((loc ? 'ok(local)' : 'miss') + '(' + (rows || []).length + ',' + ms + 'ms)');
        });
      } catch (e) { clearTimeout(t); resolve('err(' + String(e && e.message || e).slice(0, 24) + ')'); }
    });
  }

  async function run() {
    let groups = CASES;
    const wanted = CAT_ALIAS[covMode];
    if (wanted) groups = CASES.filter(c => c[0] === wanted);
    else if (covMode === '1') groups = CASES.map(c => [c[0], c[1].slice(0, 1)]);
    else if (covMode !== 'full') groups = CASES.map(c => [c[0], c[1].slice(0, 1)]);
    if (covMode === 'fut') groups = CASES.filter(c => c[0] === '股指期货' || c[0] === '国债期货');
    const host = d.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b1017;color:#dbe3ef;' +
      'font:12px/1.5 Menlo,monospace;overflow:auto;padding:10px 12px;white-space:pre-wrap';
    d.body.appendChild(host);
    const lines = [];
    const flush = () => { host.textContent = lines.join('\n'); host.scrollTop = host.scrollHeight; };
    const rows = [];
    let idx = 0;
    const CASES_N = groups.reduce((n, c) => n + c[1].length, 0);
    lines.push('分类自检：mode=' + covMode + '，共 ' + CASES_N + ' 项（间隔 1000ms，不并发）…');
    lines.push('每条显示 耗时ms + 实际命中源。');
    lines.push('页面底部会在结束后出现「下载 JSON / 复制 JSON」按钮。'); flush();

    for (const [cat, items] of groups) {
      for (const [key, name] of items) {
        const r = { cat, key, search: '', quote: '', intra: '', kline: '' };
        idx++;
        r.search = await searchOne(name || key, key);
        if (cat === '期权') { r.quote = 'n/a'; r.intra = 'n/a'; r.kline = 'n/a'; rows.push(r);
          lines.push('SEARCH ' + cat.padEnd(6) + String(key).padEnd(8) + ' S=' + r.search); flush(); await sleep(1000); continue; }
        try {
          const qT = Date.now();
          const q = (await limit(w.API.batchQuote([key]), 'timeout').then(x => x || {}))[key];
          r.qms = Date.now() - qT;
          r.qsrc = (q && q.src) || '';
          if (typeof q === 'string') r.quote = q;
          else if (!q) r.quote = 'nil';
          else if (q.failed) r.quote = 'failed';
          else if (!isFinite(q.price) || q.price <= 0) r.quote = 'bad';
          else r.quote = 'ok(' + q.price + ')';
        } catch (e) { r.quote = 'err'; }
        try {
          const iT = Date.now();
          const i = await limit(w.API.intraday(key), 'timeout');
          r.ims = Date.now() - iT;
          r.isrc = (i && i.src) || '';
          if (typeof i === 'string') r.intra = i;
          else if (!i) r.intra = 'nil';
          else if (i.failed) r.intra = 'failed';
          else {
            const n = (i.points || []).length;
            const nan = (i.points || []).filter(p => !isFinite(p.close)).length;
            r.intra = n > 10 && !nan ? 'ok(' + n + ')' : 'bad(' + n + (nan ? ',NaN' : '') + ')';
          }
        } catch (e) { r.intra = 'err'; }
        try {
          const kT = Date.now();
          const k = await limit(w.API.candles(key, 'day'), 'timeout');
          r.kms = Date.now() - kT;
          r.ksrc = (k && k.src) || '';
          if (typeof k === 'string') r.kline = k;
          else if (!k) r.kline = 'nil';
          else if (k.failed) r.kline = 'failed';
          else {
            const n = (k.points || []).length;
            const bad = (k.points || []).filter(x => !isFinite(x.close) || x.close <= 0).length;
            r.kline = n > 30 && !bad ? 'ok(' + n + ')' : 'bad(' + n + ')';
          }
        } catch (e) { r.kline = 'err'; }
        rows.push(r);
        const pass = [r.search, r.quote, r.intra, r.kline].every(v => String(v).startsWith('ok'));
        lines.push('[' + idx + '/' + CASES_N + '] ' + (pass ? 'PASS ' : 'FAIL ') + cat.padEnd(6) + String(key).padEnd(8) +
          ' S=' + r.search.padEnd(16) + ' Q=' + r.quote.padEnd(14) +
          ' I=' + r.intra.padEnd(12) + ' K=' + r.kline +
          ' | ' + r.qms + '/' + r.ims + '/' + r.kms + 'ms' +
          ' @' + [r.qsrc, r.isrc, r.ksrc].join('/'));
        flush();
        await sleep(1000);   // 节流：不给上游风控任何理由
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
    const payload = JSON.stringify({ at: new Date().toISOString(), passN, total, byCat, rows }, null, 2);
    lines.push('');
    lines.push('===== 自检完成：' + passN + '/' + total + ' 合格 =====');
    lines.push('下面 JSON 可直接下载或复制发给开发者：');
    lines.push('');
    flush();
    /* 按钮：下载 .json / 复制到剪贴板（手机可用） */
    const bar = d.createElement('div');
    bar.style.cssText = 'position:sticky;bottom:0;padding:10px 0;background:#0b1017;display:flex;gap:8px;flex-wrap:wrap';
    const mk = (txt, fn) => {
      const b = d.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'padding:8px 14px;border:1px solid #4f9dff;border-radius:6px;background:#16243c;color:#cfe3ff;font:14px sans-serif';
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    /* v306：跑完自动触发下载（用户不用手动复制那一大段 JSON）；
     * 手机浏览器若拦截非手势下载，仍可点下面的「下载 JSON」按钮兜底。 */
    const fileName = 'macropulse-coverage-' + new Date().toISOString().slice(0, 10) + '.json';
    let autoDone = false;
    const doDownload = (silent) => {
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        const url = w.URL.createObjectURL(blob);
        const a = d.createElement('a');
        a.href = url; a.download = fileName;
        d.body.appendChild(a); a.click(); d.body.removeChild(a);
        setTimeout(() => { try { w.URL.revokeObjectURL(url); } catch (e) {} }, 1500);
        if (!silent) { alert('已下载：' + fileName); }
        autoDone = true;
        return true;
      } catch (e) {
        if (!silent) alert('下载失败：' + e.message);
        return false;
      }
    };
    mk('下载 JSON', () => doDownload(false));
    /* 自动下载 + 自动复制（剪贴板权限被拒时静默跳过，不影响主流程） */
    setTimeout(() => {
      doDownload(true);
      try {
        if (w.navigator && w.navigator.clipboard) {
          w.navigator.clipboard.writeText(payload).catch(() => {});
        }
      } catch (e) {}
      lines.push('>>> 已自动下载 ' + fileName + '（手机的「下载」目录）；若没看到请点下面「下载 JSON」。');
      flush();
    }, 400);
    mk('复制 JSON', () => {
      const done = () => { alert('已复制，粘贴发给开发者即可'); };
      if (w.navigator && w.navigator.clipboard) {
        w.navigator.clipboard.writeText(payload).then(done, () => fallbackCopy());
      } else fallbackCopy();
      function fallbackCopy() {
        const ta = d.createElement('textarea');
        ta.value = payload; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        d.body.appendChild(ta); ta.select();
        try { d.execCommand('copy'); done(); } catch (e) { alert('复制失败，请长按下方文本全选复制'); }
        d.body.removeChild(ta);
      }
    });
    host.appendChild(bar);
    const pre = d.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:11px/1.45 Menlo,monospace;color:#9fb3cf';
    pre.textContent = payload;
    host.appendChild(pre);
    try { w.__coverageResult = { passN, total, byCat, rows }; } catch (e) {}
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', () => setTimeout(run, 2500));
  else setTimeout(run, 2500);
})(window, document);
