/* ============================================================
 * predict.js — 预测市场实时概率（window.Predict）
 * ------------------------------------------------------------
 * 解决的问题（用户原话）：
 *   「中期选举的概率预测、俄乌会谈的时间、霍尔木兹的通行情况、
 *    美联储的加息概率，如果都是固定的就太可惜了，这些肯定要能自动更新。
 *    图表做得那么漂亮，当然要让它能随真实事件的变化而变化。」
 *
 * 数据源：Polymarket（全球最大的预测市场，真金白银定价）。
 *   · 概率 = 合约的 yes 价格（0~1），乘 100 就是百分比
 *   · 它比任何"模型预测"都硬：有人拿钱在赌
 *
 * 通道：gamma-api 没有 CORS 头，浏览器直连会被拦 → 走 r.jina.ai 代理。
 *   实测：`https://r.jina.ai/https://gamma-api.polymarket.com/...` 可用。
 *
 * 【为什么不再用 slug 直查】
 *   Polymarket 的 event slug 现在带一串创建时间戳后缀：
 *     fed-decision-in-december-20260729232808632
 *   写死 slug（fed-decision-in-december）会返回 `[]` —— 上一版就是这么挂的：
 *   图表里的概率永远停在快照值，看起来「实时更新没生效」，其实是查不到。
 *   现在改成：**关键词搜索 → 标题正则认人 → 取结束时间最晚的那个未结算盘口**。
 *   同一件事每年都会重开一盘（Fed Decision in December? 有 2024/2025/2026 三个），
 *   按 endDate 取最晚的，天然拿到「当前这一届」。
 *
 * 用法（在 events.js 的 metric 上配一行）：
 *   { name: '12月加息概率', value: 79,
 *     pred: { q: 'fed decision december', event: 'Fed Decision in December',
 *             market: 'increases interest rates', outcome: 'Yes' } }
 *   · q      —— 搜索词（越独特越好，但要能在搜索结果里出现）
 *   · event  —— 事件标题的正则，用来认人（'Fed Decision in December'）
 *   · market —— 事件下多个子市场时，用关键词/正则挑一个（'increases interest rates'）
 *   · slug   —— 旧写法，仍兼容，但官方 slug 一变就失效，别再用
 * 拿不到就保留原值并标「快照」。
 * ============================================================ */
