/* ============================================================
 * verify.js — 消息 → 行情「影响验证」
 * ------------------------------------------------------------
 * 这个终端的核心不是「读新闻」，是回答一句话：
 *   「这条消息，实际把哪些品种打成了什么样？」
 *
 * 做法：取该标的真实 1 分钟 K 线，以消息时刻为基准点（base），
 *      算消息前 12 分钟 → 消息后 15 分钟的完整走势：
 *        · spark  走势序列（供卡片内画迷你曲线）
 *        · chg    消息后 5 分钟净变动（交易员习惯口径）
 *        · pre    消息前 15 分钟变动（有没有「资金走在新闻前面」）
 *        · day    当日涨跌幅（今天到现在一共走了多少，取自现价快照）
 *        · moved  该品种是否真的动了（按品种阈值判定）
 *
 * 为什么同时要给 day：只看「消息后 5 分钟」会严重误导 ——
 *   一条「布油失守100美元」后面写「-0.33%」，看着像没事，
 *   实际当日已经 -3.6%。5 分钟口径只说明「这条消息自己打出的边际反应」，
 *   不说明「现在价格在哪」。所以卡片主数字用当日涨跌，5 分钟退成小字。
 *
 * 输出用于回答三个具体问题：
 *   1) 地缘消息只写黄金时，原油到底动没动 → 并排给你看
 *   2) A 级里混进普通新闻 → 所有品种都没动，直接标「未兑现」
 *   3) 某个品种在动但找不到消息 → 由雷达页反向标「疑似黑天鹅」
 * ============================================================ */
