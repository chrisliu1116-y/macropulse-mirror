/* ============================================================
 * volprofile.js — 品种波动率画像 + 动态波动率库（VolBank）
 * ------------------------------------------------------------
 * 三件事：
 *   ① profile()      拉近 5 日分钟线，算「每日窗口极值」分布 → 画像
 *   ② VolBank        把每天观测到的窗口极值存进 localStorage，
 *                    跨天累积成一个**会自己长大**的分布
 *   ③ dynThreshold() 用 VolBank 的经验分位 × 静态标定值加权，
 *                    得到「随行情漂移、不需要改文件」的阈值
 *
 * 【为什么要有 VolBank（用户原话）】
 *   「这个波动率的回溯应该是动态的…随着时间往前走，这个波动率
 *     是不是需要动态调整…重点是要可以实现，而不是要一直更新这个文件。」
 *
 *   静态阈值是拿 28~106 个交易日的 TradingView K 线标定出来的，
 *   它天生会过时：市场进入高波动季度，所有阈值都偏低会刷屏；
 *   进入死水期，又一条都不响。
 *
 *   VolBank 的做法：
 *     · 页面每 20 秒扫一次全池，顺手把「今天到目前为止的窗口极值」
 *       写进本地库（只增不减，取当天最大值）；
 *     · 每天第一次拉历史画像时，用**精确重算**的值覆盖前几天的临时值
 *       （页面只开半小时也不会污染数据）；
 *     · 阈值 = w·经验分位 + (1-w)·静态标定，w = min(1, 样本天数/40)
 *       → 样本少时信先验，样本多了就完全交给真实行情。
 *   收敛后阈值随市场自动漂移，不需要任何人再动 universe.js。
 *
 * 【多尺度】
 *   5 / 15 / 30 分钟三个窗口各自维护一套库与阈值：
 *   5 分钟抓闪崩，30 分钟抓趋势。
 * ============================================================ */
