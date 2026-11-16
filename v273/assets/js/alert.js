/* ============================================================================
 * alert.js — 股价预警（v167）
 *
 * 用户口径：只要「股价提醒」，参考同花顺的预警页，但**左边那一列分类不要**
 * （盘口指标 / 技术指标 / 走势异动 / 财务指标 / 选股指标），
 * 只留股价类的 8 个条件。
 *
 * 条件类型：
 *   above / below      股价涨到 / 跌到（填价格）
 *   pctUp / pctDown    日涨幅超 / 日跌幅超（填百分比）
 *   m5Up / m5Down      5 分钟涨幅超 / 跌幅超（填百分比，靠本地采样滚动窗口算）
 *   newHigh / newLow   股价创新高 / 新低（不用填，用当日最高/最低比）
 *
 * 存储：localStorage['mm_alert_v1'] = { items:[{id,k,type,val,at,firedAt}], log:[...] }
 *
 * v191 三种提醒频次（编辑预警窗口可选）：
 *   once  仅提醒一次（默认）：命中落日志 + 提醒后**自动删除这条预警**。
 *   daily 每日一次：每天最多提醒一次，次日自动重新生效，预警一直保留。
 *   multi 每日多次：每次股价「重新触及」条件都提醒（离开条件后再触及才算一次，
 *        边缘触发，避免 15s 轮询每轮都响），预警一直保留。
 * 旧数据里带 firedAt 的条目仍按原来的「重新启用」语义兼容显示。
 *
 * 局限（必须如实告诉用户）：浏览器页面关掉就没人盯着，只能靠 App 打开期间的
 * 轮询；系统通知也要用户允许。这点在界面里写清楚，不能假装是后台推送。
 * ========================================================================== */
