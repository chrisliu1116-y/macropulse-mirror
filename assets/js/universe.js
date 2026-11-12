/* ============================================================
 * universe.js — 资产宇宙 / 符号注册表
 * 所有品种的真实数据源标识都集中在这里，新增品种只改这个文件。
 * 数据源：
 *   em      = 东方财富（push2 批量快照 / push2his K线分时，CORS 对 null 源开放）
 *   binance = 币安开放 API（毫秒级，覆盖加密）
 *   dex     = DexScreener（链上池子价格，CORS 开放）
 *   hl      = Hyperliquid「xyz」子 DEX 的 RWA 永续（7×24 报价，CORS 全开）
 *
 * 【hl 字段为什么重要】
 *   CME / ICE / 交易所周末关门，原油、商品、股指、个股在周末是没有
 *   连续报价的 —— 但链上的 RWA 永续合约 7×24 一直在成交，价格对
 *   「周末出了什么事」反应最快。所以这些品种在主市场休市时，
 *   会额外挂一条「链上」价（等价于用户说的暗盘价），
 *   并给出与最近收盘价的基差，方便判断周一开盘缺口方向。
 *   xyz DEX 目前 142 个标的，含 CL/BRENTOIL/GOLD/SILVER/COPPER/
 *   NATGAS/SP500/VIX/JP225/DXY/JPY/EUR 与 INNOLIGHT（中际旭创）等。
 *   ⚠️ 只给「标的口径一致」的品种配 hl。纳斯达克综合(IXIC) vs
 *      XYZ100(纳指100)、费半指数 vs SMH(半导体ETF)、KOSPI vs
 *      KOSPI200 都不是同一个东西，硬配会算出 +12%、-95% 这种
 *      假基差，所以这三个不配 —— 宁可不显示，也不能给错数。
 * ============================================================ */