(function (w) {
  'use strict';

  const U = w.UNIVERSE;

  /* 品种分类 → 暴力倍数 K（经验值，仅在完全没有标定值时兜底用） */
  const CATS = {
    cn: { name: 'A股股指', K: 2.0 },
    apac: { name: '亚太股指', K: 1.7 },
    us: { name: '美股股指', K: 2.5 },
    energy: { name: '能源商品', K: 1.6 },
    metal: { name: '金属', K: 1.4 },
    crypto: { name: '加密', K: 1.8 },
    fx: { name: '外汇', K: 1.6 },
    rate: { name: '美债', K: 1.3 }
  };

  const CLASS = {
    index_cn: { floor: 0.45, ceil: 8.00, K: 2.0 },
    index_us: { floor: 0.20, ceil: 25.0, K: 2.5 },
    index_ap: { floor: 0.35, ceil: 8.00, K: 1.7 },
    crypto: { floor: 0.80, ceil: 8.00, K: 1.8 },
    energy: { floor: 0.90, ceil: 10.0, K: 1.6 },
    metal: { floor: 0.55, ceil: 8.00, K: 1.2 },
    fx: { floor: 0.05, ceil: 2.00, K: 1.6 },
    rate: { floor: 0.30, ceil: 5.00, K: 1.3 }
  };

  function classify(key) {
    const a = U.get(key);
    if (!a) return 'us';
    if (a.kind === 'yield') return 'rate';
    if (a.src === 'binance' || a.grp === 'crypto') return 'crypto';
    if (a.grp === 'fx') return 'fx';
    if (a.grp === 'energy') return 'energy';
    if (a.grp === 'metal') return 'metal';
    if (a.grp === 'ind') return 'ind';
    if (a.grp === 'cn') return 'cn';
    if (a.grp === 'apac') return 'apac';
    return 'us';
  }

  const CLASS_KEY = {
    cn: 'index_cn', apac: 'index_ap', us: 'index_us',
    crypto: 'crypto', energy: 'energy', metal: 'metal',
    ind: 'metal', fx: 'fx', rate: 'rate'
  };

  function classOf(key) {
    const c = classify(key);
    return { cat: c, cls: CLASS[CLASS_KEY[c]] || CLASS.index_us };
  }

  function quantile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
    return sorted[i];
  }

  /* ============================================================
   * ① 原始分钟线（带缓存，三个尺度共用一次请求）
   * ============================================================ */
  const BAR_CACHE = new Map();          // key → { t, bars, step }
  const BAR_TTL = 30 * 60 * 1000;
  const JINA = 'https://r.jina.ai/';

  function groupByDay(bars) {
    const days = new Map();
    for (const b of bars) {
      const d = new Date(b.t);
      const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(b);
    }
    return days;
  }

  /** 时间连续、跨度恰为 win 分钟的窗口序列 */
  function windowSeries(bars, win, step) {
    const n = Math.max(1, Math.round(win / step));
    const out = [];
    for (let i = n; i < bars.length; i++) {
      const t0 = bars[i - n].t, t1 = bars[i].t;
      const span = Math.round((t1 - t0) / 60000);
      if (span !== win) continue;              // 跨缺口/午休/隔夜 → 丢弃
      const f = bars[i - n].close;
      if (!(f > 0)) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (bars[j].high > hi) hi = bars[j].high;
        if (bars[j].low < lo) lo = bars[j].low;
      }
      out.push({ chg: (bars[i].close - f) / f * 100, amp: (hi - lo) / f * 100 });
    }
    return out;
  }

  async function fetchRawBars(key) {
    const a = U.get(key);
    if (!a) throw new Error('unknown');

    if (a.src === 'yahoo') {
      const url = `${JINA}https://query1.finance.yahoo.com/v8/finance/chart/`
        + `${encodeURIComponent(a.sym)}?interval=5m&range=1mo`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      const cut = txt.indexOf('{');
      if (cut < 0) throw new Error('no json');
      const d = JSON.parse(txt.slice(cut));
      const res = d.chart.result[0];
      const ts = res.timestamp || [];
      const q = res.indicators.quote[0];
      const off = (res.meta && res.meta.gmtoffset) || 0;
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close[i];
        if (c == null || !isFinite(c) || c <= 0) continue;
        bars.push({ t: (ts[i] + off) * 1000, close: c, high: q.high[i] || c, low: q.low[i] || c });
      }
      return { bars, step: 5 };
    }

    if (a.src === 'binance') {
      const url = `https://api.binance.com/api/v3/klines?symbol=${a.sym}&interval=1m&limit=1000`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const k = await r.json();
      return {
        bars: k.map(x => ({ t: x[0], close: +x[4], high: +x[2], low: +x[3] })),
        step: 1
      };
    }

    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get`
      + `?secid=${encodeURIComponent(a.secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8`
      + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0&iscca=0`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const rows = (d && d.data && d.data.trends) || [];
    const bars = [];
    for (const s of rows) {
      const p = s.split(',');
      if (p.length < 6) continue;
      const t = new Date(p[0].replace(' ', 'T')).getTime();
      const close = +p[2], high = +p[3], low = +p[4];
      if (!isFinite(t) || !(close > 0) || !(high > 0) || !(low > 0)) continue;
      bars.push({ t, close, high, low });
    }
    return { bars, step: 1 };
  }

  async function rawBars(key, fresh) {
    const hit = BAR_CACHE.get(key);
    if (!fresh && hit && Date.now() - hit.t < BAR_TTL) return hit;
    const v = await fetchRawBars(key);
    BAR_CACHE.set(key, { t: Date.now(), bars: v.bars, step: v.step });
    return BAR_CACHE.get(key);
  }

  /* ============================================================
   * ② 历史画像
   * ============================================================ */
  const CACHE = new Map();
  const TTL = 30 * 60 * 1000;

  async function profile(key, win) {
    const ck = key + ':' + win;
    const hit = CACHE.get(ck);
    if (hit && Date.now() - hit.t < TTL) return hit.prof;

    let prof = null;
    try {
      const { bars, step } = await rawBars(key);
      if (bars.length >= 60) {
        const days = groupByDay(bars);
        const dayMax = [];
        const perDay = {};
        const allChg = [];
        for (const [dk, list] of days) {
          const ser = windowSeries(list, win, step);
          if (ser.length < 3) continue;
          let mx = 0;
          for (const s of ser) {
            const a = Math.abs(s.chg);
            if (a > mx) mx = a;
            allChg.push(a);
          }
          dayMax.push(mx);
          perDay[dk] = mx;
        }
        allChg.sort((x, y) => x - y);
        dayMax.sort((x, y) => x - y);
        if (dayMax.length >= 2 && allChg.length >= 30) {
          prof = {
            dayMax, perDay, dayMaxMed: quantile(dayMax, 0.5),
            p95: quantile(allChg, 0.95), p99: quantile(allChg, 0.99),
            max: allChg[allChg.length - 1], n: allChg.length, days: dayMax.length
          };
        }
      }
    } catch (e) { prof = null; }

    if (prof) CACHE.set(ck, { t: Date.now(), prof });
    return prof;
  }

  /* ============================================================
   * ③ VolBank —— 会自己长大的波动率库
   * ============================================================ */
  const BANK_KEY = 'mp_volbank_v2';
  const BANK_MAX_DAYS = 150;

  let BANK = {};
  let bankDirty = false;
  let bankSavedAt = 0;

  function dk(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
  const TODAY = () => dk(Date.now());

  function loadBank() {
    try {
      const raw = w.localStorage && w.localStorage.getItem(BANK_KEY);
      if (!raw) return {};
      const d = JSON.parse(raw);
      return (d && d.v === 2 && d.keys) ? d.keys : {};
    } catch (e) { return {}; }
  }

  function saveBank(force) {
    if (!bankDirty) return;
    if (!force && Date.now() - bankSavedAt < 60 * 1000) return;
    try {
      const keys = {};
      for (const k in BANK) {
        const scales = {};
        for (const s in BANK[k]) {
          const days = BANK[k][s];
          const ds = Object.keys(days).sort();
          if (ds.length > BANK_MAX_DAYS) {
            const drop = ds.slice(0, ds.length - BANK_MAX_DAYS);
            drop.forEach(x => delete days[x]);
          }
          scales[s] = days;
        }
        keys[k] = scales;
      }
      w.localStorage.setItem(BANK_KEY, JSON.stringify({ v: 2, keys, t: Date.now() }));
      bankSavedAt = Date.now();
      bankDirty = false;
    } catch (e) { /* 隐私模式/配额满：静默降级为纯内存 */ }
  }

  function slot(key, win) {
    if (!BANK[key]) BANK[key] = {};
    if (!BANK[key][win]) BANK[key][win] = {};
    return BANK[key][win];
  }

  /** 盘中观测：当天窗口极值，只增不减 */
  function observe(key, win, v) {
    if (!(v > 0) || !isFinite(v)) return;
    const s = slot(key, win);
    const d = TODAY();
    if (!(s[d] >= v)) {
      s[d] = +v.toFixed(4);
      bankDirty = true;
    }
  }

  /** 精确回填：从历史分钟线重算出来的日极值，直接覆盖（比盘中观测准） */
  function ingestDays(key, win, perDay) {
    if (!perDay) return;
    const s = slot(key, win);
    for (const d in perDay) {
      const v = perDay[d];
      if (!(v > 0)) continue;
      s[d] = +v.toFixed(4);
      bankDirty = true;
    }
  }

  /** 取某个尺度上的历史日极值序列（默认剔除今天） */
  function seriesOf(key, win, withToday) {
    const s = BANK[key] && BANK[key][win];
    if (!s) return [];
    const today = TODAY();
    const out = [];
    for (const d in s) {
      if (!withToday && d === today) continue;
      if (s[d] > 0) out.push(s[d]);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * 动态阈值
   * @param key    品种
   * @param win    窗口（分钟）
   * @param staticThr 静态标定值（先验）
   * @param targetRate 目标触发日占比（5% / 4.5% / 4%）
   */
  function dynThreshold(key, win, staticThr, targetRate) {
    const arr = seriesOf(key, win, false);
    const n = arr.length;
    const base = staticThr > 0 ? staticThr : 0;

    if (!base || n < 10) {
      return { thr: base || classOf(key).cls.floor, src: 'prior', n, w: 0 };
    }

    // 与标定完全同一个口径：第 k 大日极值，k = 目标占比 × 样本天数
    const k = Math.max(1, Math.round((targetRate || 0.05) * n));
    const empir = arr[Math.max(0, n - 1 - k)];

    // 样本越多越信经验值
    const wEmp = Math.min(1, n / 40);
    let thr = wEmp * empir + (1 - wEmp) * base;

    // 经验值只在标定值的 0.6 ~ 2.0 倍区间内允许漂移（防脏数据打穿）
    thr = Math.max(base * 0.6, Math.min(base * 2.0, thr));

    return { thr: thr, src: n >= 25 ? 'adaptive' : 'blend', n, w: +wEmp.toFixed(2), empir: +empir.toFixed(3) };
  }

  /** 当日实时波动强度（用于事件密集日适度放宽尺子，上限 1.15） */
  function liveVol(key, win) {
    const arr = seriesOf(key, win, true);
    if (arr.length < 10) return 1;
    const today = TODAY();
    const s = BANK[key] && BANK[key][win];
    const tv = s && s[today];
    if (!(tv > 0)) return 1;
    const hist = seriesOf(key, win, false);
    const med = quantile(hist, 0.5);
    if (!(med > 0)) return 1;
    return Math.max(1, Math.min(1.6, tv / med));
  }

  w.VolProfile = {
    profile, classify, classOf, CLASS, CATS,
    windowReturns: windowSeries, quantile, rawBars,
    dynThreshold, liveVol,
    VolBank: {
      observe, ingestDays, seriesOf,
      load() { BANK = loadBank(); },
      save: saveBank,
      get size() {
        let n = 0;
        for (const k in BANK) for (const s in BANK[k]) n = Math.max(n, Object.keys(BANK[k][s]).length);
        return n;
      },
      dump() { return BANK; }
    }
  };
})(window);