(function (w) {
  'use strict';

  var LS = 'mm_alert_v1';

  /* 顺序与参考图一致：涨到 / 跌到 / 日涨 / 日跌 / 5分钟涨 / 5分钟跌 / 新高 / 新低 */
  var TYPES = [
    { id: 'above',   label: '股价涨到',   unit: 'price' },
    { id: 'below',   label: '股价跌到',   unit: 'price' },
    { id: 'pctUp',   label: '日涨幅超',   unit: 'pct' },
    { id: 'pctDown', label: '日跌幅超',   unit: 'pct' },
    { id: 'm5Up',    label: '5分钟涨幅超', unit: 'pct' },
    { id: 'm5Down',  label: '5分钟跌幅超', unit: 'pct' },
    { id: 'newHigh', label: '股价创新高', unit: 'days', def: 20 },
    { id: 'newLow',  label: '股价创新低', unit: 'days', def: 20 }
  ];

  function typeOf(t) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === t) return TYPES[i];
    return null;
  }

  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(LS) || '{}');
      return {
        items: Array.isArray(o.items) ? o.items : [],
        log: Array.isArray(o.log) ? o.log : []
      };
    } catch (e) { return { items: [], log: [] }; }
  }
  function persist(o) {
    try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {}
  }

  var Alert = {
    types: TYPES,
    onFire: null,        // function(item, quote, text)
    onChange: null,      // function(items)
    _buf: {},            // k -> [{t, price}]，5 分钟窗口用
    _lastHL: {},         // k -> {high, low} 当日高低（跨轮次保留最近一次有效值）
    /* 「N 日新高/新低」的参照区间，由 app.js 用日 K 算好后写进来：
     * 键 = '代码:天数'，值 = {high, low}（**已排除今天还没走完的那根**） */
    daily: {},

    all: function () { return load().items; },
    forKey: function (k) {
      return load().items.filter(function (x) { return x.k === k; });
    },
    activeKeys: function () {
      var m = {};
      load().items.forEach(function (x) { if (!x.firedAt) m[x.k] = 1; });
      return Object.keys(m);
    },
    countFor: function (k) {
      var n = 0;
      load().items.forEach(function (x) { if (x.k === k) n++; });
      return n;
    },

    add: function (k, type, val) {
      if (!k || !typeOf(type)) return null;
      var o = load();
      var item = {
        id: 'a' + Date.now() + Math.random().toString(16).slice(2, 6),
        k: k, type: type,
        val: (val == null || val === '') ? null : Number(val),
        at: Date.now(), firedAt: null, freq: 'once',
        lastFireDay: null, armed: true
      };
      if (typeOf(type).unit !== 'none' && !isFinite(item.val)) return null;
      o.items.push(item);
      persist(o);
      if (this.onChange) this.onChange(o.items);
      return item;
    },
    remove: function (id) {
      var o = load();
      o.items = o.items.filter(function (x) { return x.id !== id; });
      persist(o);
      if (this.onChange) this.onChange(o.items);
    },
    /* v191：编辑预警窗口保存时改条件数值 + 提醒频次。
     * 切换频次时把触发状态复位，避免「从仅一次改成每日一次」仍带着旧状态。 */
    update: function (id, val, freq) {
      var o = load(), found = null;
      o.items.forEach(function (x) {
        if (x.id !== id) return;
        found = x;
        x.val = Number(val);
        if (freq === 'once' || freq === 'daily' || freq === 'multi') {
          x.freq = freq;
          x.firedAt = null;
          x.lastFireDay = null;
          x.armed = true;
        }
      });
      if (!found) return null;
      persist(o);
      if (this.onChange) this.onChange(o.items);
      return found;
    },
    rearm: function (id) {
      var o = load();
      o.items.forEach(function (x) { if (x.id === id) x.firedAt = null; });
      persist(o);
      if (this.onChange) this.onChange(o.items);
    },
    clearKey: function (k) {
      var o = load();
      o.items = o.items.filter(function (x) { return x.k !== k; });
      persist(o);
      if (this.onChange) this.onChange(o.items);
    },
    clearAll: function () {
      persist({ items: [], log: [] });
      if (this.onChange) this.onChange([]);
    },
    log: function () { return load().log; },

    /* 文案：「股价涨到 1,234.00」「日涨幅超 5%」 */
    text: function (item, dec) {
      var t = typeOf(item.type);
      if (!t) return '';
      var num = function (v, d) {
        return Number(v).toLocaleString('en-US', {
          minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d
        });
      };
      if (t.unit === 'none') return t.label;
      if (t.unit === 'days') return t.label + ' ' + Math.max(2, Math.round(item.val || 20)) + '日';
      if (t.unit === 'pct') return t.label + ' ' + Math.abs(item.val) + '%';
      var d = (dec == null ? 2 : dec);
      return t.label + ' ' + num(item.val, d);
    },

    /* 采样：每轮 push 一次价格，5 分钟涨跌幅 = 当前 vs 5 分钟前最近一个样本 */
    sample: function (k, price) {
      var now = Date.now();
      var buf = this._buf[k] || (this._buf[k] = []);
      if (!buf.length || now - buf[buf.length - 1].t > 3000) buf.push({ t: now, price: price });
      while (buf.length > 2 && now - buf[0].t > 11 * 60000) buf.shift();
      return buf;
    },

    /** 检查一轮。quotes: { key: {price, pct, high, low} } */
    check: function (quotes) {
      var o = load(), fired = [], onceIds = [], stateDirty = false;
      var now = Date.now();
      var dd = new Date(now);
      var today = dd.getFullYear() + '-' + (dd.getMonth() + 1) + '-' + dd.getDate();
      for (var i = 0; i < o.items.length; i++) {
        var it = o.items[i];
        var freq = it.freq || 'once';
        /* 旧数据用 firedAt 表示「已触发且不再提醒」；新频次不写 firedAt */
        if (freq === 'once' && it.firedAt) continue;
        var q = quotes[it.k];
        if (!q || q.price == null || !isFinite(q.price)) continue;
        var price = +q.price, pct = (q.pct == null ? null : +q.pct);
        var hit = false;

        if (q.high != null && q.high > 0) this._lastHL[it.k] = { high: +q.high, low: +q.low || +q.high };

        switch (it.type) {
          case 'above':   hit = price >= it.val; break;
          case 'below':   hit = price <= it.val; break;
          case 'pctUp':   hit = pct != null && pct >= Math.abs(it.val); break;
          case 'pctDown': hit = pct != null && pct <= -Math.abs(it.val); break;
          case 'm5Up':
          case 'm5Down': {
            var buf = this.sample(it.k, price);
            var ref = null;
            for (var b = buf.length - 1; b >= 0; b--) {
              if (Date.now() - buf[b].t >= 4.5 * 60000) { ref = buf[b]; break; }
            }
            if (ref && ref.price > 0) {
              var chg = (price - ref.price) / ref.price * 100;
              hit = it.type === 'm5Up' ? chg >= Math.abs(it.val) : chg <= -Math.abs(it.val);
            }
            break;
          }
          /* v168：用户口径 —— 创新高/低不能"点一下就加"，要指定「多少日内」。
           * 参照的是**前 N 个交易日**的最高/最低（不含今天这根没走完的），
           * 所以「20日新高」＝突破过去 20 个交易日的最高价。 */
          case 'newHigh': {
            var n1 = Math.max(2, Math.round(it.val || 20));
            var d1 = this.daily[it.k + ':' + n1];
            hit = !!(d1 && d1.high > 0 && price >= d1.high * 0.99999);
            break;
          }
          case 'newLow': {
            var n2 = Math.max(2, Math.round(it.val || 20));
            var d2 = this.daily[it.k + ':' + n2];
            hit = !!(d2 && d2.low > 0 && price <= d2.low * 1.00001);
            break;
          }
        }

        /* v191：按频次决定「要不要响、响完怎么处理」。
         * · multi 用 armed 做边缘触发：条件从「不满足」翻到「满足」才响一次，
         *   否则 15s 一轮的轮询会在价格一直达标时每轮都弹提醒。 */
        if (freq === 'multi') {
          if (hit && it.armed !== false) {
            it.armed = false; stateDirty = true;
            fired.push({ item: it, at: now });
          } else if (!hit && it.armed !== true) {
            it.armed = true; stateDirty = true;
          }
          continue;
        }
        if (!hit) continue;
        if (freq === 'daily') {
          if (it.lastFireDay === today) continue;
          it.lastFireDay = today; stateDirty = true;
          fired.push({ item: it, at: now });
        } else {
          /* 仅提醒一次：落日志 + 提醒，然后自动从列表移除 */
          it.firedAt = now;
          stateDirty = true;
          fired.push({ item: it, at: now });
          onceIds.push(it.id);
        }
      }
      if (fired.length || stateDirty) {
        o.log = (o.log || []).concat(fired.map(function (f) {
          return { id: 'l' + now + Math.random().toString(16).slice(2, 5),
                   k: f.item.k, type: f.item.type, val: f.item.val, at: f.at };
        })).slice(-80);
        if (onceIds.length) {
          o.items = o.items.filter(function (x) { return onceIds.indexOf(x.id) < 0; });
        }
        persist(o);
        if (fired.length) {
          if (this.onChange) this.onChange(o.items);
          var self = this;
          fired.forEach(function (f) {
            if (self.onFire) self.onFire(f.item, quotes[f.item.k]);
          });
        }
      }
      return fired.map(function (f) { return f.item; });
    }
  };

  w.Alert = Alert;
})(window);
