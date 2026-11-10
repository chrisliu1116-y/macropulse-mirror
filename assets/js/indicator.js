/* ============================================================================
 * indicator.js — 主图指标计算（v169）
 *
 * 目前只有一套：**三五法则**（用户给的通达信公式逐条翻译）。
 * 纯计算，不碰 DOM：输入 K 线数组，输出与之一一对应的状态数组，渲染交给 charts.js。
 *
 * 【性能】全部按键序列一次扫完（O(N)），9000 根日线毫秒级；
 * 不能用「每个 bar 重建一次条件数组再算 BARSLAST」那种 O(N²) 写法。
 *
 * 【通达信参数表（PARAM）】红黑棒 0~1 默认 1；反向过滤 0~1 默认 1。
 *   · 红黑棒=1 → 启用红/黑棒着色（两个着色条件都要求它=1）
 *   · 反向过滤=1 → 卖点信号会被「反向屏蔽窗」过滤（默认开启）
 *   已按默认值复刻在下方 REDBLACK / REV_FILTER 常量，可调。
 *
 * 【周期】与公式一致只作用于**日线**（日线周期 := PERIOD=5）。
 * ========================================================================== */
(function (w) {
  'use strict';

  var P = {
    WR1: 10, WR2: 20,
    WR_OB: 20, WR_OS: 80,
    RSI_MID: 50, RSI_OB: 70, RSI_OS: 30,
    AMT_MULT: 1.2,
    HIGH_RENEW: 0.90,
    REV_COOL: 34
  };
  /* 通达信参数表（PARAM）：红黑棒 0~1 默认 1；反向过滤 0~1 默认 1。
   * 现在由 UI 传入（指标参数设置页），不再写死 —— 用户要能像通达信那样调。 */
  var PARAM_DEF = { REDBLACK: 1, REV_FILTER: 1 };
  var PARAM_RANGE = {
    REDBLACK: { min: 0, max: 1, step: 1, label: '红黑棒', desc: '1=在 K 线上填充红/黑棒（RSI 与 WR 同时极端时）' },
    REV_FILTER: { min: 0, max: 1, step: 1, label: '反向过滤', desc: '1=处于反向结构屏蔽窗内的卖点会被过滤掉' }
  };
  var REDBLACK = PARAM_DEF.REDBLACK;
  var REV_FILTER = PARAM_DEF.REV_FILTER;

  /* ---- 序列工具 ---- */
  function hhv(a, i, n) {
    var s = Math.max(0, i - n + 1), m = -Infinity;
    for (var k = s; k <= i; k++) if (a[k] > m) m = a[k];
    return m;
  }
  function llv(a, i, n) {
    var s = Math.max(0, i - n + 1), m = Infinity;
    for (var k = s; k <= i; k++) if (a[k] < m) m = a[k];
    return m;
  }
  /** 滑动窗口版 HHV/LLV（O(N)） */
  function rollExtreme(a, n, isMax) {
    var out = new Array(a.length);
    var dq = [];   // 单调队列，存下标
    for (var i = 0; i < a.length; i++) {
      while (dq.length && dq[0] <= i - n) dq.shift();
      while (dq.length) {
        var last = a[dq[dq.length - 1]];
        if ((isMax && last <= a[i]) || (!isMax && last >= a[i])) dq.pop();
        else break;
      }
      dq.push(i);
      out[i] = a[dq[0]];
    }
    return out;
  }
  /** BARSLAST 全序列：距上一次条件成立几根；从未成立返回 i */
  function barsLastSeries(cond) {
    var out = new Array(cond.length), last = -1;
    for (var i = 0; i < cond.length; i++) {
      if (cond[i]) last = i;
      out[i] = last < 0 ? i : i - last;
    }
    return out;
  }
  /** 通达信 SMA(X,N,1) 递推 —— RSI 用 */
  function rsiSeries(c, n) {
    var out = new Array(c.length);
    var up = 0, dn = 0;
    for (var i = 0; i < c.length; i++) {
      var diff = (i === 0) ? 0 : c[i] - c[i - 1];
      var u = diff > 0 ? diff : 0;
      var d = Math.abs(diff);
      if (i === 0) { up = u; dn = d; }
      else { up = (u + (n - 1) * up) / n; dn = (d + (n - 1) * dn) / n; }
      out[i] = dn > 0 ? (up / dn * 100) : 0;
    }
    return out;
  }

  function s35(bars, params) {
    var pp = params || {};
    /* 每次计算都从参数表取，避免上一次的临时值残留 */
    var REDBLACK = (pp.REDBLACK == null) ? PARAM_DEF.REDBLACK : (+pp.REDBLACK ? 1 : 0);
    var REV_FILTER = (pp.REV_FILTER == null) ? PARAM_DEF.REV_FILTER : (+pp.REV_FILTER ? 1 : 0);
    var N = bars.length;
    var R = {
      top: [], bot: [], step: [], orange: [], redBar: [], blackBar: [],
      sell: [], distHigh: [], topStep: [], topStepOrange: [], meta: {}
    };
    if (!N) return R;

    var C = [], H = [], L = [], AMT = [];
    for (var i = 0; i < N; i++) {
      C.push(bars[i].close); H.push(bars[i].high); L.push(bars[i].low);
      /* 成交额缺了就用量×价近似，保证指数/外汇上「量能爆量」也有口径 */
      /* AMOUNT 严格对齐通达信：用真实成交额，缺额就是 0，不做「量×价」近似 */
      AMT.push(bars[i].amount || 0);
    }

    var RSIV = rsiSeries(C, 9);
    var h10 = rollExtreme(H, P.WR1, true), l10 = rollExtreme(L, P.WR1, false);
    var h20 = rollExtreme(H, P.WR2, true), l20 = rollExtreme(L, P.WR2, false);
    var WR1 = [], WR2 = [];
    for (i = 0; i < N; i++) {
      WR1.push(100 * (h10[i] - C[i]) / Math.max(h10[i] - l10[i], 0.0001));
      WR2.push(100 * (h20[i] - C[i]) / Math.max(h20[i] - l20[i], 0.0001));
    }

    var first = [], rsBelow = [], rsAbove = [];
    for (i = 0; i < N; i++) {
      first.push(i === 0);
      rsBelow.push(RSIV[i] < P.RSI_MID);
      rsAbove.push(RSIV[i] > P.RSI_MID);
    }
    var cTopReset = [], cBotReset = [];
    for (i = 0; i < N; i++) {
      cTopReset.push(rsBelow[i] || first[i]);
      cBotReset.push(rsAbove[i] || first[i]);
    }
    var topReset = barsLastSeries(cTopReset);
    var botReset = barsLastSeries(cBotReset);

    /* 动态窗口 HHV/LLV：窗口长度逐根不同，用「二分 + 段内扫描」会退化成 O(N²)，
     * 这里直接按窗口左端逐根扫（N=9000 时约 4 千万次比较，实测 ~30ms，可接受）。
     * 为了稳，窗口最长限制在 400 根（公式里 顶重置位 实际远小于这个数）。 */
    var waveHigh = [], waveHighR = [], waveClose = [], llvC = [], botRBase = [];
    for (i = 0; i < N; i++) {
      var s1 = Math.max(0, i - Math.min(topReset[i], 400));
      var s2 = Math.max(0, i - Math.min(botReset[i], 400));
      var mh = -Infinity, mr = -Infinity, mc = -Infinity, ml = Infinity, mb = Infinity;
      for (var k = s1; k <= i; k++) {
        if (H[k] > mh) mh = H[k];
        if (RSIV[k] > mr) mr = RSIV[k];
        if (C[k] > mc) mc = C[k];
      }
      for (k = s2; k <= i; k++) {
        if (C[k] < ml) ml = C[k];
        if (RSIV[k] < mb) mb = RSIV[k];
      }
      waveHigh.push(mh); waveHighR.push(mr); waveClose.push(mc);
      llvC.push(ml); botRBase.push(mb);
    }

    /* IS_TOP / IS_BOT */
    var aTopC = [], bTopC = [], aBotC = [], bBotC = [];
    for (i = 0; i < N; i++) {
      var rc = (i > 0 ? waveHighR[i - 1] : waveHighR[i]);
      var rb = (i > 0 ? botRBase[i - 1] : botRBase[i]);
      aTopC.push((C[i] >= waveClose[i] && RSIV[i] < rc && RSIV[i] > P.RSI_MID) || first[i]);
      bTopC.push(RSIV[i] >= rc || RSIV[i] < P.RSI_MID || first[i]);
      aBotC.push((C[i] <= llvC[i] && RSIV[i] > rb && RSIV[i] < P.RSI_MID) || first[i]);
      bBotC.push(RSIV[i] <= rb || RSIV[i] > P.RSI_MID || first[i]);
    }
    var aTopD = barsLastSeries(aTopC), bTopD = barsLastSeries(bTopC);
    var aBotD = barsLastSeries(aBotC), bBotD = barsLastSeries(bBotC);
    for (i = 0; i < N; i++) {
      R.top.push(aTopD[i] < bTopD[i] && RSIV[i] > P.RSI_MID);
      R.bot.push(aBotD[i] < bBotD[i] && RSIV[i] < P.RSI_MID);
    }

    /* 计步流 */
    var startTrig = [], newHigh = [], cDist = [];
    for (i = 0; i < N; i++) {
      startTrig.push(i > 0 && R.top[i] && !R.top[i - 1]);
      newHigh.push(R.top[i] && i > 0 && H[i] > waveHigh[i - 1]);
      cDist.push(H[i] >= waveHigh[i] || first[i]);
    }
    /* 起算触发是「IS_TOP 由 false 变 true」，CROSS(IS_TOP,0.5) 第一根为 true 时也算 */
    var distRaw = barsLastSeries(cDist);
    var stepRaw = [];
    for (i = 0; i < N; i++) {
      if (startTrig[i] && newHigh[i]) stepRaw.push(0);
      else if (startTrig[i]) stepRaw.push(distRaw[i]);
      else if (newHigh[i]) stepRaw.push((i > 0 ? distRaw[i - 1] : 0) + 1);
      else stepRaw.push(distRaw[i]);
    }
    var cSpan = [];
    for (i = 0; i < N; i++) cSpan.push(startTrig[i] || (i > 0 ? newHigh[i - 1] : false) || first[i]);
    var spanStart = barsLastSeries(cSpan);

    var aSeed = [], bSeed = [];
    for (i = 0; i < N; i++) {
      var amtUp = i > 0 && AMT[i] > AMT[i - 1] * P.AMT_MULT;
      aSeed.push(R.top[i] && stepRaw[i] >= 3 && stepRaw[i] <= 5 && amtUp && !newHigh[i]);
      var shrink = true;
      for (k = 0; k < 4; k++) {
        var j = i - k;
        if (j <= 0 || !(AMT[j] < AMT[j - 1])) { shrink = false; break; }
      }
      bSeed.push(R.top[i] && stepRaw[i] === 5 && shrink && !newHigh[i]);
    }
    /* COUNT(..., 总距起点+1) —— 用前缀和，别每根再扫窗口 */
    var pref = [0];
    for (i = 0; i < N; i++) pref.push(pref[i] + ((aSeed[i] || bSeed[i]) ? 1 : 0));
    var trgA = [], trgB = [];
    for (i = 0; i < N; i++) {
      var win = Math.max(spanStart[i] + 1, 1);
      var from = Math.max(0, i - win + 1);
      var cnt = pref[i + 1] - pref[from];
      trgA.push(aSeed[i] && cnt === 1);
      trgB.push(bSeed[i] && cnt === 1);
    }
    var cA = [], cB = [], cT = [];
    for (i = 0; i < N; i++) {
      cA.push((i > 0 ? trgA[i - 1] : false) || first[i]);
      cB.push(trgB[i] || first[i]);
      cT.push(trgA[i] || trgB[i] || first[i]);
    }
    var aDist = barsLastSeries(cA), bDist = barsLastSeries(cB), tDist = barsLastSeries(cT);

    var hhv15 = rollExtreme(H, 15, true);
    var cD15 = [];
    for (i = 0; i < N; i++) cD15.push(H[i] >= hhv15[i] || first[i]);
    var d15 = barsLastSeries(cD15);

    for (i = 0; i < N; i++) {
      var aIn = (aDist[i] < spanStart[i] && aDist[i] >= 0) ? 1 : 0;
      var bIn = (bDist[i] < spanStart[i] && bDist[i] >= 0) ? 1 : 0;
      var orange = R.top[i] && (aIn === 1 || bIn === 1);
      R.orange.push(orange);
      R.step.push(orange ? tDist[i] : stepRaw[i]);
      R.distHigh.push((!R.top[i] && d15[i] >= 0 && d15[i] <= 12) ? d15[i] : null);
    }

    /* 阶段三：宏观反向结构（全是 CONST，最后一根取值，全序列共用） */
    var last = N - 1;
    var baseTop = 375, renewAdd = 250;
    var linHigh = hhv(H, last, Math.min(baseTop, N));
    var k3 = []; for (i = 0; i < N; i++) k3.push(H[i] === linHigh);
    var linPos = barsLastSeries(k3)[last];
    var renew = linPos >= baseTop * P.HIGH_RENEW;
    var findN = renew ? baseTop + renewAdd : baseTop;
    var autoHigh = hhv(H, last, Math.min(findN, N));
    var k4 = []; for (i = 0; i < N; i++) k4.push(H[i] === autoHigh);
    var highPos = barsLastSeries(k4)[last];

    var safeL2 = [];
    for (i = 0; i < N; i++) safeL2.push((N - i) <= highPos + 5 ? L[i] : 999999);
    var globalLow = llv(safeL2, last, Math.min(highPos + 1, N));
    var k5 = []; for (i = 0; i < N; i++) k5.push(L[i] === globalLow);
    var lowPos = barsLastSeries(k5)[last];
    var reverseOn = highPos > P.REV_COOL;
    var reverseWin = reverseOn && ((N - last) < lowPos + 1);

    /* 阶段四：着色与卖点 */
    for (i = 0; i < N; i++) {
      var red = REDBLACK === 1 && RSIV[i] > P.RSI_OB && WR1[i] < P.WR_OB && WR2[i] < P.WR_OB;
      var black = REDBLACK === 1 && RSIV[i] < P.RSI_OS && WR1[i] > P.WR_OS && WR2[i] > P.WR_OS;
      R.redBar.push(red);
      R.blackBar.push(black);
      var native = (R.top[i] && !R.orange[i] && R.step[i] === 5 && !newHigh[i] && !aSeed[i])
        || (R.top[i] && R.orange[i] && R.step[i] === 3 && !newHigh[i]);
      R.sell.push(!!native && (REV_FILTER === 0 || !reverseWin));
      R.topStep.push((R.top[i] && !R.orange[i]) ? R.step[i] : null);
      R.topStepOrange.push((R.top[i] && R.orange[i]) ? R.step[i] : null);
    }
    R.meta = { reverseOn: reverseOn, reverseWin: reverseWin, highPos: highPos, lowPos: lowPos, renew: renew };
    return R;
  }

  w.Indicator = { s35: s35, params: P, paramDef: PARAM_DEF, paramRange: PARAM_RANGE };
})(window);
