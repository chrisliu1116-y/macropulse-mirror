(function () {
  'use strict';

  var S = {
    d: null,
    from: 0,
    to: 0,
    userMoved: false,    /* v290：用户手动拖/捏过就不再自动对齐最右 */
    cursor: -1,          /* 十字游标所在索引，-1 = 不在游标模式 */
    cursorMode: false,
    ptrs: new Map(),
    pinch: null,
    drag: null,
    lpTimer: null,
    geo: null
  };

  /* 深浅两套主题 —— 最终要并进 APP，跟随 APP 的 mm_theme。
   * 方案 A：折线分段着色（半透明做底衬），点用同色系亮一档 + 描边。
   * 中间段用「红」不用蓝（蓝被「冰点」占用），≥150 用亮橙。 */
  var THEMES = {
    dark: {
      grid: 'rgba(255,255,255,.055)', axis: '#4b5a70',
      red: '#ff4d4f', green: '#22c55e', warn: '#f59e0b',
      /* 线：半透明，当底衬 */
      line: ['rgba(95,107,125,.60)', 'rgba(192,57,43,.62)', 'rgba(217,119,6,.62)'],
      /* 点：同色系亮一档 */
      dot: ['#a8b4c6', '#ff7d7d', '#ffc247'],
      ring: 'rgba(11,16,23,.95)',
      /* 数字：常规红 / 攻击橙 / 冰点蓝 */
      num: ['#ff7d7d', '#ffc247', '#38bdf8'],
      /* 红三角：比原来更亮，加白描边让它跳出来 */
      upArrow: '#ff5c5c', upEdge: 'rgba(255,255,255,.85)',
      downArrow: '#22c55e', downEdge: 'rgba(7,10,15,.75)',
      warnDot: '#f59e0b', warnEdge: '#0b1017', warnMark: '#1a1206',
      cursor: 'rgba(255,255,255,.30)',
      level100: 'rgba(139,150,168,.26)',
      last: '#ffffff'
    },
    light: {
      grid: 'rgba(15,23,42,.07)', axis: '#94a3b8',
      red: '#dc2626', green: '#16a34a', warn: '#ea8a00',
      line: ['rgba(154,166,184,.80)', 'rgba(220,38,38,.62)', 'rgba(217,119,6,.62)'],
      dot: ['#5f6b7d', '#b91c1c', '#ea8a00'],
      ring: 'rgba(255,255,255,.95)',
      /* v261：浅色「攻击」橙由 #b45309 提亮到 #ea8a00 —— 原值深棕发暗，用户反馈像屎黄 */
      num: ['#dc2626', '#ea8a00', '#0369a1'],
      /* v261：点的特殊色（跟当日家数走）—— 冰点蓝 / 攻击橙 */
      dotIce: '#0369a1', dotHot: '#ea8a00',
      upArrow: '#e53935', upEdge: 'rgba(127,29,29,.85)',
      downArrow: '#16a34a', downEdge: 'rgba(255,255,255,.9)',
      warnDot: '#ea8a00', warnEdge: '#ffffff', warnMark: '#ffffff',
      cursor: 'rgba(15,23,42,.28)',
      level100: 'rgba(100,116,139,.28)',
      last: '#0f172a'
    }
  };
  var C = THEMES.dark;
  /* 深色主题同样要有点的特殊色键（跟当日家数走） */
  THEMES.dark.dotIce = '#38bdf8';
  THEMES.dark.dotHot = '#ffc247';

  function isLight() { return document.body.classList.contains('light'); }
  function cur() { return isLight() ? THEMES.light : THEMES.dark; }

  var WK = ['日', '一', '二', '三', '四', '五', '六'];
  /* 'YYYY-MM-DD' → '一'..'日'（按本地时区，避免 UTC 偏移把周几算错一天） */
  function wkOf(ds) {
    try {
      var t = new Date(ds + 'T00:00:00');
      return WK[t.getDay()] || '';
    } catch (e) { return ''; }
  }

  /* v261 折线分段：符合总数 <100 灰 / ≥100 红（不再有橙色档；
   * 橙色改为「点」跟当日家数走的攻击标记，见下方点色逻辑） */
  function bandOf(v) { return v >= 100 ? 1 : 0; }

  var MIN_BARS = 15;

  function $(id) { return document.getElementById(id); }

  /* 图例跟着主题走（深浅各一套色） */
  function paintLegend() {
    var T = cur();
    $('lg').innerHTML =
      '<span><em style="background:' + T.dot[0] + '"></em>&lt;100</span>' +
      '<span><em style="background:' + T.dot[1] + '"></em>≥100</span>' +
      '<span><em style="background:' + T.dotIce + '"></em>冰点</span>' +
      '<span><em style="background:' + T.dotHot + '"></em>攻击≥150</span>' +
      '<span style="color:' + T.upArrow + '">▲ 转多</span>' +
      '<span style="color:' + T.downArrow + '">▼ 转空</span>' +
      '<span style="color:' + T.warnDot + '">! 预警</span>';
  }

  /* ---------------- 数据 ---------------- */
  /* ---------------- 数据来源（v237 四源并发竞速 + 新鲜度校验） ----------------
   * 实测（2026-11-10，国内，各 3 次）：
   *   同源 data/breadth.json   主站热 0.33s / Pages 0.76s   ← 最快
   *   raw.githubusercontent  0.76 ~ 1.05s（cache 5 分钟）
   *   jsDelivr CDN           0.78 ~ 0.81s（原本 12h 缓存，跑批后已自动 purge）
   *   Pages 绝对地址          0.76 ~ 1.08s
   * 旧版把同源文件故意延后 800ms、又把 raw 设成第一源，等于放弃了最快的通道。
   * 现在三个远端并发、同源延后兜底：第一个返回「新鲜」数据的直接上屏；陈旧副本不会顶掉新数据。
   * 最坏情况（主站冷启动 2.78s）由 CDN / raw 在 0.8s 左右补齐，不再白屏。 */
  /* v238【正确性优先于毫秒】同源 data/breadth.json 虽然最快（主站热 0.33s），
   * 但它随「发版」才更新，GitHub Actions 每天 15:20 跑批只更新远端仓库。
   * 若让同源抢跑，明天起主站宽度页会一直显示发版那天的旧数据。
   * 所以：三个远端全并发（数据一定是新的），同源延后 700ms 只做全挂兜底。
   * 加速来自「并发 + jsDelivr 跑批后 purge」，不靠牺牲数据新鲜度。 */
  /* v290-rev：jsDelivr 提到首位（跑批完成后 workflow 主动 purge，国内可达）；
   * raw 在国内手机常年取不到，放第二；镜像与本地副本只做全挂兜底。 */
  var DATA_SOURCES = [
    'https://cdn.jsdelivr.net/gh/chrisliu1116-y/insum-cloud@main/breadth/data/breadth.json',
    'https://raw.githubusercontent.com/chrisliu1116-y/insum-cloud/main/breadth/data/breadth.json',
    'https://chrisliu1116-y.github.io/macropulse-mirror/breadth/data/breadth.json',
    'data/breadth.json'
  ];
  function dataSources() {
    var d = new Date();
    /* 收盘窗口内按 10 分钟分桶破缓存：跑批 15:00–16:00 每 10 分钟可能更新一次，
     * 只按天打 tag 的话当天刷新也拿不到新数据。10 分钟桶既不击穿 CDN、又能及时可见。 */
    var tag = '' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2)
      + ('0' + d.getDate()).slice(-2) + ('0' + d.getHours()).slice(-2)
      + Math.floor(d.getMinutes() / 10);
    return DATA_SOURCES.map(function (u) {
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + tag;
    });
  }

  /* 收盘窗口内静默追新：数据一落库，已经打开的页面也能在 3 分钟内看到，
   * 不需要用户手动刷新、更不整页 reload（整页重载会把用户的放大/拖动状态清空，
   * 正是之前反馈过的那个问题）。只原地替换 S.d 并重绘，保留当前 from/to 视野。 */
  function intradayWindow() {
    var n = new Date();
    var wd = n.getDay();
    if (wd === 0 || wd === 6) return false;
    var hm = n.getHours() * 100 + n.getMinutes();
    return hm >= 1500 && hm <= 1800;
  }
  function startIntradayRefresh() {
    setInterval(function () {
      if (!intradayWindow() || !S.d || S.pinch || S.drag || S.ptrs.size) return;
      var u = DATA_SOURCES[0] + '?t=' + Date.now();
      fetch(u, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (!validData(d) || !isFresh(d)) return;
          var oldLast = S.d.dates[S.d.dates.length - 1];
          var newLast = d.dates[d.dates.length - 1];
          if (newLast <= oldLast) return;                 // 没有新交易日
          if (S.pinch || S.drag || S.ptrs.size) return;   // 用户正在操作，下一轮再说
          /* 按日期重新定位视野：新数据只在尾部追加，历史索引有偏移时按日期找回来 */
          var oldFromDate = S.d.dates[S.from], oldToDate = S.d.dates[S.to];
          var wasAtEnd = S.to >= S.d.dates.length - 1;
          S.d = d;
          var fi = d.dates.indexOf(oldFromDate), ti = d.dates.indexOf(oldToDate);
          S.from = fi >= 0 ? fi : 0;
          S.to = wasAtEnd ? d.dates.length - 1 : (ti >= 0 ? ti : d.dates.length - 1);
          if (S.to < S.from) S.to = S.from;
          $('upd').textContent = '全A股 · ' + updText(d);
          $('dot').classList.remove('old');
          $('ft').textContent = footText(d);
          if (S.cursor >= 0 && S.cursor < d.dates.length) updateCards(S.cursor);
          else updateCards(d.dates.length - 1);
          paintLegend();
          draw();
        })
        .catch(function () { /* 单个源失败不影响页面，下一轮再试 */ });
    }, 3 * 60 * 1000);
  }
  function validData(d) { return !!(d && d.dates && d.dates.length > 100 && d.meta); }
  /* 收盘后 5 个自然日内都算新鲜：覆盖周末 + 小长假，又不至于把
   * 主站 dist 里那份「部署当天之后就不再更新」的旧副本当成新数据。 */
  function isFresh(d) {
    try {
      var last = d.dates[d.dates.length - 1];
      var t = Date.parse(last + 'T00:00:00Z');
      return isFinite(t) && (Date.now() - t) < 5 * 86400e3 && (Date.now() - t) > -86400e3;
    } catch (e) { return false; }
  }
  function loadData() {
    return new Promise(function (resolve, reject) {
      var srcs = dataSources(), remoteDone = 0, done = false;
      var best = null, bestDay = '', fresh = null, freshDay = '';
      function consider(d) {
        if (!validData(d)) return;
        var day = d.dates[d.dates.length - 1];
        if (!best || day > bestDay) { best = d; bestDay = day; }
        if (isFresh(d) && (!fresh || day > freshDay)) { fresh = d; freshDay = day; }
      }
      function finish() {
        if (done) return; done = true; clearTimeout(hard); clearTimeout(grace);
        var pick = fresh || best;
        if (pick) resolve(pick); else reject(new Error('全部数据源失败'));
      }
      var hard = setTimeout(finish, 9000);
      /* v340：三个远端全返回、或最多 2.5s 宽限期即结算；按「最后交易日最大」
       * 选数据，本地 dist 快照延后 700ms 只作全挂兜底，杜绝旧数据先上屏再跳。 */
      var grace = setTimeout(finish, 2500);
      srcs.forEach(function (u, i) {
        var go = function () {
          fetch(u, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) { if (!done) consider(d); })
            .catch(function () {})
            .then(function () {
              if (!done && i < srcs.length - 1) {
                remoteDone++;
                if (remoteDone >= srcs.length - 1) finish();
              }
            });
        };
        if (i === srcs.length - 1) setTimeout(go, 700); else go();
      });
    });
  }

  /* 更新时间：meta.generated 已由跑批脚本写成固定 UTC+8 北京时间。
   * 老数据没有 trade_date / generated_tz 字段，就退回用 dates 末日显示，
   * 但会打上「旧格式」标记，让用户一眼看出跑批脚本没更新。 */
  function updText(d) {
    var m = d.meta || {};
    var day = m.trade_date || d.dates[d.dates.length - 1] || '';
    var g = String(m.generated || '');
    if (!g) return '数据截至 ' + day + '（无跑批时间）';
    var short = g.replace(/^\d{4}-/, '').slice(0, 11);
    /* v288 方案1：跑批上游失败时保留上一份成功数据，明确标注停留日期，不假装今天 */
    if (m.stale) return '数据停留在 ' + day + '（跑批未更新' + (m.stale_reason ? ' · ' + m.stale_reason : '') + '）';
    return '数据 ' + day + ' · 更新 ' + short + (m.generated_tz ? ' 北京' : '');
  }

  function footText(d) {
    var m = d.meta || {}, g = String(m.generated || '');
    var short = g ? g.replace(/^\d{4}-/, '').slice(0, 11) : '';
    var day = m.trade_date || d.dates[d.dates.length - 1] || '';
    return 'A股 ' + m.universe + '/' + m.valid + ' · ' + m.days + '日 · ' + day
      + (short ? ' · ' + short + (m.generated_tz ? ' 北京' : '') : '')
      + (m.stale ? ' · 未更新' : '');
  }

  /* 全屏：优先 Fullscreen API；WebView 会走 WebChromeClient.onShowCustomView。
   * v255：APK 里点全屏 → 原生强制横屏、退出 → 回竖屏（NativePulse.setLandscape，
   * 由宿主 APK v1.5.8 提供；iframe 里经 parent 取同一个桥）。浏览器无桥，静默跳过。 */
  function nativeLandscape(on) {
    try {
      var np = (window.parent && window.parent !== window && window.parent.NativePulse) || window.NativePulse;
      if (np && np.setLandscape) np.setLandscape(!!on);
    } catch (e) {}
  }
  function bindFullscreen() {
    var btn = $('btnFull');
    if (!btn) return;
    function sync() {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      btn.classList.toggle('on', on);
      var lab = btn.querySelector('span');
      if (lab) lab.textContent = on ? '退出' : '全屏';
      nativeLandscape(on);
    }
    btn.addEventListener('click', function () {
      var el = document.documentElement;
      var cur = document.fullscreenElement || document.webkitFullscreenElement;
      try {
        if (cur) {
          (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
        } else {
          var req = el.requestFullscreen || el.webkitRequestFullscreen;
          if (req) {
            req.call(el).then(function () {
              try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape'); } catch (e) {}
            }).catch(function () {});
          }
        }
      } catch (e) {}
      setTimeout(function () { sync(); draw(); }, 320);
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    window.addEventListener('resize', function () { setTimeout(draw, 240); });
  }

  function readTheme() {
    try {
      var th = JSON.parse(localStorage.getItem('mm_theme') || '"dark"');
      return th === 'light' ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function applyTheme(th) {
    var on = th === 'light';
    document.body.classList.toggle('light', on);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', on ? '#eef2f7' : '#070a0f');
    if (S.d) draw();      // 图表是 canvas，换了主题要重画
  }

  /* 只读调试句柄：无头浏览器验证「进入时视窗是否在最右最新」用 */
  window.__breadthView = function () {
    return {
      from: S.from, to: S.to, n: S.d ? S.d.dates.length : 0,
      lastDate: S.d ? S.d.dates[S.d.dates.length - 1] : null,
      userMoved: S.userMoved,
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight
    };
  };

  function boot() {
    bindFullscreen();
    /* 并进 APP 后由宿主 iframe 通过 postMessage 写主题；同源 localStorage 的
     * mm_theme 也作为兜底。embed 模式（?embed=1）隐藏重复的大标题，把高度让给图表。 */
    if (/embed=1/.test(location.search)) document.body.classList.add('embed');
    applyTheme(readTheme());
    window.addEventListener('message', function (e) {
      if (e.data && typeof e.data.mm_theme === 'string') applyTheme(e.data.mm_theme);
      /* v1.5.10：原生返回键 → 父页面 postMessage 通知退出全屏。
       * 赚钱效应是在 iframe 里全屏的，父页面无法替它调 exitFullscreen。 */
      if (e.data && e.data.mm_effect_show) {
        /* v290：主站每次切到本页都发。重绘一次（隐藏加载后 draw 曾因宽 0 早退）；
         * 只要用户没手动拖/捏过，就把窗口对齐回最右最新
         * （30日/60日/120日/全部按当前激活按钮）。 */
        setTimeout(function () {
          try {
            if (!S.d) return;
            if (!S.userMoved) {
              var on = document.querySelector('#ranges button.on');
              setRange(on ? (parseInt(on.dataset.n, 10) || 0) : 30);
              S.cursor = -1; S.cursorMode = false;
              updateCards(S.d.dates.length - 1);
            }
            draw();
          } catch (err) {}
        }, 120);
      }
      if (e.data && e.data.mm_exit_fs) {
        var cur = document.fullscreenElement || document.webkitFullscreenElement;
        if (cur) {
          try { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); } catch (err) {}
        }
        nativeLandscape(false);
      }
    });
    window.addEventListener('storage', function (e) {
      if (e.key === 'mm_theme') applyTheme(readTheme());
    });
    loadData()
      .then(function (d) {
        S.d = d;
        $('upd').textContent = '全A股 · ' + updText(d);
        setRange(30);
        updateCards(d.dates.length - 1);
        $('dot').classList.remove('old');
        paintLegend();
        $('ft').textContent = '全部A股 ' + d.meta.universe + ' 只 · 有效 ' +
          d.meta.valid + ' 只 · ' + d.meta.days + ' 个交易日 · ' + updText(d);
        draw();
      })
      .catch(function (e) {
        $('gen').textContent = '数据加载失败';
        $('upd').textContent = '全A股 · 数据未更新，请检查跑批';
        $('dot').classList.add('old');
      });
  }

  function setRange(n) {
    var N = S.d.dates.length;
    if (!n || n >= N) { S.from = 0; S.to = N - 1; }
    else { S.to = N - 1; S.from = Math.max(0, N - n); }
  }

  /* ---------------- 顶部数值卡（跟随游标） ---------------- */
  function updateCards(i) {
    var d = S.d;
    if (!d || i < 0 || i >= d.dates.length) return;
    var tot = d.total[i], day = d.daycnt[i], nw = d.newadd[i], rm = d.willrm[i];
    var p = function (k) { return i > 0 ? d[k][i - 1] : null; };

    $('vTotal').textContent = tot;
    $('vDay').textContent = day;
    $('vNew').textContent = nw;
    $('vRm').textContent = rm;

    function delta(el, cur, prev) {
      if (prev == null) { el.textContent = ''; return; }
      var df = cur - prev;
      el.textContent = (df > 0 ? '▲ +' : df < 0 ? '▼ ' : '— ') + Math.abs(df) + ' 较前日';
      el.className = df > 0 ? 'up' : df < 0 ? 'dn' : 'flat';
    }
    delta($('dTotal'), tot, p('total'));
    delta($('dDay'), day, p('daycnt'));
    delta($('dNew'), nw, p('newadd'));
    delta($('dRm'), rm, p('willrm'));

    /* 当日家数三色：≥150 橙 / <前一日一半 蓝（冰点）/ 其余 红 */
    var prevDay = p('daycnt');
    var half = prevDay != null && day <= prevDay * 0.5;
    var T = cur();
    $('vDay').style.color = day >= 150 ? T.num[1] : (half ? T.num[2] : T.num[0]);
    $('vDayTag').textContent = day >= 150 ? '攻击' : (half ? '冰点' : '');

    /* 标题右侧日期：游标模式显示游标日，否则显示最新日 */
    var isLast = i === d.dates.length - 1;
    $('gen').textContent = d.dates[i] + ' 周' + wkOf(d.dates[i]) + (isLast ? ' 收盘' : '');
    $('gen').style.color = isLast ? '' : T.num[2];
  }

  /* ---------------- 绘制 ---------------- */
  function draw() {
    var cv = $('cv'), wrap = cv.parentElement;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H || !S.d) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var d = S.d, N = d.dates.length;
    var T = cur();
    var from = Math.max(0, Math.floor(S.from));
    var to = Math.min(N - 1, Math.ceil(S.to));
    var cnt = to - from + 1;
    if (cnt < 2) return;

    var P = { l: 30, r: 9, t: 14, b: 20 };
    var iw = W - P.l - P.r, ih = H - P.t - P.b;
    var step = iw / (cnt - 1);
    var xOf = function (k) { return P.l + k * step; };

    var mn = Infinity, mx = -Infinity;
    for (var j = from; j <= to; j++) {
      var v = d.total[j];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    if (mx === mn) mx = mn + 1;
    var lo0 = (mn > mx * 0.3) ? mn * 0.88 : 0;
    var lo = Math.max(0, Math.floor(lo0 / 10) * 10);
    var hi = Math.ceil((mx + Math.max((mx - lo) * 0.14, 10)) / 10) * 10;
    if (hi <= mx) hi = Math.ceil((mx + 10) / 10) * 10;
    var yOf = function (val) { return P.t + ih - (val - lo) / (hi - lo) * ih; };

    /* 横网格 + 左刻度 */
    g.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (var t = 0; t <= 4; t++) {
      var val = lo + (hi - lo) * t / 4;
      var y = yOf(val);
      if (y < P.t - 1 || y > P.t + ih + 1) continue;
      g.strokeStyle = T.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(P.l, Math.round(y) + .5);
      g.lineTo(W - P.r, Math.round(y) + .5);
      g.stroke();
      g.fillStyle = T.axis;
      g.fillText(Math.round(val), P.l - 5, y);
    }

    /* 100 水位参考线：帮助读「灰 / 蓝」分界 */
    if (lo < 100 && hi > 100) {
      var y100 = yOf(100);
      g.strokeStyle = T.level100;
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(P.l, y100); g.lineTo(W - P.r, y100); g.stroke();
      g.setLineDash([]);
    }

    /* 折线：逐段按「起点水位」着色，跨档那天就在该点变色 */
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = 2;
    for (var k = 0; k < cnt - 1; k++) {
      var v0 = d.total[from + k], v1 = d.total[from + k + 1];
      g.strokeStyle = T.line[bandOf(v0)];
      g.beginPath();
      g.moveTo(xOf(k), yOf(v0));
      g.lineTo(xOf(k + 1), yOf(v1));
      g.stroke();
    }

    /* 每日节点（方案 A）：同色系亮一档 + 对比描边，让点从线上「浮」出来。
     * v223 恢复 —— v219 曾整段删掉点，导致页面只有一条线、看不出「一天一个点」。
     * 半径随间距自适应：30 日 ≈4.5（珠链感）、60 日 3.4、120 日以上 2.4。 */
    if (step >= 2.6) {
      var rr = step >= 8 ? 4.5 : (step >= 4.5 ? 3.4 : 2.4);
      for (var b = 0; b < cnt; b++) {
        var gi = from + b;
        var bx = xOf(b), by = yOf(d.total[gi]);
        /* v261：点色跟「当日家数」的特殊状态走 —— 冰点（家数 ≤ 前日一半）蓝、
         * 攻击（家数 ≥150）橙，其余按符合总数：<100 灰 / ≥100 红。
         * 判据与家数数字着色（isHalf / ≥150）完全一致。 */
        var dv0 = d.daycnt[gi], pg0 = gi > 0 ? d.daycnt[gi - 1] : null;
        g.fillStyle = (pg0 != null && dv0 <= pg0 * 0.5) ? T.dotIce
          : (dv0 >= 150 ? T.dotHot : (d.total[gi] >= 100 ? T.dot[1] : T.dot[0]));
        g.beginPath();
        g.arc(bx, by, rr, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = T.ring;
        g.stroke();
      }
    }

    /* 箭头 / 预警：v261 起转空▼与预警⚠画在**点的上方**（转多▲仍在点下方）。
     * 家数数字也画在上方（step≥4 时），图标再抬一档避开数字带；顶边夹紧。 */
    var lastIconX = -1e9;
    var iconGap = step < 2.2 ? 9 : 4;
    var big = step >= 5;
    for (var a = 0; a < cnt; a++) {
      var gi2 = from + a;
      var s2 = d.sig[gi2];
      var isRed = !!(s2 & 1), isGrn = !!(s2 & 2), isAl = !!(s2 & 4), isSup = !!(s2 & 16);
      if (!isRed && !isGrn && !isAl) continue;
      var ax = xOf(a);
      if (ax - lastIconX < iconGap) continue;
      lastIconX = ax;
      var py2 = yOf(d.total[gi2]);
      var ayDown = py2 + (big ? 13 : 11);
      if (ayDown > P.t + ih + 6) ayDown = P.t + ih + 6;
      var ay = isRed ? ayDown
        : py2 - (step >= 4 ? (big ? 25 : 22) : (big ? 14 : 12));
      if (ay < P.t + 9) ay = P.t + 9;
      var sc = big ? 1 : (step >= 3 ? 0.85 : 0.7);

      if (isRed) {
        /* 红色向上三角（转多）；超级红＝双三角 + 光晕。
         * v222：颜色提亮 + 描边，让它从同色系的红点里跳出来。 */
        g.fillStyle = T.upArrow;
        g.strokeStyle = T.upEdge;
        g.lineWidth = 1;
        if (isSup && step >= 3) { g.shadowColor = 'rgba(255,92,92,.95)'; g.shadowBlur = 9; }
        g.beginPath();
        g.moveTo(ax, ayDown - 7.2 * sc);
        g.lineTo(ax + 6 * sc, ayDown + 2.6 * sc);
        g.lineTo(ax - 6 * sc, ayDown + 2.6 * sc);
        g.closePath(); g.fill(); g.stroke();
        if (isSup && step >= 3) {
          g.beginPath();
          g.moveTo(ax, ayDown + 2.6 * sc);
          g.lineTo(ax + 6 * sc, ayDown + 9.6 * sc);
          g.lineTo(ax - 6 * sc, ayDown + 9.6 * sc);
          g.closePath(); g.fill(); g.stroke();
          g.shadowBlur = 0;
        }
      } else if (isGrn) {
        /* 绿色向下三角（转空） */
        g.fillStyle = T.downArrow;
        g.strokeStyle = T.downEdge;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(ax, ay + 7.2 * sc);
        g.lineTo(ax + 6 * sc, ay - 2.6 * sc);
        g.lineTo(ax - 6 * sc, ay - 2.6 * sc);
        g.closePath(); g.fill(); g.stroke();
      } else if (isAl) {
        /* 预警：实心橙圆 + 对比描边 + 感叹号，最醒目 */
        g.beginPath();
        g.arc(ax, ay, 5.4 * sc, 0, Math.PI * 2);
        g.fillStyle = T.warnDot;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = T.warnEdge;
        g.stroke();
        g.fillStyle = T.warnMark;
        g.fillRect(ax - .65, ay - 2.8 * sc, 1.3, 3.6 * sc);
        g.fillRect(ax - .65, ay + 1.7 * sc, 1.3, 1.3);
      }
    }

    /* 当日家数数字：每天都画（间距不够时按 step 自动稀疏） */
    if (step >= 4) {
      g.font = '600 8.5px -apple-system,BlinkMacSystemFont,sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      var lastNumX = -1e9;
      var minGap = Math.max(9.5, step * 0.92);
      for (var m = 0; m < cnt; m++) {
        var gi3 = from + m;
        var dv = d.daycnt[gi3];
        if (!dv) continue;
        var gx = xOf(m);
        if (gx - lastNumX < minGap) continue;
        var gy = yOf(d.total[gi3]) - 8;
        if (gy < P.t + 7) gy = P.t + 7;
        var pg = gi3 > 0 ? d.daycnt[gi3 - 1] : null;
        var isHalf = pg != null && dv <= pg * 0.5;
        g.fillStyle = dv >= 150 ? T.num[1] : (isHalf ? T.num[2] : T.num[0]);
        /* v224：原来左右各夹 10px，最右边那天的数字会被硬生生左移 ——
         * 放大后看得特别明显（用户：55 没画在今天的点上，偏左）。
         * 改成按「文字实际半宽」只贴画布边缘夹，正常位置一律居中。 */
        var half = g.measureText(String(dv)).width / 2;
        g.fillText(dv, Math.max(half + 2, Math.min(W - 2 - half, gx)), gy);
        lastNumX = gx;
      }
    }

    /* 最新点：v263 按用户口径不做任何特殊标记，与其他点完全一致
     * （v262 曾改空心环，用户明确「不需要加外圈，跟前面的一样就可以」）。 */

    /* X 轴日期（v257：按可见跨度自适应刻度）
     * 「全部」档已覆盖 1990 至今（8000+ 点），固定 4 个「MM-DD」标签完全读不出年代。
     * 规则：跨度 >2 年 → 只显示年份；>180 天 → 年-月；否则 → 月-日（点少时带周几）。
     * 放大到某个年份区间自动变「2008-03」，再放大到月内变「03-15」。 */
    g.font = '9px -apple-system,BlinkMacSystemFont,sans-serif';
    g.fillStyle = T.axis;
    g.textBaseline = 'top';
    var _d0 = Date.parse(d.dates[from] + 'T00:00:00Z');
    var _d1 = Date.parse(d.dates[to] + 'T00:00:00Z');
    var _span = Math.max(0, (_d1 - _d0) / 86400000);
    var _marks = [];   // [{pos, lab}]：每年/每月的第一个交易日作为锚点
    var _j, _y, _ly = '';
    if (_span > 730) {
      for (_j = from; _j <= to; _j++) {
        _y = d.dates[_j].slice(0, 4);
        if (_y !== _ly) { _marks.push({ pos: _j - from, lab: _y }); _ly = _y; }
      }
    } else if (_span > 180) {
      for (_j = from; _j <= to; _j++) {
        _y = d.dates[_j].slice(0, 7);
        if (_y !== _ly) { _marks.push({ pos: _j - from, lab: _y }); _ly = _y; }
      }
    }
    var _picked = [];
    if (_marks.length) {
      var _n = Math.min(6, _marks.length);
      for (var _L = 0; _L < _n; _L++) {
        _picked.push(_marks[Math.round(_L * (_marks.length - 1) / (_n - 1))]);
      }
    } else {
      var _labs = Math.min(4, cnt);
      for (var _L2 = 0; _L2 < _labs; _L2++) {
        var _pos = _labs === 1 ? 0 : Math.round(_L2 * (cnt - 1) / (_labs - 1));
        var _dt = d.dates[from + _pos];
        _picked.push({
          pos: _pos,
          lab: cnt <= 40 ? (_dt.slice(5) + ' ' + wkOf(_dt)) : _dt.slice(5)
        });
      }
    }
    /* 同标签只留第一个（年/月锚点均匀抽样后可能重复），并让首尾贴边不溢出 */
    var _seen = {};
    for (var _k = 0; _k < _picked.length; _k++) {
      var _m = _picked[_k];
      if (_seen[_m.lab]) continue;
      _seen[_m.lab] = 1;
      g.textAlign = _m.pos <= cnt * 0.06 ? 'left' : (_m.pos >= cnt * 0.94 ? 'right' : 'center');
      g.fillText(_m.lab, xOf(_m.pos), P.t + ih + 5);
    }

    /* 十字游标 */
    if (S.cursor >= 0) {
      var hk = S.cursor - from;
      if (hk >= 0 && hk < cnt) {
        var hx = xOf(hk), hy = yOf(d.total[S.cursor]);
        g.strokeStyle = T.cursor;
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(hx, P.t); g.lineTo(hx, P.t + ih); g.stroke();
        g.beginPath(); g.moveTo(P.l, hy); g.lineTo(W - P.r, hy); g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(hx, hy, 4.2, 0, Math.PI * 2);
        g.fillStyle = T.last; g.fill();
        g.lineWidth = 2;
        g.strokeStyle = T.line[bandOf(d.total[S.cursor])];
        g.stroke();
      }
    }

    S.geo = { from: from, to: to, cnt: cnt, step: step, P: P, iw: iw, ih: ih, W: W, H: H };
  }

  /* ---------------- 交互 ---------------- */
  function idxAt(clientX) {
    var geo = S.geo;
    if (!geo) return -1;
    var r = $('cv').getBoundingClientRect();
    var ratio = (clientX - r.left - geo.P.l) / geo.iw;
    ratio = Math.max(0, Math.min(1, ratio));
    return Math.round(geo.from + ratio * (geo.cnt - 1));
  }

  function setCursor(i) {
    S.cursor = i;
    S.cursorMode = true;
    updateCards(i);
    draw();
  }

  function clearCursor() {
    if (!S.cursorMode) return;
    S.cursorMode = false;
    S.cursor = -1;
    updateCards(S.d.dates.length - 1);
    draw();
  }

  function bind() {
    var cv = $('cv');

    function clearRangeBtns() {
      Array.prototype.forEach.call($('ranges').children, function (x) {
        if (x.id !== 'btnFit') x.classList.remove('on');
      });
    }

    function clampView() {
      var N = S.d.dates.length;
      var span = S.to - S.from;
      if (span < MIN_BARS - 1) {
        var mid = (S.from + S.to) / 2;
        S.from = mid - (MIN_BARS - 1) / 2;
        S.to = mid + (MIN_BARS - 1) / 2;
      }
      if (S.from < 0) { S.to -= S.from; S.from = 0; }
      if (S.to > N - 1) { S.from -= (S.to - (N - 1)); S.to = N - 1; }
      if (S.from < 0) S.from = 0;
    }

    function cancelLP() {
      if (S.lpTimer) { clearTimeout(S.lpTimer); S.lpTimer = null; }
    }

    function onDown(e) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      S.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (S.ptrs.size === 2) {
        cancelLP();
        var a = Array.from(S.ptrs.values());
        S.pinch = {
          dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y),
          from: S.from, to: S.to,
          mid: idxAt((a[0].x + a[1].x) / 2)
        };
        S.drag = null;
        return;
      }
      if (S.ptrs.size === 1) {
        S.drag = { x: e.clientX, y: e.clientY, from: S.from, to: S.to, moved: false };
        if (e.pointerType !== 'mouse') {
          /* 长按 280ms 出十字游标（拖动会取消） */
          cancelLP();
          var cx0 = e.clientX;
          S.lpTimer = setTimeout(function () {
            S.lpTimer = null;
            S.drag = null;
            setCursor(idxAt(cx0));
            if (navigator.vibrate) { try { navigator.vibrate(8); } catch (er) {} }
          }, 280);
        } else {
          setCursor(idxAt(e.clientX));
        }
      }
    }

    function onMove(e) {
      var p = S.ptrs.get(e.pointerId);

      if (!p) {
        if (e.pointerType === 'mouse') setCursor(idxAt(e.clientX));
        return;
      }
      p.x = e.clientX; p.y = e.clientY;

      /* 双指缩放 */
      if (S.ptrs.size === 2 && S.pinch) {
        var a = Array.from(S.ptrs.values());
        var dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (dist < 10 || S.pinch.dist < 10) return;
        var scale = S.pinch.dist / dist;
        var span0 = S.pinch.to - S.pinch.from;
        var span = Math.max(MIN_BARS - 1, Math.min(S.d.dates.length - 1, span0 * scale));
        var ratio = span0 > 0 ? (S.pinch.mid - S.pinch.from) / span0 : 0.5;
        S.from = S.pinch.mid - span * ratio;
        S.to = S.pinch.mid + span * (1 - ratio);
        S.userMoved = true;
        clampView();
        clearRangeBtns();
        draw();
        return;
      }

      /* 游标模式：移动游标 */
      if (S.cursorMode) {
        setCursor(idxAt(e.clientX));
        return;
      }

      /* 拖动平移 */
      if (S.drag && S.ptrs.size === 1) {
        var dx = e.clientX - S.drag.x;
        var dy = e.clientY - S.drag.y;
        if (!S.drag.moved && Math.hypot(dx, dy) > 6) {
          S.drag.moved = true;
          S.userMoved = true;
          cancelLP();
        }
        if (!S.drag.moved) return;
        var geo = S.geo;
        if (!geo) return;
        var dIdx = -dx / geo.step;
        S.from = S.drag.from + dIdx;
        S.to = S.drag.to + dIdx;
        clampView();
        clearRangeBtns();
        draw();
      }
    }

    function onUp(e) {
      cancelLP();
      S.ptrs.delete(e.pointerId);
      if (S.ptrs.size < 2) S.pinch = null;
      if (S.ptrs.size === 0) {
        var was = S.drag;
        S.drag = null;
        if (was && !was.moved && !S.cursorMode) {
          setCursor(idxAt(e.clientX));
        }
      }
    }

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', function () {
      if (S.ptrs.size === 0 && S.cursorMode) clearCursor();
    });

    $('ranges').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var n = parseInt(b.dataset.n, 10) || 0;
      setRange(n);
      S.cursor = -1; S.cursorMode = false;
      updateCards(S.d.dates.length - 1);
      draw();
    });

    var fit = $('btnFit');
    if (fit) fit.addEventListener('click', function () {
      setRange(0);
      S.cursor = -1; S.cursorMode = false;
      updateCards(S.d.dates.length - 1);
      Array.prototype.forEach.call($('ranges').children, function (x) {
        x.classList.toggle('on', x.dataset.n === '0');
      });
      draw();
    });

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(draw, 120);
    });
    window.addEventListener('orientationchange', function () { setTimeout(draw, 260); });
  }

  boot();
  bind();
  startIntradayRefresh();   // 收盘窗口内静默追新，不整页重载

})();