(function (w) {
  'use strict';

  const U = w.UNIVERSE;
  const SKEW = -new Date().getTimezoneOffset() * 60;  // 东财时间轴是「北京时间当 UTC」
  const WINDOW = 300;                                  // 主口径：消息后 5 分钟
  const PRE_MIN = 12;                                  // 曲线往前画 12 分钟
  const POST_MIN = 15;                                 // 曲线往后画 15 分钟
  const MAX_KEYS = 4;                                  // 每条消息最多验证 4 个标的
  const MAX_AGE = 6 * 3600;                            // 超过 6 小时不再验证
  const cache = new Map();

  function realEpoch(k, bar) {
    const a = U.get(k);
    return a && a.src === 'binance' ? bar.time : bar.time - SKEW;
  }

  // 收益率类用基点，其余用相对涨跌
  function metric(k, from, to) {
    const a = U.get(k);
    if (a && a.kind === 'yield') return { v: (to - from) * 100, unit: 'bp' };
    return { v: from ? ((to - from) / from) * 100 : 0, unit: '%' };
  }

  // 「算不算动了」的分品种门槛
  function scaleOf(k) {
    const a = U.get(k);
    if (!a) return { strong: 1.0, clear: 0.35 };
    if (a.kind === 'yield') return { strong: 8, clear: 3 };               // bp
    if (a.grp === 'crypto') return { strong: 1.6, clear: 0.6 };
    if (a.grp === 'fx') return { strong: 0.5, clear: 0.15 };
    if (a.grp === 'rate') return { strong: 8, clear: 3 };
    if (a.grp === 'metal') return { strong: 0.9, clear: 0.3 };
    return { strong: 1.0, clear: 0.35 };                                 // 股指 / 原油
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 东财在短时间内连发请求会偶发空返回，重试一次再放弃
  async function barsOf(k) {
    for (let i = 0; i < 2; i++) {
      try {
        const b = await w.API.minutes(k, 480);
        if (b && b.length >= 3) return b;
      } catch (e) { /* retry */ }
      await sleep(220);
    }
    return null;
  }

  async function one(k, ts) {
    const bars = await barsOf(k);
    if (!bars) return null;

    // 找到「消息时刻之前最后一根」与「消息后 5 分钟那根」
    let bi = -1, ai = -1;
    for (let i = 0; i < bars.length; i++) {
      const rt = realEpoch(k, bars[i]);
      if (rt <= ts) bi = i;
      if (rt <= ts + WINDOW) ai = i;
    }
    if (bi < 1 || ai <= bi) return null;
    if (ts - realEpoch(k, bars[bi]) > 20 * 60) return null;  // 数据没覆盖到那个时点

    const base = bars[bi].close;          // 消息时刻的定价基准
    const from = bars[bi].close;
    const to = bars[ai].close;
    const m = metric(k, from, to);

    // 消息前 15 分钟是否已经在动 —— 「资金走在新闻前面」
    const pi = Math.max(0, bi - 15);
    const pre = metric(k, bars[pi].close, from);

    // 完整走势：以消息时刻为 0，往前 12 分钟到往后 15 分钟
    const lo = Math.max(0, bi - PRE_MIN);
    const hi = Math.min(bars.length - 1, bi + POST_MIN);
    const spark = [];
    for (let i = lo; i <= hi; i++) {
      spark.push({ i: i - bi, v: metric(k, base, bars[i].close).v });
    }

    const sc = scaleOf(k);
    const abs = Math.abs(m.v);

    return {
      k: k,
      chg: m.v,
      unit: m.unit,
      pre: pre.v,
      from: from,
      to: to,
      base: base,
      spark: spark,
      span: hi - lo,
      delay: realEpoch(k, bars[ai]) - ts,
      moved: abs >= sc.clear,
      violent: abs >= sc.strong
    };
  }

  /**
   * @returns {Promise<null|{items:Array, verdict:string, label:string, hit:number}>}
   */
  async function check(n) {
    if (!n || !n.direct || !n.direct.length) return null;
    if (cache.has(n.id)) return cache.get(n.id);

    const ts = Math.floor(n.ts / 1000);
    if (Math.abs(Date.now() / 1000 - ts) > MAX_AGE) { cache.set(n.id, null); return null; }

    const keys = n.direct.filter(x => U.get(x.k)).slice(0, MAX_KEYS).map(x => x.k);
    if (!keys.length) { cache.set(n.id, null); return null; }

    const items = [];
    for (const k of keys) {
      try {
        const r = await one(k, ts);
        if (r) items.push(r);
      } catch (e) { /* 单品种失败不影响其它 */ }
      await sleep(90);
    }
    if (!items.length) { cache.set(n.id, null); return null; }

    /* 当日涨跌：一次批量快照拿全（不逐个打接口）。
     * 拿不到就退回「5 分钟」口径 —— 宁可少一个数字，也不能显示 0 假装没跌。 */
    let snap = {};
    try { snap = (await w.API.batchQuote(keys)) || {}; } catch (e) { snap = {}; }
    items.forEach(it => {
      const q = snap[it.k];
      it.day = (q && typeof q.pct === 'number' && isFinite(q.pct)) ? q.pct : null;
      it.dayPrice = q && typeof q.price === 'number' ? q.price : null;
    });

    // 剧烈程度：取最猛的那个品种
    let rank = 0;
    items.forEach(it => {
      if (it.violent) rank = Math.max(rank, 2);
      else if (it.moved) rank = Math.max(rank, 1);
    });
    const verdict = rank === 2 ? 'violent' : rank === 1 ? 'clear' : 'flat';
    const hit = items.filter(it => it.moved).length;

    // 记下波动最大的那个，作为「这条消息实际打出了多大动静」的标题。
    // 有当日涨跌就用当日（用户看的是「现在跌了多少」，不是「消息那 5 分钟」）。
    const pick = items.filter(it => it.day != null);
    const top = (pick.length ? pick : items).slice().sort((a, b) =>
      Math.abs(pick.length ? b.day : b.chg) - Math.abs(pick.length ? a.day : a.chg))[0];
    const maxTxt = pick.length
      ? (top.day >= 0 ? '+' : '') + top.day.toFixed(2) + '%'
      : (top.chg >= 0 ? '+' : '') + (top.unit === 'bp' ? top.chg.toFixed(1) : top.chg.toFixed(2)) + top.unit;

    // 消息发出来还不到 5 分钟，或者部分品种的分钟线还没到那个时点
    const ageSec = Math.floor(Date.now() / 1000 - ts);
    const partial = ageSec < WINDOW + 90 || items.length < keys.length;

    const res = {
      items: items,
      verdict: verdict,
      hit: hit,
      maxTxt: maxTxt,
      partial: partial,
      ageMin: Math.max(0, Math.round(ageSec / 60)),
      // 「2/3 兑现」比「市场反应平淡」信息量大得多
      label: hit === 0 ? '无显著异动'
        : (hit === items.length ? '全线兑现' : hit + '/' + items.length + ' 兑现'),
      at: Date.now()
    };
    cache.set(n.id, res);
    return res;
  }

  // 批量验证（串行 + 间隔，避免一次打爆接口）
  async function checkMany(list, limit) {
    const out = {};
    const todo = (list || []).slice(0, limit || 8);
    for (const n of todo) {
      try {
        const r = await check(n);
        if (r) out[n.id] = r;
      } catch (e) {}
      await sleep(150);
    }
    return out;
  }

  function fmt(it) {
    const v = it.chg;
    const s = (v >= 0 ? '+' : '') + (it.unit === 'bp' ? v.toFixed(1) : v.toFixed(2)) + it.unit;
    return { name: U.name(it.k), text: s, up: v >= 0 };
  }

  /** 当日涨跌（拿不到快照返回 null，调用方据此退回 5 分钟口径） */
  function fmtDay(it) {
    if (!it || it.day == null) return null;
    const v = it.day;
    return {
      name: U.name(it.k),
      text: (v >= 0 ? '+' : '') + v.toFixed(2) + '%',
      up: v >= 0,
      pct: v
    };
  }

  function clearPartial() { cache.clear(); }

  w.NewsVerify = {
    check: check, checkMany: checkMany, fmt: fmt, fmtDay: fmtDay,
    scaleOf: scaleOf, clear: clearPartial
  };
})(window);
