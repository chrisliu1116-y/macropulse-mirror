/* ============================================================
 * events.js — 事件追踪数据
 * ------------------------------------------------------------
 * 当前全球瞩目的重点事件（人工甄选 + 定期维护），驱动「事件追踪」页。
 * 每条事件 = 一张卡片；点开卡片看预测、现状、时间线、相关报道与相关标的。
 *
 * 【数据性质 —— 必读】
 * 本文件是**人工维护的叙事快照 + 实时行情叠加**的混合结构：
 *   · updated  = 该卡片「叙事部分」的人工维护截止时间，卡片上会明确标出
 *   · src      = 内容出处（人工整理所参考的来源），不保证逐条可核
 *   · 时间线节点用 k 字段区分性质：
 *       k: 'fact'     —— 已由来源报道的既成事实（人工转述，非本终端核验）
 *       k: 'forecast' —— 预期 / 关键节点 / 条件性判断（预测，非事实）
 *   · metrics 里带 asset 字段的条目 = 该指标本身就是一个可实时报价的品种
 *     （asset = 行情键），渲染层会用 QuoteHub 的实时报价覆盖显示，
 *     并把 value 保留为「快照基准值」做对照；卡片上会标「实时」角标。
 *   · metrics 里不带 asset 的条目 = 预测概率、人工指数、人工估算，
 *     仍然是维护时点的人工数值，无法实时化，渲染层会明确标注。
 *   · assets  = 该事件的相关标的清单，卡片会实时显示这些标的的当前报价。
 * 渲染层会把「实时行情」与「人工快照」明确区分开，避免把预期当成已发生的事实。
 * ============================================================ */
