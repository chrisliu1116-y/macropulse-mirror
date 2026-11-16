/* ============================================================
 * hot-events.js — 自动热点事件（window.HotEvents）
 * ------------------------------------------------------------
 * 解决的问题（用户原话）：
 *   「卡片你说不能自动更新，要的话只能从 A 级里抓取。但我当时只告诉你要把
 *    市场关注度高的事件做成卡片，我并没有告诉你这些事件是什么。
 *    你最好能做成市场上聚集关注度高的东西。一个事情解决之后，卡片自动关上、
 *    自动移除出去。」
 *
 * 做法：不再依赖人工维护的 w.EVENTS（那是叙事快照，写死的），
 * 改成**从新闻流里实时聚类**：
 *
 *   ① 把每条快讯映射到「主题」（地缘冲突 / 美国政治 / 美联储 / 中国政策 /
 *      AI 半导体 / 原油能源 / 黄金避险 / 关税贸易 / 亚太股市 / 美股）
 *      一条可以同时属于多个主题（「伊朗冲突推高油价」既是地缘也是能源）
 *
 *   ② 算热度：每条消息按级别加权（S=5 / A=3 / B=1），再乘时间衰减
 *      （2 小时内 ×1.0，6 小时 ×0.8，12 小时 ×0.5，24 小时 ×0.25）
 *      热度 = Σ(权重 × 衰减)
 *
 *   ③ 取热度达标的 top N 生成卡片；状态按「最近一条消息多久以前」判断：
 *      1 小时内 → 升温；1~6 小时 → 进行中；6~12 小时 → 降温；
 *      超过 12 小时没有新消息 → 直接不出现（等于自动移除）
 *
 *   ④ 事件的"解决"不靠人工判断 —— 市场不讨论了，热度自然掉下去，
 *      卡片就消失了。有新消息进来，热度回升，卡片自动重新出现。
 *
 * 输出结构与 w.EVENTS 兼容，渲染层不用改。
 * ============================================================ */
