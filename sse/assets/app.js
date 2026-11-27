(function () {
  'use strict';

  /* ============ 状态（单一真源） ============
   * S.axis  当前主轴日期数组（对比关闭=breadth 全A交易日，开启=上证日K交易日）
   * S.insum 与 axis 对齐的指标数组（total/daycnt/willrm/newadd/sig）
   * S.from/S.to 可见区间（axis 索引，float，拖动/缩放用）
   * 两窗共享同一套 from/to —— 绝不给两个 canvas 各自绑手势 */
  var S = {
    B: null, K: null,
    ALLIDX: null,          /* v491: sse.json.indices —— 全部对比指数(各带自己的起点) */
    idxKey: 'SH',          /* 当前对比指数: SH=顶层上证, 其余=indices[key] */
    bIndex: null,          /* Map: date -> breadth 索引 */
    compare: false,
    axis: null, insum: null,
    from: 0, to: 0,
    cursor: -1, cursorMode: false,
    ptrs: new Map(), pinch: null, drag: null, lpTimer: null, geo: null
  };

  /* ============ 双主题（对齐 breadth 的 THEMES，另加上证 K 线色） ============ */
  var THEMES = {
    dark: {
      grid: 'rgba(255,255,255,.055)', axis: '#4b5a70',
      red: '#ff4d4f', green: '#22c55e', warn: '#f59e0b',
      line: ['rgba(95,107,125,.60)', 'rgba(192,57,43,.62)', 'rgba(217,119,6,.62)'],
      dot: ['#a8b4c6', '#ff7d7d', '#ffc247'],
      ring: 'rgba(11,16,23,.95)',
      num: ['#ff7d7d', '#ffc247', '#38bdf8'],
      dotIce: '#38bdf8', dotHot: '#ffc247',
      /* v265：连续两日「攻击」橙之间的连线色 */
      lineHot: 'rgba(255,194,71,.92)',
      upArrow: '#ff5c5c', upEdge: 'rgba(255,255,255,.85)',
      downArrow: '#22c55e', downEdge: 'rgba(7,10,15,.75)',
      warnDot: '#f59e0b', warnEdge: '#0b1017', warnMark: '#1a1206',
      cursor: 'rgba(255,255,255,.30)',
      level100: 'rgba(139,150,168,.26)',
      last: '#ffffff',
      /* 上证 K 线（涨红跌绿，A 股口径） */
      sseUp: '#ff4d4f', sseDown: '#22c55e',
      sseLine: '#7aa2f7', sseFillTop: 'rgba(56,189,248,.20)', sseFillBot: 'rgba(56,189,248,0)'
    },
    light: {
      grid: 'rgba(15,23,42,.07)', axis: '#94a3b8',
      red: '#dc2626', green: '#16a34a', warn: '#ea8a00',
      line: ['rgba(154,166,184,.80)', 'rgba(220,38,38,.62)', 'rgba(217,119,6,.62)'],
      dot: ['#5f6b7d', '#b91c1c', '#ea8a00'],
      ring: 'rgba(255,255,255,.95)',
      num: ['#dc2626', '#ea8a00', '#0369a1'],
      dotIce: '#0369a1', dotHot: '#ea8a00',
      lineHot: 'rgba(234,138,0,.90)',
      upArrow: '#e53935', upEdge: 'rgba(127,29,29,.85)',
      downArrow: '#16a34a', downEdge: 'rgba(255,255,255,.9)',
      warnDot: '#ea8a00', warnEdge: '#ffffff', warnMark: '#ffffff',
      cursor: 'rgba(15,23,42,.28)',
      level100: 'rgba(100,116,139,.28)',
      last: '#0f172a',
      sseUp: '#dc2626', sseDown: '#16a34a',
      sseLine: '#2563eb', sseFillTop: 'rgba(37,99,235,.14)', sseFillBot: 'rgba(37,99,235,0)'
    }
  };

  /* v267：恢复 H5 原本的浅色配色（浅底配深红/深橙/深蓝），
   * 不再把深色那套亮色点线搬到浅色上。 */

  function isLight() { return document.body.classList.contains('light'); }
  function cur() { return isLight() ? THEMES.light : THEMES.dark; }

  var WK = ['日', '一', '二', '三', '四', '五', '六'];
  function wkOf(ds) {
    try {
      var t = new Date(ds + 'T00:00:00');
      return WK[t.getDay()] || '';
    } catch (e) { return ''; }
  }

  /* 折线分段：符合总数 <100 灰 / >=100 红 */
  function bandOf(v) { return v >= 100 ? 1 : 0; }
  /* v267【整数关卡】上证数轴只显示整百整数点位（2800 / 3100 / 3500），
   * 不写 3.66k，也不出现 3991 / 3881 这类带十位个位的均分杂数。
   * 任何数值都吸附到最近的 100 点关卡。 */
  function sseAxisLabel(v) { return String(Math.round(v / 100) * 100); }
  /* 生成落在 [lo,hi] 内的整百关卡刻度：步长在 100/200/500/1000… 中自适应，
   * 保证 4~6 条、且每条都是 100 的整数倍（放大到早期低点位区间也不会出杂数）。 */
  function sseAxisTicks(lo, hi) {
    var range = Math.max(1, hi - lo);
    var raw = range / 5;   /* 目标约 4~6 条关卡：近期 440 点区间 → 100 步长出 4 条 */
    var CAND = [100, 200, 500, 1000, 2000, 5000, 10000];
    var step = CAND[CAND.length - 1];
    for (var i = 0; i < CAND.length; i++) {
      if (CAND[i] >= raw) { step = CAND[i]; break; }
    }
    var first = Math.ceil(lo / step) * step;
    var out = [];
    for (var v = first; v <= hi + 0.001; v += step) out.push(v);
    if (!out.length) out.push(Math.round(((lo + hi) / 2) / step) * step);
    return out;
  }
  /* 点色分类（与家数数字判据完全一致）：0 常规 / 1 冰点蓝 / 2 攻击橙。
   * 抽成纯函数，让「点」与「连续两日攻击的连线」共用同一把尺子。 */
  /* v269【insum 纵轴整百关卡】只显示 100 / 200 / 300 / 400 …
   * 步长在 100/200/500/1000 中自适应，刻度一律 100 的整数倍。 */
  function insumAxisTicks(lo, hi) {
    var range = Math.max(1, hi - lo);
    var raw = range / 4;
    var CAND = [100, 200, 500, 1000];
    var step = CAND[CAND.length - 1];
    for (var i = 0; i < CAND.length; i++) {
      if (CAND[i] >= raw) { step = CAND[i]; break; }
    }
    var first = Math.max(step, Math.ceil(lo / step) * step);
    var out = [];
    for (var v = first; v <= hi + 0.001; v += step) out.push(v);
    return out;
  }

  /* v270【上下两窗格子数统一】给定上证窗的刻度数 need，
   * 生成 need 条等距、全整百的 insum 刻度，并把上界抬到能覆盖 mx。
   * 例：mx=1100 / need=4 → [0,400,800,1200]；mx=160 / need=3 → [0,100,200] */
  function alignedInsumTicks(mx, need) {
    if (!(need > 1)) return null;
    var st = 100;
    while ((need - 1) * st < mx) st += 100;
    var out = [];
    for (var q = 0; q < need; q++) out.push(q * st);
    return out;
  }

  function dotColorIdx(d, gi) {
    var dv = d.daycnt[gi];
    var pg = gi > 0 ? d.daycnt[gi - 1] : null;
    if (pg != null && dv <= pg * 0.5) return 1;
    if (dv >= 150) return 2;
    return 0;
  }
  /* 连续两日「攻击」橙 → 返回需要染橙的线段起点索引（相对 from）。
   * 纯函数，tools/test_render.js 直接复用同一份规则做断言。 */
  function hotSegs(d, from, cnt) {
    var out = [];
    for (var k = 0; k < cnt - 1; k++) {
      if (dotColorIdx(d, from + k) === 2 && dotColorIdx(d, from + k + 1) === 2) out.push(k);
    }
    return out;
  }

  var MIN_BARS = 15;
  var P_INSUM = { l: 30, r: 9, t: 14, b: 20 };
  var P_SSE = { l: 30, r: 9, t: 8, b: 4 };

  function $(id) { return document.getElementById(id); }

  /* ============ 纯函数（供渲染与 node 自测共用） ============ */
  /* 两窗共享同一横向坐标：P.l / P.r / iw / cnt 必须一致，xAt 才一致 */
  function xAt(k, P, iw, cnt) { return P.l + k * (iw / (cnt - 1)); }
  /* 上证渲染模式：可见点数 > 可见像素宽*0.8 时降采样为收盘折线，否则画蜡烛 */
  function sseMode(cnt, iw) { return cnt > iw * 0.8 ? 'line' : 'candle'; }
  function axisTier(spanDays) {
    if (spanDays > 730) return 'year';
    if (spanDays > 180) return 'yearmonth';
    return 'day';
  }
  function spanDays(dates, from, to) {
    var d0 = Date.parse(dates[from] + 'T00:00:00Z');
    var d1 = Date.parse(dates[to] + 'T00:00:00Z');
    return Math.max(0, (d1 - d0) / 86400000);
  }

  /* ============ 图例 ============ */
  function paintLegend() {
    var T = cur();
    $('lg').innerHTML =
      '<span><em style="background:' + T.dot[0] + '"></em>&lt;100</span>' +
      '<span><em style="background:' + T.dot[1] + '"></em>≥100</span>' +
      '<span><em style="background:' + T.dotIce + '"></em>冰点</span>' +
      '<span><em style="background:' + T.dotHot + '"></em>攻击≥150</span>' +
      '<span><em class="seg" style="background:' + T.lineHot + '"></em>连攻线</span>' +
      '<span style="color:' + T.upArrow + '">▲ 转多</span>' +
      '<span style="color:' + T.downArrow + '">▼ 转空</span>' +
      '<span style="color:' + T.warnDot + '">! 预警</span>';
  }

  /* ============ 数据加载（本地 data/breadth.json + data/sse.json） ============ */
  function loadJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* v265【数据不再永久静态】本地快照先渲染，随后静默竞速线上四源拿到
   * 更新的 breadth.json；只原地换数据、保留视口，绝不整页重载。
   * 远程全失败时静默回退本地，页面照常可用（收盘窗口每 3 分钟再查一次）。 */
  var REMOTE_B = [
    'https://raw.githubusercontent.com/chrisliu1116-y/insum-cloud/main/breadth/data/breadth.json',
    'https://cdn.jsdelivr.net/gh/chrisliu1116-y/insum-cloud@main/breadth/data/breadth.json',
    'https://chrisliu1116-y.github.io/insum-cloud/breadth/data/breadth.json'
  ];
  /* v276：上证 K 线也进云端跑批，与 breadth.json 同批成对提交。
   * 用户实测出现过「insum 新 / 上证旧」，所以 SSE 也必须竞速远端。 */
  var REMOTE_S = [
    'https://raw.githubusercontent.com/chrisliu1116-y/insum-cloud/main/breadth/data/sse.json',
    'https://cdn.jsdelivr.net/gh/chrisliu1116-y/insum-cloud@main/breadth/data/sse.json',
    'https://chrisliu1116-y.github.io/insum-cloud/breadth/data/sse.json'
  ];
  function loadRemoteS() {
    if (typeof fetch !== 'function') return Promise.reject(new Error('offline'));
    return REMOTE_S.reduce(function (p, url) {
      return p.catch(function () { return loadJSONTimeout(url, 6000); });
    }, Promise.reject(new Error('start')));
  }
  /* v278：上证标的自检 —— 线上曾出现 sse.json 实为平安银行（末收盘 11.71）却标成
   * 「上证指数」，整条 K 线画错。按点位量级拒收：宁可显示缺失，也不画错数据。 */
  function sseOK(k) {
    var c = (k && k.c) || [];
    if (!c.length) return false;
    var v = c[c.length - 1];
    return v > 50 && v < 20000;
  }

  /* v491【多指数对比】sse.json 顶层=上证(原字段,兼容),indices=额外5指数。
   * 统一入口：存 ALLIDX,按当前 idxKey 把 S.K 指向对应数据(各带自己起点),
   * buildAxis() 用 S.K.dates 当主轴 → 指标天然从该指数首日开始,无 0 假基线。 */
  function applySse(k) {
    if (!k || !k.dates || !k.dates.length) return false;
    S.SH_K = k;                                // 顶层上证本体(固定在 S 上,不随 S.K 切换丢失)
    S.ALLIDX = k.indices || null;              // 额外指数(可能为空=旧版 sse.json)
    S.K = k;                                   // 默认指向上证
    if (S.idxKey !== 'SH') {
      var x = (S.ALLIDX || {})[S.idxKey];
      if (x && x.dates && x.dates.length) S.K = x;   // 切到选中指数
      else S.idxKey = 'SH';                          // 选中指数无数据 → 回上证
    }
    /* v523：数据就绪时同步图例标题（若消息在加载前设了 idxKey，这里也要跟上） */
    try {
      var _lab = $('sseLgLabel');
      if (_lab) _lab.textContent = ((S.K && S.K.name) || '上证指数') + ' · 前复权 · 涨红跌绿';
    } catch (e0) {}
    syncIndexSelect();
    return true;
  }
  function syncIndexSelect() {
    var sel = $('cmpIndex');
    if (sel) sel.value = S.idxKey;
  }
  function applyNewSse(k) {
    if (!k || !k.dates || !k.dates.length) return false;
    if (!sseOK(k)) return false;
    /* v491：新旧比较固定用上证本体(S.SH_K)，避免选中科创后 meta 不同误判 */
    var _sh = S.SH_K || S.K;
    /* v617：同日重跑时 to 不变但 generated 更新 → 也要刷新 */
    var _sNewGen = (k.meta && k.meta.generated) || '';
    var _sOldGen = (_sh && _sh.meta && _sh.meta.generated) || '';
    var _sNewTo = (k.meta && k.meta.to) || '';
    var _sOldTo = (_sh && _sh.meta && _sh.meta.to) || '';
    if (_sNewTo < _sOldTo || (_sNewTo === _sOldTo && (!_sNewGen || _sNewGen <= _sOldGen))) return false;
    applySse(k);
    if (S.B && $('btnCompare')) $('btnCompare').disabled = false;
    renderAll();
    try { parent.postMessage({ mm_sse_state: (k.meta && k.meta.to) || '' }, '*'); } catch (e) {}
    return true;
  }
  function loadJSONTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms || 6000);
      loadJSON(url).then(function (d) { if (!done) { done = true; clearTimeout(t); resolve(d); } },
        function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }
  function remoteBreadth() {
    var t = Date.now();
    return Promise.all(REMOTE_B.map(function (u) {
      return loadJSONTimeout(u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + t)
        .then(function (d) { if (!d || !d.dates || !d.dates.length) throw new Error('empty'); return d; })
        .catch(function () { return null; });
    })).then(function (arr) {
      var best = null;
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i]; if (!d) continue;
        if (!best || d.dates[d.dates.length - 1] > best.dates[best.dates.length - 1]) best = d;
      }
      return best;
    });
  }
  function applyNewBreadth(b) {
    if (!S.B || !S.axis) return false;
    var oldLast = S.B.dates[S.B.dates.length - 1];
    var newLast = b.dates[b.dates.length - 1];
    /* v617【同日重跑自动刷新】原守门只比末日期：同一交易日补跑（15:10 vs 15:00）
     * 日期不变 → 直接 return false，用户停在页面就永远看不到新数据，必须杀 APP 重开。
     * 现在：日期变大 或 同日但 meta.generated 更新（重跑/补数据）→ 都刷新。 */
    var _newGen = (b.meta && b.meta.generated) || '';
    var _oldGen = (S.B.meta && S.B.meta.generated) || '';
    if (newLast < oldLast) return false;
    if (newLast === oldLast && (!_newGen || _newGen <= _oldGen)) return false;
    /* v292【右端跟随 · 用户核心诉求】此前只按日期保持视窗：
     * 数据更新（本地旧 8816 → 远端新 8818）后，视窗仍停在旧日期（11-10），
     * 用户必须手动往右拖才能看到最新（11-12）。
     * 现在：若更新前视窗右端就贴着旧轴末尾（用户在看最新），
     * 新数据进来后整窗右移到新末尾；若用户已拖到历史中间，按日期保持原位。 */
    var wasAtEnd = S.to >= S.axis.length - 1 - 0.5;
    var span = S.to - S.from;
    var fromDate = S.axis[Math.max(0, Math.min(S.axis.length - 1, Math.round(S.from)))];
    var toDate = S.axis[Math.max(0, Math.min(S.axis.length - 1, Math.round(S.to)))];
    S.B = b;
    S.bIndex = new Map();
    for (var i = 0; i < b.dates.length; i++) S.bIndex.set(b.dates[i], i);
    buildAxis();
    if (wasAtEnd) {
      S.to = S.axis.length - 1;
      S.from = Math.max(0, S.to - span);
    } else {
      var nf = nearestIdx(S.axis, fromDate), nt = nearestIdx(S.axis, toDate);
      S.from = nf >= 0 ? Math.min(nf, S.axis.length - 1) : 0;
      S.to = nt >= 0 ? Math.max(S.from, Math.min(nt, S.axis.length - 1)) : S.axis.length - 1;
    }
    $('upd').textContent = '全A股 · ' + updText(b);
    $('ft').textContent = footText();
    if (isFresh(b)) $('dot').classList.remove('old');
    updateCards(S.cursor >= 0 ? S.cursor : S.axis.length - 1);
    renderAll();
    postStatus();
    return true;
  }
  function startRemoteRefresh() {
    if (typeof fetch !== 'function') return;   /* jsdom/offline 静默跳过 */
    function tick() {
      remoteBreadth().then(function (b) { if (b) applyNewBreadth(b); }).catch(function () {});
      loadRemoteS().then(function (k) { applyNewSse(k); }).catch(function () {});
    }
    tick();
    var _tickN = 0;
    var timer = setInterval(function () {
      var bj = new Date(Date.now() + 8 * 3600 * 1000);
      var wd = bj.getUTCDay(), hh = bj.getUTCHours();
      /* v617：原逻辑只在 工作日15-18点 追新，但收盘后补跑/周末补数据也会落库，
       * 停在页面的用户永远等不到刷新。改为：交易窗口(工作日15-18点)3分钟一轮，
       * 其余时间10分钟一轮（低频省流量，但保证补数据能自动刷新）。 */
      var inWindow = (wd >= 1 && wd <= 5 && hh >= 15 && hh < 18);
      if (!inWindow && _tickN++ % 3 !== 0) return;
      tick();
    }, 3 * 60 * 1000);
    try { if (timer && timer.unref) timer.unref(); } catch (e) {}
  }

  /* v265：数据陈旧不再假装实时。交易日 15:00 后若仍停在旧交易日，标「待更新」。
   * 周末休市、15:00 前都不算陈旧（简化口径，不含节假日日历）。 */
  function isFresh(d) {
    var day = (d.meta && d.meta.trade_date) || d.dates[d.dates.length - 1] || '';
    var bj = new Date(Date.now() + 8 * 3600 * 1000);
    var today = bj.toISOString().slice(0, 10);
    var wd = bj.getUTCDay(), hh = bj.getUTCHours();
    if (day >= today) return true;
    if (wd === 0 || wd === 6) return true;
    return hh < 15;
  }
  function updText(d) {
    var m = d.meta || {};
    var day = m.trade_date || d.dates[d.dates.length - 1] || '';
    var g = String(m.generated || '');
    var short = g ? g.replace(/^\d{4}-/, '').slice(0, 11) : '';
    var txt = '数据 ' + day + (short ? ' · 更新 ' + short + (m.generated_tz ? ' 北京' : '')
      : '（无跑批时间）');
    if (d.meta && d.meta.stale) txt += ' · 跑批未更新，数据停留在 ' + day;
    else if (!isFresh(d)) txt += ' · 待更新';
    return txt;
  }

  /* v267【底部只一行】老版「数据日期 + 更新时间」折成两行浪费一行，
   * 数据日期已放在主站工具条状态里，这里只写更新时间 + 精简统计。 */
  function footText() {
    var m = (S.B && S.B.meta) || {};
    var g = String(m.generated || '');
    var short = g ? g.replace(/^\d{4}-/, '').slice(0, 11) : '';
    var parts = [];
    /* v268：补回老版完整口径「全部A股 X 只 · 有效 X 只 · X 个交易日」，
     * 数据日期不重复写（工具条状态已有），只保留更新时间，仍强制一行。 */
    /* v520：精简为一行可容纳（原「全部A股 X 只 · 有效 X 只 · X 个交易日 · 更新…」太长换行） */
    if (S.B) parts.push('全A ' + m.universe + '只 · ' + m.days + '日');
    parts.push(short ? '更新 ' + short : '未更新');
    /* v581【待补品种修正】旧代码写死「上证 X 待补」，但 S.K 会随对比指数切换，
     * 且只查当前选中指数一条——实测创业板 CYB 停在 11-23、上证已到 11-25 时，
     * 底部却写「上证 2026-11-23 待补」（错指品种 + 用错日期）。改为遍历全部指数：
     * 顶层 S.SH_K=上证 + S.ALLIDX=其余 5 个，逐一比末日与 breadth 交易日，
     * 列出真正落后的品种名与其自身末日。都最新时不显示任何「待补」。 */
    var bLast = S.B && S.B.dates && S.B.dates.length ? S.B.dates[S.B.dates.length - 1] : null;
    if (bLast) {
      var IDX_NAMES = {
        SH: '上证', SZ: '深证成指', SZ50: '上证50',
        HS300: '沪深300', CYB: '创业板指', KC50: '科创50'
      };
      var pending = [];
      var chk = function (key, obj) {
        if (!obj || !obj.dates || !obj.dates.length) return;
        var last = obj.dates[obj.dates.length - 1];
        if (last < bLast) pending.push((IDX_NAMES[key] || key) + ' ' + last);
      };
      chk('SH', S.SH_K);
      var all = S.ALLIDX || {};
      for (var ik in all) if (Object.prototype.hasOwnProperty.call(all, ik)) chk(ik, all[ik]);
      if (pending.length) parts.push(pending.join('/') + ' 待补');
    }
    /* v519【源名显示在底部】按用户口径，源名跟原来一样放底部那行。
     * 取当前游标所在日期对应段的源（东财段/腾讯段），游标移动时随 footer 刷新。 */
    var _i = S.cursor >= 0 ? S.cursor : (S.axis ? S.axis.length - 1 : -1);
    var _date = (S.axis && _i >= 0) ? S.axis[_i]
      : ((S.B && S.B.dates && S.B.dates[S.B.dates.length - 1]) || '');
    var _src = srcAtDate(_date);
    if (_src) parts.push('源 ' + _src);
    if (S.B && S.B.meta && S.B.meta.stale) parts.push('跑批未更新');
    else if (S.B && !isFresh(S.B)) parts.push('待更新');
    return parts.join(' · ');
  }
  /* v490【分段源显示】拼接底稿：1990~2013-12-23 东财（含北交所长历史），
   * 2013-12-24 起腾讯。日期落在哪段就标哪个源，游标移动实时跟随。
   * 优先读 meta.segments；老数据用 merge_cut 兜底；再老的纯单源退回 meta.source。
   * 对比模式下主轴是上证日K日期(S.K)，仍按同一日期阈值判段。 */
  function srcAtDate(date) {
    var m = (S.B && S.B.meta) || {};
    if (!date) return '';
    if (m.segments && m.segments.length) {
      for (var k = 0; k < m.segments.length; k++) {
        var sg = m.segments[k];
        if (date >= sg.from && date <= sg.to) {
          var s = String(sg.source || '').toLowerCase();
          if (s.indexOf('tencent') >= 0) return '腾讯';
          if (s.indexOf('eastmoney') >= 0) return '东财';
          return sg.source || '';
        }
      }
    }
    if (m.merged && m.merge_cut) return date < m.merge_cut ? '东财' : '腾讯';
    var src = String(m.source || '').toLowerCase();
    if (src.indexOf('tencent') >= 0) return '腾讯';
    if (src.indexOf('eastmoney') >= 0) return '东财';
    return '';
  }

  /* 把「日期 周X 收盘 · 源 + 新鲜度」推给主站工具条（老版 header 里那颗绿点） */
  function postStatus() {
    if (!isEmbed()) return;
    try {
      var i = S.cursor >= 0 ? S.cursor : (S.axis ? S.axis.length - 1 : -1);
      var date = (S.axis && i >= 0) ? S.axis[i]
        : ((S.B && S.B.dates[S.B.dates.length - 1]) || '');
      var last = !S.axis || i >= S.axis.length - 1;
      var wk = wkOf(date);
      /* v520：源名只在底部那行显示，顶部工具条保持「日期 周X」原样，不再重复 */
      parent.postMessage({ mm_status: {
        text: date + (wk ? ' 周' + wk : '') + (last ? ' 收盘' : ''),
        fresh: S.B ? isFresh(S.B) : true
      } }, '*');
    } catch (e) {}
  }

  /* ============ 主轴对齐（按日期 Map，不按下标硬对齐） ============ */
  function buildAxis() {
    /* v583【统一 Insum 主轴·用户口径】跑批只有一份 Insum（breadth.json），
     * 所有对比模式指数必须引用同一份、显示完全一致。旧实现把主轴设成各指数 K
     * 线日期（S.K.dates），再把 breadth 按日期塞进去——K 线缺日（沪深300/创业板
     * 缺 11-24、科创50 缺 11-23+24）就让 Insum 图少点、箭头/预警缺失、卡片 delta
     * 与上证不一致。现在主轴恒为 breadth 交易日轴（所有指数相同），K 线按日期
     * 映射到这条轴上（缺日沿用前值，只影响上窗那根 K，绝不影响 Insum）。 */
    if (!S.B || !S.B.dates || !S.B.dates.length) {
      var kd = (S.K && S.K.dates) ? S.K.dates : [];
      S.axis = kd; S.KV = S.K || null;
      S.insum = { total: [], daycnt: [], willrm: [], newadd: [], sig: [] };
      S.axisBi = [];
      return;
    }
    var dates = S.B.dates.slice();            // 统一轴 = breadth（与是否对比、选哪个指数无关）
    /* v584【按指数首日裁切前段·用户口径】同一份 Insum 所有指数共用、尾端都一样；
     * 但指数没有 K 线的年代（创业板 2010 前、科创50 2019 前）不该显示 Insum。
     * 起点 = max(breadth 首日, 当前指数 K 线首日)，从该日起同步裁切 Insum+K 线。
     * 只有对比模式且确实选了指数时裁切；上证/单独模式仍从 breadth 首日全量。 */
    var start = 0;
    if (S.compare && S.K && S.K.dates && S.K.dates.length) {
      var kFirst = S.K.dates[0];
      while (start < dates.length && dates[start] < kFirst) start++;
    }
    if (start > 0) dates = dates.slice(start);
    S.axis = dates;
    S.insum = {
      total: S.B.total.slice(start), daycnt: S.B.daycnt.slice(start),
      willrm: S.B.willrm.slice(start), newadd: S.B.newadd.slice(start),
      sig: (S.B.sig ? S.B.sig.slice(start) : S.B.total.map(function () { return 0; }).slice(start))
    };
    S.axisBi = dates.map(function (_, i) { return start + i; });   // 主轴位置 → breadth 索引

    /* K 线映射到统一轴：breadth 每个交易日 d 找指数 K 线同日那根；
     * 缺日沿用前一根 K（保持与轴一一对应，drawSse 用 S.KV[gi] 直接索引）。
     * 指数数据起点晚于 breadth 的日期（如科创50<2019）左侧无 K 线 → 用首根填充，
     * 只在极早期；用户看的最近区间不受影响。 */
    if (S.K && S.K.dates && S.K.dates.length) {
      var kMap = {}, K = S.K;
      for (var q = 0; q < K.dates.length; q++) kMap[K.dates[q]] = q;
      var last = null;
      var kv = { dates: dates.slice(), o: [], h: [], l: [], c: [] };
      for (var i2 = 0; i2 < dates.length; i2++) {
        var ki = kMap[dates[i2]];
        if (ki !== undefined && K.c[ki] > 0) last = { o: K.o[ki], h: K.h[ki], l: K.l[ki], c: K.c[ki] };
        if (!last) last = { o: K.o[0], h: K.h[0], l: K.l[0], c: K.c[0] };
        kv.o.push(last.o); kv.h.push(last.h); kv.l.push(last.l); kv.c.push(last.c);
      }
      S.KV = kv;
    } else {
      S.KV = S.K;
    }
  }

  /* v265：日期 → 主轴索引，二分找「不早于该日期」的第一根；
   * 找不到精确日期时吸附到最近交易日，而不是把视口弹回全景。 */
  function nearestIdx(axis, date) {
    if (!axis || !axis.length || !date) return -1;
    var lo = 0, hi = axis.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (axis[mid] < date) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function setRange(n) {
    var N = S.axis.length;
    if (!n || n >= N) { S.from = 0; S.to = N - 1; }
    else { S.to = N - 1; S.from = Math.max(0, N - n); }
  }

  /* ============ 顶部数值卡（跟随游标，对齐 breadth） ============ */
  function updateCards(i) {
    var d = S.insum;
    if (!d || i < 0 || i >= S.axis.length) return;
    var tot = d.total[i], day = d.daycnt[i], nw = d.newadd[i], rm = d.willrm[i];
    /* v582【对比模式"较前日"错位】指数 K 线可能缺日（沪深300/创业板缺 11-24，
     * 科创50 缺 11-23+11-24），主轴 i-1 不是 breadth 的上一交易日 → delta 算错、
     * 冰点/预警角标误判。修复：prev 直接从 breadth 源数组按 bi-1 取（breadth
     * 本身交易日连续、不缺日），不从主轴序列取。字段名映射 total/daycnt/newadd/willrm
     * 与 S.B 完全一致，直接索引即可。 */
    var BF = { total: 'total', daycnt: 'daycnt', newadd: 'newadd', willrm: 'willrm' };
    var p = function (k) {
      if (!S.B || !S.axisBi || i < 0 || i >= S.axisBi.length) return null;
      var bi = S.axisBi[i];
      if (bi == null || bi < 0) bi = -1;
      // 往前找当前位置之前最近的有效 breadth 索引（当前本身缺日时）
      if (bi < 0) {
        for (var j = i - 1; j >= 0; j--) if (S.axisBi[j] >= 0) { bi = S.axisBi[j]; break; }
      }
      if (bi <= 0) return null;
      // 关键：从 breadth 源直接取 bi-1（真正的上一交易日），绕开指数 K 线缺日
      var src = S.B[BF[k] || k];
      return (src && bi - 1 < src.length) ? src[bi - 1] : null;
    };

    $('vTotal').textContent = tot;
    $('vDay').textContent = day;
    $('vNew').textContent = nw;
    $('vRm').textContent = rm;

    function delta(el, cur, prev) {
      if (prev == null) { el.textContent = ''; return; }
      var df = cur - prev;
      el.textContent = (df > 0 ? '▲ +' : df < 0 ? '▼ ' : '— ') + Math.abs(df) + ' 较前日';
      el.className = df > 0 ? 'up' : df < 0 ? 'dn' : 'flat';
    }
    delta($('dTotal'), tot, p('total'));
    delta($('dDay'), day, p('daycnt'));
    delta($('dNew'), nw, p('newadd'));
    delta($('dRm'), rm, p('willrm'));

    var prevDay = p('daycnt');
    var half = prevDay != null && day <= prevDay * 0.5;
    var T = cur();
    $('vDay').style.color = day >= 150 ? T.num[1] : (half ? T.num[2] : T.num[0]);
    $('vDayTag').textContent = day >= 150 ? '攻击' : (half ? '冰点' : '');

    var isLast = i === S.axis.length - 1;
    $('gen').textContent = S.axis[i] + ' 周' + wkOf(S.axis[i]) + (isLast ? ' 收盘' : '');
    $('gen').style.color = isLast ? '' : T.num[2];
    postStatus();
  }

  /* ============ X 轴刻度（对齐 breadth v257 自适应三档） ============ */
  function buildAxisLabels(dates, from, to, cnt) {
    var span = spanDays(dates, from, to);
    var tier = axisTier(span);
    var marks = [];
    if (tier !== 'day') {
      var ly = '';
      for (var j = from; j <= to; j++) {
        var y = tier === 'year' ? dates[j].slice(0, 4) : dates[j].slice(0, 7);
        if (y !== ly) { marks.push({ pos: j - from, lab: y }); ly = y; }
      }
    }
    var picked = [];
    if (marks.length) {
      var n = Math.min(6, marks.length);
      for (var L = 0; L < n; L++) {
        picked.push(marks[Math.round(L * (marks.length - 1) / (n - 1))]);
      }
    } else {
      var labs = Math.min(4, cnt);
      for (var L2 = 0; L2 < labs; L2++) {
        var pos = labs === 1 ? 0 : Math.round(L2 * (cnt - 1) / (labs - 1));
        var dt = dates[from + pos];
        picked.push({ pos: pos, lab: cnt <= 40 ? (dt.slice(5) + ' ' + wkOf(dt)) : dt.slice(5) });
      }
    }
    return picked;
  }

  /* ============ insum 指标窗（完整复刻 breadth 的 draw） ============ */
  function drawInsum() {
    var cv = $('cvI'), wrap = cv.parentElement;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H || !S.axis) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var d = S.insum, dates = S.axis, N = dates.length;
    var T = cur();
    var from = Math.max(0, Math.floor(S.from));
    var to = Math.min(N - 1, Math.ceil(S.to));
    var cnt = to - from + 1;
    if (cnt < 2) return;

    var P = P_INSUM;
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var step = iw / (cnt - 1);
    var xOf = function (k) { return xAt(k, P, iw, cnt); };

    var mn = Infinity, mx = -Infinity;
    for (var j = from; j <= to; j++) {
      var v = d.total[j];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    if (mx === mn) mx = mn + 1;
    var lo0 = (mn > mx * 0.3) ? mn * 0.88 : 0;
    /* v269：上下界都对齐到整百，刻度才能落在 100/200/300… 上 */
    var lo = Math.max(0, Math.floor(lo0 / 100) * 100);
    var hi = Math.ceil((mx + Math.max((mx - lo) * 0.14, 10)) / 100) * 100;
    if (hi <= mx) hi += 100;
    var yOf = function (val) { return P.t + ih - (val - lo) / (hi - lo) * ih; };

    /* 横网格 + 左刻度 */
    g.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    var aligned = (S.gridN > 1) ? alignedInsumTicks(mx, S.gridN) : null;
    var yticks;
    if (aligned) {
      /* 对比态：上界抬到整百关卡顶，网格线数量与上证窗严格一致 */
      lo = 0; hi = aligned[aligned.length - 1];
      yticks = aligned;
    } else {
      yticks = insumAxisTicks(lo, hi);
    }
    for (var t = 0; t < yticks.length; t++) {
      var val = yticks[t];
      var y = yOf(val);
      if (y < P.t - 1 || y > P.t + ih + 1) continue;
      g.strokeStyle = T.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(P.l, Math.round(y) + .5);
      g.lineTo(W - P.r, Math.round(y) + .5);
      g.stroke();
      g.fillStyle = T.axis;
      g.fillText(String(val), P.l - 5, y);
    }

    /* 100 水位参考线 */
    if (lo < 100 && hi > 100) {
      var y100 = yOf(100);
      g.strokeStyle = T.level100;
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(P.l, y100); g.lineTo(W - P.r, y100); g.stroke();
      g.setLineDash([]);
    }

    /* 折线：逐段按起点水位着色；全量档点数远多于像素时按 stride 降采样
     * （v265 性能修复：8816 根逐段 stroke 会在拖动时明显掉帧）。 */
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = 2;
    var stride = cnt > iw * 1.5 ? Math.max(1, Math.floor(cnt / (iw * 0.8))) : 1;
    for (var k = 0; k + stride < cnt; k += stride) {
      var v0 = d.total[from + k], v1 = d.total[from + k + stride];
      g.strokeStyle = T.line[bandOf(v0)];
      g.beginPath();
      g.moveTo(xOf(k), yOf(v0));
      g.lineTo(xOf(k + stride), yOf(v1));
      g.stroke();
    }
    /* v265【连续两日攻击 → 中间线段变橙】
     * 只有「相邻两个点都是攻击橙」，连接它们的那一段才变橙：
     * A 橙 / B 灰 / C 橙 → AB、BC 都不变色；A、B 都橙 → AB 橙。
     * 橙段单独叠加绘制，不受 stride 降采样影响，全量档也看得到。 */
    g.strokeStyle = T.lineHot;
    var hs = hotSegs(d, from, cnt);
    /* 注意：循环变量绝不能叫 hi —— drawInsum 里 hi 是 Y 轴上界，
     * var 是函数作用域，覆盖后 yOf() 会把点全算到画布外（v265 事故）。 */
    for (var si = 0; si < hs.length; si++) {
      var k2 = hs[si];
      g.beginPath();
      g.moveTo(xOf(k2), yOf(d.total[from + k2]));
      g.lineTo(xOf(k2 + 1), yOf(d.total[from + k2 + 1]));
      g.stroke();
    }

    /* 每日节点：点色跟当日家数走（冰点蓝 / 攻击橙 / 其余按总数灰红） */
    var rr = 0;
    if (step >= 2.6) {
      rr = step >= 8 ? 4.5 : (step >= 4.5 ? 3.4 : 2.4);
      for (var b = 0; b < cnt; b++) {
        var gi = from + b;
        var bx = xOf(b), by = yOf(d.total[gi]);
        var ci = dotColorIdx(d, gi);
        g.fillStyle = ci === 1 ? T.dotIce
          : (ci === 2 ? T.dotHot : (d.total[gi] >= 100 ? T.dot[1] : T.dot[0]));
        g.beginPath();
        g.arc(bx, by, rr, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = T.ring;
        g.stroke();
      }
    }

    /* 箭头 / 预警：▲在点下方，▼⚠在点上方；家数数字在上方 */
    var lastIconX = -1e9;
    var iconGap = step < 2.2 ? 9 : 4;
    var big = step >= 5;
    for (var a = 0; a < cnt; a++) {
      var gi2 = from + a;
      var s2 = d.sig[gi2];
      var isRed = !!(s2 & 1), isGrn = !!(s2 & 2), isAl = !!(s2 & 4), isSup = !!(s2 & 16);
      if (!isRed && !isGrn && !isAl) continue;
      var ax = xOf(a);
      if (ax - lastIconX < iconGap) continue;
      lastIconX = ax;
      var py2 = yOf(d.total[gi2]);
      var ayDown = py2 + (big ? 13 : 11);
      if (ayDown > P.t + ih + 6) ayDown = P.t + ih + 6;
      var ay = isRed ? ayDown
        : py2 - (step >= 4 ? (big ? 25 : 22) : (big ? 14 : 12));
      if (ay < P.t + 9) ay = P.t + 9;
      var sc = big ? 1 : (step >= 3 ? 0.85 : 0.7);

      if (isRed) {
        g.fillStyle = T.upArrow;
        g.strokeStyle = T.upEdge;
        g.lineWidth = 1;
        if (isSup && step >= 3) { g.shadowColor = 'rgba(255,92,92,.95)'; g.shadowBlur = 9; }
        g.beginPath();
        g.moveTo(ax, ayDown - 7.2 * sc);
        g.lineTo(ax + 6 * sc, ayDown + 2.6 * sc);
        g.lineTo(ax - 6 * sc, ayDown + 2.6 * sc);
        g.closePath(); g.fill(); g.stroke();
        if (isSup && step >= 3) {
          g.beginPath();
          g.moveTo(ax, ayDown + 2.6 * sc);
          g.lineTo(ax + 6 * sc, ayDown + 9.6 * sc);
          g.lineTo(ax - 6 * sc, ayDown + 9.6 * sc);
          g.closePath(); g.fill(); g.stroke();
          g.shadowBlur = 0;
        }
      } else if (isGrn) {
        g.fillStyle = T.downArrow;
        g.strokeStyle = T.downEdge;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(ax, ay + 7.2 * sc);
        g.lineTo(ax + 6 * sc, ay - 2.6 * sc);
        g.lineTo(ax - 6 * sc, ay - 2.6 * sc);
        g.closePath(); g.fill(); g.stroke();
      } else if (isAl) {
        g.beginPath();
        g.arc(ax, ay, 5.4 * sc, 0, Math.PI * 2);
        g.fillStyle = T.warnDot;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = T.warnEdge;
        g.stroke();
        g.fillStyle = T.warnMark;
        g.fillRect(ax - .65, ay - 2.8 * sc, 1.3, 3.6 * sc);
        g.fillRect(ax - .65, ay + 1.7 * sc, 1.3, 1.3);
      }
    }

    /* 当日家数数字 */
    if (step >= 4) {
      g.font = '600 8.5px -apple-system,BlinkMacSystemFont,sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      var lastNumX = -1e9;
      var minGap = Math.max(9.5, step * 0.92);
      for (var m = 0; m < cnt; m++) {
        var gi3 = from + m;
        var dv = d.daycnt[gi3];
        if (!dv) continue;
        var gx = xOf(m);
        if (gx - lastNumX < minGap) continue;
        var gy = yOf(d.total[gi3]) - 8;
        if (gy < P.t + 7) gy = P.t + 7;
        var pg = gi3 > 0 ? d.daycnt[gi3 - 1] : null;
        var isHalf = pg != null && dv <= pg * 0.5;
        g.fillStyle = dv >= 150 ? T.num[1] : (isHalf ? T.num[2] : T.num[0]);
        var hw = g.measureText(String(dv)).width / 2;
        g.fillText(dv, Math.max(hw + 2, Math.min(W - 2 - hw, gx)), gy);
        lastNumX = gx;
      }
    }

    /* v265：最新点不做任何特殊标记，与其他点完全一致（同步主站 v263） */

    /* X 轴日期（只有 insum 底部画；上证 pane 不画） */
    g.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
    g.fillStyle = T.axis;
    g.textBaseline = 'top';
    var picked = buildAxisLabels(dates, from, to, cnt);
    var seen = {}, lastRight = -1e9;
    for (var _k = 0; _k < picked.length; _k++) {
      var _m = picked[_k];
      if (seen[_m.lab]) continue;
      var _x = xOf(_m.pos);
      var _tw = g.measureText(_m.lab).width;
      var _align = _m.pos <= cnt * 0.06 ? 'left' : (_m.pos >= cnt * 0.94 ? 'right' : 'center');
      var _left = _align === 'left' ? _x : (_align === 'right' ? _x - _tw : _x - _tw / 2);
      if (_left < P.l) { _align = 'left'; _left = _x; }
      var _right = _left + _tw;
      if (_right > W - P.r) { _align = 'right'; _left = _x - _tw; _right = _x; }
      /* v269：相邻标签至少留 10px，挤在一起的直接丢弃（原来会连成
       * 「2024-12025-02」这种一串） */
      if (_left < lastRight + 10) continue;
      seen[_m.lab] = 1; lastRight = _right;
      g.textAlign = _align;
      g.fillText(_m.lab, _x, P.t + ih + 5);
    }

    /* 十字游标（insum 侧） */
    if (S.cursor >= 0) {
      var hk = S.cursor - from;
      if (hk >= 0 && hk < cnt) {
        var hx = xOf(hk), hy = yOf(d.total[S.cursor]);
        g.strokeStyle = T.cursor;
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx, P.t); g.lineTo(hx, P.t + ih); g.stroke();
        g.beginPath(); g.moveTo(P.l, hy); g.lineTo(W - P.r, hy); g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(hx, hy, 4.2, 0, Math.PI * 2);
        g.fillStyle = T.last; g.fill();
        g.lineWidth = 2;
        g.strokeStyle = T.line[bandOf(d.total[S.cursor])];
        g.stroke();
      }
    }

    S.geo = { from: from, to: to, cnt: cnt, step: step, P: P, iw: iw, ih: ih, W: W, H: H };
  }

  /* ============ 上证 K 线窗（涨红跌绿；点数过密降采样为收盘折线） ============ */
  function drawSse() {
    if (!S.compare || !S.K) return;
    var cv = $('cvK'), wrap = cv.parentElement;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var dates = S.axis, N = dates.length;
    var T = cur();
    var from = Math.max(0, Math.floor(S.from));
    var to = Math.min(N - 1, Math.ceil(S.to));
    var cnt = to - from + 1;
    if (cnt < 2) return;

    /* 与 insum 共用同一 P.l/P.r/iw/cnt，保证同一天横向坐标一致 */
    var P = P_SSE;
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var step = iw / (cnt - 1);
    var xOf = function (k) { return xAt(k, P, iw, cnt); };

    var mn = Infinity, mx = -Infinity;
    for (var j = from; j <= to; j++) {
      if (S.KV.h[j] > mx) mx = S.KV.h[j];
      if (S.KV.l[j] < mn) mn = S.KV.l[j];
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    if (mx === mn) mx = mn + 1;
    var pad = (mx - mn) * 0.06;
    var lo = mn - pad, hi = mx + pad;
    var yOf = function (v) { return P.t + ih - (v - lo) / (hi - lo) * ih; };

    /* 横网格 + 左刻度 */
    g.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    var ticks = sseAxisTicks(lo, hi);
    var drawn = 0;
    for (var t = 0; t < ticks.length; t++) {
      var val = ticks[t];
      var y = yOf(val);
      if (y < P.t - 1 || y > P.t + ih + 1) continue;
      drawn++;
      g.strokeStyle = T.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(P.l, Math.round(y) + .5);
      g.lineTo(W - P.r, Math.round(y) + .5);
      g.stroke();
      g.fillStyle = T.axis;
      g.fillText(sseAxisLabel(val), P.l - 5, y);
    }
    S.gridN = drawn;   /* 供 insum 窗对齐格子数 */

    var mode = sseMode(cnt, iw);
    if (mode === 'candle') {
      var bw = Math.max(1, Math.min(9, step * 0.7));
      for (var k = 0; k < cnt; k++) {
        var gi = from + k;
        var o = S.KV.o[gi], c = S.KV.c[gi], h = S.KV.h[gi], l = S.KV.l[gi];
        var up = c >= o;
        var col = up ? T.sseUp : T.sseDown;
        var x = xOf(k);
        g.strokeStyle = col;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, yOf(h)); g.lineTo(x, yOf(l)); g.stroke();
        g.fillStyle = col;
        var yTop = yOf(Math.max(o, c));
        var yBot = yOf(Math.min(o, c));
        var bh = Math.max(1, Math.abs(yBot - yTop));
        g.fillRect(x - bw / 2, Math.min(yTop, yBot), bw, bh);
      }
    } else {
      /* 降采样：收盘价折线 + 面积，最多 2000 个绘制单元 */
      var stride = Math.max(1, Math.ceil(cnt / 2000));
      var top = P.t + ih;
      var xStart = xOf(0), xEnd = xOf(cnt - 1);
      var started = false;
      g.beginPath();
      for (var m = from; m <= to; m += stride) {
        var x1 = xOf(m - from), y1 = yOf(S.KV.c[m]);
        if (!started) { g.moveTo(x1, y1); started = true; } else g.lineTo(x1, y1);
      }
      if ((to - from) % stride !== 0) g.lineTo(xEnd, yOf(S.KV.c[to]));
      g.lineTo(xEnd, top); g.lineTo(xStart, top); g.closePath();
      var grd = g.createLinearGradient(0, P.t, 0, top);
      grd.addColorStop(0, T.sseFillTop);
      grd.addColorStop(1, T.sseFillBot);
      g.fillStyle = grd; g.fill();

      started = false;
      g.beginPath();
      for (var m2 = from; m2 <= to; m2 += stride) {
        var x2 = xOf(m2 - from), y2 = yOf(S.KV.c[m2]);
        if (!started) { g.moveTo(x2, y2); started = true; } else g.lineTo(x2, y2);
      }
      if ((to - from) % stride !== 0) g.lineTo(xEnd, yOf(S.KV.c[to]));
      g.strokeStyle = T.sseLine;
      g.lineWidth = 1.4;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke();
    }

    /* 十字游标（上证侧）+ 收盘信息徽标 */
    if (S.cursor >= 0) {
      var hk = S.cursor - from;
      if (hk >= 0 && hk < cnt) {
        var hx = xOf(hk);
        var close = S.KV.c[S.cursor];
        var hy = yOf(close);
        g.strokeStyle = T.cursor;
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx, P.t); g.lineTo(hx, P.t + ih); g.stroke();
        g.beginPath(); g.moveTo(P.l, hy); g.lineTo(W - P.r, hy); g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(hx, hy, 3.6, 0, Math.PI * 2);
        g.fillStyle = T.last; g.fill();

        var prev = S.cursor > 0 ? S.KV.c[S.cursor - 1] : null;
        var chg = prev != null ? close - prev : 0;
        var pct = prev ? chg / prev * 100 : 0;
        var up = chg >= 0;
        var col = up ? T.sseUp : T.sseDown;
        var txt = dates[S.cursor] + '  收 ' + close.toFixed(2) + '  ' +
          (up ? '▲ +' : '▼ ') + chg.toFixed(2) + '  ' + (up ? '+' : '') + pct.toFixed(2) + '%';
        g.font = '600 10px -apple-system,BlinkMacSystemFont,sans-serif';
        var tw = g.measureText(txt).width + 14;
        var bx = 6, by = 6, bh2 = 19;
        g.fillStyle = isLight() ? 'rgba(255,255,255,.94)' : 'rgba(9,13,20,.92)';
        g.strokeStyle = isLight() ? 'rgba(15,23,42,.14)' : 'rgba(255,255,255,.12)';
        g.lineWidth = 1;
        g.beginPath();
        if (g.roundRect) g.roundRect(bx, by, tw, bh2, 6); else g.rect(bx, by, tw, bh2);
        g.fill(); g.stroke();
        g.fillStyle = col;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(txt, bx + 7, by + bh2 / 2 + 0.5);
      }
    }
  }

  function renderAll() {
    /* v270：上证窗先画并登记实际网格条数，insum 窗再按同一数量画格子 */
    S.gridN = 0;
    if (S.compare && S.K) drawSse();
    drawInsum();
  }
  /* v265：拖动/缩放用 rAF 合帧，一次连续事件只重绘一帧；
   * renderAll() 仍保持同步，启动/档位/切换/自测不受异步影响。 */
  var rafPending = false;
  function scheduleRender() {
    if (typeof requestAnimationFrame === 'undefined') { renderAll(); return; }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; renderAll(); });
  }

  /* ============ 交互（单一手势源，绑定在 stage 上） ============ */
  function idxAt(clientX) {
    var geo = S.geo;
    if (!geo) return -1;
    var r = $('cvI').getBoundingClientRect();
    var ratio = (clientX - r.left - geo.P.l) / geo.iw;
    ratio = Math.max(0, Math.min(1, ratio));
    return Math.round(geo.from + ratio * (geo.cnt - 1));
  }

  function setCursor(i) {
    S.cursor = i;
    S.cursorMode = true;
    updateCards(i);
    /* v520：底部源名要跟着游标变（东财段/腾讯段）。footer 原本只在数据加载时
     * 刷新，游标移动不会更新，导致源名卡在最新日的段。这里显式重绘底部行。 */
    try { $('ft').textContent = footText(); } catch (e0) {}
    renderAll();
  }

  function clearCursor() {
    if (!S.cursorMode) return;
    S.cursorMode = false;
    S.cursor = -1;
    updateCards(S.axis.length - 1);
    try { $('ft').textContent = footText(); } catch (e0) {}   // v520：离开游标源名回到最新段
    renderAll();
  }

  function bind() {
    var stage = $('stage');

    function clearRangeBtns() {
      Array.prototype.forEach.call($('ranges').children, function (x) {
        if (x.id !== 'btnFit') x.classList.remove('on');
      });
    }

    function clampView() {
      var N = S.axis.length;
      var span = S.to - S.from;
      if (span < MIN_BARS - 1) {
        var mid = (S.from + S.to) / 2;
        S.from = mid - (MIN_BARS - 1) / 2;
        S.to = mid + (MIN_BARS - 1) / 2;
      }
      if (S.from < 0) { S.to -= S.from; S.from = 0; }
      if (S.to > N - 1) { S.from -= (S.to - (N - 1)); S.to = N - 1; }
      if (S.from < 0) S.from = 0;
    }

    function cancelLP() {
      if (S.lpTimer) { clearTimeout(S.lpTimer); S.lpTimer = null; }
    }

    function onDown(e) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      S.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (S.ptrs.size === 2) {
        cancelLP();
        var a = Array.from(S.ptrs.values());
        S.pinch = {
          dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y),
          from: S.from, to: S.to,
          mid: idxAt((a[0].x + a[1].x) / 2)
        };
        S.drag = null;
        return;
      }
      if (S.ptrs.size === 1) {
        S.drag = { x: e.clientX, y: e.clientY, from: S.from, to: S.to, moved: false,
          /* v562【单指上下滑缩放】对齐 K 线 charts.js:_bindVerticalZoom：
           * 记录起始 span/中心，后续每帧基于起点绝对计算，避免累积误差。
           * dir 在 onMove 首次判定：'v'=垂直缩放 / 'h'=水平平移 / null=未定。 */
          vz: null,
          span0: S.to - S.from, center0: (S.from + S.to) / 2,
          dataN: S.axis ? S.axis.length : 0 };
        if (e.pointerType !== 'mouse') {
          cancelLP();
          var cx0 = e.clientX;
          S.lpTimer = setTimeout(function () {
            S.lpTimer = null;
            S.drag = null;
            setCursor(idxAt(cx0));
            if (navigator.vibrate) { try { navigator.vibrate(8); } catch (er) {} }
          }, 280);
        } else {
          setCursor(idxAt(e.clientX));
        }
      }
    }

    function onMove(e) {
      if (!S.axis) return;   /* v265：breadth 加载失败时双指缩放不再抛错 */
      var p = S.ptrs.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') setCursor(idxAt(e.clientX));
        return;
      }
      p.x = e.clientX; p.y = e.clientY;

      if (S.ptrs.size === 2 && S.pinch) {
        var a = Array.from(S.ptrs.values());
        var dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (dist < 10 || S.pinch.dist < 10) return;
        var scale = S.pinch.dist / dist;
        var span0 = S.pinch.to - S.pinch.from;
        var span = Math.max(MIN_BARS - 1, Math.min(S.axis.length - 1, span0 * scale));
        var ratio = span0 > 0 ? (S.pinch.mid - S.pinch.from) / span0 : 0.5;
        S.from = S.pinch.mid - span * ratio;
        S.to = S.pinch.mid + span * (1 - ratio);
        clampView();
        clearRangeBtns();
        scheduleRender();
        return;
      }

      if (S.cursorMode) {
        setCursor(idxAt(e.clientX));
        return;
      }

      if (S.drag && S.ptrs.size === 1) {
        var dx = e.clientX - S.drag.x;
        var dy = e.clientY - S.drag.y;
        if (!S.drag.moved && Math.hypot(dx, dy) > 6) {
          S.drag.moved = true;
          cancelLP();
          /* 首次移动定方向：垂直占主导 → 缩放；水平占主导 → 平移（原行为） */
          S.drag.vz = (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) ? 'v' : 'h';
        }
        if (!S.drag.moved) return;
        if (S.drag.vz === 'v') {
          /* v562：上滑(dy<0)放大、下滑(dy>0)缩小；与 K 线同系数 0.008/px。
           * 中心固定在手势起点 center0，缩放后由 clampView 收进 [0, N-1]。 */
          var scale = Math.exp(0.008 * dy);
          var maxSpan = Math.max(MIN_BARS - 1, (S.drag.dataN || 1) - 1);
          var span = Math.max(MIN_BARS - 1, Math.min(maxSpan, S.drag.span0 * scale));
          S.from = S.drag.center0 - span / 2;
          S.to = S.drag.center0 + span / 2;
          clampView();
          clearRangeBtns();
          scheduleRender();
          return;
        }
        var geo = S.geo;
        if (!geo) return;
        var dIdx = -dx / geo.step;
        S.from = S.drag.from + dIdx;
        S.to = S.drag.to + dIdx;
        clampView();
        clearRangeBtns();
        scheduleRender();
      }
    }

    function onUp(e) {
      cancelLP();
      S.ptrs.delete(e.pointerId);
      if (S.ptrs.size < 2) S.pinch = null;
      if (S.ptrs.size === 0) {
        var was = S.drag;
        S.drag = null;
        if (was && !was.moved && !S.cursorMode) {
          setCursor(idxAt(e.clientX));
        }
      }
    }

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('pointerleave', function () {
      if (S.ptrs.size === 0 && S.cursorMode) clearCursor();
    });

    $('ranges').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var n = parseInt(b.dataset.n, 10) || 0;
      setRange(n);
      S.cursor = -1; S.cursorMode = false;
      updateCards(S.axis.length - 1);
      renderAll();
    });

    var fit = $('btnFit');
    if (fit) fit.addEventListener('click', function () {
      setRange(0);
      S.cursor = -1; S.cursorMode = false;
      updateCards(S.axis.length - 1);
      Array.prototype.forEach.call($('ranges').children, function (x) {
        x.classList.toggle('on', x.dataset.n === '0');
      });
      renderAll();
    });

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(renderAll, 120);
    });
    window.addEventListener('orientationchange', function () { setTimeout(renderAll, 260); });
  }

  /* ============ 对比开关 ============ */
  function setCompare(on) {
    if (on && !S.K) return;
    if (S.compare === on) return;
    if (!S.axis) return;
    var fromDate = S.axis[Math.min(S.axis.length - 1, Math.max(0, Math.round(S.from)))];
    var toDate = S.axis[Math.min(S.axis.length - 1, Math.max(0, Math.round(S.to)))];
    var curDate = S.cursor >= 0 ? S.axis[S.cursor] : null;
    S.compare = on;
    buildAxis();
    var nf = nearestIdx(S.axis, fromDate), nt = nearestIdx(S.axis, toDate);
    S.from = nf >= 0 ? nf : 0;
    S.to = nt >= 0 ? nt : S.axis.length - 1;
    if (S.to < S.from) S.to = S.from;
    var nc = curDate != null ? nearestIdx(S.axis, curDate) : -1;
    S.cursor = nc >= 0 ? nc : -1;
    document.body.classList.toggle('compare', on);
    $('btnCompare').classList.toggle('on', on);
    $('btnCompare').setAttribute('aria-pressed', on ? 'true' : 'false');
    Array.prototype.forEach.call($('ranges').children, function (x) { x.classList.remove('on'); });
    updateCards(S.cursor >= 0 ? S.cursor : S.axis.length - 1);
    renderAll();
    try { parent.postMessage({ mm_compare_state: !!S.compare }, '*'); } catch (e) {}
  }

  /* ============ 主题 ============ */
  function isEmbed() { return document.body.classList.contains('embed'); }
  /* 同源 iframe 直接读父页面 body.light，不依赖 postMessage 时序；
   * 主站点 ◐ 时 MutationObserver 立刻同步，杜绝「主站浅色 / 内页深色」。 */
  function parentTheme() {
    try {
      if (parent === window || !parent.document || !parent.document.body) return null;
      return parent.document.body.classList.contains('light') ? 'light' : 'dark';
    } catch (e) { return null; }
  }
  function readTheme() {
    if (isEmbed()) { var pt = parentTheme(); if (pt) return pt; }
    /* v266：URL 参数优先，方便直接分享「浅色版」链接与截图验收 */
    try {
      var q = new URLSearchParams(location.search).get('theme');
      if (q === 'light' || q === 'dark') return q;
    } catch (e) {}
    try {
      var th = JSON.parse(localStorage.getItem('mm_theme') || 'null');
      if (th === 'light') return 'light';
      if (th === 'dark') return 'dark';
    } catch (e) {}
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function applyTheme(th) {
    var on = th === 'light';
    document.body.classList.toggle('light', on);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', on ? '#eef2f7' : '#070a0f');
    if (S.B) { paintLegend(); renderAll(); }
  }

  function nativeLandscape(on) {
    try {
      var np = (window.parent && window.parent !== window && window.parent.NativePulse) || window.NativePulse;
      if (np && np.setLandscape) np.setLandscape(!!on);
    } catch (e) {}
  }

  function bindFullscreen() {
    var btn = $('btnFull');
    if (!btn) return;
    function sync() {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      btn.classList.toggle('on', on);
      var lab = btn.querySelector('span');
      if (lab) lab.textContent = on ? '退出' : '全屏';
      nativeLandscape(on);
    }
    btn.addEventListener('click', function () {
      var el = document.documentElement;
      var cur = document.fullscreenElement || document.webkitFullscreenElement;
      try {
        if (cur) {
          (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
        } else {
          var req = el.requestFullscreen || el.webkitRequestFullscreen;
          if (req) {
            req.call(el).then(function () {
              try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape'); } catch (e) {}
            }).catch(function () {});
          }
        }
      } catch (e) {}
      setTimeout(function () { sync(); renderAll(); }, 320);
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    window.addEventListener('resize', function () { setTimeout(renderAll, 240); });
  }

  /* ============ 启动 ============ */
  /* 只读调试句柄：验证进入时视窗是否在最右最新 */
  window.__breadthView = function () {
    return {
      from: S.from, to: S.to, n: S.axis ? S.axis.length : 0,
      lastDate: S.axis ? S.axis[S.axis.length - 1] : null,
      compare: S.compare, embed: document.body.classList.contains('embed'),
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight,
      bodyOverflow: getComputedStyle(document.body).overflow
    };
  };

  function boot() {
    bindFullscreen();
    if (/embed=1/.test(location.search)) document.body.classList.add('embed');
    applyTheme(readTheme());
    window.addEventListener('message', function (e) {
      /* v585【切回赚钱效应 tab 顶部按钮被横栏遮住】iframe 在切走时只是被隐藏、
       * DOM 保留，内部 scrollY 不会归零；用户滚过一次后再切回来就停在下方，
       * 顶部的「对比模式/全屏」按钮被宿主横栏盖住，必须杀进程重开才恢复。
       * 宿主 switchTab('effect') 会发 mm_effect_show，收到即滚回顶部，
       * 与重开 APP 新建 iframe 的效果一致。只处理来自父窗口的消息。 */
      if (e.data && e.data.mm_effect_show && e.source === window.parent) {
        try {
          window.scrollTo(0, 0);
          if (document.documentElement) document.documentElement.scrollTop = 0;
          if (document.body) document.body.scrollTop = 0;
        } catch (eScroll) {}
      }
      if (e.data && typeof e.data.mm_theme === 'string' && !isEmbed()) applyTheme(e.data.mm_theme);
      if (e.data && typeof e.data.mm_compare === 'boolean') setCompare(e.data.mm_compare);
      /* v521：主站 eff-bar 下拉切指数 → 本页切换；若数据未就绪则缓存，applySse 后生效 */
      if (e.data && typeof e.data.mm_compare_index === 'string') {
        if (typeof window.__switchCompareIndex === 'function') window.__switchCompareIndex(e.data.mm_compare_index);
        else S.idxKey = e.data.mm_compare_index;   // 数据未加载，先记住
      }
      if (e.data && e.data.mm_exit_fs) {
        var cur = document.fullscreenElement || document.webkitFullscreenElement;
        if (cur) { try { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); } catch (err) {} }
        nativeLandscape(false);
      }
    });
    window.addEventListener('storage', function (e) {
      if (e.key === 'mm_theme') applyTheme(readTheme());
    });

    var cmp = $('btnCompare');
    cmp.addEventListener('click', function () { setCompare(!S.compare); });
    /* v491：下拉切换对比指数。S.K 指向选中指数 → buildAxis() 用其 dates 当主轴，
     * 指标自动从该指数首日开始，无 0 假基线。缺数据的指数(如抓失败的)回退当前。
     * v521：下拉已移到主站 eff-bar(embed 下 sse header 被隐藏)，本页也可能有(独立打开时)。 */
    /* v523：更新 K 线图例标题为当前指数名（数据里的 name / 顶层 meta）。 */
    function updateIdxLabel(key, target) {
      var el = $('sseLgLabel');
      if (!el) return;
      var name = (target && target.name) || '上证指数';
      /* 指数裸数据无复权概念（qfq/hfq 等价），但保留原措辞避免引入其它展示变化 */
      el.textContent = name + ' · 前复权 · 涨红跌绿';
    }
    function switchIndex(key) {
      var target = key === 'SH' ? (S.SH_K || S.K) : ((S.ALLIDX || {})[key]);
      if (!target || !target.dates || !target.dates.length) return false;
      /* v539d【用户诉求】切指数保留正在看的时间段与缩放：
       * 旧行为 setRange(0) 会把视窗铺满新指数全区间→正在看2015年切上证却跳到最新。
       * 新行为：按【日期】而非索引保存/恢复（不同指数交易日数不同，索引不可直接用）；
       * 仅当想看的整段都在新指数首日之前(如90年代看创业板)才回退到最新。 */
      var oldAxis = S.axis || [];
      var span = S.to - S.from;
      var fromDate = oldAxis.length ? oldAxis[Math.max(0, Math.min(oldAxis.length - 1, Math.round(S.from)))] : null;
      var toDate = oldAxis.length ? oldAxis[Math.max(0, Math.min(oldAxis.length - 1, Math.round(S.to)))] : null;
      S.idxKey = key;
      S.K = target;
      /* v523：K线图例标题跟随选中指数——原来写死"上证指数"，切科创50后
       * 数据已切对(Y轴 1200+)但标题仍是上证，用户误以为没切换。 */
      updateIdxLabel(key, target);
      S.cursor = -1; S.cursorMode = false;   // 切指数重置游标
      buildAxis();
      var first = S.axis[0], last = S.axis[S.axis.length - 1];
      // 保留条件：想看的区间与新指数数据范围有交集（结束日不早于新指数首日、开始日不晚于末日）
      var overlap = fromDate && toDate && !(toDate < first) && !(fromDate > last);
      if (overlap) {
        var nf = nearestIdx(S.axis, fromDate), nt = nearestIdx(S.axis, toDate);
        S.from = nf >= 0 ? Math.min(nf, S.axis.length - 1) : 0;
        S.to = nt >= 0 ? Math.max(S.from, Math.min(nt, S.axis.length - 1)) : S.axis.length - 1;
        // 缩放比例(span)保留：若两端都落在范围内，用原 span 修正右端，避免交易日疏密导致窗口宽度漂移
        if (span > 0 && nf >= 0 && nt < S.axis.length && S.to - S.from < span - 0.5) {
          S.from = Math.max(0, S.to - span);
        }
        if (S.to <= S.from) S.to = Math.min(S.axis.length - 1, S.from + 1);
      } else {
        setRange(0);   // 该指数在想看的时段根本不存在 → 铺满(跳到最新)，符合用户要求
      }
      var viewI = Math.round(S.to);
      updateCards(viewI);
      try { $('ft').textContent = footText(); } catch (e0) {}
      renderAll();
      try { parent.postMessage({ mm_compare_index: key }, '*'); } catch (e) {}
      return true;
    }
    window.__switchCompareIndex = switchIndex;   // 供 message handler 调用
    /* v584：只读验收探针（不参与渲染，供自动化核对统一 Insum 轴/裁切起点） */
    window.__sseProbe = function () {
      var ax = S.axis || [], n = ax.length;
      return { first: n ? ax[0] : '', last: n ? ax[n - 1] : '', n: n,
               idxKey: S.idxKey, totalLast: (S.insum && S.insum.total) ? S.insum.total[n - 1] : null,
               sigLast: (S.insum && S.insum.sig) ? S.insum.sig[n - 1] : null };
    };
    var cmpSel = $('cmpIndex');
    if (cmpSel) cmpSel.addEventListener('change', function () {
      if (!switchIndex(cmpSel.value)) cmpSel.value = S.idxKey;
    });

    if (isEmbed()) {
      try {
        new MutationObserver(function () {
          var t = parentTheme(); if (t) applyTheme(t);
        }).observe(parent.document.body, { attributes: true, attributeFilter: ['class'] });
      } catch (e) {}
      try { parent.postMessage({ mm_theme_req: 1 }, '*'); } catch (e) {}
      document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      document.addEventListener('selectstart', function (e) { e.preventDefault(); });
    }

    var theme = $('btnTheme');
    if (theme) theme.addEventListener('click', function () {
      var next = isLight() ? 'dark' : 'light';
      try { localStorage.setItem('mm_theme', JSON.stringify(next)); } catch (e) {}
      try {
        var u = new URL(location.href);
        u.searchParams.delete('theme');
        history.replaceState(null, '', u.toString());
      } catch (e) {}
      applyTheme(next);
    });

    /* v563【首屏直落最新】原来先用本地 data/breadth.json（可能停在前一交易日），
     * 再靠 startRemoteRefresh() 异步竞速云端才有最新 —— 用户打开头几秒看到的
     * 是昨天那根（截图 11-20），要等一会才跳到最新。现在反过来：
     * 先给远程 2.5s 窗口拿最新，拿到直接用；超时/失败再落本地快照，不阻塞首屏太久。 */
    var localB = loadJSON('data/breadth.json');
    var remoteFirst = new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 2500);
      remoteBreadth().then(function (rb) {
        if (!done) { done = true; clearTimeout(t); resolve(rb || null); }
      }, function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
    var firstB = remoteFirst.then(function (rb) {
      return rb || localB;   // 远程拿到（已按末日选最优源）→ 直接用；否则本地
    }).catch(function () { return localB; });
    firstB
      .then(function (b) {
        if (!b || !b.dates || !b.dates.length) throw new Error('breadth empty');
        S.B = b;
        S.bIndex = new Map();
        for (var i = 0; i < b.dates.length; i++) S.bIndex.set(b.dates[i], i);
        buildAxis();
        $('upd').textContent = '全A股 · ' + updText(b);
        setRange(30);
        updateCards(S.axis.length - 1);
        if (isFresh(b)) $('dot').classList.remove('old'); else $('dot').classList.add('old');
        if (S.K) cmp.disabled = false;
        paintLegend();
        $('ft').textContent = footText();
        renderAll();
        if (S.K && /compare=1/.test(location.search)) setCompare(true);
        try { parent.postMessage({ mm_compare_state: !!S.compare, mm_ready: 1 }, '*'); } catch (e) {}
        postStatus();
        startRemoteRefresh();
      })
      .catch(function () {
        $('gen').textContent = '数据加载失败';
        $('upd').textContent = '全A股 · 数据未更新，请检查跑批';
        $('dot').classList.add('old');
      });

    loadRemoteS()
      .then(function (k) {
        if (!sseOK(k)) throw new Error('sse-symbol-check');
        applySse(k);
        if (S.B) cmp.disabled = false;
        cmp.title = '';
        if (S.B) {
          $('ft').textContent = footText();
          if (/compare=1/.test(location.search)) setCompare(true);
        }
        renderAll();
      })
      .catch(function () {
        return loadJSON('data/sse.json').then(function (k) {
          if (!sseOK(k)) throw new Error('sse-symbol-check');
          applySse(k);
          if (S.B) cmp.disabled = false;
          if (S.B) $('ft').textContent = footText();
          renderAll();
        });
      })
      .catch(function () {
        cmp.disabled = true;
        /* v278：区分「缺数据」与「数据标的校验失败」——后者是抓错标的，必须显式提示 */
        cmp.title = '上证数据缺失或校验失败，无法对比';
        try { if ($('gen')) $('gen').textContent = '上证数据校验失败'; } catch (e) {}
        $('gen').textContent = '上证数据缺失';   /* v265：移动端 hover 不出 title，给可见提示 */
      });
  }

  /* 浏览器里才启动；node（自测）require 时不碰 DOM */
  if (typeof document !== 'undefined') {
    boot();
    bind();
  }

  /* 供 tools/test_render.js 复用的纯函数 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      P_INSUM: P_INSUM, P_SSE: P_SSE,
      xAt: xAt, sseMode: sseMode, axisTier: axisTier,
      spanDays: spanDays, buildAxisLabels: buildAxisLabels,
      dotColorIdx: dotColorIdx, hotSegs: hotSegs, nearestIdx: nearestIdx,
      sseAxisLabel: sseAxisLabel, sseAxisTicks: sseAxisTicks,
      insumAxisTicks: insumAxisTicks, alignedInsumTicks: alignedInsumTicks
    };
  }
})();
