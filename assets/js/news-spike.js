/* ============================================================
 * news-spike.js —— 新闻驱动异动检测（新闻 → K线验证 → 关联）
 *
 * 思路（用户提出）：
 *   新闻源经常直接报道「某某品种突然拉升 / 跳水 / 闪崩 5%」。
 *   这类表述本身就是一条「疑似异动」线索，不该只当普通新闻看。
 *   但新闻会夸大、会滞后、会张冠李戴，所以必须拿真实行情去验证：
 *
 *     ① 从新闻文本解析方向（涨/跌）与幅度（%）        detect()
 *     ② 取该品种的真实分钟线，按时间连续窗口算实际涨跌幅  verify()
 *     ③ 方向一致 且 实际幅度达到「声称幅度的一半」或「该品种阈值的0.6倍」
 *        → 判定为「新闻已验证」，把这条新闻挂到异动事件上
 *     ④ 否则标记为「行情未印证」——照样展示新闻，但绝不报警
 *
 * 设计原则：
 *   · 只做验证，不造数据。行情取不到就返回 unknown，不猜。
 *   · 方向不明（同时出现涨跌词）直接放弃，避免误判。
 *   · 幅度解析取文本中绝对值最大的百分数，且限定 <100%，防「涨了1%但
 *     成交量放大300%」这类把量幅误当涨跌幅。
 * ============================================================ */