(function (w) {
  'use strict';

  /* 主题词表。一条消息命中哪个主题，就算进哪个主题的热度。
   * 词表刻意收窄：只放「市场会因为这些词跳一下」的东西，
   * 不放泛泛的财经词（比如「经济」「市场」），否则什么都能进。 */
  var TOPICS = [
    {
      id: 'geo', name: '地缘冲突', icon: '⚔️', cat: '地缘 · 风险',
      re: /伊朗|以色列|哈马斯|胡塞|真主党|俄军|乌军|乌克兰|俄罗斯|空袭|导弹|无人机|停火|开战|霍尔木兹|曼德海峡|红海|加沙|黎巴嫩|叙利亚|制裁|撤侨/
    },
    {
      id: 'uspol', name: '美国政治', icon: '🗳️', cat: '政治 · 美国',
      re: /中期选举|特朗普|川普|民主党|共和党|众议院|参议院|弹劾|白宫|国会|内阁|国情咨文|政府停摆/
    },
    {
      id: 'fed', name: '美联储与利率', icon: '🏦', cat: '货币 · 美国',
      re: /美联储|FOMC|鲍威尔|点阵图|降息|加息|联邦基金利率|美债收益率|非农|ADP|PCE|核心通胀/
    },
    {
      id: 'cn', name: '中国政策', icon: '🇨🇳', cat: '政策 · 中国',
      re: /国务院|政治局|国常会|央行|人民银行|证监会|发改委|财政部|工信部|降准|LPR|专项债|特别国债|房地产|楼市|平准基金|汇金|国家队|并购重组|退市/
    },
    {
      id: 'ai', name: 'AI 与半导体', icon: '💾', cat: '科技 · 算力',
      re: /英伟达|NVIDIA|台积电|TSMC|SK海力士|海力士|三星电子|美光|ASML|阿斯麦|HBM|存储芯片|DRAM|NAND|算力|数据中心|先进制程|光刻|寒武纪|中芯/
    },
    {
      id: 'oil', name: '原油与能源', icon: '🛢️', cat: '能源 · 大宗',
      re: /原油|布伦特|WTI|OPEC|欧佩克|油价|天然气|TTF|炼厂|成品油|燃料油|柴油|汽油/
    },
    {
      id: 'gold', name: '黄金与避险', icon: '🥇', cat: '贵金属 · 避险',
      re: /黄金|金价|白银|现货金|COMEX金|XAU|避险/
    },
    {
      id: 'trade', name: '关税与贸易', icon: '📦', cat: '贸易 · 政策',
      re: /关税|贸易战|出口管制|实体清单|反倾销|反补贴|贸易救济|禁运|断供/
    },
    {
      id: 'asia', name: '亚太股市', icon: '📈', cat: '市场 · 亚太',
      re: /日经|KOSPI|韩国综合|韩国首尔|恒生|恒指|上证|深证|创业板|A股|沪深|科创50|台湾加权/
    },
    {
      id: 'us', name: '美股', icon: '🇺🇸', cat: '市场 · 美国',
      re: /纳斯达克|纳指|标普500|道指|道琼斯|美股|费城半导体/
    }
  ];

  var LV_W = { S: 5, A: 3, B: 1, C: 0 };
  var HOUR = 3600 * 1000;

  /** 时间衰减：越新权重越高 */
  function decay(ageMs) {
    if (ageMs < 2 * HOUR) return 1.0;
    if (ageMs < 6 * HOUR) return 0.8;
    if (ageMs < 12 * HOUR) return 0.5;
    if (ageMs < 24 * HOUR) return 0.25;
    return 0;
  }

  /** 状态：按「最近一条消息多久以前」 */
  function statusOf(ageMs) {
    if (ageMs < 1 * HOUR) return { text: '升温中', cls: 'live' };
    if (ageMs < 6 * HOUR) return { text: '进行中', cls: '' };
    if (ageMs < 12 * HOUR) return { text: '降温中', cls: 'cool' };
    return null;                       // 超过 12 小时没动静 → 不出现（自动移除）
  }

  /** 热度 → 1~5 颗星（卡片上的 hot 字段） */
  function stars(score) {
    if (score >= 60) return 5;
    if (score >= 35) return 4;
    if (score >= 20) return 3;
    if (score >= 10) return 2;
    return 1;
  }

  function hhmm(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 从新闻流生成热点事件。
   * @param {Array} news  S.news（已分级、已去重）
   * @param {Object} opt  { min: 最低热度, max: 最多几条 }
   * @returns {Array} 与 w.EVENTS 同构的数组
   */
  function build(news, opt) {
    opt = opt || {};
    var minScore = opt.min || 3;
    var maxN = opt.max || 6;
    if (!Array.isArray(news) || !news.length) return [];

    var now = Date.now();
    var buckets = {};

    for (var i = 0; i < news.length; i++) {
      var n = news[i];
      if (!n || !n.title) continue;
      var age = now - (n.ts || now);
      if (age > 24 * HOUR) continue;
      /* 只用**标题**判定主题，不看正文。
       * 实测：「摩根士丹利：中期选举后美国经济有望上行」的正文里提到了原油，
       * 结果被算进「原油与能源」主题，摘要第一行全是投行观点——
       * 正文里顺带提到的词不能代表这条消息在讲什么。 */
      var text = String(n.title || '');
      /* 综述类不进主题：一条稿子塞十几件事，算进哪个主题都是错的。 */
      if (/要闻|速递|汇总|综述|盘点|早报|晚报|日报|周报|整理|直播/.test(text)) continue;
      var wgt = (LV_W[n.level] || 0) * decay(age);
      if (!wgt) continue;

      for (var j = 0; j < TOPICS.length; j++) {
        var t = TOPICS[j];
        if (!t.re.test(text)) continue;
        var b = buckets[t.id] || (buckets[t.id] = { topic: t, score: 0, items: [] });
        b.score += wgt;
        b.items.push(n);
      }
    }

    var out = [];
    Object.keys(buckets).forEach(function (k) {
      var b = buckets[k];
      if (b.score < minScore) return;
      b.items.sort(function (a, c) { return (c.ts || 0) - (a.ts || 0); });
      var latest = b.items[0];
      var st = statusOf(now - (latest.ts || now));
      if (!st) return;                 // 已结束 → 不出现

      /* 时间线：最近 6 条，按时间正序（早 → 晚），让"事情怎么演变"看得清 */
      var tl = b.items.slice(0, 6).slice().sort(function (a, c) { return (a.ts || 0) - (c.ts || 0); });

      /* 标的：把该主题下所有消息挂的品种聚合，按出现次数排序取前 6 */
      var cnt = {};
      b.items.forEach(function (x) {
        (x.direct || []).forEach(function (d) { if (d && d.k) cnt[d.k] = (cnt[d.k] || 0) + 1; });
      });
      var assets = Object.keys(cnt).sort(function (a, c) { return cnt[c] - cnt[a]; }).slice(0, 6);

      var aN = b.items.filter(function (x) { return x.level === 'A' || x.level === 'S'; }).length;

      out.push({
        id: 'auto-' + b.topic.id,
        auto: true,
        icon: b.topic.icon,
        title: b.topic.name,
        cat: b.topic.cat,
        status: st.text,
        statusCls: st.cls,
        hot: stars(b.score),
        updated: hhmm(latest.ts),
        /* 摘要用最近三条标题拼，读起来就是"现在在发生什么" */
        summary: b.items.slice(0, 3).map(function (x) { return x.title; }).join('；'),
        headline: {
          label: '近 24 小时相关消息',
          value: b.items.length + ' 条',
          sub: '其中 S/A 级 ' + aN + ' 条'
        },
        metrics: [],
        assets: assets,
        timeline: tl.map(function (x) {
          return {
            t: hhmm(x.ts),
            k: 'fact',
            d: (x.level === 'S' || x.level === 'A' ? '【' + x.level + '】' : '') + x.title
          };
        }),
        _score: Math.round(b.score * 10) / 10
      });
    });

    out.sort(function (a, c) { return c._score - a._score; });
    return out.slice(0, maxN);
  }

  w.HotEvents = { build: build, TOPICS: TOPICS };
})(window);