(function (w) {
  'use strict';

  w.EVENTS = [
    {
      id: 'iran',
      icon: '🛢️',
      title: '美伊冲突 · 霍尔木兹海峡',
      cat: '地缘 · 能源',
      status: '僵持中',
      statusCls: 'warn',
      hot: 3,
      updated: '2026-11-05 18:10',
      summary: '伊朗要求美国完整回应其七项条件后才开放霍尔木兹海峡；据来源报道，特朗普承认美军对伊朗防空设施发动「小规模攻击」。海峡运输受阻推升能源与取暖油成本，但油价因和谈预期连续回落，市场在「和谈 vs 供应风险」之间反复拉锯。',
      headline: { label: '布伦特原油', value: '100.8', sub: '11-04 早盘人工录入（快照基准）', asset: 'BRENT' },
      metrics: [
        { name: '布伦特原油（快照）', value: 100.8, note: '美元/桶 · 维护时点值', color: '#f783ac', asset: 'BRENT' },
        { name: 'WTI 原油（快照）', value: 96.7, note: '美元/桶 · 维护时点值', color: '#f783ac', asset: 'WTI' },
        { name: '美国取暖油均价（快照）', value: 6.19, note: '美元/加仑 同比+76% · 维护时点值', color: '#ff9fb0' },
        /* 这一格原来是「人工指数 35」—— 纯手填，图表永远不动。
         * 现在接 Polymarket：11-30 前「某日至少有 10 艘船通行海峡」的合约价，
         * 当前 35.5%，与原来的人工数值几乎一致，但它会自己走。 */
        { name: '海峡恢复通行概率', value: 35.5, unit: '%',
          note: 'Polymarket：11-30 前某日 ≥10 艘船通行', color: '#ffd43b',
          pred: { q: 'hormuz ships transit', event: 'ships transit the Strait of Hormuz on any day by November',
                  market: 'at least 10 ships', outcome: 'Yes' } },
        /* 【v172】原来那条「停火延续至年底」的盘口已经**结算为 No**（停火 11-07 前后中断），
         * 继续挂着一个 0% 没有信息量。换成 Polymarket 上同一事件**仍在交易**的三条，
         * 分别对应「解除封锁 / 航道恢复 / 核协议」三条真实路径。 */
        { name: '美国宣布解除封锁（12-31 前）', value: 37, unit: '%',
          note: 'Polymarket：US announces end of Iranian blockade by 12-31', color: '#ffd43b',
          pred: { q: 'US announces end of Iranian blockade', event: 'US announces end of Iranian blockade by',
                  market: 'December 31, 2026', outcome: 'Yes' } },
        { name: '海峡通行恢复正常（12-31 前）', value: 8.5, unit: '%',
          note: 'Polymarket：Strait of Hormuz traffic returns to normal by 12-31', color: '#ffd43b',
          pred: { q: 'Strait of Hormuz traffic returns to normal', event: 'Strait of Hormuz traffic returns to normal by December 31',
                  market: 'December 31', outcome: 'Yes' } },
        { name: '美伊最终核协议（12-31 前）', value: 9.5, unit: '%',
          note: 'Polymarket：US-Iran Final Nuclear Deal by 12-31', color: '#ffd43b',
          pred: { q: 'US-Iran Final Nuclear Deal', event: 'US-Iran Final Nuclear Deal by',
                  market: 'December 31, 2026', outcome: 'Yes' } }
      ],
      battleground: ['霍尔木兹海峡', '伊朗核谈判', '也门胡塞', '沙特联军', '卡塔尔斡旋'],
      timeline: [
        { t: '10月中', k: 'fact', txt: '来源报道：伊朗提出七项条件，作为开放海峡前提' },
        { t: '11-02', k: 'fact', txt: '来源报道：特朗普承认美军对伊朗防空设施「小规模攻击」' },
        { t: '11-03', k: 'fact', txt: '来源报道：伊朗称距离达成结束战争的协议「还很遥远」' },
        { t: '11-04', k: 'fact', txt: '来源报道：油价连跌后尾盘收复大部分跌幅，市场观望和谈' }
      ],
      themes: ['原油供给', '取暖油成本', '航运风险', '黄金避险'],
      newsKeys: ['伊朗', '霍尔木兹', '美伊', '胡塞', '中东', '原油', '油轮'],
      assets: ['BRENT', 'WTI', 'GOLD'],
      src: '路透社 / 华尔街日报 / 央视新闻（11-03 ~ 11-04）'
    },
    {
      id: 'fed',
      icon: '🏛️',
      title: '美联储政策路径',
      cat: '央行 · 利率',
      status: '跟踪中',
      statusCls: 'watch',
      hot: 3,
      updated: '2026-11-05 18:10',
      summary: '据来源报道，9月JOLTS职位空缺意外升至752.3万、工厂订单强劲，美债收益率与美元同步走高；Polymarket 上「12月加息25bp」的合约价约 77.5%。加息预期升温压制风险资产与贵金属，是当前除选举外最主导的宏观主线。',
      /* v171：headline 也接 Polymarket —— 原来只有下面的指标行接了实时，
       * 上面这个 77.5% 是写死的，同一页两个值（77.5 / 76.5）用户一眼就看出来。 */
      headline: { label: '12月加息概率', value: '77.5%', sub: 'Polymarket 合约价',
        pred: { q: 'fed decision december', event: 'Fed Decision in December',
                market: 'increase interest rates by 25', outcome: 'Yes' } },
      metrics: [
        { name: '12月加息概率', value: 77.5, unit: '%',
          note: 'Polymarket：12 月 FOMC 加息 25bp 合约价', color: '#8ce99a',
          pred: { q: 'fed decision december', event: 'Fed Decision in December',
                  market: 'increase interest rates by 25', outcome: 'Yes' } },
        /* v172：同一事件（Fed Decision in December）的另外两种结果 —— 加息 76.5% 只是分布的一端，
         * 把「维持不变」和「降息」一起放上来，才看得出市场对 12 月的完整定价。 */
        { name: '12月维持利率不变', value: 21.5, unit: '%',
          note: 'Polymarket：12 月 FOMC 按兵不动', color: '#8ce99a',
          pred: { q: 'fed decision december', event: 'Fed Decision in December',
                  market: 'no change', outcome: 'Yes' } },
        { name: '12月降息 25bp', value: 0.7, unit: '%',
          note: 'Polymarket：12 月 FOMC 降息 25bp', color: '#8ce99a',
          pred: { q: 'fed decision december', event: 'Fed Decision in December',
                  market: 'decrease interest rates by 25', outcome: 'Yes' } },
        { name: '9月JOLTS职位空缺', value: 752.3, note: '万人 · 来源报道，超预期716.4万', color: '#8ce99a' },
        { name: '美债10Y收益率（快照）', value: 4.3, note: '%（走高）· 维护时点值', color: '#63e6be', asset: 'US10Y' },
        { name: '美元指数（快照）', value: 106, note: '高位运行 · 维护时点值', color: '#8ce99a', asset: 'DXY' }
      ],
      battleground: ['12月FOMC', '鲍威尔讲话', '点阵图', 'JOLTS', '非农就业'],
      timeline: [
        { t: '11-03', k: 'fact', txt: '来源报道：9月JOLTS职位空缺752.3万，超预期；裁员降至2025年3月来最低' },
        { t: '11-04', k: 'fact', txt: '来源报道：美债收益率与美元同步走高，贵金属与工业金属承压' },
        { t: '12月', k: 'forecast', txt: '关键节点：FOMC议息会议——市场押注79%概率加息（期货隐含）' }
      ],
      themes: ['加息预期', '美债收益率', '美元指数', '风险偏好'],
      /* 裸「加息 / 降息」已拿掉：这两词全球央行通用，留着会把欧央行、日银
       * 的稿子全抓进来（实跑：欧洲央行官员称12月加息 + 欧元区通胀创新高）。
       * 现在只留美联储专属词，再用 newsMust 兜一道、newsExcl 挡别的央行。 */
      newsKeys: ['美联储', '鲍威尔', 'FOMC', 'JOLTS', '非农', '美债', '美元指数'],
      newsMust: ['美联储', '鲍威尔', 'FOMC', '联储', '美元指数', '美债', '非农', 'JOLTS'],
      newsExcl: ['欧洲央行', '欧元区', 'ECB', '日本央行', '日银', '英国央行', '英央行'],
      assets: ['US10Y', 'DXY', 'SPX', 'GOLD'],
      src: '华尔街见闻 / 汇通财经（11-03 ~ 11-04）'
    },
    {
      id: 'ukraine',
      icon: '🕊️',
      title: '俄乌和谈',
      cat: '地缘 · 外交',
      status: '待会谈',
      statusCls: 'watch',
      hot: 2,
      updated: '2026-11-05 18:10',
      summary: '据来源报道，俄美乌三方会谈定于11月10日至11日在阿联酋阿布扎比举行，美总统特使威特科夫将斡旋工作层级谈判。若达成停火/和平框架，将缓解欧洲能源与粮食供应风险、削弱黄金与原油的地缘溢价。',
      headline: { label: '三方会谈（计划）', value: '11-10', sub: '阿布扎比 · 俄美乌' },
      metrics: [
        /* 和谈「会不会开」比「谈成没有」更早反映进展：
         * 11-15 前举行和谈的合约价 88.5%，说明阿布扎比会谈大概率成局。 */
        { name: '11-15 前举行和谈', value: 88.5, unit: '%',
          note: 'Polymarket：11-15 前举行俄乌和谈', color: '#91a7ff',
          pred: { q: 'russia ukraine peace talks', event: 'peace talks by',
                  market: 'November 15, 2026', outcome: 'Yes' } },
        /* 原来写死的 45%「市场预估」并没有出处，实测只有 12.5% —— 差了三倍多。
         * 换成可核的合约价：12-31 前达成停火协议。 */
        { name: '年内达成停火协议', value: 12.5, unit: '%',
          note: 'Polymarket：12-31 前达成停火协议', color: '#91a7ff',
          pred: { q: 'russia ukraine ceasefire', event: 'ceasefire agreement by',
                  market: 'December 31, 2026', outcome: 'Yes' } },
        /* v172：同一事件（ceasefire agreement by）的其他时点 ——
         * 年内 12.5% 与 2027-06 的 52.5% 差 4 倍，说明市场认为「年内谈成」概率低但不为零。 */
        { name: '11-30 前达成停火', value: 4.5, unit: '%',
          note: 'Polymarket：11-30 前达成停火协议（最近的一个时点）', color: '#91a7ff',
          pred: { q: 'russia ukraine ceasefire', event: 'ceasefire agreement by',
                  market: 'November 30, 2026', outcome: 'Yes' } },
        { name: '2027-06 前达成停火', value: 52.5, unit: '%',
          note: 'Polymarket：2027-06-30 前达成停火协议', color: '#91a7ff',
          pred: { q: 'russia ukraine ceasefire', event: 'ceasefire agreement by',
                  market: 'June 30, 2027', outcome: 'Yes' } },
        { name: '布伦特原油地缘溢价', value: 8, note: '美元/桶（估算）· 人工估算', color: '#f783ac' },
        { name: '欧洲天然气（快照）', value: 42, note: '欧元/兆瓦时 · 维护时点值', color: '#91a7ff' }
      ],
      battleground: ['阿布扎比会谈', '停火框架', '能源供给', '粮食出口'],
      timeline: [
        { t: '11-02', k: 'fact', txt: '来源报道：美方透露将于11-10~11在阿布扎比举行俄美乌三方会谈' },
        { t: '11-03', k: 'fact', txt: '来源报道：佩斯科夫确认会谈日期；威特科夫称将斡旋工作层级谈判' },
        { t: '11-10', k: 'forecast', txt: '关键节点：阿布扎比三方会谈（计划举行）' }
      ],
      themes: ['停火预期', '能源供给', '粮食出口', '避险情绪'],
      newsKeys: ['俄乌', '乌克兰', '俄罗斯', '和谈', '停火', '阿布扎比', '威特科夫'],
      assets: ['BRENT', 'GOLD', 'EURUSD'],
      src: '东方财富 / 路透社（11-02 ~ 11-03）'
    }
  ];

  /* 事件 <> 快讯 的匹配判定，抽成纯函数放在数据层，好处：
   *   ① 前端只传标题，不用把匹配规则散在渲染逻辑里；
   *   ② 可以单测（tools/test_events_match.js），改词表不会静默回归。
   * 三层：newsExcl 一票否决 → newsKeys 至少命中一个 → newsMust 必须再命中其一。
   * 只匹配标题，不碰正文，避免正文里顺带提到就被抓。 */
  w.evMatchNews = function (ev, title) {
    if (!ev) return false;
    var t = String(title || '').toLowerCase();
    if (!t) return false;
    function any(list) {
      list = list || [];
      for (var i = 0; i < list.length; i++) {
        if (t.indexOf(String(list[i]).toLowerCase()) >= 0) return true;
      }
      return false;
    }
    if (ev.newsExcl && any(ev.newsExcl)) return false;
    if (!any(ev.newsKeys)) return false;
    if (ev.newsMust && ev.newsMust.length && !any(ev.newsMust)) return false;
    return true;
  };
})(window);