(function (w) {
  'use strict';

  var API = 'https://gamma-api.polymarket.com/';
  var PROXY = 'https://r.jina.ai/';
  /* 缓存时长。事件页每 30 秒重绘一次，会重新问 prob()，
   * 真正决定「多久变一次」的就是这个 TTL：
   *   5 分钟 —— 用户反馈「数字半天不动」，体感是死的
   *   2 分钟 —— 预测市场的合约价本来就以分钟级波动，再快只是白耗代理
   * 四个指标 × 每 2 分钟 ≈ 2 次请求/分钟，公共代理完全扛得住。 */
  var TTL = 2 * 60 * 1000;

  var cache = {};                    // slug -> { at, data }
  var inflight = {};

  function now() { return Date.now(); }

  /** 剥掉代理包装（jina 会把 JSON 包在「Markdown Content:」后面） */
  function unwrap(text) {
    var s = String(text || '');
    var i = s.indexOf('[');
    var j = s.indexOf('{');
    var k = i < 0 ? j : (j < 0 ? i : Math.min(i, j));
    return k >= 0 ? s.slice(k) : s;
  }

  /** 从搜索结果里挑出「当前这一届」事件：
   *  ① 未结算 ② 标题匹配 event 正则 ③ endDate 最晚的那个。
   *  最后一条是关键：Fed Decision in December? 每年一盘，靠它区分 2026 / 2025。 */
  function pickEvent(list, eventRe) {
    var re = eventRe ? new RegExp(eventRe, 'i') : null;
    var arr = (list || []).filter(function (e) {
      if (!e || e.closed) return false;
      if (re && !re.test(e.title || '')) return false;
      return true;
    });
    if (!arr.length) return null;
    arr.sort(function (a, b) {
      return new Date(b.endDate || 0).getTime() - new Date(a.endDate || 0).getTime();
    });
    return arr[0];
  }

  /** 在事件的子市场里按关键词挑一个；**优先未结算的**。
   *  已结算盘口的价格是 0/1 定值，当成「实时概率」显示会误导 ——
   *  用户看到「美伊停火延续至年底 0%」以为是抓取坏了，
   *  实际是那个 12-31 盘口已经结算为 No（停火没延续到年底），价格被钉在 0。 */
  function pickMarket(markets, kw) {
    var list = markets || [];
    var re = kw ? new RegExp(kw, 'i') : null;
    var byKw = re ? list.filter(function (m) { return re.test(m.question || ''); }) : list.slice();
    if (!byKw.length) byKw = list.slice();
    var open = byKw.filter(function (m) { return !m.closed; });
    return open[0] || byKw[0] || null;
  }

  /* 【v169 关键修复】之前**无条件**走 r.jina.ai 代理取数，而 jina 的免费额度
   * 经常 401/429（实测），代理一挂 → 卡片永远停在 events.js 里写死的快照值
   * （就是「Polymarket · 11-05」那种，其实是几天前人工填的）。
   * 实测 gamma-api 现在会回 `access-control-allow-origin: *`，浏览器**可以直连**，
   * 所以改成：先直连（快且稳），失败再退回 jina。 */
  function fetchJson(path) {
    var url = API + path;
    var direct = fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    return direct.catch(function () {
      return fetch(PROXY + url, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (t) { return JSON.parse(unwrap(t)); });
    });
  }

  /* ---------------- 日快照 ----------------
   * 用户口径：「这种重磅事件一天更新一次就行，除非短时间发生了重大变化」。
   * 也就是说卡片上真正需要的不是秒级跳动，而是「比昨天动了多少」。
   * 做法：每天第一次拿到某个合约的价格时存一份，之后一律拿它当基准，
   * 跨天自动滚动（今天的值变成明天的「昨日」）。
   */
  var DAY_KEY = 'mm_pred_day_v1';

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function readDays() {
    try { return JSON.parse(w.localStorage.getItem(DAY_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function writeDays(o) {
    try { w.localStorage.setItem(DAY_KEY, JSON.stringify(o)); } catch (e) { /* 隐私模式 */ }
  }

  /** 返回上一个有记录日子的值（没有就 null） */
  function dayBase(key, p) {
    var all = readDays(), t = todayStr(), rec = all[key];
    if (!rec || rec.d !== t) {
      all[key] = { d: t, p: p, prev: rec ? rec.p : null, prevD: rec ? rec.d : '' };
      writeDays(all);
      rec = all[key];
    }
    return rec.prev == null ? null : { p: rec.prev, d: rec.prevD };
  }

  /** 从一个 market 里取指定 outcome 的价格（0~1） */
  function priceOf(market, outcome) {
    if (!market) return null;
    var outs, prices;
    try { outs = JSON.parse(market.outcomes || '[]'); } catch (e) { outs = []; }
    try { prices = JSON.parse(market.outcomePrices || '[]'); } catch (e) { prices = []; }
    if (!prices.length) return null;
    if (!outcome) return parseFloat(prices[0]);          // 默认取第一个（多为 Yes）
    var idx = outs.findIndex(function (o) {
      return String(o).toLowerCase() === String(outcome).toLowerCase();
    });
    if (idx < 0) return null;
    return parseFloat(prices[idx]);
  }

  /** 同步取「上次拿到的值」（不发请求）。
   *  作用：事件页每 30 秒整块重绘一次，如果首屏还用它写死的快照值，
   *  屏幕上会先闪一下旧数再跳回实时值 —— 用这个缓存值垫着就不会。
   *  @returns {{p:number,title:string,at:number}|null} */
  function instant(cfg) {
    if (!cfg) return null;
    var key = [cfg.q || '', cfg.slug || '', cfg.event || '', cfg.outcome || '', cfg.market || ''].join('|');
    var c = cache[key];
    return (c && c.data) ? c.data : null;
  }

  /**
   * 取一个市场的实时概率。
   * @param {Object} cfg { slug, outcome, market }
   *   slug    —— Polymarket 事件 slug
   *   outcome —— 'Yes' / 'Democratic' / ...，缺省取第一个结果
   *   market  —— 事件下多个子市场时，用关键词挑一个（如 'December'）
   * @returns {Promise<{p:number, title:string, at:number}|null>}  p 是 0~100
   */
  function prob(cfg) {
    if (!cfg || (!cfg.slug && !cfg.q)) return Promise.resolve(null);
    var key = [cfg.q || '', cfg.slug || '', cfg.event || '', cfg.outcome || '', cfg.market || ''].join('|');
    var c = cache[key];
    if (c && now() - c.at < TTL) return Promise.resolve(c.data);
    if (inflight[key]) return inflight[key];

    /* 两条通道：
     *   q     —— public-search，结果里直接带 markets + outcomePrices，
     *            一次请求就够（顺带绕开 slug 后缀问题）
     *   slug  —— 旧接口，只在没有 q 时兜底 */
    var path = cfg.q
      ? 'public-search?q=' + encodeURIComponent(cfg.q) + '&limit_per_type=10'
      : 'events?slug=' + encodeURIComponent(cfg.slug);

    inflight[key] = fetchJson(path)
      .then(function (res) {
        var ev;
        if (cfg.q) {
          ev = pickEvent((res && res.events) || [], cfg.event);
        } else {
          ev = Array.isArray(res) ? res[0] : res;
        }
        if (!ev) return null;
        var mk = pickMarket(ev.markets, cfg.market);
        var p = priceOf(mk, cfg.outcome);
        if (p == null || !isFinite(p)) return null;
        var val = Math.round(p * 1000) / 10;    // 0~100，保留一位小数
        var data = {
          p: val,
          base: dayBase(key, val),              // { p: 昨日值, d: 日期 } 或 null
          title: (mk && mk.question) || ev.title || '',
          slug: ev.slug,
          at: now(),
          /* 已结算盘口：价格是定值 0/1，UI 要标「已结算」而不是「实时」 */
          settled: !!(mk && mk.closed),
          yes: (val >= 50)
        };
        cache[key] = { at: now(), data: data };
        return data;
      })
      .catch(function () { return null; })
      .then(function (r) { delete inflight[key]; return r; });

    return inflight[key];
  }

  /**
   * 按关键词搜当前**未结算**的市场，用来给新事件快速找合约。
   * @returns {Promise<Array<{slug,title,p}>>}
   */
  function search(term, limit) {
    if (!term) return Promise.resolve([]);
    return fetchJson('public-search?q=' + encodeURIComponent(term) + '&limit_per_type=6')
      .then(function (d) {
        var evs = (d && d.events) || [];
        return evs
          .filter(function (e) { return !e.closed; })
          .map(function (e) {
            var m = (e.markets || [])[0];
            return { slug: e.slug, title: e.title, p: priceOf(m) };
          })
          .filter(function (x) { return x.slug; })
          .slice(0, limit || 5);
      })
      .catch(function () { return []; });
  }

  w.Predict = {
    prob: prob, search: search, instant: instant,
    _priceOf: priceOf, _pickEvent: pickEvent, _pickMarket: pickMarket
  };
})(window);
