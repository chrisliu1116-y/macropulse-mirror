/* ============================================================
 * pool.js — 本地快讯池（window.NewsPool）
 * ------------------------------------------------------------
 * 解决的问题（用户原话）：
 *   「每次打开 H5 都是刷新抓取的，而且只抓取最近几条。
 *    如果我没打开页面的时候有暴涨暴跌我也不知道。」
 *
 * 做法：把**已经富化过**（已分级 + 已翻译 + 已打标）的快讯条目
 * 落进 localStorage，打开页面时先用池子立刻铺满首屏，再去联网补增量。
 *
 * 结构：localStorage['mm_pool_v1'] = { v:1, t:<毫秒>, items:[...] }
 *   items 里每条都保留原有字段（id/ts/title/brief/src/url/level/cat/
 *   direct/cn/chain/noAsset/firm/stocks/important/titleEn/briefEn），
 *   不做二次加工 —— 这里只负责「存、取、裁」，分级口径仍归 news-live-client.js。
 *
 * 三条硬约束：
 *   ① 保留 72 小时（3 天），容量上限 800 条，超限按 ts 从旧往新丢；
 *   ② 写入 debounce 5 秒（合并多次写入，不每条都序列化整个数组）；
 *      QuotaExceededError 时先裁到 400、再裁到 200 重试，且不抛错打断渲染；
 *   ③ localStorage 不可用（隐私模式 / 配额为 0）→ 自动降级为纯内存，
 *      所有函数都被 try/catch 包住，任何异常都不让页面挂掉。
 * ============================================================ */