(function (w) {
  'use strict';

  // dec: 小数位 | grp: 行情分组 | kind: 资产类型 | tv: TradingView 符号
  // dex: 链上检索关键词（非交易时段展示链上价）
  const ASSETS = {
    /* ---------------- A股指数 ----------------
     * ord 只在「同一分组内」决定先后，跨组顺序由时段判断负责 */
    AX:    { name: '上证指数',   short: '上证',    ord: 1, src: 'em', secid: '1.000001', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SSE:000001' },
    HS300: { name: '沪深300',    short: '沪深300', ord: 2, src: 'em', secid: '1.000300', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SSE:000300' },
    SZ:    { name: '深证成指',   short: '深成',    ord: 3, src: 'em', secid: '0.399001', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SZSE:399001' },
    CYB:   { name: '创业板指',   short: '创业板',  ord: 4, src: 'em', secid: '0.399006', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SZSE:399006' },
    SZ50:  { name: '上证50',     short: '上证50',  ord: 5, src: 'em', secid: '1.000016', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SSE:000016' },
    KC50:  { name: '科创50',     short: '科创50',  ord: 6, src: 'em', secid: '1.000688', dec: 2, grp: 'cn',  kind: 'index', unit: '点', tv: 'SSE:000688' },

    /* ---------------- 亚太 ----------------
     * 顺序按交易体量：港股 → 韩国 → 日本 → 台湾（A股单独成组排在最前）
     * HSI 用港股时段（收盘 16:00），不用日股时段 */
    HSI:   { name: '恒生指数',   short: '恒指',    ord: 1, sess: 'hk',  src: 'em', secid: '100.HSI',  dec: 2, grp: 'apac', kind: 'index', unit: '点', tv: 'TVC:HSI', yh: '^HSI' },
    HSTECH:{ name: '恒生科技指数', short: '恒生科技', ord: 2, sess: 'hk', src: 'em', secid: '124.HSTECH', dec: 2, grp: 'apac', kind: 'index', unit: '点', tv: 'TVC:HSTECH', yh: '^HSTECH' },
    KS11:  { name: '韩国KOSPI',  short: 'KOSPI',   ord: 3, src: 'em', secid: '100.KS11', dec: 2, grp: 'apac', sess: 'kr', kind: 'index', unit: '点', tv: 'KRX:KOSPI', yh: '^KS11'},
    N225:  { name: '日经225',    short: '日经',    ord: 4, src: 'em', secid: '100.N225', dec: 2, grp: 'apac', sess: 'jp', kind: 'index', unit: '点', tv: 'TVC:NI225' , hl: 'JP225', yh: '^N225'},
    /* v291：TWII 兜底链实测结论 —— 台湾加权是全池唯一「腾讯/新浪/TradingView
     * 三家都没有免费报价符号」的品种（实测 tw2330/rt_tw2330/TVC:TWII/TPE:TWII
     * 全部无数据），只有 Yahoo ^TWII 可用（实测 2340，与东财 178.TWII 同量级），
     * 所以东财挂掉时它走 yahooQuoteFallback。 */
    TWII:  { name: '台湾加权指数', short: '台湾加权', ord: 5, src: 'em', secid: '100.TWII', dec: 2, grp: 'apac', sess: 'tw', kind: 'index', unit: '点', yh: '^TWII' },

    /* ---------------- 美股 ----------------
     * 注意：东财 100.NDX = 纳斯达克综合指数（IXIC），100.NDX100 才是纳斯达克100。
     * 用户口径要的是「纳斯达克」，所以用 100.NDX。
     * 费城半导体走 251.SOX（东财美股指数市场号 251，不是 100）。 */
    SPX:   { name: '标普500',    short: '标普',    ord: 1, src: 'em', secid: '100.SPX',  dec: 2, grp: 'us', kind: 'index', unit: '点', tv: 'SP:SPX', extSym: 'ES=F' , hl: 'SP500', yh: '^GSPC'},
    NDX:   { name: '纳斯达克指数', short: '纳指', ord: 2, src: 'em', secid: '100.NDX', dec: 2, grp: 'us', kind: 'index', unit: '点', tv: 'NASDAQ:IXIC', extSym: 'NQ=F', yh: '^NDX'},
    SOX:   { name: '费城半导体指数', short: '费半', ord: 3, src: 'em', secid: '251.SOX',  dec: 2, grp: 'us', kind: 'index', unit: '点', tv: 'TVC:SOX', yh: '^SOX', ndq: { sym: 'SOX', cls: 'index' }},
    DJI:   { name: '道琼斯指数', short: '道指',    ord: 4, src: 'em', secid: '100.DJIA', dec: 2, grp: 'us', kind: 'index', unit: '点', tv: 'DJ:DJI', extSym: 'YM=F' },

    /* ---------------- VIX 恐慌指数 ----------------
     * 东财没有 VIX 现货，走 Yahoo（^VIX）。CBOE 计算，指数本身是
     * 「市场对未来30天预期波动率」的报价，不是可交易标的。
     * 方向特殊：VIX 上涨 = 市场恐慌 = 风险事件 → invert=true。 */
    VIX:   { name: 'VIX恐慌指数', short: 'VIX',    ord: 5, sess: 'vix', src: 'cboe', dec: 2, grp: 'us', kind: 'index', unit: '', tv: 'CBOE:VIX', invert: true , hl: 'VIX',
             /* rt:'cnbc' —— CBOE 官方端点（cdn-api/delayed_quotes）是延时 15 分钟的，
              * 实测 Yahoo ^VIX 滞后 912 秒、TradingView CBOE:VIX 是 delayed_streaming_900，
              * 只有 CNBC 的 quote.cnbc.com 是**真实时**（last_time 与当前时刻一致），
              * 且 CORS 全开、图表接口 ts-api.cnbc.com 也给 1 分钟线。
              * 日 K 仍走 CBOE（src:'cboe' 不动），只有报价和分时换成 CNBC。
              * minSpan：VIX 从 03:15 ET（GTH 开盘）算到 16:15 ET = 780 分钟，
              * 比美股常规 390 分钟长得多，分时图右侧留白要按它算。 */
             rt: 'cnbc', minSpan: 780},

    /* ---------------- 美债收益率：只留 5 / 10 / 30 年 ----------------
     * 2 年是政策利率预期，噪音大且与本终端的「黑天鹅」定位不符，已移除 */
    /* v291：US5Y 的 tv 符号实测修正 —— TVC:US5Y 在 TradingView scanner 里不存在
     * （实测 95 个 tv 符号穷举：US10Y/US30Y 都返回，唯独 US5Y 缺席），
     * 正确符号是 TVC:US05Y（实测 4.837，update_mode=streaming 真实时）。
     * 东财 171.US5Y 挂掉时兜底链靠它 + Yahoo ^FVX（实测 4.827 同量级）。 */
    US5Y:  { name: '美债5年',    short: '美债5Y',  src: 'em', secid: '171.US5Y',  dec: 4, grp: 'rate', kind: 'yield', unit: '%', tv: 'TVC:US05Y', invert: true, yh: '^FVX' },
    US10Y: { name: '美债10年',   short: '美债10Y', src: 'em', secid: '171.US10Y', dec: 4, grp: 'rate', kind: 'yield', unit: '%', tv: 'TVC:US10Y', invert: true, yh: '^TNX' },
    US30Y: { name: '美债30年',   short: '美债30Y', src: 'em', secid: '171.US30Y', dec: 4, grp: 'rate', kind: 'yield', unit: '%', tv: 'TVC:US30Y', invert: true, yh: '^TYX' },

    /* ---------------- 汇率：人民币 / 日元 / 欧元 / 美元指数 ---------------- */
    /* 用户口径：「这几个汇率改成中文，如美元指数、美元兑离岸人民币」。
     * name 给行情页（宽）用全称，short 给异动格子（窄）用短名——
     * 两边都不再出现 USDCNH 这种代码。 */
    DXY:   { name: '美元指数',         short: '美元指数',   src: 'em', secid: '100.UDI',   dec: 3, grp: 'fx', kind: 'fx', unit: '', tv: 'TVC:DXY',    hl: 'DXY' },
    USDCNH:{ name: '美元兑离岸人民币', short: '离岸人民币', src: 'em', secid: '133.USDCNH', dec: 4, grp: 'fx', kind: 'fx', unit: '', tv: 'FX:USDCNH' },
    USDJPY:{ name: '美元兑日元',       short: '美元日元',   src: 'em', secid: '119.USDJPY', dec: 3, grp: 'fx', kind: 'fx', unit: '', tv: 'FX:USDJPY', hl: 'JPY' },
    EURUSD:{ name: '欧元兑美元',       short: '欧元美元',   src: 'em', secid: '119.EURUSD', dec: 4, grp: 'fx', kind: 'fx', unit: '', tv: 'FX:EURUSD', hl: 'EUR' },

    /* ---------------- 原油 / 能源 ----------------
     * 【rt / txSym / sinaSym 是什么】东财对 CME、ICE 商品是**延时 10 分钟**的源
     * （实测分时末点、1 分钟 K 最后一根、报价 f86 时间戳全都比当前早 600 秒），
     * TradingView scanner 对这些合约同样是 delayed_streaming_600。
     * 所以这几个品种必须换源：
     *   · rt:'tx'    → 报价走腾讯 qt.gtimg.cn（实时，CORS 开放）
     *   · txSym      → 腾讯符号（hf_ 前缀 = 外盘期货）
     *   · sinaSym    → 新浪外盘期货符号，分时走它的 jsonp.php 通道（真实时）
     *   · pxScale    → 新浪/腾讯的报价单位换算（铜给的是美分/磅）
     *   · sinaRoll   → 新浪该符号必须带年月、会换月，用东财连续合约当锚点自愈
     * 日 K 仍走东财（secid 不变），不受影响。 */
    BRENT: { name: '布伦特原油', short: '布伦特',  src: 'em', secid: '112.B00Y', dec: 2, grp: 'energy', kind: 'future', unit: '美元/桶', tv: 'ICEEUR:BRN1!' , hl: 'BRENTOIL', rt: 'tx', txSym: 'hf_OIL', sinaSym: 'OIL'},
    WTI:   { name: 'WTI原油',    short: 'WTI',     src: 'em', secid: '102.CL00Y', dec: 2, grp: 'energy', kind: 'future', unit: '美元/桶', tv: 'NYMEX:CL1!' , hl: 'CL', rt: 'tx', txSym: 'hf_CL', sinaSym: 'CL'},
    /* 天然气：腾讯 hf_NG 和新浪默认 NG 都是**远月合约**（比主力高 13%，实测 3.59 vs 3.18），
     * 必须用带年月的 NG2612。换月由 sinaRoll 自动纠正。 */
    NG:    { name: 'NYMEX天然气', short: '天然气', src: 'em', secid: '102.NG00Y', dec: 3, grp: 'energy', kind: 'future', unit: '美元/百万英热', tv: 'NYMEX:NG1!' , hl: 'NATGAS', rt: 'tx', sinaSym: 'NG2612', sinaRoll: 'NG'},

    /* ---------------- 贵金属 ---------------- */
    // 用户口径：黄金用「黄金兑美元」现货，而非 COMEX 期金
    /* v291：GOLD 兜底链实测 —— 现货黄金（122.XAU）只有东财与 TV OANDA:XAUUSD
     * 两条链。给报价补腾讯 hf_GC（实测 3972.5，与 TVC:GOLD 3969 差 0.09%，
     * 是期金口径但基差 <0.5%）、分时补新浪 hf_GC 分钟线（真实时），
     * 东财挂掉时黄金不再只剩 TV 一条腿。 */
    GOLD:  { name: '黄金/美元',  short: '黄金',    src: 'em', secid: '122.XAU', dec: 2, grp: 'metal', kind: 'spot', unit: '美元/盎司', tv: 'OANDA:XAUUSD' , hl: 'GOLD', rt: 'tx', txSym: 'hf_GC', sinaSym: 'GC'},
    SILVER:{ name: '白银/美元',  short: '白银',    src: 'em', secid: '101.SI00Y', dec: 3, grp: 'metal', kind: 'future', unit: '美元/盎司', tv: 'COMEX:SI1!' , hl: 'SILVER', rt: 'tx', txSym: 'hf_SI', sinaSym: 'SI'},

    /* ---------------- 金属（贵金属 + 工业金属合并） ----------------
     * 用户口径：贵金属/工业金属合并成一个大类；商品名要写全「X/美元」，
     * 避免以后手动加「黄金T+D」这类同名品种时和现货黄金混在一起。 */
    COPPER:{ name: '铜/美元',    short: '铜',      src: 'em', secid: '101.HG00Y', dec: 4, grp: 'metal', kind: 'future', unit: '美元/磅', tv: 'COMEX:HG1!' , hl: 'COPPER', rt: 'tx', txSym: 'hf_HG', sinaSym: 'HG', pxScale: 0.01},

    /* ---------------- 加密 ---------------- */
    BTC:   { name: '比特币', short: 'BTC', src: 'binance', sym: 'BTCUSDT', dec: 1, grp: 'crypto', kind: 'crypto', unit: 'USDT', tv: 'BINANCE:BTCUSDT', dex: 'WBTC', dexChain: 'ethereum', dexAddr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
    ETH:   { name: '以太坊', short: 'ETH', src: 'binance', sym: 'ETHUSDT', dec: 2, grp: 'crypto', kind: 'crypto', unit: 'USDT', tv: 'BINANCE:ETHUSDT', dex: 'WETH', dexChain: 'ethereum', dexAddr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    SOL:   { name: 'Solana', short: 'SOL', src: 'binance', sym: 'SOLUSDT', dec: 3, grp: 'crypto', kind: 'crypto', unit: 'USDT', tv: 'BINANCE:SOLUSDT', dex: 'SOL', dexChain: 'solana', dexAddr: 'So11111111111111111111111111111111111111112' },

    /* ---------------- A股映射标的（个股） ----------------
     * 这些只在「消息本身与中国强相关」时才会出现在卡片上，见 news-live-client.js 的 cnGate() */
    '601689': { name: '拓普集团',   src: 'em', secid: '1.601689', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601689' },
    '002050': { name: '三花智控',   src: 'em', secid: '0.002050', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:002050' },
    '002594': { name: '比亚迪',     src: 'em', secid: '0.002594', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:002594' },
    '600547': { name: '山东黄金',   src: 'em', secid: '1.600547', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600547' },
    '601899': { name: '紫金矿业',   src: 'em', secid: '1.601899', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601899' },
    '601857': { name: '中国石油',   src: 'em', secid: '1.601857', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601857' },
    '600111': { name: '北方稀土',   src: 'em', secid: '1.600111', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600111' },
    '600030': { name: '中信证券',   src: 'em', secid: '1.600030', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600030' },
    '300059': { name: '东方财富',   src: 'em', secid: '0.300059', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:300059' },
    '688981': { name: '中芯国际',   src: 'em', secid: '1.688981', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:688981' },
    '688256': { name: '寒武纪',     src: 'em', secid: '1.688256', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:688256' },
    '300308': { name: '中际旭创',   src: 'em', secid: '0.300308', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:300308' , hl: 'INNOLIGHT'},
    '601138': { name: '工业富联',   src: 'em', secid: '1.601138', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601138' },
    '600519': { name: '贵州茅台',   src: 'em', secid: '1.600519', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600519' },
    '300750': { name: '宁德时代',   src: 'em', secid: '0.300750', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:300750' },
    '601088': { name: '中国神华',   src: 'em', secid: '1.601088', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601088' },
    '600028': { name: '中国石化',   src: 'em', secid: '1.600028', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600028' },
    '601985': { name: '中国核电',   src: 'em', secid: '1.601985', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601985' },
    '000725': { name: '京东方A',    src: 'em', secid: '0.000725', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SZSE:000725' },
    '601398': { name: '工商银行',   src: 'em', secid: '1.601398', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601398' },
    '600036': { name: '招商银行',   src: 'em', secid: '1.600036', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600036' },
    '601288': { name: '农业银行',   src: 'em', secid: '1.601288', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601288' },
    '601939': { name: '建设银行',   src: 'em', secid: '1.601939', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601939' },
    '601988': { name: '中国银行',   src: 'em', secid: '1.601988', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:601988' },
    '600893': { name: '航发动力',   src: 'em', secid: '1.600893', dec: 2, grp: 'cnstock', kind: 'stock', unit: '元', tv: 'SSE:600893' },

    /* ---------------- 美股映射标的 ---------------- */
    GM:    { name: '通用汽车',     src: 'em', secid: '106.GM', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:GM', extSym: 'GM' },
    F:     { name: '福特汽车',     src: 'em', secid: '106.F', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:F', extSym: 'F' },
    TSLA:  { name: '特斯拉',       src: 'em', secid: '105.TSLA', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:TSLA', extSym: 'TSLA' , hl: 'TSLA'},
    NVDA:  { name: '英伟达',       src: 'em', secid: '105.NVDA', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:NVDA', extSym: 'NVDA' , hl: 'NVDA'},
    AAPL:  { name: '苹果',         src: 'em', secid: '105.AAPL', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:AAPL', extSym: 'AAPL' , hl: 'AAPL'},
    /* 正文点名的美股个股（news-live-client.js 的 tagUS 会把它们挂上卡片）。
     * 市场号：105 = 纳斯达克，106 = 纽交所（均实测有报价）。
     * 只收「财经快讯里真的会被点名」的大票，不做全市场铺开。 */
    MSFT:  { name: '微软',     short: '微软',   src: 'em', secid: '105.MSFT',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:MSFT',  extSym: 'MSFT' },
    GOOGL: { name: '谷歌-A',   short: '谷歌',   src: 'em', secid: '105.GOOGL', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:GOOGL', extSym: 'GOOGL' },
    AMZN:  { name: '亚马逊',   short: '亚马逊', src: 'em', secid: '105.AMZN',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:AMZN',  extSym: 'AMZN' },
    META:  { name: 'Meta',     short: 'Meta',   src: 'em', secid: '105.META',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:META',  extSym: 'META' },
    AMD:   { name: '超威半导体', short: 'AMD',  src: 'em', secid: '105.AMD',   dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:AMD',   extSym: 'AMD' },
    AVGO:  { name: '博通',     short: '博通',   src: 'em', secid: '105.AVGO',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:AVGO',  extSym: 'AVGO' },
    MU:    { name: '美光科技', short: '美光',   src: 'em', secid: '105.MU',    dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:MU',    extSym: 'MU' },
    TSM:   { name: '台积电',   short: '台积电', src: 'em', secid: '106.TSM',   dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:TSM',    extSym: 'TSM' },
    INTC:  { name: '英特尔',   short: '英特尔', src: 'em', secid: '105.INTC',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:INTC',  extSym: 'INTC' },
    QCOM:  { name: '高通',     short: '高通',   src: 'em', secid: '105.QCOM',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:QCOM',  extSym: 'QCOM' },
    NFLX:  { name: '奈飞',     short: '奈飞',   src: 'em', secid: '105.NFLX',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:NFLX',  extSym: 'NFLX' },
    ORCL:  { name: '甲骨文',   short: '甲骨文', src: 'em', secid: '106.ORCL',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:ORCL',   extSym: 'ORCL' },
    JPM:   { name: '摩根大通', short: '摩根大通', src: 'em', secid: '106.JPM', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:JPM',    extSym: 'JPM' },
    BA:    { name: '波音',     short: '波音',   src: 'em', secid: '106.BA',    dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:BA',     extSym: 'BA' },
    DIS:   { name: '迪士尼',   short: '迪士尼', src: 'em', secid: '106.DIS',   dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:DIS',    extSym: 'DIS' },
    XOM:   { name: '埃克森美孚', short: '埃克森', src: 'em', secid: '106.XOM', dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:XOM',    extSym: 'XOM' },
    CVX:   { name: '雪佛龙',   short: '雪佛龙', src: 'em', secid: '106.CVX',   dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:CVX',    extSym: 'CVX' },
    BABA:  { name: '阿里巴巴', short: '阿里',   src: 'em', secid: '106.BABA',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:BABA',   extSym: 'BABA' },
    NIO:   { name: '蔚来',     short: '蔚来',   src: 'em', secid: '106.NIO',   dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:NIO',    extSym: 'NIO' },
    XPEV:  { name: '小鹏汽车', short: '小鹏',   src: 'em', secid: '106.XPEV',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NYSE:XPEV',   extSym: 'XPEV' },
    PLTR:  { name: 'Palantir', short: 'PLTR',   src: 'em', secid: '105.PLTR',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:PLTR',  extSym: 'PLTR', yh: 'PLTR', ndq: { sym: 'PLTR', cls: 'stocks' } },
    /* v92：阿斯麦/ASML 是纳指 ADR，快讯里常写中文「阿斯麦控股」。
     * 原来标的字典里没有它，tagUS 就算挂上也会被 U.get() 过滤掉。 */
    ASML:  { name: '阿斯麦',   short: '阿斯麦', src: 'em', secid: '105.ASML',  dec: 2, grp: 'usstock', kind: 'stock', unit: 'USD', tv: 'NASDAQ:ASML',  extSym: 'ASML' },

    '00700': { name: '腾讯控股',   src: 'em', secid: '116.00700', dec: 2, grp: 'hkstock', kind: 'stock', unit: 'HKD', tv: 'HKEX:700' },

    /* ---------------- 海外个股（韩 / 日 / 台）----------------
     * 东财市场号：177=韩股(KRX)、176=日股(JPX)、178=台股(TWSE)
     * 用户可直接在「添加品种」搜索框输代码/名称加入自选 */
    // 韩股
    '000660': { name: 'SK海力士',   short: 'SK海力士', src: 'em', secid: '177.000660', dec: 2, grp: 'krstock', kind: 'stock', unit: '韩元', tv: 'KRX:000660', rt: 'tx', txSym: 'kr000660' },
    '005930': { name: '三星电子',   short: '三星电子', src: 'em', secid: '177.005930', dec: 2, grp: 'krstock', kind: 'stock', unit: '韩元', tv: 'KRX:005930', rt: 'tx', txSym: 'kr005930' },
    '005380': { name: '现代汽车',   short: '现代汽车', src: 'em', secid: '177.005380', dec: 2, grp: 'krstock', kind: 'stock', unit: '韩元', tv: 'KRX:005380', rt: 'tx', txSym: 'kr005380' },
    // 日股
    '7203':   { name: '丰田汽车',   short: '丰田',     src: 'em', secid: '176.7203',   dec: 2, grp: 'jpstock', kind: 'stock', unit: '日元', tv: 'TSE:7203', rt: 'tx', txSym: 'jp7203' },
    '9984':   { name: '软银集团',   short: '软银',     src: 'em', secid: '176.9984',   dec: 2, grp: 'jpstock', kind: 'stock', unit: '日元', tv: 'TSE:9984', rt: 'tx', txSym: 'jp9984' },
    '285A':   { name: '铠侠',       short: '铠侠',     src: 'em', secid: '176.285A',   dec: 2, grp: 'jpstock', kind: 'stock', unit: '日元', tv: 'TSE:285A', rt: 'tx', txSym: 'jp285A' },
    '6857':   { name: '爱德万测试', short: '爱德万',   src: 'em', secid: '176.6857',   dec: 2, grp: 'jpstock', kind: 'stock', unit: '日元', tv: 'TSE:6857', rt: 'tx', txSym: 'jp6857' },
    // 台股
    '2330':   { name: '台积电',     short: '台积电',   src: 'em', secid: '178.2330',   dec: 2, grp: 'twstock', kind: 'stock', unit: '新台币', tv: 'TWSE:2330' },
    '2327':   { name: '国巨',       short: '国巨',     src: 'em', secid: '178.2327',   dec: 2, grp: 'twstock', kind: 'stock', unit: '新台币', tv: 'TWSE:2327' },
    '2454':   { name: '联发科',     short: '联发科',   src: 'em', secid: '178.2454',   dec: 2, grp: 'twstock', kind: 'stock', unit: '新台币', tv: 'TWSE:2454' }
  };

  /* ---------------- 行情分组 ----------------
   * order 只是「默认顺序」；实际渲染顺序会按当前交易时段动态上浮
   * （见 app.js 的 groupOrder）：哪个市场在交易，它和正在交易的
   * 24 小时品种就往前顶，休市的往后放。可手动关掉。
   * ---------------------------------------------- */
  const GROUPS = {
    cn:      { label: 'A股',       full: 'A股指数',   color: '#ff6b6b', order: 1, session: 'cn' },
    apac:    { label: '亚太',      full: '亚太股市',  color: '#ffd43b', order: 2, session: 'apac' },
    us:      { label: '美股',      full: '美股指数',  color: '#74c0fc', order: 3, session: 'us' },
    rate:    { label: '美债',      full: '美债收益率', color: '#63e6be', order: 4, session: 'rate' },
    fx:      { label: '外汇',      full: '汇率',      color: '#8ce99a', order: 5, session: 'fx' },
    energy:  { label: '能源',      full: '原油·天然气', color: '#f783ac', order: 6, session: 'cmdty' },
    metal:   { label: '金属',      full: '金属',      color: '#ffd43b', order: 7, session: 'cmdty' },
    crypto:  { label: '加密',      full: '加密货币',  color: '#ffc078', order: 9, session: 'crypto' },
    cnstock: { label: 'A股个股',   full: 'A股映射标的', color: '#ff8787', order: 10, session: 'cn' },
    usstock: { label: '美股个股',  full: '美股映射标的', color: '#91a7ff', order: 11, session: 'us' },
    hkstock: { label: '港股个股',  full: '港股映射标的', color: '#ffc9c9', order: 12, session: 'hk' },
    krstock: { label: '韩股个股',  full: '韩股',         color: '#4dabf7', order: 13, session: 'kr' },
    jpstock: { label: '日股个股',  full: '日股',         color: '#da77f2', order: 14, session: 'jp' },
    twstock: { label: '台股个股',  full: '台股',         color: '#ffa94d', order: 15, session: 'tw' }
  };

  /* ---------------- 异动矩阵监控池 ----------------
   * 六尺度：1 / 2 / 3 / 5 / 15 / 30 分钟窗口并联，任一越线即报警。
   *
   * 【为什么必须往「分钟」走】
   *   用户原话：「那种剧烈波动，特别是黑天鹅，都是发生在几分钟里面的，
   *   你 30 分钟才去看的话，根本就来不及了。」
   *   闪崩与垂直拉升的真实时间常数是 60~180 秒，30 分钟窗口只能事后复述。
   *   所以最快的三个尺度直接切到 1 / 2 / 3 分钟：
   *     1 分钟  → 闪崩、单根 K 线的垂直拉升（黑天鹅发生的那一刻）
   *     2 / 3 分钟 → 短促脉冲，确认不是单笔异常成交
   *     5 分钟  → 主战场：几分钟内走完的急动
   *     15 / 30 分钟 → 持续趋势，用来确认不是插针
   *
   * 【阈值口径】
   *   30/15/5 分钟：data/tv_hist（TradingView 5 分钟 K 线，A股 106 个
   *     交易日、其余 19~28 个）按交易日切分，取每日窗口极值，再取
   *     「触发日占比」对应分位 —— 5 分钟 5% / 15 分钟 4.5% / 30 分钟 4%。
   *   1/2/3 分钟：没有这么长的 1 分钟历史（东财分时最多 5 日、币安 1m
   *     一次 1000 根），tools/thr_short.py 改用「等稀有度比例法」：
   *     用近 5 个交易日真实 1 分钟数据，量出每个品种
   *         r_s = median(日极值_s / 日极值_5)
   *     全池中位 r1=0.527 / r2=0.712 / r3=0.845，再乘 1.25 阻尼
   *     （短窗尾部更肥），原始标定为 t1≈0.66·t5、t2≈0.89·t5、t3≈t5。
   *     三条曲线按同一批真实数据回测 3 次：0.16 / 0.14 / 0.11 次·品种·日，
   *     前端再叠「5 分钟同向过半」闸门与逐品种冷却 → 全盘每天 3~4 条。
   *
   *   * 2026-11-11 重标定（用户审查）：原来 t3 与 t5 完全相等，等于 3 分钟
   *     窗口形同虚设。现统一为 t2 = round(0.78·t5, 3)、t3 = round(0.88·t5, 3)，
   *     保证 t1 < t2 < t3 < t5 严格单调递增；HSI 按港股真实波动率整体上调，
   *     N225 的 t30 倒挂（1.181 < t15 1.187）修正为 1.450。
   *
   *   ⚠️ 这里的 t1~t30 是「初始先验」，运行时由 volprofile.js 的波动率库
   *      （VolBank）用页面自己观测到的日极值逐日校正：40 个交易日后权重
   *      w 达到 1，但经验值始终夹紧在 [base*0.6, base*2.0] 内（防脏数据
   *      打穿），并非完全无约束地交给实盘；样本 ≥15 日时还会做
   *      「近 15 日 ×0.7 + 全量 ×0.3」双窗口分位融合。
   *      v137 起界面上的「灵敏度滑杆」已下线：阈值只由这套自适应决定，
   *      不再有任何人工系数。
   * ---------------------------------------------- */
  const RADAR = [
    // A股股指
    { k: 'AX',       w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.462, t2: 0.546, t3: 0.616, t5: 0.700, t15: 1.100, t30: 1.360 },
    { k: 'HS300',    w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.594, t2: 0.702, t3: 0.792, t5: 0.900, t15: 1.280, t30: 1.400 },
    { k: 'SZ',       w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.710, t2: 0.839, t3: 0.947, t5: 1.076, t15: 1.628, t30: 2.327 },
    { k: 'CYB',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.970, t2: 1.147, t3: 1.294, t5: 1.470, t15: 2.350, t30: 2.909 },
    { k: 'SZ50',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.382, t2: 0.451, t3: 0.509, t5: 0.578, t15: 1.097, t30: 1.181 },
    { k: 'KC50',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.367, t2: 1.615, t3: 1.822, t5: 2.071, t15: 3.450, t30: 4.237 },
    // 亚太股指
    { k: 'HSI',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.550, t2: 0.741, t3: 0.836, t5: 0.950, t15: 1.450, t30: 1.750 },
    { k: 'HSTECH',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.850, t2: 1.005, t3: 1.134, t5: 1.289, t15: 2.458, t30: 3.064 },
    { k: 'KS11',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.709, t2: 0.838, t3: 0.945, t5: 1.074, t15: 2.048, t30: 2.553 },
    { k: 'N225',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.481, t2: 0.568, t3: 0.641, t5: 0.728, t15: 1.187, t30: 1.450 },
    { k: 'TWII',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.334, t2: 0.395, t3: 0.445, t5: 0.506, t15: 0.707, t30: 1.057 },
    // 美股股指
    { k: 'SPX',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.188, t2: 0.222, t3: 0.251, t5: 0.285, t15: 0.436, t30: 0.595 },
    { k: 'NDX',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.267, t2: 0.316, t3: 0.356, t5: 0.405, t15: 0.605, t30: 0.801 },
    { k: 'SOX',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.624, t2: 0.737, t3: 0.832, t5: 0.945, t15: 1.567, t30: 2.245 },
    { k: 'DJI',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.217, t2: 0.257, t3: 0.290, t5: 0.329, t15: 0.532, t30: 0.730 },
    { k: 'VIX',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 3.443, t2: 4.054, t3: 4.573, t5: 5.197, t15: 7.039, t30: 7.985 },
    // 美债收益率
    { k: 'US5Y',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.446, t2: 0.527, t3: 0.595, t5: 0.676, t15: 1.055, t30: 1.352 },
    { k: 'US10Y',    w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.459, t2: 0.542, t3: 0.612, t5: 0.695, t15: 1.084, t30: 1.389 },
    { k: 'US30Y',    w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.266, t2: 0.314, t3: 0.355, t5: 0.403, t15: 0.629, t30: 0.806 },
    // 外汇
    { k: 'DXY',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.085, t2: 0.101, t3: 0.114, t5: 0.129, t15: 0.200, t30: 0.257 },
    { k: 'USDCNH',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.044, t2: 0.051, t3: 0.058, t5: 0.066, t15: 0.077, t30: 0.121 },
    { k: 'USDJPY',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.120, t2: 0.142, t3: 0.160, t5: 0.182, t15: 0.246, t30: 0.289 },
    { k: 'EURUSD',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.157, t2: 0.186, t3: 0.209, t5: 0.238, t15: 0.274, t30: 0.374 },
    // 能源
    { k: 'BRENT',    w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.081, t2: 1.278, t3: 1.441, t5: 1.638, t15: 2.305, t30: 2.602 },
    { k: 'WTI',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.104, t2: 1.304, t3: 1.471, t5: 1.672, t15: 2.255, t30: 2.664 },
    { k: 'NG',       w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.267, t2: 1.497, t3: 1.689, t5: 1.919, t15: 2.754, t30: 3.323 },
    // 金属（贵金属 + 工业金属）
    { k: 'GOLD',     w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.522, t2: 0.617, t3: 0.696, t5: 0.791, t15: 0.950, t30: 1.267 },
    { k: 'SILVER',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.974, t2: 1.151, t3: 1.298, t5: 1.475, t15: 1.780, t30: 2.254 },
    { k: 'COPPER',   w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.419, t2: 0.495, t3: 0.558, t5: 0.634, t15: 0.804, t30: 1.026 },
    // 加密
    { k: 'BTC',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 0.831, t2: 0.981, t3: 1.107, t5: 1.258, t15: 1.380, t30: 1.931 },
    { k: 'ETH',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.334, t2: 1.576, t3: 1.778, t5: 2.021, t15: 2.553, t30: 2.822 },
    { k: 'SOL',      w1: 1, w2: 2, w3: 3, w5: 5, w15: 15, w30: 30, t1: 1.140, t2: 1.346, t3: 1.519, t5: 1.726, t15: 2.596, t30: 3.279 },
  ];

  /* 兼容字段：老代码读 t.win / t.thr（30 分钟主口径）。
   * 新代码应优先读 t.w5/t15/t30 + t.t5/t15/t30。 */
  RADAR.forEach(t => {
    t.win = t.w5; t.thr = t.t5;
    /* 六个尺度并联，任一越线就报警。
     *   1/2/3 分钟 —— 闪崩、垂直拉升（黑天鹅真正发生的尺度）
     *   5 分钟     —— 主战场：几分钟内走完的急动
     *   15/30 分钟 —— 持续趋势，确认不是插针
     * 阈值必须单调递增：窗口越长，能容纳的位移越大。 */
    t.scales = [
      { win: t.w1,  thr: t.t1,  name: '闪' },
      { win: t.w2,  thr: t.t2,  name: '急' },
      { win: t.w3,  thr: t.t3,  name: '快' },
      { win: t.w5,  thr: t.t5,  name: '短' },
      { win: t.w15, thr: t.t15, name: '中' },
      { win: t.w30, thr: t.t30, name: '慢' }
    ];
  });

  // 首页行情条
  const TICKER_DEFAULT = ['AX', 'HS300', 'N225', 'TWII', 'SPX', 'NDX', 'US10Y', 'DXY', 'USDCNH', 'BRENT', 'GOLD', 'BTC'];

  // 行情页默认展示（可在页面内增删）
  // 组内顺序：A股 上证→沪深300→深成→创业板→上证50→科创50；
  //          亚太 港股→韩国→日本→台湾；美股 标普→纳指→费半→道指→VIX
  const MARKET_DEFAULT = [
    'AX', 'HS300', 'SZ', 'CYB', 'SZ50', 'KC50',
    'HSI', 'HSTECH', 'KS11', 'N225', 'TWII',
    'SPX', 'NDX', 'SOX', 'DJI', 'VIX',
    'US5Y', 'US10Y', 'US30Y',
    'DXY', 'USDCNH', 'USDJPY', 'EURUSD',
    'BRENT', 'WTI', 'NG',
    'GOLD', 'SILVER',
    'COPPER',
    'BTC', 'ETH', 'SOL'
  ];

  /* v101：A 股全市场自动映射 —— 词表来自 cn-stocks.js（构建期快照）。
   * 不把 5 千多只票静态写进 ASSETS：只在真有快讯点到某只票时，按需合成
   * 一条标的描述并缓存进 ASSETS。这样 normItem 的 U.get() 过滤不会再把
   * 「标题点名但未登记」的个股丢掉，详情页 / 行情面板也拿得到报价。
   * 东财 secid：6 开头（含 688 科创板）→ 1.；0/3/4/8 开头 → 0. */
  const CN_ALL = w.CN_STOCKS || {};
  const CN_STRIP = /^(?:S\*ST|\*ST|SST|ST|XD|XR|DR|N|C)\s*/;
  function cnName(code) {
    const n = CN_ALL[String(code)];
    if (!n) return '';
    return String(n).replace(CN_STRIP, '')
      .replace(/[Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  }
  function synthCN(code) {
    const nm = cnName(code);
    if (!nm) return null;
    const s = String(code);
    /* 【市场号不能只看首位】
     * 6 开头＝沪A（含 688 科创）、900 开头＝沪B → 1.
     * 其余全是 0.：深A 000/001/002/003、创业板 300/301、深B 200、
     * 北交所 43/83/87/88，以及 2026 年新启用的 **920 段**。
     * 之前写成 `p==='6'||p==='9'`，把 920xxx 也归进了沪市 → 东财查不到
     * （实测 920275 驱动力 用 1.920275 返回空，分时直接掉进合成假数据）。 */
    const sh = s.charAt(0) === '6' || /^900/.test(s);
    const bj = /^(920|4|8)/.test(s);
    const a = {
      name: nm, short: nm, src: 'em',
      secid: (sh ? '1.' : '0.') + code, dec: 2,
      grp: 'cnstock', kind: 'stock', unit: '元',
      tv: (sh ? 'SSE:' : (bj ? 'BJSE:' : 'SZSE:')) + code, _synth: true
    };
    ASSETS[code] = a;
    return a;
  }
  /* v101：港股 / 美股全市场点名个股也按需合成。
   * 词表同在 cn-stocks.js 的 w.GLOBAL_STOCKS：code → [中文名, 市场号, HK|US]。
   * 港股 secid 用 116.（东财港股行情市场号），美股沿用接口给的 f13
   * （105 纳斯达克 / 106 纽交所）。不预先铺进 ASSETS，命中一次缓存一次。 */
  const GLOBAL_ALL = w.GLOBAL_STOCKS || {};
  /* 港美股新闻常用的 2 字简称：全市场词表为避免歧义只收 ≥3 字名，
   * 这些大票手工登记（格式与 GLOBAL_STOCKS 一致：名 / 市场号 / 市场）。 */
  const GLOBAL_SHORT = {
    '03690': ['美团', '128', 'HK'], '09999': ['网易', '128', 'HK'],
    '09618': ['京东', '128', 'HK'], '01024': ['快手', '128', 'HK'],
    '09888': ['百度', '128', 'HK'], '00992': ['联想', '128', 'HK'],
    '02331': ['李宁', '128', 'HK'], '02015': ['理想', '128', 'HK'],
    '09866': ['蔚来', '128', 'HK'], '09868': ['小鹏', '128', 'HK']
  };
  function synthGlobal(key) {
    const g = GLOBAL_ALL[String(key)] || GLOBAL_SHORT[String(key)];
    if (!g) return null;
    const nm = g[0], mkt = String(g[1]), isHK = g[2] === 'HK';
    const a = {
      name: nm, short: nm, src: 'em',
      secid: (isHK ? '116.' : mkt + '.') + key, dec: 2,
      grp: isHK ? 'hkstock' : 'usstock', kind: 'stock',
      unit: isHK ? '港元' : 'USD',
      tv: (isHK ? 'HKEX:' : (mkt === '106' ? 'NYSE:' : 'NASDAQ:')) + key,
      _synth: true
    };
    ASSETS[key] = a;
    return a;
  }
  /* v59：台股 4 位代码按需合成（2330 / 2317 / 2454 …）。
   * 之前只有 2330/2327/2454 三只写死在 HARD 表里，用户加别的台股会报
   * 「unknown asset 2317」，等于台股只能看这三只。
   * 4 位纯数字在港美股/A股里都不出现（港股 5 位、A股 6 位、美股带字母），
   * 所以这个判据足够安全。名称先占位为代码，首次拉分钟线时用 Yahoo 的
   * shortName 回填（见 api.js twMinutes / intraday）。 */
  /* v64：4 位数字代码在台股 / 日股之间会撞车（台股 2330、日股 6758 都是 4 位）。
   * 之前一律当台股，用户加日股会变成「台股个股」且取不到价。
   * 这里只放几个确定无疑的东证大票，其余 4 位仍按台股处理。 */
  const JP_KNOWN = {
    '6758': '索尼集团', '8306': '三菱日联', '9983': '迅销', '7974': '任天堂',
    '8035': '东京电子', '4063': '信越化学', '9432': 'NTT', '6501': '日立',
    '6752': '松下控股', '6902': '电装'
  };
  function synthTW(key) {
    if (!/^\d{4}$/.test(String(key))) return null;
    const jpName = JP_KNOWN[String(key)];
    if (jpName) {
      const j = {
        name: jpName, short: jpName, src: 'em',
        secid: '176.' + key, dec: 2,
        grp: 'jpstock', kind: 'stock', unit: '日元',
        tv: 'TSE:' + key, _synth: true
      };
      ASSETS[key] = j;
      return j;
    }
    const a = {
      name: String(key), short: String(key), src: 'em',
      secid: '178.' + key, dec: 2,
      grp: 'twstock', kind: 'stock', unit: '新台币',
      tv: 'TWSE:' + key, _synth: true
    };
    ASSETS[key] = a;
    return a;
  }
  function get(key) {
    if (ASSETS[key]) return ASSETS[key];
    const s = String(key);
    if (/^\d{6}$/.test(s)) return synthCN(s);
    if (GLOBAL_ALL[s] || GLOBAL_SHORT[s]) return synthGlobal(s);
    if (/^\d{4}$/.test(s)) return synthTW(s);
    return null;
  }
  /* v273：ETF / 全市场 suggest 合成 —— 东财搜索建议返回 QuoteID（=secid），
   * 任意市场通用（沪深基金 1./0.、美股 105/106/107、港股 116…）。
   * A股 ETF/基金价格 3 位小数（如 0.707），美股/港股 2 位。
   * kind='etf' 仅作标记；grp 借用现有分组键，行情列表无需新增分组。 */
  function synthSecid(secid, code, name) {
    code = String(code || secid.replace('.', '_'));
    if (ASSETS[code]) return ASSETS[code];
    const mkt = String(secid).split('.')[0];
    const us = mkt === '105' || mkt === '106' || mkt === '107';
    const hk = mkt === '116';
    const nm = String(name || code);
    const a = {
      name: nm, short: nm, src: 'em',
      secid: String(secid), dec: us || hk ? 2 : 3,
      grp: us ? 'usstock' : (hk ? 'hkstock' : 'cnstock'),
      kind: 'etf', unit: us ? 'USD' : (hk ? '港元' : '元'),
      _synth: true
    };
    ASSETS[code] = a;
    return a;
  }
  function name(key) { const a = get(key); return a ? (a.short || a.name) : key; }
  function fullName(key) { const a = get(key); return a ? a.name : key; }
  function grp(key) { const a = get(key); return a ? (GROUPS[a.grp] || { label: '', color: '#8b95a6', order: 99 }) : { label: '', color: '#8b95a6', order: 99 }; }
  function decimals(key) { const a = get(key); return a ? a.dec : 2; }
  function keys() { return Object.keys(ASSETS); }
  // 组内默认先后（没写 ord 的排到后面，按传入顺序稳定排列）
  function orderOf(key) { const a = ASSETS[key]; return a && a.ord != null ? a.ord : 99; }

  function fmt(key, v) {
    if (v == null || isNaN(v)) return '--';
    const a = ASSETS[key];
    const d = a ? a.dec : 2;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pct(v) {
    if (v == null || isNaN(v)) return '--';
    const n = Number(v);
    const s = n.toFixed(2);
    if (Math.abs(parseFloat(s)) < 0.005) return '0.00%';   // 不显示 -0.00%
    return (n >= 0 ? '+' : '') + s + '%';
  }

  // 涨跌展示：收益率类给「基点(bp)」而不是百分比 —— 交易员口径
  function changeLabel(key, q) {
    if (!q) return '--';
    const a = ASSETS[key];
    if (a && a.kind === 'yield' && q.chg != null && !isNaN(q.chg)) {
      const bp = q.chg * 100;
      return (bp >= 0 ? '+' : '') + bp.toFixed(1) + 'bp';
    }
    return pct(q.pct);
  }

  /* ---------------- 跨市场「暗盘」映射（v64） ----------------
   * 用户口径：「如果日股韩股台股有暗盘或者链上，也要弄出来」。
   * 实测 Hyperliquid 的 xyz 市场（7×24 个股永续）列出的是**同一家公司的海外挂牌**：
   *   SKHX   = SK 海力士（1:1，$870.77 ↔ 1,132,000 KRW，隐含汇率 ~1300）
   *   TSM    = 台积电 ADR（1 ADS = 5 股普通股，故价格是台股 1/5 量级）
   *   SMSN   = 三星电子 GDR（伦敦挂牌）
   *   SOFTBANK / KIOXIA / IBIDEN = 软银 / 铠侠 / 揖斐电
   * 这些都不是本币挂牌，**不能直接与本地价格比基差**（币种 + 换算比例都不同），
   * 所以只作为「暗盘参考价」展示，标注 ADR/GDR 与代码，不计算基差。
   * 只收录已核过标的身份、比例明确的；不确定的一律不放，宁可少显示。 */
  const ADR_MAP = {
    '000660': { sym: 'SKHX', label: 'ADR 1:1', ratio: 1 },
    '005930': { sym: 'SMSN', label: 'GDR', ratio: null },
    '2330':   { sym: 'TSM',  label: 'ADR 1:5', ratio: 5 },
    '2303':   { sym: 'UMC',  label: 'ADR 1:5', ratio: 5 },
    '9984':   { sym: 'SOFTBANK', label: 'ADR', ratio: null },
    '285A':   { sym: 'KIOXIA',   label: 'ADR', ratio: null },
    '4062':   { sym: 'IBIDEN',   label: 'ADR', ratio: null }
  };
  function adrOf(key) { return ADR_MAP[String(key)] || null; }

  w.UNIVERSE = {
    ASSETS, GROUPS, RADAR, TICKER_DEFAULT, MARKET_DEFAULT,
    get, name, fullName, grp, decimals, fmt, pct, changeLabel, keys, orderOf,
    cnName, shortNames: GLOBAL_SHORT,
    /* v149：全市场名录搜索命中后现场合成品种用（synthCN 写 ASSETS，后续照常取报价） */
    synthCN, synthGlobal, synthSecid,
    adrOf
  };
})(window);
