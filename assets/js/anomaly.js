/* ============================================================
 * anomaly.js — 行情异动反向嗅探（六尺度）
 * ------------------------------------------------------------
 * 逻辑：资金永远走在新闻前面。核心资产的窗口涨跌幅击穿阈值，
 *      而快讯库中找不到催化剂 → 亮红灯「正在全力捕获催化剂」。
 *
 * 【六尺度：黑天鹅发生在分钟级】
 *   用户原话：「那种剧烈波动，特别是黑天鹅，都是发生在几分钟里面的，
 *   你 30 分钟才去看的话，根本就来不及了。」
 *   所以六个窗口同时盯，任一越线即触发：
 *     1 分钟  → 闪崩 / 单根 K 线垂直拉升（不等确认，1.4 倍直接报）
 *     2 分钟  → 短促脉冲（同上）
 *     3 分钟  → 脉冲确认
 *     5 分钟  → 主战场（1.6 倍直接报，否则需连续两轮）
 *     15 分钟 → 短促趋势（连续两轮）
 *     30 分钟 → 持续趋势（连续两轮）
 *   短尺度额外闸门：1/2/3 分钟越线时，要求 5 分钟窗口也走掉阈值的 50%
 *   以上 —— 单笔异常成交打出的「一分钟插针」不会同向推动 5 分钟窗口，
 *   这条闸门把「真急动」和「撮合毛刺」分开。
 *
 * 【动态波动率】
 *   阈值不是死值。每次扫描把「今天到目前为止的窗口极值」写进
 *   VolBank（localStorage），跨天累积成经验分布，再与静态标定值
 *   按样本量加权 —— 详见 volprofile.js。页面开着就一直在学，
 *   40 个交易日后完全由实盘分布决定，不用再改 universe.js。
 *
 * 【关键防护】
 *   · 休市/跨夜：窗口首尾时间跨度必须严格等于 win 分钟，否则本轮放弃判断，
 *     否则开盘瞬间会把隔夜跳空当成异动。
 *   · 粒度不足：Yahoo 只有 5 分钟 K 线时，1/2/3 分钟窗口自动跳过
 *     （spanMin ≠ win），不会把 5 分钟当成 1 分钟。
 * ============================================================ */
