/* ============================================================
 * news-zh.js — 英文快讯中文化
 * ------------------------------------------------------------
 * 用户反馈：「刚刷新的时候出来它显示了英文，后面才又变成中文，
 *   以后这种英文的全部要翻译成中文。」
 *
 * 做法：
 *   ① 判定「这条是不是纯英文标题」（已有中文的一律不动，
 *      避免把「英伟达发布 GB200」这种中英混排翻坏）
 *   ② 三级翻译链路：
 *        translate.googleapis.com（快，2s 内返回，国内可能不通）
 *        → api.mymemory.translated.net（国内可达，稍慢）
 *        → 内置财经词表逐词替换（断网兜底，至少关键名词是中文）
 *   ③ 结果按原文缓存到 localStorage，同一条只翻一次
 *
 * 注意：翻译发生在**入库之前**（collect 里），所以后面按中文标题
 * 做的去重、品种映射、分级判断都能正常吃到中文，不会出现
 * 「英文一条、中文一条，明明同一件事却不合并」。
 * ============================================================ */
(function (w) {
  'use strict';

  const KEY = 'mp_zh_v1';
  const MAX_CACHE = 800;
  const T_GTX = 3200;
  const T_MEM = 6500;

  let dict = {};
  try {
    dict = JSON.parse(w.localStorage.getItem(KEY) || '{}') || {};
  } catch (e) { dict = {}; }
  let dirty = 0;

  function save() {
    if (!dirty) return;
    try {
      const ks = Object.keys(dict);
      if (ks.length > MAX_CACHE) {
        // 按插入顺序砍掉最老的一半（对象 key 顺序即插入顺序）
        const drop = ks.slice(0, ks.length - MAX_CACHE);
        drop.forEach(k => { delete dict[k]; });
      }
      w.localStorage.setItem(KEY, JSON.stringify(dict));
      dirty = 0;
    } catch (e) { /* 存不下就算了，不影响展示 */ }
  }

  function cjkCount(s) {
    return (String(s || '').match(/[\u4e00-\u9fa5]/g) || []).length;
  }
  function latinCount(s) {
    return (String(s || '').match(/[A-Za-z]/g) || []).length;
  }

  /** 是否「基本是中文」—— 用于判定译文 / 词表回退结果是否可用：
   *   英文单词占比过高（> 45%）或汉字不足，都视作「没翻好」。
   *   这是上一版漏掉的一环：词表回退只检查「汉字 ≥ 2」，于是
   *   「morning session close, 中国's main futures contracts」这种
   *   只把 China→中国、其余照旧的半吊子结果被当成合格译文接受了，
   *   用户端就看到了中英混杂的垃圾标题。 */
  function mostlyZh(s) {
    const t = String(s || '').trim();
    if (t.length < 3) return false;
    const zh = cjkCount(t);
    const en = latinCount(t);
    if (zh < 2) return false;
    return en <= Math.max(10, t.length * 0.45);
  }

  /** 是否「整条英文」——已有 4 个以上汉字的标题不算（中英混排不动） */
  function isEn(s) {
    const t = String(s || '').trim();
    if (t.length < 8) return false;
    const zh = cjkCount(t);
    if (zh >= 4) return false;
    const en = latinCount(t);
    return en >= 8 && en > zh * 4;
  }

  /* ---------------- 兜底词表（断网时用） ---------------- */
  const PH = [
    [/\bmatching (the )?(market )?(expectations?|forecasts?|estimates?)\b/gi, '符合市场预期'],
    [/\b(beating|beat) (the )?(market )?(expectations?|forecasts?|estimates?)\b/gi, '超出市场预期'],
    [/\b(below|missing|missed) (the )?(market )?(expectations?|forecasts?|estimates?)\b/gi, '不及市场预期'],
    [/\b(above|higher than) (the )?(market )?(expectations?|forecasts?|estimates?)\b/gi, '高于市场预期'],
    [/\b(january|jan)\b/gi, '1月'], [/\b(february|feb)\b/gi, '2月'],
    [/\b(march|mar)\b/gi, '3月'], [/\b(april|apr)\b/gi, '4月'],
    [/\bmay\b/gi, '5月'], [/\b(june|jun)\b/gi, '6月'],
    [/\b(july|jul)\b/gi, '7月'], [/\b(august|aug)\b/gi, '8月'],
    [/\b(september|sept|sep)\b/gi, '9月'], [/\b(october|oct)\b/gi, '10月'],
    [/\b(november|nov)\b/gi, '11月'], [/\b(december|dec)\b/gi, '12月'],
    [/\bpreliminary\b|\bfirst estimate\b/gi, '初值'],
    [/\brevised\b/gi, '修正'],
    [/\bfinal\b/gi, '终值'],
    [/\byear[- ]on[- ]year\b|\bYoY\b/g, '同比'],
    [/\bmonth[- ]on[- ]month\b|\bMoM\b/g, '环比'],
    [/\bquarter[- ]on[- ]quarter\b|\bQoQ\b/g, '环比'],
    [/\bseasonally adjusted\b|\bSAAR\b/g, '季调后'],
    [/\bbasis points?\b|\bbps?\b/g, '基点'],
    [/\bpercentage points?\b|\bppt\b/gi, '个百分点'],
    [/\bnonfarm payrolls?\b|\bNFP\b/g, '非农就业'],
    [/\bunemployment rate\b/gi, '失业率'],
    [/\bretail sales\b/gi, '零售销售'],
    [/\bindustrial production\b/gi, '工业产出'],
    [/\btrade balance\b/gi, '贸易帐'],
    [/\bcurrent account\b/gi, '经常帐'],
    [/\bconsumer price index\b/gi, '消费者物价指数'],
    [/\bproducer price index\b/gi, '生产者物价指数'],
    [/\binterest rate decision\b|\brate decision\b/gi, '利率决议'],
    [/\binterest rates?\b/gi, '利率'],
    [/\bcentral bank\b/gi, '央行'],
    [/\bFederal Reserve\b|\bthe Fed\b|\bFOMC\b/g, '美联储'],
    [/\bECB\b/g, '欧洲央行'],
    [/\bBOJ\b/g, '日本央行'],
    [/\bcrude oil\b|\bWTI\b|\bBrent\b/g, '原油'],
    [/\bfirst quarter\b|\bQ1\b/g, '第一季度'],
    [/\bsecond quarter\b|\bQ2\b/g, '第二季度'],
    [/\bthird quarter\b|\bQ3\b/g, '第三季度'],
    [/\bfourth quarter\b|\bQ4\b/g, '第四季度'],
    [/\bfull year\b|\bannual\b/gi, '全年'],
    [/\bUkraine\b/gi, '乌克兰'], [/\bRussia\b|\bRussian\b/gi, '俄罗斯'],
    [/\bUnited States\b|\bU\.S\.\b|\bUS\b/g, '美国'], [/\bChina\b|\bChinese\b/gi, '中国'],
    [/\bEurozone\b|\bEuro area\b/gi, '欧元区'], [/\bGermany\b|\bGerman\b/gi, '德国'],
    [/\bFrance\b|\bFrench\b/gi, '法国'], [/\bBritain\b|\bUK\b|\bBritish\b/g, '英国'],
    [/\bJapan\b|\bJapanese\b/gi, '日本'], [/\bIndia\b|\bIndian\b/gi, '印度'],
    [/\bIsrael\b|\bIsraeli\b/gi, '以色列'], [/\bIran\b|\bIranian\b/gi, '伊朗'],
    [/\bCanada\b/gi, '加拿大'], [/\bAustralia\b/gi, '澳大利亚'],
    [/\bSouth Korea\b/gi, '韩国'], [/\bTurkey\b|\bTürkiye\b/gi, '土耳其'],
    [/\bdown\b|\bfell\b|\bfalls?\b|\bdeclines?\b|\bdeclined\b|\bdrops?\b|\bdropped\b/gi, '下降'],
    [/\bup\b|\brose\b|\brisen?\b|\brises?\b|\bgains?\b|\bgained\b/gi, '上升'],
    [/\bsaid\b|\bsays\b|\bstate[sd]?\b/gi, '称'],
    [/\bannounc(ed|es|e)\b/gi, '宣布'],
    [/\bwarns?\b|\bwarned\b/gi, '警告'],
    [/\bsigns?\b|\bsigned\b/gi, '签署'],
    [/\bapproves?\b|\bapproved\b/gi, '批准'],
    [/\btariffs?\b/gi, '关税'], [/\bsanctions?\b/gi, '制裁'],
    [/\bceasefire\b/gi, '停火'], [/\bstrikes?\b|\battacks?\b/gi, '袭击'],
    [/\binflation\b/gi, '通胀'], [/\bdeflation\b/gi, '通缩'],
    [/\brecession\b/gi, '衰退'], [/\bgold\b/gi, '黄金'],
    [/\bdollar\b/gi, '美元'], [/\beuro\b/gi, '欧元'], [/\byen\b/gi, '日元'],
    [/\bstocks?\b|\bshares?\b/gi, '股市'], [/\bbonds?\b|\byields?\b/gi, '债券'],
    [/\bexports?\b/gi, '出口'], [/\bimports?\b/gi, '进口'],
    [/\bproduction\b/gi, '生产'], [/\bmanufacturing\b/gi, '制造业'],
    [/\bquarter\b/gi, '季度'], [/\bmonth\b/gi, '月'], [/\byear\b/gi, '年'],
    [/\bexpects?\b|\bexpected\b/gi, '预期'], [/\bforecasts?\b/gi, '预测'],
    [/\bgovernment\b/gi, '政府'], [/\bparliament\b/gi, '议会'],
    [/\belection\b/gi, '选举'], [/\bminister\b/gi, '部长'],
    // —— 盘面时段 / 综述词 ——
    [/\bmorning\b/gi, '早盘'], [/\bsession\b/gi, '时段'], [/\bclose\b/gi, '收盘'],
    [/\bopening\b/gi, '开盘'], [/\bmidday\b/gi, '午盘'], [/\bclosing\b/gi, '收盘'],
    [/\bmixed\b/gi, '涨跌互现'], [/\bdifferentiated\b/gi, '分化'],
    [/\bfutures\b/gi, '期货'], [/\bcontracts?\b/gi, '合约'],
    [/\bShanghai\b/gi, '沪市'], [/\bDalian\b/gi, '大连'], [/\bZhengzhou\b/gi, '郑州'],
    // —— 商品现货 / 品种名 ——
    [/\bpalladium\b/gi, '钯金'], [/\bplatinum\b/gi, '铂金'],
    [/\bsilver\b/gi, '白银'], [/\bplatinum\b/gi, '铂金'],
    [/\bcoke\b/gi, '焦炭'], [/\bcoal\b/gi, '煤炭'], [/\bcoking coal\b/gi, '焦煤'],
    [/\bbitumen\b|\basphalt\b/gi, '沥青'], [/\bmethanol\b/gi, '甲醇'],
    [/\bLPG\b/gi, '液化石油气'], [/\bpropylene\b/gi, '丙烯'], [/\bbenzene\b/gi, '苯'],
    [/\bcopper\b/gi, '铜'], [/\baluminium\b|\baluminum\b/gi, '铝'], [/\bnickel\b/gi, '镍'],
    [/\biron ore\b/gi, '铁矿石'], [/\brum\b/gi, '橡胶'], [/\bsoybean\b/gi, '大豆'],
    [/\bcrude\b/gi, '原油'], [/\bgasoline\b/gi, '汽油'], [/\bdiesel\b/gi, '柴油'],
    [/\bnatural gas\b/gi, '天然气'], [/\blumber\b/gi, '木材'], [/\bcotton\b/gi, '棉花'],
    [/\bsugar\b/gi, '糖'], [/\bwheat\b/gi, '小麦'], [/\bpalm oil\b/gi, '棕榈油'],
    // —— 涨跌动词（覆盖 rose/fell/surged 等未收录的词）——
    [/\bsurged?\b|\bspiked?\b|\bjumped?\b|\brallied?\b|\bsoared?\b/gi, '大涨'],
    [/\bclimbed?\b|\bgained?\b|\badvanced?\b|\bedged up\b/gi, '上涨'],
    [/\btumbled?\b|\bplunged?\b|\bslumped?\b|\bplummeted?\b|\bcrashed?\b|\bcollapsed?\b/gi, '大跌'],
    [/\bdropped?\b|\bdeclined?\b|\bfell\b|\bweakened?\b|\bslid?\b|\bslipped?\b/gi, '下跌'],
    [/\bmore\b/gi, '逾'], [/\babout\b/gi, '约'], [/\bnearly\b|\balmost\b/gi, '近'],
    [/\broughly\b/gi, '约'], [/\bslightly\b/gi, '微'], [/\bsharply\b/gi, '大幅'],
    [/\bdownside\b/gi, '下行'], [/\bupside\b/gi, '上行'], [/\bvolatility\b/gi, '波动'],
    [/\bhigher\b/gi, '走高'], [/\blower\b/gi, '走低'], [/\bsteady\b/gi, '持稳'],
    [/\bhit\b/gi, '触及'], [/\bbounced?\b/gi, '反弹'], [/\brecovered?\b/gi, '回升']
  ];
  const DROP = /\b(a|an|the|of|to|and|for|in|on|at|by|with|from|as|is|are|was|were|be|been|that|this|its|it|has|have|had|will|would|after|before|over|amid|into|than)\b/gi;

  /** 词表兜底翻译（同步、离线，质量一般但保证不出现整条英文） */
  function glossary(text) {
    let s = ' ' + String(text || '') + ' ';
    PH.forEach(([re, zh]) => { s = s.replace(re, zh); });
    s = s.replace(DROP, ' ');
    // 数字与中文之间、中英文之间的多余空格清掉
    s = s.replace(/[ \t]+/g, ' ')
         .replace(/([\u4e00-\u9fa5，。、：；（）%])\s+/g, '$1')
         .replace(/\s+([\u4e00-\u9fa5，。、：；（）%])/g, '$1')
         .trim();
    return s;
  }

  /* ---------------- 在线翻译 ---------------- */
  function withTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r; })
      .finally(() => clearTimeout(timer));
  }

  async function viaGtx(text) {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q='
      + encodeURIComponent(text);
    const j = await (await withTimeout(u, T_GTX)).json();
    const seg = (j && j[0]) || [];
    return seg.map(x => (x && x[0]) || '').join('').trim();
  }

  async function viaMemo(text) {
    const u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480))
      + '&langpair=en|zh-CN';
    const j = await (await withTimeout(u, T_MEM)).json();
    const t = (j && j.responseData && j.responseData.translatedText) || '';
    return String(t).trim();
  }

  /** 判断译文是否可信：必须出现若干汉字、且不是原样退回、且基本是中文 */
  function usable(src, out) {
    if (!out) return false;
    const t = String(out).trim();
    if (!t || t === src) return false;
    return mostlyZh(t);
  }

  const pending = new Map();

  /**
   * 两个通道竞速取先到的可用译文：
   *   谷歌通常 2 秒内回，但国内可能不通；MyMemory 国内可达但常要 5~8 秒。
   *   所以先发谷歌，1.6 秒还没结果就同时发 MyMemory，谁先给出可信译文用谁，
   *   整体 5.2 秒封顶 —— 避免一条英文把首屏卡十秒。
   */
  function raceTranslate(src) {
    return new Promise(resolve => {
      let done = false;
      const win = (t) => { if (!done && t) { done = true; resolve(t); } };
      viaGtx(src).then(t => { if (usable(src, t)) win(t); }).catch(() => {});
      const timer = setTimeout(() => {
        if (done) return;
        viaMemo(src).then(t => { if (usable(src, t)) win(t); }).catch(() => {});
      }, 1600);
      setTimeout(() => {
        clearTimeout(timer);
        if (!done) { done = true; resolve(''); }
      }, 5200);
    });
  }

  /** 异步翻译：缓存 → 双通道竞速 → 词表 */
  async function toZh(text) {
    const src = String(text || '').trim();
    if (!src) return '';
    if (dict[src]) return dict[src];
    if (pending.has(src)) return pending.get(src);

    const job = (async () => {
      let out = '';
      try { out = await raceTranslate(src); } catch (e) { out = ''; }
      if (!usable(src, out)) {
        const g = glossary(src);
        // 词表回退也必须「基本是中文」才接受 —— 否则宁可返回空（调用方据此丢弃），
        // 也不能把「China→中国、其余照旧」的半吊子结果当合格译文塞给用户。
        out = mostlyZh(g) ? g : '';
      }
      if (out) {
        dict[src] = out;
        dirty = 1;
        save();
      }
      return out || '';
    })();

    pending.set(src, job);
    try { return await job; } finally { pending.delete(src); }
  }

  /** 同步版：只吃缓存与词表，供渲染时兜底 */
  function toZhSync(text) {
    const src = String(text || '').trim();
    if (!src) return '';
    if (dict[src]) return dict[src];
    return glossary(src);
  }

  w.NewsZH = {
    isEn: isEn,
    toZh: toZh,
    toZhSync: toZhSync,
    glossary: glossary,
    stats: () => ({ cached: Object.keys(dict).length }),
  };
})(window);
