/* ============================================================
 * session.js — 各市场交易时段判定
 * 用途：行情页标注「交易中 / 盘前 / 盘后 / 休市」，
 *      非交易时段改用链上价或延展时段价（见 api.js 的 alt）。
 * 说明：只做工作日 + 时段判断，不含各国节假日（节假日会显示为「休市·无成交」，
 *      价格停留在最后收盘价，不会伪造成实时）。
 * ============================================================ */
(function (w) {
  'use strict';

  const TZ = {
    cn: 'Asia/Shanghai',
    hk: 'Asia/Hong_Kong',
    jp: 'Asia/Tokyo',
    kr: 'Asia/Seoul',
    tw: 'Asia/Taipei',
    us: 'America/New_York'
  };

  // 取某时区的日期分量（避免依赖用户本机时区）
  const fmtCache = {};
  function zoned(tz, date) {
    let f = fmtCache[tz];
    if (!f) {
      f = fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short'
      });
    }
    const o = {};
    f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
    let hh = parseInt(o.hour, 10);
    if (hh === 24) hh = 0;
    return {
      y: +o.year, m: +o.month, d: +o.day, wd: wd,
      hh: hh, mm: +o.minute,
      mins: hh * 60 + +o.minute
    };
  }

  const inR = (m, a, b) => m >= a && m < b;

  /* session 定义
   * weekdays: [1..5]；segs: 常规时段；pre/post: 延展时段
   * 时段用交易所当地时间的分钟数表示
   */
  const SESSIONS = {
    cn: {
      tz: TZ.cn, weekdays: [1, 2, 3, 4, 5],
      segs: [[570, 690], [780, 900]],       // 09:30-11:30 / 13:00-15:00
      name: 'A股'
    },
    hk: {
      tz: TZ.hk, weekdays: [1, 2, 3, 4, 5],
      segs: [[570, 720], [780, 960]],       // 09:30-12:00 / 13:00-16:00
      name: '港股'
    },
    apac: {
      // 日经 / KOSPI 取并集（08:00-14:30 北京时间），只要有一家开市就算「亚太交易中」
      tz: TZ.jp, weekdays: [1, 2, 3, 4, 5],
      segs: [[540, 690], [750, 900]],
      name: '亚太'
    },
    kr: {
      // 韩国 KOSPI：09:00-15:30（首尔时间，无午休）
      // v146：补上盘前（08:30 开市前集合竞价）与盘后（15:30–18:00 KRX 延长交易），
      // 否则韩股个股在延展时段只能显示「休市」，拿不到盘后价。
      tz: TZ.kr, weekdays: [1, 2, 3, 4, 5],
      segs: [[540, 930]],
      pre: [510, 540], post: [930, 1080],
      preHint: '盘前时段 08:30–09:00 KST',
      postHint: '盘后时段 15:30–18:00 KST',
      name: '韩股'
    },
    jp: {
      // 东京证交所：09:00-11:30 / 12:30-15:30（东京时间）
      tz: TZ.jp, weekdays: [1, 2, 3, 4, 5],
      segs: [[540, 690], [750, 930]],
      name: '日股'
    },
    tw: {
      // 台湾证交所：09:00-13:30（台北时间，与北京同区）
      // v146：补盘后固定交易 14:00–14:30（台北时间）。台股没有独立盘前集合竞价，
      // 所以只加 post，不加 pre。
      tz: TZ.tw, weekdays: [1, 2, 3, 4, 5],
      segs: [[540, 810]],
      pre: [510, 540], post: [810, 870],
      preHint: '盘前时段 08:30–09:00 台北',
      postHint: '盘后时段 13:30–14:30 台北',
      name: '台股'
    },
    us: {
      tz: TZ.us, weekdays: [1, 2, 3, 4, 5],
      segs: [[570, 960]],                   // 09:30-16:00 ET
      pre: [240, 570], post: [960, 1200],   // 04:00-09:30 / 16:00-20:00 ET
      name: '美股'
    },
    rate: {
      /* v237：旧定义按「现货 08:00-17:00 ET」判，北京白天整段被误标休市，
       * 可数据源（东财）给的是近 23 小时滚动窗口（fullMinutes('rate')=1380），
       * 分时线仍在走却写「休市」。改成跟外汇一样的 24×5 电子盘口径。 */
      tz: TZ.us, weekdays: [0, 1, 2, 3, 4, 5], weekly: true,
      segs: [[0, 1440]],
      name: '美债'
    },
    fx: {
      // 外汇 24×5：周五 17:00 ET 收，周日晚 17:00 开
      tz: TZ.us, weekdays: [0, 1, 2, 3, 4, 5], weekly: true,
      segs: [[0, 1440]],
      name: '外汇'
    },
    cmdty: {
      // CME Globex：周日 18:00 – 周五 17:00 ET，每日 17:00-18:00 结算暂停
      tz: TZ.us, weekdays: [0, 1, 2, 3, 4, 5], cme: true,
      segs: [[0, 1020], [1080, 1440]],
      name: '商品'
    },
    vix: {
      /* VIX 恐慌指数（CBOE 现货指数）不是「美股盘前盘后」，而是近 24/5：
       * 周日 20:15 ET 开 GTH → 连续到周五 16:15 ET，工作日每天只有
       * 16:15–20:15 ET 维护休市（外加 09:25–09:30 的 5 分钟 RTH 切换缺口）。
       * 所以不能用 judge('us') 的 pre/post 套它 —— 美东凌晨 3 点美股休市，
       * 但 VIX 正在 GTH 交易。 */
      tz: TZ.us, weekdays: [0, 1, 2, 3, 4, 5], vix24: true,
      name: 'VIX恐慌指数'
    },
    crypto: { tz: TZ.cn, always: true, name: '加密' }
  };

  function judge(type, now) {
    const cfg = SESSIONS[type];
    if (!cfg) return { open: false, phase: 'closed', label: '休市', hint: '' };
    if (cfg.always) return { open: true, phase: 'regular', label: '7×24', hint: '连续交易' };

    const z = zoned(cfg.tz, now);
    const wd = z.wd, m = z.mins;

    // 加密/外汇/商品的周末规则
    if (cfg.weekly) {
      if (wd === 6) return { open: false, phase: 'closed', label: '休市', hint: '周末外汇休市' };
      if (wd === 0) {
        // 周日 17:00 ET 之后开盘
        if (m >= 1020) return { open: true, phase: 'regular', label: '交易中', hint: '' };
        return { open: false, phase: 'closed', label: '休市', hint: '周日晚 17:00 ET 开盘' };
      }
      /* 周五 17:00 ET 收盘 —— 漏了这条会把「北京时间周六上午」判成交易中，
       * 因为那时美东还是周五 22~23 点。用户看到的周六外汇「交易中」
       * 假象就是这么来的。 */
      if (wd === 5 && m >= 1020) {
        return { open: false, phase: 'closed', label: '休市', hint: '周五 17:00 ET 收盘，周日晚 17:00 重开' };
      }
      return { open: true, phase: 'regular', label: '交易中', hint: '' };
    }
    if (cfg.cme) {
      if (wd === 6) return { open: false, phase: 'closed', label: '休市', hint: '周末休市' };
      if (wd === 0) {
        if (m >= 1080) return { open: true, phase: 'regular', label: '夜盘', hint: '电子盘' };
        return { open: false, phase: 'closed', label: '休市', hint: '周日 18:00 ET 开盘' };
      }
      if (wd === 5 && m >= 1020) return { open: false, phase: 'closed', label: '休市', hint: '周五 17:00 ET 收盘' };
      const open = cfg.segs.some(([a, b]) => inR(m, a, b));
      return open
        ? { open: true, phase: 'regular', label: m >= 1080 || m < 360 ? '夜盘' : '交易中', hint: '' }
        : { open: false, phase: 'closed', label: '结算中', hint: '每日 17:00–18:00 ET 暂停' };
    }
    if (cfg.vix24) {
      /* CBOE VIX 现货指数（近 24/5）：
       * 周日 20:15 (1215) ET 开盘；工作日 00:00–09:25 是 GTH 延续、09:30–16:15 (975) 是 RTH、
       * 20:15–24:00 又是 GTH；每天休市窗口 = 09:25–09:30（5 分钟）与 16:15–20:15（维护）。 */
      if (wd === 6) return { open: false, phase: 'closed', label: '休市', hint: '周末休市' };
      if (wd === 0) {
        if (m >= 1215) return { open: true, phase: 'regular', label: '交易中', hint: 'CBOE GTH 时段' };
        return { open: false, phase: 'closed', label: '休市', hint: '周日 20:15 ET 开盘' };
      }
      if (wd === 5 && m >= 975) return { open: false, phase: 'closed', label: '休市', hint: '周五 16:15 ET 收盘' };
      const open = !(inR(m, 565, 570) || inR(m, 975, 1215));
      return open
        ? { open: true, phase: 'regular', label: '交易中', hint: (m < 570 || m >= 1215) ? 'CBOE GTH 时段' : '' }
        : { open: false, phase: 'closed', label: '休市', hint: inR(m, 565, 570) ? 'RTH 切换缺口 09:25–09:30 ET' : '每日 16:15–20:15 ET 维护休市' };
    }

    if (cfg.weekdays.indexOf(wd) < 0) {
      return { open: false, phase: 'closed', label: '休市', hint: '周末休市' };
    }
    if (cfg.segs.some(([a, b]) => inR(m, a, b))) {
      return { open: true, phase: 'regular', label: '交易中', hint: '' };
    }
    if (cfg.pre && inR(m, cfg.pre[0], cfg.pre[1])) {
      return { open: false, phase: 'pre', label: '盘前', hint: '盘前时段 04:00–09:30 ET' };
    }
    if (cfg.post && inR(m, cfg.post[0], cfg.post[1])) {
      return { open: false, phase: 'post', label: '盘后', hint: '盘后时段 16:00–20:00 ET' };
    }
    return { open: false, phase: 'closed', label: '休市', hint: '' };
  }

  // 给某个资产 key 判定
  function state(key) {
    const U = w.UNIVERSE;
    const a = U.get(key);
    if (!a) return { open: false, phase: 'closed', label: '--', hint: '' };
    /* v236【全品种修复】品种自带 sess 必须优先于「分组时段」。
     * apac 是日经+KOSPI 的**并集**（东京时区 09:00-11:30 / 12:30-15:00），
     * 而 HSI/HSTECH(hk)、KS11(kr)、TWII(tw) 虽然 grp=apac，各自时段完全不同：
     * 北京 10:46 港股正在交易，apac 却落在「东京午休」→ 详情页显示「亚太·休市」。
     * 行情列表的 sessionOf() 早就优先 a.sess，只有直接调 state() 的
     * 详情页 / 选股表 / 异动雷达漏了 —— 在这里统一修，所有入口一起好。 */
    const type = a.sess || (U.GROUPS[a.grp] && U.GROUPS[a.grp].session) || 'cn';
    return judge(type, new Date());
  }

  /* v237【全品种修复·第二层】时段表的「并集」不能代表组内每个品种。
   * apac 是日经 09:00-11:30 / 12:30-15:00（东京）的并集，但同组的
   * 港股(hk) / 韩股(kr) / 台股(tw) 时段完全不同：北京 10:46 港股在交易，
   * judge('apac') 却落在东京午休 → 整个「亚太」组被判休市、沉到列表底部。
   * 这里给分组排序/顶部提示用：组内任一品种在交易，这个时段就算活跃。 */
  function sessionLive(sk) {
    const j = judge(sk, new Date());
    if (j.open) return true;
    if (j.phase === 'pre' || j.phase === 'post') return true;
    const U = w.UNIVERSE;
    if (!U || !U.keys) return false;
    const grps = Object.keys(U.GROUPS).filter(g => U.GROUPS[g].session === sk);
    if (!grps.length) return false;
    let hit = false;
    U.keys().forEach(k => {
      if (hit) return;
      const a = U.get(k);
      if (!a || grps.indexOf(a.grp) < 0) return;
      const s = state(k);
      if (s.open || s.phase === 'pre' || s.phase === 'post') hit = true;
    });
    return hit;
  }

  // 交易所当地时间的可读字符串（用于详情页副标题）
  function localTime(type) {
    const cfg = SESSIONS[type];
    if (!cfg || cfg.always) return '7×24 全球连续交易';
    const z = zoned(cfg.tz, new Date());
    return cfg.name + '当地 ' + String(z.hh).padStart(2, '0') + ':' + String(z.mm).padStart(2, '0');
  }

  /* 一个交易日的「分钟数」——分时图/缩略图用它决定 X 轴要铺多宽。
   * 股票类直接从 SESSIONS.segs 累加（新加市场只要 grp 带 session 就自动正确，
   * 不用再维护一张硬编码表）；24 小时类（外汇/商品/美债）的数据源本身是
   * 「最近 N 小时滚动窗口」，按实测口径给固定值；crypto 是 7×24 连续交易，
   * 没有开盘收盘，返回 0 = 不补点（走满）。 */
  const ROLL = { fx: 1440, cmdty: 1380, rate: 1380, apac: 390 };
  function fullMinutes(type) {
    if (!type) return 0;
    if (ROLL[type]) return ROLL[type];
    const cfg = SESSIONS[type];
    if (cfg && cfg.segs && cfg.segs.length) {
      let m = 0;
      for (let i = 0; i < cfg.segs.length; i++) m += (cfg.segs[i][1] - cfg.segs[i][0]);
      return m;
    }
    return 0;
  }

  w.Session = { state: state, judge: judge, sessionLive: sessionLive, localTime: localTime, SESSIONS: SESSIONS, fullMinutes: fullMinutes };
})(window);