(function (w) {
  'use strict';

  const U = w.UNIVERSE;

  /* 各尺度的目标触发日占比（与 tools/tune_multi.py / thr_short.py 标定口径一致） */
  const TARGET_RATE = { 1: 0.04, 2: 0.04, 3: 0.04, 5: 0.05, 15: 0.045, 30: 0.04 };

  /* 短尺度立即报警所需的倍数（越小越敏感）
   * 1~3 分钟：1.3 倍就报，不等下一轮 —— 闪崩的窗口只有几十秒，
   *   再等 20 秒确认一次，可能整段行情已经走完。
   * 5 分钟：1.5 倍；不到就连续两轮确认。 */
  const FAST_MULT = { 1: 1.3, 2: 1.3, 3: 1.3, 5: 1.5 };

  /* 短尺度闸门：5 分钟窗口至少走掉自身阈值的这个比例 */
  const CROSS_GATE = 0.5;

  /** 窗口 → 尺度名 */
  function scaleOf(win) {
    if (win <= 3) return 'flash';
    if (win <= 5) return 'fast';
    if (win <= 15) return 'mid';
    return 'slow';
  }

  /** 重复提醒闸门（纯函数，便于单测）。
   *  用户口径：「不是说一定要 3% 扩大到 5% 才提醒，我只是举例……不同商品的波动率是不
   *  一样的呀，那有一些像汇率的话，我零点几个百分点都很大了。它如果持续扩大的话，就这
   *  个还是要看波动率的，它只要这个幅度是在扩大，而且振幅比较明显的话，就要提醒，那这
   *  个振幅看的是这个商品本身的波动率去判断的。」
   *
   *  所以判据不能写死百分比，要用**该品种自己的波动尺度**：
   *    sigma = 这个品种自己的异常幅度（5 分钟动态阈值，已按它自身的历史分位标定）
   *            美元人民币 ≈ 0.066%，黄金 ≈ 0.79%，比特币 ≈ 1.26%，VIX ≈ 5.2%
   *  再报的门槛 = 本次比上次又扩大了多少（delta），且 delta 要达到 sigma 的一定比例 ——
   *  这样汇率扩大 0.04 个百分点就会再报，而比特币要扩大 0.6 个百分点才算数。
   *
   *  @param curAmp  当前幅度（%，取当日/累计/窗口最大）
   *  @param lastAmp 上次弹出预警时的幅度（%）
   *  @param sigma  该品种自身的波动尺度（%）
   *  @param cool   冷却毫秒
   *  @param prevAt 上次弹出预警的时间戳（0 = 从未弹出）
   *  @param now    当前时间戳
   *  @returns 是否应再次弹出预警 */
  function ampGate(curAmp, lastAmp, sigma, cool, prevAt, now) {
    if (!prevAt) return true;                  // 首次必报
    if (now - prevAt <= cool) return false;    // 冷却期内不重复
    const delta = curAmp - lastAmp;            // 这次又扩大了多少（百分点）
    if (delta <= 0) return false;              // 没有继续扩大 → 不重复
    // 「明显」按该品种自己的尺子判断
    const s = sigma > 0 ? sigma : 0.2;
    return delta >= Math.max(s * 0.5, 0.02);
  }

  /* ============================================================
   * 波动率状态：判断「现在到底有没有在震」
   * ------------------------------------------------------------
   * 用户口径（原话）：
   *   「上午 +5% → 回落到 +1% 这种情况本身就已经是高波动的杀盘，
   *    本身就已经够预警了。如果是一段时间快速回落的话，我觉得重点还是在于
   *    你对各个品种的波动率的测算。」
   *   「像以太坊虽然全天交易，但明显有些时间段属于冷交易时间，
   *    这种时间没有大波动，也不应该有任何预警。」
   *
   * 所以「异动」的定义不该是「累计涨跌幅超过某个百分比」——那是**结果**，
   * 不是**状态**。累计涨幅可以来自 14 小时前的一根直线，而现在的盘面
   * 可能完全是一潭死水；反过来从 +5% 一路阴跌回 +1%，
   * 累计数字在缩小，但这一路都是剧烈波动，异动并没有结束。
   *
   * 量化口径：用**已实现波动率（realized volatility）**看当下活跃度。
   *   RV  = 最近 N 根 1 分钟收益率的标准差（%，单位与涨跌幅一致）
   *   REF = 当日各 N 分钟窗口 RV 的中位数，再抬到该品种的波动地板
   *   z   = RV / REF
   *
   * z ≈ 1 → 就是它自己的常态；z ≥ 2 → 明显在震；z < 1 → 一潭死水。
   * 这个指标对方向不敏感，所以「拉升」和「回落」都能被同样识别为异动，
   * 而「14 小时前涨完、现在横盘」会被干净地判成冷清。
   * ============================================================ */

  /** 最近 n 根 1 分钟收益率的样本标准差（%）。用收益率而非价格差，
   *  这样不同价位的品种可以直接比较，也不会被趋势本身抬高。 */
  function realizedVol(bars, n) {
    if (!bars || bars.length < 3) return 0;
    const from = Math.max(1, bars.length - n);
    const rets = [];
    for (let i = from; i < bars.length; i++) {
      const p0 = bars[i - 1] && bars[i - 1].close;
      const p1 = bars[i] && bars[i].close;
      if (p0 > 0 && p1 > 0) rets.push((p1 - p0) / p0);
    }
    if (rets.length < 3) return 0;
    let m = 0;
    for (const r of rets) m += r;
    m /= rets.length;
    let v = 0;
    for (const r of rets) v += (r - m) * (r - m);
    v /= rets.length;
    return Math.sqrt(v) * 100;
  }

  /** 当日滚动基线：把最近这些分钟按 n 分钟一段切开，取各段 RV 的中位数。
   *  取中位数而不是均值，是为了让昨晚那一根直线拉升不至于把基线抬上天，
   *  否则「今天横盘」会被误算成 z≈0、而「刚启动的小行情」反而显得正常。 */
  function volBaseline(bars, n) {
    if (!bars || bars.length < n * 2) return 0;
    const step = Math.max(1, Math.floor(n / 2));
    const out = [];
    for (let end = n * 2; end <= bars.length; end += step) {
      out.push(realizedVol(bars.slice(end - n * 2, end), n));
    }
    if (out.length < 3) return 0;
    out.sort((a, b) => a - b);
    return out[Math.floor(out.length / 2)] || 0;
  }

  /** 该品种的波动地板：再冷清也不可能低于这个量级，
   *  否则「一整天都在 0.01% 抖动」的品种会把 z 算爆表。 */
  function volFloor(key) {
    const VP = w.VolProfile;
    const cls = VP && VP.classOf ? VP.classOf(key).cls : { floor: 0.3 };
    return Math.max(0.012, (cls.floor || 0.3) * 0.12);
  }

  /* 维持闸门：z 高于这个值，说明这一波还没平息 —— 哪怕窗口涨跌幅已经
   * 在收敛（回落），也继续算作「异动中」。用户要的就是「回落也是杀盘」。 */
  const HOLD_Z = 1.25;
  /* 当日尺度的新鲜度旁路：z 够高就直接认新鲜，不必再比 15/30 分钟幅度。 */
  const FRESH_Z = 1.5;

  class Radar {
    constructor(opts) {
      opts = opts || {};
      this.onUpdate = opts.onUpdate || function () {};
      this.onAlert = opts.onAlert || function () {};
      this.newsLookup = opts.newsLookup || function () { return false; };
      /* v100：归因要能落到**具体新闻**，不能只返回一个布尔值。
       * 用户口径：「异动矩阵下面的分类要能点开看到列表，有归因的要写出归因」。
       * 返回新闻对象（含 id / title / src / url / ts），没有就返回 null。 */
      this.newsCause = opts.newsCause || function () { return null; };
      /* 只有行情播报、没有事件原因时，UI 需要说清「为什么没归因」，
       * 否则用户会以为归因功能挂了。 */
      this.newsEchoOnly = opts.newsEchoOnly || function () { return false; };
      this.timer = null;
      this.state = {};
      this.alertedAt = {};
      /* 上次弹出预警时的「幅度」（当日/累计/窗口取最大）。用于「重复提醒」判据：
       * 同一品种弹过一次后，只有幅度较上次明显扩大才再报，否则不再打扰。 */
      this.alertedAmp = {};
      this.thrScale = 1;
      this.cooldown = 10 * 60 * 1000;
      this.busy = false;
      this.scans = 0;
      this.hits = 0;
      this.log = [];
      this.newsLog = [];        // 「新闻先报、行情印证」的补充异动（保留最近 20 条）
      this.calib = {};
      this.prof = {};
      this.hitState = {};
      this.profAt = 0;
      this.lastScanAt = 0;
      this.nextScanAt = 0;
      this.wallskew = -new Date().getTimezoneOffset() * 60;
      /* 持续事件（burst）：
       * 一个品种一旦越线，就记下「从哪一根 bar 开始、起点价多少」，
       * 之后每轮只更新「持续了多久 / 累计多少 / 还在不在扩大」。
       * 目的见 scan() 里的注释 —— 短窗口会把 30 分钟的单边行情说成「只跌了 0.3%」。 */
      this.bursts = {};
      /* 「当日尺度」阈值缓存：动态 5 分钟阈值每轮都会重算，同一条 -16.8% 的行情
       * 会在两轮之间从「命中」掉回「平静」，横幅一闪一灭。
       * 当日阈值只许降不许升（同一交易日内取最小值），状态就不会来回跳。 */
      this.dayBase = {};

      /* 每个品种上一轮是否处于「异动中」。
       * 用途：波动率还高的时候把异动状态**维持**住 —— 从 +5% 跌回 +1% 的那一路
       * 窗口涨跌幅在收敛，但盘面依然剧烈，异动并没有结束（用户口径）。 */
      this.alarmOn = {};

      /* ---- 预警状态持久化 ----
       * 用户反馈：「关掉 app 再打开，预警又会全部重新跑出来」。
       *
       * 根因：alertedAt / alertedAmp 只在内存里，重启即清零。
       * ampGate 看到 prevAt=0 就走「首次必报」分支 → 所有异动全部重弹一遍。
       *
       * 修法：把「每个品种当天已预警的幅度 + 时间」落盘，重启后恢复。
       * 恢复后判据照旧生效：
       *   · 幅度没继续扩大 → 不再报（这才是用户要的「不反复预警」）
       *   · 幅度确实在扩大（如原油连跌 2 小时）→ 继续报（用户明确要的）
       * 按**交易日**分桶：新的一天是新行情，旧账不带过来。 */
      this.alertState = {};
      this.alertStateDay = '';
      try { this.loadAlertState(); } catch (e) {}

      /* ---- 顶部横幅账本（与预警账本分开） ----
       * 用户反馈：「纳斯达克的预警一刷新就跑出来，关掉 app 再打开，
       * S 级预警和 VIX 预警又跑出来」。
       *
       * 根因不在 ampGate，而在 app.js 的 syncAlerts()：
       * 横幅的显示条件只有「当前是否存在未归因异动」，
       * 跟「这个异动之前报过没有」完全无关 ——
       * 所以只要行情还在异动状态里，重启后横幅必然重弹。
       *
       * 这里给横幅单独记一份账：每个品种上次**弹出横幅**时的幅度。
       * 判定：首次必弹；之后只有幅度明显扩大才重新弹。
       * 于是「关掉 app 再打开」不会把旧异动重放一遍，
       * 而原油那种持续扩大的行情仍会继续提示。
       * 单独记账而不是复用预警账本，是因为两者的触发时机不同：
       * 预警账本管的是 toast 弹窗，横幅账本管的是顶部横幅。 */
      this.bannerState = {};
      this.bannerStateDay = '';
      this.bannerCool = 3 * 60 * 1000;   // 横幅最短重弹间隔，避免抖动刷屏
      try { this.loadBannerState(); } catch (e) {}

      // 波动率库：先读本地，再交给下一次 loadProfiles 精确回填
      try { if (w.VolProfile) w.VolProfile.VolBank.load(); } catch (e) {}
    }

    start(intervalMs) {
      this.stop();
      this.interval = intervalMs || 20000;
      this.scan();
      this.timer = setInterval(() => this.scan(), this.interval);
      /* v236：前台服务从 Java 侧主动注入扫描的入口。
       * APP 退到后台时 Android 会节流 WebView 的 JS timer，但外部
       * evaluateJavascript 注入不受影响；scan() 自带 busy 门，重复调用安全。 */
      try { w.__forceAnomalyScan = () => this.scan(); } catch (e) {}
    }

    stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

    /* ---------------- 预警状态持久化 ----------------
     * 落地内容：{ v, day, st: { 品种: { at: 上次预警时间, amp: 上次预警幅度 } } }
     * 分桶键 day = 今天的日期（本地时区）。
     * 换天后旧记录整体作废 —— 新的一天是新的行情，不该继承昨天的预警记录。 */
    alertStoreKey() { return 'mm_alert_state_v1'; }

    /** 当前「预警账」的日期桶。交易时段跨午夜（美股）也按自然日，
     *  因为美股的一个交易日从北京时间晚上开始，跨零点仍是同一段行情。 */
    alertDay() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');
    }

    loadAlertState() {
      const today = this.alertDay();
      this.alertStateDay = today;
      this.alertState = {};
      try {
        const ls = w.localStorage;
        if (!ls) return;
        const raw = ls.getItem(this.alertStoreKey());
        if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || d.v !== 1 || d.day !== today || !d.st) return;
        // 恢复成 alertedAt / alertedAmp —— ampGate 立刻按老口径工作
        for (const k in d.st) {
          const v = d.st[k];
          if (!v || typeof v.at !== 'number') continue;
          this.alertState[k] = v;
          this.alertedAt[k] = v.at;
          this.alertedAmp[k] = Number(v.amp) || 0;
        }
      } catch (e) { /* 隐私模式/配额满：静默降级为纯内存 */ }
    }

    /** 记录一次预警并落盘（节流 3 秒，避免每轮扫描都写） */
    markAlerted(k, amp) {
      this.alertState[k] = { at: Date.now(), amp: Number(amp) || 0 };
      this.alertStateDay = this.alertDay();
      this.saveAlertState(true);   // 强制落盘，不吃节流（否则关 app 就丢）
    }

    /** 一波行情走完：把「幅度基准」清零，但保留时间戳让冷却继续走。
     *  这样下一波可以从 0 起算，重新触发提醒（用户要的「下午再冲高要再提醒」），
     *  同时阈值边缘来回穿越时不会被绕过冷却反复弹窗。 */
    resetAlertedAmp(k) {
      if (!this.alertedAmp[k] && !(this.alertState[k] && this.alertState[k].amp)) return;
      this.alertedAmp[k] = 0;
      if (this.alertState[k]) this.alertState[k].amp = 0;
      this.saveAlertState(false);
    }

    saveAlertState(force) {
      const now = Date.now();
      /* 同横幅账本：预警记录被节流丢掉 = 重启后所有异动重弹一遍。
       * 预警本身就是低频事件，直接同步写盘。 */
      if (!force && this._alertSavedAt && now - this._alertSavedAt < 3000) return;
      this._alertSavedAt = now;
      try {
        const ls = w.localStorage;
        if (!ls) return;
        ls.setItem(this.alertStoreKey(), JSON.stringify({
          v: 1, day: this.alertDay(), st: this.alertState, t: now
        }));
      } catch (e) { /* 静默降级 */ }
    }

    /* ---------------- 顶部横幅账本 ---------------- */
    bannerStoreKey() { return 'mm_banner_state_v1'; }

    loadBannerState() {
      const today = this.alertDay();
      this.bannerStateDay = today;
      this.bannerState = {};
      try {
        const ls = w.localStorage;
        if (!ls) return;
        const raw = ls.getItem(this.bannerStoreKey());
        if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || d.v !== 1 || d.day !== today || !d.st) return;
        for (const k in d.st) {
          const v = d.st[k];
          if (!v || typeof v.at !== 'number') continue;
          this.bannerState[k] = { at: v.at, amp: Number(v.amp) || 0 };
        }
      } catch (e) { /* 静默降级 */ }
    }

    saveBannerState(force) {
      const now = Date.now();
      /* 【关键】横幅账本不能节流落盘。
       * 原来的 3 秒节流会让「刚弹出的那条横幅」的 markBanner 被丢掉 ——
       * 于是下次打开 app，账本里查不到这条异动，横幅又弹一遍。
       * 这正是用户反馈的「关掉 app 再打开，纳指/VIX 预警又跑出来」。
       * 横幅弹出是低频事件（每天几次），直接同步写盘完全够用。 */
      if (!force && this._bannerSavedAt && now - this._bannerSavedAt < 3000) return;
      this._bannerSavedAt = now;
      try {
        const ls = w.localStorage;
        if (!ls) return;
        ls.setItem(this.bannerStoreKey(), JSON.stringify({
          v: 1, day: this.alertDay(), st: this.bannerState, t: now
        }));
      } catch (e) { /* 静默降级 */ }
    }

    /** 记一次「横幅已弹出」 */
    markBanner(k, amp) {
      this.bannerState[k] = { at: Date.now(), amp: Number(amp) || 0 };
      this.bannerStateDay = this.alertDay();
      this.saveBannerState(true);   // 强制落盘，不吃节流
    }

    /**
     * 某品种此刻是否允许再弹一次横幅。
     * @param k      品种键
     * @param curAmp 当前幅度（%）
     * @param sigma  该品种自身的波动尺度（%）
     */
    bannerAllowed(k, curAmp, sigma) {
      const rec = this.bannerState[k];
      if (!rec) return true;                       // 首次必弹
      if (Date.now() - rec.at <= this.bannerCool) return false;  // 冷却期内不重复
      const delta = curAmp - (rec.amp || 0);
      if (delta <= 0) return false;                // 没有继续扩大 → 不再打扰
      const s = sigma > 0 ? sigma : 0.2;
      return delta >= Math.max(s * 0.5, 0.02);
    }

    /** 当前「幅度」：当日涨跌幅 / 持续段累计 / 窗口幅度取最大。
     *  这是「重复提醒」的分子 —— 用户口径：同一品种弹过一次后，
     *  除非幅度继续扩大（如跌幅从 -3% 到 -5%），否则不再重复提醒。 */
    ampOf(r) {
      if (!r) return 0;
      /* 报警账本要比的是「这一波有多大」，**不能算进当日累计**。
       *
       * 实跑（用户口径）：「科创50 上午 10:30 前一直高波动拉升，提醒异动没问题；
       * 10:30 后冲高回落，假设下午又出现像上午那样的冲高拉升或者大幅跳水，
       * 就应该再次提醒。」
       *
       * 原来这里取 max(dayPct, run.cum, chg)。dayPct 一整天只增不减，
       * 上午冲到 +5% 记账成 5，下午再从低点拉 4% 时 curAmp 仍是 5（被 dayPct 撑着），
       * delta = 0 → 判「没扩大」→ 全天只提醒一次。
       * 现在只用「当前这一波」的累计幅度，dayPct 仅在完全没有 run 时兜底。 */
      if (r.run) return Math.abs(r.run.cum || 0);
      return Math.max(Math.abs(r.dayPct || 0), Math.abs(r.chg || 0));
    }

    /** 该品种自身的波动尺度（%）：取它自己的 5 分钟动态阈值
     *  （已按自身历史分位标定）。美元人民币 0.066%、黄金 0.79%、
     *  比特币 1.26%、VIX 5.2% —— 各按各的尺子量。 */
    sigmaOf(r) {
      if (!r) return 0.2;
      const h5t = (r.hits || []).find(h => h.win === 5);
      return (h5t && h5t.thr) || r.thr || 0.2;
    }

    setThresholdScale(v) { this.thrScale = v; }

    /** 手动触发一次（演示 / 自检） */
    fire(k, chg) {
      const t = U.RADAR.find(x => x.k === (k || 'BRENT')) || U.RADAR[0];
      const r = {
        key: t.k, name: U.fullName(t.k), short: U.name(t.k),
        chg: chg == null ? -1.82 : chg,
        amp: Math.abs(chg == null ? -1.82 : chg) * 1.1,
        thr: +(t.t5 * this.thrScale).toFixed(2),
        win: 5, scale: 'short',
        last: (this.state[t.k] && this.state[t.k].last) || null,
        at: Date.now(), status: 'unattributed', demo: true, ageMin: 0
      };
      this.log.unshift(Object.assign({ kind: 'unattributed' }, r));
      this.log = this.log.slice(0, 60);
      this.hits++;
      this.state[t.k] = r;
      this.onAlert(r);
      this.onUpdate(Object.values(this.state), this);
      return r;
    }

    /** 推断 bar 粒度（分钟）：东财/币安 1，Yahoo 5 */
    barStep(bars) {
      if (!bars || bars.length < 4) return 1;
      const diffs = [];
      const n = bars.length;
      for (let i = n - 1; i > Math.max(1, n - 15); i--) {
        const d = Math.round((bars[i].time - bars[i - 1].time) / 60);
        if (d >= 1 && d <= 60) diffs.push(d);
      }
      if (!diffs.length) return 1;
      diffs.sort((a, b) => a - b);
      return diffs[Math.floor(diffs.length / 2)];
    }

    /** 以最后一根 bar 结尾、时间连续、长度恰为 win 分钟的窗口 */
    winWindow(bars, win) {
      const n = bars.length;
      const step = this.barStep(bars);
      const need = Math.max(1, Math.round(win / step));
      if (n < need + 1) return { ok: false, step };
      const last = bars[n - 1];
      const from = bars[n - 1 - need];
      const spanMin = Math.round((last.time - from.time) / 60);
      const ok = spanMin === win;
      // 开盘头几分钟不算：东财分时把 09:15~09:25 集合竞价也给了，
      // 「第一分钟涨 1.8%」其实是隔夜跳空，不是盘中异动。
      // 同理跨过午休/夜盘缺口后的头几分钟也不看。
      const ss = this.sessionStart(bars, step);
      const afterOpen = (n - 1 - need) - ss < 4;
      return { from, last, span: need, ok: ok && !afterOpen, step, spanMin, afterOpen };
    }

    /** 当前这一节的起点下标（往前找第一根出现 >2 个 step 缺口的位置） */
    sessionStart(bars, step) {
      const n = bars.length;
      const gapSec = Math.max(2, step * 2) * 60;
      for (let i = n - 1; i > 0; i--) {
        if (bars[i].time - bars[i - 1].time > gapSec) return i;
      }
      return 0;
    }

    /** 分钟级噪声：最近 30 根 bar 的 (high-low)/close 中位数（%），用来判断「多大幅度的反向算回调」 */
    runNoise(bars) {
      const n = bars.length;
      const m = Math.min(30, n);
      const arr = [];
      for (let i = n - m; i < n; i++) {
        const b = bars[i];
        const c = b.close || 1;
        const hi = b.high != null ? b.high : c;
        const lo = b.low != null ? b.low : c;
        if (hi > lo) arr.push((hi - lo) / c * 100);
      }
      if (!arr.length) return 0.1;
      arr.sort((a, b) => a - b);
      const med = arr[Math.floor(arr.length / 2)];
      return Math.max(0.05, Math.min(1.5, med * 1.1));
    }

    /** 连续同向的那一段：从最后一根 bar 往前扩，只要这段的「最大回撤」不超过噪声就继续。
     *  返回 { idx, at, from, cum, durMin }。
     *
     *  为什么不能用「从首次越线算起」：以前只要累计没回吐一半就继续计时，
     *  于是「涨—回调—再涨」的一整天会被算成「持续上涨 109 分钟」。
     *  用户原话：「明显不可能 100 多分钟一直都在拉升或下跌」。
     *
     *  正确的「持续」定义：这一段里从高点到低点的最大回撤 ≤ 噪声。
     *  一旦某个更早的 bar 让回撤超标，说明中间有过像样的反向，段就从那之后算起。
     *  涨跌两个方向共用「回撤」这一把尺子，反弹和回调是对称的。 */
    contiguousRun(bars, dir, tol) {
      const n = bars.length;
      if (!n || !dir) return null;
      const eps = Math.max(0.01, tol);
      let anchor = n - 1;
      let dd = 0;                                  // 当前段内的最大回撤（%）
      let suffixMin = bars[n - 1].close;           // i 之后出现过的最低价
      for (let i = n - 2; i >= 0; i--) {
        const c = bars[i].close;
        if (!isFinite(c) || c <= 0) break;
        /* 把 c 扩进段里，会新增一段「从 c 跌到之后最低点」的回撤；
         * 和已有回撤取大者。超过噪声就说明中间反过向，段从这里断开。 */
        const ddNew = Math.max(dd, (c - suffixMin) / c * 100);
        if (ddNew > eps) break;
        dd = ddNew;
        suffixMin = Math.min(suffixMin, c);
        anchor = i;
      }
      const from = bars[anchor].close;
      const cum = from > 0 ? (bars[n - 1].close - from) / from * 100 : 0;
      // 方向对不上（比如要上涨段，但这段整体是跌的）→ 不算这一段
      if (Math.sign(cum) !== Math.sign(dir) && Math.abs(cum) > 0.02) return null;
      return {
        idx: anchor,
        at: bars[anchor].time,
        from: from,
        cum: cum,
        durMin: Math.max(0, Math.round((bars[n - 1].time - bars[anchor].time) / 60)),
      };
    }

    /** 当日（最近的连续交易时段）窗口极值 —— 喂给 VolBank */
    sessionMax(bars, win) {
      const step = this.barStep(bars);
      const need = Math.max(1, Math.round(win / step));
      const n = bars.length;
      if (n < need + 1) return 0;
      const lastT = bars[n - 1].time;
      let mx = 0;
      for (let i = n - 1; i >= need; i--) {
        if (lastT - bars[i].time > 16 * 3600) break;      // 只算当前这一节
        const from = bars[i - need];
        if (Math.round((bars[i].time - from.time) / 60) !== win) continue;
        const f = from.close;
        if (!(f > 0)) continue;
        const a = Math.abs((bars[i].close - f) / f * 100);
        if (a > mx) mx = a;
      }
      return mx;
    }

    /**
     * 单尺度阈值 = 动态波动率库 × 当日波动强度 × 全局系数，再夹在分类上下限内
     *
     * 注意：短尺度（1/2/3 分钟）的静态先验里**已经含了 1.25 的阻尼**
     * （见 tools/thr_short.py），这里不再二次放大 —— 否则今天的
     * 科创50 15 分钟 +3.5% 会被 4.49% 的门槛挡在门外。
     */
    thrOf(k, win, staticThr) {
      const VP = w.VolProfile;
      if (!VP) return { thr: staticThr, src: 'static', n: 0 };
      const d = VP.dynThreshold(k, win, staticThr, TARGET_RATE[win] || 0.05);
      let thr = d.thr;

      // 当日已经很躁动 → 尺子适度放宽；上限 1.15 倍（否则会压住正在发生的暴力行情）
      const lv = VP.liveVol(k, win);
      if (lv > 1) thr *= Math.min(1.15, lv);

      const cls = VP.classOf(k).cls;
      thr = Math.max(cls.floor, Math.min(cls.ceil, thr));
      thr *= this.thrScale;

      this.calib[k + ':' + win] = { t: Date.now(), thr: thr, src: d.src };
      return { thr: +thr.toFixed(3), src: d.src, n: d.n, w: d.w };
    }

    /** 历史画像回填（后台异步，扫描只读缓存） */
    async loadProfiles() {
      if (this._profBusy) return;
      this._profBusy = true;
      try {
        const list = U.RADAR;
        const wins = [5, 15, 30];
        await Promise.all(list.map(async t => {
          for (const win of wins) {
            try {
              const p = await w.VolProfile.profile(t.k, win);
              if (!p) continue;
              this.prof[t.k + ':' + win] = p;
              // 精确回填：覆盖之前盘中观测到的临时值
              w.VolProfile.VolBank.ingestDays(t.k, win, p.perDay);
            } catch (e) { /* 单个失败不拖累其他 */ }
          }
        }));
        this.profAt = Date.now();
        this.calib = {};
        try { w.VolProfile.VolBank.save(true); } catch (e) {}
        if (this.onProfile) this.onProfile(this.prof);
        if (this.onProfile) setTimeout(() => this.scan(), 200);
      } finally {
        this._profBusy = false;
      }
    }

    async scan() {
      if (this.busy) return;
      this.busy = true;
      this.scans++;
      this.lastScanAt = Date.now();
      this.nextScanAt = Date.now() + (this.interval || 20000);

      /* 跨天检查：预警账按交易日分桶。
       * 昨天弹过的，今天是新的行情 —— 不该继承昨天的「已预警」记录。
         * （美股交易时段跨北京时间的午夜，但自然日切换正好落在美股收盘后，
         *  此时该品种本就没有新异动，账目清空是安全的。） */
      const today = this.alertDay();
      if (this.alertStateDay && this.alertStateDay !== today) {
        this.alertState = {};
        this.alertStateDay = today;
        this.alertedAt = {};
        this.alertedAmp = {};
        try { this.saveAlertState(); } catch (e) {}
      } else if (!this.alertStateDay) {
        this.alertStateDay = today;
      }
      /* 横幅账本同样按自然日分桶 —— 新的一天是新的行情 */
      if (this.bannerStateDay && this.bannerStateDay !== today) {
        this.bannerState = {};
        this.bannerStateDay = today;
        try { this.saveBannerState(); } catch (e) {}
      } else if (!this.bannerStateDay) {
        this.bannerStateDay = today;
      }

      const targets = U.RADAR;
      const results = [];
      const nowEpoch = Date.now() / 1000;

      if (!this.profAt || Date.now() - this.profAt > 60 * 60000) {
        this.loadProfiles();
      }

      await Promise.all(targets.map(async (t) => {
        const a = U.get(t.k);
        try {
          const bars = await w.API.minutes(t.k, 480);
          if (!bars || bars.length < 4) throw new Error('thin');

          const n = bars.length;
          const last = bars[n - 1].close;

          // ---- 六个尺度各自算一遍 ----
          const hits = [];
          for (const s of t.scales) {
            const ww = this.winWindow(bars, s.win);
            if (!ww.ok) continue;                 // 粒度不够 / 有缺口 → 该尺度本轮放弃
            const from = ww.from.close;
            const chg = from ? ((last - from) / from) * 100 : 0;
            let hi = -Infinity, lo = Infinity;
            for (let i = n - ww.span; i < n; i++) {
              if (bars[i].high > hi) hi = bars[i].high;
              if (bars[i].low < lo) lo = bars[i].low;
            }
            const amp = from ? ((hi - lo) / from) * 100 : 0;
            const th = this.thrOf(t.k, s.win, s.thr);
            hits.push({
              win: s.win, chg: chg, amp: amp, thr: th.thr, src: th.src, n: th.n,
              warm: th.warm,
              fromT: ww.from.time, fromC: from,
              ratio: Math.abs(chg) / (th.thr || 1)
            });
            // 顺手喂波动率库（当天窗口极值，只增不减）
            const sm = this.sessionMax(bars, s.win);
            if (sm > 0) w.VolProfile.VolBank.observe(t.k, s.win, sm);
          }

          // 5 分钟窗口的消耗比例：短尺度越线时用它做「同向推力」闸门
          const h5 = hits.find(x => x.win === 5);
          const r5 = h5 ? h5.ratio : 0;
          for (const h of hits) {
            if (h.win > 5) continue;
            // 1/2/3 分钟：单笔异常成交打出来的插针不会同向推动 5 分钟窗口
            if (h.win <= 3) h.gated = r5 < CROSS_GATE;
          }

          /* ---------------- 当日尺度（跳空 / 慢跌） ----------------
           * 分钟窗口有两个天生盲区，而用户看到的恰恰是这两种：
           *   ① 跳空：跌幅在开盘第一根 bar 之前就走完了，窗口一律看不到；
           *   ② 慢跌：每分钟只跌 0.1%，40 分钟累计 -4%，5 分钟窗口永远不越线。
           * 用户截图里 VIX 从 20.83 跌到 17.21（-17.4%），分钟口径全都是「平静」，
           * 于是异动页毫无反应 —— 这不是阈值高低，是**尺子只量了短边**。
           * 所以加一条「当日」伪命中：日内涨跌幅超过 5 分钟阈值的 3.2 倍（且不低于 1.5%）
           * 就算异动，让它能进预警、能进矩阵、能被归因。
           */
          let dayPct = 0, dayFrom = 'prev', dayPrev = 0;
          const q0 = (w.API && w.API.cachedQuote) ? w.API.cachedQuote(t.k) : null;
          if (q0 && q0.prev > 0) {
            dayPrev = q0.prev;
            dayPct = (last - dayPrev) / dayPrev * 100;
          } else if (a.src === 'cboe' && w.API && w.API.cboeQuote) {
            // VIX 的批量快照不一定在缓存里，直接问 CBOE（25 秒缓存，不会重复打）
            try {
              const cq = await w.API.cboeQuote();
              dayPrev = cq.prev; dayPct = cq.pct;
            } catch (e) { /* 走下面的兜底 */ }
          }
          if (!dayPrev) {
            const ss0 = this.sessionStart(bars, this.barStep(bars));
            const f0 = bars[Math.max(0, ss0)].close;
            dayPrev = f0;
            dayPct = f0 > 0 ? (last - f0) / f0 * 100 : 0;
            dayFrom = 'open';
          }

          const h5thr = (hits.find(x => x.win === 5) || {}).thr || t.t5 || 1;
          /* 当日阈值：同一天内只降不升，避免动态阈值飘动导致命中状态抖动 */
          const rawDayThr = Math.max(h5thr * 3.2, 1.5);
          const dayKey = new Date(bars[n - 1].time * 1000).toDateString();
          if (this.dayBase[t.k] && this.dayBase[t.k].d !== dayKey) delete this.dayBase[t.k];
          const b0 = this.dayBase[t.k];
          const dayThr = b0 ? Math.min(b0.v, rawDayThr) : rawDayThr;
          this.dayBase[t.k] = { d: dayKey, v: dayThr };

          /* ---------------- 当日命中的「新鲜度」 ----------------
           * 用户报（原话）：「图二显示以太坊异动剧烈波动预警，但点进行情发现
           * 以太坊剧烈波动的时间其实是昨天晚上 10 点到 11 点那个时间段，
           * 现在其实是它交易比较冷清的时间段，在分时图上也没有看到剧烈波动，
           * 所以这个异动的预警是有问题的。」
           *
           * 根因：当日尺度（win=0）**命中就算 quick，不等第二轮**（见下面的 quick 判定），
           * 于是「今天累计涨了 7%」这件已经过去 13 小时的事，每轮扫描都会重新
           * 弹一次「突发剧烈异动」。分时图上早就是一条平线了。
           *
           * 判据：最近 15/30 分钟得真在动 ——
           *   同向变动 ≥ 该窗口阈值的 35%（且不低于 0.15%），
           *   或者 ≥ 当日幅度的 8%（大行情里的小回调也算还在推进）。
           * 不满足 → 这条当日命中只留在 hits 里供 UI 显示「今日累计 / 近 24 小时」，
           * 不参与 best 选择、不触发预警。异动已经走完，就不该再喊。 */
          /* ---------------- 波动率状态（本轮的核心判据） ----------------
           * 见文件顶部「波动率状态」注释。一句话：
           * 异动是**状态**（现在有没有在震），不是**结果**（今天累计涨了多少）。
           * z = 最近 15 分钟的已实现波动率 / 当日基线波动率。 */
          const rvNow = realizedVol(bars, 15);
          const rvBase = volBaseline(bars, 15);
          /* 基线还没攒够样本（开盘头一小时）时不要把 z 算爆表 ——
           * 那时 floor 是唯一参照，任何小抖动都会显得「异常活跃」。
           * 样本不足就直接给中性值 1，让幅度判据单独工作。 */
          const rvRef = rvBase > 0 ? Math.max(rvBase, volFloor(t.k)) : 0;
          const volZ = rvRef > 0 ? rvNow / rvRef : 1;

          const hv15 = hits.find(x => x.win === 15);
          const hv30 = hits.find(x => x.win === 30);
          const recentMag = Math.max(hv15 ? Math.abs(hv15.chg) : 0, hv30 ? Math.abs(hv30.chg) : 0);
          /* 门槛：既要压过该窗口阈值的三分之一（正常的「还在动」），
           * 也要占到当日幅度的 12% 以上 —— 否则「跌了 5% 之后反弹 0.3%」
           * 也会被当成「还在推进」，一天的行情永远不结束。
           * 另外 z 够高（波动率明显高于常态）也直接认为新鲜：
           * 这才是「现在真的在震」的直接证据，比幅度间接判断可靠。 */
          const recentNeed = Math.max(
            hv30 ? hv30.thr * 0.35 : 0,
            hv15 ? hv15.thr * 0.35 : 0,
            0.15,
            Math.abs(dayPct) * 0.12
          );
          const dayFresh = recentMag >= recentNeed || volZ >= FRESH_Z;

          if (Math.abs(dayPct) >= dayThr) {
            hits.push({
              win: 0, day: true,
              chg: dayPct, amp: Math.abs(dayPct),
              thr: +dayThr.toFixed(3), src: 'day', n: 0,
              fromT: bars[Math.max(0, this.sessionStart(bars, this.barStep(bars)))].time,
              fromC: dayPrev,
              ratio: Math.abs(dayPct) / dayThr,
              /* fresh=false = 这波异动早就走完了，只剩一个当日累计的数字 */
              fresh: dayFresh,
              recentMag: +recentMag.toFixed(3),
              recentNeed: +recentNeed.toFixed(3),
            });
          }

          /* 开盘跳空占比 —— 决定 UI 该说「跳空低开」还是「近 N 分钟持续下跌」。
           * 用户口径：「VIX 跳水已经超过半小时了，应该写近多少时间持续下跌」。
           * 但如果跌幅其实全在开盘第一根 bar 上走完，说「持续 46 分钟下跌」就是撒谎，
           * 那种情况正确的说法是「今日跳空低开 x%」。两个口径必须分开存。 */
          let gapPct = 0, openC = 0;
          if (dayPrev > 0) {
            const si0 = Math.max(0, this.sessionStart(bars, this.barStep(bars)));
            openC = bars[si0] ? bars[si0].close : last;
            if (openC > 0) gapPct = (openC - dayPrev) / dayPrev * 100;
          }

          // ---- 选「最越线」的那个尺度作为本次结果 ----
          /* 陈旧的当日命中（fresh=false）不参与：那只是「今天涨了 7%」这个静态事实，
           * 不是「现在正在异动」。它在 hits 里留着，UI 照样能显示累计幅度。 */
          const alive = hits.filter(h => !(h.win === 0 && h.fresh === false));
          let best = null;
          for (const h of alive) {
            if (h.ratio >= 1 && !h.gated && (!best || h.ratio > best.ratio)) best = h;
          }
          // 没越线时，展示最接近的那个尺度，便于看板显示「逼近阈值」
          if (!best) {
            for (const h of alive) if (!best || h.ratio > best.ratio) best = h;
          }

          // binance / cboe 给的是真实 UTC epoch；东财是「北京时字面量当作 UTC」，要减掉本机时区
          const barEpoch = (a.src === 'binance' || a.src === 'cboe')
            ? bars[n - 1].time : bars[n - 1].time - this.wallskew;
          const ageMin = Math.max(0, (nowEpoch - barEpoch) / 60);
          /* 陈旧判定要留出「数据源本身延迟」的余量：
           * CBOE 官方口径就是延迟 15 分钟，按 25 分钟卡会把正常交易中的 VIX
           * 判成「休市」—— 用户截图里 VIX 正在暴跌 -17%，面板却写「休市」，
           * 根因就是这里没算延迟。 */
          const delayMin = (a.src === 'cboe') ? 18 : 0;
          const stale = a.grp !== 'crypto'
            && ageMin > Math.max((best && best.win ? best.win : 30) * 3 + 8, 25) + delayMin;

          // ---- 触发判定 ----
          // 1/2/3 分钟：1.4~1.5 倍直接报，不等下一轮（等 20 秒，行情可能已经走完）
          // 5 分钟：1.6 倍直接报，否则连续两轮
          // 15/30 分钟：必须连续两轮（防止单根插针把长窗口也污染掉）
          let alarm = false;
          let holding = false;
          const prev = this.hitState[t.k];
          if (best && best.ratio >= 1 && !best.gated) {
            /* 当日尺度（win=0）本身就是「已经持续了一整天」的确认，不需要再等第二轮；
             * 但它必须**新鲜**（dayFresh）—— 否则「今天累计涨了 7%」
             * 这件 13 小时前的事会每轮重弹一次（用户报的以太坊误报）。 */
            const quick = best.win === 0
              ? (best.fresh !== false)
              : (best.win <= 5 && best.ratio >= (FAST_MULT[best.win] || 1.6));
            const sustained = prev && prev.hit && (best.win === 0 || prev.win === best.win)
              && (nowEpoch - prev.at) < 180;
            alarm = quick || sustained;
          }
          /* ---------------- 异动的「维持」 ----------------
           * 用户口径：「上午 +5% 回落到 +1% 这种本身就是高波动的杀盘，
           * 本身就已经够预警了。」
           *
           * 这一路窗口涨跌幅在收敛（甚至反转），幅度判据会认为「没扩大」而掉回平静；
           * 但盘面明明还在剧烈波动。所以只要**波动率仍然高于常态**（volZ ≥ HOLD_Z），
           * 就把异动状态维持住 —— 异动是状态，不是「累计涨了多少」这个结果。
           * 退出条件同样干净：volZ 掉回 1 附近（真的平静了）就自动退出。 */
          if (!alarm && this.alarmOn[t.k] && volZ >= HOLD_Z) {
            alarm = true; holding = true;
          }
          this.alarmOn[t.k] = alarm;
          this.hitState[t.k] = {
            hit: !!(best && best.ratio >= 1 && !best.gated),
            win: best ? best.win : 0,
            at: nowEpoch
          };

          /* ---------------- 持续时间与当日涨跌 ----------------
           * 用户口径（原话）：「如果 5 分钟内暴跌，一直持续了 10 分钟、又持续了半小时，
           * 而且跌幅一直扩大，那异动和预警里就要显示 30 分钟跌幅扩大到多少、日跌幅多少，
           * 而不是傻傻只显示 5 分钟的变化 —— 图二实际布油累计跌幅很大，但只显示短时间的。」
           *
           * 所以除了窗口幅度，再跟一条「从起点累计」的线：
           *   起点 = 第一次越线那一轮的窗口起始 bar
           *   同向且幅度超过历史峰值 → expanding（还在扩大）
           *   回吐超过峰值一半 / 方向反转 / 跨节超过 6 小时 → 本次结束
           */
          const br0 = this.bursts[t.k];
          const noise = this.runNoise(bars);
          /* 方向：优先跟本轮命中方向；本轮没命中就沿用已有 burst 的方向 */
          const dirNow = (best && Math.abs(best.chg) > 1e-9)
            ? (best.chg > 0 ? 1 : -1)
            : (br0 ? br0.dir : 0);
          // 连续同向的那一段（中间不允许出现超过噪声的反向）
          const seg = dirNow ? this.contiguousRun(bars, dirNow, noise) : null;

          if (br0) {
            const cumNow = seg ? seg.cum : 0;
            const sameDir = !!(seg && Math.sign(cumNow) === br0.dir);
            // 「当日」命中的起点本来就是当天开盘，别用 6 小时把它反复掐断
            const aged = !br0.day && (bars[n - 1].time - br0.at) > 6 * 3600;
            /* 连续段已经不成立（中间出现过像样反弹），或者幅度萎缩到峰值的三分之一，
             * 就认定这一波结束。不能再挂着「持续 109 分」的牌子 —— 那是在骗人。 */
            const over = !sameDir || Math.abs(cumNow) < br0.peak * 0.34 || aged;
            if (over) {
              delete this.bursts[t.k];
              /* 一波走完，预警账本里的「幅度基准」也跟着清零 ——
               * 下一波要能重新提醒。
               * 用户口径：「上午冲高回落，下午再冲高或跳水，就应该再次提醒」。
               * 只清幅度、**保留时间戳**：冷却期继续生效，
               * 否则在阈值附近来回穿越时会被 reset 绕开冷却、反复弹窗。 */
              this.resetAlertedAmp(t.k);
            } else { br0.at = seg.at; br0.from = seg.from; }
          }
          if (!this.bursts[t.k] && seg && best && best.ratio >= 1 && !best.gated) {
            const ssIdx = Math.max(0, this.sessionStart(bars, this.barStep(bars)));
            this.bursts[t.k] = {
              at: seg.at,
              from: seg.from,
              dir: seg.cum >= 0 ? 1 : -1,
              peak: Math.abs(seg.cum),
              peakAt: bars[n - 1].time,
              win: best.win,
              /* day=true 只在「连续段确实从开盘一路走下来」时成立；
               * 盘中回调过再跌，就不该说「今日」，那一段的时长另有意义。 */
              day: !!best.day && seg.idx <= ssIdx + 1,
              gapPct: gapPct,
              openC: openC || last,
            };
          }
          let run = null;
          const B = this.bursts[t.k];
          if (B) {
            const cum = B.from > 0 ? (last - B.from) / B.from * 100 : 0;
            const mag = Math.abs(cum);
            if (mag > B.peak + 1e-9) { B.peak = mag; B.peakAt = bars[n - 1].time; }
            B.cum = cum;
            B.durMin = Math.max(0, Math.round((bars[n - 1].time - B.at) / 60));
            run = {
              dir: B.dir, from: B.from, at: B.at,
              durMin: B.durMin, cum: cum, peak: B.peak,
              peakMin: Math.max(0, Math.round((B.peakAt - B.at) / 60)),
              expanding: mag >= B.peak - 1e-9,
              win: B.win,
              // day=true：起点是「当天开盘 / 昨收」，UI 显示「今日」而不是「已持续 N 分」
              day: !!B.day,
              // 这一波有多少是开盘跳空一次走完的（用于区分「跳空」与「持续下跌」）
              gapPct: B.gapPct || 0,
              // 开盘后这一段走了多少 —— 「近 N 分钟持续下跌 x%」用的是这个，不含跳空
              openPct: (B.openC > 0) ? (last - B.openC) / B.openC * 100 : 0,
            };
          }

          /* v100：先取「具体归因新闻」，再决定 attributed / unattributed。
           * 只认事件型快讯（newsCause 由 app.js 用 newsFor(..., ['cause']) 提供），
           * 行情播报类不会出现在这里，避免「黄金下跌归因到黄金下跌 5%」的循环论证。 */
          const cause = this.newsCause(t.k, 25);
          const r = {
            key: t.k, name: U.fullName(t.k), short: U.name(t.k),
            chg: best ? best.chg : 0,
            amp: best ? best.amp : 0,
            thr: best ? best.thr : (t.t5 || 1),
            win: best ? best.win : 30,
            scale: scaleOf(best ? best.win : 30),
            last: last,
            gap: !hits.length,
            bp: a.kind === 'yield' ? (best ? best.chg : 0) * last / 100 : null,
            at: Date.now(), ageMin: ageMin,
            dayPct: dayPct, dayFrom: dayFrom, run: run,
            hits: hits,
            thrSrc: best ? best.src : 'prior',
            thrScaleDays: best ? best.n : 0,
            gate: !!(best && best.gated),
            /* 波动率状态：volZ = 当前 15 分钟已实现波动率 / 当日基线。
             * 1 附近 = 常态；≥2 = 明显在震；<1 = 一潭死水。
             * holding = 这轮没有新的越线窗口，但波动率还高，所以异动状态继续保持。 */
            volZ: +volZ.toFixed(2),
            rv: +rvNow.toFixed(3),
            holding: !!(alarm && !(best && best.ratio >= 1 && !best.gated)),
            status: stale ? 'closed' : (!alarm ? 'quiet'
              : (cause ? 'attributed' : 'unattributed')),
            /* v100：把具体归因新闻挂到结果上，列表/卡片才能写出「因为哪件事」。 */
            cause: cause || null,
            /* 有新闻但不能当原因（纯行情播报）—— 让 UI 说「只有播报，没有事件」，
             * 而不是含糊地显示「无消息」，两者含义完全不同。 */
            echoOnly: !stale && alarm && !cause && this.newsEchoOnly(t.k, 25)
          };
          results.push(r);

          if (r.status === 'unattributed' || r.status === 'attributed') {
            const prevAt = this.alertedAt[t.k] || 0;
            const curAmp = this.ampOf(r);
            const lastAmp = this.alertedAmp[t.k] || 0;
            /* 判「这次扩大得明不明显」用的尺子 = 该品种自己的波动尺度。 */
            const sigma = this.sigmaOf(r);
            // 冷却：闪崩尺度最激进但最容易重复（同一段行情 1/2/3 分钟会连着越线），
            // 冷却期最短；已归因的（消息驱动）拉长，避免一条新闻反复弹。
            const cool = r.status === 'attributed' ? this.cooldown * 2
              : r.scale === 'flash' ? this.cooldown * 0.4
                : r.scale === 'fast' ? this.cooldown * 0.6
                  : this.cooldown;
            // 首次必报；之后必须「冷却期已过」且「按自身波动率算确实在明显扩大」才再报。
            if (ampGate(curAmp, lastAmp, sigma, cool, prevAt, Date.now())) {
              this.alertedAt[t.k] = Date.now();
              this.alertedAmp[t.k] = Math.max(lastAmp, curAmp);
              /* 落盘 —— 否则关掉 app 再打开，alertedAt 清零，
               * ampGate 走「首次必报」分支，所有异动全部重弹一遍。 */
              this.markAlerted(t.k, this.alertedAmp[t.k]);
              if (r.status === 'unattributed') this.hits++;
              this.log.unshift(Object.assign({ kind: r.status }, r));
              this.log = this.log.slice(0, 60);
              if (r.status === 'unattributed') this.onAlert(r);
            }
          }
        } catch (e) {
          results.push({
            key: t.k, name: U.fullName(t.k), short: U.name(t.k),
            chg: 0, amp: 0, thr: +(t.t5 * this.thrScale).toFixed(2), win: 5,
            scale: 'fast', last: null, at: Date.now(), ageMin: 999,
            hits: [], status: 'offline'
          });
        }
      }));

      // 波动率库定期落盘
      try { w.VolProfile.VolBank.save(false); } catch (e) {}

      results.sort((a, b) => {
        const ia = targets.findIndex(x => x.k === a.key);
        const ib = targets.findIndex(x => x.k === b.key);
        return ia - ib;
      });
      results.forEach(r => { this.state[r.key] = r; });
      this.busy = false;
      this.onUpdate(results, this);
    }

    /** 当前处于异动状态的品种（含新闻验证出来的） */
    active() {
      return Object.values(this.state).filter(r =>
        r.status === 'unattributed' || r.status === 'attributed' || r.status === 'news-confirmed');
    }

    /** 某尺度的静态标定阈值（新闻验证的兜底基准） */
    staticThrOf(k, win) {
      const t = (U.RADAR || []).find(x => x.k === k);
      if (!t) return 0.5;
      const map = { 1: t.t1, 2: t.t2, 3: t.t3, 5: t.t5, 15: t.t15, 30: t.t30 };
      return map[win] || t.t5 || 0.5;
    }

    /** 某尺度「当前真正生效」的阈值（含动态波动率 + 冷却系数），新闻验证用这个 */
    liveThrOf(k, win) {
      return this.thrOf(k, win, this.staticThrOf(k, win)).thr;
    }

    /**
     * 新闻驱动异动：新闻声称某品种「突然拉升 / 暴跌」→ 拿真实分钟线验证
     *
     * 与 scan() 的分工（用户原话）：
     *   「我是怕你有时候抓不到这个异动，所以通过媒体报道来补充。
     *     如果说你自己都有抓到，那就不需要这个补充。」
     *   → 这是**兜底通道**：行情链路没抓到时，新闻链路补一条。
     *     所以先看该品种是否已经在异动名单里，是就不重复。
     */
    async ingestNews(items) {
      if (!w.NewsSpike || !items || !items.length) return [];
      const found = [];
      const queue = [];
      const now = Date.now();

      for (const it of items) {
        if (!it || it.demo) continue;
        if (it.live === false) continue;
        if (!it.ts || now - it.ts > 8 * 3600 * 1000) continue;
        const sp = w.NewsSpike.detect(it);
        if (!sp) continue;
        // 新闻条目可能带 assets（原始），也可能只有 direct（渲染后），两种都认
        const raw = (it.assets && it.assets.length)
          ? it.assets
          : (it.direct || []).map(x => (x && x.k) || x);
        const keys = raw.filter(k => k && U.get(k) && U.get(k).kind !== 'stock').slice(0, 2);
        if (!keys.length) continue;
        queue.push({ it: it, sp: sp, keys: keys });
        if (queue.length >= 6) break;
      }
      if (!queue.length) return [];

      for (const q of queue) {
        for (const k of q.keys) {
          // 行情链路已经抓到 → 不重复报（用户口径：新闻只是补充）
          const st = this.state[k];
          if (st && (st.status === 'unattributed' || st.status === 'attributed')
            && Date.now() - (st.at || 0) < 40 * 60000) {
            if (!q.it.spike) q.it.spike = {};
            q.it.spike[k] = { ok: true, actual: st.chg, need: st.thr, dir: st.chg >= 0 ? 1 : -1,
              reason: 'caught-by-radar', win: st.win, at: st.at };
            continue;
          }

          let bars;
          try {
            bars = await w.API.minutes(k, 480);
          } catch (e) { continue; }
          if (!bars || bars.length < 4) continue;

          // 六个尺度都试：新闻说「闪崩」可能真是 1 分钟的事，
          // 说「走低」可能是半小时的趋势。门槛用**当前生效的动态阈值**，
          // 而不是静态先验 —— 否则日波动率已经放大时，新闻补获会失灵。
          const v = w.NewsSpike.verifyMulti(q.sp, bars, [1, 2, 3, 5, 15, 30],
            (win) => this.liveThrOf(k, win), q.it.ts);
          if (!q.it.spike) q.it.spike = {};
          q.it.spike[k] = v;

          if (v.ok !== true) continue;

          const last = bars[bars.length - 1];
          const r = {
            key: k,
            name: U.fullName(k),
            short: U.name(k),
            chg: v.actual,
            amp: Math.abs(v.actual),
            dir: v.dir,
            thr: v.thr,
            win: v.win || 30,
            scale: scaleOf(v.win || 30),
            last: last.close,
            at: Date.now(),
            kind: 'news',
            news: {
              id: q.it.id, title: q.it.title, src: q.it.src,
              url: q.it.url, ts: q.it.ts, level: q.it.level
            },
            need: v.need,
            status: 'news-confirmed'
          };
          found.push(r);
          this.log.unshift(r);
          this.log = this.log.slice(0, 60);
          this.newsLog.unshift(r);
          this.newsLog = this.newsLog.slice(0, 20);
          this.hits++;
          this.alertedAt[k] = Date.now();
          /* 新闻驱动的异动也要落盘，否则重启后同一条新闻会再次触发轻提示 */
          this.markAlerted(k, this.alertedAmp[k] || Math.abs(r.chg || 0));
          this.onAlert(r);
        }
      }
      return found;
    }
  }

  w.Radar = Radar;
  w.ampGate = ampGate;
})(window);
