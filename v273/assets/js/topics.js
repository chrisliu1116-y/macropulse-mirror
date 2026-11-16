/* ============================================================
 * topics.js — 快讯「类别」体系（与「级别」正交）
 * ------------------------------------------------------------
 * 级别（S / A / B / C）只表达「有多重要」；
 * 类别（中国政策 / 海外央行 / 地缘 / 关税 …）只表达「属于哪一类」。
 * 判定口径：
 *   · 宏观政策 = 我国央行政策 + 针对 A 股的重大政策 + 财政政策
 *     （美国财政部拍卖国债、美联储议息属于「美债 / 海外央行」，不在此列）
 *   · 不再设「公司与机构」类别 —— 本终端以黑天鹅为优先，
 *     一般公司新闻不进信息流；极少数能打出全市场波动的事件
 *     会自动落到「信用风险」或对应资产类别里。
 * ============================================================ */
(function (w) {
  'use strict';

  const TOPICS = [
    { id: 'all',     label: '全部' },
    { id: 'policy',  label: '中国政策' },
    { id: 'cb',      label: '海外央行' },
    { id: 'politics',label: '政治事件' },
    { id: 'geo',     label: '地缘冲突' },
    { id: 'tariff',  label: '关税贸易' },
    { id: 'data',    label: '经济数据' },
    { id: 'energy',  label: '能源原油' },
    { id: 'metal',   label: '贵金属' },
    { id: 'rate',    label: '美债' },
    { id: 'fx',      label: '汇率' },
    { id: 'cn',      label: 'A股' },
    { id: 'us',      label: '美股' },
    { id: 'crypto',  label: '加密' },
    { id: 'firm',    label: '公司事件' },
    { id: 'credit',  label: '信用风险' }
  ];

  // 分级器给出的 cat → 类别
  const CAT2TOPIC = {
    '中国政策': ['policy', 'cn'],
    '海外央行': ['cb'],
    '政治事件': ['politics'],
    '科技政策': ['us', 'politics'],
    '海外政策': ['policy', 'us'],
    '地缘':     ['geo'],
    '关税':     ['tariff'],
    '宏观数据': ['data'],
    '美债':     ['rate'],
    '能源':     ['energy'],
    '加密':     ['crypto'],
    '信用风险': ['credit'],
    '汇率':     ['fx'],
    // 以下不再单独设类别，靠资产反推落到具体市场
    // 「公司重大」= 十亿级回购/重组这类重磅公司事件，极少数能进信息流，
    // 单独给一个标签，免得被归到「中国政策」里（那是最容易误导人的错标）。
    '公司重大': ['firm'],
    '公司事项': [],
    /* 汇编/综述稿（早间要闻汇总、收盘综述…）不归任何科目 ——
     * 它讲的是十几件互不相关的事，贴在「中国政策」上纯属误导。 */
    '市场综述': [],
    '机构观点': [],
    '资金流':   [],
    '行情播报': [],
    '杂讯':     [],
    '重要快讯': [],
    // 旧口径别名（离线样例库 / 服务端历史数据兼容）
    '货币政策': ['cb'],
    'A股政策':  ['policy', 'cn'],
    '政策部委': ['policy'],
    '央行':     ['cb'],
    '利率':     ['rate'],
    '权益':     ['us'],
    '监管':     ['policy'],
    '财报':     [],
    '公司公告': [],
    '公司增减持': []
  };

  // 资产 → 类别
  const ASSET2TOPIC = {
    BRENT: 'energy', WTI: 'energy', NG: 'energy',
    GOLD: 'metal', SILVER: 'metal',
    SPX: 'us', NDX: 'us', SOX: 'us', DJI: 'us',
    AX: 'cn', HS300: 'cn', SZ: 'cn', CYB: 'cn', SZ50: 'cn', KC50: 'cn',
    BTC: 'crypto', ETH: 'crypto', SOL: 'crypto',
    US5Y: 'rate', US10Y: 'rate', US30Y: 'rate',
    DXY: 'fx', USDCNH: 'fx', USDJPY: 'fx', EURUSD: 'fx'
  };

  function topicsOf(n) {
    const out = [];
    const add = (t) => { if (t && out.indexOf(t) < 0) out.push(t); };
    (CAT2TOPIC[n.cat] || []).forEach(add);
    [].concat(n.direct || [], n.cn || []).forEach(x => add(ASSET2TOPIC[x.k]));
    if ((n.cn || []).length) add('cn');
    const a0 = (n.direct || [])[0];
    if (a0) {
      const U = w.UNIVERSE;
      const a = U.get(a0.k);
      if (a && a.grp === 'usstock') add('us');
    }
    return out;
  }

  function label(id) {
    const t = TOPICS.find(x => x.id === id);
    return t ? t.label : id;
  }

  // 分类标签里已经写了「地缘」，就不必再重复显示「地缘冲突」
  function catTopics(cat) { return CAT2TOPIC[cat] || []; }

  w.TOPICS = { LIST: TOPICS, of: topicsOf, label: label, catTopics: catTopics };
})(window);