(function (w) {
  'use strict';

  var KEY = 'mm_pool_v2';
  /* VER = 映射规则版本。
   * 缓存里存的是**已经 enrich 过**的条目（含 direct/cn/us 挂载），
   * 一旦映射规则改了，旧缓存里的挂载就是按老规则算的 —— 会继续把
   * 「A 股上市辅导」挂到纳斯达克下面，用户看到的还是错的。
   * 所以规则一改就升 VER，版本对不上直接丢弃旧缓存重抓。 */
  var VER = 2;
  var MAX = 800;           // 容量上限
  var KEEP_H = 72;         // 保留小时数
  var SAVE_DELAY = 5000;   // 写入 debounce（约 5 秒合并一次）

  var mem = [];
  var ready = false;
  var memOnly = false;     // true = 只走内存（localStorage 不可用）
  var timer = null;
  var lastErr = '';
  var savedAt = 0;

  function now() { return Date.now(); }

  /** 取 localStorage（某些环境下一访问就抛，所以整段包住） */
  function LS() {
    if (memOnly) return null;
    try {
      var ls = w.localStorage;
      if (!ls) { memOnly = true; return null; }
      return ls;
    } catch (e) {
      memOnly = true;
      lastErr = String((e && e.message) || e);
      return null;
    }
  }

  /** 只留结构化需要的字段，砍掉可能膨胀的临时属性 */
  function slim(it) {
    if (!it || typeof it !== 'object') return null;
    var id = it.id == null ? '' : String(it.id);
    var ts = Number(it.ts || 0);
    var title = String(it.title || '');
    if (!id || !ts || !title) return null;
    return {
      id: id,
      ts: ts,
      title: title.slice(0, 200),
      brief: String(it.brief || '').slice(0, 400),
      src: String(it.src || ''),
      url: String(it.url || ''),
      level: String(it.level || 'B').toUpperCase().slice(0, 1),
      cat: String(it.cat || ''),
      region: String(it.region || ''),
      direct: Array.isArray(it.direct) ? it.direct.slice(0, 6) : [],
      cn: Array.isArray(it.cn) ? it.cn.slice(0, 4) : [],
      us: Array.isArray(it.us) ? it.us.slice(0, 5) : [],
      /* v123：港股映射独立成槽（原来与 A 股混在一起，美股/港股会被误挂进 A 股） */
      hk: Array.isArray(it.hk) ? it.hk.slice(0, 5) : [],
      chain: Array.isArray(it.chain) ? it.chain.slice(0, 4) : null,
      noAsset: !!it.noAsset,
      firm: !!it.firm,
      live: it.live === false ? false : true,
      stocks: Array.isArray(it.stocks) ? it.stocks.slice(0, 6) : [],
      important: !!it.important,
      /* 【关键】必须存分级口径版本号。
       * 不存的话，hydrateFromPool 拿到的每条 it.gv 都是 undefined，
       * 永远不等于当前 GRADE_VER —— 于是每次启动/重载都把整个缓存
       * 当成"旧口径"全量重算一遍。重算用的是精简字段，一部分条目
       * 会被判成 C 直接丢弃，用户看到的就是"刷新后 72 条变 11 条"。
       * 存了 gv，同口径的条目原样复用，条数不会凭空蒸发。 */
      gv: Number(it.gv || 0) || 0,
      titleEn: String(it.titleEn || '').slice(0, 300),
      briefEn: String(it.briefEn || '').slice(0, 400)
    };
  }

  function sortDesc(list) {
    return list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  }

  /** 超容量 → 从最旧的开始丢 */
  function trimCap() {
    if (mem.length <= MAX) return false;
    sortDesc(mem);
    mem = mem.slice(0, MAX);
    return true;
  }

  /** 裁到指定条数（配额不足时用），同样按 ts 保留最新的 */
  function trimTo(n) {
    if (mem.length <= n) return;
    sortDesc(mem);
    mem = mem.slice(0, n);
  }

  /* ---------------- 对外 API ---------------- */

  /** 从 localStorage 读进内存。重复调用只读一次。 */
  function load() {
    try {
      if (ready) return mem;
      ready = true;
      var ls = LS();
      if (!ls) return mem;
      var raw = ls.getItem(KEY);
      if (!raw) return mem;
      var obj = JSON.parse(raw);
      /* 版本对不上 = 映射规则已经改了，缓存里的挂载是按老规则算的。
       *
       * 【不再整池丢弃】旧逻辑是 removeItem(KEY) 直接清空 ——
       * 用户 72 小时攒下的新闻瞬间归零，重载后首屏空、只能干等一轮网络
       * 把新闻重新抓回来（用户看到的就是「全屏空白近 10 秒，新闻重新刷新进来」）。
       * 现在改成「剥掉派生字段、保留原文」：标题 / 时间 / 来源 / 标红标记 /
       * stocks 这些**原始数据**跟映射规则无关，完全可复用；
       * 只有 direct / cn / chain 这些按老规则算出来的挂载需要作废重算。
       * 用 gv=0 标记，前端 hydrateFromPool 会用当前规则重新 enrich。 */
      var arr = (obj && Array.isArray(obj.items)) ? obj.items : (Array.isArray(obj) ? obj : []);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.v !== VER) {
        for (var m = 0; m < arr.length; m++) {
          var om = arr[m];
          if (!om || typeof om !== 'object') continue;
          om.direct = [];
          om.cn = [];
          om.us = [];
          om.hk = [];
          om.chain = [];
          om.gv = 0;
        }
        // 洗一次就按新版本落盘，避免每次启动都重洗
        try { ls.setItem(KEY, JSON.stringify({ v: VER, t: obj.t || now(), items: arr })); } catch (em) {}
      }
      var out = [];
      var seen = Object.create(null);
      for (var i = 0; i < arr.length; i++) {
        var o = slim(arr[i]);
        if (!o) continue;
        if (seen[o.id]) continue;      // 同 id 只留第一条
        seen[o.id] = 1;
        out.push(o);
      }
      mem = sortDesc(out);
      prune();                         // 顺手清掉超过 72 小时的（prune() 不传参＝按 KEEP_H 裁）
      return mem;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (!Array.isArray(mem)) mem = [];
      return mem;
    }
  }

  /**
   * 合并条目（按 id 去重），返回**新增**条数。
   * 已存在的 id 不覆盖：池子里那份是富化过的，优先级更高。
   */
  function merge(items) {
    try {
      load();
      if (!items || !items.length) return 0;
      var have = Object.create(null);
      for (var i = 0; i < mem.length; i++) have[mem[i].id] = mem[i];
      var added = 0, upgraded = 0;
      for (var j = 0; j < items.length; j++) {
        var o = slim(items[j]);
        if (!o) continue;
        var old = have[o.id];
        if (old) {
          /* 同 id 已有：默认不覆盖（池子里那份是富化过的、更完整）。
           * 但【分级口径版本】不同时必须覆盖 —— 只补 gv 字段、保留原有富化内容，
           * 这样既不会每次启动都重算，也不会把池子的挂载信息冲掉。 */
          if ((Number(old.gv) || 0) !== (Number(o.gv) || 0) && o.gv) {
            old.gv = o.gv;
            upgraded++;
          }
          continue;
        }
        have[o.id] = o;
        mem.push(o);
        added++;
      }
      if (added || upgraded) {
        sortDesc(mem);
        prune(KEEP_H);                   // 抓回来的旧闻（部分源会给几天前的条目）同样只留 72 小时
        trimCap();
        scheduleSave();
      }
      return added;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      return 0;
    }
  }

  /**
   * 丢弃超过 hours 小时的条目（默认 72）。
   * @returns 丢掉的条数
   */
  function prune(hours) {
    try {
      var h = (hours == null || !isFinite(hours)) ? KEEP_H : Number(hours);
      if (!(h > 0)) return 0;
      var cut = now() - h * 3600 * 1000;
      var before = mem.length;
      var out = [];
      for (var i = 0; i < mem.length; i++) {
        if (mem[i] && mem[i].ts >= cut) out.push(mem[i]);
      }
      mem = out;
      trimCap();
      var dropped = before - mem.length;
      if (dropped > 0) scheduleSave();
      return dropped;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      return 0;
    }
  }

  /** 取最近 hours 小时的条目，按 ts 倒序（默认 72）。返回浅拷贝，调用方可随意改。 */
  function list(hours) {
    try {
      load();
      var h = (hours == null || !isFinite(hours)) ? KEEP_H : Number(hours);
      var cut = now() - h * 3600 * 1000;
      var out = [];
      for (var i = 0; i < mem.length; i++) {
        var it = mem[i];
        if (!it || !(it.ts >= cut)) continue;
        out.push({
          id: it.id, ts: it.ts, title: it.title, brief: it.brief,
          src: it.src, url: it.url, level: it.level, cat: it.cat,
          region: it.region,
          direct: Array.isArray(it.direct) ? it.direct.map(function (x) { return { k: x && x.k, d: (x && x.d) || 0, note: (x && x.note) || '' }; }) : [],
          cn: Array.isArray(it.cn) ? it.cn.map(function (x) { return { k: x && x.k, d: (x && x.d) || 0, note: (x && x.note) || '' }; }) : [],
          us: Array.isArray(it.us) ? it.us.map(function (x) { return { k: x && x.k, d: (x && x.d) || 0, note: (x && x.note) || '' }; }) : [],
          hk: Array.isArray(it.hk) ? it.hk.map(function (x) { return { k: x && x.k, d: (x && x.d) || 0, note: (x && x.note) || '' }; }) : [],
          chain: Array.isArray(it.chain) ? it.chain.slice() : null,
          noAsset: !!it.noAsset,
          firm: !!it.firm,
          live: it.live !== false,
          stocks: Array.isArray(it.stocks) ? it.stocks.slice() : [],
          important: !!it.important,
          gv: Number(it.gv || 0) || 0,
          titleEn: it.titleEn || '',
          briefEn: it.briefEn || ''
        });
      }
      return sortDesc(out);
    } catch (e) {
      lastErr = String((e && e.message) || e);
      return [];
    }
  }

  /** 立即落盘。失败时按 400 → 200 逐级裁剪重试（最低 200 条，保证还能继续跑）。 */
  function save() {
    try {
      timer = null;
      var ls = LS();
      if (!ls) return false;                 // 纯内存模式
      var payload;
      try {
        payload = JSON.stringify({ v: VER, t: now(), items: mem });
      } catch (e) {
        lastErr = 'stringify: ' + String((e && e.message) || e);
        return false;
      }
      try {
        ls.setItem(KEY, payload);
        savedAt = now();
        return true;
      } catch (e1) {
        lastErr = String((e1 && e1.message) || e1);
      }
      // 配额不够 → 裁到 400 再试，仍不行裁到 200（此时只保最新 200 条，页面照跑）
      var ladders = [400, 200];
      for (var i = 0; i < ladders.length; i++) {
        try {
          trimTo(ladders[i]);
          ls.setItem(KEY, JSON.stringify({ v: VER, t: now(), items: mem }));
          savedAt = now();
          return true;
        } catch (e2) {
          lastErr = String((e2 && e2.message) || e2);
        }
      }
      return false;                          // 彻底写不进去 → 继续用内存那份
    } catch (e) {
      lastErr = String((e && e.message) || e);
      return false;
    }
  }

  function scheduleSave() {
    try {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { save(); }, SAVE_DELAY);
    } catch (e) { /* 定时器都挂了就放弃落盘，内存照用 */ }
  }

  function stats() {
    try {
      load();
      var byLevel = { S: 0, A: 0, B: 0, C: 0 };
      var oldest = 0, newest = 0;
      for (var i = 0; i < mem.length; i++) {
        var it = mem[i];
        if (byLevel[it.level] != null) byLevel[it.level]++;
        if (!oldest || it.ts < oldest) oldest = it.ts;
        if (it.ts > newest) newest = it.ts;
      }
      return {
        total: mem.length,
        byLevel: byLevel,
        oldest: oldest,
        newest: newest,
        spanH: oldest ? +((now() - oldest) / 3600000).toFixed(1) : 0,
        max: MAX,
        keepH: KEEP_H,
        memoryOnly: !!memOnly,
        savedAt: savedAt,
        err: lastErr
      };
    } catch (e) {
      return { total: 0, byLevel: { S: 0, A: 0, B: 0, C: 0 }, oldest: 0, newest: 0, spanH: 0, max: MAX, keepH: KEEP_H, memoryOnly: true, savedAt: 0, err: String((e && e.message) || e) };
    }
  }

  /** 清空（设置页一键重置时用） */
  function clear() {
    try {
      mem = [];
      ready = true;
      if (timer) { clearTimeout(timer); timer = null; }
      var ls = LS();
      if (ls) ls.removeItem(KEY);
      return true;
    } catch (e) { return false; }
  }

  // 关页前把 debounce 里攒的那一次写掉，避免最后 1.5 秒的新条目丢失
  try {
    if (w.addEventListener) {
      w.addEventListener('pagehide', function () { try { if (timer) save(); } catch (e) {} });
      w.addEventListener('beforeunload', function () { try { if (timer) save(); } catch (e) {} });
    }
  } catch (e) {}

  w.NewsPool = {
    KEY: KEY,
    load: load,
    merge: merge,
    prune: prune,
    list: list,
    save: save,
    stats: stats,
    clear: clear
  };
})(window);
