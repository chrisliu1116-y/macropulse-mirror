/* ============================================================
 * api.js — 行情数据适配层
 * 真实数据源（均开放 CORS，浏览器可直连）：
 *   1) 东财 push2     — 批量快照（一次请求拿全部品种的价格/涨跌幅）
 *   2) 东财 push2his  — K线 / 分时
 *   3) 币安 open API  — BTC/ETH/SOL 分钟级 K 线
 *   4) DexScreener    — 链上池子价格（非交易时段 / CEX-DEX 基差）
 * v284：取不到数时**不再降级为合成的「演示数据」**。假曲线一旦画上去，
 *       就会和顶部的真实报价同时出现（用户 11-12 截图：报价 7634，分时却写着
 *       昨收 3793 的假数字），比空着更误导。现在如实返回 failed + 原因，
 *       由图表显示「取数失败」。
 * ============================================================ */
(function (w) {
  'use strict';

  /* 主站（WorkBuddy）带 server.py，提供 /api/news、/__proxy、/__fetch 三个同源后端通道。
   * GitHub Pages 备用源是纯静态、没有后端，这些路径必然 404。
   * 非主站时直接跳过它们，走浏览器直连 / 第三方中转，别每次都先打一个注定 404 的请求。 */
  const HAS_BACKEND = (typeof location !== 'undefined') && /workbuddy\.host$/.test(location.hostname);

  const U = w.UNIVERSE;

  /* v284【历史接口多宿主】2026-11-12 01:5x 实测（IPv4 直连、带 Referer/UA）：
   *   · push2.eastmoney.com/api/qt/ulist.np/get  → HTTP 200，正常返回 JSON；
   *   · push2his.eastmoney.com/api/qt/stock/trends2/get → TLS 握手成功后
   *     **0 字节直接断开**；同一秒内的同一台机器上两个域名表现完全不同。
   *   连续请求若干次后整站开始回 403（openresty 风控页）。
   *   设备侧的表现正是「顶部报价是真的、点进分时全是假的」——因为报价走 push2，
   *   分时/K线走 push2his，两个域名是两条独立的命。
   * 所以历史接口不再绑死一个域名，按顺序试：
   *   ① push2his（首选）② push2（同款 API 路径）
   *   ③ 同源 /__proxy（服务端取数，换出口 IP 绕开对客户端的限流；file:// 下不可用）
   * 三条都失败才算失败，并把每一步的原因拼起来交给 UI 显示。 */
  const EM_HIS_HOSTS = ['https://push2his.eastmoney.com', 'https://push2.eastmoney.com'];
  const EM_KLINE_PATH = '/api/qt/stock/kline/get';
  const EM_TREND_PATH = '/api/qt/stock/trends2/get';
  const EM_LIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
  const EM_GET = 'https://push2.eastmoney.com/api/qt/stock/get';
  const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
  /* v338【东财静默开关】家里宽带 IP 仍在冷却期，用户要求日常看盘对东财零请求，
   * 让 IP 彻底静默解封。置 true 后所有东财请求在发网络之前直接失败（不产生
   * 任何 TCP/TLS 连接），自动走腾讯/新浪/Yahoo/CNBC/币安兜底；需要恢复东财时改成 false。 */
  const EM_QUIET = true;
  const BN_BASE = 'https://api.binance.com/api/v3';

  /* 币安系多域名：主站在国内网络经常 DNS 污染 / 连接重置，
   * data-api.binance.vision 是官方给公开行情用的只读域名，通常能通。 */
  const BN_HOSTS = [
    'https://api.binance.com/api/v3',
    'https://api-gcp.binance.com/api/v3',   /* v312：官方高可用镜像（实测 200） */
    'https://data-api.binance.vision/api/v3',
    'https://api1.binance.com/api/v3',
    'https://api2.binance.com/api/v3',
    'https://api3.binance.com/api/v3',
    'https://api4.binance.com/api/v3',
  ];
  let bnHost = 0;
  const DEX_BASE = 'https://api.dexscreener.com/latest/dex';

  const cache = new Map();
  const status = { em: 'unknown', emHis: 'unknown', binance: 'unknown', dex: 'unknown', ext: 'unknown', hl: 'unknown', cboe: 'unknown', lastErr: '', lastOk: 0 };

  /* ---------------- 基础工具 ---------------- */

  /* v301【代理双通道】线上静态托管没有 server.py，同源 /__proxy 恒 404；
   * 这里统一封装：先试同源，失败再试 Cloudflare Worker 的 /__proxy。
   * Worker 已加同路由（白名单放行行情源），两条路任一可用即可。 */
  const WORKER_BASE = 'https://macropulse-edge.mp-7962af18.workers.dev';
  /* v303【Worker 熔断】workers.dev 在国内被网络封锁，实测连接超时 12s。
   * 若每次请求都去等它，手机端每个数据请求白卡 12 秒 —— 这是比数据缺失更糟的体验。
   * 策略：① 只用 1500ms 超时探测；② 探测失败后全局熔断，本次会话不再尝试；
   * ③ 熔断后所有代理请求只走同源（同源 404 就直接失败，由调用方切腾讯/新浪直连）。 */
  let _workerDead = false;
  function _workerTry(q) {
    if (_workerDead) return Promise.reject(new Error('worker circuit open'));
    return new Promise((resolve, reject) => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        _workerDead = true;                 // 一旦超时，本次会话永久跳过
        reject(new Error('worker timeout'));
      }, 1500);
      fetch(WORKER_BASE + '/__proxy?u=' + q, ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' })
        .then(r => { clearTimeout(timer); if (r.ok) return resolve(r); _workerDead = true; reject(new Error('worker HTTP ' + r.status)); })
        .catch(e => { clearTimeout(timer); _workerDead = true; reject(e); });
    });
  }
  async function proxyFetch(target, opts) {
    const q = encodeURIComponent(target);
    const o = Object.assign({ cache: 'no-store' }, opts || {});
    let firstErr = null;
    try {
      const r = await fetch('/__proxy?u=' + q, o);
      if (r.ok) return r;
      firstErr = new Error('same-origin HTTP ' + r.status);
    } catch (e) { firstErr = e; }
    try {
      return await _workerTry(q);
    } catch (e2) {
      throw firstErr || e2;
    }
  }

  async function getJSON(url, ttl, tag) {
    if (EM_QUIET && /eastmoney\.com/.test(String(url))) throw new Error('em quiet (IP cooldown)');
    const hit = cache.get(url);
    const now = Date.now();
    if (hit && now - hit.t < ttl) return hit.d;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store',
        headers: { 'User-Agent': (w.navigator && w.navigator.userAgent) || 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      cache.set(url, { t: now, d });
      if (cache.size > 400) { // 批量报价的 URL 带时间戳，避免缓存无限膨胀
        let i = 0;
        for (const k of cache.keys()) { cache.delete(k); if (++i > 120) break; }
      }
      if (tag) status[tag] = 'ok';
      status.lastOk = now;
      return d;
    } catch (e) {
      if (tag) status[tag] = 'fail';
      status.lastErr = (e && e.message) || 'network';
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 东财「历史类」接口（K线 / 分时）统一入口：多宿主 + 同源代理兜底。
   *  路径参数里已经带好 query string。全部失败时抛出集合后的原因。 */
  async function emHistJSON(pathQuery, ttl) {
    if (EM_QUIET) throw new Error('em quiet (IP cooldown)');
    const errs = [];
    for (const host of EM_HIS_HOSTS) {
      try {
        const d = await getJSON(host + pathQuery, ttl);
        status.emHis = 'ok';
        return d;
      } catch (e) {
        errs.push(host.replace(/^https:\/\//, '').replace(/\.eastmoney\.com$/, '')
          + ':' + ((e && e.message) || 'net'));
      }
    }
    /* 直连两个域名都挂 → 让服务端再试一次（出口 IP 不同，能绕开对客户端的限流） */
    if (typeof location !== 'undefined' && location.protocol !== 'file:') {
      try {
        const r = await proxyFetch(EM_HIS_HOSTS[0] + pathQuery);
        if (r.ok) {
          const d = await r.json();
          if (d && d.data) { status.emHis = 'ok-proxy'; return d; }
          errs.push('proxy:empty');
        } else {
          errs.push('proxy:HTTP ' + r.status);
        }
      } catch (e) {
        errs.push('proxy:' + ((e && e.message) || 'net'));
      }
    }
    status.emHis = 'fail';
    const msg = errs.join(' / ') || 'em history fail';
    status.lastErr = msg;
    throw new Error(msg);
  }

  // '2026-11-03 09:30' → unix seconds（按 UTC 分量对齐，使坐标轴直接显示北京时间）
  function tMin(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  }
  function tDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
  }

  /** 日线 → 周/月线。CBOE 只吐日线，周K月K在客户端聚合，不再打接口。 */
  /* v332：直达源（新浪期货/腾讯/新浪外汇/CNBC/期权）只给日线，之前无论点
   * 日K/周K/月K 都原样返回 —— 用户看到的周K月K其实是日线（外汇实测完全一致）。
   * 统一按请求周期在客户端聚合，保证三类周期各有其形。 */
  function toMode(pts, mode, m) {
    const arr = (mode === 'd') ? pts : aggregate(pts, mode);
    return arr.slice(-(m || 260));
  }

  function aggregate(pts, mode) {
    const out = [];
    let cur = null, curKey = '';
    for (const p of pts) {
      const ms = p.time * 1000;
      const dt = new Date(ms);
      let key;
      if (mode === 'm') {
        key = dt.getUTCFullYear() + '-' + (dt.getUTCMonth() + 1);
      } else {
        const wd = (dt.getUTCDay() + 6) % 7;             // 周一 = 0
        const mon = new Date(ms - wd * 86400000);
        key = mon.getUTCFullYear() + '-' + (mon.getUTCMonth() + 1) + '-' + mon.getUTCDate();
      }
      if (key !== curKey) {
        if (cur) out.push(cur);
        cur = { time: p.time, open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume || 0 };
        curKey = key;
      } else {
        cur.high = Math.max(cur.high, p.high);
        cur.low = Math.min(cur.low, p.low);
        cur.close = p.close;
        cur.volume = (cur.volume || 0) + (p.volume || 0);
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 失败的统一返回形状 ----------------
   * v284：原来这里有一条 synth()（随机游走 + base 3600 之类），任何品种取数失败
   * 都会画出一条「长得像行情」的假曲线，图例只挂一个 8px 的「演示数据」小字。
   * 用户 11-12 的截图就是三种品种（标普/KOSPI/SK海力士）同时命中它：
   * 假昨收 3793.71 / 3806.28 / 3702.95 全落在 3600–3900（正是上证的量级），
   * 而顶部报价是真实的 —— 两套数字差一倍。
   * 现在**不再合成**，统一返回 failed + 原因，让界面直接说「取数失败」。 */
  function failedRes(reason) {
    return { points: [], preClose: 0, synthetic: false, failed: true, error: String(reason || 'net') };
  }

  /* v286【行情可信白名单 / API 出口硬闸】--------------------------------------
   * 11-12 事故复盘：intradayRaw 的 catch(e) 无条件调用 synth() 生成随机游走，
   * 上游 push2his 一挂就把 240 个假点当成真分时画出去（假昨收 3793.71…）。
   * 现在除删除 synth() 外，再加一道出口校验：只有「未失败 + 非合成 + src 属于
   * 下列真实数据源」的序列才允许离开 API 层。所有调用方（charts.render、
   * app.js 的缩略图 loadMkSpark、quote、雷达）都只能拿到真数据或 failedRes。
   * 这样即便将来有人误加一条无源 / 合成的返回，也会在这里被改写成空 failed。
   * 与 charts.js 的 SRC_NAME 白名单保持一致。 */
  const REAL_SOURCES = Object.freeze([
    'em', 'tencent', 'sina', 'cboe', 'cnbc', 'yahoo', 'binance',
    'nasdaq', 'naver', 'mixed', 'tx', 'tv', 'jp-pts', 'twse',
    /* v310：财政部官方日频收益率 / 新浪 ETF 期权 / CBOE 期权链 */
    'treasury', 'sinaopt', 'cboeopt', 'okx'
  ]);
  function trusted(res) {
    if (!res || res.failed || res.synthetic) return false;
    if (!res.points || !res.points.length) return false;
    return REAL_SOURCES.indexOf(res.src) >= 0;
  }
  function finalize(res, reason) {
    return trusted(res) ? res : failedRes((res && res.error) || reason || 'untrusted series');
  }

  /* ---------------- 东财封装 ---------------- */

  async function emKline(secid, klt, lmt, fqt) {
    const q = `${EM_KLINE_PATH}?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6`
      + `&fields2=f51,f52,f53,f54,f55,f56,f57&klt=${klt}&fqt=${fqt === 0 ? 0 : 1}&end=20500101&lmt=${lmt}`;
    const d = await emHistJSON(q, 30000);
    const rows = (d && d.data && d.data.klines) || [];
    /* 空包也必须当失败抛出：以前这里返回 []，上层再兜底到合成曲线，
     * 结果「接口回了 200 但没有 klines」= 一张假 K 线。 */
    if (!rows.length) throw new Error('em kline empty');
    return rows.map(r => {
      const p = r.split(',');
      return {
        time: klt === 1 || klt === 5 || klt === 15 || klt === 30 || klt === 60 ? tMin(p[0]) : tDay(p[0]),
        open: +p[1], close: +p[2], high: +p[3], low: +p[4],
        volume: +p[5] || 0,
        /* v169：f57 = 成交额（本币）。实测 94 个品种里 64 个有真实值；
         * 指数/汇率/美债/台日韩本地个股为 0，副图会自动退回成交量。 */
        amount: +p[6] || 0
      };
    }).filter(x => x.time && isFinite(x.close));
  }

  // 前复权在「高分红 + 长历史」时会算出负数价格（东财的已知副作用），
  // 一旦发现就改用不复权（fqt=0），宁可有个除权缺口也不能出现负价。
  function klineValid(pts) {
    return pts.every(p => p.close > 0 && p.low > 0 && p.high > 0);
  }

  async function emTrend(secid, ndays) {
    const q = `${EM_TREND_PATH}?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8`
      + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${ndays || 1}&iscr=0&iscca=0`;
    const d = await emHistJSON(q, 15000);
    const data = (d && d.data) || {};
    const rows = data.trends || [];
    const pts = rows.map(r => {
      const p = r.split(',');
      return { time: tMin(p[0]), open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5] || 0, avg: +p[7] || +p[2] };
    }).filter(x => x.time && isFinite(x.close));
    return { points: pts, preClose: +data.preClose || (pts[0] && pts[0].close) || 0, name: data.name || '' };
  }

  /* ---------------- 外盘商品实时源（新浪分时 + 腾讯报价） ----------------
   * 【为什么非加不可】东财对 CME / ICE 商品是**延时 10 分钟**的源：
   * 实测 WTI / 布伦特 / 白银 / 铜 / 天然气 的分时末点、1 分钟 K 最后一根、
   * 报价 f86 时间戳全都停在同一个时刻，比当前时间早 600 秒。
   * TradingView scanner 对这些合约的 update_mode 同样是 delayed_streaming_600，
   * 所以这是「源」的问题，不是抓取姿势的问题，只能换源。
   *
   * 【实测可用的两个通道】
   *   · 新浪 GlobalFuturesService（jsonp.php）→ 分钟分时，**真实时**
   *     （末点就是当前分钟），响应 Content-Type 是 application/javascript，
   *     不会触发 ORB 拦截，也不校验 Referer；
   *   · 腾讯 qt.gtimg.cn → 报价，真实时，且 Access-Control-Allow-Origin: *，
   *     可以普通 fetch（响应是 GBK，用 TextDecoder 解码）。
   *
   * 【代价】两家都不提供成交量 —— 这几个品种的分时副图会显示「量 --」，
   * 与其混一条延时 10 分钟的柱子，不如老实留空。
   */

  const SINA_FUT = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20__CB__=/'
    + 'GlobalFuturesService.getGlobalFuturesMinLine?symbol=';
  const TX_Q = 'https://qt.gtimg.cn/q=';
  let sinaSeq = 0;
  const sinaCache = new Map();
  const txCache = new Map();

  /** JSONP：新浪这条通道没有 CORS 头，只能挂 <script>。
   *  【关键】新浪的 jsonp.php 不是「回调函数」形态，而是**变量赋值**：
   *    var __sina_cb_1=({"minLine_1d":[...]});
   *  所以不能挂一个函数等它调用（会被赋值直接覆盖掉，回调永远不触发），
   *  必须在 onload 之后去读同名全局变量。回调名带自增序号避免并发覆盖。 */
  function sinaJSONP(url, timeout) {
    return new Promise((resolve, reject) => {
      const g = '__sina_cb_' + (++sinaSeq);
      const s = document.createElement('script');
      let done = false;
      const fin = (err) => {
        if (done) return;
        done = true;
        const got = window[g];
        try { delete window[g]; } catch (e) { /* var 声明的全局属性删不掉 */ }
        window[g] = undefined;
        if (s.parentNode) s.parentNode.removeChild(s);
        if (err) reject(err);
        else if (!got) reject(new Error('sina empty'));
        else resolve(got);
      };
      const timer = setTimeout(() => fin(new Error('sina timeout')), timeout || 12000);
      s.charset = 'gbk';
      s.onload = () => { clearTimeout(timer); fin(null); };
      s.onerror = () => { clearTimeout(timer); fin(new Error('sina net')); };
      s.src = url.replace('__CB__', g);
      document.head.appendChild(s);
    });
  }

  /* ---------------- 腾讯分时 / 日K（A股 · 港股） ----------------
   * 2026-11-12 实测（本机；响应带 Access-Control-Allow-Origin: *，浏览器可直连）：
   *   sh000001 / sz399001 / sh000300 → 242 根 09:30–15:00（逐分钟，date=20261111）
   *   sh600519 / sz300750            → 267 根（含集合竞价时段，已按时段过滤）
   *   hkHSI / hkHSTECH / hk00700     → 332 根，末根 16:08/18:31 是收盘快照（已过滤到 16:00）
   *   usINX / usAAPL / kr000660      → **只回 1 个当前 tick**，不能当分时（所以不接）
   * 东财 trends2 整站挂掉时，这是 A股/港股分时唯一可用的浏览器直连源。
   * 解构：`data[code].data.data` = ["0930 3655.66 累计量 累计额", ...]，
   *       量/额是**当日累计**，要按分钟差分；`data[code].qt[4]` 是昨收。
   */
  const TX_MIN = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
  const TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
  const txMinCache = new Map();

  /** 由 secid 推导腾讯代码：1.600519→sh600519；0.000001→sz000001；
   *  港股 100.HSI→hkHSI、124.HSTECH→hkHSTECH、116.00700→hk00700；
   *  v291：美股 105/106/107.GM→usGM（实测 usAAPL/usGM 等 27 只全部返回），
   *  指数 100.DJIA→usDJI、100.NDX→usIXIC（实测 52486/25466 与东财同量级，
   *  且 100.NDX＝纳斯达克综合，与腾讯 usIXIC 同口径）。其余返回 null。 */
  function txStockCode(key) {
    const a = U.get(key);
    if (!a || !a.secid) return null;
    const s = String(a.secid);
    if (/^1\.\d{6}$/.test(s)) return 'sh' + s.slice(2);
    if (/^0\.\d{6}$/.test(s)) return 'sz' + s.slice(2);
    if ((/^100\.|^124\.|^116\./.test(s)) && (a.sess === 'hk' || a.grp === 'hkstock')) {
      return 'hk' + s.split('.')[1];
    }
    if (/^(105|106|107)\./.test(s)) return 'us' + s.split('.')[1];
    if (s === '100.DJIA') return 'usDJI';
    if (s === '100.NDX') return 'usIXIC';
    return null;
  }

  /* ================= v309 品类精准主源直达 =================
   * 用户口径：不许「所有品种先撞东财、超时后再串行试别的源」。
   * 本机实测（Chrome UA + Referer，单次低频）：
   *   腾讯 qt/minute/fqkline 200 且 CORS:*；新浪 nf_IF0 / fx_susdcnh 200；
   *   CNBC US2Y 返回 last:"4.867%"；Yahoo 2330.TW 5m/5d 239 点。
   * 这些品类直接打主源，东财只作兜底。 */
  function directKind(a, key) {
    const g = (a && a.grp) || '';
    /* v311：RT_OVERRIDE 里的品种（SPX/HSI/WTI/GOLD/NG/COPPER/A50）必须进入直达分流，
     * 否则 grp 不在映射里会落回 TV / 东财兜底。 */
    const ov0 = key && RT_OVERRIDE[key];
    if (ov0) return ov0.t === 'sinag' ? 'sinag' : ov0.t;
    /* v310：动态注册的期权合约（新浪 CON_OP / CBOE OCC）也要直达主源 */
    if (a && a.src === 'sinaopt') return 'sinaopt';
    if (a && a.src === 'yahoo' && g === 'option') return 'yahoo';
    /* v310：src:yahoo 的指数（IXIC ^IXIC）也要直达实时 Yahoo，不落 TV 延时源 */
    if (g === 'us' && a && a.src === 'yahoo') return 'yahoo';
    if (g === 'cffex' || g === 'bondfut') return 'sinafut';
    if (g === 'fx') return 'sinafx';
    if (g === 'rate') return 'cnbc';
    if (g === 'twstock' || g === 'jpstock' || g === 'krstock' || g === 'glbfut') return 'yahoo';
    if (g === 'cn' || g === 'cnstock' || g === 'hkstock' || g === 'usstock') return 'tencent';
    return null;
  }
  async function sinaFxQuote(key, a) {
    const sym = (a && a.fxSym) || ('fx_s' + String(key).toLowerCase().replace(/^\w+?_?/, ''));
    const map = { USDCNH: 'fx_susdcnh', USDJPY: 'fx_susdjpy', EURUSD: 'fx_seurusd' };
    const code = map[key] || 'fx_s' + String(key).toLowerCase();
    const txt = await proxyText('https://hq.sinajs.cn/list=' + code,
      'https://finance.sina.com.cn/');
    const m = /="([^"]*)"/.exec(String(txt || ''));
    if (!m || !m[1]) return null;
    const f = m[1].split(',');
    const price = +f[1];            // 买价/最新价
    const prev = +f[8] || +f[3];    // 昨收
    if (!isFinite(price) || price <= 0) return null;
    return { price, prev, src: 'sina' };
  }
  /* v309【外汇日K】Yahoo 的 CNH=X 日线只有 1 根，本机实测新浪
   * NewForexService.getDayKLine?symbol=fx_susdcnh 返回 2014 年至今的日线字符串。 */
  async function sinaFxDaily(key, a, n) {
    const map = { USDCNH: 'fx_susdcnh', USDJPY: 'fx_susdjpy', EURUSD: 'fx_seurusd' };
    const code = map[key] || 'fx_s' + String(key).toLowerCase();
    const url = 'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_=/NewForexService.getDayKLine?symbol=' + code;
    const txt = await proxyText(url, 'https://finance.sina.com.cn/');
    const m = /\("([^"]*)"\)/.exec(String(txt || ''));
    if (!m || !m[1]) return [];
    const out = [];
    m[1].split('|').forEach(seg => {
      const f = seg.split(',');
      if (f.length < 5) return;
      const t = tDay(f[0]);
      const o = +f[1], lo = +f[2], hi = +f[3], c = +f[4];
      if (!t || !(c > 0)) return;
      out.push({ time: t, open: o || c, high: hi || c, low: lo || c, close: c, volume: 0 });
    });
    return out.slice(-(n || 200));
  }

  async function cnbcRateQuote(key, a) {
    const sym = (a && a.cnbc) || key;
    const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
      + '?symbols=' + encodeURIComponent(sym)
      + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
    let txt = '';
    try { txt = await fastText(url, 'https://www.cnbc.com/', 2500); }
    catch (e0) { txt = await fastText(url, 'https://www.cnbc.com/', 2500); }
    const cut = String(txt || '').indexOf('{');
    if (cut < 0) return null;
    const d = JSON.parse(String(txt).slice(cut));
    const q = (((d.FormattedQuoteResult || {}).FormattedQuote) || [])[0];
    if (!q) return null;
    const price = parseFloat(String(q.last || '').replace('%', ''));
    if (!isFinite(price) || price <= 0) return null;
    const chg = parseFloat(String(q.change || '0').replace('%', '')) || 0;
    return { price, prev: price - chg, src: 'cnbc' };
  }
  async function txQuoteOne(key, a) {
    const code = txStockCode(key);
    if (!code) return null;
    const txt = await proxyText('https://qt.gtimg.cn/q=' + code, 'https://gu.qq.com/');
    const m = /="([^"]*)"/.exec(String(txt || ''));
    if (!m || !m[1]) return null;
    const f = m[1].split('~');
    const price = +f[3], prev = +f[4];
    if (!isFinite(price) || price <= 0) return null;
    return { price, prev, src: 'tencent' };
  }
  /* 直达报价：按品类一次命中，不经过东财批次 */
  async function directQuote(key, a, out) {
    const kind = directKind(a, key);
    try {
      let r = null;
      /* v311：SPX/HSI/WTI/GOLD/NG/COPPER/A50 顶部报价 0 延时源优先，彻底剔除 TV */
      const ov = RT_OVERRIDE[key];
      if (ov) {
        if (ov.t === 'sinag') {
          r = await sinaGlobalQuote(ov.sym);
          if (r && a && a.pxScale) { r.price *= a.pxScale; if (r.prev) r.prev *= a.pxScale; }
        }
        else if (ov.t === 'tencent') {
          const txt = String(await proxyText('https://qt.gtimg.cn/q=' + ov.sym, 'https://gu.qq.com/') || '');
          const m = /="([^"]*)"/.exec(txt);
          if (m && m[1]) {
            const f = m[1].split('~');
            const price = +f[3], prev = +f[4];
            if (price > 0) r = { price, prev, src: 'tencent' };
          }
        } else if (ov.t === 'yahoo') {
          const hd = await yahooChart(ov.sym, '1m', '1d');
          const m = (((hd.chart || {}).result || [])[0] || {}).meta || {};
          if (m.regularMarketPrice > 0) {
            r = { price: m.regularMarketPrice,
              prev: m.chartPreviousClose || m.previousClose || m.regularMarketPrice, src: 'yahoo' };
          }
        }
      }
      if (kind === 'sinafut') r = await sinaFutQuote(key, a);
      else if (kind === 'sinafx') r = await sinaFxQuote(key, a);
      else if (kind === 'cnbc') r = await cnbcRateQuote(key, a);
      else if (kind === 'tencent') r = await txQuoteOne(key, a);
      else if (kind === 'sinaopt') r = await sinaOptionQuote((a && a.opSina) || key);
      else if (kind === 'yahoo') {
        /* v310：台股第一主源用 TWSE 官方实时（非延时 TV） */
        if (a && a.grp === 'twstock') {
          try {
            const q = await twseQuote(key);
            if (q && q.price > 0) r = { price: q.price, prev: q.prev, src: 'twse' };
          } catch (e) { /* 落 Yahoo */ }
        }
        if (!r) {
          /* v310：不再依赖 a.sym（7203/005930/2330 此前因此落回 TV 延时源），
           * 用 yahooSymbolFor 统一映射，并打 1m/1d 的实时 meta.regularMarketPrice。 */
          const ys = (a && a.sym && a.src === 'yahoo') ? a.sym : yahooSymbolFor(key, a);
          if (ys) {
            const hd = await yahooChart(ys, '1m', '1d');
            const m = (((hd.chart || {}).result || [])[0] || {}).meta || {};
            if (m.regularMarketPrice > 0) {
              const price = m.regularMarketPrice;
              const prev = m.chartPreviousClose || m.previousClose || price;
              r = { price, prev, src: 'yahoo' };
            }
          }
        }
      }
      if (r && r.price > 0) {
        const prev = r.prev || 0;
        out[key] = { price: r.price, prev, chg: prev ? r.price - prev : 0,
          pct: prev ? (r.price - prev) / prev * 100 : 0,
          at: Date.now(), src: r.src };
        return true;
      }
    } catch (e) { /* 落原链路 */ }
    return false;
  }

  /* ================== v310 真实源补齐（本机实测 2026-11-13） ==================
   * 用户指定 CNBC `ts-api` bars 为首选；本机 4 个路径实测 404，因此同时接入
   * 已实测可用的美国财政部官方日频收益率曲线（真实 2Y/10Y/30Y）。
   * 期权：国内走新浪 OP_UP/OP_DOWN + CON_OP 分钟线；美股走 CBOE 官方 CDN
   *   （SPY.json / NVDA.json / _SPX.json 实测 200，_SPY 403 → 双前缀自动试）+
   *   Yahoo OCC 合约分时/日K（实测 79 点 / 154 根）。全程不合成、不冒充。 */
  const CNBC_BARS = 'https://ts-api.cnbc.com/harmony/app/bars/';
  const TREASURY_CSV = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
    + 'daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv';
  const SINA_OPT_LIST = 'https://hq.sinajs.cn/list=';
  const SINA_OPT_API = 'https://stock.finance.sina.com.cn/futures/api/openapi.php/StockOptionDaylineService.';
  const CBOE_OPT = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';
  const SINA_REF = 'https://finance.sina.com.cn/';

  /* CNBC bars：用户给的 1M/1D、1D/1Y 路径。返回 barData.priceBars。 */
  async function cnbcBars(sym, iv, rg) {
    const url = CNBC_BARS + encodeURIComponent(sym) + '/' + iv + '/' + rg + '.json';
    const txt = await proxyText(url, 'https://www.cnbc.com/');
    const d = JSON.parse(String(txt || '').slice(String(txt || '').indexOf('{')));
    const bars = ((d.barData || {}).priceBars) || ((d.data || {}).priceBars) || [];
    return bars.map(b => ({
      time: Math.floor((+(b.tradeTimeinMills || b.tradeTime || 0)) / 1000),
      open: +(b.open || 0), high: +(b.high || 0), low: +(b.low || 0),
      close: +(b.close || 0), volume: +(b.volume || 0)
    })).filter(p => p.time > 0 && p.close > 0);
  }

  /* 美国财政部官方日频收益率曲线（CSV 真实值，含 2 Yr / 10 Yr / 30 Yr 列） */
  async function treasuryDaily(key, n) {
    const txt = String(await proxyText(TREASURY_CSV, 'https://home.treasury.gov/') || '');
    const lines = txt.trim().split(/\r?\n/);
    if (lines.length < 3) return [];
    const head = lines[0].split(',').map(x => x.replace(/"/g, '').trim());
    const want = key === 'US2Y' ? '2 Yr' : key === 'US10Y' ? '10 Yr' : key === 'US30Y' ? '30 Yr' : '2 Yr';
    const col = head.indexOf(want);
    if (col < 0) return [];
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(',');
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((f[0] || '').trim());
      const v = +f[col];
      if (!m || !(v > 0)) continue;
      out.push({ time: Math.floor(Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000),
        open: v, high: v, low: v, close: v, volume: 0 });
    }
    out.sort((a, b) => a.time - b.time);
    return out.slice(-(n || 200));
  }

  /* ---- 新浪 ETF 期权：OP_UP/OP_DOWN 拿合约码，CON_OP 拿报价，getOptionMinline 拿分时 ---- */
  const SINA_OPT_UND = [
    { re: /50ETF期权|510050期权|50etf/i, und: '510050', label: '50ETF期权' },
    { re: /300ETF期权|510300期权|300etf/i, und: '510300', label: '300ETF期权' },
    { re: /科创50期权|588000期权/i, und: '588000', label: '科创50ETF期权' },
    /* 中金所 IO 股指期权本机无免风控源；这里明确以「300ETF 期权（沪深300 系列）」呈现，
     * 名称已标注，绝不冒充 IO 合约。 */
    { re: /沪深300期权|IO期权|io期权/i, und: '510300', label: '300ETF期权(沪深300系列)' }
  ];
  function optMonths() {
    const d = new Date(), y = String(d.getFullYear()).slice(2), m = d.getMonth() + 1;
    const n2 = m + 1 > 12 ? 1 : m + 1, y2 = m + 1 > 12 ? String(d.getFullYear() + 1).slice(2) : y;
    return [y + String(m).padStart(2, '0'), y2 + String(n2).padStart(2, '0')];
  }
  async function sinaOptionChain(q) {
    const hit = SINA_OPT_UND.filter(x => x.re.test(String(q || '')))[0];
    if (!hit) return [];
    const codes = [];
    optMonths().forEach(mo => codes.push('OP_UP_' + hit.und + mo, 'OP_DOWN_' + hit.und + mo));
    const txt = String(await proxyText(SINA_OPT_LIST + codes.join(','), SINA_REF) || '');
    const re = /hq_str_OP_(UP|DOWN)_\d+="([^"]*)"/g;
    const out = []; let m;
    while ((m = re.exec(txt))) {
      (m[2] || '').split(',').filter(x => /^CON_OP_\d+$/.test(x)).slice(0, 8).forEach(code => {
        out.push({ code: code, name: hit.label + ' ' + (m[1] === 'UP' ? '购' : '沽') + ' ' + code.slice(-5),
          secid: '', opSina: code, grp: 'option', type: hit.label });
      });
    }
    return out.slice(0, 20);
  }
  /* 新浪期权分时（真实分钟序列，i=HH:MM:SS, p=价格, v=量, d=日期） */
  async function sinaOptionMin(code) {
    const txt = String(await proxyText(SINA_OPT_API + 'getOptionMinline?symbol=' + code, SINA_REF) || '');
    const cut = txt.indexOf('{'); if (cut < 0) return [];
    const d = JSON.parse(txt.slice(cut));
    const arr = (((d.result || {}).data) || []);
    const out = [];
    /* v310【实测字段】新浪 getOptionMinline 只有第一条带 d（日期），其余 N 条
     * 只有 i/p/v——旧版按 d 过滤把 119/120 个点全丢了。日期沿用首条。 */
    const firstD = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((arr[0] || {}).d || ''));
    if (!firstD) return [];
    arr.forEach(r => {
      const p = +r.p, mm = /^(\d{2}):(\d{2})/.exec(String(r.i || ''));
      if (!(p > 0) || !mm) return;
      out.push({ time: Math.floor(Date.UTC(+firstD[1], +firstD[2] - 1, +firstD[3], +mm[1], +mm[2]) / 1000),
        open: p, high: p, low: p, close: p, volume: +r.v || 0 });
    });
    return out;
  }
  /* v311【期权日K】用户修正：symbol 去掉 CON_OP_ 前缀只传 8 位数字。
   * 本机实测仍 data:null（多合约多参数），保留该路径 + 东财 10. 段兜底。 */
  async function sinaOptionDaily(code, n) {
    const num = String(code || '').replace(/^CON_OP_/, '');
    const txt = String(await proxyText(SINA_OPT_API + 'getOptionDayline?symbol=' + num, SINA_REF) || '');
    const cut = txt.indexOf('{'); if (cut < 0) return [];
    const d = JSON.parse(txt.slice(cut));
    const arr = (((d.result || {}).data) || []);
    if (!Array.isArray(arr)) return [];
    const out = [];
    arr.forEach(r => {
      const t = tDay(r.d || r.date), c = +(r.c || r.close);
      if (!t || !(c > 0)) return;
      out.push({ time: t, open: +(r.o || r.open) || c, high: +(r.h || r.high) || c,
        low: +(r.l || r.low) || c, close: c, volume: +(r.v || r.volume) || 0 });
    });
    return out.slice(-(n || 60));
  }
  /* 报价用分时尾点（同源，避免顶部价和图尾不一致）；首点作日内基准 */
  async function sinaOptionQuote(code) {
    const pts = await sinaOptionMin(code);
    if (!pts.length) return null;
    return { price: pts[pts.length - 1].close, prev: pts[0].close, src: 'sinaopt' };
  }

  /* ---- 美股期权：CBOE CDN 期权链（免 Key、无 429），OCC 代码走 Yahoo 三图 ---- */
  async function cboeOptionChain(ticker) {
    const t = String(ticker || '').toUpperCase().replace(/[^A-Z.\-]/g, '');
    if (!/^[A-Z.\-]{1,6}$/.test(t)) return [];
    let d = null;
    for (const pre of [t, '_' + t]) {
      try {
        const txt = String(await fastText(CBOE_OPT + pre + '.json', 'https://www.cboe.com/', 2500) || '');
        const cut = txt.indexOf('{'); if (cut < 0) continue;
        const j = JSON.parse(txt.slice(cut));
        if (j && j.data && j.data.options && j.data.options.length) { d = j; break; }
      } catch (e) { /* 试下一个前缀 */ }
    }
    if (!d) return [];
    const _today = (() => { const d = new Date();
      return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); })();
    const rows = d.data.options
      .filter(o => o && /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(String(o.option || '')))
      /* v311：剔除已到期合约（OCC 的 6 位日期 < 今天），否则抽样到昨日到期合约只有 1 根日K */
      .filter(o => { const m = /^[A-Z]{1,6}(\d{6})[CP]\d{8}$/.exec(String(o.option)); return m && m[1] >= _today; })
      .sort((a, b) => (+b.volume || 0) - (+a.volume || 0))
      .slice(0, 20);
    return rows.map(o => ({
      code: String(o.option), name: t + ' ' + String(o.option),
      secid: '', yh: String(o.option), grp: 'option',
      type: '美股期权(延15m)', px: o.last_trade_price || ((+o.bid + +o.ask) / 2) || 0,
      bid: o.bid, ask: o.ask, vol: o.volume
    }));
  }

  /* ================== v311 新浪外盘（本机实测 2026-11-13） ================== */
  const SINA_GF = 'https://stock2.finance.sina.com.cn/futures/api/';
  async function sinaGlobalQuote(sym) {
    const txt = String(await proxyText('https://hq.sinajs.cn/list=' + sym, SINA_REF) || '');
    const m = /="([^"]*)"/.exec(txt);
    if (!m || !m[1]) return null;
    const f = m[1].split(',');
    const price = +f[0], prev = +f[7] || +f[8] || +f[3];
    if (!isFinite(price) || price <= 0) return null;
    return { price, prev: isFinite(prev) && prev > 0 ? prev : price, src: 'sina' };
  }
  async function sinaGlobalMin(sym) {
    const txt = String(await proxyText(SINA_GF + 'openapi.php/GlobalFuturesService.getGlobalFuturesMinLine?symbol='
      + sym + '&callback=var%20_m=', SINA_REF) || '');
    const mm = /var _m=\(([\s\S]*)\);?\s*$/.exec(txt);
    if (!mm) return [];
    const d = JSON.parse(mm[1]);
    const arr = (((d.result || {}).data || {}).minLine_1d) || [];
    const out = [];
    arr.forEach(x => {
      if (!Array.isArray(x) || /^\d{4}-\d{2}-\d{2}$/.test(String(x[0]))) return;
      const p = +x[1], ts = String(x[5] || '');
      const m2 = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})/.exec(ts);
      if (!(p > 0) || !m2) return;
      out.push({ time: Math.floor(Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]) / 1000),
        open: p, high: p, low: p, close: p, volume: +x[2] || 0 });
    });
    return out;
  }
  async function sinaGlobalDaily(sym, n) {
    const txt = String(await proxyText(SINA_GF + 'jsonp.php/var%20_k=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol='
      + sym + '&_=1', SINA_REF) || '');
    const mm = /var _k=\(([\s\S]*)\);?\s*$/.exec(txt);
    if (!mm) return [];
    const arr = JSON.parse(mm[1]) || [];
    const out = [];
    arr.forEach(r => {
      const t = tDay(r.date), c = +r.close;
      if (!t || !(c > 0)) return;
      out.push({ time: t, open: +r.open || c, high: +r.high || c, low: +r.low || c, close: c, volume: +r.volume || 0 });
    });
    return out.slice(-(n || 200));
  }
  /* ================== v312 OKX 兜底 + 中金所期权链（本机实测 2026-11-13） ==================
   * OKX 公共接口免 Key、带 CORS：BTC/SOL 日K 200 根、1m 300 根、ticker 实时。
   * 币安全部镜像都挂时 OKX 保底，加密永不掉线。 */
  async function okxCandles(instId, bar, limit) {
    const txt = String(await proxyText('https://www.okx.com/api/v5/market/candles?instId='
      + encodeURIComponent(instId) + '&bar=' + bar + '&limit=' + (limit || 200), 'https://www.okx.com/') || '');
    const cut = txt.indexOf('{'); if (cut < 0) return [];
    const d = JSON.parse(txt.slice(cut));
    const rows = (d && d.data) || [];
    return rows.map(r => ({ time: Math.floor(+r[0] / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0 })).reverse();
  }
  /* 中金所股指期权（IO/MO/HO）：新浪 OptionService 完整报价链（实测 io2611/io2612 全 200）。
   * data.up / data.down 数组字段：[?, 买, 卖, 最新, 量, 持仓, 涨幅%, 行权价, 合约代码]。
   * 合约代码如 io2612C3550，按东财 8. 段注册（东财可用时三图自动生效）。 */
  async function cffexOptionChain(product, label) {
    const months = optMonths();
    const pin = product + (months[1] || months[0]);
    let txt = '';
    try {
      txt = String(await fastText('https://stock.finance.sina.com.cn/futures/api/openapi.php/OptionService.getOptionData?type=futures&product='
        + product + '&exchange=cffex&pinzhong=' + pin, SINA_REF, 2500) || '');
    } catch (e) { return []; }
    const cut = txt.indexOf('{'); if (cut < 0) return [];
    let d; try { d = JSON.parse(txt.slice(cut)); } catch (e) { return []; }
    const data = (((d.result || {}).data) || {});
    const out = [];
    const push = (arr, side) => {
      (arr || []).slice(0, 10).forEach(x => {
        if (!Array.isArray(x) || !x[8]) return;
        const px = +x[3];
        out.push({ code: String(x[8]),
          name: label + ' ' + (side === 'up' ? '购' : '沽') + ' ' + x[7],
          secid: '8.' + String(x[8]), type: label, grp: 'option',
          px: px > 0 ? px : 0, pct: x[6] });
      });
    };
    push(data.up, 'up'); push(data.down, 'down');
    return out.slice(0, 20);
  }

  const RT_OVERRIDE = {
    SPX:    { t: 'yahoo',   sym: '^GSPC' },
    HSI:    { t: 'tencent', sym: 'r_hkHSI' },
    WTI:    { t: 'sinag',   sym: 'hf_CL' },
    GOLD:   { t: 'sinag',   sym: 'hf_GC' },
    /* v315：NG 不再用 RT_OVERRIDE 直达 `hf_NG`——它是远月口径，会跟东财主力
     * 拼成两套合约导致分时尾端垂直断崖。改走 universe.rt='tx' + sinaRoll(NG2612)。 */
    COPPER: { t: 'sinag',   sym: 'hf_HG' },
    A50:    { t: 'sinag',   sym: 'hf_CHA50CFD' }
  };

  /* ---------------- 期权主力合约链（v303） ----------------
   * 用户要求：搜「50ETF期权 / 300ETF期权 / 沪深300期权 / 黄金期权 / NVDA期权」
   * → 出最活跃的主力认购/认沽合约 → 点任意合约直接看报价+分时+K线。
   * 国内走东财 clist（按成交额 f6 降序，fs=m:10 上交所期权 / m:8 中金所 / m:113~115 商品），
   * 合约 secid 原样用东财返回的 f13.f12（10.xxx / 8.xxx / 113.xxx），
   * 注册后现有 em 报价/分时/K线链路自动生效。
   * 东财不可达时如实返回空（不编合约代码）。 */
  const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
  const OPT_MARKETS = [
    { re: /50ETF期权|510050期权|50etf/i, fs: 'm:10', label: '50ETF期权' },
    { re: /300ETF期权|510300期权|300etf/i, fs: 'm:10', label: '300ETF期权' },
    { re: /科创50期权|588000期权/i, fs: 'm:10', label: '科创50ETF期权' },
    { re: /IO期权|沪深300期权/i, fs: 'm:8', label: '沪深300股指期权' },
    { re: /MO期权|中证1000期权/i, fs: 'm:8', label: '中证1000股指期权' },
    { re: /HO期权|上证50期权/i, fs: 'm:8', label: '上证50股指期权' },
    { re: /黄金期权|沪金期权|au期权/i, fs: 'm:113', label: '沪金期权' },
    { re: /铜期权|沪铜期权|cu期权/i, fs: 'm:114', label: '沪铜期权' },
    { re: /原油期权|sc期权/i, fs: 'm:115', label: '原油期权' }
  ];
  const fastText = (url, ref, ms) => {
    if (EM_QUIET && /eastmoney\.com/.test(String(url))) return Promise.reject(new Error('em quiet (IP cooldown)'));
    return Promise.race([
    proxyText(url, ref),
    new Promise((_, rej) => setTimeout(() => rej(new Error('option source timeout')), ms || 2500))
  ]);
  };
  async function optionChain(q) {
    /* v312：中金所股指期权（IO/MO/HO）→ 新浪 OptionService 完整报价链（零东财依赖） */
    try {
      if (/IO期权|io期权/i.test(q)) return await cffexOptionChain('io', 'IO沪深300股指期权');
      if (/MO期权|mo期权/i.test(q)) return await cffexOptionChain('mo', 'MO中证1000股指期权');
      if (/HO期权|ho期权/i.test(q)) return await cffexOptionChain('ho', 'HO上证50股指期权');
    } catch (e) { /* 落 ETF 链 */ }
    /* v310：国内 ETF 期权主源改新浪（本机 200，零东财依赖）；东财 clist 仅兜底 */
    try {
      const sr = await sinaOptionChain(q);
      if (sr.length) return sr;
    } catch (e) { /* 落兜底 */ }
    const hit = OPT_MARKETS.filter(x => x.re.test(String(q || '')))[0];
    if (!hit) return [];
    try {
      const url = EM_CLIST + '?pn=1&pz=30&po=1&np=1&fltt=2&invt=2&fid=f6&fs='
        + encodeURIComponent(hit.fs) + '&fields=f12,f13,f14,f2,f3,f6';
      const txt = await fastText(url, 'https://quote.eastmoney.com/', 2500);
      const cut = String(txt || '').indexOf('{');
      if (cut < 0) return [];
      const d = JSON.parse(String(txt).slice(cut));
      const rows = ((d.data || {}).diff) || [];
      return rows.filter(r => r && r.f12 && r.f13 != null).slice(0, 20).map(r => ({
        code: String(r.f12), name: String(r.f14 || r.f12),
        secid: String(r.f13) + '.' + String(r.f12),
        type: hit.label, grp: 'option', px: r.f2, pct: r.f3
      }));
    } catch (e) { return []; }
  }

  /* ---------------- 美股期权链（v304 · Yahoo v7） ----------------
   * 搜「SPY期权 / NVDA期权」→ 最近到期日的 Call/Put 主力合约 →
   * 点任一合约看报价 + 分时 + K线。Yahoo 返回 contractSymbol（SPY260116C00500000），
   * 用 regYahooSym 注册（src='yahoo'），三条链路自动可用；Yahoo 限流时如实返回空。 */
  const YAHOO_OPT = 'https://query2.finance.yahoo.com/v7/finance/options/';
  async function usOptionChain(ticker) {
    const t = String(ticker || '').toUpperCase().replace(/[^A-Z.\-]/g, '');
    if (!/^[A-Z.\-]{1,6}$/.test(t)) return [];
    /* v310：CBOE 官方 CDN 主源（本机 SPY/QQQ/NVDA/TSLA/_SPX 实测 200、无 429） */
    try {
      const cr = await cboeOptionChain(t);
      if (cr.length) return cr;
    } catch (e) { /* 落 Yahoo v7 兜底 */ }
    let txt = '';
    try {
      txt = await fastText(YAHOO_OPT + encodeURIComponent(t),
        'https://finance.yahoo.com/quote/' + t + '/options', 2500);
    } catch (e) { return []; }
    const cut = String(txt || '').indexOf('{');
    if (cut < 0) return [];
    let d;
    try { d = JSON.parse(String(txt).slice(cut)); } catch (e) { return []; }
    const res = (((d.optionChain || {}).result || [])[0]) || {};
    const opt = ((res.options || [])[0]) || {};
    const exp = (res.expirationDates && res.expirationDates[0])
      ? new Date(res.expirationDates[0] * 1000).toISOString().slice(0, 10) : '';
    const rows = [];
    const pushRows = (list, side) => {
      (list || []).slice(0, 10).forEach(o => {
        const cs = String(o.contractSymbol || '');
        if (!cs) return;
        rows.push({ code: cs, name: t + ' ' + exp + ' ' + side + ' ' + (o.strike != null ? o.strike : ''),
          secid: '', yh: cs, grp: 'option', type: '美股期权', px: o.lastPrice, pct: o.percentChange });
      });
    };
    pushRows(opt.calls, 'C'); pushRows(opt.puts, 'P');
    return rows;
  }

  /* ---------------- 新浪国内期货（v302） ----------------
   * 用户点名：IF/IH/IC/IM、TL/T/TF/TS 此前只挂了东财 8. 段，东财一断全瞎。
   * 新浪这三条接口免费、无需 key、字段稳定：
   *   实时  hq.sinajs.cn/list=nf_IF0        （GBK，逗号分隔：名,开,高,低,最新,...）
   *   分时  stock2.finance.sina.com.cn/futures/api/jsonp.php/.../getFewMinLine?symbol=IF0&type=5
   *   日K   .../InnerFuturesNewService.getDailyKLine?symbol=IF0
   */
  const SINA_NF = 'https://hq.sinajs.cn/list=nf_';
  /* 取文本的统一入口：APP 内 nativeFetch 直连（最快、无 CORS）；PWA 走代理池。 */
  async function proxyText(target, ref) {
    try {
      const np = w.NativePulse;
      if (np && typeof np.nativeFetch === 'function') {
        const t = np.nativeFetch(target);
        if (t) return String(t).replace(/^\s*HTTP\s*\d+\s*/, '');
      }
    } catch (e) { /* 落代理 */ }
    /* v311【关键回退】原生桥（curl/Java）返回空或失败时，**先尝试直连**：
     * Node 无 CORS、腾讯/币安等浏览器 CORS:* 都可直接 fetch；此前直接落代理，
     * 导致本机 Yahoo/CBOE 在桥失败时整体挂掉（商品/期权分时回归的根因）。 */
    try {
      const r0 = await fetch(target, { cache: 'no-store' });
      if (r0.ok) return await r0.text();
    } catch (e) { /* 再落代理 */ }
    const P = w.LiveNews && w.LiveNews.proxy;
    if (typeof P === 'function') {
      try { return await P(target, { timeout: 12000, raw: true }); } catch (e) { /* 落 proxyFetch */ }
    }
    const r = await proxyFetch(target);
    return await r.text();
  }
  const SINA_FUT_API = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_nf=/InnerFuturesNewService.';
  function sinafOf(key, a) { return (a && a.sinaf) || null; }

  async function sinaFutQuote(key, a) {
    const sym = sinafOf(key, a);
    if (!sym) return null;
    const txt = await proxyText(SINA_NF + sym, 'https://finance.sina.com.cn/futures/quotes/' + sym + '.shtml');
    const m = /="([^"]*)"/.exec(String(txt || ''));
    if (!m || !m[1]) return null;
    const f = m[1].split(',');
    if (f.length < 6) return null;
    /* v309【本机实测修正】nf_IF0 = "4011,4023,4000,4004(最新),23696(量),...,4002.4(昨结),..."
     * 旧代码取 f[4] 把成交量当价格、f[10] 把跌停价当昨结 —— 全错。 */
    const price = +f[3];
    const prev = +f[13] || +f[0];
    if (!isFinite(price) || price <= 0) return null;
    return { price: price, prev: isFinite(prev) && prev > 0 ? prev : null, src: 'sina' };
  }

  async function sinaFutDaily(key, a, n) {
    const sym = sinafOf(key, a);
    if (!sym) return [];
    const txt = await proxyText(SINA_FUT_API + 'getDailyKLine?symbol=' + sym,
      'https://finance.sina.com.cn/futures/quotes/' + sym + '.shtml');
    const cut = String(txt || '').indexOf('[');
    if (cut < 0) return [];
    let arr;
    try { arr = JSON.parse(String(txt).slice(cut).replace(/\);\s*$/, '')); } catch (e) { return []; }
    const out = [];
    (arr || []).forEach(r => {
      const d = String(r.d || r.date || '');
      const t = tDay(d);
      const c = +r.c || +r.close;
      if (!t || !(c > 0)) return;
      out.push({ time: t, open: +r.o || c, close: c, high: +r.h || c, low: +r.l || c, volume: +r.v || 0 });
    });
    return out.slice(-(n || 200));
  }

  async function sinaFutMin(key, a) {
    const sym = sinafOf(key, a);
    if (!sym) return [];
    const txt = await proxyText(SINA_FUT_API + 'getFewMinLine?symbol=' + sym + '&type=5',
      'https://finance.sina.com.cn/futures/quotes/' + sym + '.shtml');
    const cut = String(txt || '').indexOf('[');
    if (cut < 0) return [];
    let arr;
    try { arr = JSON.parse(String(txt).slice(cut).replace(/\);\s*$/, '')); } catch (e) { return []; }
    const out = [];
    (arr || []).forEach(r => {
      const tm = String(r.d || r.time || '');           // 2026-11-13 09:01:00
      const mm = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(tm);
      if (!mm) return;
      /* v309：新浪分钟线 p=持仓量，价格必须用 c */
      const c = +r.c || +r.close || +r.price;
      if (!(c > 0)) return;
      out.push({
        time: Math.floor(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5]) / 1000),
        open: c, high: c, low: c, close: c, volume: +r.v || 0
      });
    });
    return out;
  }

  async function txMinute(code, sess) {
    const hit = txMinCache.get(code);
    if (hit && Date.now() - hit.t < 20000) return hit.d;
    const d = await getJSON(TX_MIN + encodeURIComponent(code), 0, 'tx');
    const inner = ((d && d.data) || {})[code] || {};
    const box = inner.data || {};
    const rows = box.data || [];
    const md = /^(\d{4})(\d{2})(\d{2})$/.exec(String(box.date || ''));
    if (rows.length < 30 || !md) throw new Error('tx min empty');
    const y = +md[1], mo = +md[2], dd = +md[3];
    const qt = ((inner.qt || {})[code]) || [];
    const prev = +qt[4] || 0;
    let prevCum = 0;
    const pts = [];
    for (const row of rows) {
      const f = String(row).split(' ');
      const hm = f[0];
      if (!/^\d{4}$/.test(hm)) continue;
      const hh = +hm.slice(0, 2), mi = +hm.slice(2);
      const t = hh * 60 + mi;
      /* 只留常规时段：A股 09:30-11:30 / 13:00-15:00；港股 09:30-16:00。
       * 腾讯把集合竞价和收盘快照也塞在同一数组里，不过滤会把线拉到 18:31。 */
      if (sess === 'cn' && !((t >= 570 && t <= 690) || (t >= 780 && t <= 900))) continue;
      if (sess === 'hk' && !(t >= 570 && t <= 960)) continue;
      const c = +f[1];
      if (!(c > 0)) continue;
      const cum = +f[2] || 0;
      const vol = cum > prevCum ? cum - prevCum : 0;
      if (cum) prevCum = cum;
      pts.push({
        time: Math.floor(Date.UTC(y, mo - 1, dd, hh, mi) / 1000),
        open: c, high: c, low: c, close: c, volume: vol
      });
    }
    if (pts.length < 30) throw new Error('tx min empty');
    const out = { points: pts, prev: prev || 0, date: box.date };
    txMinCache.set(code, { t: Date.now(), d: out });
    return out;
  }



  /** v339：新浪 A股分钟线（JSONP，走浏览器原生网络栈，零 CORS、零东财）。
   * 仅在腾讯 minute/mkline 都失败时兜底 —— 家庭宽带下腾讯域名不通时仍能出分时。 */
  let sinaMinSeq = 0;
  function sinaCnMinute(txCode, scale) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') return reject(new Error('no document'));
      const v = '__sm' + (++sinaMinSeq) + '_' + Date.now().toString(36);
      const url = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20' + v +
        '=/CN_MarketDataService.getKLineData?symbol=' + encodeURIComponent(txCode) +
        '&scale=' + (scale || 5) + '&ma=no&datalen=1023';
      const sc = document.createElement('script');
      sc.async = true;
      let done = false;
      const clean = () => { try { sc.remove(); } catch (e) { } try { delete w[v]; } catch (e) { } };
      const timer = setTimeout(() => { if (done) return; done = true; clean(); reject(new Error('sina min timeout')); }, 6000);
      sc.onload = () => {
        if (done) return; done = true; clearTimeout(timer);
        try {
          const arr = w[v] || [];
          clean();
          const rows = [];
          (arr || []).forEach(r => {
            const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(r.day || ''));
            if (!m) return;
            const c = +r.close;
            if (!(c > 0)) return;
            rows.push({
              date: m[1] + '-' + m[2] + '-' + m[3],
              time: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000,
              open: +r.open || c, high: +r.high || c, low: +r.low || c, close: c, volume: +r.volume || 0
            });
          });
          if (rows.length < 10) return reject(new Error('sina min empty'));
          rows.sort((a, b) => a.time - b.time);
          const last = rows[rows.length - 1].date;
          const pts = rows.filter(x => x.date === last);
          if (pts.length < 10) return reject(new Error('sina min empty'));
          resolve({ points: pts.map(x => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })), prev: 0, date: last, srcTag: 'sina' });
        } catch (e) { reject(e); }
      };
      sc.onerror = () => { if (done) return; done = true; clearTimeout(timer); clean(); reject(new Error('sina min error')); };
      sc.src = url;
      (document.head || document.documentElement).appendChild(sc);
    });
  }

  /** v339：腾讯「历史分钟线」兜底（mkline）。休市/收盘后 minute/query 常只回
   * 很少几行（<30），旧逻辑直接判失败并落到东财兜底；东财静默期就报 em quiet。
   * mkline 给多日 1 分钟序列，裁到最近交易日即可，仍然零东财请求。 */
  async function txMkMinute(code, sess) {
    const url = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=' +
      encodeURIComponent(code + ',m1,,320');
    const d = await getJSON(url, 0, 'tx');
    const box = ((d && d.data) || {})[code] || {};
    const arr = box.m1 || box.m5 || [];
    const rows = [];
    for (const r of arr) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(r[0]));
      if (!m) continue;
      const t = (+m[4]) * 60 + (+m[5]);
      if (sess === 'cn' && !((t >= 570 && t <= 690) || (t >= 780 && t <= 900))) continue;
      if (sess === 'hk' && !(t >= 570 && t <= 960)) continue;
      const c = +r[2];
      if (!(c > 0)) continue;
      rows.push({
        date: m[1] + '-' + m[2] + '-' + m[3],
        time: Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000),
        open: +r[1] || c, high: +r[3] || c, low: +r[4] || c, close: c, volume: +r[5] || 0
      });
    }
    if (rows.length < 20) throw new Error('tx mkline empty');
    rows.sort((a, b) => a.time - b.time);
    const lastDay = rows[rows.length - 1].date;
    const pts = rows.filter(x => x.date === lastDay).map(x => ({
      time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume
    }));
    if (pts.length < 20) throw new Error('tx mkline empty');
    return { points: pts, prev: 0, date: lastDay };
  }

  /** 腾讯日K（前复权）。实测：A股/港股给满 320 天，美股/韩股只给**当日 1 根**。
   *  数组格式：[日期, 开, 收, 高, 低, 量]。
   *  【上限 1200】实测 count=9000 时腾讯返回的是 data:[]（数组而不是对象），
   *  解析会炸；640/1200 都正常，1200 约 4.7 年，够画长周期。 */
  async function txDaily(code, n) {
    const cnt = Math.max(20, Math.min(1200, n || 320));
    /* v302【美股/港股日K 打错接口】腾讯分市场三个 endpoint：
     *   A股 fqkline / 港股 hkfqkline / 美股 usfqkline。此前一律打 fqkline，
     *   美股自然拿不到 → 误判「腾讯只给 1 根」。字段兼容也一并放宽到 hfqday。 */
    const c = String(code || '');
    const base = /^[a-z]{2}/i.test(c)
      ? (/^us/i.test(c) ? 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param='
        : (/^hk/i.test(c) ? 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param='
          : TX_KLINE))
      : TX_KLINE;
    const d = await getJSON(base + encodeURIComponent(code) + ',day,,,' + cnt + ',qfq', 120000, 'tx');
    const box = ((d && d.data) || {})[code];
    if (!box || typeof box !== 'object') throw new Error('tx kline empty');
    const rows = box.qfqday || box.day || box.hfqday || [];
    const pts = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const t = tDay(r[0]);
      const o = +r[1], c = +r[2], hi = +r[3], lo = +r[4];
      if (!t || !(c > 0)) continue;
      pts.push({ time: t, open: o || c, close: c, high: hi || c, low: lo || c, volume: +r[5] || 0 });
    }
    return pts;
  }

  /** 新浪外盘分时（1 分钟）。首行是「日线头」，带昨收，字段比正文多。
   *  正文：['07:01', 价, 0, 0, 均价, '2026-11-09 07:01:00']
   *  首行：['2026-11-09', 昨收, 'cme', '', '07:00', 首分钟价, 0, 0, 均价, '2026-11-09 07:00:00'] */
  async function sinaFut(sym, scale) {
    if (!sym) throw new Error('no sina sym');
    const sc = scale || 1;
    const ck = sym + '|' + sc;
    const hit = sinaCache.get(ck);
    if (hit && Date.now() - hit.t < 15000) return hit.d;
    const d = await sinaJSONP(SINA_FUT + encodeURIComponent(sym), 12000);
    const rows = (d && d.minLine_1d) || [];
    let prev = 0;
    const pts = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;
      const wide = r.length >= 10;
      if (wide) prev = +r[1] || prev;
      const t = tMin(wide ? r[9] : r[5]);
      const c = +(wide ? r[5] : r[1]);
      if (!t || !isFinite(c)) continue;
      const avg = +(wide ? r[8] : r[4]);
      pts.push({
        time: t,
        open: c * sc, high: c * sc, low: c * sc, close: c * sc,
        volume: 0,
        avg: (isFinite(avg) ? avg : c) * sc
      });
    }
    const out = {
      points: pts,
      preClose: prev ? prev * sc : ((pts[0] && pts[0].close) || 0)
    };
    sinaCache.set(ck, { t: Date.now(), d: out });
    return out;
  }

  /** 腾讯外盘报价（一次请求覆盖多个符号）。
   *  响应形如 v_hf_CL="87.51,-3.66,87.66,87.68,91.42,86.19,01:49:03,90.83,90.83,0,5,9,2026-11-10,纽约原油";
   *  字段：0 现价 / 1 涨跌幅% / 2 买 / 3 卖 / 4 最高 / 5 最低 / 6 时间 / 7 昨收 / 8 今开 */
  async function txQuote(keys) {
    const map = {};
    const syms = [];
    keys.forEach(k => {
      const a = U.get(k);
      if (!a) return;
      /* v292：没有显式 txSym 时按 secid 推导（105/106/107→usXXX、116→hkXXX、
       * 100.HSI→hkHSI 等，见 txStockCode）。美股 27 只 / 港股全部实测命中。 */
      const sym = a.txSym || txStockCode(k);
      if (!sym) return;
      map[sym] = k;
      syms.push(sym);
    });
    if (!syms.length) return {};
    const ck = syms.join(',');
    const hit = txCache.get(ck);
    if (hit && Date.now() - hit.t < 8000) return hit.d;
    const r = await fetch(TX_Q + syms.join(','), { cache: 'no-store' });
    if (!r.ok) throw new Error('tx ' + r.status);
    const buf = await r.arrayBuffer();
    let txt;
    try { txt = new TextDecoder('gbk').decode(buf); }
    catch (e) { txt = new TextDecoder().decode(buf); }
    const out = {};
    const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const k = map[m[1]];
      if (!k) continue;
      /* v274：日/韩股（jp/kr 前缀）—— 腾讯返回 ~ 分隔、f[3]=现价 f[4]=昨收，
       * 与商品的逗号格式完全不同。东财对 176/177 市场行情滞后 20 分钟
       * （实测海力士：东财 13:52:54 报 1278000，腾讯同刻 1280000 且仍在跳），
       * 所以这批品种 rt:'tx' 走腾讯实时，东财只当锚点。 */
      if (m[2].indexOf('~') >= 0) {
        const f2 = m[2].split('~');
        const price2 = +f2[3], prev2 = +f2[4];
        if (!(price2 > 0)) continue;
        const pct2 = prev2 ? (price2 - prev2) / prev2 * 100 : 0;
        out[k] = {
          price: price2, pct: pct2,
          chg: prev2 ? price2 - prev2 : null,
          prev: prev2 || null,
          high: null, low: null, open: null,
          at: Date.now(), src: 'tx'
        };
        continue;
      }
      const f = m[2].split(',');
      const price = +f[0];
      if (!(price > 0)) continue;
      const a = U.get(k);
      const sc = a.pxScale || 1;
      const prev = +f[7] || 0;
      const pct = isFinite(+f[1]) ? +f[1] : (prev ? (price - prev) / prev * 100 : 0);
      out[k] = {
        price: price * sc,
        pct: pct,
        chg: prev ? (price - prev) * sc : null,
        prev: prev ? prev * sc : null,
        high: +f[4] ? +f[4] * sc : null,
        low: +f[5] ? +f[5] * sc : null,
        open: +f[8] ? +f[8] * sc : null,
        at: Date.now(),
        src: 'tx'
      };
    }
    txCache.set(ck, { t: Date.now(), d: out });
    return out;
  }

  /* v287：东财批量报价失败时的腾讯兜底。
   * 背景：em 组约 79 个品种原本只有东财一个报价源，getJSON 抛错时
   * `catch(e){}` 什么都不做 → 缓存里的旧价继续被当成实时价显示，
   * 活线还每 8 秒用这个旧价续点，看起来「价格在走」其实根本没刷新。
   * 这里只对**能由 secid 推导腾讯代码**的品种（A股/港股，实测 31 个）
   * 补一次真实报价，带 at=Date.now()、src='tx'；拿不到的品种绝不编数，
   * 由 status 明确报失败，界面显示「上次更新」。
   * 不复制 txQuote：那个依赖 universe 的 txSym 字段，em 组没有。 */
  async function emFallbackTx(keys, out) {
    const map = {}, syms = [];
    keys.forEach(k => {
      if (out[k]) return;
      const code = txStockCode(k);
      if (!code) return;
      map[code] = k;
      syms.push(code);
    });
    if (!syms.length) return 0;
    const r = await fetch(TX_Q + syms.join(','), { cache: 'no-store' });
    if (!r.ok) throw new Error('tx-fallback HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    let txt;
    try { txt = new TextDecoder('gbk').decode(buf); }
    catch (e) { txt = new TextDecoder().decode(buf); }
    const re = /v_([a-zA-Z0-9._]+)="([^"]*)"/g;
    let m, n = 0;
    while ((m = re.exec(txt))) {
      const k = map[m[1]];
      if (!k) continue;
      const f = m[2].split('~');
      if (f.length < 5) continue;              // 逗号格式是商品，这里不处理
      const price = +f[3], prev = +f[4];
      if (!(price > 0)) continue;
      out[k] = {
        price: price,
        pct: prev ? (price - prev) / prev * 100 : 0,
        chg: prev ? price - prev : null,
        prev: prev || null,
        high: null, low: null, open: null,
        at: Date.now(), src: 'tx'
      };
      n++;
    }
    return n;
  }

  /* v291：东财批量报价失败时的第三/四级兜底（第一级是 emFallbackTx 腾讯）。
   * 背景：东财 push2 间歇故障（实测 http=000/连接直接断），此时 A股/美股/港股
   * 有腾讯兜底，但美债/外汇/商品/亚太指数/台股原本无路可走。
   * 穷举实测（tools/test_quote_coverage.py，95 品种 × 7 源）确认：
   *   · TV scanner 对 94 个 tv 符号一次 POST 全部返回（唯一例外 TVC:TWII，
   *     已实测确认该符号在 scanner 不存在）→ 批量兜底首选，CORS 开放；
   *   · 延迟口径由 update_mode 给出：streaming=真实时，delayed_streaming_600/
   *     900/1200 = 官方延迟 10/15/20 分钟，报价对象上带 delayed 秒数；
   *   · 台湾加权（TWII）腾讯/新浪/TV 全无免费符号，只有 Yahoo ^TWII 可用
     *     （实测 2340），走 yahooBars 末点兜底。
   * 两级都只填 out 里还缺的 key，绝不覆盖腾讯已拿到的实时价。 */
  async function tvScanFallback(keys, out) {
    const want = keys.filter(k => !out[k] && U.get(k) && U.get(k).tv);
    if (!want.length) return 0;
    const body = JSON.stringify({
      symbols: { tickers: want.map(k => U.get(k).tv), query: { types: [] } },
      columns: ['close', 'change', 'update_mode']
    });
    const res = await fetch(TV_SCAN, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: body, cache: 'no-store'
    });
    if (!res.ok) throw new Error('TV fallback HTTP ' + res.status);
    const d = await res.json();
    const byTv = {};
    (d.data || []).forEach(it => { if (it && it.s) byTv[it.s] = it.d; });
    let n = 0;
    want.forEach(k => {
      const a = U.get(k);
      const arr = byTv[a.tv];
      if (!arr || !isFinite(Number(arr[0])) || !(Number(arr[0]) > 0)) return;
      const price = Number(arr[0]);
      const pct = isFinite(Number(arr[1])) ? Number(arr[1]) : 0;
      const dm = /_(\d+)$/.exec(String(arr[2] || ''));
      out[k] = {
        price: price,
        pct: pct,
        chg: null, prev: null, high: null, low: null, open: null,
        at: Date.now(), src: 'tv',
        delayed: dm ? +dm[1] : 0        // 官方延迟口径（秒）；streaming 为 0
      };
      n++;
    });
    return n;
  }

  async function yahooQuoteFallback(keys, out) {
    const want = keys.filter(k => !out[k] && U.get(k) && U.get(k).yh);
    if (!want.length) return 0;
    let n = 0;
    for (const k of want) {
      try {
        const y = await yahooBars(U.get(k).yh, '5m', '1d');
        if (!y.points.length) continue;
        const last = y.points[y.points.length - 1];
        const prev = y.prevClose || y.points[0].close;
        if (!(last.close > 0)) continue;
        out[k] = {
          price: last.close,
          pct: prev ? (last.close - prev) / prev * 100 : 0,
          chg: prev ? last.close - prev : null,
          prev: prev || null,
          high: null, low: null, open: null,
          at: Date.now(), src: 'yahoo'
        };
        n++;
      } catch (e) { /* Yahoo 偶发 429，不重试，宁缺毋假 */ }
    }
    return n;
  }

  /* ---------------- CNBC（VIX 实时源 + 1 分钟线） ----------------
   * VIX 这个指数很特殊：CBOE 官方 cdn-api 的路径本身就叫 delayed_quotes（延 15 分钟），
   * Yahoo ^VIX 实测滞后 912 秒，TradingView CBOE:VIX 是 delayed_streaming_900 ——
   * 免费源里只有 CNBC 是真实时的（quote.cnbc.com 的 last_time 与当前时刻一致），
   * 而且它 CORS 全开、图表接口还给 1 分钟线，所以报价和分时都换过来。
   * 日 K 继续用 CBOE（cboeDaily），那边日线是准的、历史也长。 */
  const CNBC_QUICK = 'https://quote.cnbc.com/quote-html-webservice/quote.htm'
    + '?symbols=__SYM__&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  const CNBC_CHART = 'https://ts-api.cnbc.com/harmony/app/charts/1D.json'
    + '?symbol=__SYM__&events=1&lang=en-US';
  const cnbcCache = new Map();

  /** CNBC 有两个坑（实测）：
   *  ① 首次冷启动要 10 秒左右，偶尔直接回 **HTTP 200 但 priceBars 为空**；
   *  ② 偶发 SSL 断流。
   *  两者都会让 VIX 退回 15 分钟延时的 CBOE，所以把「取数 + 校验」整体放进重试，
   *  空包也要重试（只包 fetch 是不够的 —— 空包不抛异常）。 */
  async function cnbcRetry(fn, tries) {
    const n = tries || 3;
    let lastErr = null;
    for (let i = 0; i < n; i++) {
      try { return await fn(); }
      catch (e) {
        lastErr = e;
        if (i < n - 1) await new Promise(r => setTimeout(r, 400 + i * 600));
      }
    }
    throw lastErr || new Error('cnbc fail');
  }

  async function cnbcQuoteOne(sym) {
    const ck = 'q:' + sym;
    const hit = cnbcCache.get(ck);
    if (hit && Date.now() - hit.t < 8000) return hit.d;
    const url = CNBC_QUICK.replace('__SYM__', encodeURIComponent(sym));
    const x = await cnbcRetry(async () => {
      const d = await cnbcJSON(url);
      const arr = ((d && d.QuickQuoteResult) || {}).QuickQuote || [];
      const y = arr[0];
      if (!y) throw new Error('cnbc no quote');
      if (!(cnbcNum(y.last) > 0)) throw new Error('cnbc bad price');
      return y;
    });
    const price = cnbcNum(x.last);
    const chg = cnbcNum(x.change);
    const pct = cnbcNum(x.change_pct);
    const prev = (chg != null) ? price - chg : (pct != null ? price / (1 + pct / 100) : null);
    const out = {
      price: price,
      prev: prev,
      chg: chg,
      pct: pct != null ? pct : (prev ? (price - prev) / prev * 100 : 0),
      open: cnbcNum(x.open),
      high: cnbcNum(x.high),
      low: cnbcNum(x.low),
      at: Date.now(),
      src: 'cnbc'
    };
    cnbcCache.set(ck, { t: Date.now(), d: out });
    return out;
  }

  /** CNBC 1D 分钟线：bar 的 tradeTimeinMills 是**真实 epoch**，
   *  而全站时间轴约定是「北京时间墙上时间装进 UTC 分量」，所以要 +8h。 */
  async function cnbcIntraday(sym) {
    const ck = 'm:' + sym;
    const hit = cnbcCache.get(ck);
    if (hit && Date.now() - hit.t < 15000) return hit.d;
    const url = CNBC_CHART.replace('__SYM__', encodeURIComponent(sym));
    const pts = await cnbcRetry(async () => {
      const d = await cnbcJSON(url);
      const bars = ((d && d.barData) || {}).priceBars || [];
      if (!bars.length) throw new Error('cnbc no bars');   // 空包 → 重试
      /* 1D 会把「上一场收盘那一根」也带上（VIX 实测首根是前一天 15:18），
       * 只留最后一个交易日的，否则分时图左端会挂一个孤零零的点。 */
      let lastDay = '';
      for (const b of bars) {
        const s = String(b.tradeTime || '');
        if (s.length >= 8 && s.slice(0, 8) > lastDay) lastDay = s.slice(0, 8);
      }
      const acc = [];
      for (const b of bars) {
        const s = String(b.tradeTime || '');
        if (!lastDay || s.slice(0, 8) !== lastDay) continue;
        const ms = +b.tradeTimeinMills;
        if (!(ms > 0)) continue;
        const c = +b.close;
        if (!(c > 0)) continue;
        const t = Math.floor((ms + 8 * 3600e3) / 60000) * 60;
        acc.push({
          time: t,
          open: +b.open || c, high: +b.high || c, low: +b.low || c, close: c,
          volume: +b.volume || 0
        });
      }
      if (!acc.length) throw new Error('cnbc empty');
      acc.sort((x, y) => x.time - y.time);
      return acc;
    });
    const out = { points: pts };
    cnbcCache.set(ck, { t: Date.now(), d: out });
    return out;
  }

  /* v284：美股**指数**分时改用 CNBC 1D 分钟线。
   * 2026-11-12 实测：`.SPX` 当日 09:30→13:07 ET 共 218 根，逐分钟、价格量级与报价一致
   * （last=7631.83，图末 7631.74）；而东财 push2his 当天 0 字节断连 / 403。
   * 只取最后一日的常规时段（09:30–16:00 ET）：1D 序列里还混着盘前盘后，
   * 指数分时按 390 格铺 X 轴，混进延展段会让「线只走一半」。
   * `tradeTime` 对美股指数是**美东墙上时间**（20261111093000 = 09:30 ET），
   * 可直接按 0930–1600 切片；时间戳换成全站的「北京墙上时间装进 UTC」口径（+8h）。 */
  const idxMinCache = new Map();
  async function cnbcIdxIntraday(sym) {
    const ck = 'i:' + sym;
    const hit = idxMinCache.get(ck);
    if (hit && Date.now() - hit.t < 15000) return hit.d;
    const url = CNBC_CHART.replace('__SYM__', encodeURIComponent(sym));
    const pts = await cnbcRetry(async () => {
      const d = await cnbcJSON(url);
      const bars = ((d && d.barData) || {}).priceBars || [];
      if (!bars.length) throw new Error('cnbc no bars');
      let lastDay = '';
      for (const b of bars) {
        const s = String(b.tradeTime || '');
        if (s.length >= 8 && s.slice(0, 8) > lastDay) lastDay = s.slice(0, 8);
      }
      const acc = [];
      for (const b of bars) {
        const s = String(b.tradeTime || '');
        if (!lastDay || s.slice(0, 8) !== lastDay) continue;
        const hm = +s.slice(8, 12);
        if (!(hm >= 930 && hm <= 1600)) continue;
        const ms = +b.tradeTimeinMills;
        const c = +b.close;
        if (!(ms > 0) || !(c > 0)) continue;
        acc.push({
          time: Math.floor((ms + 8 * 3600e3) / 60000) * 60,
          open: +b.open || c, high: +b.high || c, low: +b.low || c, close: c,
          volume: 0            // CNBC 指数分时不给成交量 → 副图显示「量 --」，比编一根柱子好
        });
      }
      if (!acc.length) throw new Error('cnbc empty');
      acc.sort((x, y) => x.time - y.time);
      return acc;
    });
    const out = { points: pts, preClose: 0 };
    idxMinCache.set(ck, { t: Date.now(), d: out });
    return out;
  }

  /* 新浪「带年月」符号的换月自愈：
   * 天然气这类合约符号是 NG2612（12 月合约），换月后旧符号会跑到远月、
   * 价格和主力差十几个百分点。用东财的连续合约价当锚点（它的**合约口径是对的**，
   * 只是晚 10 分钟），逐月试一遍，取最接近的那个月，存 localStorage 下次直接用。 */
  const SINA_SYM_KEY = 'mm_sinasym_v1';
  const sinaRollBusy = {};

  function sinaStore() {
    try { return JSON.parse(localStorage.getItem(SINA_SYM_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function sinaSymOf(key) {
    const a = U.get(key);
    if (!a) return null;
    if (!a.sinaRoll) return a.sinaSym || null;
    return sinaStore()[key] || a.sinaSym || null;
  }
  async function resolveSinaRoll(key, anchor) {
    const a = U.get(key);
    if (!a || !a.sinaRoll || !anchor || sinaRollBusy[key]) return;
    sinaRollBusy[key] = true;
    try {
      const now = new Date();
      const cands = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
        cands.push(a.sinaRoll + String(d.getUTCFullYear()).slice(2)
          + String(d.getUTCMonth() + 1).padStart(2, '0'));
      }
      let best = null, bestErr = 0.02;
      for (const s of cands) {
        try {
          const r = await sinaFut(s, a.pxScale || 1);
          const last = r.points[r.points.length - 1];
          if (!last) continue;
          const err = Math.abs(last.close - anchor) / anchor;
          if (err < bestErr) { bestErr = err; best = s; }
        } catch (e) { /* 该月没挂牌 */ }
      }
      if (best) {
        const st = sinaStore();
        st[key] = best;
        try { localStorage.setItem(SINA_SYM_KEY, JSON.stringify(st)); } catch (e) {}
        sinaCache.clear();
      }
    } finally { sinaRollBusy[key] = false; }
  }

  /* ---------------- TWSE 证交所官方实时（台股加权 + 台股个股） ----------------
   * v292：TWII/台股个股此前只有东财（延 20 分钟）与 Yahoo ^TWII 兜底。
   * 攻坚实测（2026-11-12）：证交所 mis.twse.com.tw 的 getStockInfo.jsp 是官方
   * **实时**接口 —— tse_t00.tw 返回 z=43091.87 / y=44257.15 / t=13:33（台北收盘），
   * 与 Yahoo ^TWII 快照全等；tse_2330.tw 返回 z=2340.00、五档、量全有。
   * 多符号逗号分隔实测无效，只能一符号一请求（4 个台股品种可接受，15s 缓存）。
   * 【CORS】该接口不回 Access-Control-Allow-Origin —— 浏览器直连必被拦：
   *   · APK 壳内：LiveNews.proxy → NativePulse.nativeFetch（Java 直连无 CORS）；
   *   · 主站 H5：LiveNews.proxy → 同源 /__proxy（服务端转发）；
   *   · 都不行时补漏链走 TV（TWSE:2330，延 20 分钟）/ Yahoo ^TWII。 */
  const TWSE_API = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
  const twseCache = new Map();

  function twseSymOf(key) {
    const a = U.get(key);
    if (!a) return null;
    if (a.twse) return a.twse;
    /* 动态合成的台股：secid 178.XXXX → tse_XXXX.tw */
    const m = /^178\.(\d{4})$/.exec(String(a.secid || ''));
    return m ? 'tse_' + m[1] + '.tw' : null;
  }

  async function twseJSON(sym) {
    const url = TWSE_API + '?ex_ch=' + encodeURIComponent(sym) + '&json=1&delay=0&_=' + Date.now();
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('twse HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      /* 直连失败（浏览器 CORS / 区域墙）→ 统一代理池 */
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') throw e;
      const t = await P(url, { timeout: 14000, check: b => String(b).indexOf('msgArray') >= 0 });
      const i = String(t).indexOf('{');
      if (i < 0) throw new Error('twse bad payload');
      return JSON.parse(String(t).slice(i));
    }
  }

  /** 字段（实测）：z=成交价 / y=昨收 / o,h,l=开高低 / t=时间 / n=名称。
   *  收盘后 z 停在最后一笔成交 —— 与腾讯/东财收盘快照同口径。 */
  async function twseQuote(key) {
    const sym = twseSymOf(key);
    if (!sym) throw new Error('no twse sym');
    const hit = twseCache.get(sym);
    if (hit && Date.now() - hit.t < 15000) return hit.d;
    const d = await twseJSON(sym);
    const r = ((d && d.msgArray) || [])[0] || {};
    const price = +r.z;
    if (!(price > 0)) throw new Error('twse empty');
    const prev = +r.y || 0;
    const out = {
      price: price,
      pct: prev ? (price - prev) / prev * 100 : 0,
      chg: prev ? price - prev : null,
      prev: prev || null,
      high: +r.h || null, low: +r.l || null, open: +r.o || null,
      at: Date.now(), src: 'twse'
    };
    twseCache.set(sym, { t: Date.now(), d: out });
    return out;
  }

  /* ---------------- 批量报价（一次请求覆盖全部东财品种） ---------------- */

  let batchSeq = 0;

  /** v292：东财批量报价的「纯取数」部分（不含兜底链）。
   *  主链（em 组）与 tvq/补漏的降级路径共用这一份，返回填充的品种数。 */
  async function emQuoteBatch(keys, out) {
    if (EM_QUIET) return 0;
    const list = keys.filter(k => U.get(k) && U.get(k).secid);
    if (!list.length) return 0;
    const secids = list.map(k => U.get(k).secid);
    const url = `${EM_LIST}?fltt=2&secids=${secids.map(encodeURIComponent).join(',')}`
      /* v167：多带 f15/f16/f17（最高/最低/今开）—— 股价预警的「创新高/创新低」
       * 要用当日高低，同一个请求里就有，不用额外再打一次接口。 */
      + `&fields=f2,f3,f4,f12,f13,f14,f15,f16,f17&ut=${EM_UT}&_=${++batchSeq}`;
    const d = await getJSON(url, 0, 'em');
    const diff = (d && d.data && d.data.diff) || [];
    const byId = {};
    diff.forEach(r => { byId[r.f13 + '.' + r.f12] = r; });
    let n = 0;
    list.forEach(k => {
      const a = U.get(k);
      const r = byId[a.secid];
      if (!r) return;
      const price = typeof r.f2 === 'number' ? r.f2 : null;
      const pct = typeof r.f3 === 'number' ? r.f3 : null;
      if (price == null) return;
      /* 只做锚点、不进 out（东财这 5 个商品延 10 分钟，不能用它显示） */
      if (a.rt === 'tx') {
        cache.set('anc:' + k, { t: Date.now(), d: { price: price } });
        return;
      }
      out[k] = {
        price: price,
        pct: pct == null ? 0 : pct,
        chg: typeof r.f4 === 'number' ? r.f4 : null,
        prev: pct != null ? price / (1 + pct / 100) : null,
        high: typeof r.f15 === 'number' ? r.f15 : null,
        low: typeof r.f16 === 'number' ? r.f16 : null,
        open: typeof r.f17 === 'number' ? r.f17 : null,
        at: Date.now(),
        src: 'em'
      };
      n++;
    });
    return n;
  }

  async function batchQuote(keys) {
    keys = keys.filter(k => U.get(k));
    /* v309：按品类分流，直达主源与原链路并行，东财只兜底 */
    const directKeys = keys.filter(k => directKind(U.get(k), k));
    const restKeys = keys.filter(k => !directKind(U.get(k), k));
    /* v292【按分组接实时源优先链】各组的「实时源在前、延迟源在后」：
     *   us(美股指数 5 只)  → CNBC 官方实时（realTime:true，实测 .VIX 盘外仍在跳）
     *   usstock/hkstock/HSI/HSTECH → 腾讯（us/hk 前缀实测实时，27 只美股全命中）
     *   twstock/TWII       → TWSE 证交所官方实时（mis.twse.com.tw）
     *   fx/rate/N225/KS11  → TV scanner（官方 streaming 实时，实测逐秒跳）
     *   energy/metal(除NG) → 腾讯 hf_（与 CNBC 主力合约昨收逐一吻合，实时）
     *   crypto             → 币安（实时）
     *   cn/cnstock         → 东财批量（A股官方实时）→ 挂时腾讯兜底（实时）
     *   NG                 → 东财（主力口径只有延迟源，见 universe.js v292 注）
     * 各组没拿到的，最后统一「补漏」：TV → 东财 → Yahoo。 */
    const em = [], bn = [], yh = [], cb = [], tx = [], cn = [], tvq = [], tw = [];
    restKeys.forEach(k => {
      const a = U.get(k);
      const s = a.src;
      if (a.rt === 'cnbc' || a.grp === 'us') cn.push(k);
      else if (a.rt === 'tx'
        || a.grp === 'usstock' || a.grp === 'hkstock'
        || (a.grp === 'apac' && (k === 'HSI' || k === 'HSTECH'))) {
        tx.push(k);
        /* 天然气这类新浪符号带年月、会换月，需要东财的连续合约价当锚点，
         * 所以它仍然进 em 批次 —— 但只用来做锚点，不写进 out。 */
        if (a.sinaRoll) em.push(k);
      }
      else if (a.grp === 'twstock' || k === 'TWII') tw.push(k);
      else if (a.grp === 'fx' || a.grp === 'rate'
        || (a.grp === 'apac' && (k === 'N225' || k === 'KS11'))) tvq.push(k);
      else if (s === 'binance') bn.push(k);
      else if (s === 'yahoo') yh.push(k);
      // cboe 必须单独拎出来：它既没有 secid（进 em 会让东财整批请求失败），
      // 也不该走 yahoo 的 5m 序列（国内根本连不上）。
      else if (s === 'cboe') cb.push(k);
      else em.push(k);
    });
    const out = {};
    const jobs = [];
    /* 直达主源并行（腾讯 qt / 新浪期货 / 新浪外汇 / CNBC / Yahoo meta） */
    if (directKeys.length) {
      jobs.push(Promise.all(directKeys.map(k => directQuote(k, U.get(k), out))));
    }

    if (em.length) {
      jobs.push((async () => {
        try {
          await emQuoteBatch(em, out);
        } catch (e) {
          /* v287：东财挂了不能只「保留缓存」——那会让旧价被当成实时价。
           * ① 记下失败原因供设置页/顶栏显示；② 对能映射腾讯代码的品种补真实报价；
           * ③ 补不到的绝不编数，交给 UI 明确标「延迟」。
           * v291：兜底升级为三级链（穷举实测覆盖 95/95，见 tools/test_quote_coverage.py）：
           *   一级 腾讯（真实时）：A股/港股/美股个股/美股指数/商品/日韩股
           *   二级 TV scanner 批量（一次 POST）：美债/外汇/商品/亚太指数/台股等
           *        全部 tv 符号（带官方延迟口径 update_mode）
           *   三级 Yahoo 末点：TWII 等腾讯/TV 都没有符号的品种 */
          status.em = 'fail';
          status.lastErr = '东财批量报价失败：' + ((e && e.message) || e);
          try {
            const n = await emFallbackTx(em, out);
            if (n > 0) {
              status.emFallback = 'tx:' + n;
              status.lastOk = Date.now();
            }
          } catch (e2) { /* 二级继续 */ }
          try {
            const n2 = await tvScanFallback(em, out);
            if (n2 > 0) {
              status.tvFallback = 'tv:' + n2;
              status.lastOk = Date.now();
            }
          } catch (e3) { /* 三级继续 */ }
          try {
            const n3 = await yahooQuoteFallback(em, out);
            if (n3 > 0) status.yhFallback = 'yh:' + n3;
          } catch (e4) { /* 全挂，交给 UI 报失败 */ }
        }
      })());
    }

    if (cn.length) {
      jobs.push((async () => {
        for (const k of cn) {
          try {
            const a = U.get(k);
            const sym = a.cnbcSym || cnbcSym(k, a);
            if (!sym) continue;
            out[k] = await cnbcQuoteOne(sym);
          } catch (e) {
            /* v292：只有 VIX（src=cboe）退回 CBOE（延 15 分钟，但仍是真价）。
             * SPX/NDX/SOX/DJI 的 src 是 em —— 绝不能退 CBOE，那会把 VIX 的价
             * 错填给标普（旧代码在 CNBC 失败时会把 cboeQuote 写进任意 key）。
             * 指数这边交给后面的补漏链：TV（延 15 分钟）→ 东财。 */
            const a2 = U.get(k);
            if (a2 && a2.src === 'cboe') {
              try {
                const q = await cboeQuote();
                out[k] = Object.assign({}, q, { src: 'cboe' });
              } catch (e2) { /* 补漏继续 */ }
            }
          }
        }
      })());
    }

    if (tvq.length) {
      jobs.push((async () => {
        /* TV scanner：外汇/美债/日经/KOSPI 全是官方 streaming 实时（实测），
         * 一次 POST 拿全部。挂了退东财（延 15 分钟级），再挂交给补漏。 */
        try { await tvScanFallback(tvq, out); }
        catch (e) { /* 退东财 */ }
        const miss = tvq.filter(k => !out[k]);
        if (miss.length) {
          try { await emQuoteBatch(miss, out); } catch (e) { /* 补漏继续 */ }
        }
      })());
    }

    if (tw.length) {
      jobs.push((async () => {
        /* TWSE 官方实时（一符号一请求，15s 缓存）。挂了交给补漏：
         * TV（台股延 20 分钟）→ Yahoo ^TWII。 */
        for (const k of tw) {
          try { out[k] = await twseQuote(k); }
          catch (e) { /* 补漏继续 */ }
        }
      })());
    }

    if (tx.length) {
      jobs.push((async () => {
        /* ① 腾讯批量报价（真实时、CORS 开放，一个请求拿全部有符号的） */
        try {
          const tq = await txQuote(tx);
          Object.keys(tq).forEach(k => { out[k] = tq[k]; });
        } catch (e) { /* 下面用新浪分时末点兜底 */ }
        /* ② 腾讯没有对应符号的（天然气）用新浪分时末点当报价 */
        for (const k of tx) {
          if (out[k]) continue;
          const a = U.get(k);
          if (!a || a.txSym) continue;
          try {
            const r = await sinaFut(sinaSymOf(k), a.pxScale || 1);
            const last = r.points[r.points.length - 1];
            if (!last) continue;
            const prev = r.preClose || last.close;
            out[k] = {
              price: last.close, prev,
              chg: prev ? last.close - prev : null,
              pct: prev ? (last.close - prev) / prev * 100 : 0,
              at: Date.now(), src: 'sina'
            };
            /* 和东财连续合约价对不上 → 合约可能换月了，后台纠正一次 */
            const anc = (cache.get('anc:' + k) || {}).d;
            if (anc && anc.price && Math.abs(last.close - anc.price) / anc.price > 0.025) {
              resolveSinaRoll(k, anc.price);
            }
          } catch (e) { /* ignore */ }
        }
      })());
    }

    if (bn.length) {
      jobs.push((async () => {
        try {
          const syms = bn.map(k => U.get(k).sym);
          let arr = [];
          try {
            const d = await bnJSON('/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(syms)));
            arr = Array.isArray(d) ? d : (d ? [d] : []);
          } catch (e) {
            // 币安全线不通 → OKX / 火币兜底，保证加密面板不空
            arr = await altTickers(syms);
            if (arr.length) status.binance = 'ok';
            status.bnAlt = arr.length ? 'okx/htx' : 'fail';
          }
          arr.forEach(r => {
            const k = bn.find(x => U.get(x).sym === r.symbol);
            if (!k) return;
            const price = +r.lastPrice;
            const pct = +r.priceChangePercent;
            out[k] = { price, pct, chg: price - price / (1 + pct / 100), prev: price / (1 + pct / 100), at: Date.now(), src: 'binance' };
          });
        } catch (e) { /* ignore */ }
      })());
    }

    if (cb.length) {
      jobs.push((async () => {
        try {
          const q = await cboeQuote();
          cb.forEach(k => { out[k] = Object.assign({}, q); });
        } catch (e) { /* ignore */ }
      })());
    }

    if (yh.length) {
      jobs.push((async () => {
        for (const k of yh) {
          try {
            /* v307：先用 1d 轻量 chart 的 meta 取实时价（一个请求、几百字节），
             * 比 5m/5d 序列快得多；拿不到再走原序列。 */
            const a0 = U.get(k);
            try {
              const hd = await yahooChart(a0.sym, '1d', '1d');
              const m = (((hd.chart || {}).result || [])[0] || {}).meta || {};
              if (m && m.regularMarketPrice > 0) {
                const price = m.regularMarketPrice;
                const prev = m.chartPreviousClose || m.previousClose || price;
                out[k] = { price, prev, chg: price - prev,
                  pct: prev ? (price - prev) / prev * 100 : 0,
                  at: Date.now(), src: 'yahoo' };
                continue;
              }
            } catch (e0) { /* 落序列 */ }
            const y = await yahooBars(a0.sym, '5m', '5d');
            if (!y.points.length) continue;
            const price = y.points[y.points.length - 1].close;
            const prev = y.prevClose || y.points[0].close;
            if (!price || !prev) continue;
            out[k] = {
              price, prev, chg: price - prev,
              pct: (price - prev) / prev * 100,
              at: Date.now(), src: 'yahoo'
            };
          } catch (e) { /* ignore */ }
        }
      })());
    }

    await Promise.all(jobs);
    /* v292【补漏】：各分组实时源都没拿到的品种，按「实时优先的兜底」再过一遍。
     * 覆盖：CNBC 挂的美股指数（TV→东财）、腾讯挂的美股/港股（TV→东财）、
     * TWSE 挂的台股（TV 延 20min → Yahoo ^TWII）、TV 挂的外汇美债（东财）。 */
    const missing = keys.filter(k => !out[k]);
    if (missing.length) {
      /* v307【新浪期货报价补漏】v302 写了 sinaFutQuote 却从未接进 batchQuote，
       * 导致东财 8. 段一断 IF/TL 等 8 个品种顶部价全空（手机矩阵已证实）。 */
      await Promise.all(missing.filter(k => (U.get(k) || {}).sinaf).map(async k => {
        try {
          const r = await sinaFutQuote(k, U.get(k));
          if (r && r.price > 0) {
            const prev = r.prev || 0;
            out[k] = { price: r.price, prev: prev, chg: prev ? r.price - prev : 0,
              pct: prev ? (r.price - prev) / prev * 100 : 0,
              at: Date.now(), src: 'sina' };
          }
        } catch (e) { /* 下一级 */ }
      }));
      const miss0 = missing.filter(k => !out[k]);
      if (miss0.length) {
        try { await tvScanFallback(miss0, out); } catch (e) { /* 下一级 */ }
      }
      const miss2 = miss0.filter(k => !out[k]);
      if (miss2.length) {
        try { await emQuoteBatch(miss2, out); } catch (e) { /* 下一级 */ }
      }
      const miss3 = miss2.filter(k => !out[k]);
      if (miss3.length) {
        try { await yahooQuoteFallback(miss3, out); } catch (e) { /* 全挂，如实报失败 */ }
      }
    }
    Object.keys(out).forEach(k => { cache.set('q:' + k, { t: Date.now(), d: out[k] }); });
    return out;
  }

  /* ---------------- 链上价格（DexScreener，CORS 开放） ---------------- */

  async function dexQuote(key) {
    const a = U.get(key);
    if (!a) throw new Error('no dex');
    /* v150：美股个股在链上有同名 RWA 代币（实测 MU 691.91 / SKHY 129.06，
     * 流动性 80 万美元级，与正股价格同量级）。没配 dex 时用代码搜一次。
     * 韩股/台股/A股/港股没有整齐对应关系，乱搜会把毫不相干的小币当成
     * 「链上价」摆上去，所以只放开美股。 */
    const guess = (!a.dex && (a.grp === 'usstock' || a.grp === 'us')) ? key : null;
    if (!a.dex && !guess) throw new Error('no dex');
    const STABLE = /^(USDC|USDT|DAI|USDC\.E|FDUSD|TUSD|USDD|PYUSD)$/i;
    const q0 = a.dex || guess;
    // 优先按合约地址取（结果集干净），否则退回关键词搜索
    const url = a.dexAddr
      ? `${DEX_BASE}/tokens/${encodeURIComponent(a.dexAddr)}`
      : `${DEX_BASE}/search?q=${encodeURIComponent(q0)}`;
    const d = await getJSON(url, 120000, 'dex');
    let pairs = (d && d.pairs) || [];
    if (a.dexAddr) {
      const addr = a.dexAddr.toLowerCase();
      const hit = pairs.filter(p => p && p.baseToken && String(p.baseToken.address).toLowerCase() === addr);
      if (hit.length) pairs = hit;
    } else {
      const want = String(q0).toUpperCase();
      pairs = pairs.filter(p => p && p.baseToken && String(p.baseToken.symbol).toUpperCase() === want
        /* 搜索式取数会混进同名垃圾币（SKHY 有个 $0.0000273 的），
         * 股票代币价格与正股同量级，低于 1 美元的直接排除。 */
        && (!guess || +p.priceUsd >= 1));
    }
    const pick = (arr) => arr.slice().sort((x, y) =>
      ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0))[0];
    const best = pick(pairs.filter(p => p.quoteToken && STABLE.test(p.quoteToken.symbol))) || pick(pairs);
    if (!best || !best.priceUsd) throw new Error('no pair');
    return {
      price: +best.priceUsd,
      liq: (best.liquidity && best.liquidity.usd) || 0,
      dex: best.dexId,
      chain: best.chainId,
      pair: (best.baseToken.symbol || '') + '/' + (best.quoteToken.symbol || ''),
      at: Date.now()
    };
  }

  /* ---------------- 延展时段价（需要服务端代理，file:// 下自动跳过） ---------------- */

  async function extQuote(key) {
    if (location.protocol === 'file:') return null;
    const a = U.get(key);
    if (!a || !a.extSym) return null;
    try {
      const r = await fetch('/api/ext?symbol=' + encodeURIComponent(a.extSym), { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || d.price == null) return null;
      status.ext = 'ok';
      return d;
    } catch (e) {
      status.ext = 'fail';
      return null;
    }
  }

  /* ---------------- CNBC 延展时段报价（盘前 / 盘后） ----------------
   * 用户口径：「盘前走势和盘后走势，点进去能看到分时图但没有涨跌幅；
   *            行情页可以像暗盘那样写上盘前/盘后涨跌幅」。
   *
   * 为什么必须单开一路：
   *   东财批量报价（batchQuote 的 f2/f3）只有**常规时段**口径。美股一进盘前/盘后，
   *   f2 就停在上一交易日收盘价、f3 就是那一整天的涨跌 —— 于是「盘前」标签旁边
   *   的百分比永远是昨天的数，盘前真正走了多少完全看不到。
   *
   * quote.cnbc.com 的 restQuote 带 exthrs=1，回包里直接给 ExtendedMktQuote：
   *   {"type":"PRE_MKT"|"POST_MKT","last":"342.65","change":"+0.28","change_pct":"+0.08%"}
   * 一次可批量（symbols 用 | 分隔），指数(.SPX/.IXIC/.DJI/.SOX/.VIX)与个股通吃，
   * 国内实测可直连；它不回 CORS 头，浏览器侧自动回落 LiveNews.proxy 同源转发。
   * ---------------------------------------------------------------- */
  const CNBC_Q = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
  /* universe 里的美股指数 → CNBC 代码（前缀 . 表示指数）。
   * 注意 NDX 这项在东财是 100.NDX＝纳斯达克综合(IXIC)，不是纳指100，别改成 .NDX */
  const CNBC_IDX = { SPX: '.SPX', NDX: '.IXIC', SOX: '.SOX', DJI: '.DJI', VIX: '.VIX' };
  const extCache = new Map();   // key -> { at, d }

  function cnbcSym(key, a) {
    if (!a) return '';
    if (a.grp === 'usstock') return a.extSym || '';
    if (a.grp === 'us') return CNBC_IDX[key] || '';
    return '';
  }

  async function cnbcJSON(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') throw e;
      const t = await P(url, { timeout: 14000, check: b => String(b).indexOf('FormattedQuote') >= 0 });
      const i = String(t).indexOf('{');
      if (i < 0) throw new Error('bad proxy payload');
      return JSON.parse(String(t).slice(i));
    }
  }

  const cnbcNum = (s) => {
    const v = Number(String(s == null ? '' : s).replace(/[$,%\s]/g, ''));
    return isFinite(v) ? v : null;
  };

  /** 解析单条 CNBC 报价里的延展时段部分；没有盘前/盘后成交就返回 null */
  function parseCnbcExt(x) {
    if (!x) return null;
    const ex = x.ExtendedMktQuote;
    if (!ex || !ex.last) return null;
    const t = String(ex.type || '').toUpperCase();
    const phase = t.indexOf('PRE') === 0 ? 'pre' : t.indexOf('POST') >= 0 ? 'post' : '';
    if (!phase) return null;
    const price = cnbcNum(ex.last);
    if (price == null || price <= 0) return null;
    const chg = cnbcNum(ex.change);
    /* 基准必须是「常规收盘价」而不是更早的 previous_day_closing：
     * CNBC 的 ExtendedMktQuote.change 是相对**当日常规收盘**算的
     * （实测 TSLA 盘后 359.40、change +1.18 → 收盘 358.22，涨幅 0.33%；
     *   拿 previous_day_closing 343.69 去比会算成 +4.6%，差一个量级）。 */
    const regularClose = (chg != null) ? price - chg : cnbcNum(x.previous_day_closing);
    let pct = cnbcNum(ex.change_pct);
    if (pct == null) {
      if (chg != null && regularClose) pct = chg / regularClose * 100;
    }
    return {
      phase,
      price,
      pct,                                  // 盘前/盘后相对常规收盘的涨跌幅
      chg,
      base: regularClose,                   // 常规收盘价（延展时段的比较基准）
      prevClose: cnbcNum(x.previous_day_closing),  // 再往前一天的收盘（对照用，不参与计算）
      regularPct: cnbcNum(x.change_pct),    // 常规时段那一整天的涨跌
      at: Date.now()
    };
  }

  /* ---------------- TradingView 盘前/盘后（覆盖 CNBC 够不到的动态/海外品种） ----------
   * 用户口径：盘前盘后价不光美股要有，韩股/台股也要；而且像 SK 海力士（美股 OTC 代码
   * SKHY）这种「动态合成」品种没有 CNBC extSym，CNBC 取不到盘后价。TradingView 的
   * scanner 按 tv 符号取数（NASDAQ:SKHY / KRX:000660 / TWSE:2330），一次 POST 把整个
   * watchlist 的盘前盘后全拿回来，正好补上 CNBC 的盲区。
   *
   * 接口：POST https://scanner.tradingview.com/global/scan
   *   body {"symbols":{"tickers":[...],"query":{"types":[]}},"columns":[...]}
   *   CORS：用 text/plain 作为 content-type 走 simple request（免预检）；Origin:null（file://）
   *        也回 200。返回 d.data[].d 是列值数组，顺序与 columns 一致。
   *   列：close / premarket_close / postmarket_close（价格，本币）/ currency
   *   —— 涨跌幅不依赖 TV 给的 change 字段，直接用 (price/close-1)*100 算，避免口径歧义。
   * ------------------------------------------------------------------------------ */
  const TV_SCAN = 'https://scanner.tradingview.com/global/scan';
  const TV_EXT_GRPS = ['usstock', 'us', 'krstock', 'twstock'];

  async function tvExtFetch(tvKeys) {
    const cols = ['close', 'premarket_close', 'postmarket_close', 'currency'];
    const tickers = tvKeys.map(k => U.get(k).tv);
    const body = JSON.stringify({ symbols: { tickers: tickers, query: { types: [] } }, columns: cols });
    const res = await fetch(TV_SCAN, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body,
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('TV HTTP ' + res.status);
    const d = await res.json();
    const byTv = {};
    (d.data || []).forEach(it => { if (it && it.s) byTv[it.s] = it.d; });
    const out = {};
    tvKeys.forEach(k => {
      const a = U.get(k);
      const arr = byTv[a.tv];
      if (!arr || arr[0] == null) return;            // close 都没有 → TV 也不覆盖这个品种
      const close = Number(arr[0]);
      if (!isFinite(close) || close <= 0) return;
      const preC = Number(arr[1]);
      const postC = Number(arr[2]);
      /* v61：台股没有连续盘后（14:00–14:30 定盘，单一价），TV 的 postmarket_close
       * 恒等于常规收盘。照它显示会得到「盘后 2,135.00 +0.00%」这种假读数，
       * 所以与收盘差 <0.05% 的台股 pre/post 一律当没有（与 tvRawExt 同口径）。 */
      const eps = close * 0.0005;
      const isTw = a.grp === 'twstock';
      const preOk = isFinite(preC) && preC > 0 && (!isTw || Math.abs(preC - close) >= eps);
      const postOk = isFinite(postC) && postC > 0 && (!isTw || Math.abs(postC - close) >= eps);
      const st = w.Session && w.Session.state ? w.Session.state(k) : null;
      const usePost = (st && (st.phase === 'post' || st.phase === 'closed'));
      const isPre = !!(st && st.phase === 'pre');
      let phase = null, price = null;
      if (usePost && postOk) { phase = 'post'; price = postC; }
      else if (preOk) { phase = 'pre'; price = preC; }
      /* v200：盘前时段不认残留的 postmarket_close（上一场盘后价），
       * 否则行情页会在 04:00–09:30 ET 误标成「盘后」。宁可不显示，不造假。 */
      else if (postOk && !isPre) { phase = 'post'; price = postC; }
      if (!phase) return;
      out[k] = {
        phase: phase, price: price, pct: (price / close - 1) * 100,
        chg: price - close, base: close, prevClose: close,
        regularPct: null, src: 'tv', at: Date.now()
      };
    });
    return out;
  }

  /** 返回 TV 的 pre/post 收盘原始值（不按当前时段 gating），供韩股/台股合成延展段。
   *  与 tvExtFetch 不同：这里把 premarket_close / postmarket_close 都返回，
   *  由调用方按「是否有差值」自行决定画不画盘前/盘后段，从而做到
   *  「开关只是显示/隐藏，段始终合成」——与美股 Nasdaq 那套逻辑一致。
   *  实测 KRX:000660 盘后 1,176,000 vs 常规 1,132,000（+3.89%）有真实盘后数据。 */
  async function tvRawExt(tvKeys) {
    if (!tvKeys || !tvKeys.length) return {};
    const cols = ['close', 'premarket_close', 'postmarket_close', 'currency'];
    const tickers = tvKeys.map(k => U.get(k).tv);
    const body = JSON.stringify({ symbols: { tickers: tickers, query: { types: [] } }, columns: cols });
    const res = await fetch(TV_SCAN, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, cache: 'no-store'
    });
    if (!res.ok) throw new Error('TV HTTP ' + res.status);
    const d = await res.json();
    const byTv = {};
    (d.data || []).forEach(it => { if (it && it.s) byTv[it.s] = it.d; });
    const out = {};
    tvKeys.forEach(k => {
      const a = U.get(k);
      const arr = byTv[a.tv];
      if (!arr || arr[0] == null) return;
      const close = Number(arr[0]);
      if (!isFinite(close) || close <= 0) return;
      const pre = Number(arr[1]);
      const post = Number(arr[2]);
      /* v61：台股没有连续盘后交易（只有 14:00–14:30 的盘后定盘，单一价），
       * TV 回包的 postmarket_close 恒等于常规收盘。这不是「盘后价」，
       * 照着显示会得到「盘后 2,135.00 +0.00%」这种误导性读数，
       * 分时图上也会多接一段平线。台股这边只要与收盘差 <0.05% 就当没有。 */
      const eps = close * 0.0005;
      const realPre = (isFinite(pre) && pre > 0 && (a.grp !== 'twstock' || Math.abs(pre - close) >= eps)) ? pre : null;
      const realPost = (isFinite(post) && post > 0 && (a.grp !== 'twstock' || Math.abs(post - close) >= eps)) ? post : null;
      out[k] = {
        close: close,
        pre: realPre,
        post: realPost
      };
    });
    return out;
  }

  /** 批量取延展时段报价 → { [key]: {phase,price,pct,...} }
   *  45 秒缓存；取不到就返回空对象（行情页不显示这一行，不会造假）
   *
   *  v146：先跑 TradingView（覆盖 SKHY / KRX / TWSE 这类 CNBC 取不到的动态/海外品种），
   *  再跑 CNBC 补美股常规路径；两条都拿不到才不显示。两条源并存，互不删除对方的命中。 */
  async function extQuotes(keys) {
    const want = (keys || []).filter(Boolean);
    if (!want.length) return {};
    const now = Date.now();

    // ---- ① TradingView：盘前/盘后（覆盖 CNBC 盲区）----
    const tvKeys = want.filter(k => {
      const a = U.get(k);
      return a && a.tv && TV_EXT_GRPS.indexOf(a.grp) >= 0
        && (!extCache.get(k) || now - extCache.get(k).at > 45000);
    });
    if (tvKeys.length) {
      try {
        const tvMap = await tvExtFetch(tvKeys);
        tvKeys.forEach(k => {
          if (tvMap[k]) extCache.set(k, { at: now, d: tvMap[k] });
          else extCache.delete(k);
        });
        status.tv = 'ok';
      } catch (e) { status.tv = 'fail'; }
    }

    const byKey = new Map();
    want.forEach(k => {
      const s = cnbcSym(k, U.get(k));
      if (s) byKey.set(k, s);
    });
    const stale = want.filter(k => {
      const h = extCache.get(k);
      return !h || now - h.at > 45000;
    });
    const syms = [];
    stale.forEach(k => {
      const s = byKey.get(k);
      if (s && syms.indexOf(s) < 0) syms.push(s);
    });
    if (syms.length) {
      const url = `${CNBC_Q}?symbols=${encodeURIComponent(syms.join('|'))}`
        + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
      try {
        const d = await cnbcJSON(url);
        const raw = d && d.FormattedQuoteResult && d.FormattedQuoteResult.FormattedQuote;
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        const bySym = {};
        arr.forEach(x => { if (x && x.symbol) bySym[String(x.symbol).toUpperCase()] = x; });
        byKey.forEach((sym, k) => {
          const rec = parseCnbcExt(bySym[String(sym).toUpperCase()]);
          // TV 已经给了这个品种就别删（CNBC 偶发抽风返回空时，保留 TV 的命中）
          const tvHit = extCache.get(k) && extCache.get(k).d && extCache.get(k).d.src === 'tv';
          if (rec) extCache.set(k, { at: now, d: rec });
          else if (!tvHit) extCache.delete(k);
        });
        status.ext = 'ok';
      } catch (e) {
        status.ext = 'fail';   // 失败保留旧值（45 秒内仍可用），不抛给调用方
      }
    }
    const out = {};
    want.forEach(k => {
      const h = extCache.get(k);
      const rec = h && h.d;
      if (!rec) return;
      /* v200：盘前时段不认「上一场残留的盘后价」。
       * TV / CNBC 在 04:00–09:30 ET 有时还挂着上一交易日的 postmarket_close，
       * 若原样透出，行情页会在盘前时段误标成「盘后 xxx」——用户问的就是这个。
       * 盘前只认真实盘前价（phase=pre）；拿不到就留空，绝不拿旧盘后价冒充。 */
      const stp = w.Session && w.Session.state ? w.Session.state(k) : null;
      if (stp && stp.phase === 'pre' && rec.phase === 'post') return;
      out[k] = rec;
    });

    /* 【兜底】CNBC 偶发抽风（限流 / 该时段不给 ExtendedMktQuote）时，个股改用
     * 纳斯达克官方分时推一条盘前/盘后价 —— 那份数据本来就要抓来画分时图，
     * 命中 60 秒缓存就是零成本，不会额外多打请求。
     * 用户口径里「美光没有显示盘后价」就是这么暴露出来的：数据源在、只是
     * 单一路径失败时整行都不见了。 */
    const miss = want.filter(k => {
      if (out[k]) return false;
      const a = U.get(k);
      return !!(a && a.grp === 'usstock' && a.kind === 'stock' && a.extSym);
    }).slice(0, 8);
    if (miss.length) {
      const got = await Promise.all(miss.map(async k => [k, await nasdaqExtOf(U.get(k).extSym)]));
      got.forEach(([k, rec]) => {
        if (!rec) return;
        extCache.set(k, { at: now, d: rec });
        out[k] = rec;
      });
    }
    return out;
  }

  /** 用纳斯达克分时末点推一份延展时段报价（CNBC 失败时的兜底） */
  async function nasdaqExtOf(sym) {
    try {
      const n = await nasdaqMinutes(sym);
      const pts = (n && n.points) || [];
      if (!pts.length) return null;
      const last = pts[pts.length - 1];
      if (!last.seg || last.seg === 'reg') return null;   // 还在常规时段，没有「盘后价」可说
      const base = n.regClose || n.preClose || pts[0].close;
      if (!base || !last.close) return null;
      const price = last.close;
      return {
        phase: last.seg,
        price: price,
        pct: (price - base) / base * 100,
        chg: price - base,
        base: base,
        prevClose: n.preClose,
        regularPct: n.preClose ? (base - n.preClose) / n.preClose * 100 : null,
        src: 'nasdaq',
        at: Date.now()
      };
    } catch (e) { return null; }
  }

  /* ---------------- 链上 RWA 永续（Hyperliquid xyz 子 DEX） ----------------
   * 用户口径：「原油周末要标出暗盘价格，其他商品如果有暗盘或链上价格同理」。
   *
   * 为什么是它：
   *   CME / ICE 周末关门，原油、黄金、股指、个股都没有连续报价。
   *   链上的 RWA 永续合约 7×24 交易，周末和节假日照样成交，
   *   报价对「周末出了什么事」反应最快 —— 这正是「暗盘」想知道的东西。
   *
   * 接口：POST https://api.hyperliquid.xyz/info
   *   body {"type":"allMids","dex":"xyz"}  → 一次返回 142 个标的的最新中间价
   *   回包 {"xyz:CL":"60.21", "xyz:GOLD":"4040.9", ...}（价格是字符串）
   *   CORS：access-control-allow-origin: * ，file:// 下也能直连。
   *
   * 一次请求拿全池，本地按 hl 字段映射，30 秒缓存 —— 开销可以忽略。
   * ------------------------------------------------------------------ */
  const HL_API = 'https://api.hyperliquid.xyz/info';
  const HL_TTL = 30000;
  let hlCache = { at: 0, map: null, busy: null };

  async function hlMids() {
    const now = Date.now();
    if (hlCache.map && now - hlCache.at < HL_TTL) return hlCache.map;
    if (hlCache.busy) return hlCache.busy;
    hlCache.busy = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        let res;
        try {
          res = await fetch(HL_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'allMids', dex: 'xyz' }),
            signal: ctrl.signal,
            cache: 'no-store'
          });
        } finally { clearTimeout(timer); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        const map = {};
        Object.keys(d || {}).forEach(k => {
          // 回包 key 带 "xyz:" 前缀，值可能是字符串
          const name = k.indexOf(':') >= 0 ? k.split(':').pop() : k;
          const v = parseFloat(d[k]);
          if (name && isFinite(v) && v > 0) map[name.toUpperCase()] = v;
        });
        status.hl = 'ok';
        hlCache = { at: Date.now(), map, busy: null };
        return map;
      } catch (e) {
        status.hl = 'fail';
        hlCache.busy = null;
        return hlCache.map || {};
      }
    })();
    return hlCache.busy;
  }

  /** 单个品种的链上价；该品种没配 hl 或取不到时返回 null */
  async function hlQuote(key) {
    const a = U.get(key);
    if (!a) return null;
    /* 用户后续自己添加的品种不一定配过 hl。
     * 美股个股在链上是同名挂牌（NVDA / TSLA / AAPL…），直接用代码试一次；
     * A股/港股没有这么整齐的对应关系，乱猜会把「-90%」的假基差摆到页面上，
     * 所以只对美股个股做这个兜底。
     *
     * v64：日股/韩股/台股改走「同公司海外挂牌」映射（universe 的 ADR_MAP），
     * 例如 000660→SKHX、2330→TSM。这类价格是美元计价的 ADR/GDR，
     * 与本地价格不同币种、还可能不同换算比例，因此**只当参考价**，
     * 由调用方按 adr 标记决定不计算基差。 */
    const adr = (!a.hl && w.UNIVERSE && w.UNIVERSE.adrOf) ? w.UNIVERSE.adrOf(key) : null;
    const sym = a.hl || (adr && adr.sym)
      || ((a.grp === 'usstock' || (a.kind === 'stock' && a.secid && /^105\./.test(a.secid))) ? key : null);
    if (!sym) return null;
    const map = await hlMids();
    const p = map[String(sym).toUpperCase()];
    if (!p) return null;
    return { price: p, sym: sym, at: hlCache.at, adr: adr || null };
  }

  /* ---------------- 韩股：常规 + 盘后（Nextrade 애프터마켓）分钟线 ----------------
   * 用户口径：「韩股 15:40–16:00 定价，16:00–20:00 连续盘后，源可以是 KIS / yfinance」。
   * 实测结论（2026-11-08）：
   *   · yfinance 就是 Yahoo 的封装，Yahoo 对 000660.KS 用 includePrePost=true
   *     在 5天/1分钟、1个月/5分钟两个区间里 **15:30 之后一个点都没有** —— 走不通；
   *   · TradingView 没有 NXT 交易所符号（NXT:000660 查无此标的）；
   *   · Nextrade 官网行情在会员门户后面，无公开接口；네이버/다음/토스 也没有 NXT 字段；
   *   · **Naver 的 fchart 分钟接口**（fchart.stock.naver.com/sise.nhn）却完整覆盖了：
   *       15:40–15:59 单一价（收盘定价，实测 11-06 全天恒为 1,132,000）
   *       16:00–19:59 连续成交（实测逐分钟变化，18:00 之后只有 Nextrade 在交易）
   *     即 Nextrade 애프터마켓 15:40–20:00 的分钟序列。**盘前 08:00–08:50 该源没有**。
   * 所以：韩股盘后分时用这个源，盘前仍然没有（不编）。
   * 返回的 volume 是**当日累计量**，这里按日切差分还原成每分钟量，否则量能柱会一路爬升。
   */
  const KR_MIN_TTL = 45000;
  const krMinCache = new Map();

  async function krNaverMinutes(key) {
    const a = U.get(key);
    if (!a || a.grp !== 'krstock' || !a.tv) return null;
    const code = String(a.tv).split(':')[1] || String(key);
    if (!/^\d{6}$/.test(code)) return null;
    const hit = krMinCache.get(code);
    if (hit && Date.now() - hit.at < KR_MIN_TTL) return hit.d;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
    const target = 'https://fchart.stock.naver.com/sise.nhn?symbol=' + code
      + '&timeframe=minute&count=700&requestType=0';
    let txt = '';
    try {
      const r = await proxyFetch(target);
      if (r.ok) {
        const t = await r.text();
        if (t && t.indexOf('data="') >= 0) txt = t;
      }
    } catch (e) { /* 走兜底 */ }
    if (!txt) {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') return null;
      try {
        txt = String(await P(target, { timeout: 15000, raw: true, check: b => String(b).indexOf('data="') >= 0 }));
      } catch (e) { return null; }
    }
    const raw = [];
    const re = /data="([^"]+)"/g;
    let m;
    while ((m = re.exec(txt))) raw.push(m[1]);
    if (!raw.length) return null;
    const lastDay = raw[raw.length - 1].slice(0, 8);
    const pts = [];
    let prevCum = 0;
    for (const line of raw) {
      const f = line.split('|');
      if (!f[0] || f[0].slice(0, 8) !== lastDay) continue;
      const close = +f[4];
      if (!isFinite(close) || close <= 0) continue;
      const y = +f[0].slice(0, 4), mo = +f[0].slice(4, 6), dd = +f[0].slice(6, 8);
      const hh = +f[0].slice(8, 10), mi = +f[0].slice(10, 12);
      const hm = hh * 60 + mi;
      const cum = +f[5] || 0;
      const vol = cum > prevCum ? cum - prevCum : 0;
      if (cum) prevCum = cum;
      const seg = hm < 540 ? 'pre' : (hm <= 930 ? 'reg' : 'post');
      pts.push({
        /* v274：Naver 分钟的时间是 KST，东财常规段是北京时间 —— 直接当 UTC 装
         * 桶会出现「左上角 16:08」（KST）与顶部/图轴（北京）差一小时的两套钟。
         * 统一换算成北京时间（-1h），Date.UTC 负小时自动跨日进位。 */
        time: Math.floor(Date.UTC(y, mo - 1, dd, hh - 1, mi) / 1000),
        open: close, high: close, low: close, close: close,
        volume: vol, seg: seg,
        auction: (seg === 'post' && hm < 960) ? true : undefined
      });
    }
    if (pts.length < 20) return null;
    const d = { points: pts, day: lastDay };
    krMinCache.set(code, { at: Date.now(), d: d });
    return d;
  }

  /* ---------------- 日股 夜間PTS（Japannext J-Market） ----------------
   * 用户口径：「日股有 PTS 盘前盘后，你要想办法揭露」。
   * 事实：东证主板没有美股式盘前盘后；Japannext 的 J-Market 提供 17:00–次日 06:00
   * 的夜间连续交易（Yahoo!ファイナンス 页面明确写着数据来自 ジャパンネクスト証券，
   * 并给「東証終値比」）。免费可得的入口就是这个页面。
   * 实测 6758：夜間PTS 4,255，东证终值比 +2.73%。
   * 注意：YJ 没有公开的分时接口 —— 所以只报「最新价 + 相对东证收盘涨跌幅」，
   * 不画曲线（画就是编）。
   */
  const JP_PTS_TTL = 60000;
  const jpPtsCache = new Map();

  async function jpPtsQuote(key) {
    const a = U.get(key);
    if (!a || a.grp !== 'jpstock' || !a.tv) return null;
    const code = String(a.tv).split(':')[1];
    if (!/^\d{4}$/.test(code)) return null;
    const hit = jpPtsCache.get(code);
    if (hit && Date.now() - hit.at < JP_PTS_TTL) return hit.d;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
    const url = 'https://finance.yahoo.co.jp/quote/' + code + '.T';
    /* 取原文优先走**同源 /__proxy**：部署环境自带，返回的是原始 HTML，不会被限流。
     * 代理池（含 jina 镜像）作为兜底 —— 但 jina 会把页面转成 Markdown，
     * `夜間PTS</span>` 这种标记就没了，所以下面两种形态都要能解析。 */
    let html = '';
    try {
      if (typeof location !== 'undefined' && location.protocol.indexOf('http') === 0) {
        const r = await fetch('/__proxy?u=' + encodeURIComponent(url), { cache: 'no-store' });
        if (r.ok) {
          const t = await r.text();
          if (t && t.indexOf('夜間PTS') >= 0) html = t;
        }
      }
    } catch (e) { /* 走兜底 */ }
    if (!html) {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') return null;
      try {
        html = String(await P(url, { timeout: 18000, raw: true, check: b => String(b).indexOf('夜間PTS') >= 0 }));
      } catch (e) { return null; }
    }
    let price = 0, pct = null;
    const s = html.indexOf('夜間PTS</span>');
    if (s >= 0) {
      const seg = html.slice(s, s + 1500);
      const pm = /_StyledNumber__value_[^"]*">\s*([\d,]+(?:\.\d+)?)\s*</.exec(seg);
      if (pm) price = +pm[1].replace(/,/g, '');
      const cm = /東証終値比[\s\S]{0,300}?_StyledNumber__value_[^"]*">\s*([+-]?[\d.]+)\s*</.exec(seg);
      if (cm) pct = +cm[1];
    }
    if (!price) {
      /* Markdown 形态：夜間PTS 4,255 … 東証終値比 +2.73% */
      const mp = /夜間PTS\s*\|?\s*([\d,]+(?:\.\d+)?)/.exec(html);
      if (mp) price = +mp[1].replace(/,/g, '');
      const mc = /東証終値比\s*\|?\s*([+-]?[\d.]+)\s*%?/.exec(html);
      if (mc) pct = +mc[1];
    }
    if (!isFinite(price) || price <= 0) return null;
    const d = { price: price, pct: pct, code: code, at: Date.now(), src: 'jp-pts' };
    jpPtsCache.set(code, { at: Date.now(), d: d });
    return d;
  }

  /* ---------------- 币安封装 ---------------- */

  /** 依次试币安各域名，第一个成功的记住，下次直接用 */
  async function bnJSON(path) {
    const errs = [];
    for (let n = 0; n < BN_HOSTS.length; n++) {
      const i = (bnHost + n) % BN_HOSTS.length;
      try {
        const d = await getJSON(BN_HOSTS[i] + path, 0, null);
        bnHost = i;
        status.binance = 'ok';
        status.bnHost = BN_HOSTS[i].replace('https://', '').split('/')[0];
        return d;
      } catch (e) { errs.push(String((e && e.message) || e)); }
    }
    throw new Error('币安全部域名不可达（' + errs[errs.length - 1] + '）');
  }

  /* 币安全挂时的备用行情：OKX / 火币。
   * 国内网络下这两个站点比币安更容易连通，接口都带 CORS 头。
   * 只提供现价与 24h 涨跌幅 —— 加密面板要的就是这两个数。 */
  function okxInst(sym) {
    const b = String(sym || '').toUpperCase().replace(/USDT$/, '');
    return b ? b + '-USDT' : '';
  }

  async function altTickers(syms) {
    const out = [];
    await Promise.all((syms || []).map(async (sym) => {
      const inst = okxInst(sym);
      if (!inst) return;
      // ① OKX
      try {
        const d = await getJSON('https://www.okx.com/api/v5/market/ticker?instId=' + encodeURIComponent(inst), 5000, null);
        const r = d && d.data && d.data[0];
        const last = r ? +r.last : 0;
        const open = r ? +r.open24h : 0;
        if (last > 0) {
          out.push({ symbol: sym, lastPrice: last, priceChangePercent: open > 0 ? (last - open) / open * 100 : 0 });
          return;
        }
      } catch (e) { /* 下一家 */ }
      // ② 火币 HTX
      try {
        const d = await getJSON('https://api.huobi.pro/market/detail/merged?symbol=' + inst.replace('-', '').toLowerCase(), 5000, null);
        const t = d && d.tick;
        const last = t ? +t.close : 0;
        const open = t ? +t.open : 0;
        if (last > 0) {
          out.push({ symbol: sym, lastPrice: last, priceChangePercent: open > 0 ? (last - open) / open * 100 : 0 });
        }
      } catch (e) { /* 没辙了 */ }
    }));
    return out;
  }

  const BN_IV = { min: '5m', d: '1d', w: '1w', m: '1M', '1m': '1m' };

  async function bnKline(sym, interval, limit) {
    /* v166：币安单次最多 1000 根，要全历史就按 endTime 往前翻页 */
    if (limit <= 1000) {
      const d = await bnJSON(`/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
      if (!Array.isArray(d)) throw new Error('bad binance payload');
      return d.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        amount: +k[7] || 0
      }));
    }
    let out = [];
    let endTime = null;
    while (out.length < limit) {
      const n = Math.min(1000, limit - out.length);
      const q = `/klines?symbol=${sym}&interval=${interval}&limit=${n}`
        + (endTime ? `&endTime=${endTime}` : '');
      const d = await bnJSON(q);
      if (!Array.isArray(d) || !d.length) break;
      out = d.concat(out);
      endTime = d[0][0] - 1;
      if (d.length < n) break;
    }
    return out.slice(-limit).map(k => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      amount: +k[7] || 0
    }));
  }

  /* ---------------- Yahoo 封装（VIX 等东财没有的标的） ----------------
   * 浏览器直连 Yahoo 无 CORS 头，走 jina 代理（返回体带 "Markdown Content:" 前缀）。
   * 服务端形态（server.py / news_live.py）可直连，无此限制。
   */
  const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  const JINA_PROXY = 'https://r.jina.ai/';

  async function yahooChart(sym, interval, range) {
    /* 【v166 关键】range=max 会被 Yahoo **偷偷降级粒度**：
     * 实测 ^SOX ?interval=1d&range=max 只回 391 根（1994 起每月一根 ≈ 月线），
     * AAPL / ^GSPC 也只回 169 根 —— 照它画「日K」等于只剩几根柱子。
     * 要真·全历史必须用 period1/period2：period1=0 会从最早一根给起
     * （实测 ^SOX 日线 8184 根 / 周线 1698 / 月线 392）。
     * 所以约定 range==='epoch' 表示「我要从上市到现在」。 */
    const qs = (range === 'epoch')
      ? ('interval=' + interval + '&period1=0&period2=' + Math.floor(Date.now() / 1000))
      : ('interval=' + interval + '&range=' + range);
    const target = `${YAHOO_CHART}${encodeURIComponent(sym)}?${qs}`;
    let url = target;
    /* v331【外汇日K 取数失败】range=epoch（period1=0）历史极长，走代理会超时/截断，
     * 而浏览器直连 Yahoo 又被 CORS 拦，于是外汇日K整条失败（美元离岸人民币实测）。
     * epoch 失败时自动回退 5y（≈1300 根，足够画日K全貌），再不行才如实失败。 */
    const tryOnce = async (tgt) => {
      try {
        const raw = await proxyText(tgt, 'https://finance.yahoo.com/');
        const c0 = String(raw || '').indexOf('{');
        if (c0 >= 0 && String(raw).indexOf('"chart"') >= 0) {
          return JSON.parse(String(raw).slice(c0));
        }
      } catch (e) { /* 落原 fetch 路径 */ }
      try {
        const r = await fetch(tgt, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const t = await r.text();
        return JSON.parse(t.slice(t.indexOf('{')));
      } catch (e) {
        const P = w.LiveNews && w.LiveNews.proxy;
        if (typeof P !== 'function') throw e;
        const t = await P(tgt, { timeout: 16000, check: b => String(b).indexOf('"chart"') >= 0 });
        const cut = String(t).indexOf('{');
        if (cut < 0) throw new Error('bad proxy payload');
        return JSON.parse(String(t).slice(cut));
      }
    };
    try {
      return await tryOnce(target);
    } catch (e0) {
      if (range === 'epoch') {
        const alt = `${YAHOO_CHART}${encodeURIComponent(sym)}?interval=${interval}&range=5y`;
        return await tryOnce(alt);
      }
      throw e0;
    }
  }

  async function yahooBars(sym, interval, range, beijing) {
    const d = await yahooChart(sym, interval, range);
    const res = d.chart.result[0];
    const ts = res.timestamp || [];
    const q = (res.indicators.quote || [{}])[0];
    const off = (res.meta && res.meta.gmtoffset) || 0;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = (q.close || [])[i];
      if (c == null || !isFinite(c)) continue;
      /* v330：时间轴约定 = 「北京时间墙上时间装进 UTC 分量」（与东财/腾讯一致）。
       * 日K用交易所日期（ts+gmtoffset）；分时若原样输出交易所墙上时间，图上会
       * 显示 12:36（ET）而不是北京 01:36，右侧收盘留白也会算错 ——
       * 分时调用一律传 beijing=true，改用 ts+8h。 */
      const t = beijing ? (ts[i] + 8 * 3600) : (ts[i] + off);
      out.push({
        time: Math.floor(t / 60) * 60,
        open: (q.open || [])[i] || c,
        high: (q.high || [])[i] || c,
        low: (q.low || [])[i] || c,
        close: c,
        volume: (q.volume || [])[i] || 0
      });
    }
    return { points: out, prevClose: (res.meta && res.meta.chartPreviousClose) || 0,
             name: (res.meta && (res.meta.shortName || res.meta.longName)) || '' };
  }

  /* ---------------- CBOE 官方（VIX 的唯一可靠源） ----------------
   *
   * 原来 VIX 走 Yahoo（^VIX）。问题是 query1.finance.yahoo.com
   * 在国内**直连根本不通**（实测 code=000），只能吃代理池里最后一次成功的旧值 ——
   * 于是 VIX 一边显示「-0.72% 休市」，实际当天已经跌了 17.4%。
   * 波动率指数是黑天鹅的第一现场，用陈价等于把这个面板最值钱的功能废掉。
   *
   * cdn-api.cboe.com 是 CBOE 自家 CDN（CloudFront），**国内直连可达**
   * （实测 200 / 2.0s），延迟 15 分钟，字段齐全：
   *   现价 / 涨跌额 / 涨跌幅 / 昨收 / 开高低 —— 日涨跌直接用它给的，不自己瞎算。
   * 分钟线在 charts/intraday，日线在 charts/historical（1990 年至今）。
   *
   * 唯一坑：它不回 Access-Control-Allow-Origin，浏览器 fetch 必被 CORS 拦。
   * 所以统一走 LiveNews.proxy（APK 里是原生同源代理，浏览器里是 jina 镜像）。
   */
  const CBOE = {
    q: 'https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/_VIX.json',
    intraday: 'https://cdn-api.cboe.com/api/global/delayed_quotes/charts/intraday/_VIX.json',
    daily: 'https://cdn-api.cboe.com/api/global/delayed_quotes/charts/historical/_VIX.json',
  };

  /** 从可能带 Markdown 包装的文本里取出 JSON（jina 会在前后加标题行） */
  function takeJSON(t) {
    const s = String(t == null ? '' : t);
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  }

  async function cboeJSON(url, ttl) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < (ttl || 30000)) return hit.d;
    let d = null;
    // ① 直连：少数环境（原生容器 / 服务端渲染）不走同源策略
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) d = await r.json();
    } catch (e) { /* 预期内：CORS */ }
    // ② 统一代理池（jina 偶尔会慢到十几秒，给足时间；它仍是国内唯一能直连的中转）
    if (!d) {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P === 'function') {
        try {
          const t = await P(url, { timeout: 22000, check: b => String(b).indexOf('"data"') >= 0 });
          d = takeJSON(t);
        } catch (e) { /* 落到下面 */ }
      }
    }
    /* ③ 失败时用旧值顶上（最多 10 分钟）。
     * 为什么必须有这一层：VIX 只有 CBOE 一个可靠源，而浏览器里它必须过代理。
     * 代理抖一次，面板就变成「-- 失败」，可实际上 15 分钟前的 -17.4% 仍然是对的
     * （CBOE 本身就是延迟 15 分钟的报价）。显示陈价 + 标注，比显示「失败」有用得多。 */
    if (!d) {
      if (hit && Date.now() - hit.t < 10 * 60000) {
        status.cboe = 'stale';
        return hit.d;
      }
      status.cboe = 'fail';
      throw new Error('CBOE 不可达（直连被 CORS 拦、代理未通）');
    }
    status.cboe = 'ok';
    cache.set(url, { t: Date.now(), d });
    return d;
  }

  /** VIX 快照：日涨跌幅直接用官方给的，避免自算口径漂移 */
  async function cboeQuote() {
    const d = await cboeJSON(CBOE.q, 25000);
    const x = (d && d.data) || {};
    const price = +x.current_price;
    if (!(price > 0)) throw new Error('CBOE 无有效报价');
    const prev = +x.prev_day_close || (price - (+x.price_change || 0));
    if (!(prev > 0)) throw new Error('CBOE 缺昨收');
    return {
      price, prev,
      chg: price - prev,
      // 官方给了 price_change_percent，优先用；没给再自算
      pct: isFinite(+x.price_change_percent) ? +x.price_change_percent
        : (price - prev) / prev * 100,
      open: +x.open || 0, high: +x.high || 0, low: +x.low || 0,
      at: Date.now(), src: 'cboe',
      delayMin: 15,
    };
  }

  /** VIX 当日分钟序列（美东字面量 → 真实 UTC epoch） */
  async function cboeMinutes() {
    const [d, snap] = await Promise.all([
      cboeJSON(CBOE.intraday, 45000),
      cboeJSON(CBOE.q, 45000).catch(() => null),
    ]);
    const arr = (d && d.data) || [];
    const rows = [];
    for (const x of arr) {
      const c = x && x.price ? +x.price.close : 0;
      if (!(c > 0) || !x.datetime) continue;    // 开盘集合竞价那根给的是 0，扔掉
      rows.push({ dt: String(x.datetime), c, o: +x.price.open || c, h: +x.price.high || c, l: +x.price.low || c });
    }
    if (!rows.length) throw new Error('CBOE 无分钟线');

    /* 时区：datetime 是**美东本地时间**字面量。
     * 直接用固定 -5h 会在夏令时（EDT=-4h）错一小时，ageMin 就会误判成「休市」。
     * 用快照的 UTC 时间戳反推偏移，四舍五入到整小时（延迟 15 分钟不影响取整）：
     *   14:52Z − 09:37(当UTC解析) = 5h15m → round = 5 → EST ✓
     * 这样冬夏令时都自动对。 */
    const lastLocal = Date.parse(rows[rows.length - 1].dt + 'Z');
    const snapUTC = snap && snap.timestamp ? Date.parse(String(snap.timestamp).replace(' ', 'T') + 'Z') : NaN;
    let offH = 5;
    if (isFinite(snapUTC) && isFinite(lastLocal)) {
      const guess = Math.round((snapUTC - lastLocal) / 3600000);
      if (guess >= 3 && guess <= 6) offH = guess;
    }
    const offMs = offH * 3600000;
    return rows.map(r => {
      /* 【时区口径统一】全站时间轴约定是「北京时间墙上时间装进 UTC 分量」
       * （见 tMin 注释：Date.UTC 直接吃北京时间字面量）。
       * 这里 CBOE 给的是美东本地时间，先 +offH 变 UTC，再 +8h 才是北京 ——
       * 之前只做了 ET→UTC，于是 VIX 分时显示成 17:xx（UTC），
       * 和别的品种差 8 小时（用户：分时左上角时间看着很乱）。 */
      const t = Math.floor((Date.parse(r.dt + 'Z') + offMs) / 60000) * 60 + 8 * 3600;
      return { time: t, open: r.o, high: r.h, low: r.l, close: r.c, volume: 0 };
    }).filter(p => isFinite(p.time));
  }

  /** VIX 日线（详情页日K / 长周期） */
  async function cboeDaily(limit) {
    const d = await cboeJSON(CBOE.daily, 6 * 3600e3);
    const arr = (d && d.data) || [];
    const out = [];
    for (const x of arr) {
      const c = +x.close;
      if (!(c > 0) || !x.date) continue;
      out.push({
        time: tDay(String(x.date)),
        open: +x.open || c, high: +x.high || c, low: +x.low || c, close: c,
        volume: +x.volume || 0,
      });
    }
    if (!out.length) throw new Error('CBOE 无日线');
    // 当天的日线还没生成，用盘中快照补一根，否则图上少了最新一天
    try {
      const q = await cboeQuote();
      const today = tDay(new Date().toISOString().slice(0, 10));
      const last = out[out.length - 1];
      if (last.time < today) {
        out.push({ time: today, open: q.open || q.price, high: q.high || q.price, low: q.low || q.price, close: q.price, volume: 0 });
      } else {
        last.close = q.price;
        last.high = Math.max(last.high, q.price);
        last.low = Math.min(last.low, q.price);
      }
    } catch (e) { /* 快照失败不影响日线 */ }
    return out.slice(-(limit || 260));
  }

  /* ---------------- 对外统一接口 ---------------- */

  /* v166：K 线放开到全历史。之前 {d:260,w:160,m:84}＝日K只有一年，
   * 用户要「从有行情那天起到今天」。东财 kline 接口 lmt 给大值即可（end=20500101）；
   * Yahoo 的 range 也从 1y/5y/10y 改成 max。 */
  const LIMIT = { d: 9000, w: 3000, m: 1500 };

  /* v301【全品种 Yahoo 兜底 · 东财被封/无历史时】把 universe key 映射成 Yahoo 符号。
   * 实测本机东财全线被掐后，Yahoo chart 对 A股/港股/美股/日股/韩股/台股/指数/外汇/
   * 美债收益率/商品/海外期指全部可用 —— 这是「任何源失败自动换源」的核心备用路。 */
  function yahooSymbolFor(key, a) {
    if (a && a.yh) return a.yh;
    if (a && a.sym && a.src === 'yahoo') return a.sym;
    const k = String(key || '');
    /* 显式映射表（指数/外汇/美债/商品/期指） */
    const MAP = {
      SPX: '^GSPC', IXIC: '^IXIC', DJI: '^DJI', HSI: '^HSI', N225: '^N225', KOSPI: '^KS11', TWSE: '^TWII',
      USDCNH: 'CNH=X', USDJPY: 'JPY=X', EURUSD: 'EURUSD=X', DXY: 'DX-Y.NYB',
      US10Y: '^TNX', US30Y: '^TYX', US5Y: '^FVX',
      /* US2Y：^IRX 是 13 周国库券，不是 2 年期 —— 宁可不出也不冒充 */
      WTI: 'CL=F', BRENT: 'BZ=F', GOLD: 'GC=F', SILVER: 'SI=F', COPPER: 'HG=F', NG: 'NG=F',
      ES: 'ES=F', NQ: 'NQ=F', YM: 'YM=F', NK: 'NKD=F', A50: 'XIN9.FGI',
      IF: null, IH: null, IC: null, IM: null, TL: null, T: null, TF: null, TS: null
    };
    if (Object.prototype.hasOwnProperty.call(MAP, k)) return MAP[k];
    /* 代码型 */
    /* v309：韩股 6 位（005930）必须先判，否则被当成 A 股深市 005930.SZ（实测 404） */
    if (a && a.grp === 'krstock' && /^\d{6}$/.test(k)) return k + '.KS';
    if (/^\d{6}$/.test(k)) {                       // A股：6/9 开头沪，其余深
      return (k[0] === '6' || k[0] === '9') ? k + '.SS' : k + '.SZ';
    }
    if (/^\d{5}$/.test(k)) return k.replace(/^0+/, '').padStart(4, '0') + '.HK';  // 港股 5 位
    if (/^\d{4}$/.test(k)) {
      const a2 = a || {};
      if (a2.grp === 'twstock') return k + '.TW';
      if (a2.grp === 'jpstock') return k + '.T';
      return k + '.T';
    }
    if (/^\d{6}$/.test(k) && a && a.grp === 'krstock') return k + '.KS';
    if (/^[A-Z.]{1,6}$/.test(k)) return k;         // 美股 ticker
    return null;
  }

  /* v302【Yahoo 美债收益率缩放】^TNX/^TYX/^FVX/^IRX 返回的是「收益率×10」
   * （4.3% 返回 43.0）。这里统一 /10，与东财/CNBC 口径对齐。 */
  /* v330：^TNX/^TYX/^FVX/^IRX 的口径分两代：旧版 Yahoo 回 49.6（百分数×10），
   * 现在回 4.96（已是百分数）。固定 ×0.1 会把 5Y 收益率画成 0.496，再和报价的
   * 4.960 拼出「全天 -89.97%」的假跌幅与一条贴底直线（美债5Y 实测）。
   * 改为按序列中位数量级判定，两代口径都正确。 */
  function yahooUnit(ys, pts) {
    if (!/^\^(TNX|TYX|FVX|IRX)$/.test(String(ys || ''))) return 1;
    const arr = pts || [];
    const mid = arr.length ? arr[Math.floor(arr.length / 2)].close : 0;
    return (mid > 20) ? 0.1 : 1;
  }
  function yahooScale(pts, ys) {
    const f = yahooUnit(ys, pts);
    if (!pts || !pts.length || f === 1) return pts;
    return pts.map(p => ({
      time: p.time, volume: p.volume || 0,
      open: p.open * f, high: p.high * f, low: p.low * f, close: p.close * f
    }));
  }

  /* v308【K线不卡死】emHistJSON 会串行试 2 个东财域名 + 代理，最坏 27s；
   * 给它 4 秒硬闸，超时立即进并行兜底，别让自检/页面白等。 */
  function klineFast(p, ms) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('em kline slow')), ms || 4000))
    ]);
  }

  /* v327：把跨日分时裁到「最近一场」。时间轴约定是「北京墙上时间装进 UTC 分量」，
   * 真实时刻 = time*1000 - 8h；再按品种交易所时区取日期，才和 Yahoo 的交易日对齐。
   * 只保留最后一天；若该天点数过少（<5，说明刚开盘或只有一两笔），退回原序列不动。 */
  function trimToLatestSession(pts, a) {
    try {
      const type = a.sess || (U.GROUPS[a.grp] && U.GROUPS[a.grp].session) || 'cn';
      const cfg = (w.Session && w.Session.SESSIONS) ? w.Session.SESSIONS[type] : null;
      const tz = (cfg && cfg.tz) || 'America/New_York';
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      const days = pts.map(p => fmt.format(new Date(p.time * 1000 - 8 * 3600e3)));
      const latest = days[days.length - 1];
      const out = pts.filter((p, i) => days[i] === latest);
      return out.length >= 5 ? out : pts;
    } catch (e) { return pts; }
  }

  /* v324【回滚 v322/v323】撤掉「今日K补根」整套逻辑：日K完全以原生K线源
   * （东财/腾讯/新浪/Yahoo/CBOE）为准，上游给到哪根就显示到哪根，
   * 不再用报价/分时拼当日K线（用户口径：以能获取K线为主，重绘是没办法的办法）。 */
  async function candles(key, mode) {
    const a = U.get(key);
    if (!a) throw new Error('unknown asset ' + key);
    const m = LIMIT[mode] || 200;
    try {
      let pts;
      /* v311【国内 ETF 期权日K】新浪去前缀（用户修正）→ 东财 10. 段兜底；
       * 本机新浪 data:null、东财被封，模拟器东财通道若通则直接出图。 */
      if (a && a.src === 'sinaopt') {
        try {
          const sd = await sinaOptionDaily(a.opSina || key, m);
          if (sd.length >= 5) return finalize({ points: dedupe(sd), synthetic: false, src: 'sina' });
        } catch (e) { /* 落东财 */ }
        try {
          const num = String(a.opSina || key).replace(/^CON_OP_/, '');
          const ep = await klineFast(emKline('10.' + num, 101, m, 1), 4000);
          if (ep && ep.length >= 5) return finalize({ points: dedupe(ep), synthetic: false, src: 'em' });
        } catch (e) { /* 如实失败 */ }
      }
      /* v311【美股期权日K 硬直达】动态 OCC 合约此前落 em 只回 1 根；
       * 直接打 Yahoo v8 chart 1d/6mo 有 34 根。期权新挂牌寿命短，门槛 ≥5 根。 */
      if (a && a.src === 'yahoo' && a.grp === 'option') {
        const oy = await yahooBars(a.sym || key, '1d', '6mo');
        const op = yahooScale(oy && oy.points, a.sym || key);
        if (op && op.length >= 5) {
          return finalize({ points: dedupe(op), synthetic: false, src: 'yahoo' });
        }
      }
      /* v311【新浪外盘日K】A50 2594 根（2016 起）；CL/GC/NG/HG 同接口。
       * v312 修 TDZ：此处不能引用 dk（其 const 声明在后面的 v309 直达块，会抛
       * "Cannot access 'dk' before initialization" 打断整条 K 线链）。 */
      if (RT_OVERRIDE[key] && RT_OVERRIDE[key].t === 'sinag') {
        const gd = await sinaGlobalDaily(RT_OVERRIDE[key].sym.replace(/^hf_/, ''), m);
        if (gd.length >= 20) return finalize({ points: dedupe(toMode(gd, mode, m)), synthetic: false, src: 'sina' });
      }
      /* v309【K线直达】主源一次命中，不再先撞东财 4 秒 */
      const dk = directKind(a, key);
      const ivd = mode === 'd' ? '1d' : mode === 'w' ? '1wk' : '1mo';
      try {
        if (dk === 'sinafut') {
          const sk = await sinaFutDaily(key, a, m);
          if (sk.length >= 20) return finalize({ points: dedupe(toMode(sk, mode, m)), synthetic: false, src: 'sina' });
        }
        if (dk === 'tencent') {
          const tc = txStockCode(key);
          if (tc) {
            const tp = await txDaily(tc, m);
            if (tp.length >= 20) return finalize({ points: dedupe(toMode(tp, mode, m)), synthetic: false, src: 'tencent' });
          }
        }
        if (dk === 'sinafx') {
          const fx = await sinaFxDaily(key, a, m);
          if (fx.length >= 20) return finalize({ points: dedupe(toMode(fx, mode, m)), synthetic: false, src: 'sina' });
        }
        if (dk === 'cnbc') {
          /* v310：CNBC bars 首选；本机 404 → 美国财政部官方日频收益率曲线（真实 2Y/10Y/30Y） */
          try {
            const cb = await cnbcBars(a.cnbc || key, '1D', '1Y');
            if (cb.length >= 20) return finalize({ points: dedupe(toMode(cb, mode, m)), synthetic: false, src: 'cnbc' });
          } catch (e) { /* 落财政部 */ }
          /* v334【美债日K补今日根】财政部官方曲线是 T+1（只有收盘、开高低全等，
           * 图上呈点状，且当天那根缺失）。Yahoo ^TNX/^FVX/^TYX 日K含当日进行中
           * 的一根、开高低齐全，优先用它；取不到再退财政部（真实但延迟一天）。 */
          if (/^US(2|10|30)Y$/.test(key)) {
            const ysd2 = yahooSymbolFor(key, a);
            if (ysd2) {
              try {
                const y = await yahooBars(ysd2, '1d', 'epoch');
                const p = yahooScale(y && y.points, ysd2);
                if (p && p.length >= 20) {
                  return finalize({ points: dedupe(toMode(p, mode, m)), synthetic: false, src: 'yahoo' });
                }
              } catch (e) { /* 落财政部 */ }
            }
          }
          /* 财政部曲线是美国国债：只对美债 2Y/10Y/30Y 用，绝不冒充中债 */
          if (/^US(2|10|30)Y$/.test(key)) {
            try {
              const td = await treasuryDaily(key, m);
              if (td.length >= 20) return finalize({ points: dedupe(toMode(td, mode, m)), synthetic: false, src: 'treasury' });
            } catch (e) { /* 落 Yahoo */ }
          }
        }
        if (dk === 'yahoo' || dk === 'cnbc' || dk === 'sinafx') {
          const ysd = yahooSymbolFor(key, a);
          if (ysd) {
            /* v310：期权合约（OCC）对 epoch 模式只回 1 根，改用 range=6mo（实测 34 根）*/
            const yRange = (a && a.grp === 'option') ? (mode === 'd' ? '6mo' : '1mo') : 'epoch';
            const y = await yahooBars(ysd, ivd, yRange);
            const p = yahooScale(y && y.points, ysd);
            if (p && p.length >= 20) return finalize({ points: dedupe(p), synthetic: false, src: 'yahoo' });
          }
        }
      } catch (eD) { /* 落原链路兜底 */ }
      if (a.src === 'cboe') {
        // CBOE 只给日线，周/月直接在客户端聚合，不额外打接口
        const daily = await cboeDaily(1400);
        pts = mode === 'd' ? daily.slice(-m) : aggregate(daily, mode).slice(-m);
      } else if (a.src === 'yahoo') {
        const iv = mode === 'd' ? '1d' : mode === 'w' ? '1wk' : '1mo';
        const y = await yahooBars(a.sym, iv, 'epoch');   // v166：全历史（见 yahooChart 注释）
        pts = y.points.slice(-m);
      } else if (a.src === 'binance') {
        pts = shift(await bnKline(a.sym, BN_IV[mode] || '1d', m), 28800); // 币安是 UTC，统一成北京时区分量
      } else {
        const klt = mode === 'd' ? 101 : mode === 'w' ? 102 : 103;
        pts = await klineFast(emKline(a.secid, klt, m, 1), 4000);
        if (!klineValid(pts)) {
          const raw = await klineFast(emKline(a.secid, klt, m, 0), 4000);
          if (raw.length && klineValid(raw)) pts = raw;
          else pts = pts.filter(p => p.close > 0 && p.low > 0);
        }
        /* v166：东财对部分海外品种历史特别短 —— 实测（lmt=9000 全量拉取）：
         *   251.SOX 费半只有 89 根（2026-07 起）、105.PLTR 488 根（2024-11 起）。
         * 按「官方优先、够长才用」的顺序补：① Nasdaq historical（国内可达）
         * ② Yahoo（国内一般不通，留作海外网络下的兜底）。谁长用谁。 */
        const need = mode === 'd' ? 1200 : mode === 'w' ? 260 : 60;
        if (pts.length < need && a.ndq) {
          try {
            const rows = await nasdaqHistorical(a.ndq.sym, a.ndq.cls);
            if (rows.length > pts.length) {
              pts = mode === 'd' ? rows : aggregate(rows, mode);
            }
          } catch (e) { /* 取不到就维持东财那段 */ }
        }
        if (pts.length < need && a.yh) {
          try {
            const iv = mode === 'd' ? '1d' : mode === 'w' ? '1wk' : '1mo';
            const y = await yahooBars(a.yh, iv, 'epoch');
            if (y && y.points.length > pts.length) pts = y.points;
          } catch (e) { /* 拿不到就维持现有那段 */ }
        }
        pts = pts.slice(-m);
        /* v308：东财偶发只给几根（688825 实测只给 5 根，而腾讯/新浪/Yahoo 都有 74 根），
         * 不能当成功返回 —— 主动抛错进并行兜底，拿足历史再画。 */
        if (pts.length < 20) throw new Error('em kline too few ' + pts.length);
        /* 外盘商品的日 K 也来自东财（延时 10 分钟），最后一根是「今日进行中」的那根，
         * 收盘价会比分时末价晚 10 分钟 —— 用新浪的实时末价补一下，两边对得上。
         * 只补最后一根（历史 K 不受影响）。 */
        if (a.rt === 'tx' && mode === 'd' && pts.length) {
          try {
            const r = await sinaFut(sinaSymOf(key), a.pxScale || 1);
            const last = r.points[r.points.length - 1];
            if (last) {
              const b = pts[pts.length - 1];
              b.close = last.close;
              b.high = Math.max(b.high, last.close);
              b.low = Math.min(b.low, last.close);
            }
          } catch (e) { /* 拿不到就维持东财那根 */ }
        }
      }
      if (!pts.length) throw new Error('empty');
      return finalize({ points: dedupe(pts), synthetic: false, src: a.src === 'binance' ? 'binance' : 'em' });
    } catch (e) {
      /* v284：东财 kline 挂了 → 腾讯日K 补一次（实测 A股/港股给满 320 天；
       * 美股/韩股只给当日 1 根，1 根画不出历史，所以 <20 根就当没有）。
       * 再不行才如实报「取数失败」，绝不合成假 K 线。 */
      /* v308【并行竞速兜底】新浪期货 / 腾讯 / Yahoo 同时打，谁先给够 20 根用谁；
       * 原来串行三层各 9s，手机端必然被 10s 超时掐断（v307 矩阵 K线 19 个 timeout 即此）。 */
      const iv = mode === 'd' ? '1d' : mode === 'w' ? '1wk' : '1mo';
      const tasks = [];
      const wrap = (pr, src) => pr.then(p => {
        if (p && p.length >= 20) return { p: p, src: src };
        throw new Error(src + ' too few');
      }).catch(() => { throw new Error(src + ' fail'); });
      /* v312：币安全挂 → OKX 兜底（BTC/SOL 日K 200 根实测） */
      if (a && a.src === 'binance' && mode === 'd') {
        const oi = okxInst(a.sym);
        if (oi) tasks.push(wrap(okxCandles(oi, '1D', m).then(ps => shift(ps, 28800)), 'okx'));
      }
      if (a && a.sinaf) tasks.push(wrap(sinaFutDaily(key, a, m), 'sina'));
      const code = txStockCode(key);
      if (code) tasks.push(wrap(txDaily(code, m), 'tencent'));
      const ys = yahooSymbolFor(key, a);
      if (ys) tasks.push(wrap(yahooBars(ys, iv, 'epoch').then(y => yahooScale(y && y.points, ys)), 'yahoo'));
      if (tasks.length) {
        try {
          const got = await Promise.any(tasks);
          return finalize({ points: dedupe(got.p.slice(-m)), synthetic: false, src: got.src });
        } catch (e4) { /* 全挂 */ }
      }
      return failedRes(e && e.message);
    }
  }

  /* ---------------- Nasdaq 官方：盘前 / 盘后分时 ----------------
   * 东财 trends2 对美股只给常规时段（北京 22:30–05:00 那一根），
   * 04:00–09:30 ET 的盘前、16:00–20:00 ET 的盘后**一点都没有** ——
   * 于是「美光盘前涨 8%」点进详情，分时图还是昨天收盘那条线，看不出盘前。
   * api.nasdaq.com 的 chart 接口返回当日全时段分钟点（实测第一点就是 4:00 AM ET），
   * NASDAQ 与 NYSE 正股都能取，是国内可直连的官方源。
   * 它不回 CORS 头，浏览器侧自动回退到同源代理 /__proxy。
   */
  const NASDAQ_Q = 'https://api.nasdaq.com/api/quote/';
  const nasdaqCache = new Map();
  /* 今天最后一次成功的原文（不设 60 秒上限）。中转两条同时失败时用它兜底：
   * 差几分钟的盘前曲线，远好于整段消失、退回「只有昨天常规时段」的分时图。 */
  const nasdaqLast = new Map();

  /* v236：从「夹了杂质的文本」里抠出第一个完整 JSON 对象。
   * 【2026-11-10 实测，盘前分时全站失效的真因】
   *   ① api.nasdaq.com 现在**不再回 Access-Control-Allow-Origin**（响应头实测没有），
   *      浏览器直连一律 TypeError: Failed to fetch —— 不是 403，连重试都没有意义；
   *   ② 只能走中转，但中转会把原文包一层：
   *        · microlink → `{...原文JSON...}</pre><div class="json-formatter-container"></div>`
   *        · jina      → 前面三行 `Title: / URL Source: / Markdown Content:`
   *   ③ 旧代码 `JSON.parse(text.slice(text.indexOf('{')))` 遇到尾巴上的
   *      `</pre><div ...>` 直接 SyntaxError → nasdaqChart 抛错 → 静默退回东财
   *      常规时段 → 图上还是「昨天的分时」，但按钮仍写着「盘前分时」并高亮，
   *      用户点与不点一个样（11-10 20:15 美光 / 英伟达两张截图）。
   * 这里按括号配对取到真正的结尾（跳过字符串内的括号与转义），再解析。 */
  function jsonSlice(text) {
    const s = String(text || '');
    const i = s.indexOf('{');
    if (i < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
      const ch = s[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (!depth) {
          try { return JSON.parse(s.slice(i, k + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /* 中转有缓存：microlink 实测回过「前一天 22:00」的快照（timeAsOf = Nov 9）。
   * 把昨天的盘前曲线当成今天画，比不画更糟，所以按 timeAsOf 的美东日期判新鲜。
   * 没给 timeAsOf（老格式）时按可用处理，不因为判据缺失就整条丢掉。 */
  function nqFresh(d) {
    const s = String((d && d.data && d.data.timeAsOf) || '');
    const m = s.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
    if (!m) return true;
    const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const mon = MON[m[1]];
    if (!mon) return true;
    const et = new Date(Date.now() + tzOffMin('America/New_York') * 60000);
    return et.getUTCFullYear() === +m[3] && (et.getUTCMonth() + 1) === mon && et.getUTCDate() === +m[2];
  }

  async function nasdaqChart(sym) {
    const target = `${NASDAQ_Q}${encodeURIComponent(sym)}/chart?assetclass=stocks`;
    const good = d => !!(d && d.data && d.data.chart && d.data.chart.length);
    let lastErr = null;

    /* ① 直连：Nasdaq 现已撤掉 CORS 头，正常网络下必失败（约 300ms 就报错，
     *    不拖首屏）。留着是因为 APK 壳的原生通道、以及哪天对方重新放开时能直接吃。 */
    try {
      const r = await fetch(target, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (good(d)) return d;
      throw new Error('no chart');
    } catch (e) { lastErr = e; }

    /* ② 中转：jina 立刻发；400ms 没回来就并行再拉代理池，谁先给出「当天且完整」
     *    的 chart 就用谁，另一条结果丢弃。实测 jina 单发 0.5~1s，代理池偶发 8~10s
     *    （microlink 通道要等它自己的超时），串行等会把冷启动拖到 10 秒以上。
     *    两条都按括号配对抠 JSON（jsonSlice），并用 nqFresh 挡掉隔夜快照。 */
    const viaJina = async () => {
      /* 5 秒硬超时：jina 平时 0.6~1s，偶发排队到 10s 以上（实测 INTC 9.9s）。
       * 超时就认输走代理池 / 东财兜底，不能让一条慢通道把详情页拖成白屏。 */
      const ac = (typeof AbortController === 'function') ? new AbortController() : null;
      const to = ac ? setTimeout(() => { try { ac.abort(); } catch (e) {} }, 5000) : 0;
      try {
        const r = await fetch('https://r.jina.ai/' + target,
          { cache: 'no-store', signal: ac ? ac.signal : undefined });
        if (!r.ok) throw new Error('jina HTTP ' + r.status);
        return jsonSlice(await r.text());
      } finally { if (to) clearTimeout(to); }
    };
    const viaPool = async () => {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') throw new Error('no proxy channel');
      return jsonSlice(await P(target, { timeout: 5000 }));
    };
    const raced = await new Promise((resolve) => {
      let done = false, pending = 2, timer = 0;
      const finish = (d) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(d || null);
      };
      const run = (fn) => {
        Promise.resolve().then(fn).then((d) => {
          if (done) return;
          if (good(d) && nqFresh(d)) return finish(d);
          if (good(d)) lastErr = new Error('stale snapshot (timeAsOf ' + (d.data.timeAsOf || '?') + ')');
          if (--pending === 0) finish(null);
        }).catch((e) => {
          lastErr = e;
          if (!done && --pending === 0) finish(null);
        });
      };
      run(viaJina);
      timer = setTimeout(() => run(viaPool), 400);
    });
    if (raced) {
      nasdaqLast.set(sym, raced);
      return raced;
    }
    /* 两条中转都没成（jina 限流 / 代理池只剩隔夜快照）时，用今天最后一次成功的
     * 副本兜底 —— 盘前曲线落后几分钟可以接受，整段消失不行。 */
    const keep = nasdaqLast.get(sym);
    if (keep && good(keep) && nqFresh(keep)) return keep;
    throw lastErr || new Error('nasdaq chart unavailable');
  }

  /* ---------------- Nasdaq 官方历史日线（长历史兜底） ----------------
   * 【为什么需要它】东财对部分海外标的的历史短得没法画图，实测（lmt=9000）：
   *   251.SOX 费城半导体只有 89 根（2026-07 起）、105.PLTR 只有 488 根（2024-11 起）。
   * 而 api.nasdaq.com 的 historical 接口给的是**官方全历史**：
   *   SOX（assetclass=index）= 8207 根，1995-01-02 起；PLTR = 1534 根，2020-09-30 起。
   * 同域名的 chart 接口本项目早就在用（盘前盘后分时），链路已验证国内可达，
   * 不回 CORS 头 → 直连失败走同源 /__proxy。
   * 注意：返回行的顺序**不固定**（SOX 升序、PLTR 降序，实测），必须自己按时间排；
   * 价格带 "$" 和千分位逗号，且早年 open/high/low 可能是 0.00，要用 close 补齐。 */
  async function nasdaqHistorical(sym, cls) {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const to = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const target = `${NASDAQ_Q}${encodeURIComponent(sym)}/historical?assetclass=${cls || 'stocks'}`
      + `&fromdate=1990-01-01&todate=${to}&limit=9999`;
    let d = null;
    try {
      const r = await fetch(target, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
    } catch (e) {
      const P = w.LiveNews && w.LiveNews.proxy;
      if (typeof P !== 'function') throw e;
      const t = await P(target, { timeout: 20000, check: b => String(b).indexOf('tradesTable') >= 0 });
      const cut = String(t).indexOf('{');
      if (cut < 0) throw new Error('bad proxy payload');
      d = JSON.parse(String(t).slice(cut));
    }
    const rows = ((d && d.data && d.data.tradesTable) || {}).rows || [];
    const num = v => {
      const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
      return isFinite(n) ? n : null;
    };
    const out = [];
    for (const r0 of rows) {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(r0.date || '').trim());
      if (!m) continue;
      const c = num(r0.close);
      if (!(c > 0)) continue;
      const o = num(r0.open), h = num(r0.high), l = num(r0.low);
      /* 【坑】Nasdaq 对「指数上线之前」的日期会**填充一条平线**：SOX 1990-01-01
       * 到 1994-05 全是 close 479.49、open/high/low 全 0.00 的假记录（实测 9512 行里
       * 前 1000 多行都是它）。这类行 OHLC 三值全 0，直接丢掉，否则图上会多出一段
       * 「1990 年就开始交易、四年一条横线」的假历史。 */
      if (!(o > 0) && !(h > 0) && !(l > 0)) continue;
      out.push({
        time: Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000,
        open: (o && o > 0) ? o : c,
        high: (h && h > 0) ? h : c,
        low: (l && l > 0) ? l : c,
        close: c,
        volume: num(r0.volume) || 0
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** 某时区当前相对 UTC 的分钟偏移（ET 冬令时 -300 / 夏令时 -240，北京 +480） */
  function tzOffMin(tz) {
    try {
      const d = new Date();
      const s = d.toLocaleString('sv-SE', { timeZone: tz });   // "2026-11-06 06:35:00"
      const asUTC = Date.parse(s.replace(' ', 'T') + 'Z');
      if (!isFinite(asUTC)) return 0;
      return Math.round((asUTC - d.getTime()) / 60000);
    } catch (e) { return 0; }
  }

  /** 台股分钟线（钜亨 cnyes 为主，Yahoo 兜底）。
   *  【为什么必须换源】东财对台股 `trends2` / `kline?klt=1` 返回的是**假数据**：
   *  实测 2330 返回 361 个点，取值只有 2 个 —— 09:00~14:59 全是昨收 2240，
   *  最后一根才跳到收盘价 2135，成交量全 0。画出来就是「一条平线 + 一根垂直跳水」，
   *  用户报的「台股不管盘前盘后盘中都是一条直线」根因就在这里。
   *  Yahoo `{code}.TW` 本来是第一选择，但国内直连基本 403 / 连不上（实测代理取回 403）。
   *  改用钜亨 cnyes 的 charting history：真实逐分钟「开高低收 + 成交量」，
   *  实测 2330 一天 260 根（09:00–13:30 台北），数值 2020→2135 真实波动。
   *  它不回 CORS 头，所以直连失败后走 w.LiveNews.proxy（同源 /__proxy）。 */
  const TW_CHART = 'https://ws.api.cnyes.com/ws/api/v1/charting/history';

  /* 取数通道（按顺序试，成功一个就记住）。
   * 为什么要在前端自己排通道：部署沙箱的出口只放行少数域名
   * （实测 东财/GitHub 通，google / r.jina.ai / cnyes / twse 全部超时），
   * 所以 /__proxy 在线上拿不到台湾站点数据；只能由**用户浏览器**去取。
   * cnyes 不回 CORS 头 → 必须经中转。 */
  const TW_CHANNELS = ['local', 'jina', 'allorigins', 'codetabs'];
  let twChan = '';        // 本次会话已经验证可用的通道
  const twCache = new Map();

  function b64url(s) {
    try { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    catch (e) { return ''; }
  }

  function twChanURL(ch, url) {
    if (ch === 'local') return HAS_BACKEND
      ? '/__proxy/' + Date.now().toString(36) + '/' + b64url(url) : '';
    if (ch === 'jina') return 'https://r.jina.ai/' + url;
    if (ch === 'allorigins') return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    if (ch === 'codetabs') return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url);
    return '';
  }

  async function twFetchText(url, ms) {
    const order = twChan ? [twChan].concat(TW_CHANNELS.filter(c => c !== twChan)) : TW_CHANNELS.slice();
    for (const ch of order) {
      const u = twChanURL(ch, url);
      if (!u) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms || 9000);
      try {
        const r = await fetch(u, { signal: ctrl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const t = await r.text();
        if (t.indexOf('"data"') < 0) throw new Error('bad payload');
        twChan = ch;
        return t;
      } catch (e) { /* 换下一个通道 */ }
      finally { clearTimeout(timer); }
    }
    return '';
  }

  async function twCnyesMinutes(code) {
    const hit = twCache.get(code);
    if (hit && Date.now() - hit.t < 60000) return hit.pts;
    const now = Math.floor(Date.now() / 1000);
    /* 取 4 天窗口：跨周末/长假也能拿到最近一个交易日 */
    const url = TW_CHART + '?resolution=1&symbol=TWS:' + encodeURIComponent(code) + ':STOCK'
      + '&from=' + (now - 4 * 86400) + '&to=' + now;
    let txt = '';
    try { txt = await twFetchText(url, 9000); } catch (e) { txt = ''; }
    if (!txt) return null;
    const cut = String(txt).indexOf('{');
    if (cut < 0) return null;
    let d = null;
    try { d = JSON.parse(String(txt).slice(cut)); } catch (e) { return null; }
    const dd = d && d.data;
    if (!dd || !dd.t || !dd.c || dd.t.length < 20) return null;
    const rows = [];
    for (let i = 0; i < dd.t.length; i++) {
      const c = +dd.c[i];
      if (!isFinite(c) || c <= 0) continue;
      /* cnyes 的 t 是真实 UTC 秒；图表的 time 口径是「当地墙上时间当作 UTC」
       * （见 tMin：东财 "2026-11-06 09:00" → 09:00Z）。台北 = UTC+8，故 +8h。 */
      rows.push({
        time: dd.t[i] + 28800,
        open: +dd.o[i] || c,
        high: +dd.h[i] || c,
        low: +dd.l[i] || c,
        close: c,
        volume: +dd.v[i] || 0
      });
    }
    if (rows.length < 20) return null;
    rows.sort((a, b) => a.time - b.time);
    /* 只留最后一个交易日：窗口跨了几天，混在一起图上会出现断层 */
    const lastDay = Math.floor(rows[rows.length - 1].time / 86400);
    const pts = rows.filter(r => Math.floor(r.time / 86400) === lastDay);
    if (pts.length < 20) return null;
    twCache.set(code, { t: Date.now(), pts });
    return pts;
  }

  async function twMinutes(key) {
    const code = String(key || '').replace(/\.(TW|TWO)$/i, '');
    let pts = null, nm = '';
    try { pts = await twCnyesMinutes(code); } catch (e) { pts = null; }
    if (!pts || pts.length < 20) {
      for (const sym of [code + '.TW', code + '.TWO']) {
        try {
          const y = await yahooBars(sym, '1m', '1d');
          if (y && y.points.length >= 20) {
            return { points: y.points, preClose: y.prevClose || y.points[0].close, name: y.name || '' };
          }
        } catch (e) { /* 试下一个后缀 */ }
      }
      return null;
    }
    /* 昨收：cnyes 这段接口不带，单取东财 f60（*100 定点）当基准，
     * 图表靠它画 0% 基准线和涨跌幅着色，不能缺 */
    let prev = 0;
    try {
      const q = await getJSON(`${EM_GET}?secid=${encodeURIComponent('178.' + code)}&fields=f58,f60&ut=${EM_UT}`, 60000, 'em');
      const qd = (q && q.data) || {};
      const v = qd.f60;
      if (v) prev = +v / 100;
      if (qd.f58) nm = String(qd.f58);
    } catch (e) {}
    return { points: pts, preClose: prev || pts[0].close, name: nm };
  }

  /** 盘前 + 常规 + 盘后 的完整分钟序列（美股正股 / ETF）。
   *  返回 ext:true 表示「这条曲线是含延展时段的」，图表会标注出来。 */
  async function nasdaqMinutes(sym) {
    const hit = nasdaqCache.get(sym);
    if (hit && Date.now() - hit.t < 60000) return hit.d;
    const d = await nasdaqChart(sym);
    const rows = (d && d.data && d.data.chart) || [];
    /* 【时区】Nasdaq 的 x 虽然是毫秒时间戳，但它的 UTC 分量装的是**美东墙上时间**
     * （实测盘前第一点 04:00 ET 的时间戳解出来就是 04:00Z，而现在 06:35 ET 的点
     * 解出来是 06:35Z）。直接 +8 小时会得到 12:00 —— 比真正的北京时间早 5 小时。
     * 正确做法：先还原成真实 UTC（减去 ET 偏移），再换成北京时间，
     * 也就是整体 +（北京偏移 − ET 偏移）= 冬令时 13h / 夏令时 12h。
     * 用 Intl 现算，避免写死 DST。 */
    const shiftMin = tzOffMin('Asia/Shanghai') - tzOffMin('America/New_York');
    const byT = new Map();
    /* 【分段】要分辨「盘前 / 常规 / 盘后」，最稳的是用**原始美东分钟数**判断，
     * 而不是事后拿北京时间去反推（夏令时切换会差一小时）。
     * p.x 的 UTC 分量装的正是美东墙上时间，取模 1440 直接得到当天第几分钟：
     *   04:00–09:30 ET → pre，09:30–16:00 → reg，16:00–20:00 → post。 */
    for (const p of rows) {
      const v = Number(p.y);
      if (!isFinite(v) || v <= 0) continue;
      const t = Math.floor((p.x / 1000 + shiftMin * 60) / 60) * 60;
      const etMin = Math.floor((p.x / 60000) % 1440);
      const seg = etMin < 570 ? 'pre' : etMin < 960 ? 'reg' : 'post';
      byT.set(t, { v: v, seg: seg });
    }
    const pts = Array.from(byT.entries()).sort((a, b) => a[0] - b[0])
      .map(([t, o]) => ({ time: t, open: o.v, high: o.v, low: o.v, close: o.v, volume: 0, seg: o.seg }));
    /* 昨收：Nasdaq 的 previousClose 在盘前给的是「前前一日」收盘（实测 795.23，
     * 而盘前相对的是昨天 656.39），不能直接用；用 lastSale - netChange 最稳。 */
    const num = s => Number(String(s == null ? '' : s).replace(/[$,+\s]/g, ''));
    const last = num(d && d.data && d.data.lastSalePrice);
    const chg = num(d && d.data && d.data.netChange);
    const preClose = (isFinite(last) && isFinite(chg)) ? last - chg : 0;
    /* 常规收盘价 = 官方收盘（Nasdaq 的 lastSalePrice，收盘后就是当日常规收盘 690.00）。
     * 不能用「最后一根常规分钟」的收盘（689.43），那是 15:59 的价，比集合竞价收盘低，
     * 拿它当分母会把盘后算成 +0.78%，而富途/CNBC 都是 +0.69%。盘前时段 lastSalePrice
     * 已经是盘前价，不能用，退回最后一根常规分钟。 */
    let regClose = 0;
    for (const p of pts) if (p.seg === 'reg') regClose = p.close;
    const lastSeg = pts.length ? pts[pts.length - 1].seg : '';
    if (lastSeg === 'post' && isFinite(last) && last > 0) regClose = last;
    const out = { points: pts, preClose: preClose, regClose: regClose || preClose };
    nasdaqCache.set(sym, { t: Date.now(), d: out });
    return out;
  }

  async function intradayRaw(key) {
    const a = U.get(key);
    /* v309【分时直达】不等东财 trends2，按品类第一主源直接出图 */
    try {
      const dk = directKind(a, key);
      if (a && key === 'A50') {
        const gm = await sinaGlobalMin('CHA50CFD');
        if (gm && gm.length > 10) {
          return { points: gm, preClose: (cachedQuote(key) || {}).prev || gm[0].close,
            synthetic: false, src: 'sina' };
        }
      }
      if (a && dk === 'sinag' && RT_OVERRIDE[key]) {
        const gm = await sinaGlobalMin(RT_OVERRIDE[key].sym.replace(/^hf_/, ''));
        if (gm && gm.length > 10) {
          return { points: gm, preClose: (cachedQuote(key) || {}).prev || gm[0].close,
            synthetic: false, src: 'sina' };
        }
      }
      if (a && dk === 'sinafut') {
        const mp = await sinaFutMin(key, a);
        if (mp && mp.length > 10) {
          return { points: mp, preClose: (cachedQuote(key) || {}).prev || mp[0].close,
            synthetic: false, src: 'sina' };
        }
      }
      if (a && dk === 'sinaopt') {
        const om = await sinaOptionMin(a.opSina || key);
        if (om && om.length > 10) {
          return { points: om, preClose: (cachedQuote(key) || {}).prev || om[0].close,
            synthetic: false, src: 'sinaopt' };
        }
      }
      if (a && dk === 'cnbc') {
        /* v310：用户指定的 CNBC bars 首选（本机 404 时快速落 Yahoo） */
        try {
          const cb = await cnbcBars(a.cnbc || key, '1M', '1D');
          if (cb.length > 10) {
            return { points: cb, preClose: (cachedQuote(key) || {}).prev || cb[0].close,
              synthetic: false, src: 'cnbc' };
          }
        } catch (e) { /* 落 Yahoo */ }
      }
      if (a && (dk === 'yahoo' || dk === 'cnbc' || dk === 'sinafx')) {
        const ys = yahooSymbolFor(key, a);
        if (ys) {
          /* v327【单日分时】Yahoo 5m 必须取 5d 才能拿到当天完整序列（1d 在盘前只回几根），
           * 但它会把**最近 5 个交易日连成一条**（标普500 实测 11-09~11-13 各 78 根），
           * 用户看到的横轴 12:00→14:00→09:3x 就是跨日拼接。这里按交易所时区
           * 只保留「今天」那一场；今天还没开盘（凌晨 0-4 点 ET）时保留最近一场。
           * 之后图表自带 whitespace 补到收盘，于是最左=开盘、最右=收盘。 */
          const yb = await yahooBars(ys, '5m', '5d', true);
          let pts = yahooScale(yb && yb.points, ys);
          /* v330：单日裁剪扩到外汇/美债 —— 这三类此前同样把 5 天拼成一条
           * （用户实测「外汇分时都是连续的」）。 */
          if (pts && pts.length > 15 &&
              (a.grp === 'us' || a.grp === 'fx' || a.grp === 'rate')) {
            pts = trimToLatestSession(pts, a);
          }
          if (pts && pts.length > 15) {
            /* v329：昨收优先用实时报价的 prev（与头部涨跌幅同源同口径）。
             * Yahoo meta 的 chartPreviousClose 实测是**更早一天**的收盘
             * （11-13 盘中给 7376.86，而 11-12 收盘是 7592.40），
             * 拿它当分母会算出「全天 +2.15%」和头部 -0.79% 打架。 */
            const q0 = cachedQuote(key) || {};
            return { points: pts, preClose: (q0.prev > 0 ? q0.prev : (yb.prevClose || pts[0].close)),
              synthetic: false, src: 'yahoo' };
          }
        }
      }
    } catch (e0) { /* 落原链路 */ }
    /* 未知品种也走「失败」返回而不是抛错：调用方（缩略图队列）是 fire-and-forget，
     * 抛出去会变成没人接的 Promise 异常，把整轮补图打断。 */
    if (!a) return failedRes('unknown asset ' + key);
    try {
      /* VIX：CBOE 延 15 分钟，报价和分时都改走 CNBC（真实时 + 1 分钟线）。
       * CNBC 偶尔抽风时退回 CBOE 那条（延 15 分钟，但仍是真数据），
       * 绝不能直接掉到合成曲线 —— 那是编的。 */
      if (a.rt === 'cnbc') {
        const sym = a.cnbcSym || cnbcSym(key, a);
        try {
          const r = await cnbcIntraday(sym);
          if (r.points.length) {
            /* 昨收优先用已经缓存好的报价，别再打一次 CNBC ——
             * 少一个请求就少一次空包/断流的机会（冷启动那个坑很致命）。 */
            let pre = r.points[0].close;
            const cq = cachedQuote(key);
            if (cq && cq.prev) pre = cq.prev;
            else {
              try { const q = await cnbcQuoteOne(sym); if (q.prev) pre = q.prev; } catch (e) {}
            }
            return { points: r.points, preClose: pre, synthetic: false, src: 'cnbc' };
          }
        } catch (e) { /* 落到下面走 CBOE */ }
        const cm = await cboeMinutes();
        let pre2 = cm[0].close;
        try { const q = await cboeQuote(); if (q.prev) pre2 = q.prev; } catch (e) {}
        return { points: cm, preClose: pre2, synthetic: false, src: 'cboe' };
      }
      /* 外盘商品：东财延 10 分钟，分时改走新浪（真实时，末点＝当前分钟） */
      if (a.rt === 'tx') {
        try {
          const r = await sinaFut(sinaSymOf(key), a.pxScale || 1);
          if (r.points.length) {
            if (a.sinaRoll) {
              const anc = (cache.get('anc:' + key) || {}).d;
              const last = r.points[r.points.length - 1];
              if (anc && anc.price && Math.abs(last.close - anc.price) / anc.price > 0.025) {
                resolveSinaRoll(key, anc.price);
              }
            }
            return { points: r.points, preClose: r.preClose || r.points[0].close, synthetic: false, src: 'sina' };
          }
        } catch (e) { /* 新浪抽风时退回东财（延 10 分钟，但仍是真数据） */ }
      }
      if (a.src === 'cboe') {
        const pts = await cboeMinutes();
        if (!pts.length) throw new Error('empty');
        const q = await cboeQuote();
        return { points: pts, preClose: q.prev || pts[0].close, synthetic: false, src: 'cboe' };
      }
      if (a.src === 'yahoo') {
        const y = await yahooBars(a.sym, '5m', '1d', true);
        if (!y.points.length) throw new Error('empty');
        return { points: y.points, preClose: y.prevClose || y.points[0].close, synthetic: false, src: 'yahoo' };
      }
      if (a.src === 'binance') {
        const pts = shift(await bnKline(a.sym, '5m', 288), 28800);
        if (!pts.length) throw new Error('empty');
        return { points: pts, preClose: pts[0].close, synthetic: false, src: 'binance' };
      }
      /* A股 / 港股（含指数与个股）：腾讯逐分钟，实测 200ms、CORS 开放。
       * 直接优先于东财：东财这条通道一挂就是 2×9 秒超时再失败，图要等 20 秒才空；
       * 腾讯不行时再落到下面的东财。 */
      if ((a.grp === 'cn' || a.grp === 'cnstock' || a.grp === 'hkstock' || a.sess === 'hk')
          && txStockCode(key)) {
        try {
          const sessCode = a.sess === 'hk' || a.grp === 'hkstock' ? 'hk' : 'cn';
          const tc = txStockCode(key);
          let r = null;
          try { r = await txMinute(tc, sessCode); } catch (e1) { r = null; }
          if (!r || r.points.length <= 30) {
            try { r = await txMkMinute(tc, sessCode); } catch (e2) { r = null; }
          }
          /* 腾讯两条都不通（常见于家庭宽带域名解析/封禁）→ 新浪 JSONP 分钟线。
           * 港股暂无同口径 JSONP，继续走下面的 Yahoo/其他兜底。 */
          if ((!r || r.points.length <= 30) && sessCode === 'cn') {
            try { r = await sinaCnMinute(tc, 5); } catch (e3) { r = null; }
          }
          if (r && r.points.length > 30) {
            return {
              points: r.points,
              preClose: r.prev || (cachedQuote(key) || {}).prev || r.points[0].close,
              synthetic: false,
              src: (r && r.srcTag) ? r.srcTag : 'tencent'
            };
          }
        } catch (e) { /* 落到东财 */ }
      }
      /* 美股正股 / ETF：先要「含盘前盘后」的完整曲线。
       * 失败就静默回退下面的东财常规时段 —— 宁可少一段盘前，也不能让图空着。
       * v146：动态合成的美股（SKHY 等）没有 extSym，但从 tv 符号（NASDAQ:SKHY）也能
       * 走纳斯达克官方分时拿到盘前盘后，所以这里用 extSym 或 tv 推导纳斯达克代码。 */
      if (a.grp === 'usstock' && a.kind === 'stock') {
        const nsym = a.extSym || (a.tv ? a.tv.split(':')[1] : null);
        if (nsym) {
          try {
            const n = await nasdaqMinutes(nsym);
            if (n.points.length) {
              /* v215【盘前分时形同虚设的真因】盘前时段 Nasdaq 的 chart 接口只返回
               * **今天**的点（04:00 ET → 现在），里面清一色 seg='pre'、一根 reg 都没有。
               * render 里「常规分时」拿不到 regPts 就退回 pts，「盘前分时」也退回 pts，
               * 两条路都变成同一条盘前线 —— 用户实测「点与不点一模一样」。
               * 修法：缺 reg 时用东财补上一交易日常规时段，拼成 reg(前) + pre(后)：
               *   · 常规分时 → 只看 reg（上一交易日走势）
               *   · 盘前分时 → reg + pre（价格连续，pre 段单独上蓝色）
               * 时间基准两套都是「北京墙上时间装进 UTC」，可直接按时间戳拼接。 */
              const hasReg = n.points.some(p => p.seg === 'reg');
              if (!hasReg) {
                try {
                  const r = await emTrend(a.secid, 1);
                  if (r.points.length) {
                    /* 成交量清零：美股个股的分时量本来就没有（Nasdaq chart 不给量），
                     * 拼进来之后点数从 391 涨到 650+，histogram 的 barSpacing 掉到
                     * 0.58px —— 柱子成了亚像素、看上去像一条贴底的空线（实测截图确认）。
                     * 与其给个「看着像坏了」的副图，不如保持美股分时无副图的原状；
                     * 日K 的量来自东财日线，不受影响。 */
                    const regPts = r.points.map(p => Object.assign({}, p, { seg: 'reg', volume: 0, amount: 0 }));
                    const prePts = n.points.filter(p => p.seg === 'pre');
                    const postPts = n.points.filter(p => p.seg === 'post');
                    const merged = regPts
                      .concat(prePts.length ? prePts : n.points.filter(p => p.seg !== 'reg'))
                      .concat(postPts);
                    merged.sort((x, y) => x.time - y.time);
                    return {
                      points: merged,
                      preClose: r.preClose || n.preClose || merged[0].close,
                      regClose: regPts[regPts.length - 1].close || n.preClose,
                      synthetic: false,
                      src: 'mixed',
                      ext: true
                    };
                  }
                } catch (e2) { /* 东财也拿不到就退回原样（只有盘前段） */ }
              }
              return {
                points: n.points,
                preClose: n.preClose || n.points[0].close,
                regClose: n.regClose || n.preClose,
                synthetic: false,
                src: 'nasdaq',
                ext: true
              };
            }
          } catch (e) { /* 回退东财 */ }
        }
      }
      /* 韩股 / 台股：东财 trends2 只含常规时段（实测 KRX 到 14:30 北京＝15:30 KST 常规收盘，
       * 不含盘后 15:00–17:00 北京）。盘前/盘后价从 TradingView 拿（scanner 给报价，CORS 开放）。
       * 关键修复（v147）：不再按「当前时段」门控合成 —— 只要 TV 的 pre/post 收盘与常规收盘
       * 有明显差值就合成对应段，段始终存在于数据里，「盘后分时」开关只是显示/隐藏
       * （与美股 Nasdaq 那套分段着色同一逻辑）。否则常规时段手动点「盘后分时」会因
       * tvExtFetch 返回空而仍是盘中图（即图2 韩股 SK海力士的 bug）。 */
      if ((a.grp === 'krstock' || a.grp === 'twstock') && a.tv) {
        /* v59：台股必须走 Yahoo 1m —— 东财台股分钟是「一条平线 + 最后一根跳水」的假数据
         * （见 twMinutes 注释）。韩股东财是真实逐分钟，保持原路不动。 */
        let r = null;
        if (a.grp === 'twstock') {
          try { r = await twMinutes(key); } catch (e) { r = null; }
        }
        if (!r || !r.points.length) r = await emTrend(a.secid, 1);
        if (!r.points.length) throw new Error('empty');
        /* v60：台股若只剩东财那条「全平 + 末点跳水」的假序列，宁可不画。
         * 判据：整条序列不同收盘价 ≤1 个，或成交量总和为 0 —— 真实盘中不可能这样。 */
        if (a.grp === 'twstock') {
          const uniq = new Set(r.points.map(p => p.close)).size;
          const vol = r.points.reduce((s, p) => s + (p.volume || 0), 0);
          if (uniq <= 1 || (vol === 0 && uniq <= 2)) throw new Error('tw-flat');
        }
        /* 自定义合成的台股只有代码没有名字，用 Yahoo 的 shortName 回填一次 */
        if (a._synth && r.name && (!a.name || a.name === key)) { a.name = r.name; a.short = r.name; }
        const regPts = r.points.map(p => Object.assign({}, p, { seg: 'reg' }));
        /* 常规收盘用分钟序列自己的最后一点，不再为了「合成盘后段」去多打一次 TV。
         * 盘后价由 S.ext（extQuotes/tvExtFetch）单独提供，两条路径互不依赖。 */
        const base = regPts[regPts.length - 1].close;
        const pts = regPts.slice();
        /* v63【不再为韩股/台股编造盘后分时】
         * 用户核图：韩股盘后那条「近乎 90 度的直线」到底对不对。核查结论：不对，而且
         * **无源可修** —— 2026-11-08 实测三个源：
         *   · 东财 trends2（177.000660）最后一点停在 14:30 北京＝15:30 KST 常规收盘；
         *   · Yahoo 000660.KS includePrePost=true 最后一点同样是 15:00 KST，没有盘后分钟；
         *   · TradingView 只给一个 postmarket_close（1,176,000），没有序列。
         * 因为 KRX 的 시간외단일가 和台股盤後定盤本身就是**定盘单一价撮合**，
         * 全天只有一个成交价，不存在逐笔走势。以前用「收盘价 → 盘后价」两个点连线，
         * 画出来的斜坡是编的：看着像盘后单边走 3.89%，实际只有一个成交价。
         *
         * 所以这里不再合成任何 pre/post 段：ext 恒为 false，开关也不出现，
         * 盘后价改在页面顶部（真实 TV 成交价）与「暗盘·链上」页呈现，
         * 分时页用一行说明讲清原因 —— 宁可不画，也不画假曲线。 */
        /* v65：韩股盘后接上 Nextrade 애프터마켓 的真实分钟（Naver fchart 源）。
         * 15:40–15:59 是收盘定价（单一价，标 auction），16:00–19:59 是连续成交。
         * 盘前 08:00–08:50 该源没有，所以 pre 段仍然为空 —— 有就有、没有就不画。 */
        let hasExt = false;
        if (a.grp === 'krstock') {
          try {
            const nx = await krNaverMinutes(key);
            if (nx && nx.points && nx.points.length) {
              const post = nx.points.filter(p => p.seg === 'post');
              if (post.length > 5) {
                const merged = pts.concat(post);
                return { points: merged, preClose: r.preClose, regClose: base, synthetic: false, src: 'mixed', ext: true };
              }
            }
          } catch (e) { /* 拿不到就保持常规分时 */ }
        }
        return { points: pts, preClose: r.preClose, regClose: base, synthetic: false, src: 'em', ext: hasExt };
      }
      /* v284：美股指数（标普 / 纳指 / 费半 / 道指）先走 CNBC 分钟线。
       * 见 cnbcIdxIntraday 注释：东财历史域名挂掉时，CNBC 这条仍是逐分钟真数据。 */
      if (a.grp === 'us' && a.kind === 'index' && CNBC_IDX[key] && a.rt !== 'cnbc') {
        try {
          const c = await cnbcIdxIntraday(CNBC_IDX[key]);
          if (c.points.length > 20) {
            /* 昨收必须是真的「上一交易日收盘」，不能拿首根当基准：
             * 标普首根 7593 而昨收 7520.93，拿首根算会把 +1.48% 写成 +0.66%。
             * 缓存里没有就用 CNBC 的 quick quote（last - change）补一次。 */
            let pre = (cachedQuote(key) || {}).prev;
            if (!pre) {
              try { pre = (await cnbcQuoteOne(CNBC_IDX[key])).prev; } catch (e) { pre = 0; }
            }
            return { points: c.points, preClose: pre || c.preClose || c.points[0].close, synthetic: false, src: 'cnbc' };
          }
        } catch (e) { /* CNBC 也不通 → 落到东财 */ }
      }
      const r = await emTrend(a.secid, 1);
      if (!r.points.length) throw new Error('empty');
      return { points: r.points, preClose: r.preClose, synthetic: false, src: 'em' };
    } catch (e) {
      /* v302【分时 Yahoo 兜底 · 用户点名缺口】东财 trends2 被掐 / 无该品种时，
       * 用 Yahoo 1 分钟线补上（日股 .T / 韩股 .KS / 台股 .TW / 期指 =F /
       * 美债 ^TNX / 外汇 =X 都能出分时）。≥15 点才用，绝不画两三个点的假线。 */
      /* v302：国内期货（IF/IH/IC/IM/TL/T/TF/TS）东财断 → 新浪分钟线 */
      try {
        if (a && a.sinaf) {
          const mp = await sinaFutMin(key, a);
          if (mp && mp.length > 10) {
            const q = cachedQuote(key) || {};
            return { points: mp, preClose: q.prev || mp[0].close, synthetic: false, src: 'sina' };
          }
        }
      } catch (e0) { /* 落 Yahoo */ }
      try {
        const ys = yahooSymbolFor(key, a);
        if (ys) {
          /* v332：外汇/美债的东财链路挂了会落这里，旧版用 1m/1d —— 时间戳是 UTC，
           * 图上显示 17:51（不是北京 01:51），且 1d 对 FX 是 UTC 日界，边界错位。
           * 统一 5m/5d + 北京时间 + 单日裁剪，与主分时分支同口径。 */
          const yb = await yahooBars(ys, '5m', '5d', true);
          let pts = yahooScale(yb && yb.points, ys);
          if (pts && pts.length >= 15 && a.grp !== 'crypto') {
            pts = trimToLatestSession(pts, a);
          }
          if (pts && pts.length >= 15) {
            const q0 = cachedQuote(key) || {};
            const prev = (q0.prev > 0 ? q0.prev : 0)
              || (yb.prevClose ? yb.prevClose * yahooUnit(ys, yb.points) : 0)
              || pts[0].close;
            return { points: pts, preClose: prev, synthetic: false, src: 'yahoo' };
          }
        }
      } catch (e2) { /* Yahoo 也不通就如实失败 */ }
      /* v284：不再编一条假曲线（见 failedRes 注释） */
      return failedRes(EM_QUIET ? '行情源暂不可用，稍后自动重试' : (e && e.message));
    }
  }

  /** 分时线末端补一个「当前分钟」的实时点。
   *  分钟线本质是「已经收盘的那一分钟」，天然慢 1~2 分钟（各家源都一样），
   *  用户看到的就是「图上的线比顶上的价格慢」。用实时报价把线头拉到此刻，
   *  两边就对齐了。只在「最后一点距今 ≤5 分钟」时补（收盘后不动）。 */
  async function withLiveTip(key, res) {
    try {
      if (!res || res.synthetic || !res.points || !res.points.length) return res;
      const nowMin = Math.floor((Date.now() + 8 * 3600e3) / 60000) * 60;
      const pts = res.points;
      let last = pts[pts.length - 1];

      /* v236：延展时段（盘前 / 盘后）不补这个实时点。
       * 批量报价给的是「最近一次常规收盘」：美光盘前已经在 724.76 走了一小时，
       * 报价里的 f2 仍然是 733.15。把它补进 pre 段末端，图上就会凭空拉出一根
       * 从 724 直跳 733 的竖线（用户 11-10 20:15 英伟达截图右端那个尖峰），
       * 图例还会把盘前显示成 +0.00%。盘前/盘后价本来就由 extQuotes 单独显示在
       * 页面顶部，分钟线自己已经是最新一分钟，不需要这条补点。 */
      /* v274：韩股盘后（Naver 段延迟可达 20 分钟）放开补实时点，
       * 让分时线尾与顶部大价对齐；其它市场的延展时段仍按 v236 不补。 */
      const _ka = U.get(key);
      const _kr = !!(_ka && _ka.grp === 'krstock');
      if (last.seg && last.seg !== 'reg' && !_kr) return res;

      /* 【先把时间轴对齐】各家源对「分钟」的打标签方式不一样：
       *   · 美股（Nasdaq/东财个股）按**起始**打标，最后一根 ≤ 当前分钟；
       *   · 东财的 FX / 美债会把「正在走的那一分钟」按**结束时刻**打标，
       *     最后一根 = 当前分钟 + 60 秒。
       * 不归一化就会出现「人民币快 1 分钟、英伟达慢 2 分钟」这种各品种不一致。
       * 这里把未来 1~2 分钟的标签拉回当前分钟（它本来就是在走的那根）。 */
      if (last.time > nowMin && last.time - nowMin <= 120) {
        /* 归一化后可能与前一根撞同一个时间戳（源按「结束时刻」标时，前一根也标 nowMin）。
         * LightweightCharts 要求时间严格递增，撞点会让分时线渲染错乱 —— 合并掉前一根。 */
        const prev = pts.length > 1 ? pts[pts.length - 2] : null;
        if (prev && prev.time >= nowMin) pts.splice(pts.length - 2, 1);
        last.time = nowMin;
      }

      /* 报价只读缓存，**不再同步补一次批量报价**。
       * v285：原来缓存没热时会 await batchQuote —— 东财挂掉时那是 9~18 秒，
       * 整张分时图就卡在「加载中…」等一个根本拿不到的报价（实测上证 6 秒还没画完）。
       * 线头晚几分钟由 _liveTick（每 8 秒）补上，不该拿首屏时间换。 */
      const q = cachedQuote(key);
      if (!q || !(q.price > 0)) return res;

      let gap = nowMin - last.time;
      /* 韩股盘后 Naver 点延迟大，gap 上限放宽到 2 小时；其它市场维持 5 分钟 */
      if (gap < 0 || (gap > 300 && !_kr) || gap > 7200) return res;
      if (gap === 0) {
        last.close = q.price;
        last.high = Math.max(last.high, q.price);
        last.low = Math.min(last.low, q.price);
      } else {
        pts.push({
          time: nowMin, open: last.close, close: q.price,
          high: Math.max(last.close, q.price), low: Math.min(last.close, q.price),
          volume: 0
        });
      }
    } catch (e) { /* 补点失败不影响主流程 */ }
    return res;
  }

  async function intraday(key) {
    const r = finalize(await withLiveTip(key, await intradayRaw(key)), 'intraday');
    /* v310【同源校准硬规则】分时数组加载完且非空时，用尾点价对齐顶部快照，
     * 消除「顶部价来自 A 源、分时尾点来自 B 源」拉出的 90° 竖线（美债历史问题）。 */
    try {
      if (r && !r.failed && r.points && r.points.length) {
        const last = r.points[r.points.length - 1];
        const hit = cache.get('q:' + key);
        if (last && last.close > 0 && hit && hit.d && hit.d.price > 0 && hit.d.price !== last.close) {
          const q = hit.d;
          cache.set('q:' + key, { t: Date.now(), d: Object.assign({}, q, {
            price: last.close,
            chg: q.prev ? last.close - q.prev : q.chg,
            pct: q.prev ? (last.close - q.prev) / q.prev * 100 : q.pct,
            at: Date.now(), aligned: true
          }) });
        }
      }
    } catch (e) { /* 校准失败不影响出图 */ }
    return r;
  }

  // 分钟序列（供异动雷达计算窗口涨跌幅）
  async function minutes(key, limit) {
    const a = U.get(key);
    if (!a) throw new Error('unknown asset ' + key);
    /* VIX：CNBC 1 分钟线（CBOE 那条延 15 分钟，雷达算窗口涨幅会滞后） */
    if (a.rt === 'cnbc') {
      const r = await cnbcIntraday(a.cnbcSym || cnbcSym(key, a));
      if (!r.points.length) throw new Error('empty');
      return r.points;
    }
    /* 外盘商品：异动雷达算窗口涨跌幅也要用实时序列，不能拿东财延 10 分钟的 */
    if (a.rt === 'tx') {
      const r = await sinaFut(sinaSymOf(key), a.pxScale || 1);
      if (!r.points.length) throw new Error('empty');
      return r.points;
    }
    if (a.src === 'cboe') {
      // 只给当日盘中分钟。收盘后条数停在 390，跨日会归零 ——
      // 这时返回空，scan 侧按「无数据」处理，不拿昨天的走势冒充今天。
      return await cboeMinutes();
    }
    if (a.src === 'yahoo') {
      // range=1d 在非美股时段会返回 0 根（Yahoo 只给当日盘中），
      // 必须用 5d 才有足够 bar 计算 30 分钟窗口。
      let y = await yahooBars(a.sym, '5m', '5d');
      if (!y.points.length) y = await yahooBars(a.sym, '1m', '5d');
      if (!y.points.length) throw new Error('empty');
      return y.points;
    }
    if (a.src === 'binance') return bnKline(a.sym, '1m', limit || 40);
    /* v284：emKline 现在「空包即抛错」，这里要接住，否则没有 1 分钟线的品种
     * （美元指数等）会直接失败，连下面用分时序列兜底的机会都没有。 */
    let bars = [];
    try { bars = await emKline(a.secid, 1, limit || 40); } catch (e) { bars = []; }
    if (bars.length >= 5) return bars;
    // 部分品种（美元指数等）没有 1 分钟 K 线，用分时序列合成
    const r = await emTrend(a.secid, 1);
    if (!r.points.length) throw new Error('empty');
    return r.points.map(p => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close, volume: 0 }));
  }

  /** 读批量报价的内存快照（不触发新请求）。
   *  异动扫描要算「当日涨跌」，必须用昨收 —— 用当日开盘价会严重失真：
   *  VIX 昨收 20.83、今开 17.77，拿开盘算只跌 1.2%，实际跌 15.7%。 */
  function cachedQuote(key) {
    const hit = cache.get('q:' + key);
    return hit ? hit.d : null;
  }

  // 单品种报价（走批量接口，保证与行情页同一口径）
  async function quote(key) {
    const hit = cache.get('q:' + key);
    if (hit && Date.now() - hit.t < 20000) return hit.d;
    const o = await batchQuote([key]);
    if (o[key]) return o[key];
    const r = await intraday(key);
    if (r.failed || !r.points.length) throw new Error(r.error || 'no quote');
    const last = r.points[r.points.length - 1];
    const prev = r.preClose || (r.points[0] && r.points[0].close);
    const price = last ? last.close : null;
    return { price, prev, chg: price && prev ? price - prev : 0, pct: prev ? (price - prev) / prev * 100 : 0, synthetic: r.synthetic, at: Date.now() };
  }

  // 币安返回真实 UTC 时间戳；图表按「北京时区分量当作 UTC」渲染，故整体平移 +8h
  function shift(pts, s) {
    return pts.map(p => ({ time: p.time + s, open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume }));
  }

  function dedupe(pts) {    const seen = new Set();
    const out = [];
    for (const p of pts) {
      if (!p.time || seen.has(p.time)) continue;
      seen.add(p.time);
      out.push(p);
    }
    out.sort((x, y) => x.time - y.time);
    return out;
  }

  function tradingViewURL(key) {
    const a = U.get(key);
    if (!a || !a.tv) return 'https://www.tradingview.com/';
    return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(a.tv);
  }

  /* ---------------- 真实快讯接入 ---------------- */
  async function news(force, onProgress) {
    // ① 优先走后端聚合（金十 / 东财 / 新浪，服务端抓取，覆盖最全）
    if (location.protocol !== 'file:' && HAS_BACKEND) {
      try {
        const r = await fetch('/api/news' + (force ? '?force=1' : ''), { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (d && Array.isArray(d.items) && d.items.length) {
            return { items: d.items, stats: d.stats || {} };
          }
        }
      } catch (e) { /* 后端不可达，走 ② */ }
    }
    // ② 浏览器直连聚合（11 源）：见闻 / 金十 / 财联社 / 财联社深度 / 格隆汇 / 同花顺 / 东财 / 新浪 / RSS / KZG / 川普
    //    即使一条都没抓到，也要把 stats.srcDetail 带回去，好让 UI 逐源显示「谁通了、谁挂了」
    if (w.LiveNews) {
      try {
        const res = await w.LiveNews.collect(force, null, false, onProgress);
        if (res && res.stats) {
          res.stats.direct = true;
          if (res.items && res.items.length) return res;
          return { items: [], stats: res.stats, empty: true };
        }
      } catch (e) { /* 聚合层整体抛错，交给 ③ */ }
    }
    return null;
  }

  /* v101：应用内下拉刷新专用。
   * 与 news() 的区别：不重载页面、不重建 9 个源的连接，只跳过 25 秒 TTL
   * 立刻跑一次正常轮询；LiveNews.collect(soft) 会顺带对上一轮失败的源
   * 清掉代理失败缓存强制重试，已连通的源保持原状态。 */
  async function newsSoft(onProgress) {
    if (!w.LiveNews || typeof w.LiveNews.collect !== 'function') return null;
    try {
      const res = await w.LiveNews.collect(false, 0, true, onProgress);
      if (res && res.stats) {
        return {
          items: res.items || [], stats: res.stats,
          empty: !res.items || !res.items.length, soft: true
        };
      }
    } catch (e) { /* 拉不到就维持现状，25 秒自动轮询会接上 */ }
    return null;
  }

  async function flash(limit) {
    try {
      const r = await fetch('/api/flash?limit=' + (limit || 80), { cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !Array.isArray(d.items)) return null;
      return d.items;
    } catch (e) { return null; }
  }

  /* ---------------- 启动自检 ----------------
   * 设置页的「在线/异常/待连接」以前经常一直停在「待连接」——
   * 因为链上价只有在休市且配了 hl 时才会被调用，从来没人探过。
   * 这里在启动后主动打一遍四个通道，状态立刻是真实值。 */
  async function probeSources() {
    const r = {};
    // 东财批量快照（push2）
    try {
      await getJSON(`${EM_LIST}?fltt=2&secids=1.000001&fields=f2,f3,f4,f12,f13,f14&ut=${EM_UT}&_=` + Date.now(), 0, 'em');
      r.em = 'ok';
    } catch (e) { r.em = 'fail'; }
    /* v284：历史接口（分时/K线，push2his）必须单独探。
     * 以前只探批量报价，于是「东财行情 · 在线」一直亮着，而分时全站挂掉没人知道。 */
    try {
      const d = await emHistJSON(`${EM_TREND_PATH}?secid=1.000001&fields1=f1,f2&fields2=f51,f52&ndays=1`, 0);
      r.emHis = ((d && d.data && d.data.trends) || []).length ? 'ok' : 'fail';
    } catch (e) { r.emHis = 'fail'; }
    // 币安（含备选）
    try {
      await bnJSON('/ticker/24hr?symbols=' + encodeURIComponent('["BTCUSDT"]'));
      r.binance = 'ok';
    } catch (e) {
      try { r.binance = (await altTickers(['BTCUSDT'])).length ? 'ok' : 'fail'; }
      catch (e2) { r.binance = 'fail'; }
    }
    // 链上：DexScreener 池子价
    try {
      const d = await getJSON(DEX_BASE + '/search?q=WBTC', 60000, 'dex');
      r.dex = (d && d.pairs && d.pairs.length) ? 'ok' : 'fail';
    } catch (e) { r.dex = 'fail'; }
    // 链上：Hyperliquid RWA 永续（暗盘价）
    try {
      const m = await hlMids();
      r.hl = Object.keys(m || {}).length ? 'ok' : 'fail';
    } catch (e) { r.hl = 'fail'; }
    // VIX：CBOE 官方
    try {
      await cboeQuote();
      r.cboe = 'ok';
    } catch (e) { r.cboe = 'fail'; }
    return r;
  }

  w.API = {
    candles, intraday, minutes, quote, batchQuote, dexQuote, extQuote, extQuotes, hlQuote, hlMids, jpPtsQuote, krNaverMinutes,
    status, tradingViewURL, tMin, tDay, emQuiet: EM_QUIET, flash, news, newsSoft, optionChain, usOptionChain, cboeOptionChain, sinaOptionChain, sinaOptionMin,
    probeSources, altTickers, bnJSON, cboeQuote, cboeMinutes, cboeDaily,
    cachedQuote,
    /* v286：行情可信白名单与校验器（供回归测试 / 外部校验复用） */
    REAL_SOURCES, trusted, finalize
  };
})(window);