(function (w) {
  'use strict';

  // 上涨类表述
  const UP = /暴涨|大涨|急涨|猛涨|拉升|直线拉升|暴力拉升|突然拉升|急速拉升|飙升|狂飙|拉涨|猛拉|冲高|走高|涨破|升破|涨停|创新高|刷新新高|创历史新高|V型反转/;
  // 下跌类表述
  const DOWN = /暴跌|大跌|急跌|猛跌|跳水|闪崩|重挫|狂泻|杀跌|下杀|突然下杀|急速下跌|突然跳水|走低|跌破|跌停|创新低|刷新新低|创历史新低|断崖|崩盘|骤降/;

  // 明确表示「不确定/未发生/假设」的语境，命中就不当异动线索
  const HEDGE = /若|如果|假如|一旦|或将|预计|有望|恐将|可能|传闻|据悉|拟|计划|预期|警告称|分析师|策略师/;

  const PCT_RE = /([+-]?\d+(?:\.\d+)?)\s*(%|％)/g;

  /** 从新闻文本里提取「方向 + 幅度」；不是异动表述返回 null */
  function detect(item) {
    if (!item) return null;
    const text = String(item.title || '') + ' ' + String(item.brief || '');
    if (!text.trim()) return null;

    const up = UP.test(text);
    const down = DOWN.test(text);
    if (!up && !down) return null;          // 没有异动表述
    if (up && down) return null;            // 涨跌词并存，方向不明，放弃
    // 「若…则暴涨」这类假设句不是已发生的异动
    if (HEDGE.test(text) && !/已|盘中|刚刚|突然|现涨|现跌|一度/.test(text)) return null;

    // 取绝对值最大的百分数（<100%，避免把成交量/概率当涨跌幅）
    let pct = null;
    let m;
    PCT_RE.lastIndex = 0;
    while ((m = PCT_RE.exec(text))) {
      const v = Math.abs(parseFloat(m[1]));
      if (isFinite(v) && v > 0 && v < 100 && (pct === null || v > pct)) pct = v;
    }

    return { dir: up ? 1 : -1, pct: pct, word: (up ? (text.match(UP) || [''])[0] : (text.match(DOWN) || [''])[0]) };
  }

  /** 取「以 anchorTs 结尾、时间连续、跨度恰好 winMin 分钟」的窗口涨跌幅
   *  anchorTs 为秒级时间戳；不传则用最后一根 bar */
  function windowMove(bars, winMin, anchorTs) {
    if (!bars || bars.length < 3) return null;
    const target = winMin * 60;

    // 定位锚点：不传锚点用最后一根；传了就取「时间 <= 锚点」的最后一根
    let ai = bars.length - 1;
    if (anchorTs) {
      let found = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].time <= anchorTs) { found = i; break; }
      }
      // 锚点早于全部数据（新闻太旧）→ 无法验证
      if (found < 0) return null;
      ai = found;
    }
    const last = bars[ai];

    // 从锚点往前找第一根满足「时间跨度 == win」的 bar
    for (let i = ai - 1; i >= 0; i--) {
      const span = last.time - bars[i].time;
      if (span < target) continue;
      if (span > target * 1.05) break;   // 跨了缺口（隔夜/午休），放弃
      const f = bars[i].close;
      if (!(f > 0)) break;
      return { chg: (last.close - f) / f * 100, from: bars[i].time, to: last.time,
               win: winMin, at: last.time };
    }
    return null;
  }

  /**
   * 用真实行情验证新闻声称的异动。
   * @param spike  detect() 的结果
   * @param bars   API.minutes() 返回的分钟线（按时间升序）
   * @param winMin 观察窗口（分钟），与异动雷达一致，默认 30
   * @param baseThr 该品种当前的异动阈值（%），用于「新闻没给幅度」时兜底
   * @param newsTs 新闻发布时间（毫秒）。传了就按「新闻发布时刻」回溯验证，
   *               而不是用当前最新窗口——否则几小时前的拉升新闻永远对不上。
   * @returns {ok, actual, need, dir, reason}
   *   ok: true=已验证 / false=行情未印证 / null=数据不足无法验证
   */
  function verify(spike, bars, winMin, baseThr, newsTs) {
    if (!spike) return { ok: null, reason: 'no-spike' };

    // 新闻常在行情动完之后才发出，所以试几个锚点：新闻时刻、+10 分钟、+20 分钟
    const anchors = [];
    if (newsTs) {
      const base = Math.floor(newsTs / 1000);
      [0, 10, 20].forEach(m => anchors.push(base + m * 60));
    } else {
      anchors.push(null);
    }

    let best = null;
    for (const a of anchors) {
      const mv = windowMove(bars, winMin || 30, a);
      if (!mv) continue;
      const r = judge(spike, mv, baseThr);
      // 已经确定就收工；否则记下幅度最大的那次（最有利于新闻成立）
      if (r.ok === true) return r;
      if (!best || Math.abs(mv.chg) > Math.abs(best._chg)) {
        best = r;
        best._chg = mv.chg;
      }
    }
    if (!best) return { ok: null, reason: 'no-window' };
    delete best._chg;
    return best;
  }

  /** 单次判定 */
  function judge(spike, mv, baseThr) {
    const actual = mv.chg;
    const dir = actual >= 0 ? 1 : -1;
    const abs = Math.abs(actual);
    const thr = Math.max(0.05, Number(baseThr) || 0.5);

    // 需要的幅度：有声称幅度就用一半（容忍新闻夸大/滞后），否则用阈值 0.6 倍
    const need = spike.pct != null
      ? Math.max(spike.pct * 0.5, thr * 0.5)
      : thr * 0.6;

    if (dir !== spike.dir) {
      return { ok: false, actual: round(actual), need: round(need), dir: dir,
               reason: 'direction-mismatch' };
    }
    if (abs < need) {
      return { ok: false, actual: round(actual), need: round(need), dir: dir,
               reason: 'below-claim' };
    }
    return { ok: true, actual: round(actual), need: round(need), dir: dir,
             reason: 'confirmed', win: mv.win, at: mv.at };
  }

  /**
   * 多尺度验证：5 / 15 / 30 分钟各试一遍。
   *
   * 为什么要多尺度：新闻说「闪崩」可能真的是 3 分钟的事，
   * 说「走低」可能是半小时的趋势。只用一个窗口，必然有一半的新闻
   * 验不过 —— 但用户要的是「行情漏抓时新闻能补上」，
   * 所以哪个尺度先证明它动了，就用哪个。
   *
   * @param thrFn  function(win) → 该尺度的静态标定阈值
   * @returns 通过时取**最小窗口**（最快的证据）；都不通过时返回最接近的
   */
  function verifyMulti(spike, bars, wins, thrFn, newsTs) {
    if (!spike) return { ok: null, reason: 'no-spike' };
    let best = null, bestScore = -1, passed = null;
    for (const win of wins) {
      const thr = typeof thrFn === 'function' ? thrFn(win) : thrFn;
      const r = verify(spike, bars, win, thr, newsTs);
      if (r.ok === null) continue;
      const score = Math.abs(r.actual) / (r.need || 1);
      if (r.ok === true) {
        // 通过：优先取最快的时间尺度
        if (!passed || win < passed.win) passed = Object.assign({ thr: thr }, r);
      }
      if (score > bestScore) { bestScore = score; best = Object.assign({ thr: thr }, r); }
    }
    return passed || best || { ok: null, reason: 'no-window' };
  }

  function round(v) { return Math.round(v * 100) / 100; }

  w.NewsSpike = {
    detect: detect,
    verify: verify,
    verifyMulti: verifyMulti,
    windowMove: windowMove,
    _UP: UP, _DOWN: DOWN, _HEDGE: HEDGE
  };
})(window);
