(function () {
  'use strict';

  /* ============ 状态（单一真源） ============
   * S.axis  当前主轴日期数组（对比关闭=breadth 全A交易日，开启=上证日K交易日）
   * S.insum 与 axis 对齐的指标数组（total/daycnt/willrm/newadd/sig）
   * S.from/S.to 可见区间（axis 索引，float，拖动/缩放用）
   * 两窗共享同一套 from/to —— 绝不给两个 canvas 各自绑手势 */
  var S = {
    B: null, K: null,
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
    if (b.dates[b.dates.length - 1] <= oldLast) return false;
    var fromDate = S.axis[Math.max(0, Math.min(S.axis.length - 1, Math.round(S.from)))];
    var toDate = S.axis[Math.max(0, Math.min(S.axis.length - 1, Math.round(S.to)))];
    S.B = b;
    S.bIndex = new Map();
    for (var i = 0; i < b.dates.length; i++) S.bIndex.set(b.dates[i], i);
    buildAxis();
    var nf = nearestIdx(S.axis, fromDate), nt = nearestIdx(S.axis, toDate);
    S.from = nf >= 0 ? Math.min(nf, S.axis.length - 1) : 0;
    S.to = nt >= 0 ? Math.max(S.from, Math.min(nt, S.axis.length - 1)) : S.axis.length - 1;
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
    function tick() { remoteBreadth().then(function (b) { if (b) applyNewBreadth(b); }).catch(function () {}); }
    tick();
    var timer = setInterval(function () {
      var bj = new Date(Date.now() + 8 * 3600 * 1000);
      var wd = bj.getUTCDay(), hh = bj.getUTCHours();
      if (wd === 0 || wd === 6 || hh < 15 || hh >= 18) return;  /* 只在工作日 15-18 点追新 */
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
    if (!isFresh(d)) txt += ' · 待更新';
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
    if (S.B) parts.push('全部A股 ' + m.universe + ' 只 · 有效 ' + m.valid + ' 只 · ' + m.days + ' 个交易日');
    parts.push(short ? '更新 ' + short + (m.generated_tz ? ' 北京' : '') : '更新时间未知');
    if (S.K) {
      var kLast = S.K.dates[S.K.dates.length - 1];
      var bLast = S.B ? S.B.dates[S.B.dates.length - 1] : null;
      if (bLast && kLast < bLast) parts.push('上证 ' + kLast + ' 待补');
    }
    if (S.B && !isFresh(S.B)) parts.push('待更新');
    return parts.join(' · ');
  }
  /* 把「日期 周X 收盘 + 新鲜度」推给主站工具条（老版 header 里那颗绿点） */
  function postStatus() {
    if (!isEmbed()) return;
    try {
      var i = S.cursor >= 0 ? S.cursor : (S.axis ? S.axis.length - 1 : -1);
      var date = (S.axis && i >= 0) ? S.axis[i]
        : ((S.B && S.B.dates[S.B.dates.length - 1]) || '');
      var last = !S.axis || i >= S.axis.length - 1;
      var wk = wkOf(date);
      parent.postMessage({ mm_status: {
        text: date + (wk ? ' 周' + wk : '') + (last ? ' 收盘' : ''),
        fresh: S.B ? isFresh(S.B) : true
      } }, '*');
    } catch (e) {}
  }

  /* ============ 主轴对齐（按日期 Map，不按下标硬对齐） ============ */
  function buildAxis() {
    var dates = (S.compare && S.K) ? S.K.dates : S.B.dates;
    var insum = { total: [], daycnt: [], willrm: [], newadd: [], sig: [] };
    var prevTotal = 0, prevDay = 0, prevRm = 0, prevNew = 0;
    for (var i = 0; i < dates.length; i++) {
      var bi = S.bIndex.get(dates[i]);
      if (bi == null) {
        /* v266：缺日不填 0（会在图上砸出一根假尖峰），沿用前一个有效值 */
        insum.total.push(prevTotal); insum.daycnt.push(prevDay);
        insum.willrm.push(prevRm); insum.newadd.push(prevNew); insum.sig.push(0);
      } else {
        prevTotal = S.B.total[bi]; prevDay = S.B.daycnt[bi];
        prevRm = S.B.willrm[bi]; prevNew = S.B.newadd[bi];
        insum.total.push(prevTotal);
        insum.daycnt.push(prevDay);
        insum.willrm.push(prevRm);
        insum.newadd.push(prevNew);
        insum.sig.push(S.B.sig[bi]);
      }
    }
    S.axis = dates; S.insum = insum;
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
    var p = function (k) { return i > 0 ? d[k][i - 1] : null; };

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
      if (S.K.h[j] > mx) mx = S.K.h[j];
      if (S.K.l[j] < mn) mn = S.K.l[j];
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
        var o = S.K.o[gi], c = S.K.c[gi], h = S.K.h[gi], l = S.K.l[gi];
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
        var x1 = xOf(m - from), y1 = yOf(S.K.c[m]);
        if (!started) { g.moveTo(x1, y1); started = true; } else g.lineTo(x1, y1);
      }
      if ((to - from) % stride !== 0) g.lineTo(xEnd, yOf(S.K.c[to]));
      g.lineTo(xEnd, top); g.lineTo(xStart, top); g.closePath();
      var grd = g.createLinearGradient(0, P.t, 0, top);
      grd.addColorStop(0, T.sseFillTop);
      grd.addColorStop(1, T.sseFillBot);
      g.fillStyle = grd; g.fill();

      started = false;
      g.beginPath();
      for (var m2 = from; m2 <= to; m2 += stride) {
        var x2 = xOf(m2 - from), y2 = yOf(S.K.c[m2]);
        if (!started) { g.moveTo(x2, y2); started = true; } else g.lineTo(x2, y2);
      }
      if ((to - from) % stride !== 0) g.lineTo(xEnd, yOf(S.K.c[to]));
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
        var close = S.K.c[S.cursor];
        var hy = yOf(close);
        g.strokeStyle = T.cursor;
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx, P.t); g.lineTo(hx, P.t + ih); g.stroke();
        g.beginPath(); g.moveTo(P.l, hy); g.lineTo(W - P.r, hy); g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(hx, hy, 3.6, 0, Math.PI * 2);
        g.fillStyle = T.last; g.fill();

        var prev = S.cursor > 0 ? S.K.c[S.cursor - 1] : null;
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
    renderAll();
  }

  function clearCursor() {
    if (!S.cursorMode) return;
    S.cursorMode = false;
    S.cursor = -1;
    updateCards(S.axis.length - 1);
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
        S.drag = { x: e.clientX, y: e.clientY, from: S.from, to: S.to, moved: false };
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
        }
        if (!S.drag.moved) return;
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
  function boot() {
    bindFullscreen();
    if (/embed=1/.test(location.search)) document.body.classList.add('embed');
    applyTheme(readTheme());
    window.addEventListener('message', function (e) {
      if (e.data && typeof e.data.mm_theme === 'string' && !isEmbed()) applyTheme(e.data.mm_theme);
      if (e.data && typeof e.data.mm_compare === 'boolean') setCompare(e.data.mm_compare);
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

    loadJSON('data/breadth.json')
      .then(function (b) {
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

    loadJSON('data/sse.json')
      .then(function (k) {
        S.K = k;
        if (S.B) cmp.disabled = false;
        cmp.title = '';
        if (S.B) {
          $('ft').textContent = footText();
          if (/compare=1/.test(location.search)) setCompare(true);
        }
      })
      .catch(function () {
        cmp.disabled = true;
        cmp.title = '上证数据缺失，无法对比';
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
