/* ============================================================
 * app.js — 应用主逻辑
 * ------------------------------------------------------------
 * 四个页签：
 *   ① 快讯   —— 级别（S/A）与类别（宏观政策/地缘/关税…）两条正交筛选
 *   ② 异动雷达 —— 只把「击穿阈值」的品种顶到最上面，其余进全池监控
 *   ③ 行情   —— 固定分组顺序，可增删品种，非交易时段标注并给替代价
 *   ④ 设置
 * ============================================================ */
(function (w, d) {
  'use strict';

  const U = w.UNIVERSE;
  const $ = (s, r) => (r || d).querySelector(s);
  const $$ = (s, r) => Array.from((r || d).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* 【数据版本】news-live-client.js 里的去重/分级口径版本（GRADE_VER）。
   * 口径一变，本地池子里按旧规则合过的条目就得全部重来 —— 见 boot() 的清理闸。
   * 【注意】DATA_VER 故意留在 144：升它会把用户本地 600+ 条的资讯池整池清空重抓
   * （v139 那次「条数腰斩」就是这么被放大的）。要动口径才升这个数。
   * v145 只动了行情图（分时/盘后），分级与去重口径没变。
   * v146：① 详情页「常规/盘后分时」开关不再被标签栏遮挡；② 开关文案随时段切换
   *   （盘前→「盘前分时」、盘后→「盘后分时」）；③ 行情页盘前盘后价与暗盘/链上价并存；
   *   ④ 接入 TradingView 作盘前盘后主源（覆盖 SK 海力士等动态合成品种，及韩股/台股）；
   *   ⑤ 行情页按交易时段归组、指数在前个股在后；⑥ 标级纠错：香港证监会收窄称衔→B。
   * v147：① 详情页「暗盘·链上」不再跳外链，页内直接展示已接入的盘前/盘后/暗盘数据；
   *   ② 韩股/台股「盘后分时」修复：不再按时段门控合成，只要 TV 的 pre/post 与常规收盘
   *   有差值就合成对应段（开关只控制显示/隐藏），常规时段手动点也能看到盘后段；
   *   ③ 底部 TradingView 外链改为纯文字数据源标注；④ 标级纠错：区域冲突单次空袭→A。
   * v150：① 添加品种支持中文名首字母搜索（zjxc → 中际旭创），拼音表由 pypinyin
   *   离线生成 GB2312 全字集；② 「暗盘·链上」页彻底不显示盘后价，只显示暗盘
   *   （Hyperliquid）与链上（DexScreener）两条，且两者独立存储、各占一行互不覆盖；
   *   ③ 动态合成的美股品种简称不再截断到 4 字（SK海力士 曾被截成「SK海力」）；
   *   ④ 新闻去重补「地缘实体 + 动作类别」判据（也门空袭 / 霍尔木兹油轮起火 那几对）。 */
  const DATA_VER = '144';
  const gradeVerOf = () => String((w.LiveNews && w.LiveNews.GRADE_VER) || 0);

  /* ---------------- 标级纠错（用户手工改判） ----------------
   * 用户口径（11-05）：「如果设置成我可以在 app 上改，把错误标级的自己改对，
   *   你能接收到并且自己学习迭代规则吗」。
   *
   * 做法：长按卡片 0.55 秒 → 选正确级别 → **本机立刻生效**（重新排序、重算计数），
   * 同时把「新级 ← 原级 + 标题 + 来源 + 时间」记进纠错单（localStorage mm_fix_v1，
   * 上限 200 条）。设置页能把整张纠错单复制成文本回传 —— 我拿到后改规则集、
   * 登记误判台账、补回归用例，这才算真正闭环。
   *
   * 为什么不直接改池子里的 level：池子会按 gv 用新规则重算，改进去会被覆盖。
   * 所以改判单独存一份 id → level 的映射，渲染前统一覆盖，规则升级也不丢。
   */
  const FIX_KEY = 'mm_fix_v1';
  /* 长按弹改判面板后，浏览器还会补一个 click —— 不拦的话
   * 面板刚出来，新闻详情又盖上来一层。这里记一下时间戳做短时屏蔽。 */
  let fixGuardAt = 0;
  const fixStore = { list: [], map: {} };
  (function loadFix() {
    const raw = store.get(FIX_KEY, []);
    if (Array.isArray(raw)) fixStore.list = raw.filter(x => x && x.id && x.to);
    fixStore.list.forEach(x => { fixStore.map[x.id] = { to: x.to, from: x.from, at: x.at }; });
  })();
  /** 把用户改判覆盖到条目上（渲染/计数前调用） */
  function fixApply(n) {
    if (!n || !n.id) return n;
    const f = fixStore.map[n.id];
    if (f) { n.level = f.to; n.fixed = true; }
    return n;
  }
  /* 改判原因：**自己填**，不给预设选项（用户口径 11-05：
   * 「你那些改判的分类很奇怪，还不如长按可以改分级，然后下面我自己填原因」）。
   * 预设选项的问题是我按规则族切的分类，和你脑子里的判断不是一个维度 ——
   * 你想说的是「这明明是行业集体回购」，我给的却是「行业/板块集体信号」这种抽象标签，
   * 选哪个都别扭。留空也行，但填了的话，纠错单就能直接当规则条款的素材。 */

  function fixRecord(n, to, reason) {
    if (!n || !n.id || n.level === to) return false;
    /* P2-A：把「当时命中了哪条规则」一并存进纠错单。
     * 以前导出单只有标题+级别，AI 必须靠复现去猜是哪道闸；现在带上
     * ruleId / stage，直接按四桶归因定位病根，不用再猜。 */
    let tr = null;
    try {
      if (w.LiveNews && typeof w.LiveNews._explain === 'function') {
        tr = w.LiveNews._explain(n.title, n.brief || '', !!n.important,
          n.stocks || [], n.src || '');
      }
    } catch (e) { tr = null; }
    const row = {
      id: n.id,
      title: String(n.title || '').slice(0, 120),
      src: n.src || '',
      ts: n.ts || Date.now(),
      from: n.level,
      to: to,
      at: Date.now(),
      cat: n.cat || '',
      ruleId: tr ? tr.ruleId : '',
      stage: tr ? tr.stage : '',
      reason: String(reason || ''),
      gv: tr ? tr.gv : ((w.LiveNews && w.LiveNews.GRADE_VER) || 0)
    };
    fixStore.list = fixStore.list.filter(x => x.id !== n.id);   // 同一条只留最后一次
    fixStore.list.unshift(row);
    if (fixStore.list.length > 200) fixStore.list.length = 200;
    fixStore.map[row.id] = { to: to, from: row.from, at: row.at };
    store.set(FIX_KEY, fixStore.list);
    n.level = to;
    n.fixed = true;
    return true;
  }
  /** 纠错单纯文本：粘给 AI 就能直接改规则 */
  function fixText() {
    if (!fixStore.list.length) return '';
    const t = (x) => { try { return new Date(x).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; } };
    return `【标级纠错单】${fixStore.list.length} 条 · 规则 v${(w.LiveNews && w.LiveNews.GRADE_VER) || '?'} · 导出 ${t(Date.now())}\n`
      + '格式：新级←原级 | 原因 | 标题 | 来源 | 时间 | 原分类 | 命中规则(ruleId@stage)\n'
      + fixStore.list.map(x => `${x.to}←${x.from} | ${x.reason || '未填'} | ${x.title} | ${x.src} | ${t(x.ts)} | ${x.cat || ''}`
          + ` | ${x.ruleId ? x.ruleId + '@' + (x.stage || '?') : '未追溯'}`).join('\n');
  }
  /** 结构化 JSON 导出：AI 可直接按 ruleId 定位病根，不用解析文本 */
  function fixJson() {
    if (!fixStore.list.length) return '';
    return JSON.stringify({
      type: 'macro-pulse/grade-corrections',
      version: 1,
      gradeVer: (w.LiveNews && w.LiveNews.GRADE_VER) || 0,
      exportedAt: new Date().toISOString(),
      count: fixStore.list.length,
      buckets: ['A.词表缺漏→ENTITIES', 'B.数值语境误读→提取器',
        'C.支柱守门边界→croVeto/croPillar/aCap', 'D.纯个例→仅本机映射，不改规则'],
      items: fixStore.list.map(x => ({
        id: x.id, from: x.from || '', to: x.to, cat: x.cat || '',
        ruleId: x.ruleId || '', stage: x.stage || '', gv: x.gv || 0,
        reason: x.reason || '', title: x.title, src: x.src || '', ts: x.ts, at: x.at
      }))
    }, null, 2);
  }

  /** 一键复制「修复指令」：纠错单 JSON + 完整 AI 修复要求拼成一段可直接发送的 Prompt */
  function fixPrompt() {
    const json = fixJson();
    if (!json) return '';
    return '请严格按《误判台账》的四桶归因法处理以下纠错单，严禁突破 tools/test_grade.js 的反补丁棘轮锁上限（gradeCoreRules ≤ 107 / Gates ≤ 29 / 总和 ≤ 136）：\n\n'
      + '【客户端纠错单导出数据】：\n' + json + '\n\n'
      + '【强制执行要求】：\n'
      + '1. 第 0 步（读诊断与原因）：读取每条记录的 `ruleId`、`stage` 以及我在 `reason` 字段填写的业务定级口径。\n'
      + '2. 第 1 步（四桶归因）：将每条误判归入以下四桶之一，并在台账根因列写明【桶X】：\n'
      + '   - 【桶A 词表缺漏】→ 仅修改顶层 ENTITIES；\n'
      + '   - 【桶B 数值语境误读】→ 仅修改通用数值提取器或 THRESHOLDS；\n'
      + '   - 【桶C 支柱/守门边界】→ 仅在 croVeto() / croPillar() / aCap() 或既有阶段内修正边界条件；\n'
      + '   - 【桶D 纯个例怪异标题】→ 仅保留本机 mm_fix_v1 映射，不改任何规则代码。\n'
      + '   * 铁律：严禁为单条新闻编写一次性表面特征正则，严禁在 gradeCoreRules 或 Gate 函数中新增独立早退 return 分支！\n'
      + '3. 第 2 步（验证与落盘）：在 tools/test_grade.js 中补充正反回归用例，确保 441+ 分级测试、80+ 去重测试及四面棘轮锁 100% 通过；随后将 GRADE_VER +1，追加登记至 docs/误判台账.md，并同步发版。';
  }

  /* 改判面板：长按卡片弹出。走独立遮罩，不复用 #sheet ——
   * 那个是行情详情用的，混在一起会把锁定滚动/手势逻辑搅乱。 */
  function closeFixPanel() {
    const el = d.querySelector('.fixmask');
    if (el) el.remove();
  }
  function openFixPanel(id) {
    const n = S.news.find(x => x.id === id);
    if (!n) return;
    closeFixPanel();
    const cur = String(n.level || 'B').toUpperCase();
    const el = d.createElement('div');
    el.className = 'fixmask';
    el.innerHTML = `<div class="fixpanel">
      <div class="fix-h"><b>改判分级</b><span>当前 ${esc(cur)} 级 · ${esc(n.cat || '')} · ${esc(n.src || '')}</span></div>
      <p class="fix-t">${esc(n.title || '')}</p>
      <div class="fix-opts">${['S', 'A', 'B', 'C'].map(g =>
        `<button data-fix="${g}" class="${g === cur ? 'on' : ''}">${g}</button>`).join('')}</div>
      <div class="fix-lab">为什么改（选填，一句话，比如「行业集体回购算资金面信号」）</div>
      <input class="fix-rsn" type="text" maxlength="80" enterkeyhint="done"
        placeholder="写一句原因，以后能直接变成规则条款">
      <div class="fix-row">
        <button class="fix-cancel">取消</button>
        <button class="fix-ok">确认改判</button>
      </div>
    </div>`;
    d.body.appendChild(el);
    let pick = cur;
    const rsnEl = el.querySelector('.fix-rsn');
    const sync = () => {
      el.querySelectorAll('[data-fix]').forEach(b => b.classList.toggle('on', b.dataset.fix === pick));
      const ok = el.querySelector('.fix-ok');
      ok.textContent = pick === cur ? '确认改判' : '改成 ' + pick;
      ok.classList.toggle('dim', pick === cur);
    };
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('.fix-cancel')) { closeFixPanel(); return; }
      const lv = e.target.closest('[data-fix]');
      if (lv) { pick = lv.dataset.fix; sync(); return; }
      if (e.target.closest('.fix-ok')) {
        if (pick === cur) { closeFixPanel(); return; }   // 级别没变，没什么可记的
        const ok = fixRecord(n, pick, String(rsnEl.value || '').trim());
        closeFixPanel();
        if (!ok) return;
        if (typeof renderGradeFilters === 'function') renderGradeFilters();
        if (typeof renderFeed === 'function') renderFeed();
        /* 立刻回写本地池子：这样即使哪天纠错映射丢了 / 换了浏览器存储，
         * 池子里的 level 也是改判后的值。 */
        try { if (typeof poolSync === 'function') poolSync(); } catch (e) {}
        if (S.tab === 'set' && typeof renderSettings === 'function') renderSettings();
      }
    });
    sync();
  }


  /* ---------------- 状态 ---------------- */
  // 行情自选列表的结构版本：新增品种时给老用户补一条，不覆盖他们自己删过的
  const WATCH_V = 4;
  function watchInit() {
    const saved = store.get('mm_watch2', null);
    if (!Array.isArray(saved) || !saved.length) return U.MARKET_DEFAULT.slice();
    if (store.get('mm_watchV', 1) < WATCH_V) {
      // v3→v4：新增恒生科技指数（放在恒指之后）
      if (saved.indexOf('HSTECH') < 0) {
        const i = saved.indexOf('HSI');
        saved.splice(i >= 0 ? i + 1 : saved.length, 0, 'HSTECH');
      }
      if (saved.indexOf('SOX') < 0) {
        const i = saved.indexOf('NDX');
        saved.splice(i >= 0 ? i + 1 : saved.length, 0, 'SOX');
      }
      if (saved.indexOf('SOL') < 0) {
        const i = saved.indexOf('ETH');
        saved.splice(i >= 0 ? i + 1 : saved.length, 0, 'SOL');
      }
      // v1 的亚太顺序是「日经在前」，v2 改成「港股 → 韩国 → 日本 → 台湾」，
      // 只在这一版重排一次；之后用户的 ▲▼ 手动顺序就不再被覆盖
      const byG = {}, seen = {};
      saved.forEach(k => {
        const a = U.get(k);
        const g = a ? a.grp : '_';
        (byG[g] = byG[g] || []).push(k);
      });
      Object.keys(byG).forEach(g => byG[g].sort((x, y) => U.orderOf(x) - U.orderOf(y)));
      const out = [];
      saved.forEach(k => {
        const a = U.get(k);
        const g = a ? a.grp : '_';
        if (seen[g]) return;
        seen[g] = 1;
        byG[g].forEach(x => out.push(x));
      });
      store.set('mm_watch2', out);
      store.set('mm_watchV', WATCH_V);
      return out;
    }
    return saved;
  }

  /* ---------------- 弹层「点任意处关闭」统一机制 ----------------
   * 用户口径（本轮）：
   *   「不管是哪里触发的小窗，都可以通过点击窗口的任意地方关闭」
   *   「不管是历史矩阵卡片点开，还是从行情点开对应商品的行情，
   *     它都要能通过点击窗口的任意地方关闭，而不是只能点左上角那个叉」
   *
   * 之前各弹层的关闭入口五花八门：
   *   · 行情面板（#sheet）——只有左上角 ✕ 可点（点遮罩能关，但面板占满屏，
   *     遮罩几乎点不到）
   *   · 快讯详情（#newsSheet）——点 .ns-mask 遮罩可关，但正文区域点不到
   *   · 原文小窗（#linkView）——同上
   *   · 品种倒查面板（#keyPanel）——同上
   *
   * 统一做法：给每个弹层加一个「点内容区空白处也能关」的行为。
   * 关键是要区分「点击」和「操作」：
   *   · 落在可交互元素（按钮/链接/输入框/图表/列表项）上 → 不关，交给它自己
   *   · 落在纯展示的空白处 → 关
   *   · 拖动/滚动图表 → 不关（用 pointer 位移 + 滚动距离判定）
   * 这套判定和事件详情页「再点一下就退出」是同一口径，用户已经认这个手感。 */
  /* 落在这些元素上 → 不当作「点空白关闭」，交还给它们自己处理。
   * 只排除「真正会响应点击 / 会自己滚」的东西：
   *   · 语义上的可交互元素（按钮、链接、输入框、canvas、iframe…）
   *   · 会触发跳转的条目（关联快讯、事件快讯、资产按钮、行情卡片…）
   * 滚动容器（正文区、列表区）不排除 —— 用「滚动距离」判定来区分
   * 「滑动阅读」和「轻点关闭」，这样正文里也能随手关掉。 */
  const CLOSEABLE_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    'canvas', 'svg', 'label', 'iframe',
    '.rel-n', '.ev-news', '.ev-asset', '.chip', '.tk', '.card',
  ].join(',');

  /* 判定一次点击是不是「点空白处关闭」：
   *   1) 必须落在纯展示区域（排除所有可交互元素）
   *   2) 按下到抬起位移不超过 14px（排除拖拽图表）
   *   3) 期间内容区没有滚动（排除滑动阅读）
   *   4) 距按下不超过 1.2 秒（排除长按） */
  function tapToClose(e, scroller) {
    const t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest(CLOSEABLE_SELECTOR)) return false;
    const g = tapState;
    if (!g) return false;
    const moved = Math.hypot((e.clientX || 0) - g.x, (e.clientY || 0) - g.y);
    if (moved > 14) return false;
    const scrolled = scroller ? Math.abs((scroller.scrollTop || 0) - g.top) > 6 : false;
    if (scrolled) return false;
    if (Date.now() - g.ts > 1200) return false;
    return true;
  }

  let tapState = null;
  /* 给弹层挂上「点空白关闭」。container 是弹层根，panelSel 是内容容器
   * （用来判断期间有没有滚动）。同一个 container 只绑一次 —— 弹层内容
   * 会被反复重绘，但根元素是常驻的，重复绑定会导致一次点击关两层。 */
  function bindTapClose(container, panelSel, onClose) {
    if (!container) return;
    if (container.dataset.tapClose === '1') {
      // 已经绑过：只更新回调与滚动容器
      container.__tapClose = { onClose: onClose, panelSel: panelSel };
      return;
    }
    container.dataset.tapClose = '1';
    container.__tapClose = { onClose: onClose, panelSel: panelSel };
    container.addEventListener('pointerdown', (e) => {
      const cfg = container.__tapClose || {};
      const sc = cfg.panelSel ? container.querySelector(cfg.panelSel) : null;
      tapState = { x: e.clientX, y: e.clientY, ts: Date.now(), top: sc ? (sc.scrollTop || 0) : 0 };
    }, { passive: true });
    container.addEventListener('click', (e) => {
      const cfg = container.__tapClose || {};
      const sc = cfg.panelSel ? container.querySelector(cfg.panelSel) : null;
      if (tapToClose(e, sc)) {
        tapState = null;
        if (typeof cfg.onClose === 'function') cfg.onClose();
      }
    });
  }


  /* v120 回退档位默认到「重点(S+A)」：v119 误把默认/老用户档位强翻成「全部」，
   * 用户一直用的是「重点」，这里纠回。仅修正 v119 引入的 'all' 与未初始化(null)；
   * 用户自己手动选过的档位（含刻意的 'all'）一律保留。红闸(redOnly)仍翻成关闭。
   *
   * ⚠️ 这段迁移**只跑一次**（靠 mm_mig_v120 标记）：它原本会在每次启动时把
   * mm_redonly 强制翻回 false，等于用户一打开「只标红」、刷新就被关掉（11-06 反馈）。
   * 改成一次性后，用户手动开的标红/档位刷新后都能持久保留。 */
  (function () {
    if (store.get('mm_mig_v120', 0) >= 1) return;   // 已迁移过 → 跳过，别再动用户的手动设置
    if (store.get('mm_redonly', null) === true) store.set('mm_redonly', false);
    const _g = store.get('mm_grade', null);
    if (_g === null || _g === 'all') store.set('mm_grade', 'key');
    store.set('mm_mig_v120', 1);
  })();

  const S = {
    news: [],
    /* C 档按钮已经撤掉了（用户口径 11-05：「C 不是让你去掉了吗 怎么还有标签」）。
     * 但 mm_grade 是持久化的 —— 老用户如果上次停在 C 档，刷新后会卡在一个
     * 根本没有按钮可切的空列表里。这里做一次兜底：存档是 C 就回到「重点」。 */
    /* v120：默认档位回退到用户一直用的「重点(S+A)」—— 抓全量入池不变，
     * 只是首屏默认只看 S+A；想看普通稿切到「全部」档即可。
     * C 级仍一律不入流（噪声，用户早已否掉）。 */
    grade: (function () {
      const g = store.get('mm_grade', 'key');
      return g === 'C' ? 'key' : g;
    })(),
    /** B / 全部档的分页游标（见 renderFeed 的 PAGE） */
    limit: 60,
    /* 只跑「平台标红」（v104）。
     * 用户口径（11-06 11:40）：「各大网站都有个标红的类别，里面的东西基本
     *   相当于我们的 AB 级……如果标红都跑得通，以后就只从标红里跑数据，
     *   不跑普通数据了，这样能大大减少页面上的新闻数量。」
     *
     * 实现放在**渲染闸**而不是抓取闸：非标红稿仍然入池（归因、折叠、
     * 同事件合并都要用到它），只是不进列表。这样「全部」档还能回查被过滤掉
     * 什么，规则改坏了一眼能发现 —— 抓取端直接丢掉就再也捞不回来了。 */
    redOnly: store.get('mm_redonly', false),  // v119 回退 v101：默认关闭「只显示平台标红」，全部快讯都进流
    topic: 'all',
    /** 按来源筛选：在「源状态」那排点某个源名就只看它的消息，再点一次取消。
     *  用户口径：「口罩哥和川普的源，希望能像分类标签一样点开看到这两个源下
     *  的所有消息，但不是给他俩搞单独的分类标签。」 */
    srcFilter: '',
    tab: 'feed',
    notify: store.get('mm_notify', true),   // v193：预警通知总开关（s级快讯/异动/股价提醒的系统弹窗）
    sound: store.get('mm_sound', true),
    modalOn: store.get('mm_modal', true),
    toastOn: store.get('mm_toast', true),
    vibrate: store.get('mm_vib', true),
    /* v137：阈值 = 波动率库自适应，人工系数固定 1（滑杆已下线） */
    thrScale: 1,
    sheetKey: null,
    sheetMode: 'min',
    watch: watchInit(),
    marketSort: store.get('mm_msort', 'fixed'),
    sessFirst: store.get('mm_sessfirst', true),
    mxMode: store.get('mm_mxmode', 'size'),
    theme: store.get('mm_theme', 'dark'),
    marketEdit: false,
    evEdit: false,          // 事件卡片编辑模式（删除 / 排序）
    demoIdx: 0,
    lastAlarm: null,
    flashState: 'off',
    liveStats: null,
    activeAlerts: {},     // key → 异动结果（未归因/已归因）
    alt: {},              // key → 链上/延展时段替代价
    ext: {},              // key → 盘前/盘后报价（CNBC 延展时段，见 API.extQuotes）
    /* v150：链上（DexScreener DEX 池子）单开一张表。
     * 之前和 alt 共用一格，先拉到的把后拉到的挤掉 —— 用户看到「只显示暗盘没显示链上」。
     * 两者是不同的东西（暗盘=Hyperliquid RWA 永续，链上=DEX 现货池），必须并存。 */
    dexAlt: {},
    /* v64：日股「夜間PTS」（Japannext J-Market，17:00–次日 06:00）最新成交价。
     * 东证主板没有美股式盘前盘后，但 PTS 有真实夜盘成交，Yahoo!ファイナンス
     * 的「夜間PTS」栏给最新价与「東証終値比」——只报价格，没有分时序列。 */
    pts: {},
    minExt: store.get('mm_minext', null),   // 分时图是否接盘前/盘后（null＝按当前时段自动）
    seenS: store.get('mm_seenS', null) || '',
    feedNewS: 0,
    pendingSoftS: '',      // 被硬横幅挡住、等着补挂的 S 级快讯 id
    session: {}
  };

  /* ---------------- 主题：深色 / 浅色 ---------------- */
  function applyTheme(t, silent) {
    S.theme = t === 'light' ? 'light' : 'dark';
    store.set('mm_theme', S.theme);
    d.body.classList.toggle('light', S.theme === 'light');
    d.documentElement.setAttribute('data-theme', S.theme);
    const meta = d.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', S.theme === 'light' ? '#f3f6fb' : '#070a0f');
    postEffectTheme();
    const btn = $('#btnTheme');
    if (btn) {
      btn.textContent = S.theme === 'light' ? '☾' : '☀';
      btn.title = S.theme === 'light' ? '切到深色主题' : '切到浅色主题';
    }
    // 详情面板开着就按新配色重画一次图（图表是 canvas，不吃 CSS 变量）
    const sh = $('#sheet');
    if (!silent && sh && sh.classList.contains('on') && chart && chart.key) {
      chart.render(chart.key, chart.mode);
    }
    /* 分组色/图表色都是内联或 canvas，切主题必须重绘一次 */
    if (!silent) {
      try { renderMarket(); } catch (e) {}
      /* 面板头部的分组色是内联色，单独改一下，不重开面板（重开会丢滚动位置） */
      try {
        const shEl = $('#sheet');
        const a = S.sheetKey ? U.get(S.sheetKey) : null;
        const g = a && U.GROUPS[a.grp];
        const el = shEl && shEl.querySelector('.sh-sub span');
        if (el && g) el.style.color = gColor(g);
      } catch (e) {}
    }
  }

  /* ---------------- 时间 ---------------- */
  function agoText(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function hhmm(ts) {
    const t = new Date(ts);
    return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }
  function hhmmss(ts) {
    const t = new Date(ts);
    return [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  }

  /* ---------------- 报价中心（批量接口 + 缓存 + 首屏快照） ---------------- */
  /* 【改造1·首屏快照】行情报价落盘，冷启动瞬间先用上次的 price/pct 填满，
   * 不再让首屏全是一排「--」等网络。数据回来由 refresh 静默覆盖。 */
  const QUOTE_SNAP_KEY = 'mm_quote_snap_v1';
  let quoteSnapT = 0;
  function saveQuoteSnap() {
    try {
      const now = Date.now();
      if (now - quoteSnapT < 8000) return;   // 节流：8 秒最多写一次
      quoteSnapT = now;
      store.set(QUOTE_SNAP_KEY, { at: now, data: QuoteHub.cache });
    } catch (e) {}
  }
  function loadQuoteSnap() {
    let snap = null;
    try { snap = store.get(QUOTE_SNAP_KEY, null); } catch (e) {}
    if (!snap || !snap.data) return false;
    /* 只回填 12 小时内的快照，过久的价格会误导用户（隔夜后 pct 口径已变） */
    if (Date.now() - (snap.at || 0) > 12 * 3600 * 1000) return false;
    let n = 0;
    Object.keys(snap.data).forEach(k => {
      const q = snap.data[k];
      if (q && isFinite(q.price) && !QuoteHub.cache[k]) {
        q.snapped = true;                    // 标记为快照价，paintQuote 淡显「上次」
        QuoteHub.cache[k] = q;
        n++;
      }
    });
    return n > 0;
  }
  const QuoteHub = {
    cache: {},
    ttl: 25000,
    busy: false,
    queue: new Set(),
    async refresh(keys, force) {
      keys.forEach(k => { const c = this.cache[k]; if (c) paintQuote(k, c); });
      /* force：行情页高频轮询用，不等 25 秒 TTL 直接拉最新。 */
      const need = force ? keys.slice() : keys.filter(k => {
        const c = this.cache[k];
        return !c || c.snapped || Date.now() - c.at > this.ttl;
      });
      if (!need.length) return;
      need.forEach(k => this.queue.add(k));
      if (this.busy) return;
      this.busy = true;
      try {
        // 每轮最多 60 个，东财批量接口一次就能吃下
        while (this.queue.size) {
          const batch = Array.from(this.queue).slice(0, 60);
          batch.forEach(k => this.queue.delete(k));
          const res = await w.API.batchQuote(batch);
          Object.keys(res).forEach(k => {
            this.cache[k] = res[k];
            paintQuote(k, res[k]);
          });
        }
        saveQuoteSnap();
      } catch (e) { /* ignore */ }
      this.busy = false;
    },
    get(k) { return this.cache[k]; }
  };

  function paintQuote(k, q) {
    if (!q || q.price == null) return;
    const up = q.pct >= 0;
    $$(`.qp[data-k="${cssq(k)}"]`).forEach(el => {
      el.textContent = U.changeLabel(k, q);
      /* v241【关键 bug】原来只清 up/down，忘了清 snap ——
       * 实时报价回来后 class 仍是 "qp snap up"，.qp.snap::after 继续显示「上次」，
       * 要等 120 秒整页 renderMarket() 重建 DOM 才消失（用户：一两分钟才消除）。
       * 数据其实早就是实时的，只是这个标签赖着不走。 */
      el.className = el.className.replace(/\b(up|down|snap|snap-old)\b/g, '').trim()
        + ' ' + (up ? 'up' : 'down') + (q.snapped ? ' snap' : '');
    });
    $$(`.qpx[data-k="${cssq(k)}"]`).forEach(el => { el.textContent = U.fmt(k, q.price); });
    /* 暗盘价先到、主报价后到时，基差会是空的；这里补算一次，
     * 否则用户看到的永远是「暗盘 20.00」而没有对比。 */
    const altNow = S.alt[k];
    if (altNow && altNow.spread == null && altNow.kind === 'hl' && q.price) {
      const a2 = U.get(k);
      const sameUnit = !/^(元|韩元|日元|HKD|港元)$/.test((a2 && a2.unit) || '');
      if (sameUnit && altNow.price) {
        let sp = (altNow.price - q.price) / q.price * 100;
        if (Math.abs(sp) <= 8) { altNow.spread = sp; patchAlt(k); }
      }
    }
    $$(`.qrow[data-k="${cssq(k)}"]`).forEach(el => {
      el.classList.toggle('is-up', up);
      el.classList.toggle('is-down', !up);
      // 合成价逐条标注：抓不到该品种实时报价时，用相关标的推算出的价格。
      // 以前只有全局「在线/离线」一个标识，逐行看不出哪个数是算出来的。
      const syn = el.querySelector('.mk-syn');
      if (syn) syn.hidden = !q.synthetic;
    });
  }
  const cssq = (k) => (w.CSS && CSS.escape ? CSS.escape(k) : String(k).replace(/"/g, '\\"'));

  function allNewsKeys() {
    const set = new Set();
    S.news.forEach(n => {
      (n.direct || []).forEach(x => set.add(x.k));
      (n.cn || []).forEach(x => set.add(x.k));
    });
    return Array.from(set);
  }
  /* ---------------- 归因分类：事件 vs 行情播报 ----------------
   * 用户原话：「有时候归因会归到一条新闻，这条新闻写的是这个商品跌幅扩大多少、
   * 或者说它跳水，这个就不是原因。原因应该是像『原油大涨 → 美伊冲突加剧』
   * 这种具体的事情。」
   *
   * 以前 newsFor() 只看「这条快讯有没有提到这个品种」，于是
   * 「布油跌幅扩大至 3%」这种**结果播报**被当成**原因**挂上去，
   * 等于用行情解释行情，逻辑上是循环论证。
   *
   * 现在先分类：
   *   cause   有事件主语（冲突/制裁/OPEC 减产/降息/库存/财报…）→ 可以当催化剂
   *   echo    只是行情播报（跌超/涨超/跌幅扩大/失守/跳水…）→ 这是结果，不是原因
   *   neutral 两样都不像 → 不参与归因（宁缺勿滥，宁可显示「未归因」）
   */
  const EVENT_RE = new RegExp([
    // 地缘 / 突发
    '冲突|战争|开战|交火|空袭|袭击|导弹|无人机|爆炸|枪击|恐袭|政变|骚乱|抗议|罢工',
    '停火|和谈|谈判|会谈|会晤|峰会|访问|访华|访美|出访|制裁|禁运|封锁|扣押|驱逐|断交',
    '声明|警告|威胁|最后通牒|制裁名单|黑名单',
    // 宏观 / 央妈
    '美联储|鲍威尔|FOMC|议息|利率决议|降息|加息|非农|CPI|PPI|PCE|通胀|GDP|PMI',
    '失业率|零售销售|消费者信心|财政|预算|债务上限|政府关门|停摆|缩表|量化宽松|QE',
    // 能源 / 大宗供给
    'OPEC|欧佩克|减产|增产|产量|钻井|库存|EIA|API|出口|进口|关税|加征|豁免|配额|招标|拍卖',
    // 公司 / 信用
    '财报|业绩|营收|利润|指引|下调|上调|评级|并购|收购|重组|破产|违约|回购|增持|减持',
    'IPO|上市|退市|罚款|调查|起诉|禁令|许可证|召回',
    // 官方动作 / 日程
    '公布|发布|数据显示|会议纪要|讲话|提名|任命|辞职|当选|选举|公投|法案|签署|批准|否决'
  ].join('|'));

  const ECHO_RE = new RegExp([
    '(跌幅|涨幅)(扩大|收窄|缩窄|回落)',
    '跌超|涨超|跌逾|涨逾|跌近|涨近|暴跌|暴涨|大跌|大涨|急跌|急涨|跳水|闪崩|崩盘',
    '直线拉升|直线跳水|快速拉升|快速下跌|短线下挫|短线拉升|迅速跳水|迅速拉升',
    '走低|走高|回落|反弹|冲高|下探|上攻|拉升|下挫|上行|下行',
    '失守|跌破|站上|升破|收复|突破|刷新.{0,4}(高|低)',
    '创.{0,8}(新高|新低|最大单日|盘中新)',
    '日内(涨|跌)|盘中(涨|跌)|现(涨|跌)|报\\d|涨至|跌至|收涨|收跌|高开|低开|平开',
    '涨停|跌停|封板', '(涨|跌)\\s*\\d+(\\.\\d+)?%'
  ].join('|'));

  /* v100：把「事件主语」和「因果连接」单独拆出来。
   *
   * 用户口径（11-06 09:49）：「再核查一次归因 是否是归因到具体新闻 而不是那种
   * 黄金下跌归因到黄金下跌5%的这种新闻 还是要具体的事件 因为什么什么事件引发黄金下跌」。
   *
   * 旧实现的漏洞：EVENT_RE 里有「数据显示 / 公布 / 讲话」这类**泛动作词**，
   * 而且 cause 优先于 echo —— 于是「数据显示黄金下跌5%」被判成原因，
   * 用它去解释同一条黄金下跌，等于换了个句式的循环论证。
   *
   * 新判据（先看有没有行情描述，再问有没有真正的事件主体）：
   *   ① 不含行情描述 → 有事件词就是 cause，否则 neutral
   *   ② 含有行情描述 → 必须同时有「事件主体」或「因果连接」才算 cause，
   *      否则一律 echo（只是结果播报，不参与归因）
   * 这样「黄金下跌5%」「数据显示黄金下跌5%」都判 echo；
   * 「黄金下跌5%，因美联储降息」「布油跌3%，OPEC宣布减产」判 cause。 */
  const EVENT_SUBJECT = /(美联储|FOMC|欧洲央行|日本央行|英国央行|中国央行|人民银行|央行|OPEC|欧佩克|伊朗|以色列|俄罗斯|乌克兰|美国|中国|欧盟|特朗普|鲍威尔|沙特|胡塞|财报|业绩|非农|CPI|PPI|PCE|GDP|PMI|EIA|API|库存|产量|减产|增产|制裁|关税|袭击|冲突|停火|降息|加息|决议|声明|宣布|辞职|当选|法案|协议|收购|并购|破产|违约|回购|增持|减持|草案|投票|通过|谈判|会议|选举)/;
  const CAUSAL_LINK = /因为|由于|受.{0,12}(影响|拖累|提振|打压|推动)|导致|引发|推动|拖累|提振|打压|刺激|在.{0,14}(之际|背景下)/;

  function newsKind(n) {
    const t = [n && n.title, n && n.brief, n && n.summary, n && n.text].filter(Boolean).join(' ');
    if (!t) return 'neutral';
    const echo = ECHO_RE.test(t);
    const event = EVENT_RE.test(t);
    if (!echo) return event ? 'cause' : 'neutral';
    /* 有行情描述：只有带上真正的事件主体 / 因果连接，才算原因。
     * 双保险最硬的组合先判：明确因果词 + 具体事件主体，即使没撞上
     * EVENT_RE 的泛动作词（如「伊朗局势推动黄金涨超2%」）也算原因。 */
    if (CAUSAL_LINK.test(t) && EVENT_SUBJECT.test(t)) return 'cause';
    if (event && (EVENT_SUBJECT.test(t) || CAUSAL_LINK.test(t))) return 'cause';
    return 'echo';
  }

  function newsFor(key, withinMin, kinds) {
    const from = Date.now() - (withinMin || 25) * 60000;
    // 只用真实抓取的快讯做归因：演示/示例条目不能把一次真实异动「归因」到编造新闻上
    return S.news.filter(n => n.live === true && n.ts >= from
      && [...(n.direct || []), ...(n.us || []), ...(n.cn || [])].some(x => x.k === key)
      && (!kinds || kinds.indexOf(newsKind(n)) >= 0));
  }

  /** 这条异动有没有「只是行情播报」的快讯（用于 UI 解释为什么没归因） */
  function newsEchoOnly(key, withinMin) {
    return newsFor(key, withinMin, ['cause']).length === 0
      && newsFor(key, withinMin, ['echo']).length > 0;
  }

  /* ---------------- Ticker ---------------- */
  async function renderTicker() {
    const track = $('#tickerTrack');
    const keys = U.TICKER_DEFAULT.concat(U.TICKER_DEFAULT);
    track.innerHTML = keys.map(k => `
      <button class="tk" data-k="${esc(k)}">
        <span class="tk-n">${esc(U.name(k))}</span>
        <span class="tk-p qpx" data-k="${esc(k)}">--</span>
        <span class="tk-c qp" data-k="${esc(k)}">--</span>
      </button>`).join('');
    track.onclick = (e) => {
      const b = e.target.closest('.tk');
      if (b) openSheet(b.dataset.k);
    };
    await QuoteHub.refresh(U.TICKER_DEFAULT);
  }

  /* ---------------- 快讯流 ---------------- */
  function chip(k) {
    const a = U.get(k);
    if (!a) return '';
    const g = U.grp(k);
    const nm = a.short || a.name;
    // 名称本身已含分组名（美债10Y / 美债）就不重复标注
    const showG = !(g.label && nm.indexOf(g.label) === 0);
    return `<button class="chip" data-k="${esc(k)}">
      <span class="chip-n">${esc(nm)}</span>
      ${showG ? `<span class="chip-g" style="color:${gColor(g)}">${esc(g.label)}</span>` : ''}
    </button>`;
  }

  const LVCLS = { S: 'lv-s', A: 'lv-a', B: 'lv-b', C: 'lv-c' };

  /* ---------------- 防复发：非真实快讯一律打角标 ----------------
   * 真实抓取的快讯带 live: true（见 normItem）。
   * 任何没有 live 标记的条目（演示项、历史遗留的种子项等）
   * 都必须显示灰色「示例」角标，绝不能以真实新闻身份出现。
   * 演示数据额外用橙色「演示」角标区分。 */
  function liveBadge(n) {
    if (n && n.demo) {
      return '<span class="c-demo" title="这是编造的演示数据，不是真实新闻">演示数据</span>';
    }
    if (!n || n.live !== true) {
      return '<span class="c-sample" title="该条目未标记为真实抓取来源，可能是示例或历史残留，请自行核实">示例</span>';
    }
    /* 只描述「跌了多少/涨了多少」的快讯标成「播报」：
     * 它是行情的结果，不能拿去解释同一段行情（否则等于用结果当原因）。 */
    if (newsKind(n) === 'echo') {
      return '<span class="c-echo" title="这是行情播报（结果），不是事件原因，不参与异动归因">播报</span>';
    }
    return '';
  }

  /* ---------------- 新闻驱动异动：行情核对结果 ----------------
   * 新闻里出现「突然拉升 / 跳水 / 闪崩」这类表述时，会拿该品种的
   * 真实分钟线去核对（见 news-spike.js）。这里只展示核对结论：
   *   · 已验证 —— 30 分钟实际涨跌幅方向一致且幅度达标
   *   · 未印证 —— 新闻说得凶，但行情没这么走（仍保留新闻，只是不报警）
   * 没核对过（无数据/方向不明）就不显示角标，不制造噪音。 */
  function spikeBadge(n) {
    if (!n || !n.spike) return '';
    const ks = Object.keys(n.spike);
    if (!ks.length) return '';
    const okK = ks.filter(k => n.spike[k] && n.spike[k].ok === true);
    if (okK.length) {
      const v = n.spike[okK[0]];
      const s = (v.actual > 0 ? '+' : '') + v.actual + '%';
      const w = v.win || 30;
      const via = v.reason === 'caught-by-radar' ? '行情雷达已先捕获' : `${w} 分钟行情核对`;
      return `<span class="c-spike ok" title="${esc(via)}，实际 ${s}，与新闻描述一致">行情已验证 ${s}</span>`;
    }
    const badK = ks.filter(k => n.spike[k] && n.spike[k].ok === false);
    if (badK.length) {
      return '<span class="c-spike no" title="新闻的涨跌描述与真实行情不符，仅作线索参考">行情未印证</span>';
    }
    return '';
  }

  /* ---------------- 可信度：来源署名 + 可核实入口 ----------------
   * 有 url → 直接给原文链接；没有 url → 给该源的快讯频道入口，
   * 明确标注是「频道页」而不是「原文」，不假装能点到单条原文。
   * 无论哪种，来源名都必须显示，让用户能自己核实这条消息。 */
  const SRC_CHANNEL = {
    '华尔街见闻': 'https://wallstreetcn.com/live/global',
    '金十数据': 'https://www.jin10.com/',
    '东方财富': 'https://kuaixun.eastmoney.com/',
    '新浪财经': 'https://finance.sina.com.cn/7x24/',
    '财联社': 'https://www.cls.cn/telegraph',
    '同花顺': 'https://news.10jqka.com.cn/realtimenews.html',
    '口罩哥KZG': 'https://www.laohu8.com/',
    '川普言论': 'https://rollcall.com/factbase/trump/search/'
  };

  // 来源名可能是合并后的多源串（'东方财富 / 同花顺'），取第一个能识别的
  function srcChannelOf(src) {
    const one = String(src || '').split(' / ')[0].trim();
    return SRC_CHANNEL[one] || '';
  }

  /* 来源标注：一律做成「站内按钮」而不是外链 <a>。
   * 用户要求：「点开链接不要跳到浏览器，也不要开新页面，
   *   就在这个 H5 里开个小窗，小窗有叉能关掉，尽量保持页内闭环。」 */
  function srcHTML(n, cls) {
    const src = esc(n.src || '未知来源');
    const url = n.url || srcChannelOf(n.src);
    if (url) {
      const label = n.url ? src + ' ↗' : src + ' · 频道页 ↗';
      const tip = n.url
        ? '在本页内打开原文（不跳浏览器）'
        : '该源没有提供这条的原文链接，在本页内打开它的快讯频道页自行核实';
      return `<button class="${cls} c-src-link" data-open="${esc(url)}"${n.url ? '' : ' data-ch="1"'} title="${tip}">${label}</button>`;
    }
    return `<span class="${cls}">${src}</span>`;
  }

  /* 列表时间窗。
   * 缓存池保留 72 小时，但看板默认只呈现**近 24 小时** ——
   * 否则昨天上午的 A 级还会排在新消息中间，看着像刚发生的。
   * 「全部」这一档例外：它本来就是回溯入口，展示整个池子（72 小时）。 */
  const LIST_WINDOW = 24 * 3600 * 1000;
  function inWindow(n) {
    /* 用户口径（11-06）：「缓存在本地保留 72 小时，页面显示近 24 小时的新闻」。
     * 所以「全部」档也按 24 小时裁 —— 72 小时池子的作用只有一个：
     * 打开页面/被下拉重载时，立刻用本地数据铺满首屏，不用等网络。
     * 更早的历史不该堆进列表（那样「全部」动辄两三百条，正是用户嫌多的原因）。 */
    return (n.ts || 0) >= Date.now() - LIST_WINDOW;
  }

  // 级别通过与否。「key」= 重点 = S 级 + A 级（默认视图）
  function passGrade(n) {
    if (S.grade === 'all') return n.level !== 'C';
    if (S.grade === 'key') return n.level === 'S' || n.level === 'A';
    return n.level === S.grade;
  }

  /* 「标红闸」（v104）。
   *
   * 口径：平台自己标过红的才算候选 ——
   *   财联社 level=B / recommend=1、财联社深度 精选、见闻 score≥2、
   *   金十 important=1、东财 titleColor=3。
   * 但**分级规则亲手判到 S/A 的照放**：规则比平台更懂交易视角（指数 3% /
   *   商品 5% / 龙头 8% 那套），平台漏标不该连累它。
   * 「全部」档不受限 —— 那是回溯/审计入口，得能看见被筛掉了什么。
   */
  let redGate = { len: -1, grade: '', on: false };
  function redGateOn() {
    if (!S.redOnly) return false;
    /* 「全部」档不再放行全量：用户 11-06 明确「APP 里看到的只要看标红的」。
     * 全量审计交给本地池子/后台日志，不再放到前台。 */
    /* 失败自动放行：标红是「筛选器」，不是「自杀开关」。
     * 中转通道挂掉 / 首屏池子还是旧口径（important 全是 false）时，
     * 标红条数会掉到个位数甚至 0 —— 那就退回全量，宁可多几条也不能给空看板。 */
    if (redGate.len === S.news.length && redGate.grade === S.grade) return redGate.on;
    const since = Date.now() - LIST_WINDOW;
    let n = 0;
    for (let i = 0; i < S.news.length; i++) {
      const x = S.news[i];
      if (!x || (x.ts || 0) < since) continue;
      /* 只数「平台红标」——规则判的 A 不算，否则某天行情异动一堆 A，
       * 会把「红标通道其实挂了」这件事盖住。 */
      if (x.important) n++;
      if (n >= 8) break;
    }
    redGate = { len: S.news.length, grade: S.grade, on: n >= 8 };
    return redGate.on;
  }

  function passRed(n) {
    if (!S.redOnly) return true;          // 用户在设置里关掉「只标红」才放行全量
    if (n.important) return true;         // 平台标红（财联社加红/见闻 score/金十 important/东财 titleColor/格隆汇 data-red）
    /* 只有 S 例外：S 是「全球宏观 + 剧烈地缘」这种漏掉代价极大的，
     * 规则判得比平台红标更严，平台没标红也得上。
     * 其余一律不进 —— 这里原来还有一条「红标 <8 就放行全量」的兜底，
     * 一旦某个时段标红真的少（比如凌晨），它就会把三四百条普通稿全灌回列表，
     * 用户看到的直接结果就是「只标红根本没生效、数量还是 300+」。 */
    return n.level === 'S';
  }

  // 来源 / 类别筛选（级别与时间窗在外面单独判）
  function matchCtx(n) {
    /* 按来源筛选：用户在源状态那一排点「金十数据 / 川普言论」，
     * 就只看这个源推的所有消息（用户口径：「像分类标签一样可以打开看到
     * 这两个源下的所有消息，但不是给他俩搞单独的分类标签」）。
     * 合并过的条目 src 是「金十数据 / 新浪财经」这种串，所以用包含匹配。 */
    if (S.srcFilter && String(n.src || '').indexOf(S.srcFilter) < 0) return false;
    if (S.topic !== 'all' && w.TOPICS.of(n).indexOf(S.topic) < 0) return false;
    return true;
  }

  function matchFilter(n) {
    return inWindow(n) && passGrade(n) && passRed(n) && matchCtx(n);
  }

  /* 重点视图底部的「C 级待复核」兜底区。
   * 用户口径：「万一有些比较重要的信息被误标 C 就不会直接看不见了」——
   * 分级是规则跑的，规则一定有漏网的；把 C 也列出来（弱化样式、单独一区、
   * 可折叠），误判就还有救，而不是直接消失在「全部」里。 */
  function matchFilterC(n) {
    return inWindow(n) && n.level === 'C' && matchCtx(n);
  }


  function renderGradeFilters() {
    /* 计数口径 = **近 24 小时**。
     * 用户口径：「A 类的新闻我觉得有点太多了……一天最多十几二十条就非常多了，
     * 我不知道你这上面是不是怎么设置的，有 143 条」。
     * 根因是这里统计的是整个缓存池（保留 72 小时），三天累计当然翻三倍。
     * 分级本身已经按 CRO 规则收紧，这里再把口径对齐到「一天」。 */
    const since = Date.now() - 24 * 3600 * 1000;
    const c = { S: 0, A: 0, B: 0, C: 0 };
    /* v104：计数跟列表同口径（都要过标红闸），否则按钮上写着 40 条、
     * 点进去只有 12 条 —— 用户第一反应是「丢新闻了」。 */
    S.news.forEach(n => { if (n.ts >= since && c[n.level] != null && passRed(n)) c[n.level]++; });
    const in24 = S.news.filter(n => n.ts >= since && passRed(n)).length;
    /* 所有档位统一按「近 24 小时 + 过标红闸」计数，跟列表完全同口径 ——
     * 按钮上写几条、点进去就得是几条，否则用户第一反应是「丢新闻了」。
     * 「全部」不再单独按 72 小时池子计数（那是缓存量，不是展示量）。 */
    const cnt = { key: c.S + c.A, S: c.S, A: c.A, B: c.B, C: c.C,
      all: S.news.filter(n => n.ts >= since && n.level !== 'C' && passRed(n)).length };
    $$('#gradeFilters button').forEach(b => {
      const g = b.dataset.g;
      b.classList.toggle('on', g === S.grade);
      const tag = b.querySelector('b');
      if (tag) tag.textContent = cnt[g] != null ? cnt[g] : 0;
      // 「重点」这一档的 tooltip 说清口径，免得跟池子总数对不上
      if (g === 'key') b.title = `近 24 小时 S+A 级共 ${c.S + c.A} 条（池内 24 小时 ${in24} 条，保留 72 小时）`;
      if (g === 'B') b.title = `近 24 小时 B 级 ${c.B} 组（只算平台标红 ${S.redOnly ? '· 已开启' : '· 未开启'}，首屏 60 组）`;
      if (g === 'all') b.title = `整个缓存池 ${cnt.all} 条（保留 72 小时，含未标红的普通稿，用于回查；一律不含 C）`;
      if (g === 'C') b.title = `近 24 小时 C 级 ${c.C} 条 · 规则判低置信，默认不进信息流`;
    });
  }

  function renderTopicFilters() {
    const box = $('#topicFilters');
    const counts = {};
    S.news.forEach(n => {
      if (!inWindow(n) || !passGrade(n) || !passRed(n)) return;
      w.TOPICS.of(n).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    });
    const list = w.TOPICS.LIST.filter(t => t.id === 'all' || counts[t.id]);
    // 选中的类别即使暂时没有新条目也要留着，避免筛选条自己消失
    if (S.topic !== 'all' && !list.some(t => t.id === S.topic)) {
      list.push(w.TOPICS.LIST.find(t => t.id === S.topic));
    }
    box.innerHTML = list.map(t => {
      const n = t.id === 'all'
        ? S.news.filter(x => inWindow(x) && passGrade(x) && passRed(x)).length
        : (counts[t.id] || 0);
      return `<button data-t="${t.id}" class="${t.id === S.topic ? 'on' : ''}">${esc(t.label)}<b>${n}</b></button>`;
    }).join('');
    // 重绘会把横向滚动条拉回最左，这里把选中的类别滚回视野中央
    const act = box.querySelector('button.on');
    if (act) box.scrollLeft = Math.max(0, act.offsetLeft - box.clientWidth / 2 + act.offsetWidth / 2);
  }

  /* ---------------- 同事件折叠（父子卡片） ----------------
   * 用户口径（原话）：
   *   「开盘期间行情一直下挫，韩国股市下跌 2%，过几十分钟又出现下跌 5%，
   *    但它描述的都是韩国市场这个事情，可以做成子母卡片。
   *    页面上只留一张母卡片，右上角标一个气泡标签『3 条进展』，
   *    点击后下方平滑展开时间轴（13:31 跌达 2% → 13:37 扩大至 2%）。
   *    这样 35 条 A 级消息瞬间折叠成 5~8 个核心大事件。」
   *
   * 分组键 = 主标的 + 方向 + 4 小时时间桶。
   * 只折叠「行情递进」类（标题带百分比且方向明确），
   * 政策/公司类不折 —— 它们本来就是独立事件。
   */
  const EV_BUCKET = 4 * 3600 * 1000;

  /* ---------------- 同一商品涨跌：12 小时母卡（v91） ----------------
   * 用户口径（11-05）：「同一商品涨跌新闻12小时内只留母卡折叠」。
   *
   * 原来行情分组是「主标的 + 自然日」：同一商品的稿件常常挂到不同标的
   * （布伦特那条挂 BRENT+WTI、另一条只挂 WTI），一屏散着五六张
   * 「原油涨 / 原油跌 / 布油站上…」。
   * 现在按**标题里写明的商品名**归一（CM_ALIAS），12 小时会话窗内只留一张母卡，
   * 其余按时间排进子卡时间轴，点子卡能看完整详情（v87 已做）。
   *
   * 「12 小时」是会话窗而非自然日：以簇内最新一条为锚，往前 12 小时内
   * 都算同一波；超出的另起一张，24 小时回溯最多两张母卡。
   * 涨和跌不拆 —— 同一段行情的两个时点，时间轴里连着看才完整。 */
  const CM_WINDOW = 12 * 3600 * 1000;

  /* 商品别名 → 统一簇键。顺序即优先级：先具体品种，泛称「原油」放最后。
   * 只收有连续报价的商品；股指 / 汇率 / 个股 / 加密各有自己的通道。
   * **一个键 = 一个品种**：不按「化工品 / 油脂 / 黑色」这种板块合并 ——
   * 实跑踩过「郑商所丙烯大跌6%」和「苯乙烯跌停」被折进同一张 CHEM 母卡，
   * 那是四个不同商品，不是同一件事物（对齐总则 P6 资产本体）。
   * 以后冒出新品种，只在这里加一行，不用改判定逻辑。 */
  const CM_ALIAS = [
    [/布伦特|布油|Brent/i, 'BRENT'],
    [/WTI|美原油|美油/i, 'WTI'],
    [/液化石油气|LPG/i, 'LPG'],
    [/燃料油/i, 'FUELOIL'],
    [/沥青/i, 'BITUMEN'],
    [/天然气|LNG/i, 'NG'],
    [/动力煤/i, 'THERMALCOAL'],
    [/焦煤/i, 'COKINGCOAL'],
    [/焦炭/i, 'COKE'],
    [/铁矿石|铁矿/i, 'IRON'],
    [/螺纹钢/i, 'REBAR'],
    [/热卷/i, 'HRC'],
    [/不锈钢/i, 'STAINLESS'],
    [/黄金|金价|沪金|XAU/i, 'GOLD'],
    [/白银|银价|沪银/i, 'SILVER'],
    [/沪铜|伦铜|COMEX\s*铜|铜价|国际铜/i, 'COPPER'],
    [/沪铝|氧化铝/i, 'ALUMINUM'],
    [/沪镍|镍价/i, 'NICKEL'],
    [/沪锌/i, 'ZINC'],
    [/沪铅/i, 'LEAD'],
    [/沪锡/i, 'TIN'],
    [/碳酸锂/i, 'LITHIUM'],
    [/工业硅|多晶硅/i, 'SILICON'],
    [/纯碱/i, 'SODA'],
    [/玻璃/i, 'GLASS'],
    [/甲醇/i, 'METHANOL'],
    [/PTA|精对苯二甲酸/i, 'PTA'],
    [/乙二醇/i, 'EG'],
    [/聚丙烯/i, 'PP'],
    [/聚乙烯/i, 'PE'],
    [/塑料|PVC/i, 'PVC'],
    [/苯乙烯/i, 'STYRENE'],
    [/纯苯/i, 'BENZENE'],
    [/丙烯/i, 'PROPYLENE'],
    [/瓶片/i, 'PET'],
    [/棕榈油/i, 'PALM'],
    [/豆油/i, 'SOYOIL'],
    [/菜油/i, 'RAPEOIL'],
    [/豆粕/i, 'SOYMEAL'],
    [/菜粕/i, 'RAPEMEAL'],
    [/白糖/i, 'SUGAR'],
    [/棉花/i, 'COTTON'],
    [/天然橡胶|橡胶|20号胶/i, 'RUBBER'],
    [/纸浆/i, 'PULP'],
    [/生猪/i, 'HOG'],
    [/玉米/i, 'CORN'],
    [/小麦/i, 'WHEAT'],
    [/稻谷/i, 'RICE'],
    [/原油|油价|国际油/i, 'CRUDE'],
  ];
  /* 有方向动作才算「涨跌新闻」 */
  const CM_MOVE = /涨|跌|升|降|站上|失守|突破|跌破|涨停|跌停|重挫|飙升|跳水|反弹|回落|走高|走低|创新高|创新低|报\s*\d/;
  /* 观点 / 预测 / 统计 / 数量口径不是行情本身，该作为独立卡片 */
  const CM_NOT = /协会|机构|报告|研究|观点|解读|分析师|分析称|分析认为|回顾|历史|可比|同比|环比|累计|净流入|净流出|持仓|目标价|评级|预计|有望|料将|可能|或将|考虑|拟|回应|纪要|会议|讨论|计划|产量|进口|出口|收储|招标|投产|复产|检修|ETF|基金|股票|个股|板块|概念股|黄金股|成分股|股价|收评|午评|收盘|涨跌互现|涨跌不一|集体|多数|一览|盘点|期货收盘/;
  /* 事件稿（供给冲击 / 政策 / 库存发布）不进商品簇：它是独立的大事 */
  const CM_EVENT = /OPEC|欧佩克|减产|增产|宣布|决定|签署|制裁|遭袭|遇袭|起火|爆炸|封锁|油轮|炼厂|炼油|海峡|EIA|API|库存|关税|央行|美联储|欧洲央行|利率决议|降息|加息|降准|议息|非农|CPI|通胀/;
  function commodityKeyOf(n) {
    const s = String(n.title || '');
    if (!s || CM_NOT.test(s) || CM_EVENT.test(s) || !CM_MOVE.test(s)) return '';
    for (const pair of CM_ALIAS) if (pair[0].test(s)) return pair[1];
    /* 刻意不做 direct 标的兜底：实跑踩过 ——「港股收评：恒生指数涨3.67%」
     * 的 direct 里挂着 GOLD（贵金属板块联动），靠标的会把 8 条股指收评
     * 全并进黄金母卡。与 clusterKey 同一原则：只按**标题里明确写出来的
     * 主体**聚，没写商品名就宁可不并，别硬凑。 */
    return '';
  }

  function dayBucket(n) {
    const d = new Date(n.ts || Date.now());
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /** 主题簇键：同一机构 + 同一议题（判定在 news-live-client 里，此处不重复实现） */
  function clusterKeyOf(n) {
    const LN = w.LiveNews;
    if (!LN || !LN._clusterKey) return '';
    try { return LN._clusterKey(n.title) || ''; } catch (e) { return ''; }
  }

  /* v101：并卡只认「标题里明确点名的主体」，沿用 commodityKeyOf 的同一原则。
   * 实跑翻车：A 股算力股跌停稿的 direct 只挂了 NDX，和「纳指100统计」
   * 「纳指回调」「英伟达收跌9.3%」全被算成 NDX|同一天 —— 母卡是 A 股新闻、
   * 子卡却全是纳指 / 中概 / 英伟达。根因是 eventKeyOf 直接拿 direct[0]
   * 当分组键，从不检查标题有没有提到这个指数。 */
  const FOLD_ALIAS = {
    NDX: /纳斯达克|纳指|NASDAQ/i, SPX: /标普|S&P|SPX/i, DJI: /道琼斯|道指/i,
    SOX: /费城半导体|费半|SOX/i, VIX: /VIX|恐慌指数/i,
    HSI: /恒生|恒指|港股/i, AX: /上证|沪指|沪市/i, HS300: /沪深300/,
    SZ: /深证成指|深成/, CYB: /创业板/, KC50: /科创50/, SZ50: /上证50/,
    KS11: /韩国|KOSPI|韩股/i, N225: /日经|N225/i, TWII: /台湾加权|台股/,
    GOLD: /黄金|金价|现货金|COMEX\s*金|XAU/i, SILVER: /白银|银价/,
    BRENT: /布伦特|布油|Brent/i, WTI: /WTI|美原油|美油/i,
    NG: /天然气|LNG/i, COPPER: /铜价|沪铜|伦铜|COMEX\s*铜/i,
    BTC: /比特币|BTC/i, ETH: /以太坊|ETH/i, SOL: /索拉纳|SOL/i,
    US5Y: /5年期美债|美债5Y/i, US10Y: /10年期美债|美债10Y|10年期国债收益率/i,
    US30Y: /30年期美债|美债30Y/i,
    DXY: /美元指数|DXY/i, USDCNH: /离岸人民币|CNH/i,
    USDJPY: /美元[/／]日元|USD[/／]JPY|日元汇率/i,
    EURUSD: /欧元[/／]美元|EUR[/／]USD/i
  };
  function titleMentions(k, s) {
    const r = FOLD_ALIAS[k];
    if (r) return r.test(s);
    const a = U.get(k);
    if (!a) return false;
    const nm = String(a.name || ''), sh = String(a.short || '');
    return (nm.length >= 2 && s.indexOf(nm) >= 0)
      || (sh.length >= 2 && s.indexOf(sh) >= 0)
      || s.indexOf(k) >= 0;
  }

  function eventKeyOf(n) {
    /* 同一商品涨跌优先走 12h 母卡（v91），不走后面的「标的 + 自然日」。 */
    const cm = commodityKeyOf(n);
    if (cm) return 'CM:' + cm;
    const keys = (n.direct || []).map(x => x && x.k).filter(Boolean);
    const usKeys = (n.us || []).map(x => x && x.k).filter(Boolean);
    const k = keys[0] || usKeys[0] || '';
    const s = String(n.title || '');
    const hasPct = /\d+(?:\.\d+)?\s*%/.test(s);
    /* 标题点名 ≥2 只 A 股 → 按这几只票自成一组，绝不跟纳指 / 中概 / 英伟达
     * 并成一张母卡。同一波板块行情的多条稿子仍会按同一组股票折在一起。 */
    const cnNamed = (n.cn || []).map(x => x && x.k)
      .filter(x => /^\d{6}$/.test(String(x)) && titleMentions(x, s));
    if (cnNamed.length >= 2) {
      return 'CN:' + cnNamed.slice(0, 4).sort().join('+') + '|' + dayBucket(n);
    }
    /* 主题簇（母子卡）：同一机构 + 同一议题 + 同一天 → 归到一张母卡。
     * 用户口径（11-05）：「像截图里那么多英国央行的消息，其实可以做成母子卡，
     *   不然一眼看下来全部都是央行对加息这件事情的说法。」
     * 只处理**不带百分比**的稿子：带 % 的是行情播报，按标的分组更准
     * （英国央行降息 →「美债收益率跌 5bp」归美债，比归「央行|货币」贴切）。 */
    if (!hasPct) {
      const cl = clusterKeyOf(n);
      return cl ? 'CL:' + cl + '|' + dayBucket(n) : '';
    }
    /* 带 % 但没有落到任何标的上的（「曼恩投票支持加息50个基点至4.25%」
     * 「交易员预计12月加息概率升至50%」），还是回到主题簇 ——
     * 否则它们既进不了行情分组，又散在列表里，用户看到的仍是「一堆央行说法」。 */
    if (!k) {
      const cl = clusterKeyOf(n);
      return cl ? 'CL:' + cl + '|' + dayBucket(n) : '';
    }
    const up = /涨|拉升|走高|反弹|上扬|攀升/.test(s);
    const down = /跌|下挫|跳水|走低|回落|重挫/.test(s);
    if (!up && !down) return '';
    /* 分组口径（用户口径 v49）：
     *   「韩国股市跌 2%，过几十分钟又跌 5%，描述的都是韩国市场这个事情」
     *   → 同一主标的、同一天，就是一回事，不该因为「方向词不同 / 跨了 4 小时桶」
     *     就分成两张卡。
     *
     * 主标的要跳过外汇：日经那条 direct 是 [USDJPY, N225]，
     * 用第一个会把「日经跌 2%」和「美元日元波动」并到一起。
     * 涨跌方向不再进 key —— 从跌 5% 到反弹 2% 是同一段行情的两个时点，
     * 时间轴里按时间排开反而更完整（方向由 progLine 自己表达）。 */
    /* 主标的优先取「指数 / 大宗 / 汇率」这类市场级品种：
     * 「SK海力士跌 8%，韩国综指跌 3.8%」的 direct 第一个是 000660（个股），
     * 而「KOSPI 跌 6%」是 KS11 —— 同一件事被拆成两张卡。
     * 先找指数/商品，再退回「非外汇」，最后才用第一个。 */
    const INDEX_LIKE = /^(KS11|N225|SPX|NDX|DJI|HSI|AX|HS300|SZ|CYB|KC50|SZ50|TWII|SX5E|GOLD|SILVER|BRENT|WTI|NG|COPPER|BTC|ETH|SOL|VIX|DXY|USDCNH|US10Y)/;
    /* 只在标题真的点名的标的里挑主标的。没点名就宁可单独成卡，
     * 也不要靠「沾了点关系的指数」把一堆不同市场的稿子缝成一张。 */
    const pool = [];
    [].concat(keys, usKeys).forEach(x => { if (x && pool.indexOf(x) < 0) pool.push(x); });
    const named = pool.filter(x => titleMentions(x, s));
    if (!named.length) {
      const cl0 = clusterKeyOf(n);
      return cl0 ? 'CL:' + cl0 + '|' + dayBucket(n) : '';
    }
    const main = named.find(x => INDEX_LIKE.test(x))
      || named.find(x => !/^(USD|EUR|JPY|CNH|GBP)/.test(x)) || named[0];
    const d = new Date(n.ts || Date.now());
    const day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    return main + '|' + day;
  }

  /** 把筛选后的条目按事件归并：返回 [{ lead, kids, kind }]，kids 为同组的较早条目。
   *  kind: 'move' = 同一波行情（缺省）；'topic' = 同一机构同一议题的说法合集（母子卡）。
   *
   *  母卡优先取**级别最高**的那条，其次取最新 —— 原来只按时间取最新，
   *  结果一条 S 级会被压在一条 B 级下面当子条目，等于最好的内容被折叠掉了。 */
  const LV_RANK = { S: 0, A: 1, B: 2, C: 3 };
  function leadBetter(a, b) {
    const ra = LV_RANK[a.level] == null ? 9 : LV_RANK[a.level];
    const rb = LV_RANK[b.level] == null ? 9 : LV_RANK[b.level];
    if (ra !== rb) return ra < rb;
    return (a.ts || 0) > (b.ts || 0);
  }
  /** Array.sort 用的数值比较器：级别高的在前，同级别新的在前 */
  function memberCmp(a, b) {
    const ra = LV_RANK[a.level] == null ? 9 : LV_RANK[a.level];
    const rb = LV_RANK[b.level] == null ? 9 : LV_RANK[b.level];
    return ra !== rb ? ra - rb : (b.ts || 0) - (a.ts || 0);
  }
  function foldEvents(items) {
    const map = new Map();
    const out = [];
    for (const n of items) {
      const k = eventKeyOf(n);
      const kind = k && k.slice(0, 3) === 'CL:' ? 'topic'
        : (k && k.slice(0, 3) === 'CM:' ? 'commodity' : 'move');
      if (!k) { out.push({ lead: n, kids: [], kind: '' }); continue; }
      const g = map.get(k);
      if (!g) {
        const grp = { lead: n, kids: [], kind: kind, _cm: kind === 'commodity' };
        map.set(k, grp);
        out.push(grp);
      } else if (leadBetter(n, g.lead)) {
        g.kids.push(g.lead);
        g.lead = n;
      } else {
        g.kids.push(n);
      }
    }
    /* 商品簇：按 12 小时会话窗切开。以簇内最新一条为锚，
     * 与锚相隔 >12h 的另起一张母卡 —— 24 小时回溯最多两张。
     * 不切开的话，前一天夜盘和今天早盘的涨跌会被硬塞进同一张卡。 */
    const out2 = [];
    for (const g of out) {
      if (!g._cm) { out2.push(g); continue; }
      const members = [g.lead].concat(g.kids).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      let bucket = [];
      let anchor = 0;
      const flush = () => {
        if (!bucket.length) return;
        bucket.sort(memberCmp);
        out2.push({ lead: bucket[0], kids: bucket.slice(1), kind: 'commodity' });
        bucket = [];
      };
      for (const m of members) {
        const ts = m.ts || 0;
        if (bucket.length && anchor - ts > CM_WINDOW) flush();
        if (!bucket.length) anchor = ts;
        bucket.push(m);
      }
      flush();
    }
    return out2;
  }

  /** 时间轴小字：把标题压缩成「跌达 2%」这种短句 */
  function progLine(n) {
    const s = String(n.title || '');
    // 去掉来源前缀和标的名，只留变动本身
    let x = s.replace(/^财联社.{0,12}电[，,]?/, '')
      .replace(/^(日经225|日经|韩国KOSPI|KOSPI|韩国综合股价?指数|上证指数|创业板指|恒生指数|纳斯达克|标普500|道琼斯)/, '')
      .replace(/^[，,。]\s*/, '');
    if (x.length > 34) x = x.slice(0, 34) + '…';
    return x || s.slice(0, 24);
  }

  /* ---------------- C 级兜底区（重点视图底部） ----------------
   * 用户口径：「万一有些比较重要的信息被误标 C 就不会直接看不见了」。
   * 分级是规则跑的，规则一定有漏网的；C 级默认就消失等于没有补救机会。
   * 这里把 C 单独列一区：默认展开（收起＝还是看不见，违背初衷），
   * 但样式弱化、虚线分隔，和上面的 S/A 明显分层，不影响重点阅读。 */
  function cReviewHTML(cItems, cardHtml) {
    const open = store.get('mm_crev', '1') !== '0';
    /* 上限 40 条：C 级是「兜底」，不是第二信息流。
     * 全量铺开会把重点视图撑成几十屏，用户反而不会往下看。
     * 超出部分只报数（「另有 N 条」），想看全的走「C」档筛选。 */
    const MAXC = 40;
    const sorted = cItems.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const body = sorted.slice(0, MAXC)
      .map(n => `<div class="ev-solo">${cardHtml(n)}</div>`).join('');
    const more = sorted.length > MAXC
      ? `<div class="c-review-more">另有 ${sorted.length - MAXC} 条，切到「C」档看全</div>` : '';
    return `<section class="c-review" data-cr="${open ? 1 : 0}">
      <button class="c-review-h" aria-expanded="${open ? 'true' : 'false'}">
        <i class="c-review-dot"></i>
        <b>C 级 · 待复核</b>
        <span class="c-review-n">${cItems.length} 条</span>
        <span class="c-review-tip">规则判低置信 · 误判兜底，扫一眼再忽略</span>
        <i class="c-review-arr">▾</i>
      </button>
      <div class="c-review-b"${open ? '' : ' hidden'}>${body}${more}</div>
    </section>`;
  }

  /** 第二层折叠：把「同一机构 + 同一议题」的若干组并成一张母卡（母子卡）。
   *  为什么需要第二层：第一层按标的分组时，同一件事会被拆到不同桶里 ——
   *  「英国央行加息50个基点，英镑升至…」「英国30年期国债收益率升至5.58%」
   *  「贝利：有理由再加息」分属汇率 / 美债 / 央行三个桶，用户看到的还是
   *  一屏五六张卡，全在讲英国央行加息。用户口径（11-05）要的就是这种情况合成母子卡。 */
  function foldByTopic(groups) {
    const map = new Map();
    const out = [];
    for (const g of groups) {
      /* 商品簇已经按 12h 会话窗定稿，不再按「自然日 + 主题」二次合并，
       * 否则刚切开的 12h 边界又会被缝回一张跨 24h 的大卡。 */
      if (g.kind === 'commodity') { out.push(g); continue; }
      const cl = clusterKeyOf(g.lead);
      const k = cl ? 'CL:' + cl + '|' + dayBucket(g.lead) : '';
      if (!k) { out.push(g); continue; }
      const prev = map.get(k);
      if (!prev) {
        const ng = { lead: g.lead, kids: g.kids.slice(), kind: 'topic' };
        map.set(k, ng);
        out.push(ng);
        continue;
      }
      const members = [prev.lead].concat(prev.kids, [g.lead], g.kids);
      members.sort((a, b) => {
        const ra = LV_RANK[a.level] == null ? 9 : LV_RANK[a.level];
        const rb = LV_RANK[b.level] == null ? 9 : LV_RANK[b.level];
        return ra !== rb ? ra - rb : (b.ts || 0) - (a.ts || 0);
      });
      prev.lead = members[0];
      prev.kids = members.slice(1);
      prev.kind = 'topic';
    }
    return out;
  }

  /* ---------------- 视口守卫 ----------------
   * 列表重建之后，卡片里的「消息影响」面板会异步填内容、报价也会刷新，
   * 这些都会把版面撑高，把用户正在看的那张卡顶走几十像素 —— 体感就是
   * 「看着看着跳一下」。这里记住重建时的那张卡与它该在的屏幕位置，
   * 在异步内容落地后再钉一次。
   * 只在「刚重建完 3 秒内」且「用户没自己滑动」时生效，
   * 否则用户一滑就被拽回去，那是更糟的 bug。 */
  const anchorGuard = { id: '', top: 0, until: 0, idle: true };
  function guardArm(id, top) {
    anchorGuard.id = id || '';
    anchorGuard.top = top;
    anchorGuard.until = Date.now() + 3000;
    anchorGuard.idle = true;
  }
  function guardPin() {
    if (!anchorGuard.id || !anchorGuard.idle || Date.now() > anchorGuard.until) return;
    const list = $('#feedList');
    if (!list) return;
    try {
      const escId = (w.CSS && CSS.escape) ? CSS.escape(anchorGuard.id) : String(anchorGuard.id).replace(/["\\]/g, '\\$&');
      const el = list.querySelector('.card[data-id="' + escId + '"]');
      if (!el) return;
      const d = el.getBoundingClientRect().top - anchorGuard.top;
      if (Math.abs(d) > 1) window.scrollBy(0, d);
    } catch (e) {}
  }
  ['touchmove', 'wheel', 'pointerdown'].forEach(ev => {
    try { w.addEventListener(ev, () => { anchorGuard.idle = false; }, { passive: true }); } catch (e) {}
  });

  function renderFeed(keepScroll) {
    renderGradeFilters();
    renderTopicFilters();
    const list = $('#feedList');
    /* 【滚动位置保持】列表是整块 innerHTML 重建的，每次轮询补到新稿都会
     * 让浏览器把滚动位置甩回顶部 —— 用户正在翻看第 30 条，突然弹回最上面，
     * 感受就是「新闻又被重新刷了一遍」。这里重建前后对齐位置。
     * 切档 / 换筛选这类「用户主动换视角」的场景传 keepScroll=false，回到顶部。 */
    const sy = (keepScroll === false) ? 0 : (window.scrollY || 0);
    /* 【滚动锚定】只记住 scrollY 不够：后台轮询会在顶部插入新卡，
     * 同样的像素偏移就落到了不同内容上 —— 用户正在看第 30 条，页面「跳一下」。
     * 记住当前视口顶部那条卡的 data-id 与其位置，重建后把同一条卡对回原位。 */
    let anchorId = '', anchorTop = 0;
    if (keepScroll !== false) {
      try {
        const cs = list.querySelectorAll('.card[data-id]');
        for (let i = 0; i < cs.length; i++) {
          const r = cs[i].getBoundingClientRect();
          if (r.bottom > 8) { anchorId = cs[i].getAttribute('data-id') || ''; anchorTop = r.top; break; }
        }
      } catch (e) {}
    }
    const items = S.news.filter(matchFilter);
    /* C 级兜底区已停用（09:39 用户口径：「C 还是不要上了，太多太乱」）。
     * 老池子里可能还残留极少量 C（合并重算 / 历史数据），这里不再渲染，
     * 免得「C 不上」只做了一半。想查的走「C」档筛选，那一档仍然读池子。
     * cReviewHTML / matchFilterC 保留未删 —— 将来若重启兜底功能可直接复用。 */
    const cItems = [];
    /* 来源筛选生效时，列表顶部放一条明确的「正在只看 X」，并给一键退出 ——
     * 否则用户翻两屏就忘了自己还在筛选中，以为全站只有这几条。 */
    const srcBar = S.srcFilter
      ? `<div class="src-filter-bar">只看来源 <b>${esc(S.srcFilter)}</b> · ${items.length} 条`
        + `<button data-src-clear>显示全部</button></div>`
      : '';
    /* 【中英对照】订阅源（川普推文 / 口罩哥）抓的是英文原话 ——
     * 用户口径（11-06）：「川普的推文可以出中英文对照版，这样子如果翻译出错了，
     *   我还可以看英文」。中文标题/正文在上，英文原文紧随其后。
     * 只对「订阅源 + 确有英文原文 + 与中文标题不同」的条目出这块，
     * 普通中文新闻完全不受影响。翻译没成功时 titleEn === title，不重复贴一遍。 */
    const enSrc = /川普言论|口罩哥KZG/;
    const enBlock = (n) => {
      const en = String(n.titleEn || '').trim();
      if (!en || !enSrc.test(String(n.src || ''))) return '';
      if (en === String(n.title || '').trim()) return '';
      return `<div class="c-en"><span class="c-en-tag">EN</span><span class="c-en-t">${esc(en)}</span></div>`;
    };

    const cardHtml = (n, extra) => {
      // 分类列已经写了「地缘」，标签串里就不再重复「地缘冲突」
      const dup = w.TOPICS.catTopics(n.cat);
      const tps = w.TOPICS.of(n).filter(t => dup.indexOf(t) < 0);
      const dir = (n.direct || []).map(x => chip(x.k)).join('');
      const cn = (n.cn || []).map(x => chip(x.k)).join('');
      const usC = (n.us || []).map(x => chip(x.k)).join('');
      const hkC = (n.hk || []).map(x => chip(x.k)).join('');
      return `<article class="card is-${n.level.toLowerCase()}${n.noAsset ? ' is-macro' : ''}${n.demo ? ' is-demo' : ''}" data-id="${esc(n.id)}">
        <div class="c-top">
          <span class="lv ${LVCLS[n.level] || 'lv-b'}">${n.level}</span>
          ${n.fixed ? '<span class="c-fixed" title="你手工改判过这条（原级见设置 → 标级纠错）">已改判</span>' : ''}
          <span class="c-cat">${esc(n.cat)}</span>
          ${n.noAsset ? '<span class="c-macro" title="这条消息不打单一品种，但它定义了当天的市场基调">全局</span>' : ''}
          ${liveBadge(n)}
          ${spikeBadge(n)}
          <span class="c-tps">${tps.slice(0, 3).map(t => esc(w.TOPICS.label(t))).join(' · ')}</span>
          <span class="c-time">${hhmm(n.ts)} · ${agoText(n.ts)}</span>
        </div>
        <h3 class="c-title">${esc(n.title)}</h3>
        <p class="c-brief"${n.brief ? '' : ' hidden'}>${esc(n.brief || '')}</p>
        ${enBlock(n)}
        ${n.noAsset
          ? `<div class="c-imp macro">
              <div class="imp-h"><span class="imp-tag">全局事件</span><span class="imp-l">未落到单一品种</span></div>
              <p class="imp-note">这类消息不打某一个品种的价格，改的是整体风险偏好 —— 美股、美债、黄金、美元会一起重定价。点开看影响链。</p>
            </div>`
          : `<div class="c-imp" data-imp="${esc(n.id)}" hidden></div>`}
        ${dir ? `<div class="c-row" data-chips="${esc(n.id)}"><span class="c-lab">关联标的</span><div class="chips">${dir}</div></div>` : ''}
        ${usC ? `<div class="c-row"><span class="c-lab lab-us">美股映射</span><div class="chips">${usC}</div></div>` : ''}
        ${hkC ? `<div class="c-row"><span class="c-lab lab-hk">港股映射</span><div class="chips">${hkC}</div></div>` : ''}
        ${cn ? `<div class="c-row"><span class="c-lab lab-cn">A股映射</span><div class="chips">${cn}</div></div>` : ''}
        ${n.chain ? `<div class="c-chain">${n.chain.map((x, i) => `<span class="ch ${i === 0 ? 'ch-first' : ''}">${esc(x)}</span>`).join('')}</div>` : ''}
        ${srcHTML(n, 'c-src')}
        ${extra || ''}
      </article>`;
    };

    /* ---------------- 同事件折叠（父子卡片） ----------------
     * 母卡片只留最新一条，右上角一个「N 条进展」气泡；
     * 点开在下方平滑展开时间轴（13:31 跌达 2% → 13:37 扩大至 2%）。 */
    /* 【严格时间序】foldEvents 会把同一商品的多个 12h 时间桶「连续」推入，
     * 于是 15 小时前那张旧母卡被紧贴在新母卡后面，中间的其他新闻被跳过 ——
     * 用户看到「上一张涨 4%、下一张跌 1.38%」实际相隔 15 小时，很困惑。
     * 折叠只负责「合并」，不负责顺序；合并完必须按每张卡的展示时间(lead.ts)
     * 全局重排一次，保证没并进同一张卡的条目严格按时间倒序。 */
    const folded = foldByTopic(foldEvents(items))
      .sort((a, b) => (b.lead.ts || 0) - (a.lead.ts || 0));
    /* 分页渲染：B 档 / 全部档动辄两三百条，一次铺满会卡手机、也「太多太乱」。
     * 用户口径（11-05）：「b 怎么 350 条，多了那么多」——
     * 数字是真实的（24 小时全量快讯里 85% 都落在 B），不是重复；
     * 问题是**一次性把 350 张卡全渲染出来**。所以这里首屏只铺 60 组，
     * 剩下的用「加载更多」按需展开，计数仍然显示真实的 24h 条数。 */
    const PAGE = 60;
    const paged = (S.grade === 'B' || S.grade === 'all');
    const limit = paged ? Math.max(60, S.limit || 60) : folded.length;
    const visible = folded.slice(0, limit);
    const rest = folded.length - visible.length;
    const mainHtml = visible.map(({ lead, kids, kind }) => {
      if (!kids.length) return `<div class="ev-solo">${cardHtml(lead)}</div>`;
      /* 两种折叠语义分开说：行情是「进展」，同题说法是「同题」。
       * 都说成「进展」会让人以为央行连着改了六次口风。 */
      const label = kind === 'commodity'
        ? `同商品 ${kids.length + 1} 条`
        : (kind === 'topic'
          ? `同题 ${kids.length + 1} 条`
          : `${kids.length + 1} 条进展`);
      const badge = `<button class="ev-badge" aria-expanded="false">`
        + `<i class="ev-dot"></i>${label}<i class="ev-arr">▾</i></button>`;
      const timeline = `<div class="ev-kids">`
        + [lead].concat(kids)
          /* v92 用户口径：「子母卡展开 应该是时间越近的在越上面」。
           * 原来按时间升序铺 00:46 → 23:24，最新一条压在最底下，
           * 展开第一眼看到的反而是最旧的进展。改为降序（新→旧）。 */
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .map(x => `<div class="ev-tl" data-tlid="${esc(x.id)}" role="button" tabindex="0">`
            + `<b>${hhmm(x.ts)}</b><span>${esc(progLine(x))}</span><i class="ev-tl-g">›</i></div>`)
          .join('')
        + `</div>`;
      /* 气泡必须挂在**卡片**里，不能挂在 ev-group 上 ——
       * 挂在组上时它相对整组定位，展开时间轴后组变高，
       * bottom:10px 就跟着跑到时间轴底部，反而把展开的内容挡住了。 */
      return `<div class="ev-group">${cardHtml(lead, badge)}${timeline}</div>`;
    }).join('');

    if (!items.length) {
      const hints = [];
      if (S.grade !== 'all') hints.push(S.grade + ' 级');
      if (S.topic !== 'all') hints.push(w.TOPICS.label(S.topic));
      if (S.srcFilter) hints.push('来源：' + S.srcFilter);
      list.innerHTML = `<div class="empty">
        <b>没有符合条件的快讯</b>
        <span>${hints.length ? '当前筛选：' + esc(hints.join(' · ')) : '快讯源暂时没有达到阈值的条目'}</span>
        ${S.srcFilter ? '<button class="mini-btn" data-src-clear>显示全部来源</button>' : ''}
      </div>`;
      return;
    }

    const moreHtml = rest > 0
      ? `<button class="feed-more" data-more="${folded.length}">加载更多 · 还有 ${rest} 条</button>`
      : (paged && folded.length >= PAGE
        ? `<div class="feed-end">已到 24 小时内该级别的全部 ${folded.length} 条</div>` : '');

    const quoteKeys = [];
    items.slice(0, 12).forEach(n => {
      (n.direct || []).forEach(x => quoteKeys.push(x.k));
      (n.us || []).forEach(x => quoteKeys.push(x.k));
      (n.hk || []).forEach(x => quoteKeys.push(x.k));
      (n.cn || []).forEach(x => quoteKeys.push(x.k));
    });

    /* 【内容没变就绝不重建 DOM】
     * 后台每 25 秒轮询一次。原来不管有没有新稿都整块 innerHTML 重建：
     * 列表先被清空、浏览器把滚动位置夹一下、再重排 —— 用户正在看第 30 条，
     * 屏幕就「跳一下」。锚点补偿只能修「最终位置」，修不掉中间那一帧的闪动，
     * 所以必须从源头减少重建次数。
     * 指纹里带上卡片 id、折叠条数、首条时间与筛选条件：只要内容真的变了
     * （新稿进来 / 合并 / 换档）就重建一次；没变就只刷报价，DOM 一动不动。 */
    const renderKey = [
      S.grade, S.topic, S.srcFilter || '', limit,
      folded.length,
      visible.map(v => v.lead.id + ':' + (v.lead.ts || 0) + ':' + (v.kids ? v.kids.length : 0)).join(','),
    ].join('|');
    if (keepScroll !== false && renderFeed._key === renderKey) {
      QuoteHub.refresh(Array.from(new Set(quoteKeys)));
      runVerify(items);
      return;
    }
    renderFeed._key = renderKey;

    /* 重建前记下列表总高度：新稿插到顶部时用它补偿「内容整体下移」的量。
     * 只在锚点卡找不到时使用（锚点卡被新稿挤出前 N 条时会发生）。 */
    const prevH = list.offsetHeight;
    /* 入场渐隐只在首屏播一次：重播会让整屏「闪一下」（见 CSS #feedList.anim-in） */
    const firstPaint = !renderFeed._painted;
    renderFeed._painted = true;
    if (firstPaint) list.classList.add('anim-in');
    else list.classList.remove('anim-in');
    list.innerHTML = srcBar + mainHtml + moreHtml;

    if (keepScroll !== false && !firstPaint) {
      /* 【首次渲染不补偿】首屏列表本就是空的（prevH≈0、无锚点卡），
       * 此时若走兜底 dh 补偿会把整页高度 scrollBy 到最底部 —— 这正是
       * 「一刷新就跳到底部、要往上滑才能看到最新」的根因。首屏没有
       * 任何要保留的滚动位置，停在顶部（最新新闻）才是对的。 */
      /* 【锚点卡保位】把用户正在看的那张卡钉回原来的屏幕位置。
       * 用「视口相对 top」而不是绝对坐标：目标是「它看起来没动」，
       * 视口坐标直接可比，也不受页面总高变化影响。 */
      const pin = () => {
        if (!anchorId) return false;
        try {
          const escId = (w.CSS && CSS.escape) ? CSS.escape(anchorId) : String(anchorId).replace(/["\\]/g, '\\$&');
          const el = list.querySelector('.card[data-id="' + escId + '"]');
          if (!el) return false;
          const delta = el.getBoundingClientRect().top - anchorTop;
          if (Math.abs(delta) > 1) window.scrollBy(0, delta);
          return true;
        } catch (e) { return false; }
      };
      if (!pin()) {
        /* 锚点卡不在了（被合并 / 被挤出可见区间）→ 用高度差补偿：
         * 顶部新增多少高度，就把视口往下推多少，视觉内容保持不动。 */
        const dh = list.offsetHeight - prevH;
        if (Math.abs(dh) > 1) window.scrollBy(0, dh);
      }
      /* 双帧校正：重建当帧字体尚未回流、卡片进场动画也在跑，
       * 单次补偿可能差几像素。下一帧再对一次锚点，把残余偏移补掉。 */
      if (anchorId) {
        requestAnimationFrame(() => {
          try {
            const escId = (w.CSS && CSS.escape) ? CSS.escape(anchorId) : String(anchorId).replace(/["\\]/g, '\\$&');
            const el = list.querySelector('.card[data-id="' + escId + '"]');
            if (!el) return;
            const d2 = el.getBoundingClientRect().top - anchorTop;
            if (Math.abs(d2) > 1) window.scrollBy(0, d2);
          } catch (e) {}
        });
      }
    } else if (sy > 4) {
      const maxY = Math.max(0, (d.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
      try { window.scrollTo(0, Math.min(sy, maxY)); } catch (e) {}
    }

    /* 异步内容（消息影响面板 / 报价）落地后可能再撑高版面，交给视口守卫兜一次 */
    if (keepScroll !== false && anchorId) guardArm(anchorId, anchorTop);

    QuoteHub.refresh(Array.from(new Set(quoteKeys)));
    runVerify(items);
  }

  /* ---------------- 消息 → 实际影响 ---------------- */
  let vfSeq = 0;

  // 迷你走势：虚线是「消息出来的那一刻」，右侧是消息之后
  function sparkSVG(spark, up) {
    if (!spark || spark.length < 4) return '<span class="imp-sp-ph"></span>';
    const W = 64, H = 22, P = 2.5;
    const vs = spark.map(p => p.v).concat([0]);
    let mx = Math.max.apply(null, vs);
    let mn = Math.min.apply(null, vs);
    if (mx - mn < 1e-9) { mx = 0.05; mn = -0.05; }
    const x = i => P + (i / (spark.length - 1)) * (W - P * 2);
    const y = v => H - P - ((v - mn) / (mx - mn)) * (H - P * 2);
    const dd = spark.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    const mi = spark.findIndex(p => p.i === 0);
    const mvx = mi >= 0 ? x(mi).toFixed(1) : null;
    const col = up ? 'var(--up)' : 'var(--down)';
    return `<svg class="imp-sp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
      + (mvx != null ? `<line x1="${mvx}" y1="0" x2="${mvx}" y2="${H}" stroke="#39415a" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>` : '')
      + `<path d="${dd}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
      + `</svg>`;
  }

  async function runVerify(items) {
    // 只验证真实抓取的快讯：演示条目没有真实发布时间，
    // 去对行情做「消息后 5 分钟」归因只会得出编造的因果关系
    const todo = items.filter(n => n.live === true && !n.noAsset && (n.direct || []).length).slice(0, 8);
    if (!todo.length) return;
    const seq = ++vfSeq;
    let res = {};
    try { res = await w.NewsVerify.checkMany(todo, 8); } catch (e) { return; }
    if (seq !== vfSeq) return;

    let needRetry = false;
    Object.keys(res).forEach(id => {
      const el = d.querySelector(`.c-imp[data-imp="${cssq(id)}"]`);
      if (!el) return;
      const r = res[id];
      const src = todo.find(x => x.id === id) || {};
      if (r.partial) needRetry = true;
      const rows = r.items.map(it => {
        const f5 = w.NewsVerify.fmt(it);
        const fd = w.NewsVerify.fmtDay(it);
        /* 主数字用「当日涨跌」：一条「布油失守100美元」写成「5 分钟 -0.33%」，
         * 看着像没跌，实际当日已经 -3.6% —— 这个口径会把风险讲小。
         * 5 分钟只作为小字附注，说明「这条消息自己打出的边际反应」。
         * 收益类（美债）的当日百分比口径与基点对不上，仍以 5 分钟基点为主。 */
        const useDay = !!fd && it.unit !== 'bp';
        const main = useDay ? fd : f5;
        const sub = useDay ? `<i class="imp-5m" title="消息发出后 5 分钟的边际变动">5分 ${f5.text}</i>` : '';
        // 消息出来前就在同向跑 → 资金抢跑，这是很值钱的信息
        const sc = w.NewsVerify.scaleOf(it.k);
        const pre = (Math.abs(it.pre || 0) >= sc.clear && Math.sign(it.pre) === Math.sign(it.chg))
          ? '<i class="imp-pre" title="消息出来前 12 分钟就已经同向在跑，资金抢跑">抢跑</i>' : '';
        return `<div class="imp-r${(it.moved || (useDay && Math.abs(main.pct) >= 1)) ? '' : ' quiet'}">
          <span class="imp-n">${esc(main.name)}${pre}</span>
          ${sub}
          ${sparkSVG(it.spark, main.up)}
          <b class="${main.up ? 'up' : 'down'}">${main.text}</b>
        </div>`;
      }).join('');
      // 没打出波动的消息不该占三行 —— 压成一行，把版面留给真正有反应的
      // 拿不到当日快照时不能说「当日涨跌」——那是 5 分钟口径，混着写就是误导
    const anyDay = (r.items || []).some(it => it.day != null && it.unit !== 'bp');
    const chgLab = anyDay ? '当日涨跌' : '消息后 5 分钟';
    if (r.verdict === 'flat') {
        el.className = 'c-imp tight';
        el.hidden = false;
        el.innerHTML = `<div class="imp-flat">
          <span class="if-l">${r.partial ? '已到 ' + r.items.length + '/' + ((src.direct || []).length || r.items.length) + ' 个标的' : chgLab}</span>
          ${r.items.map(it => {
            const fd = w.NewsVerify.fmtDay(it);
            const f = (fd && it.unit !== 'bp') ? fd : w.NewsVerify.fmt(it);
            return `<span class="if-i">${esc(f.name)}<b class="${f.up ? 'up' : 'down'}">${f.text}</b></span>`;
          }).join('')}
        </div>`;
      } else {
        el.className = 'c-imp ' + r.verdict;
        el.hidden = false;
        el.innerHTML = `<div class="imp-h">
            <span class="imp-tag">${esc(r.label)}</span>
            <span class="imp-l">${r.partial ? '数据积累中' : chgLab} · 最大 ${esc(r.maxTxt || '')}</span>
          </div>
          <div class="imp-list">${rows}</div>`;
      }
      // 关联标的清单始终保留：验证可能只覆盖到部分品种，清单才是完整的
    });

    // 刚发出来的消息，分钟线还没走到「消息后 5 分钟」——过一会儿自动重算一次
    if (needRetry) {
      clearTimeout(runVerify._t);
      runVerify._t = setTimeout(() => {
        if (vfSeq === seq) { w.NewsVerify.clear && w.NewsVerify.clear(); renderFeed(); }
      }, 95000);
    }
    /* 面板填完再钉一次位置（见 guardPin 注释）*/
    guardPin();
  }

  function renderSNR() {
    const st = S.liveStats;
    const box = $('#snr');
    if (S.flashState === 'live' && st && st.fetched) {
      const det = st.srcDetail || [];
      const okN = det.filter(x => x.ok).length;
      /* 文案口径（v115）：
       *   st.kept   = 这一轮抓取里通过筛选的条数（去重前）
       *   在库 N    = 近 24 小时、过标红闸、跨源合并之后的实际展示条数
       * 两者天然不等（同一件事被财联社/见闻/格隆汇重复报道会合并成一张卡），
       * 所以必须分别写清楚，否则用户会拿 78 和 63 对照，以为丢了 15 条。 */
      const since24 = Date.now() - 24 * 3600 * 1000;
      const in24 = S.news.filter(n => (n.ts || 0) >= since24 && n.level !== 'C' && passRed(n)).length;
      box.innerHTML = `<b>${st.kept}</b> 条本轮通过 · 去重合并后 <b>${in24}</b> 条在库
        · S ${st.s || 0} / A ${st.a || 0} / B ${st.b || 0}
        · 丢弃 <b>${(100 - (st.snr || 0)).toFixed(1)}%</b>
        <span class="snr-note">扫描 ${st.fetched} 条 · ${det.length ? okN + '/' + det.length : (st.sources || []).length} 源在线</span>`;
      return;
    }
    const live = S.news.filter(n => n.live === true).length;
    const other = S.news.length - live;
      box.innerHTML = live
      ? `<b>${live}</b> 条在库${other ? ` · <b>${other}</b> 条示例/演示` : ''}
         <span class="snr-note">${S.flashState === 'live' ? '实时抓取中' : (S.flashState === 'connecting' ? '正在接入新闻源…' : '快讯源当前未接入，保留上次抓到的内容')}</span>`
      : `<b>0</b> 条 · <span class="snr-note">${S.flashState === 'connecting' ? '正在接入新闻源…' : '未接入真实快讯源 · 本终端不提供任何伪造新闻兜底'}</span>`;
  }

  /* ---------------- 逐源状态 ----------------
   * 把本轮抓取结果按源摊开：哪个源通了（几条、走哪条通道）、哪个源挂了（原因）。
   * 数据来自 LiveNews.collect() 返回的 stats.srcDetail，服务端形态下由后端 stats 兼容。 */
  /* ---------------- 源状态持久化（重载后不闪「未接入」） ----------------
   * 用户口径（11-06）：「所有源都是接通的状态，刷新就不去动源」。
   * 手机浏览器/微信 webview 的原生下拉刷新有时拦不住，会整页重载，
   * 内存里的源状态随之清零 —— 页面于是显示「连接中 / 未接入」，
   * 要等一轮抓取跑完才恢复，体感就是「每次刷新源都重新接一遍」。
   * 这里把上一轮的逐源结果落盘，启动时先铺上去：界面立刻是「已接入 N/N」，
   * 真实抓取在后台静默覆盖。源真挂了也会在首轮之后如实刷新。
   * TTL 30 分钟：超过就不要了，避免长时间没打开时展示过期的"全通"假象。 */
  const SRC_STATE_KEY = 'mm_srcdetail_v1';
  const SRC_STATE_TTL = 30 * 60 * 1000;

  function saveSrcState(st) {
    try {
      if (!st || !Array.isArray(st.srcDetail) || !st.srcDetail.length) return;
      store.set(SRC_STATE_KEY, {
        t: Date.now(),
        srcDetail: st.srcDetail.map(d => ({
          name: d.name, ok: !!d.ok, count: Number(d.count) || 0,
          err: d.ok ? '' : String(d.err || '').slice(0, 120), via: d.via || '',
        })),
        fetched: st.fetched || 0, kept: st.kept || 0,
        s: st.s || 0, a: st.a || 0, b: st.b || 0, filtered: st.filtered || 0,
        snr: st.snr || 0,
      });
    } catch (e) { /* 存不下就只是没有这层兜底 */ }
  }

  function restoreSrcState() {
    let v = null;
    try { v = store.get(SRC_STATE_KEY, null); } catch (e) { return false; }
    if (!v || !v.t || Date.now() - v.t > SRC_STATE_TTL) return false;
    if (!Array.isArray(v.srcDetail) || !v.srcDetail.length) return false;
    const okList = v.srcDetail.filter(d => d.ok);
    S.liveStats = {
      srcDetail: v.srcDetail,
      sources: okList.map(d => d.name + ':' + d.count),
      fetched: v.fetched, kept: v.kept, filtered: v.filtered,
      s: v.s, a: v.a, b: v.b, snr: v.snr || 0,
      restored: true,
    };
    /* 上一轮有源接通 → 直接按「实时」渲染，别让顶部先闪一个"未接入" */
    if (okList.length) S.flashState = 'live';
    return true;
  }

  function srcDetailList() {
    const st = S.liveStats;
    if (!st) return [];
    if (Array.isArray(st.srcDetail) && st.srcDetail.length) return st.srcDetail;
    // 服务端形态：只有 sources 字符串，退化成「name:count」列表
    return (st.sources || []).map(s => {
      const p = String(s).split(':');
      return { name: p[0], ok: true, count: parseInt(p[1], 10) || 0, err: '', via: '服务端' };
    });
  }

  /* 「失败」要分两种，别混成一个红叉：
   *   need —— 站点不开放跨域，必须经中转；浏览器里本来就取不到，装 App 就能直取
   *   bad  —— 真的挂了（HTTP 错误 / 超时 / 格式变了），需要修
   * 混在一起会让人以为「九个源挂了五个」，其实只有一个是真的坏。 */
  function needRelay(d) {
    return !d.ok && /不开放跨域|必须经中转|需要中转/.test(String(d.err || ''));
  }

  function renderSrcGrid() {
    const box = $('#srcGrid');
    if (!box) return;
    const det = srcDetailList();
    /* 首次安装 / 清过缓存时没有历史状态可恢复，第一轮抓取要几秒才有结果。
     * 以前这里直接留空，用户看到的就是「源状态整块消失」，很像坏了。
     * 给一句「正在接入」的占位，明确告诉用户是在连、不是没连上。 */
    if (!det.length) {
      box.innerHTML = '<span class="srcgrid-hd">正在接入新闻源…</span>';
      return;
    }
    const okN = det.filter(x => x.ok).length;
    const needL = det.filter(needRelay);
    const hard = det.filter(x => !x.ok && !needRelay(x));
    const tail = (needL.length ? ' · ' + needL.length + ' 需中转' : '')
      + (hard.length ? ' · ' + hard.length + ' 失败' : '');
    box.innerHTML = `<span class="srcgrid-hd">源状态 ${okN}/${det.length}${tail}</span>`
      + det.map(d => {
        const isNeed = needRelay(d);
        const cls = d.ok ? 'ok' : isNeed ? 'need' : 'bad';
        /* 数字必须是「点开后真能看到几条」，而不是「本轮抓到几条」。
         * 用户报：口罩哥显示 12、川普显示 10，点进去只有 2 条 / 0 条 ——
         * 因为抓回来的原始条目大部分被判 C 丢弃或跨源合并了。
         * 显示原始抓取量会让人以为筛选坏了。 */
        const shown = S.news.filter(n => String(n.src || '').indexOf(d.name) >= 0).length;
        const tip = d.ok
          ? (shown
              ? `${d.name}：入库 ${shown} 条（本轮抓取 ${d.count} 条，其余判为杂讯或与其他源合并）`
                + ` · ${d.via || '直连'} · 点一下只看这个源`
              /* 0 条要区分「源挂了」和「源通了但这一时段没有标红稿」——
               * 东方财富、财联社这类源在一段时间内确实可能一条标红都没有，
               * 显示 0 会让人误以为抓取坏了。 */
              : `${d.name}：已接通，本轮抓取 ${d.count} 条，`
                + `但都不是平台标红稿（当前口径只显示标红）· ${d.via || '直连'}`)
          : isNeed
            ? `${d.name}：不开放跨域，网页版取不到；App 版内置直取通道，可正常拉到`
            : `${d.name} 不可用：${d.err || '未知原因'}（${d.via || '直连'}）`;
        const badge = d.ok ? shown : isNeed ? '⇄' : '!';
        const on = S.srcFilter === d.name;
        /* 有数据的源做成可点的：点一下只看这个源，再点取消。
         * 挂了的源不给点（点了也是空的，只会误导）。 */
        if (!d.ok) {
          return `<span class="sg ${cls}" title="${esc(tip)}"><i class="sg-dot"></i>${esc(d.name)}`
            + `<b class="sg-n">${badge}</b></span>`;
        }
        return `<button class="sg ${cls}${on ? ' on' : ''}${shown ? '' : ' zero'}" data-src="${esc(d.name)}" title="${esc(tip)}">`
          + `<i class="sg-dot"></i>${esc(d.name)}<b class="sg-n">${badge}</b></button>`;
      }).join('');
    /* 事件委托挂在容器上；每次 renderSrcGrid 都重设一次 onclick，
     * 不会叠加监听（覆盖写），也不会因为 innerHTML 重建而失效。 */
    box.onclick = (e) => {
      const b = e.target.closest('.sg[data-src]');
      if (!b) return;
      const name = b.dataset.src;
      S.srcFilter = (S.srcFilter === name) ? '' : name;
      renderSrcGrid();
      renderFeed();
      // 筛选后回到列表顶部，否则用户还停在滚动位置看不出变化
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) {}
    };
  }

  function renderSrcList() {
    const det = srcDetailList();
    if (!det.length) return '';
    const okN = det.filter(x => x.ok).length;
    return `<div class="srclist">` + det.map(d => {
      const isNeed = needRelay(d);
      const cls = d.ok ? 'ok' : isNeed ? 'need' : 'bad';
      const ic = d.ok ? '✓' : isNeed ? '⇄' : '✕';
      const meta = d.ok
        ? `${d.count} 条 · ${d.via || '直连'}`
        : `${d.err || '未知原因'} · ${d.via || '直连'}`;
      return `<div class="srcrow ${cls}"><span class="sr-ic">${ic}</span>`
        + `<span class="sr-main"><span class="sr-name">${esc(d.name)}</span>`
        + `<span class="sr-meta">${esc(meta)}</span></span></div>`;
    }).join('') + `</div>`
      + `<div class="srcrow idle" style="margin-top:2px"><span class="sr-ic">·</span><span class="sr-main">`
      + `<span class="sr-meta">本轮 ${okN}/${det.length} 个源可用。失败源会在下一轮自动重试，`
      + `必要时可切到服务端形态（server.py）获取完整 8 源。</span></span></div>`;
  }

  /* ---------------- 雷达 ---------------- */
  let radar = null;

  const chgLabel = (r) => {
    if (r.bp == null) return U.pct(r.chg);
    const s = r.bp.toFixed(1);
    if (Math.abs(parseFloat(s)) < 0.05) return '0.0bp';
    return (r.bp >= 0 ? '+' : '') + s + 'bp';
  };

  const ST_TEXT = {
    quiet: '平静', attributed: '异动·已归因', unattributed: '异动·未归因',
    'news-confirmed': '新闻补获', closed: '休市', offline: '取数失败'
  };

  const SCALE_NAME = {
    flash: '1~3 分钟', fast: '5 分钟', mid: '15 分钟', slow: '30 分钟',
    1: '1 分钟', 2: '2 分钟', 3: '3 分钟', 5: '5 分钟', 15: '15 分钟', 30: '30 分钟'
  };

  /** 统一的窗口文案：优先用真实 win，别用档位名糊过去 */
  const winTxt = (r) => {
    if (r && r.win === 0) return '当日累计';       // 跳空 / 慢跌的「尺度」就是全天
    const v = r && r.win;
    return (v ? v + ' 分钟' : (SCALE_NAME[r && r.scale] || '30 分钟'));
  };

  /* 预警语句 —— 必须把「持续了多久」「这波多少」「当日多少」三件事分开说。
   * 用户截图里 VIX 已经跌了 46 分钟、当日 -18.67%，横幅却写
   * 「5 分钟直线跳水 -18.67%」：`r.win || 5` 把当日尺度(win=0) 兜成了 5，
   * 而 chgLabel 给的是当日幅度 —— 两处叠加，等于把当日跌幅谎报成 5 分钟跌幅。
   * 规则（用户口径）：
   *   ① 本轮已持续 ≥8 分钟 → 「近 N 分钟持续下跌 x%，当日跌幅已达 y%」
   *   ② 本轮很短          → 「5 分钟内迅速跳水 x%，当日跌幅已达 y%」
   *   ③ 跌幅主要在开盘跳空 → 「今日跳空低开 x%」（不许说「持续 N 分钟」）
   */
  const magTx = (v, bp) => (bp == null
    ? Math.abs(v).toFixed(2) + '%'
    : Math.abs(v).toFixed(1) + 'bp');

  const alarmWords = (r) => {
    /* v260：重复提醒状态机给出的精确标签（V 反 / 再下一台阶）优先，
     * 否则会被「近 N 分钟持续下跌」这类通用文案盖掉，用户看不出是升级报警。 */
    if (r.alertLabel) return r.alertLabel;
    const day = (r.dayPct != null && Math.abs(r.dayPct) >= 0.05) ? r.dayPct : null;
    const dayAbs = day == null ? null : Math.abs(day);
    const R = r.run;
    /* 加密 24 小时交易，没有「今日开盘」这回事 —— dayPct 的基准是币安 ticker
     * 的 24 小时前价格。把这句写成「今日累计」，用户会以为涨的是今天白天
     * （用户截图：ETH「今日累计上涨 7.24%」，实际那 7% 是昨晚 22:00 一波走完的）。
     * 所以加密改口径叫「近 24 小时」，其余品种仍按当日。 */
    const dayWord = (U.get(r.key) || {}).grp === 'crypto' ? '近 24 小时' : '今日';
    /* 维持状态：这一轮没有新的窗口越线，但**波动率仍显著高于常态** ——
     * 行情还没平息（用户口径：「回落也是杀盘」）。
     * 这时候说「某分钟迅速拉升」是错的，应该说清「还在剧烈波动」，
     * 并且给出量化依据（当前波动率是常态的几倍），让用户知道不是拍脑袋。 */
    if (r.holding) {
      const z = r.volZ && r.volZ > 0 ? r.volZ.toFixed(1) : '';
      const dz = dayAbs == null ? ''
        : `，${dayWord}累计${day >= 0 ? '上涨' : '下跌'} ${dayAbs.toFixed(2)}%`;
      return z ? `波动仍未平息（当前波动率是常态的 ${z} 倍）${dz}` : `波动仍未平息${dz}`;
    }
    if (R && R.durMin >= 8) {
      const up = R.cum >= 0;
      const gap = R.gapPct || 0;
      const cumAbs = Math.abs(R.cum);
      const tail = R.expanding
        ? `，${up ? '涨幅' : '跌幅'}仍在扩大` : '，动能已衰减';
      // ① 跳空型：既要说清「跌了多久」，也不能隐瞒其中大半是开盘一次走完的
      if (R.day && dayAbs != null && Math.abs(gap) >= 0.5 && Math.sign(gap) === Math.sign(R.cum)) {
        const again = (R.openPct || 0) >= 0;
        return `近 ${R.durMin} 分钟持续${again ? '上涨' : '下跌'} ${magTx(R.openPct || 0, r.bp)}`
          + `（开盘已跳空${gap >= 0 ? '高开' : '低开'} ${Math.abs(gap).toFixed(2)}%）`
          + `，当日${up ? '涨幅' : '跌幅'}已达 ${dayAbs.toFixed(2)}%`
          + (R.expanding ? '，波动仍在扩大' : '');
      }
      // ② 累计≈当日（起点就是昨收）：同一个数字不要在一句话里说两遍
      if (r.bp == null && dayAbs != null
        && Math.sign(R.cum) === Math.sign(day) && Math.abs(cumAbs - dayAbs) < 0.2) {
        return `${dayWord}累计${up ? '上涨' : '下跌'} ${cumAbs.toFixed(2)}%，已持续 ${R.durMin} 分钟${tail}`;
      }
      // ③ 普通持续：窗口只是这一波，当日另有更大的数字
      const dayTx = dayAbs == null ? ''
        : `，当日${day >= 0 ? '涨幅' : '跌幅'}已达 ${dayAbs.toFixed(2)}%`;
      return `近 ${R.durMin} 分钟持续${up ? '上涨' : '下跌'} ${magTx(R.cum, r.bp)}${dayTx}${tail}`;
    }
    const dayTx = dayAbs == null ? ''
      : `，当日${day >= 0 ? '涨幅' : '跌幅'}已达 ${dayAbs.toFixed(2)}%`;
    /* 当日尺度命中、但最近这一段还不长：说的是「今天累计跌了多少」，
     * 不能写「今日迅速跳水」—— 那等于把一整天的跌幅说成一次跳水。 */
    if (r.win === 0 && dayAbs != null) {
      /* 「最近 N 分钟仍在上行」必须真有幅度，否则就是凑字。
       * 用户报：ETH 横盘时段，横幅写「最近 3 分钟仍在上行」，
       * 但分时图上是平的 —— 那 3 分钟其实只动了 0.005%。
       * 门槛取「该品种 5 分钟阈值的 1/8」与 0.1% 中的小者，噪声级别不算「在走」。 */
      const minMove = Math.min(0.1, (r.thr || 1) * 0.125);
      const still = (R && R.durMin >= 2 && Math.abs(R.cum) >= minMove)
        ? `，最近 ${R.durMin} 分钟${R.cum >= 0 ? '仍在上行' : '仍在走低'} ${Math.abs(R.cum).toFixed(2)}%` : '';
      return `${dayWord}累计${day >= 0 ? '上涨' : '下跌'} ${dayAbs.toFixed(2)}%${still}`;
    }
    const head = (r.win || 5) + ' 分钟内';
    return `${head}迅速${r.chg >= 0 ? '拉升' : '跳水'} ${magTx(r.bp == null ? r.chg : r.bp, r.bp)}${dayTx}`;
  };

  function radarSummary(results, inst) {
    const un = results.filter(r => r.status === 'unattributed');
    const attr = results.filter(r => r.status === 'attributed');
    const closed = results.filter(r => r.status === 'closed').length;
    const off = results.filter(r => r.status === 'offline').length;
    // 逼近阈值：还没击穿，但已经用掉 80% 以上的额度 —— 提前给个眼神
    const near = results.filter(r => r.status === 'quiet' && Math.abs(r.chg) / (r.thr || 1) >= 0.8).length;
    // 新闻补获：行情链路漏掉、靠新闻报出来又经 K 线验证的事件
    const news = (inst && inst.newsLog ? inst.newsLog : []).filter(x => Date.now() - x.at < 4 * 3600e3).length;
    // 动态波动率库覆盖情况
    const vp = w.VolProfile;
    const bankDays = vp && vp.VolBank ? vp.VolBank.size : 0;
    const dyn = results.filter(r => r.thrSrc === 'adaptive' || r.thrSrc === 'blend').length;
    const total = results.length || 1;

    // 一行数字带：首屏要直接看到矩阵，说明性文字全部沉到页底折叠块
    const calib = '<div class="rs-calib">六尺度'
      + (bankDays ? ' · 动态库 ' + bankDays + ' 日' : ' · 静态先验阈值')
      + (dyn ? ' · ' + dyn + '/' + total + ' 动态' : '')
      + '</div>';
    /* v100：五个统计项都可点开 —— 用户口径「异动矩阵下面四个分类要能点开看到列表，
     * 有归因的要写出归因，有链接到新闻的要能点开新闻详情」。
     * 用 data-rs 标记分类，点击后走 openRadarList()。 */
    $('#radarSummary').innerHTML = `
      <div class="rs-i rs-btn" data-rs="all" role="button" tabindex="0"><b>${results.length}</b><span>品种</span></div>
      <div class="rs-i rs-btn ${un.length ? 'hot' : ''}" data-rs="un" role="button" tabindex="0"><b>${un.length}</b><span>未归因</span></div>
      <div class="rs-i rs-btn" data-rs="attr" role="button" tabindex="0"><b>${attr.length}</b><span>已归因</span></div>
      <div class="rs-i rs-btn ${news ? 'warm' : ''}" data-rs="news" role="button" tabindex="0"><b>${news}</b><span>新闻补获</span></div>
      <div class="rs-i rs-btn ${near ? 'warm' : ''}" data-rs="near" role="button" tabindex="0"><b>${near}</b><span>逼近阈值</span></div>
      ${(closed || off) ? `<div class="rs-note">${closed ? closed + ' 休市' : ''}${closed && off ? ' · ' : ''}${off ? off + ' 取数失败' : ''}${inst ? ' · 已扫 ' + inst.scans + ' 轮' : ''}</div>` : ''}
      ${calib}`;
    const rsBar = $('#radarSummary');
    if (rsBar) {
      rsBar.onclick = (e) => {
        const it = e.target.closest('[data-rs]');
        if (it) openRadarList(it.dataset.rs);
      };
      rsBar.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const it = e.target.closest('[data-rs]');
        if (it) { e.preventDefault(); openRadarList(it.dataset.rs); }
      };
    }
  }

  /* ---------------- 统计项 → 明细列表（v100） ----------------
   * 用户口径：「异动矩阵下面四个分类要能点开看到列表，有归因的要写出归因，
   * 有链接到新闻的要能点开新闻详情」。
   * 复用 #newsSheet 的全屏弹层（.nsheet / .ns-body），不新造一套遮罩样式。 */
  /* 新闻补获项的结构和 scan 结果不同（r.news 带新闻、r.cause 为空），
   * 不能复用品种行模板 —— 否则会错误显示「25 分钟内无可归因消息」。 */
  function rsNewsRowHTML(r) {
    const n = r.news || {};
    const up = (r.chg || 0) >= 0;
    const title = n.title || '（无标题）';
    const link = n.id
      ? `<button class="rl-n" data-news="${esc(n.id)}">${esc(title)}</button>`
      : (n.url
        ? `<button class="rl-n" data-open="${esc(n.url)}">${esc(title)}</button>`
        : `<b class="rl-nt">${esc(title)}</b>`);
    const chg = ((r.chg || 0) >= 0 ? '+' : '') + (r.chg || 0).toFixed(2) + '%';
    return `<div class="rl-row">
      <div class="rl-h">
        <b>${esc(r.name || r.short || r.key || '')}</b>
        <i class="${up ? 'up' : 'down'}">${chg}</i>
        <span>${r.win || 30}分窗口 · 行情已印证 · ${agoText(r.at)}</span>
        <button class="rl-go" data-k="${esc(r.key || '')}">看图 →</button>
      </div>
      <div class="rl-r"><em class="ok">新闻补获</em>${link}
        <span class="rl-src">${esc(n.src || '快讯')}${n.ts ? ' · ' + agoText(n.ts) : ''}</span></div>
    </div>`;
  }

  function rsRowHTML(r) {
    if (r.news) return rsNewsRowHTML(r);
    const up = r.chg >= 0;
    const cause = r.cause || null;
    let reason;
    if (cause && (cause.id || cause.url || cause.title)) {
      const btn = cause.id
        ? `<button class="rl-n" data-news="${esc(cause.id)}">${esc(cause.title || '')}</button>`
        : (cause.url
          ? `<button class="rl-n" data-open="${esc(cause.url)}">${esc(cause.title || '')}</button>`
          : `<b class="rl-nt">${esc(cause.title || '')}</b>`);
      reason = `<div class="rl-r"><em class="ok">归因</em>${btn}
        <span class="rl-src">${esc(cause.src || '快讯')}${cause.ts ? ' · ' + agoText(cause.ts) : ''}</span></div>`;
    } else if (r.echoOnly) {
      reason = `<div class="rl-r"><em>未归因</em><span class="rl-src">25 分钟内只有行情播报（涨跌幅 / 跳水类），没有事件级原因 —— 不拿结果当原因</span></div>`;
    } else {
      reason = `<div class="rl-r"><em>未归因</em><span class="rl-src">25 分钟内无可归因消息 —— 资金或已提前定价</span></div>`;
    }
    const chg = r.bp != null
      ? (r.chg >= 0 ? '+' : '') + (r.chg || 0).toFixed(2) + 'bp'
      : (r.chg >= 0 ? '+' : '') + (r.chg || 0).toFixed(2) + '%';
    return `<div class="rl-row">
      <div class="rl-h">
        <b>${esc(r.name || r.short || r.key || '')}</b>
        <i class="${up ? 'up' : 'down'}">${chg}</i>
        <span>${r.win || 5}分窗口 · 阈值 ${(r.thr || 0).toFixed(2)}%</span>
        <button class="rl-go" data-k="${esc(r.key || '')}">看图 →</button>
      </div>${reason}</div>`;
  }

  function openRadarList(kind) {
    if (!radar) return;
    const results = Object.values(radar.state || {});
    let list = [];
    let title = '全部品种';
    if (kind === 'news') {
      list = (radar.newsLog || []).filter(x => Date.now() - x.at < 4 * 3600e3);
      title = '新闻补获';
    } else if (kind === 'un') {
      list = results.filter(r => r.status === 'unattributed');
      title = '未归因异动';
    } else if (kind === 'attr') {
      list = results.filter(r => r.status === 'attributed');
      title = '已归因异动';
    } else if (kind === 'near') {
      list = results.filter(r => r.status === 'quiet' && Math.abs(r.chg) / (r.thr || 1) >= 0.8)
        .sort((a, b) => Math.abs(b.chg) / b.thr - Math.abs(a.chg) / a.thr);
      title = '逼近阈值';
    } else {
      list = results.slice().sort((a, b) => Math.abs(b.chg) / (b.thr || 1) - Math.abs(a.chg) / (a.thr || 1));
    }
    const box = $('#newsSheet');
    if (!box) return;
    S.curNews = null;
    box.className = 'nsheet on';
    syncLock();
    box.scrollTop = 0;
    bindTapClose(box, '.ns-scroll', closeNews);
    const body = list.length
      ? list.map(rsRowHTML).join('')
      : '<div class="empty sm">这个分类下暂时没有品种</div>';
    box.innerHTML = `<div class="ns-mask"></div>
      <div class="ns-body">
        <div class="ns-h">
          <div class="ns-meta">
            <span class="c-cat">${esc(title)}</span>
            <em>${list.length} 个</em>
            <button class="ns-x" aria-label="关闭">✕</button>
          </div>
          <h2 class="ns-title">${esc(title)} · ${list.length}</h2>
        </div>
        <div class="ns-scroll">${body}</div>
      </div>`;
    window.__rsList = { kind: kind, list: list };
  }

  function radarActiveHTML(results, inst) {
    // 新闻补获的事件不在 scan 的 results 里（scan 每 20 秒会重写 state），
    // 单独从 inst.newsLog 取最近 4 小时的
    const news = inst && inst.newsLog
      ? inst.newsLog.filter(x => Date.now() - x.at < 4 * 3600e3)
      : [];
    const act = results.filter(r => r.status === 'unattributed' || r.status === 'attributed');
    if (!act.length && !news.length) {
      const near = results
        .filter(r => r.status === 'quiet')
        .sort((a, b) => Math.abs(b.chg) / b.thr - Math.abs(a.chg) / a.thr)
        .slice(0, 3);
      return `<div class="calm">
        <div class="calm-ic">◌</div>
        <div class="calm-tx">
          <b>当前没有品种击穿阈值</b>
          <span>每 20 秒扫描一次全池，一旦击穿立即亮红灯并弹窗提示</span>
        </div>
        ${near.length ? `<div class="calm-near">${near.map(r => `
          <div class="cn-row"><span>${esc(r.short)}</span>
            <i><em style="width:${Math.min(100, Math.abs(r.chg) / r.thr * 100).toFixed(0)}%"></em></i>
            <b class="${r.chg >= 0 ? 'up' : 'down'}">${chgLabel(r)}</b></div>`).join('')}
          <div class="cn-tip">最接近阈值的三个</div></div>` : ''}
      </div>`;
    }
    /* 「持续多久 + 累计多少 + 当日多少」这一行是这次的核心补强：
     * 只看 5 分钟窗口，会把布油「已经跌了 3.6%」说成「只跌了 0.3%」，
     * 视觉上等于告诉用户「没事」，方向判断直接错。 */
    const runLine = (r) => {
      const R = r.run;
      if (!R || R.durMin < 2) return '';
      const f = (v) => (v >= 0 ? '+' : '') + (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%';
      const day = (r.dayPct != null && Math.abs(r.dayPct) >= 0.03)
        ? `<span>当日 <b class="${r.dayPct >= 0 ? 'up' : 'down'}">${f(r.dayPct)}</b></span>` : '';
      const expTxt = R.expanding ? (R.cum >= 0 ? '涨幅仍在扩大' : '跌幅仍在扩大') : '动能衰减';
      return `<div class="ra-run">
        ${R.day
          ? `<span>今日 <b class="${R.cum >= 0 ? 'up' : 'down'}">${f(R.cum)}</b></span>
             <span>已持续 <b>${R.durMin}</b> 分</span>`
          : `<span>已持续 <b>${R.durMin}</b> 分</span>
             <span>累计 <b class="${R.cum >= 0 ? 'up' : 'down'}">${f(R.cum)}</b></span>
             ${day}`}
        <i class="run-tag ${R.expanding ? 'exp' : 'ease'}">${expTxt}</i>
      </div>`;
    };

    const cards = act.map(r => {
      const useRun = r.run && r.run.durMin >= 2 && r.bp == null;
      const mainChg = useRun ? r.run.cum : r.chg;
      const up = mainChg >= 0;
      const p = Math.min(100, Math.abs(r.chg) / r.thr * 100);
      const sc = winTxt(r);
      return `<div class="ra ${r.status}" data-k="${esc(r.key)}">
        <div class="ra-h">
          <span class="ra-dot"></span>
          <b>${esc(r.name)}</b>
          <em>${r.status === 'unattributed' ? '未归因' : '已归因'}</em>
        </div>
        <div class="ra-v"><b class="${up ? 'up' : 'down'}">${chgLabel(useRun ? { chg: mainChg, bp: null } : r)}</b><span>${sc}</span></div>
        ${runLine(r)}
        <div class="ra-b"><i class="${up ? 'up' : 'down'}" style="width:${p.toFixed(0)}%"></i><em></em></div>
        <div class="ra-f">
          <span>${r.bp != null
            ? '振幅 ' + (r.amp * r.last).toFixed(1) + 'bp'
            : '振幅 ' + r.amp.toFixed(2) + '%'}</span>
          <span>${r.bp != null
            ? '阈值 ' + (r.thr * r.last / 100).toFixed(1) + 'bp'
            : '阈值 ' + r.thr.toFixed(2) + '%'}</span>
          <span>现价 <span class="qpx" data-k="${esc(r.key)}">${r.last ? U.fmt(r.key, r.last) : '--'}</span></span>
        </div>
        <div class="ra-t">
          ${r.status === 'unattributed'
            ? (r.echoOnly
              ? '只有 25 分钟内的行情播报（涨跌幅/跳水类），没有事件级原因 —— 不拿结果当原因'
              : '快讯库 25 分钟内无可归因消息 —— 资金或已提前定价')
            : (r.cause
              ? `归因：${r.cause.id
                ? `<button class="ra-cn" data-news="${esc(r.cause.id)}">${esc(r.cause.title || '')}</button>`
                : (r.cause.url
                  ? `<button class="ra-cn" data-open="${esc(r.cause.url)}">${esc(r.cause.title || '')}</button>`
                  : `<span class="rl-nt">${esc(r.cause.title || '事件快讯')}</span>`)}`
              : '已有对应事件快讯，属「消息驱动」波动')}
          <button class="ra-go" data-k="${esc(r.key)}">看图 →</button>
        </div>
      </div>`;
    });

    // 新闻补获卡片：行情阈值没抓到、但新闻报了且 K 线验证通过
    const newsCards = news.map(r => {
      const up = r.chg >= 0;
      const n = r.news || {};
      const sc = winTxt(r);
      const ago = Math.max(0, Math.round((Date.now() - (n.ts || r.at)) / 60000));
      return `<div class="ra news-confirmed" data-k="${esc(r.key)}">
        <div class="ra-h">
          <span class="ra-dot"></span>
          <b>${esc(r.name)}</b>
          <em>新闻补获</em>
        </div>
        <div class="ra-v"><b class="${up ? 'up' : 'down'}">${chgLabel(r)}</b><span>${sc} · 已验证</span></div>
        ${runLine(r)}
        <div class="ra-b"><i class="${up ? 'up' : 'down'}" style="width:${Math.min(100, Math.abs(r.chg) / (r.thr || 1) * 100).toFixed(0)}%"></i><em></em></div>
        <div class="ra-f">
          <span>实测 ${Math.abs(r.chg).toFixed(2)}%</span>
          <span>门槛 ${(r.need || r.thr || 0).toFixed(2)}%</span>
          <span>${ago} 分钟前</span>
        </div>
        <div class="ra-news">
          <span class="ra-ns">${esc(n.src || '快讯')}</span>
          <button class="ra-nl" ${n.id
            ? `data-news="${esc(n.id)}"`
            : `data-open="${esc(n.url || '')}"`}>${esc(n.title || '')}</button>
        </div>
        <div class="ra-t">
          行情阈值未触发，由媒体「${esc(n.src || '快讯')}」报道 + K 线回溯验证补入
          <button class="ra-go" data-k="${esc(r.key)}">看图 →</button>
        </div>
      </div>`;
    });

    return newsCards.concat(cards).join('');
  }

  const MX_ST = {
    quiet: '', attributed: '已归因', unattributed: '未归因',
    closed: '休市', offline: '失败'
  };

  // 异动矩阵：一格一个品种，**方块大小 = 异动幅度**
  //   尺寸 3 档：吃掉阈值 ≥100% → 2×2 大块；≥60% → 2×1 宽块；其余 1×1
  //   底色深浅 = 5 档热量（辅助表达，色弱也能靠大小分辨）
  //   色相     = 红涨绿跌；白框 = 已击穿阈值
  //   排序     = 幅度从大到小，大块自然落在左上角
  const HEAT_AT = [0.30, 0.55, 0.80, 1.00];   // 档位分界（相对阈值）
  function heatOf(ratio) {
    let h = 0;
    for (let i = 0; i < HEAT_AT.length; i++) if (ratio >= HEAT_AT[i]) h = i + 1;
    return h;
  }
  /* 异动矩阵的两种展示模式
   *  ─────────────────────────────────────────────
   *  「按大小」(默认)：方块大小＝异动强度的第一视觉信号 ——
   *      领跑者(比值最高)用 2×2 大块，紧随其后的用 2×1 宽块，其余 1×1；
   *      并按「异动从大到小」排到最前面，越大越靠前。
   *  「按颜色」：所有方块等大，按雷达池固定顺序排列，
   *      用底色深浅（0~4 档）表达阈值消耗 —— 经典热力图。
   *  两种模式格内数字都是真实振幅，不放大、不掺排名。
   */
  function sizeTier(rank, ratio) {
    if (!isFinite(ratio) || ratio <= 0) return 1;
    if (rank === 0) return ratio >= 0.5 ? 3 : 2;   // 领跑者：吃掉一半阈值就上 2×2
    if (rank <= 2 && ratio >= 0.12) return 2;      // 前 2~3 名且真的动过 → 宽块
    return 1;
  }

  function mxGridHTML(results) {
    const mode = S.mxMode || 'size';
    const cells = results.map(r => {
      const dead = r.status === 'offline' || r.status === 'closed';
      const thr = r.thr || 1;
      const ratio = dead ? 0 : Math.abs(r.chg) / thr;
      return { r, dead, ratio, z: 1 };
    });

    if (mode === 'color') {
      // 热力图：等大方块，按雷达池固定顺序，底色表达强度
      const order = new Map(U.RADAR.map((x, i) => [x.k, i]));
      cells.sort((a, b) => (order.get(a.r.key) ?? 99) - (order.get(b.r.key) ?? 99));
    } else {
      // 按大小：异动大的排前面，且方块更大
      cells.sort((a, b) => (a.dead - b.dead) || (b.ratio - a.ratio));
      let rank = 0;
      cells.forEach(c => { if (!c.dead) c.z = sizeTier(rank++, c.ratio); });
    }

    return cells.map(({ r, dead, ratio, z }) => {
      const hit = r.status === 'unattributed' || r.status === 'attributed';
      /* 用户口径：「异动矩阵里大字显示当日涨跌幅是对的，下面可以补上小字 xx分钟振幅xx」
       * 所以大字统一取「当日涨跌幅」（相对昨收），小字补本窗口的振幅。
       * 收益率类（bp）没有「当日百分比」这种说法，仍按窗口 bp 展示。 */
      const isBp = r.bp != null;
      const useRun = hit && r.run && r.run.durMin >= 2 && !isBp;
      const mainChg = useRun ? r.run.cum : r.chg;
      const dayP = (r.dayPct != null && Math.abs(r.dayPct) >= 0.01) ? r.dayPct : null;
      const bigVal = isBp ? mainChg : (dayP == null ? mainChg : dayP);
      const up = bigVal >= 0;
      /* 小字的「N 分钟振幅」：当日尺度命中时 r.win=0，拿它自己会写成「日内振幅」，
       * 那不是用户要的「xx分钟振幅xx」。改从 hits 里取 5 分钟那一档的真实振幅。
       * 振幅要带正负号（用户口径），方向跟对应窗口的 chg 走。 */
      let ampV = r.amp, ampWin = r.win, ampDir = r.chg >= 0 ? 1 : -1;
      if (r.win === 0 && Array.isArray(r.hits)) {
        const h5 = r.hits.find(h => h.win === 5)
          || r.hits.find(h => h.win === 15)
          || r.hits.find(h => h.win > 0);
        if (h5) { ampV = h5.amp; ampWin = h5.win; ampDir = h5.chg >= 0 ? 1 : -1; }
      }
      const ampSign = ampDir >= 0 ? '+' : '-';
      const amp = isBp
        ? ampSign + (ampV * r.last).toFixed(1) + 'bp'
        : ampSign + ampV.toFixed(2) + '%';
      const winName = ampWin === 0 ? '日内' : (ampWin || 5) + '分';
      const R = r.run;
      const runTag = (!dead && R && R.durMin >= 2)
        ? (R.day ? ('今日' + (R.expanding ? '·扩大' : ''))
          : `${R.durMin}分${R.expanding ? '·扩大' : ''}`)
        : '';
      /* 小字三段：① 本轮状态（今日·扩大 / 32分·扩大）② 本窗口振幅 ③ 大块再补阈值消耗
       * 窄格子（z1）放不下两段，只留振幅 —— 命中本身已经有白框和红字，
       * 「今日·扩大」在预警卡片和底部胶囊里都还有，不必在 66px 里硬挤。 */
      const tail = dead ? MX_ST[r.status] : (hit ? (runTag || (r.status === 'unattributed' ? '未归因' : '已归因')) : '');
      const parts = [];
      if (tail && z >= 2) parts.push(tail);
      if (!dead) parts.push(`${winName}振幅${amp}`);
      if (z >= 2 && !dead && !hit) parts.push('阈值 ' + Math.round(ratio * 100) + '%');
      const tailFull = parts.join(' · ');
      return `<button class="mx-cell z${z} h${heatOf(ratio)} ${up ? 'dir-up' : 'dir-down'} st-${r.status}"
          data-k="${esc(r.key)}">
        <span class="mx-n">${esc(r.short)}</span>
        <b class="${dead ? '' : up ? 'up' : 'down'}">${r.status === 'offline' ? '--'
          : chgLabel({ chg: bigVal, bp: isBp ? r.bp : null })}</b>
        <span class="mx-tr"><i style="width:${Math.min(100, Math.max(5, ratio * 100)).toFixed(0)}%"></i></span>
        <em class="mx-s">${tailFull}</em>
      </button>`;
    }).join('');
  }

  function renderRadar(results, inst) {
    if (!results) return;
    radarSummary(results, inst);
    const mx = $('#mxGrid');
    if (mx) mx.innerHTML = mxGridHTML(results);
    $('#radarActive').innerHTML = radarActiveHTML(results, inst);
    $('#radarTick').textContent = inst && inst.lastScanAt
      ? `最近扫描 ${hhmmss(inst.lastScanAt)} · 每 ${Math.round((inst.interval || 20000) / 1000)} 秒`
      : '等待首次扫描';

    const log = (inst && inst.log) || [];
    const KIND_TEXT = { unattributed: '无消息确认', attributed: '消息已归因', news: '新闻验证补获' };
    const SCALE_TEXT = { flash: '闪·1~3分', fast: '快·5分', mid: '中·15分', slow: '慢·30分' };
    $('#radarLog').innerHTML = log.length ? log.map(l => `
      <div class="lg-row ${l.kind}">
        <span class="lg-t">${hhmm(l.at)}</span>
        <span class="lg-k">${esc(l.short || l.name)}</span>
        <span class="lg-c ${l.chg >= 0 ? 'up' : 'down'}">${chgLabel(l)}</span>
        <span class="lg-s">${l.win ? l.win + '分' : (SCALE_TEXT[l.scale] || '')}${
          (l.run && l.run.durMin >= 2) ? ' · 累计' + ((l.run.cum >= 0 ? '+' : '') + l.run.cum.toFixed(2)) + '%' : ''
        } · ${KIND_TEXT[l.kind] || ''}</span>
        ${l.kind === 'news' && l.news ? `<i class="lg-news">${esc(l.news.title)}</i>` : ''}
      </div>`).join('') : '<div class="empty sm">本次监听周期内暂无击穿阈值的异动</div>';

    // 异动状态同步到全局（红灯 / 弹窗 / tab 角标）
    syncAlerts(inst);
  }

  /* ---------------- 预警：弹窗 / 红灯 / 角标 ---------------- */
  function syncAlerts(inst) {
    if (!inst) return;
    const act = inst.active();
    const un = act.filter(r => r.status === 'unattributed');
    /* 用户口径：「矩阵页签的小红点数字去掉」——
     * 异动数量在矩阵页顶部那行统计（31 品种 · N 未归因）和顶部红胶囊里都有，
     * 再在底部页签挂个数字属于重复表达。 */
    const bar = $('#alarmBanner');
    if (un.length) {
      const top = un[0];
      /* 【右下角常驻红胶囊已下线】
       * 用户反馈：「右下角的恒指未归因图标删掉，一直在那边挡着很碍眼，
       *   实际也没什么帮助，我直接看矩阵就很清楚了。」
       * 这个胶囊是「未归因异动」的常驻指示器，浮在右下角、压在快讯正文上，
       * 桌面端还挡住内容。异动信息在矩阵页有完整的列表 + 顶部红横幅，
       * 属于重复表达，所以整个元素从 DOM 里移除。
       * 顶部红横幅（bar）保留 —— 那是「播报」通道，用户仍然需要第一时间知道。 */
      /* 顶部横幅 —— 必须过「横幅账本」闸门。
       *
       * 根因（用户反馈：「纳指的预警一刷新就跑出来，关掉 app 再打开，
       * S 级预警和 VIX 预警又跑出来」）：
       * 原来这里只要「当前存在未归因异动」就无条件 showAlarm(top)，
       * 跟「这个异动之前报过没有」完全无关 ——
       * 于是行情只要还停在异动状态里，重启后横幅必然重弹一遍。
       *
       * 现在改成：
       *   · 横幅已在屏（还是同一个异动）→ 只刷新文案，不重新播报
       *   · 横幅不在屏 → 必须过 bannerAllowed()：
       *       首次必弹；弹过且幅度没继续扩大 → 不再打扰；
       *       幅度确实在扩大（原油连跌那种）→ 继续弹
       * 横幅账本落盘，所以关掉 app 再打开也不会重放旧异动。 */
      const shown = bar.classList.contains('on') && bar.dataset.k === top.key;
      if (shown) {
        showAlarm(top);              // 已在屏：仅刷新文案（持续时间/当日跌幅每 20 秒都在变）
      } else {
        const curAmp = inst.ampOf ? inst.ampOf(top) : Math.abs(top.chg || 0);
        const sigma = inst.sigmaOf ? inst.sigmaOf(top) : (top.thr || 0.2);
        const allow = inst.bannerAllowed ? inst.bannerAllowed(top.key, curAmp, sigma) : true;
        const muted = (S.bannerMuted === top.key && Date.now() < (S.bannerMuteUntil || 0));
        if (allow && !muted) showAlarm(top);
      }
    } else {
      /* 没有未归因异动 → 顶部横幅复位。注意「软横幅」是 S 级快讯通道，不在这里动。 */
      if (bar.classList.contains('on') && !bar.classList.contains('soft')) {
        bar.className = 'alarm';
        bar.dataset.k = '';
        /* 硬横幅退下 → 把被挡住的 S 级补挂上去 */
        try { flushSoftBanner(); } catch (e) {}
      }
    }
  }

  function toast(r) {
    if (!S.toastOn) return;
    const box = $('#toasts');
    const el = d.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="t-dot"></span>
      <div class="t-b"><b>${esc(r.name)} ${alarmWords(r)}</b>
      <span>未找到催化剂 · 正在全力捕获</span></div>
      <button class="t-go">看图</button>
      <button class="t-x">✕</button>`;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    const kill = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); };
    const timer = setTimeout(kill, 14000);
    el.querySelector('.t-x').onclick = () => { clearTimeout(timer); kill(); };
    el.querySelector('.t-go').onclick = () => { clearTimeout(timer); kill(); openSheet(r.key); };
    el.onclick = (e) => { if (e.target === el) { clearTimeout(timer); kill(); } };
    while (box.children.length > 3) box.firstChild.remove();
  }

  function showAlarm(r) {
    const bar = $('#alarmBanner');
    /* 软横幅（S 级快讯）占着同一个元素时，必须走完整渲染，
     * 不能进下面的「同一条还在继续」早退分支 —— 否则
     * 顶部的「S」图标和 S 级文案会留在屏上，硬预警出不来。 */
    if (bar.dataset.k === r.key && bar.classList.contains('on')
      && !bar.classList.contains('soft')) {
      // 同一条异动还在继续：文案要跟着刷新（持续时间/当日跌幅每 20 秒都在变），
      // 早退会把首轮的数字冻在屏幕上，用户看到的是过期值。
      const sp = bar.querySelector('.al-tx span');
      if (sp) sp.innerHTML = `${alarmWords(r)} · 暂无匹配快讯`;
      S.lastAlarm = r;
      /* 账本里的幅度同步推到当前值 ——
       * 语义是「你已经知道的最大幅度」。这样：
       *   · 幅度只是小幅漂移 → 关掉横幅后不会再弹（不重复打扰）
       *   · 幅度真的继续扩大 → delta 相对当前值仍然足够大，照样再报
       * 若不更新，基准会永远停在首次播报的数字上，
       * 用户明明在屏上已经看到最新跌幅了，关掉后还会被再弹一次。 */
      if (radar && radar.markBanner) {
        try { radar.markBanner(r.key, radar.ampOf(r)); } catch (e) {}
      }
      return;
    }
    bar.dataset.k = r.key;
    bar.className = 'alarm on';
    bar.innerHTML = `
      <div class="al-ic">!</div>
      <div class="al-tx">
        <b>${esc(r.name)}${r.holding ? '仍在剧烈波动' : '突发剧烈异动'}，正在全力捕获催化剂…</b>
        <span>${alarmWords(r)} · 暂无匹配快讯</span>
      </div>
      <button class="al-btn" data-k="${esc(r.key)}">看图</button>
      <button class="al-x" aria-label="关闭">✕</button>`;
    S.lastAlarm = r;
    /* 记入横幅账本 —— 否则关掉 app 再打开，这个异动会因为
     * 「账本里没有它」而被当成首次，横幅重新弹一遍。 */
    if (radar && radar.markBanner) {
      try { radar.markBanner(r.key, radar.ampOf(r)); } catch (e) {}
    }
    bar.querySelector('.al-btn').onclick = (e) => { e.stopPropagation(); openSheet(r.key); };
    bar.querySelector('.al-x').onclick = () => {
      bar.className = 'alarm';
      bar.dataset.k = '';
      S.bannerMuted = r.key;
      S.bannerMuteUntil = Date.now() + 15 * 60000;
      /* 硬横幅被用户手动关掉 → 位置空出来，把被挡住的 S 级补挂上去 */
      try { flushSoftBanner(); } catch (e) {}
    };
    bar.onclick = (e) => { if (!e.target.closest('button')) openSheet(r.key); };
    beep(2, 'anom');
    buzz([30, 60, 30]);
    /* v197：系统通知栏保留（用户明确要通知进通知栏）；
     * 去掉的是网页内那个深红 .toast 浮窗，见 onAlert。 */
    sysNotify('异动提醒 · ' + r.name, alarmWords(r), 'mm-anom-' + r.key, 'anom');
  }

  /* ---------------- 声音 / 震动（v193：统一走 Android 原生，不再落媒体声道） ----------------
   * beep/buzz 是「网页内横幅 + 全屏」的附加提示；系统通知横幅由 sysNotify 发。
   * 原生端用 USAGE_NOTIFICATION 的通知铃声 + Vibrator 震动，遵守手机
   * 响铃/震动/静音物理模式，也遵守前端 S.sound / S.vibrate 开关。 */
  /* v195：三类提醒各自的声音/震动开关（S级快讯 / 异动 / 股价预警）。
   * 存 mm_aprefs_v1；测试通知按「S级快讯」这组走。 */
  /* store.get 已自动 JSON.parse（返回对象），这里兼容对象/字符串两种形态 */
  function _apLoad() {
    let v = null;
    try { v = store.get('mm_aprefs_v1', null); } catch (e) {}
    if (v == null) return {};
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return {}; } }
    return (v && typeof v === 'object') ? v : {};
  }
  function alertPrefs(type) {
    const o = _apLoad();
    const def = { sound: true, vib: true };
    const k = (type === 's' || type === 'anom' || type === 'price') ? type : 's';
    return Object.assign({}, def, o[k] || {});
  }
  function setAlertPref(type, key, val) {
    const o = _apLoad();
    const k = (type === 's' || type === 'anom' || type === 'price') ? type : 's';
    o[k] = Object.assign({ sound: true, vib: true }, o[k] || {});
    o[k][key] = !!val;
    store.set('mm_aprefs_v1', o);
  }
  function beep(times, type) {
    const pf = alertPrefs(type);
    if (!pf.sound && !pf.vib) return;
    const np = w.NativePulse;
    if (np && typeof np.beep === 'function') {
      try { np.beep(pf.sound, pf.vib, times || 1); return; } catch (e) {}
    }
    /* 无原生桥（纯浏览器）：WebAudio 合成音 + navigator.vibrate 兜底 */
    if (pf.sound) webBeep(times || 1);
    if (pf.vib) { try { if (navigator.vibrate) navigator.vibrate([40, 80, 40]); } catch (e) {} }
  }
  /* v197：真实提醒都要进系统通知栏（用户口径：通知栏必须保留）。
   * 网页内每种提醒只留一个弹窗：异动=粉色 alarm 横幅、S级=全屏、股价=toast。
   * 声音与震动由 beep() 走原生 USAGE_NOTIFICATION。 */
  function sysNotify(title, body, tag, type) {
    if (!S.notify) return;
    const pf = alertPrefs(type);
    const np = w.NativePulse;
    if (np && typeof np.notify === 'function') {
      try { np.notify(pf.sound, pf.vib, title || '', body || ''); return; } catch (e) {}
    }
    try {
      if (w.Notification && Notification.permission === 'granted') {
        new Notification(title || '', { body: body || '', tag: tag || '' });
      }
    } catch (e) {}
  }
  /* 【v136】WebAudio 在 Android WebView 里要「用户触碰过页面」才允许发声。
   * 1.0 壳没有原生桥接，声音全靠这一段，所以第一次点屏就把音频上下文解锁，
   * 免得真实提醒到来时还被系统判成未授权自动播放 → 又变成「只有声音没动静」。 */
  function unlockAudio() {
    try {
      const AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return;
      _wctx = _wctx || new AC();
      if (_wctx.state === 'suspended') _wctx.resume();
    } catch (e) {}
  }
  try {
    ['pointerdown', 'touchstart', 'click'].forEach(function (ev) {
      document.addEventListener(ev, unlockAudio, { once: true, passive: true });
    });
  } catch (e) {}

  function buzz(p) {
    /* v193：有原生桥时震动已由原生 beep 统一处理（遵守响铃/震动/静音模式），
     * 这里只做纯浏览器的兜底，避免「原生震一下 + 网页又震一下」重复。 */
    const np = w.NativePulse;
    if (np && typeof np.beep === 'function') return;
    if (!S.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {}
  }
  /* 【v133】只在「原生通道被拒」时的显式测试点击里用：合成一声短提示，
   * 证明手机扬声器正常、问题出在壳的原生通道。真实快讯提醒绝不走这里，
   * 避免又落回媒体声道（v129 修的就是这个）。 */
  let _wctx = null;
  function webBeep(times) {
    try {
      const AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return false;
      _wctx = _wctx || new AC();
      if (_wctx.state === 'suspended') _wctx.resume();
      const n = times || 1;
      for (let i = 0; i < n; i++) {
        const t0 = _wctx.currentTime + i * 0.22;
        const o = _wctx.createOscillator(), g = _wctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(880, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g); g.connect(_wctx.destination);
        o.start(t0); o.stop(t0 + 0.2);
      }
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- S 级全屏警报 ----------------
   * 【防复发】只有真实抓取的快讯（live === true）才允许触发全屏警报。
   * 演示项 / 示例项一律不触发，避免被误当成真实黑天鹅。 */
  function sAlert(n) {
    if (!n || n.live !== true) return;
    /* 同一条 S 级快讯只强提醒一次。
     * 软横幅那条路径已经用 mm_s_seen_v1 记过展示记录，
     * 这里再挡一道，避免同一条新闻先弹了软横幅、
     * 紧接着又弹全屏黑天鹅（等于同一件事报两遍）。 */
    if (sLevelSeen(n.id)) return;
    S.feedNewS++;
    updateFeedDot();
    if (!S.modalOn) { beep(3, 's'); buzz([40, 80, 40]); sysNotify('S级事件 · ' + n.title, n.brief || '', 'mm-s-' + n.id, 's'); return; }
    /* 只有**真的弹了全屏**才记账。
     * 全屏被关掉时不能记 —— 否则顶部软横幅那条通道会认为
     * 「已经报过了」，结果这条新事件两条通道都没报出去。 */
    markAllSSeen([n]);
    const m = $('#sModal');
    const dir = (n.direct || []).map(x => chip(x.k)).join('');
    const cnC = (n.cn || []).map(x => chip(x.k)).join('');
    const usS = (n.us || []).map(x => chip(x.k)).join('');
    const hkS = (n.hk || []).map(x => chip(x.k)).join('');
    m.innerHTML = `<div class="sm-frame">
      <div class="sm-badge">S</div>
      <div class="sm-cat">${esc(n.cat)} · ${esc(n.src)} · ${hhmm(n.ts)}</div>
      <h2 class="sm-title">${esc(n.title)}</h2>
      <p class="sm-brief">${esc(n.brief)}</p>
      ${dir ? `<div class="sm-lab">直接标的</div><div class="sm-chips">${dir}</div>` : ''}
      ${usS ? `<div class="sm-lab">美股映射</div><div class="sm-chips sm-chips-us">${usS}</div>` : ''}
      ${hkS ? `<div class="sm-lab">港股映射</div><div class="sm-chips sm-chips-hk">${hkS}</div>` : ''}
      ${cnC ? `<div class="sm-lab">A股映射</div><div class="sm-chips sm-chips-cn">${cnC}</div>` : ''}
      <div class="sm-actions">
        <button class="sm-go">查看关联标的</button>
        <button class="sm-ok">已知悉</button>
      </div>
      <div class="sm-foot">S 级事件 · 全屏强提醒</div>
    </div>`;
    m.classList.add('on');
    beep(3, 's');
    buzz([60, 90, 60]);
    sysNotify('S级事件 · ' + n.title, n.brief || '', 'mm-s-' + n.id, 's');
    QuoteHub.refresh(Array.from(new Set([...(n.direct || []), ...(n.us || []), ...(n.hk || []), ...(n.cn || [])].map(x => x.k))));
    m.querySelector('.sm-ok').onclick = () => m.classList.remove('on');
    m.querySelector('.sm-go').onclick = () => {
      m.classList.remove('on');
      const first = (n.cn && n.cn[0]) || (n.direct && n.direct[0]);
      if (first) openSheet(first.k);
    };
    m.onclick = (e) => { if (e.target === m) m.classList.remove('on'); };
  }

  function updateFeedDot() {
    const dot = $('#tabs button[data-tab="feed"] .tab-dot');
    if (!dot) return;
    dot.hidden = !S.feedNewS;
    dot.textContent = S.feedNewS;
  }

  /* ---------------- 行情页 ---------------- */
  function sessionOf(k) {
    if (!S.session[k]) {
      const a = U.get(k);
      // 品种可以自带时段（恒指用港股时段，而不是日股时段）
      S.session[k] = (a && a.sess)
        ? w.Session.judge(a.sess, new Date())
        : w.Session.state(k);
    }
    return S.session[k];
  }

  /* v146：行情页按「交易时段」归组，而不是按 grp 细分组。
   * 这样美股指数（grp us）和美股个股（grp usstock）会并到同一个「美股」区，
   * 指数排前面、个股排后面；韩股指数(KS11)和韩股个股(000660)并到「韩股」区，等等。
   * 用户明确要的是这个效果。 */
  function sessionKeyOf(k) {
    const a = U.get(k);
    if (!a) return 'other';
    /* v257：VIX 的 sess='vix' 是「时段判定口径」（近 24/5），不是「行情分组」。
     * 直接返回 a.sess 会让它落进 sessionOrder() 里不存在的 'vix' 组，
     * 被 order.filter 丢掉 → 行情看板里 VIX 直接消失（搜索显示已添加但看不到）。
     * 分组仍归美股，时段状态用 sessionOf() 走 judge('vix')。 */
    if (a.sess === 'vix') return 'us';
    if (a.sess) return a.sess;
    const g = U.GROUPS[a.grp];
    return (g && g.session) || a.grp || 'other';
  }

  /* 浅色主题下的分组色：原调色板是给深色底配的荧光色（#ffd43b / #8ce99a / #63e6be），
   * 放到白底上又亮又刺眼。这里换成同色相、低明度低饱和的版本，观感接近通达信浅色主题。 */
  const GROUP_LIGHT = {
    'A股': '#b23a3a', '亚太': '#96700f', '美股': '#1f5f9e', '美债': '#0f7d68',
    '外汇': '#2f7a4a', '原油': '#a04a6e', '贵金属': '#8a6410', '工业金属': '#7a5b3c',
    '加密': '#9a5f14', 'A股个股': '#b23a3a', '美股个股': '#41508f', '港股个股': '#a05555'
  };
  function gColor(g) {
    if (!g) return '';
    if (S.theme === 'light' && GROUP_LIGHT[g.label]) return GROUP_LIGHT[g.label];
    return g.color || '';
  }

  // 某个交易时段区块的标题与配色
  /* 浅色主题下这些荧光色（#ffc078 / #f783ac / #ffd43b …）在白底上太刺眼，
   * 统一换成同色相的深色版本，观感对齐通达信浅色主题。 */
  const SESS_LIGHT = { crypto: '#a8681a', cmdty: '#a04a6e' };
  function sessionMeta(sk) {
    const light = S.theme === 'light';
    if (sk === 'crypto') return { label: '加密', full: '加密货币', color: light ? SESS_LIGHT.crypto : '#ffc078' };
    if (sk === 'cmdty') return { label: '商品', full: '原油·金属', color: light ? SESS_LIGHT.cmdty : '#f783ac' };
    const cfg = w.Session && w.Session.SESSIONS && w.Session.SESSIONS[sk];
    let color = '#8b95a6', gkHit = null;
    for (const gk in U.GROUPS) {
      if (U.GROUPS[gk].session === sk) { color = U.GROUPS[gk].color; gkHit = gk; break; }
    }
    if (light && gkHit) color = gColor(U.GROUPS[gkHit]);
    const label = cfg ? cfg.name : (U.GROUPS[sk] ? U.GROUPS[sk].label : sk);
    return { label: label, full: label, color: color };
  }

  // 同一时段区内：指数在前，其次按 GROUP 原始 order，再按资产 ord，最后按名称
  function sessionSort(list) {
    return list.slice().sort((x, y) => {
      const ax = U.get(x), ay = U.get(y);
      const ix = (ax && ax.kind === 'index') ? 0 : 1;
      const iy = (ay && ay.kind === 'index') ? 0 : 1;
      if (ix !== iy) return ix - iy;
      const ox = (U.GROUPS[ax.grp] && U.GROUPS[ax.grp].order) || 99;
      const oy = (U.GROUPS[ay.grp] && U.GROUPS[ay.grp].order) || 99;
      if (ox !== oy) return ox - oy;
      const rdx = (ax && ax.ord) || 99, rdy = (ay && ay.ord) || 99;
      if (rdx !== rdy) return rdx - rdy;
      return (ax ? ax.name : '').localeCompare(ay ? ay.name : '');
    });
  }

  /* v209【严格按各市场自己的交易时段排序】
   * 以前是 if/else 硬编码一串 head（如「亚太交易中 → hk,kr,jp,tw,cn,fx…」），
   * 它假定同一时刻这些市场状态一样，但实际每个市场收盘时间都不同：
   * 15:15 港股 13:00–16:00 仍在交易，日股/台股/A股却已收，硬编码 head
   * 仍把休市市场排在交易中的外汇 / 加密前面。现在逐个 session 实时判定，
   * 正在交易（含盘前 / 盘后 / 夜盘 / 7×24）一律 rank 0，休市一律 rank 1；
   * 同层按地区优先序，保留「A股›港股›韩股›日股›台股›美股」的既有观感。 */
  const SESS_PRIORITY = ['cn', 'hk', 'kr', 'jp', 'tw', 'apac', 'us', 'fx', 'rate', 'cmdty', 'crypto'];
  function sessLive(sk) {
    try {
      /* v237：优先用「组内品种实际状态」，修复 apac 这类并集时段把
       * 正在交易的港股/韩股/台股整组误判成休市的问题。 */
      if (w.Session.sessionLive) return w.Session.sessionLive(sk);
      const j = w.Session.judge(sk, new Date());
      return !!j.open || j.phase === 'pre' || j.phase === 'post';
    } catch (e) { return false; }
  }
  function sessRank(sk) { return sessLive(sk) ? 0 : 1; }
  function sessPri(sk) { const i = SESS_PRIORITY.indexOf(sk); return i < 0 ? 90 : i; }

  // 时段区块的出场顺序：正在交易的顶前、休市的沉底（同层按地区优先序）
  function sessionOrder() {
    const sessOrder = {};
    for (const gk in U.GROUPS) {
      const g = U.GROUPS[gk];
      if (!g.session) continue;
      const cur = sessOrder[g.session];
      sessOrder[g.session] = (cur == null) ? g.order : Math.min(cur, g.order);
    }
    const all = Object.keys(sessOrder).sort((a, b) => sessOrder[a] - sessOrder[b]);
    if (!S.sessFirst) return all;
    return all.slice().sort((a, b) => {
      const ra = sessRank(a), rb = sessRank(b);
      if (ra !== rb) return ra - rb;
      const pa = sessPri(a), pb = sessPri(b);
      if (pa !== pb) return pa - pb;
      return sessOrder[a] - sessOrder[b];
    });
  }

  /* v209：添加品种弹窗的分组顺序也走同一套「实时交易时段」判定，
   * 不再用 ASIA_LEAD / US_LEAD / OFF_LEAD 三组硬编码数组。
   * 每个 GROUPS 分组先映射到它自己的 session，再按该市场是否正在交易分层。 */
  function groupOrder() {
    const all = Object.keys(U.GROUPS).sort((a, b) =>
      (U.GROUPS[a] ? U.GROUPS[a].order : 99) - (U.GROUPS[b] ? U.GROUPS[b].order : 99));
    if (!S.sessFirst) return all;
    const gs = g => (U.GROUPS[g] && U.GROUPS[g].session) || '';
    return all.slice().sort((a, b) => {
      const sa = gs(a), sb = gs(b);
      const ra = sa ? sessRank(sa) : 1, rb = sb ? sessRank(sb) : 1;
      if (ra !== rb) return ra - rb;
      const pa = sa ? sessPri(sa) : 90, pb = sb ? sessPri(sb) : 90;
      if (pa !== pb) return pa - pb;
      return (U.GROUPS[a] ? U.GROUPS[a].order : 99) - (U.GROUPS[b] ? U.GROUPS[b].order : 99);
    });
  }

  // 当前排序依据的一句话说明（行情页顶部提示）
  function orderHint() {
    if (!S.sessFirst) return '固定分组顺序';
    const now = new Date();
    /* v209：不再写死「A股优先 / 港股优先」，直接把此刻真正开市的市场列出来。
     * 盘前 / 盘后属于延展交易时段，也如实标出。 */
    const live = ['cn', 'hk', 'kr', 'jp', 'tw', 'apac', 'us'].filter(sessLive).map(sk => {
      const j = w.Session.judge(sk, now);
      const name = (w.Session.SESSIONS && w.Session.SESSIONS[sk] && w.Session.SESSIONS[sk].name) || sk;
      if (j.phase === 'pre') return name + '盘前';
      if (j.phase === 'post') return name + '盘后';
      return name + '盘中';
    });
    if (!live.length) return '全球股市休市 · 7×24 品种优先';
    return '交易中：' + live.slice(0, 3).join('、') + (live.length > 3 ? '…' : '')
      + ' · 按实时时段排序，休市后置';
  }

  /* 编辑态里的 ▲▼：只在同一交易时段区内交换，跨区交给时段排序去决定 */
  function moveKey(k, dir) {
    const a = U.get(k);
    if (!a) return;
    const sk = sessionKeyOf(k);
    const same = S.watch.filter(x => U.get(x) && sessionKeyOf(x) === sk);
    const i = same.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= same.length) return;
    const other = same[j];
    const p1 = S.watch.indexOf(k), p2 = S.watch.indexOf(other);
    if (p1 < 0 || p2 < 0) return;
    S.watch[p1] = other; S.watch[p2] = k;
    store.set('mm_watch2', S.watch);
    renderMarket();
  }

  function marketRows(keys) {
    return keys.map((k, i) => {
      const a = U.get(k);
      if (!a) return '';
      const sess = sessionOf(k);
      const g = U.grp(k);
      const q = QuoteHub.get(k);
      const alt = S.alt[k];
      const extNow = S.ext[k];
      const inExt = !!(extNow && extNow.phase);   // 正处在盘前 / 盘后（有延展时段成交）
      const closed = !sess.open && a.grp !== 'crypto';
      // 指数、汇率、商品在行情页写全称（上证指数 / 美元兑离岸人民币 / 黄金/美元），个股仍用简称
      const disp = (a.kind === 'index' || a.kind === 'fx' || a.kind === 'spot' || a.kind === 'future') ? a.name : (a.short || a.name);
      const first = i === 0, last = i === keys.length - 1;
      // 暗盘/链上价与盘前/盘后价**并存**：美光既有盘后又有暗盘、SK海力士既有暗盘又有盘后，
      // 两条数据线都真实存在，谁也不替谁让位（v146 用户明确要两者同屏）。
      const altTxt = alt && (closed || a.grp === 'crypto') ? altLabel(alt, k) : '';
      const extTxt = inExt ? extLabel(extNow, k) : '';
      /* v64：日股夜盤PTS（Japannext J-Market）。只在该市场休市时段展示。 */
      const ptsNow = S.pts[k];
      const ptsTxt = (ptsNow && closed) ? altLabel({ kind: 'pts', price: ptsNow.price, pct: ptsNow.pct }, k) : '';
      /* v215：美股指数没有连续的盘前/盘后成交（三大源都只给常规时段），
       * 列表里再挂个「盘前」标签会让人以为能看到盘前走势 —— 统一按「已收盘」显示。
       * v255：VIX（CBOE 恐慌指数）例外 —— CBOE GTH 延展时段 03:15–16:15 ET 有真实
       * 连续成交，CNBC `.VIX` 给得出真实盘前价（inExt），此时必须显示「盘前」，
       * 不能把正在交易 VIX 标成「已收盘」（用户实测纠错）。 */
      const isUsIdx = (a.grp === 'us' || a.grp === 'usstock') && a.kind === 'index';
      const idxExt = isUsIdx && (sess.phase === 'pre' || sess.phase === 'post') && !inExt;
      const sessLbl = idxExt ? '已收盘' : sess.label;
      const sessCls = idxExt ? 'closed' : (sess.open ? 'open' : sess.phase);
      return `<div class="mk-row qrow" data-k="${esc(k)}">
        <div class="mk-l">
          <b>${esc(disp)}</b>
          <span class="mk-sub">
            <i style="color:${gColor(g)}">${esc(g.label)}</i>
            <em class="mk-st ${sessCls}">${esc(sessLbl)}</em>
            ${a.lag ? `<em class="mk-lag" title="该品种在所有免费行情源上都是延时 ${Math.round(a.lag / 60)} 分钟（数据源口径，不是抓取问题）">延${Math.round(a.lag / 60)}分</em>` : ''}
            ${closed && !inExt ? '<u>收盘价</u>' : ''}
            <em class="mk-syn" ${q && q.synthetic ? '' : 'hidden'} title="该品种实时报价取不到，这个价格是按相关标的推算的合成价，只能看方向，不能当成交价">合成价</em>
          </span>
          ${altTxt ? `<span class="mk-alt" title="${alt.kind === 'hl'
            ? '链上 RWA 永续合约报价（7×24 交易），主市场休市时仍在成交，可用来判断开盘缺口方向'
            : alt.kind === 'dex' ? '链上 DEX 池子实时成交价，与中心化交易所报价的差额' : '延展时段报价'}">${altTxt}</span>` : ''}
          ${extTxt ? `<span class="mk-alt mk-ext" title="美股盘前 04:00–09:30 ET / 盘后 16:00–20:00 ET 的成交价与相对昨收的涨跌幅（CNBC 延展时段报价）。上面那个大数字仍是最近一次常规收盘价。">${extTxt}</span>` : ''}
          ${ptsTxt ? `<span class="mk-alt mk-pts" title="Japannext J-Market 夜间 PTS 成交（17:00–次日 06:00 JST），涨跌幅相对东证收盘。东证主板本身没有美股式盘前盘后。">${ptsTxt}</span>` : ''}
        </div>
        <span class="mk-sp-ph" data-mksp="${esc(k)}"></span>
        <div class="mk-r">
          <b class="qpx" data-k="${esc(k)}">${q ? U.fmt(k, q.price) : '--'}</b>
          <span class="qp" data-k="${esc(k)}">${q ? U.changeLabel(k, q) : '--'}</span>
        </div>
        ${S.marketEdit ? `<div class="mk-mv">
            <button data-mv="up" data-k="${esc(k)}" ${first ? 'disabled' : ''} title="上移">▲</button>
            <button data-mv="down" data-k="${esc(k)}" ${last ? 'disabled' : ''} title="下移">▼</button>
            <button class="mk-x" data-del="${esc(k)}">×</button>
          </div>` : '<span class="mk-x-ph"></span>'}
      </div>`;
    }).join('');
  }

  /* 异动方块 → 直接跳行情页对应那一行。
   * 用户口径：「异动的方块 我希望点进去直接跳对应行情页面」。
   * 之前点方块弹的是「倒查消息」面板，看不到价格上下文，是错的重点。
   * 倒查消息保留在长按（600ms）上，功能没丢。 */
  function focusMarket(key) {
    const a = U.get(key);
    if (!a) return;
    let added = false;
    if (S.watch.indexOf(key) < 0) {
      // 监控池里的品种不一定在自选列表里；不加进去就无处可跳
      S.watch.push(key);
      store.set('mm_watch2', S.watch);
      added = true;
    }
    S.marketFocus = key;
    switchTab('market');
    // 提示条独立于行情列表重绘（价格刷新会不停重渲染 #marketBody）
    const note = $('#mktNote');
    if (note) {
      note.hidden = false;
      note.innerHTML = added
        ? `已把「${esc(a.name)}」加进行情列表 · 轻点该行可看分时/K线`
        : `已定位到「${esc(a.name)}」· 轻点该行可看分时/K线`;
      clearTimeout(note._t);
      note._t = setTimeout(() => { note.hidden = true; }, 6000);
    }
    requestAnimationFrame(() => {
      const row = d.querySelector(`.mk-row[data-k="${cssq(key)}"]`);
      if (!row) return;
      row.classList.add('mk-focus');
      // 瞬时跳，不用 smooth —— 列表很长时平滑滚动要好几秒，用户会以为没反应。
      // 目标行落在视口 40% 处：太靠上会被吸顶的排序条和提示条盖住。
      const rowTop = row.getBoundingClientRect().top + (w.scrollY || 0);
      w.scrollTo(0, Math.max(0, rowTop - Math.round(w.innerHeight * 0.4)));
      setTimeout(() => row.classList.remove('mk-focus'), 3000);
    });
  }

  /* ================= v198：行情列表顶部分类栏 + 分时图预览 =================
   * v197 用户口径：分类栏放在「行情列表页」，图四「特别关注」改成「自选」；
   * 分时小图放在每行名称与价格之间（画圈处），可开关。
   * v198 用户口径（个股泛滥回退，重大问题）：
   *   · 列表只显示「一开始加的指数/商品/外汇/美债/加密」+「用户自选个股」，
   *     不再把全池的 A股/美股/港股等映射标的混进列表；
   *   · 每个市场标签 = 该市场的指数 + 用户自选里属于该市场的个股
   *     （点「A股」看 A股指数 + 自选里的 A股个股，点「韩股」看 KOSPI + 自选韩股）；
   *   · 贵金属/工业金属合并成「金属」；「港股」下含恒生科技指数。 */
  /* v203：行情页默认进「全部」。v198~v202 的默认值是 'watch'（当时语义=自选），
   * 老落盘的 'watch' 是历史默认值、不是用户主动选的 —— 用一次性标记迁移；
   * 迁完之后用户主动点「自选」仍会记住。 */
  let mktCat = store.get('mm_mktcat', 'all');
  if (!store.get('mm_mktcat_migrated', false)) {
    store.set('mm_mktcat_migrated', true);
    if (mktCat === 'watch') { mktCat = 'all'; store.set('mm_mktcat', 'all'); }
  }
  let mktSparkOn = store.get('mm_mktspark', true);
  const MK_CATS = [
    { k: 'all', n: '全部' }, { k: 'watch', n: '自选' },
    { k: 'cn', n: 'A股' }, { k: 'hk', n: '港股' }, { k: 'kr', n: '韩股' },
    { k: 'jp', n: '日股' }, { k: 'tw', n: '台股' }, { k: 'us', n: '美股' },
    { k: 'rate', n: '美债' }, { k: 'fx', n: '外汇' }, { k: 'energy', n: '原油' },
    { k: 'metal', n: '金属' }, { k: 'crypto', n: '加密' }
  ];
  const _mkSpark = new Map();
  /* v198：老标签键（apac / usstock / ind）已合并进市场标签，落盘的旧值要归位到「自选」 */
  if (!MK_CATS.some(c => c.k === mktCat)) { mktCat = 'all'; store.set('mm_mktcat', 'all'); }
  /* v199：排序改三态（fixed/desc/asc），旧版落的 'chg' 归位默认分组顺序 */
  if (S.marketSort !== 'fixed' && S.marketSort !== 'desc' && S.marketSort !== 'asc') {
    S.marketSort = 'fixed';
    store.set('mm_msort', 'fixed');
  }

  /* 资产 → 市场标签的归类。基础标的（指数/商品/外汇/美债/加密）按 grp；
   * 个股（含动态合成）按 grp 映射到所属市场。 */
  function mktOf(k) {
    const a = U.get(k);
    if (!a) return 'other';
    const g = a.grp;
    if (g === 'ind') return 'metal';
    if (g === 'energy' || g === 'metal' || g === 'crypto' || g === 'rate' || g === 'fx') return g;
    if (g === 'cn' || g === 'cnstock') return 'cn';
    if (g === 'us' || g === 'usstock') return 'us';
    if (g === 'hkstock') return 'hk';
    if (g === 'krstock') return 'kr';
    if (g === 'jpstock') return 'jp';
    if (g === 'twstock') return 'tw';
    if (g === 'apac') return a.sess || 'apac';
    return g;
  }

  // 基础标的：非个股（指数/商品/外汇/美债/加密）——「一开始加的那些」
  function baseKeys() {
    return U.keys().filter(k => { const a = U.get(k); return a && a.kind !== 'stock' && a.kind !== 'etf'; });
  }

  function mktCatKeys() {
    /* v199 用户口径：「自选」= 只显示我自己添加的个股，
     * 排除设置好的默认指数/商品（那些在「全部」和各市场标签里看）。 */
    if (mktCat === 'watch') {
      return S.watch.filter(k => { const a = U.get(k); return a && (a.kind === 'stock' || a.kind === 'etf'); });
    }
    const base = baseKeys();
    if (mktCat === 'all') {
      const own = S.watch.filter(k => { const a = U.get(k); return a && (a.kind === 'stock' || a.kind === 'etf'); });
      return Array.from(new Set(base.concat(own)));
    }
    const inMkt = base.filter(k => mktOf(k) === mktCat);
    const own = S.watch.filter(k => { const a = U.get(k); return a && (a.kind === 'stock' || a.kind === 'etf') && mktOf(k) === mktCat; });
    return inMkt.concat(own);
  }

  function renderMktCats() {
    const bar = $('#mktCats');
    if (!bar) return;
    bar.innerHTML = MK_CATS.map(c =>
      `<button class="mkt-cat${c.k === mktCat ? ' on' : ''}" data-mcat="${c.k}">${esc(c.n)}</button>`).join('');
    bar.querySelectorAll('.mkt-cat').forEach(b => {
      b.onclick = () => {
        mktCat = b.dataset.mcat;
        store.set('mm_mktcat', mktCat);
        renderMarket();
      };
    });
  }

  /* v220：缩略图也按「当天完整时段」定位。
   * 原来 X 用 vals.length 等比，盘中看就是「才开盘一小时，线已经画满整格」
   * （用户拿通达信自选对比：刚开盘应该只有最左边一小段）。 */
  /* v223：全天格数改成**自动推导**，不再维护硬编码 grp 表。
   * 取 session（品种自带 sess 优先，否则用 GROUPS[grp].session），
   * 再由 Session.fullMinutes() 从 SESSIONS.segs 累加得到当日分钟数。
   * 这样以后往 universe 里加任何市场/品种，只要 grp 带 session 就自动正确，
   * 不会再出现「新加的品种缩略图走满格」。 */
  function sparkFullN(k, pts) {
    const n = pts.length;
    try {
      const a = w.UNIVERSE && w.UNIVERSE.get ? w.UNIVERSE.get(k) : null;
      /* minSpan：品种自带的一天分钟数（VIX 的 GTH 时段 780 分钟，不是美股的 390） */
      let total;
      if (a && a.minSpan) {
        total = a.minSpan;
      } else {
        let sk = a && a.sess;
        if (!sk && w.UNIVERSE && w.UNIVERSE.grp) {
          const g = w.UNIVERSE.grp(k);
          sk = g && g.session;
        }
        total = (w.Session && w.Session.fullMinutes) ? w.Session.fullMinutes(sk) : 0;
      }
      if (!total || n < 2) return n;
      const c = {};
      for (let i = 1; i < n; i++) {
        const d = Math.round((pts[i].time - pts[i - 1].time) / 60);
        if (d > 0 && d <= 30) c[d] = (c[d] || 0) + 1;
      }
      let gran = 1, best = 0;
      for (const key in c) if (c[key] > best) { best = c[key]; gran = +key; }
      return Math.max(n, Math.round(total / gran));
    } catch (e) { return n; }
  }

  function mkSparkSVG(vals, up, fullN) {
    if (!vals || vals.length < 4) return '<span class="mk-sp-ph" data-mksp=""></span>';
    const W = 68, H = 30, P = 2;
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const rg = (hi - lo) || 1;
    const N = Math.max(vals.length, fullN || vals.length);
    const X = i => P + i / (N - 1) * (W - P * 2);
    const Y = v => H - P - (v - lo) / rg * (H - P * 2);
    let dd = '';
    for (let i = 0; i < vals.length; i++) dd += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(vals[i]).toFixed(1) + ' ';
    const col = up ? 'var(--up)' : 'var(--down)';
    return `<svg class="mk-sp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
      + `<path d="${dd}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  /* 视口懒加载：滚动到哪行才取哪行的分时，避免一屏发几十个请求；
   * 有缓存直接复用，失败保留灰占位。 */
  let _mkObserver = null;
  /* 【改造1·首屏快照】分时序列也落盘：冷启动先用上次的分时线画满，
   * 后台拉新后覆盖。避免打开时每行都是灰占位块。 */
  const _mkSparkN = new Map();   // 每只票「当天应该有多少格」，缩略图按它定位
  const _mkSparkStale = new Set();  // 来自首屏快照、还没被真实数据替换的 key
  const SPARK_SNAP_KEY = 'mm_spark_snap_v1';
  let sparkSnapT = 0;
  function loadSparkSnap() {
    let snap = null;
    try { snap = store.get(SPARK_SNAP_KEY, null); } catch (e) {}
    if (!snap || !snap.data) return false;
    if (Date.now() - (snap.at || 0) > 12 * 3600 * 1000) return false;
    let n = 0;
    const ns = snap.n || {};
    Object.keys(snap.data).forEach(k => {
      const v = snap.data[k];
      if (Array.isArray(v) && v.length >= 4 && _mkSpark.get(k) === undefined) {
        _mkSpark.set(k, v);
        if (ns[k]) _mkSparkN.set(k, ns[k]);
        /* v221：快照只是「首屏秒开」用的旧数据，必须标记成 stale，
         * 让 loadMkSpark 仍然去拉真实分时。原来靠 `vals === undefined` 判断，
         * 快照一填进去就再也不会请求 —— 盘中一直拿昨天的全天曲线，
         * 缩略图自然是「铺满整格」（用户：缩略图还是老样子）。 */
        _mkSparkStale.add(k);
        n++;
      }
    });
    return n > 0;
  }
  function saveSparkSnap() {
    try {
      const now = Date.now();
      if (now - sparkSnapT < 15000) return;   // 节流 15 秒
      sparkSnapT = now;
      const data = {}, ns = {};
      _mkSpark.forEach((v, k) => {
        if (!Array.isArray(v)) return;
        data[k] = v;
        const n = _mkSparkN.get(k);
        if (n) ns[k] = n;
      });
      if (Object.keys(data).length) store.set(SPARK_SNAP_KEY, { at: now, data, n: ns });
    } catch (e) {}
  }
  const _mkSparkFail = new Map();   // v242：失败时刻，用于退避重试
  async function loadMkSpark(k) {
    let vals = _mkSpark.get(k);
    const failAt = _mkSparkFail.get(k) || 0;
    const cooling = failAt && (Date.now() - failAt < 12000);  // 失败后 12 秒退避，避免每轮补拉都重打
    const stale = _mkSparkStale.has(k);
    if (!cooling && (vals === undefined || stale)) {
      try {
        const r = await w.API.intraday(k);
        const allPts = (r && r.points) || [];
        /* 美股个股的 intraday 默认带盘前段（ext=true，从 04:00 ET 起 432 个点），
         * 直接拿来算就会「点数 > 全天格数」→ 不补 → 缩略图走满。
         * 详情页分时默认也只画常规段，这里保持一致。 */
        const hasSeg = allPts.some(p => p.seg);
        const regPts = hasSeg ? allPts.filter(p => p.seg === 'reg') : allPts;
        const pts = (regPts.length > 3 ? regPts : allPts);
        const nv = pts.map(p => p.close != null ? p.close : p.v).filter(v => isFinite(v));
        if (nv.length >= 4) {
          vals = nv;
          _mkSpark.set(k, vals);
          _mkSparkFail.delete(k);
          _mkSparkN.set(k, sparkFullN(k, pts));
          _mkSparkStale.delete(k);
          saveSparkSnap();
        } else if (vals === undefined) {
          /* v242：只记失败时刻，不永久写 null。
           * 原来失败即 set(k,null)，之后 vals===undefined 不成立、stale 也不成立，
           * 这一行再也不会重试 —— 网络抖一下就永久空白（用户截图里的灰块）。 */
          _mkSparkFail.set(k, Date.now());
        }
      } catch (e) { if (vals === undefined) _mkSparkFail.set(k, Date.now()); }
    }
    if (!vals) return;
    const body = $('#marketBody');
    if (!body) return;
    let slot = null;
    body.querySelectorAll('[data-mksp]').forEach(el => { if (el.dataset.mksp === k) slot = el; });
    if (!slot) return;
    const q = QuoteHub.get(k);
    const tmp = d.createElement('div');
    /* 报价还没到时 q 为 null，原来一律按「跌」画成绿色 —— 涨 +1.9% 的标普
     * 缩略图是绿的，很别扭。这里退回「首尾比较」兜底。 */
    const up = (q && q.pct != null) ? q.pct >= 0 : (vals[vals.length - 1] >= vals[0]);
    tmp.innerHTML = mkSparkSVG(vals, up, _mkSparkN.get(k));
    const node = tmp.firstChild;
    if (node) { node.setAttribute('data-mksp', k); slot.replaceWith(node); }
  }

  /* 限并发队列：最多 8 个请求在飞，逐行补齐，最终每行都有分时线
   * （不做视口懒加载 —— 用户口径是「像图四一样每行都有」）。 */
  function fillMkSparks() {
    const body = $('#marketBody');
    if (!body || !w.API || !w.API.intraday) return;
    const keys = [...body.querySelectorAll('.mk-sp-ph[data-mksp]')].map(el => el.dataset.mksp);
    if (!keys.length) return;
    let i = 0;
    const next = () => {
      if (i >= keys.length) return;
      const k = keys[i++];
      Promise.resolve(loadMkSpark(k)).then(next, next);
    };
    for (let n = 0; n < Math.min(8, keys.length); n++) next();
  }

  function renderMarket() {
    const body = $('#marketBody');
    renderMktCats();
    body.classList.toggle('no-sp', !mktSparkOn);
    const keys = mktCatKeys().filter(k => U.get(k));
    $('#mktEdit').classList.toggle('on', S.marketEdit);
    $('#mktEdit').textContent = S.marketEdit ? '完成' : '编辑';
    const sBtn = $('#mktSess');
    if (sBtn) {
      sBtn.classList.toggle('on', S.sessFirst);
      sBtn.textContent = S.sessFirst ? '时段优先' : '固定顺序';
    }
    const spTog = $('#mktSpTog');
    if (spTog) {
      spTog.classList.toggle('on', mktSparkOn);
    }
    const chgBtn = $('#mktChg');
    if (chgBtn) {
      chgBtn.classList.toggle('on', S.marketSort !== 'fixed');
      chgBtn.textContent = S.marketSort === 'desc' ? '涨幅↓' : (S.marketSort === 'asc' ? '涨幅↑' : '按涨跌');
    }

    if (!keys.length) {
      const msg = mktCat === 'watch'
        ? '<b>自选里还没有个股</b><span>点顶部放大镜「添加品种」搜索并添加你想盯的股票（默认指数/商品不在这里）</span>'
        : '<b>行情列表是空的</b><span>点顶部放大镜「添加品种」把关注的品种加回来</span>';
      body.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }

    /* v199：「按涨跌」只影响每个分组卡片内部的行序（关闭→降序→升序循环），
     * 分组卡片的位置只由「时段优先」决定，两者互不干扰。没拿到价的排最后。 */
    const byPct = (dir) => (a, b) => {
      const qa = QuoteHub.get(a), qb = QuoteHub.get(b);
      const pa = qa && isFinite(qa.pct) ? qa.pct : null;
      const pb = qb && isFinite(qb.pct) ? qb.pct : null;
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return dir === 'desc' ? pb - pa : pa - pb;
    };

    if (mktCat !== 'all' && mktCat !== 'watch') {
      // v198：单市场标签平铺展示（该市场的指数 + 用户自选个股），
      // 不套「交易时段分组」的大标题，避免「金属」标签下冒出「原油·贵金属·工业金属」这种错标题
      const c = MK_CATS.find(x => x.k === mktCat);
      const sk = sessionKeyOf(keys[0]);
      const meta = sessionMeta(sk);
      const list = (S.marketSort === 'fixed')
        ? sessionSort(keys.slice())
        : keys.slice().sort(byPct(S.marketSort));
      body.innerHTML = `<section class="mkg">
        <div class="mkg-h">
          <i style="background:${meta.color}"></i><b>${esc(c ? c.n : mktCat)}</b><span>${list.length}</span>
        </div>
        ${marketRows(list)}
      </section>`;
    } else {
      // v146：按「交易时段」归组（指数在前、个股在后）；v199：组内行序可被「按涨跌」切降/升
      const sessGroups = {};
      keys.forEach(k => {
        const sk = sessionKeyOf(k);
        (sessGroups[sk] = sessGroups[sk] || []).push(k);
      });
      const order = sessionOrder().filter(sk => sessGroups[sk]);
      body.innerHTML = `<div class="mkt-hint">${esc(orderHint())}${S.marketEdit ? ' · 用 ▲▼ 调整组内顺序' : ''}</div>`
        + order.map(sk => {
        const meta = sessionMeta(sk);
        const list = (S.marketSort === 'fixed')
          ? sessionSort(sessGroups[sk])
          : sessGroups[sk].slice().sort(byPct(S.marketSort));
        const st = sessionOf(list[0]);
        return `<section class="mkg">
          <div class="mkg-h">
            <i style="background:${meta.color}"></i><b>${esc(meta.full || meta.label)}</b>
            <span>${list.length}</span>
            <em class="mkg-s ${st.open ? 'open' : ''}">${esc(st.label)}</em>
          </div>
          ${marketRows(list)}
        </section>`;
      }).join('');
    }
    QuoteHub.refresh(keys);
    refreshAlt(keys);
    refreshExt(keys);
    if (mktSparkOn) fillMkSparks();
  }

  /* 非交易时段的替代价：
   *   · 加密 → 链上 DEX 池子价（看 CEX-DEX 基差）
   *   · 商品 / 股指 / 个股 → 链上 RWA 永续（7×24，即用户说的「暗盘价」）
   *   · 美股个别标的还有服务端延展时段兜底（file:// 下自动跳过）
   *
   * 用户口径：「原油周末要标出暗盘价格，其他商品如果有暗盘或者链上
   * 价格同理，包括我后续自己添加的个股」。所以只要资产配了 hl 字段，
   * 一旦该品种不在交易时段，就补一条链上价。 */
  let altBusy = false;
  async function refreshAlt(keys) {
    if (altBusy) return;
    altBusy = true;
    try {
      for (const k of keys) {
        const a = U.get(k);
        if (!a) continue;
        const q = QuoteHub.get(k);

        // 加密本身就是 7×24，链上只用来比基差
        if (a.grp === 'crypto' && a.dex) {
          try {
            const prev = S.alt[k];
            if (prev && Date.now() - prev.at < 90000) continue;
            const dx = await w.API.dexQuote(k);
            const spread = q && q.price ? (dx.price - q.price) / q.price * 100 : null;
            S.alt[k] = { kind: 'dex', price: dx.price, spread, at: Date.now() };
            patchAlt(k);
          } catch (e) {}
          continue;
        }

        const closed = !sessionOf(k).open;
        if (!closed) {
          // 开市中还留着上次的暗盘价会让人误读，直接撤掉
          if (S.alt[k] && S.alt[k].kind !== 'dex') { delete S.alt[k]; patchAlt(k); }
          continue;
        }

        // ① 暗盘：Hyperliquid RWA 永续（7×24 成交，休市时仍在走）
        //    美股个股即使没配 hl 也试一次 —— 用户自己加的票在链上多为同名挂牌
        //    v64：韩股/日股/台股按「同公司海外挂牌」（SKHX / TSM / SMSN …）取参考价
        let gotHl = false;
        if (a.hl || a.grp === 'usstock' || (w.UNIVERSE.adrOf && w.UNIVERSE.adrOf(k))) {
          try {
            const prev = S.alt[k];
            if (prev && prev.kind === 'hl' && Date.now() - prev.at < 50000) {
              gotHl = true;
            } else {
              const hp = await w.API.hlQuote(k);
              if (hp) {
                /* 基差只有在计价单位一致时才有意义：
                 * A股/韩股/日股/港股链上是美元计价的等价物，
                 * 直接相减会得出「-87%」这种荒谬数字，只报价格不算基差。
                 * v64：跨市场 ADR/GDR（SKHX / TSM / SMSN…）同样不算基差 ——
                 * 币种不同，换算比例也可能不是 1:1（TSM 是 1 ADS = 5 股）。 */
                const sameUnit = !/^(元|韩元|日元|HKD|港元|新台币)$/.test(a.unit || '');
                let spread = (sameUnit && !hp.adr && q && q.price)
                  ? (hp.price - q.price) / q.price * 100 : null;
                /* 基差兜底：真基差不可能有两位数。一旦超过 8%，说明
                 * 链上那个标的和主报价根本不是同一个东西（或者计价单位
                 * 不同），此时只报价格、不报基差，免得给出「-95%」这种
                 * 一眼假的数。 */
                if (spread != null && Math.abs(spread) > 8) spread = null;
                S.alt[k] = { kind: 'hl', price: hp.price, spread, at: Date.now(), sym: hp.sym, adr: hp.adr || null };
                patchAlt(k);
                gotHl = true;
              }
            }
          } catch (e) {}
        }

        // ② 链上：DexScreener DEX 现货池（和暗盘是两回事，各存一格，互不覆盖）
        /* v150 用户口径：「如果同时有暗盘和链上两个价格，要分别显示」。
         * 实测美股个股在链上有真实同名 RWA 池（MU 691.91 / SKHY 129.06，流动性 80 万美元级），
         * 韩股/台股没有整齐对应关系，dexQuote 内部会直接拒绝，不会伪造一条。 */
        try {
          const prevD = S.dexAlt[k];
          if (!(prevD && Date.now() - prevD.at < 90000)) {
            const dx = await w.API.dexQuote(k);
            /* 搜到的若是同名小币（与正股偏离 >50%），宁可不显示，也别把错价摆上来 */
            const off = (dx && dx.price && q && q.price) ? Math.abs(dx.price - q.price) / q.price : 0;
            if (dx && dx.price && off <= 0.5) {
              let sp = q && q.price ? (dx.price - q.price) / q.price * 100 : null;
              if (sp != null && Math.abs(sp) > 8) sp = null;
              S.dexAlt[k] = { kind: 'dex', price: dx.price, spread: sp, pair: dx.pair, at: Date.now() };
            }
          }
        } catch (e) {}

        // ③-b 日股 夜間PTS（Japannext J-Market，17:00–次日 06:00 JST）。
        /* 放在最后并且**不 await**：那一页有 300KB HTML，逐个串行会把这个循环拖到十几秒，
         * 后面的品种（韩股/台股的暗盘）根本轮不到 —— 实测就是「有的行有、有的行没有」。
         * 所以 fire-and-forget，回来再单独塞进那一行。 */
        if (a.grp === 'jpstock') {
          const prevP = S.pts[k];
          if (!(prevP && Date.now() - prevP.at < 55000)) {
            w.API.jpPtsQuote(k).then(pj => {
              if (!pj) return;
              S.pts[k] = pj;
              patchPts(k);
              if (S.sheetKey === k) { try { renderExtHead(k); } catch (e) {} }
            }).catch(() => {});
          }
        }

        // ③ 服务端延展时段兜底（暗盘取不到时，行情页至少还有一行替代价）
        if (!gotHl && a.extSym && !S.alt[k]) {
          try {
            const ex = await w.API.extQuote(k);
            if (ex) {
              S.alt[k] = { kind: 'ext', price: ex.price, spread: null, at: Date.now() };
              patchAlt(k);
            }
          } catch (e) {}
        }
      }
    } finally { altBusy = false; }
  }

  function altLabel(alt, k) {
    if (!alt) return '';
    const a = U.get(k);
    const sameUnit = !/^(元|韩元|日元|HKD|港元|新台币)$/.test((a && a.unit) || '');
    if (alt.kind === 'dex') {
      return '链上 ' + U.fmt(k, alt.price)
        + (alt.spread != null ? ' · 基差 ' + (alt.spread >= 0 ? '+' : '') + alt.spread.toFixed(2) + '%' : '');
    }
    if (alt.kind === 'hl') {
      /* v64：跨市场 ADR/GDR 参考价（SKHX / TSM / SMSN…）明确标出来，
       * 币种不同、可能有换算比例，绝不能让人误读成本地价格。 */
      if (alt.adr) {
        return '暗盘 ' + alt.adr.label + '(' + alt.sym + ') $' + alt.price.toFixed(2);
      }
      return '暗盘 ' + (sameUnit ? U.fmt(k, alt.price) : alt.price.toFixed(2))
        + (alt.spread != null ? ' · 基差 ' + (alt.spread >= 0 ? '+' : '') + alt.spread.toFixed(2) + '%' : '');
    }
    if (alt.kind === 'pts') {
      return '夜盤PTS ' + U.fmt(k, alt.price)
        + (alt.pct != null ? ' ' + (alt.pct >= 0 ? '+' : '') + alt.pct.toFixed(2) + '%' : '');
    }
    return '延展 ' + U.fmt(k, alt.price);
  }

  /* 日股「夜盤PTS」那一行的就地更新（与 patchAlt 同一套做法） */
  function patchPts(k) {
    const p = S.pts[k];
    const row = d.querySelector(`.mk-row[data-k="${cssq(k)}"] .mk-l`);
    if (!row) return;
    let el = row.querySelector('.mk-pts');
    if (!p) { if (el) el.remove(); return; }
    if (!el) {
      el = d.createElement('span');
      el.className = 'mk-alt mk-pts';
      el.title = 'Japannext J-Market 的夜间 PTS 成交（17:00–次日 06:00 JST），涨跌幅相对东证收盘。该市场没有美股式盘前盘后，这是唯一的连续夜盘。';
      row.appendChild(el);
    }
    el.textContent = altLabel({ kind: 'pts', price: p.price, pct: p.pct }, k);
  }

  function patchAlt(k) {
    const alt = S.alt[k];
    const row = d.querySelector(`.mk-row[data-k="${cssq(k)}"] .mk-l`);
    if (!row) return;
    // 只认「暗盘」那一行；盘前/盘后行（.mk-ext）是独立的一条，两者并存，不互相删除（v146）
    let el = row.querySelector('.mk-alt:not(.mk-ext)');
    if (!alt) { if (el) el.remove(); return; }
    if (!el) { el = d.createElement('span'); el.className = 'mk-alt'; row.appendChild(el); }
    el.textContent = altLabel(alt, k);
    el.title = alt.kind === 'hl'
      ? '链上 RWA 永续合约报价（7×24 交易），主市场休市时仍在成交，可用来判断开盘缺口方向'
      : alt.kind === 'dex'
        ? '链上 DEX 池子实时成交价，与中心化交易所报价的差额'
        : '延展时段报价';
  }

  /* ---------------- 盘前 / 盘后涨跌幅 ----------------
   * 用户口径：「行情页可以像暗盘那样写上盘前/盘后涨跌幅多少」。
   *
   * 为什么要单独一块：东财那套批量报价只有常规时段，盘前/盘后时它给的是
   * 上一交易日收盘价和那一天的涨跌。用户看到「盘前」标签却配着昨天的百分比，
   * 等于这一栏是假的。这里改用 CNBC 延展时段报价（API.extQuotes），
   * 只在真有盘前/盘后成交时才显示，取不到就不显示（不猜、不补零）。
   */
  function extLabel(ext, k) {
    if (!ext || !ext.phase) return '';
    const t = ext.phase === 'pre' ? '盘前' : '盘后';
    const px = ext.price != null ? ' ' + U.fmt(k, ext.price) : '';
    const pc = ext.pct != null ? ' · ' + (ext.pct >= 0 ? '+' : '') + ext.pct.toFixed(2) + '%' : '';
    return t + px + pc;
  }

  let extBusy = false;
  async function refreshExt(keys) {
    if (extBusy || !w.API || typeof w.API.extQuotes !== 'function') return;
    const us = (keys || []).filter(k => {
      const a = U.get(k);
      // v146：美股 + 韩股 + 台股 都有盘前盘后（韩股/台股走 TradingView），
      // 不再只认美股。加密没有延展时段，直接跳过。
      if (!a || a.grp === 'crypto') return false;
      if (['usstock', 'us', 'krstock', 'twstock'].indexOf(a.grp) < 0) return false;
      /* 常规时段不取：此刻大号价格就是实时成交，再挂一条「盘后」只会打架；
       * 而且数据源在开盘初期可能还留着上一场盘后的旧记录。 */
      const st = w.Session && w.Session.state ? w.Session.state(k) : null;
      return !(st && st.phase === 'regular');
    });
    if (!us.length) return;
    extBusy = true;
    try {
      const map = await w.API.extQuotes(us);
      us.forEach(k => {
        const rec = map[k] || null;
        if (!rec) {
          if (S.ext[k]) { delete S.ext[k]; patchExt(k); }
          return;
        }
        S.ext[k] = rec;
        patchExt(k);
      });
    } catch (e) { /* 取不到就保持原样，行情页退化成「只有常规收盘价」 */ } finally {
      extBusy = false;
    }
  }

  /* 详情页头部那一行「盘后 342.65 · +0.08%」 */
  function renderExtHead(key) {
    const host = $('#shHeadExt');
    if (!host) return;
    const ex = S.ext[key];
    if (!ex || !ex.phase) { host.hidden = true; host.innerHTML = ''; return; }
    /* v255：延展报价晚到时，头部会话标签同步从「已收盘」改为「盘前/盘后」，
     * 避免打开瞬间是「已收盘」、数据到了才闪变（VIX 实测）。 */
    const sessEl = document.querySelector('#sheet .sh-sess');
    if (sessEl && sessEl.textContent === '已收盘') {
      sessEl.textContent = ex.phase === 'pre' ? '盘前' : '盘后';
      sessEl.classList.add('open');
    }
    const cls = (ex.pct != null && ex.pct < 0) ? 'down' : 'up';
    host.hidden = false;
    host.innerHTML = `<i>${ex.phase === 'pre' ? '盘前' : '盘后'}</i>`
      + `<b>${U.fmt(key, ex.price)}</b>`
      + (ex.pct != null ? `<em class="${cls}">${U.pct(ex.pct)}</em>` : '');
  }

  /* 行内就地更新，不整页重绘（价格每 60 秒刷一次，重绘会把滚动位置带跑） */
  function patchExt(k) {
    const ext = S.ext[k];
    const row = d.querySelector(`.mk-row[data-k="${cssq(k)}"] .mk-l`);
    if (!row) return;
    let el = row.querySelector('.mk-ext');
    if (!ext || !ext.phase) { if (el) el.remove(); return; }
    if (!el) {
      el = d.createElement('span');
      el.className = 'mk-alt mk-ext';
      el.title = '美股盘前 04:00–09:30 ET / 盘后 16:00–20:00 ET 的成交价与相对昨收的涨跌幅（CNBC 延展时段报价）。上面那个大数字仍是最近一次常规收盘价。';
      row.appendChild(el);
    }
    el.textContent = extLabel(ext, k);
    /* 有延展成交时，「收盘价」这个灰标记会误导（价格其实是昨收），撤掉。
     * 暗盘那行保留 —— 盘前/盘后与暗盘/链上并存展示（v146），不再互相覆盖。 */
    const closedTag = row.querySelector('u');
    if (closedTag && closedTag.textContent === '收盘价') closedTag.remove();
  }

  /* ---------------- 中文名首字母搜索（v150） ----------------
   * 用户报：「添加自定义个股时输入中际旭创的首字母 zjxc 无结果」。
   * 原来只有 code / name / short 的字面包含匹配，中文名自然搜不到拼音。
   * 这里用一张离线生成的「汉字 → 首字母」表（pypinyin 对 GB2312 全字集生成），
   * 只对中文名做映射，英文/代码仍走原有的大小写不敏感比较，
   * 避免输入 mu 时把一堆拼音首字母含 M 的中文名也带出来。 */
  const PY_INIT_SRC = 'A俺傲凹哀哎唉啊嗄嗌嗳嗷坳埃埯奥媪嫒安岙岸庵廒懊拗按挨捱揞敖昂暗暧案桉氨澳熬爱犴獒瑷癌皑盎矮砹碍翱聱肮胺艾蔼螯袄谙遨鏊鏖铵锕锿阿隘霭鞍骜鳌鹌黯|B不丙亳伯伴佰便保俾倍傍傧八兵冫冰别剥办勃勹包匕北匾半卑博卜卞卟变叭吡吧呗哔哺啵嘣坂坌坝埠堡壁备奔妣婊婢嬖孛孢宝宾岜崩巴币布帛帮并庇庳弁弊弼彪彬彼必忭怖悖悲惫愎憋扁扒扮扳把报抱拌拔拜拨捌捕捭掰搏搬摆摈摒播擘敝斌斑晡暴本杓杯板柄柏标梆棒榜槟檗步殡比毕毖毙汴波泵浜渤滗滨濒濞灞灬炳焙煲煸爆爸版狈狴玢玻班璧瓣瓿甏甭畀畚疤病痹瘢瘪瘭癍白百砭碑碚碥碧磅礴禀秉秕稗窆笆笔笨笾筚箅箔篦簸簿粑绊绑绷缏编缤罢耙背胞脖膀膊膑膘臂舨般舭舶芭苄苞苯茇荜荸菝菠萆葆蒡蓓蓖蔽薄薜蚌蝙补表被裨裱褊褒褓褙襞谤豳豹贝败贬贲趵跋跛跸踣蹦蹩辈辨辩辫边迸逋逼遍避邦邴邶部鄙醭鐾钚钡钣钯钵钸钹铂铋锛镑镔镖镳闭阪陂陛雹霸靶鞭鞴颁飑飙飚饱饼饽驳骠髀髌髟鬓魃鲅鲍鳊鳔鳖鸨鹁鹎鼻龅|C丑丛丞串乘亍产仇从仓传伥伧伺侈侧侪促俦倡偿储催傺充冁册冲凑出刍创初刺匆厂厕厝厨参叉叱吃吵吹呈呲哧唇唱啐啜啻喘嗔嗤嘈嘬嘲噌嚓囱场坻坼垂城埕塍墀处姹娼婵媸嫦存孱宠宸察寸尘尝尺层屮岑岔崇崔嵯巛川巢差帱常幢床廛弛彩彳彻徂徜忏忖忡忱怅怆怊怵恻悴惆惝惨惩惭愁慈憧憷成戳才扯承抄抻抽拆持挫捶掣措掺插揣搀搋搐搓搽摧撑撤撮撺操擦敕敞斥昌春昶晁晟晨曹曾朝杈材村杵枞枨查柴柽棰椎椽椿楚楮榇榱槌槎槽樗橙橱檫次此殂残毳氅氚汆汊池沉沧测涔淙淬淳滁漕潮潺澄澈澶灿炊炒炽焯爨猖猜猝猹琛琮璀璁璨瓷畅畜畴疮疵痤痴瘁瘛瘥瘳皴眵睬瞅瞠矗矬砗础碜碴磁磋礤祠禅秤称程稠穿窗窜笞策筹篡篪簇粗粲粹糍糙纯绌绰绸缠羼翅翠耖耻聪肠脆脞腠膪臣臭舂舛舡舱船艚艟艹苁苌苍茈茌茨茬茶茺草莼菖菜萃葱蒇蔟蔡藏虫虿蚕蚩蛏蜍蝉蝽螬螭蟾蠢衩衬裁裎褚褫觇触词诚诧谄谌谗谶豺财赐赤趁超踌踔踟踩踹蹉蹙蹭蹰蹴蹿躇躔车辍辏辞辰辶迟逞遄郴酢酬酲醇醋采钏钗钞铖铲铳锄锉错锤锸镡镩镲闯阊阐陈除陲雌雏雠颤餐饬馇馋驰骋骖骢骣鬯魑鲳鸱鹑鹚鹾黜黪齿龀龊|D丁东丢丹仃代佃但低侗倒傣儋兑党兜典冬冻凋凳凼刀刁刂到剁动单叠叨叮叼吊吨呆呔咄咚哆哒哚啖啶喋嗒嗲嘀嘟噔囤地坫垌垛垤垫埭堆堕堞堤堵墩多大夺奠妒妲娣嫡宕定对导岛岱岽峒嶝巅帝带底店度弟弹当待得德忉怛怠怼恫悼惦惮惰憝懂戥戴打抖抵担挡捣掂掇掉掸揲搭敌敦斗断旦朵杜柁柢栋档棣椟椴歹殆殚段殿毒氐氘氡氮沌沓洞涤淀淡渎渡滇滴澹灯炖点焘煅爹牍牒犊狄独玎玳玷瓞甙电甸疔疸痘瘅瘩癜癫登的盗盯盹盾眈睇督睹瞪短砀砘砥硐碇碉碓碘碟碡碲磴礅祷稻窦端笃笛笪第等答箪篼簖簟簦籴纛绐缍缎缔羝翟耋耵耷耽聃肚胆胨胴腚舵芏荡荻菪萏董蒂蔸蚪蛋蝶蠹袋裆裰褡觌订诋诞读调谍谛谠豆貂贷赌赕趸跌跺踮踱蹀蹈蹬蹲躲达迨迪迭递逗逮遁道邓邸郸都酊钉钓钝钿铎铛铞铤铥铫锝锭锻镀镝镦镫队阽陡雕靛靼鞑顶顿颠骀骶髑鲷鲽鸫黛黩鼎|E二佴俄儿厄呃噩垩娥婀尔屙峨恩恶愕扼摁洱珥而耳腭苊莪萼蒽蛾讹诶谔贰轭迩遏鄂铒锇锷阏颚额饵饿鲕鳄鸸鹅鹗|F丰乏付份仿伏伐佛俘俯俸偾傅冯凡凤凫分副匐匚匪反发吠否吩呋咐唪啡坊坟垡复夫奉奋妃妇妨孚孵富封峰帆幅幞幡府废弗忿怫悱愤房扉扶抚拂拊放敷斐斧方服枋枫桴梵棼榧樊氛氟汾沣沸法泛浮涪淝滏瀵烦烽焚燔父犯狒珐甫畈番疯痱矾砜砝砩祓福稃符筏篚粉粪繁纷纺绂绋绯缚缝缶罘罚翡翻肤肥肪肺腐腑腓腹舫艴芙芬芳芾苻范茯莩菔菲葑蕃藩蘩蚨蜂蜉蜚蝠蝮袱覆讣讽访诽负贩费赋赙赴趺跗蹯辅辐返逢邡郛酆酚釜钒钫锋镄阀阜阝防附霏非风飞饭馥驸鲂鲋鲱鲼鳆麸黻黼鼢|G丐丨个乖亘仡估伽佝供倌傀光公共关冈冠刚刮刽刿剐割功勾匦卦古各告呙呱呷咕咣咯哏哥哽哿嗝嘎嘏噶固国圪圭坩垓垢埂埚塥够妫姑媾孤宄官宫寡尕尜尬尴岗岣崞崮工巩帼干广庋庚廾弓彀归怪恭惯感戆戈戤拐拱挂掴掼搁搞搿擀改攻故敢旮旰晷更杆杠杲构果枸柑柜栝根格桂桄桧梏梗棍棺椁概槁槔橄歌毂汞汩沟沽泔涫淦港溉滚澉灌炔牯牿犷狗猓珙瑰瓜甘疙疳痼癸皈皋盖盥睾瞽矸硅硌磙秆稿竿笱筻箍管篙篝簋糕纥纲绀给绠绲缑缟缸罐罟罡羔羹耕耿聒肛肝股肱胍胱胳膈膏臌舸艮苟苷茛莞菇菰葛藁虢虼蚣蛄蛊蜾蝈衮袼裹褂观规觏觚觥诂诖诟诡该诰谷贡购贯贵赅赓赣赶跟跪躬轨轱辊辜过逛遘郜郭酐酤钆钙钢钩钴铬锅锆锢镉镐闺阁陔隔雇革鞲顾馆馘骨骼高鬲鬼鲑鲠鲧鲴鳏鳜鸪鸹鸽鹄鹘鹳鼓龚龟|H乎互亥亨伙会何侯候冱凰函划劐劾化卉华厚号合后含吼呵呼和咴哄哈哕哗哼唤唬唿喉喊喙喝嗥嗨嗬嘿嚆嚎嚯回囫圜坏堠壑壕壶夥夯奂好婚孩宏宦害寒寰岵幌幻弘弧彗很徊後徨徽忽怀怙恍恒恚恢恨悍悔患惑惚惠惶慌慧憨憾或户戽扈护挥捍换撖撼擐攉斛旱昊昏晃晖晗晦曷杭核桁桓桦槐槲横欢毁毫氦汇汉汗沆沪河泓洄洪洹活浍浑浒浣浩海涣涵涸淮混湖湟溷滑滹漶潢濠瀚灏火灰烀烘烩焊焓焕煌煳狐狠猢猴猾獾环珩珲琥瑚璜瓠画痕痪瘊癀皇皓盍盒砉磺祜祸禾秽笏篁篌簧糇糊红绗绘缋缓缳罕翮翰耗耠肓胡胲航花茴荒荟荤荭荷获菏菡萑葫蒿蕙蕻薅薨藿蘅虍虎虹虺蚝蚵蚶蛔蛤蝗蝴蟥蟪蠖衡褐觳訇讧讳诃诙话诨诲谎豁豢豪貉货贺贿赫踝轰轷辉还逅逭遑邗邯郇郝酣醐醢钬铧铪锪锾镬闳阂阍阖阚隍隳霍韩顸颃颌颔颢馄骅骇骸骺鬟魂鲎鲩鳇鸿鹕鹤鹱麾黄黉黑鼾|J丌举久九乩井亟交京仅今介件价伎佳佶佼侥俊俭俱倔借倦倨假偈健僦僬僭僵儆兢具兼冀冂军决净减几击刭剂剑剞剧剪剿劂加劫劲匠卩即卷卺厥厩及句叫叽吉君咀咎咭哜唧啾喈嗟嘉噍噘噤噱嚼囝圾均坚基堇境墼夹奖奸妓妗姐姜姣姬娇娟婕婧嫁嫉孑孓季家寂寄将尖就尽局居届屐屦岌岬峤峻崛嵇嵴巨己巾廑建弪彐径徼忌急恝悸惊惧憬戋戒戛戟戢截戬扃技抉拒拘拣拮挢挤捃捐捡据捷掎掘接掬揪揭搅搛撅攫救教敫敬斤旌既旧晋景晶暨机杰极枧架枷柩柬桀桊桔桕桨桷检棘椐椒楗楫榉榘槿橘橛歼殛毽江汲沮泾洁洎洚津浃浆浇济浚浸涓涧渐湔湫溅激灸炅炬炯烬焦煎爝爵牮犄犋犍犟狙狡狷獍獗玑玖珈珏琚瑾甲界畸畿疆疖疚疥疽疾痂痉瘕瘠皆皎皲监眷睑睛睫矍矜矩矫矶硷碣碱礁礓祭禁积秸稷稼稽究窖窘窭竞竟竣竭笄笈笕笳笺筋简箕箭籍粳精糨紧纠级纪经结绛绝绞绢继绩缄缉缙缣缰缴羁羯翦耩聚肌肩肼胛胫胶脊脚腈腱臼舅舰艰艽节芥芨芰苣苴茄茎茧茭茳荆荐荚荠荩莒菁菅菊菌菹葭蒋蒹蒺蓟蕉蕨蕺藉虮蚧蛟蛱蠲街衿袈袷裥裾襟见觉觊觐角觖解謇警计讥讦记讲讵诀诘诫谏谨谫谲豇贱贾赆赍赳趄趼跏距跤践跻跽踞踺踽蹇蹶轿较辑近进迥迦迳迹遽郊郏郡鄄酒酱酵醮醵金鉴钅钜钧钾铗铰锏锔锦锩键锯镌镓镜镢间阄阱阶际降隽集雎霁靓靖静靳鞠鞫鞯韭颈颉颊飓饥饯饺馑驹驾骄骏骥骱髻鬏鲒鲚鲛鲣鲫鲸鸠鸡鹃鹣鹪鹫麂麇齑龃|K亏亢伉佧侃侉侩倥克况凯刊刳刻剀勘匡匮卡口叩可吭咔咖咳哐哙哭啃喀喟喹喾嗑困圹坎坑块坤坷垦垮垲堀堪壳夔夸夼奎孔客宽寇尻岢岿崆库康廓开快忾恐恪恳恺悃悝愦愧慨慷戡扛扣扩抗抠括拷挎捆控揆揩旷昆暌枯柯栲框棵楷槛款氪渴溃溘炕烤犒狂狯珂琨疴盔看眍眶睽瞌瞰矿砍磕科稞空窟窠窥筐筘筷箜篑糠纩绔缂考聩肯胩胯脍芤苛苦莰葵蒈蒉蒯蔻蛞蝌蝰裉裤诓诳课贶跨跬轲逵邝郐酷醌钪钶铐铠铿锎锞锟锴闶阃阔隗靠颏颗馈馗骒骷髁髋髡魁鲲龈龛|L两临丽乐乱了亮仂仑令伦伶佬例侣俐俚俩俪倮偻傈僚儡六兰冷冽凉凌凛列刘利剌力劣励劳勒卢卤卵历厉厘另叻吏吕吝呖呤咙咧哩唠唳啉啦啷喇喱喽嘞嘹噜囵囹坜垃垄垅垆垒埒塄墚奁姥娄娈娌婪嫘嫠孪寥寮尥屡履岚岭峦崂崃嵝嶙帘庐廉廊廖廪录律徕怜恋愣懒懔戮戾抡拉拎拢拦挛捋捞捩掠掳揽搂摞撂撩撸擂敛斓料旅旒旯晾朗李来林枥柃柳栊栌栎栏栗栳栾梁梨棂棱椋椤楝楞楼榄榈榔榴橹檑檩殓氇氯沥沦泐泠泪泷泸泺洌洛流浏浪涝涞涟淋渌溜溧滤滥滦漉漏漓漤漯潋潞潦澜澧濂濑灵炉炼烂烈烙熘燎牢犁狸狼猁猎猡獠率玲珑珞琅理琉琏琳璃璐瓴留略疗疠疬痢痨瘌瘘瘤瘰癃癞睐瞵砬砺砻砾硫碌磊磷礼禄离稂稆窿立笠笼箩篓篥篮篱簏籁类粒粝粮粱粼累纶练络绫绺绿缆缕缡缧缭罗罱罹羚羸翎老耒耢耧聆聊聋联肋胧胪脔脶脸腊膂膦臁舻良芦苈苓茏荔荦莅莉莨莱莲菱萝落蒌蒗蓝蓠蓼蔹蔺蕾藜虏虑蛉蛎蜊蜡蝼螂螺蠃蠊蠡裂裢裣裸褛褴览詈论诔谅谰赁赂赉赖趔跞路踉躏躐轮轳轹辂辆辘辚辣辽连逦逯逻遛遴邋邻郎郦酃酪酹醪醴里量銮鎏钌铃铑铝铹铼链锂锊锍锒锣镂镏镙镣镥镧镭镰闾阆阑陆陇陋陵隆隶雒雳零雷霖露颅领馏驴骆骊骝骡髅鬣魉鲁鲈鲡鲢鲤鲮鳓鳞鳢鸬鸾鹂鹨鹩鹭鹿麓麟黎黧龄龙|M么乜买亩仫们侔免冒冕冖冥劢勉勐募卖卯名吗命咩咪哞唛喵嘛嘧坶埋墁墓墨妈妙妹姆娩媒媚嫫嬷孟宀宓密寐寞岷峁嵋帽幂幔幕庙弥弭忙悯愍慕慢懋懑懵扪抹抿拇描摩摸摹敉敏旄明昧昴暝暮曼朦木末杩杪枚某梅梦棉楣模檬殁母每毛毪民氓汨沐沔没沫泌泖泯浼淼渑渺湄湎溟满漠漫漭灭焖煤熳牟牡牦牧犸猕猛猫猸玛玫珉瑁甍瘼皿盟目盲眄眇眉眠眯眸睦瞀瞄瞑瞒瞢矛码硭磨礞祢秒秘秣穆篾米糜糸縻绵缅缈缗缦缪美耄耱脉脒腼膜艋艨芈芒苗苜苠茂茅茆茉茗茫荬莓莫莽萌蒙蓦蔑蔓藐蘑蘼虻蚂蛑蛮蜜蜢蝥螟螨蟆蟊蟒蠓蠛袂袤觅谋谜谟谧谩谬貊貌貘贸迈迷邈邙酩酶醚鍪钔钼铆铭锚锰镁镅镆镘门闵闷闽陌霉霾靡面鞔颟馍馒马骂髦魅魔鳗鳘鸣鹋鹛麋麦麻麽默黾|N乃伲佞你侬倪傩内农凝努匿南呐呢呶咛哝哪啮喃喏嗫嗯囊囔囡坭垴埝奈女奴奶妞妮娘娜嫩嬲孥孬孽宁尼尿年廿弄弩念忸怒怩恁恧恼您懦扭拈拟拧拿挠挪捏捺捻搦撵攮旎昵暖曩柠柰楠氖泞泥浓涅淖溺牛狃狞猊猱瑙甯男疒疟睨硇碾糯纳纽耐耨聂聍肭胬能脑脓脲腩腻臬艿茑萘蔫蘖虐蛲蝻衄衲袅讷诺赧蹑辇辗逆那酿钕钠钮铌铙锘镊镍镎闹陧难霓颞馁馕驽鲇鲵鲶鸟黏鼐|O偶呕哦喔噢怄欧殴沤瓯耦藕讴鸥|P丕丿乒乓仆仳佩俜俳偏僻凭判刨剖剽劈匍匏匹叛叵呸咆品哌啤啪喷嘌嘭噗噼圃圮坡坪坯埔埤培堋姘娉婆媲嫔嫖屁屏帔帕平庀庖庞彭彷徘怕怦扑批抛抨披拍拚拼捧掊排撇擗攀攴攵旁旆普曝朋朴杷枇枰棚榀殍毗氆氕沛泊泡泮泼派浦淠湃湓溥滂漂潘澎濮瀑炮烹爬爿片牌牝犏狍珀琵琶璞瓢瓶甓畔疋疱疲痞癖皤皮盆盘盼睥瞟瞥砒砰破硼碰磐票笸筢篇篷粕纰缥罴翩耪聘胖胚胼脬脯脾膨芘苤苹莆菩萍葡葩蒎蒲蓬蚍蜱螃螵蟛蟠袍袢裒裴襻譬评谝谱貔贫赔趴跑蹁蹒蹼辔辟迫逄邳郫鄱配醅钋钷铍铺锫镤镨陪陴霈霹颇频颦飘骈骗魄鲆鹏鼙|Q七且丘丬乔乞乾亓亲仟企佥侨侵俅俏俟倩倾全其凄凵切券前劁劝劬勤区千却卿去取吣启呛嗪嘁噙器囚圈圊圻堑墙奇契妻妾娶嫱寝屈屺岂岍岐岖峭崎嵌巧巯庆弃强怯恰悄悛悫悭情惬愀愆慊憔憩戕戗戚扦抢拳挈掐掮揿搴撬擎擒敲旗晴曲朐期权杞枪柒栖桤桥棋椠楸榷槭樯樵橇檎檠欠欺歉歧氍气氢氰求汔汽沁沏泅泉泣洽浅淇清渠溱漆潜炝牵犬犭犰球琦琪琴琼璩畎畦痊瘸癯瞧瞿砌硗确碛磬磲祁祈祛祺禽秋秦穷穹窃窍筇筌签箐箝箧糗綦綮绮绻缱缲缺罄羌羟群翘耆肷脐腔芊芎芑芡芩芪芹苘茕茜荃荞萁萋葜葺蔷蕖蕲蘧虔虬蚯蛆蛐蛩蛴蜞蜣蜷蜻蝤螓蠼衢衾裘裙褰襁觑謦讫诎诠诮请谦谯谴赇起趋趣跄跫跷蹊躯轻辁迁迄逑逡遒遣邛邱郄酋醛銎钎钤钦钱钳铅铨锓锖锲锵锹镪阒阕阙阡雀青鞒鞘顷颀颧驱骐骑骞髂鬈鲭鳅鳍鸲鹊麒麴黔黢黥鼽齐龋|R乳人亻仁仍仞任偌儒入冉冗刃嚅嚷壤壬如妊娆孺容嵘弱忍惹戎扔扰揉攘日朊枘染柔桡榕汝洳润溶溽濡热然熔燃狨瑞瓤睿禳稔穰箬糅纫绒绕缛肉肜芮苒若茸茹荏荛荣葚蓉蓐蕊蕤薷蚋蚺蝾融蠕衽褥襦认让蹂轫软辱铷锐闰阮鞣韧颥饪饶髯|S三上世丝丧书事什仕仨伞伤伸似佘使侍俗倏傻僧僳兕兽凇删刷刹剡剩劭势勺匙十卅升厍厦厮厶叁双叔受叟史司吮呻咝哂哨唆唢售唰唼商啥啬善嗉嗍嗓嗖嗜嗣嗦嗽嗾嘶噬噻四圣垧埏埘埽塑塞塾墅墒士声夙失奢妁始姒姗姝娑娠婶嫂嬗孀孙孰守宋实审室宿寺寿射少尚尸屎属山岁崧嵊嵩巳市帅师庶式弑彡忪怂思恃恕悚愫慎慑戍所扇手扌扫抒拭拴拾挲捎损授搔搜搠搡摄摅摔撒撕擅擞收散数斯施时是晌晒暑曙朔术杀杉束松枢柿树栓桑桫梢梭梳森椹榫槊歃歙死殇殊殳毵毹氏水氵汕汜沈沙沭泗洒涉涑涩涮淑淞深渖渗湿溯溲滠漱潲潸澌澍濉炻烁烧煞煽熟熵燧爽牲狩狮狲狻猞珊琐瑟甚生甥甩申畲疏疝痧瘙瘦盛省眚眭睃睡睢瞍瞬矢矧石砂砷硕碎磉示礻社祀神祟私秫稍税稣穑穗竖竦笋笙笥筛筮筲算簌粟糁素索纟纱纾绅绍绥绱绳绶缌缩缫缮署羧耍耜耸肃肆肾胂胜脎腧腮膳膻臊舌舍舐舒舜舢艄艏艘色芍芟苏苕苫荪荽莎莘莳菘菽萨蒜蒴蓍蓑蔌蔬薮薯虱虽蚀蛇蛳蛸蜀蜃螋螫蟀蟮衫衰裟裳视觞觫誓讪讼设识诉试诗诜说诵谁谂谇谡谥豉豕贳赊赎赏赛赡赦跚身轼输述送适逝速遂邃邵鄯酥酸酾释钐铄铈铩铯锁锶锼闩闪陕隋随隧隼霎霜韶顺颂颡飒飕食飧饣饰饲馊馓首驶驷骚骟髓鲥鲨鲺鳃鳋鳝鸶麝黍鼠|T乇亠亭他仝体佗佟佻倘倜停偷傥僮兔凸剃剔厅台叹同吐吞听唐唾啕啼嗵嚏团图土坍坛坦坨堂堍塌塔塘填天太头套她妥婷它屉屠屯帑帖庭庹廷彖彤徒忐忑忒忝态恬恸悌惕慝托投抟抬拓拖挑挞挺捅掏探推掭提搪摊昙暾替条柝桃桐桶梃梯棠椭榻樘橐檀殄毯氽汀汤汰沱沲泰洮涂涕涛淌淘添湍溏溻滔滕滩潭潼炭炱烃烫煺特獭瑭甜田町畋疃疼痛痰瘫眺瞳砣砼碳祧秃突窕童笤筒箨粜糖统绦绨缇羰耥肽胎脱腆腾腿膛臀舔艇苔茼荑荼莛菟萄萜葶薹藤蜓蜕蜩螗螳袒裼褪覃誊讨谈谭豚贪贴趟趿跆跎跳踏踢蹄蹋躺迢退逃透途逖通遢邰郯酞酡酮酴醍醣钍钛钭钽铁铊铜铴铽锑锬镗闼阗陀陶霆韬颓题餮饕饧饨驮驼骰髫鲐鲦鳎鸵鹈鼍鼗龆|W万丸为乌五亡仵伍伟伪位佤侮倭偎兀刎剜务勿午卧卫危吴吻吾呒呜味哇唔唯喂嗡囗围圩圬坞外妄妩委威娃娓娲婉婺完宛寤尉尾屋崴嵬巍巫帏帷幄庑弯往微忘忤怃悟惋惘惟慰戊我挖挝挽捂握文斡无旺晚晤望未杌枉桅梧武歪毋污汪汶沃沩洧洼浯涠涡渥温渭湾潍炜烷焐煨物牾猥猬王玟玩玮琬璺瓦瓮畏畹痦痿瘟皖硪碗稳窝紊纨纬纹维绾网罔翁肟胃脘腕腽舞艉芄芜芴苇莴菀萎葳蓊蔚蕹薇蚊蛙蜈蜗蜿袜诬误诿谓豌軎辋迕违逶邬鋈钨问闱闻阌阢隈雯雾韦韪顽骛魍魏鲔鹉鹜鼯龌|X下习乡些享亵仙休侠信修偕像僖儇兄先兮兴写冼凶刑削勋勖勰匈匣协卸厢县叙吁向吓吸咸咻响哓哮唏啸喜喧嗅嘘嘻嚣囟型埙墟夏夕奚姓娴婿媳嫌嬉孝学宣宪宵寻小屑屣岘岫峋峡崤巡巷巽希席幸序庠庥廨弦形徇徐徙循心忄忻性恂恤息悉悬悻惜想惺懈戌戏挟掀揎携撷擤效斜新旋旬旭昔昕星显晓晰暄暇暹曛曦朽杏析枭枵柙校栩械楔楦榍榭樨橡檄欣欷歆歇殉氙汐汛汹泄泫泶泻洗洫洵浔浠消涎淅淆渫渲湘溆溪溴漩潇瀣炫烯煊煦熄熊熏熙熹燮燹牺犀狎狭猃猩献獬獯玄现玺瑕璇痃痫癣皙盱相眩瞎矽硎硒硖硝碹祆祥禊禧秀稀穴穸窨笑筅筱箫箱籼粞糈系絮纤线绁细绚绡绣绪续缃缬罅羞羡羲翔翕肖胁胥胸腥腺膝舄舷舾芗芯苋荀荇荥荨莶菥萧萱葙葸蓄蓰蓿蕈薛薤薪薰藓虚虾蚬蜥蝎螅蟋蟓蟹血衅行衔袖袭襄西觋训讯许询详诩谐谑谖谢象貅贤跣跹踅躞轩辖辛迅选逊逍遐邂邢邪郗酗酰醑醒醯醺鑫铉铣销锈锌锡锨镟镶闲阋陉限险陷隙隰雄雪需霄霞霰靴鞋项须顼飨饩饷馅馐香馨驯骁骧髹魈鲜鲞鲟鳕鸺鹇黠鼷|Y一与业严丫义乙也予于云亚亦亿以仪仰伊优伛伢佑余佚佣佯佾侑依俑俞俣俨倚偃允元兖养冤冶刈刖劓勇匀医卣印压厌原厣又友右叶吆吖吟吲呀呓员呦咏咦咬咽咿哑哟唁唷喁喑喻嘤噎噫因园囿圄圆圉圯垠垣垭垸域埸堙堰塬墉壅壹夜夤夭央夷奄奕妍妖妤妪姚姨姻娅娱婴媛媵嫣嬴孕宇宜宥宴寅寓尢尤尧尹屹屿岈岩岳峄峪崖崦崾嵛嶷已幺幼幽应庸庾廴延异弈弋引彝彦影役徉御徭忆忧怏怡怨怿恙恹恽恿悒悠悦愈愉意愚愠愿慵懿扬抑押拥挹掖掩掾揄揖揠援揶摇撄攸於旖昀易映昱晏晔晕曜曰曳月有杨杳柚样桠椅椰楹榆樱樾橼檐欤欲欹殃殒殪殷毅毓氤氧氩氲永沂沅油沿泱泳洇洋浴涌涯液淤淫淹渊渔渝游湮源溢滟滢演漪漾潆瀛瀹炀炎烊烟烨焉焰焱煜熠熨燕燠爰爷爻牖牙犹狁狱狳狺猗猷猿玉珧琊琰瑗瑛瑜瑶璎用甬由疑疡疣疫痈痍痒痖瘀瘐瘗瘾瘿癔盂盈益盐眙眢眼睚矣砑研砚硬禹禺秧移窈窑窬窳竽筠筵箢粤繇纡约纭绎缘缢缨罂罨羊羽羿翊翌翳翼耀耘耶聿肀肄育肴胤胭胰腋腌腰腴膺臃臆臾舀舁舆舣艳艺芋芫芸芽苑苡英茔茚茵荧荫药莜莠莸莹莺菸萤营萦萸蓣蓥蕴薏虞蚁蚓蚜蚰蚴蛘蛹蜒蜮蜴蝇蝓蝣螈衍衙衣衤袁裔裕要觎言誉讠议讶译诒诣语诱谀谊谒谕谚谣谳豫贻赝赢越跃踊轧轶轺辕迂迎运迓远迤逸逾遇遗遥邀邑邕邮邺郁郓郢郧郾鄞鄢酉酏酝酽釉野钇钥钰钺铀铕铘铟铱银镒镛镱闫阅阈阉阎阳阴院陨隅隐雁雅雍雨雩霪靥鞅韫音韵页预颍颐颖颜餍饔饫饮饴馀驭驿验鬻魇鱼鱿鳐鳙鸢鸦鸭鸯鸳鹆鹞鹦鹬鹰黝黟鼋鼬鼹龉龠|Z丈专中丶主之乍争仄仉仔仗仲众伫住佐作侄侏侦俎倬债值做偬兆兹再冢准凿则制助匝卒卓占卮只召吒吱周咂咋咒咤咨咫咱哉哲哳唑唣啁啄啧啭喳嘱嘴噪在圳址坐坠埴增壮夂奏奘妆妯姊姿嫜子字孜孳宅宗宙宰寨尊展峙峥崭崽嵫嶂州左帐帙帚帜帧帻幛庄座张彘彰征徵志忠忮怍怎怔总恣惴憎战扎执找抓折拄拙招择拯拶拽指挚挣振捉掌掷揍揸搌摘摭摺撙撞撰擢攒攥支政整斋斟斩斫旃族旨早昃昝昨昭昼智暂最朕札朱杂杖杼枕枝枣枳柘柞柱栀栅栈栉株栽桌桎桢桩梓棕棹植楂楱榛榨槠樟樽橥止正殖毡汁治沼沾注泽洙洲浈浊浙浞涨涿淄渍渚渣湛滋滓滞漳潴澡濯灶灼灾炙炷炸烛照煮燥爪状狰猪獐珍珠琢璋瓒甄甑甾畛疰疹痄症痔痣瘃瘴瘵皂皱盅盏直真眦眨着睁瞩瞻知砖砟砦砧砸磔祉祖祗祚祝祯禚种租秩秭稚稹窀窄窒站章竹竺笊笫笮筑筝箦箴箸篆簪籀籽粘粢粥粽糌糟紫絷纂纣纵纸组织终绉综绽缀缁缒缜缯缵罩罪置罾翥者耔职肇肘肢肫肿胀胄胗胙胝脂脏腙膣臧自至致臻舟舯舳舴芝芷苎茁茱荮著葬蒸蓁蔗蕞藻蘸蚤蚱蛀蛛蛭蛰蜇蜘螽蟑衷装褶觜觯訾詹证诅诈诊诌诏诛诤诸诹诼谆谘谪谮谵豸贞责账质贮贼贽赀赃资赈赘赚赜赞赠赭走赵趑趱足趾跖踪踬踯踵躁躅躜转轴轵轸载轾辄辎辙这迮追逐造遭遮遵邹邾郅郑鄣鄹酌酎酯醉重錾针钊钟钲钻铡铢铮铸锃锗锥锱锺镇镞镯长闸阵阻阼陟陬障隹雉震颛馔驵驺驻骓骘骤髭鬃鲰鲻鳟鸩鸷鹧麈黹齄龇';
  let PY_MAP = null;
  function pyMap() {
    if (PY_MAP) return PY_MAP;
    PY_MAP = Object.create(null);
    PY_INIT_SRC.split('|').forEach(seg => {
      if (!seg) return;
      const L = seg[0];
      for (let i = 1; i < seg.length; i++) PY_MAP[seg[i]] = L;
    });
    return PY_MAP;
  }
  function pyInitials(s) {
    const m = pyMap();
    let out = '';
    for (const ch of String(s || '')) {
      if (/[A-Za-z0-9]/.test(ch)) { out += ch.toUpperCase(); continue; }
      const L = m[ch];
      if (L) out += L;
    }
    return out;
  }

  /* ---------------- v274：搜索建议双源（全市场 ETF：国内/香港/海外杠杆反向） ----------------
   * ① 腾讯 smartbox.gtimg.cn：美股/港股/沪深 ETF 的代码与拼音搜索。
   *    实测 TQQQ / SOXL / 03036(港股ETF) / 510300 全部命中，不校验 token。
   *    无 CORS（fetch 不可用）但返回 v_hint="..." 全局赋值，script 标签直连即可。
   *    旧 searchapi.eastmoney.com 虽 curl 可用，但页面内 script 加载零响应
   *    （SCRIPT ERROR、无 HTTP 响应，疑似 CDN 对浏览器环境拒连），实测弃用。
   * ② 沪深 ETF 名录：push2 clist fs=b:MK0021~24（total=1660，实测）按成交额
   *    取前 300，支持中文名搜索（smartbox 不支持中文）；60 分钟缓存。
   * 返回 QuoteID 直接当 secid（synthSecid 原样收下），QuoteHub 实时报价。 */
  let _sugSeq = 0;
  function smartboxSug(q, cb) {
    const sc = d.createElement('script');
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      try { delete w.v_hint; } catch (e) { w.v_hint = undefined; }
      if (sc.parentNode) sc.parentNode.removeChild(sc);
    };
    const timer = setTimeout(() => { cleanup(); cb(null); }, 6000);
    sc.onload = () => {
      clearTimeout(timer);
      const h = w.v_hint;
      cleanup();
      cb(typeof h === 'string' ? h : null);
    };
    sc.onerror = () => { clearTimeout(timer); cleanup(); cb(null); };
    sc.src = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q)
      + '&t=all&r=' + Math.random().toString(36).slice(2);
    d.head.appendChild(sc);
  }
  /* 腾讯 v_hint 格式：条目用 ^ 分隔，字段用 ~ 分隔：
   *   us~tqqq.oq~三倍做多纳斯达克100etf~拼音~GP  → 105.TQQQ
   *   hk~03036~tr台湾~...                        → 116.03036
   *   sh~510300~沪深300ETF华泰柏瑞~...~ETF       → 1.510300
   * 美股后缀：.oq=纳斯达克→105，.n=纽交所→106，.am/.p=美交所→107 */
  function parseBox(h) {
    if (!h || h === 'N') return [];
    const out = [];
    h.split('^').forEach(seg => {
      const f = seg.split('~');
      if (f.length < 3) return;
      const mkt = f[0], raw = f[1], nm = String(f[2] || raw);
      let secid = null, type = 'ETF';
      const code = String(raw).split('.')[0].toUpperCase();
      if (mkt === 'us') {
        const suf = (String(raw).split('.')[1] || '').toLowerCase();
        const emm = suf === 'oq' ? 105 : (suf === 'n' ? 106 : 107);
        secid = emm + '.' + code; type = '美股ETF';
      } else if (mkt === 'hk') {
        secid = '116.' + String(raw); type = '港股ETF';
      } else if (mkt === 'sh') {
        secid = '1.' + code; type = f[4] === 'ETF' ? '基金' : '沪A';
      } else if (mkt === 'sz') {
        secid = '0.' + code; type = f[4] === 'ETF' ? '基金' : '深A';
      }
      if (secid && code) out.push({ secid, code, name: nm, type });
    });
    return out;
  }
  /* 沪深 ETF 名录（中文名搜索用）。按成交额降序 top300，60 分钟缓存。 */
  let _etfCN = null, _etfCNAt = 0;
  function etfCNSug(q, cb) {
    const done = (rows) => {
      const t = q.trim().toLowerCase();
      cb(!t ? [] : (_etfCN || []).filter(x =>
        x.name.toLowerCase().indexOf(t) >= 0 || x.code.indexOf(t) >= 0).slice(0, 8));
    };
    if (_etfCN && Date.now() - _etfCNAt < 3600e3) { done(); return; }
    const pages = [1, 2, 3];
    const rows = [];
    let left = pages.length;
    pages.forEach(pn => {
      /* getJSON 在 api.js 闭包内不可达，push2 有 CORS 直接 fetch */
      fetch('https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn
        + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6'
        + '&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024'
        + '&fields=f12,f13,f14&ut=fa5fd1943c7b386f172d6893dbfba10b&_=' + Date.now(), { cache: 'no-store' })
        .then(r => r.json())
        .then(d => {
          ((d && d.data && d.data.diff) || []).forEach(r => {
            if (!r.f12) return;
            rows.push({ code: String(r.f12), name: String(r.f14 || ''),
                        secid: (r.f13 === 1 ? '1.' : '0.') + r.f12 });
          });
        })
        .catch(() => {})
        .finally(() => {
          if (--left) return;
          if (rows.length) { _etfCN = rows; _etfCNAt = Date.now(); }
          done();
        });
    });
  }
  function sugList(q, cb) {
    let box = null, cn = null, fin = false;
    const merge = () => {
      const seen = Object.create(null), out = [];
      (cn || []).concat(box || []).forEach(x => {
        if (!x || !x.secid || x.secid.indexOf('.') < 0 || seen[x.code]) return;
        seen[x.code] = 1; out.push(x);
      });
      cb(out);
    };
    const done = () => { if (fin) return; fin = true; merge(); };
    setTimeout(done, 4500);
    smartboxSug(q, h => { box = parseBox(h); done(); });
    etfCNSug(q, rows => { cn = rows; done(); });
  }

  /* ---------------- v273：浮窗盯盘（安卓系统悬浮窗） ----------------
   * 配置存 localStorage 并同步给原生（NativePulse.setFloatWatch）；
   * 原生 FloatWatchService 负责气泡/展开面板/轮询/全屏隐藏。 */
  function floatData() {
    const d = store.get('mm_float_watch', null);
    return (d && typeof d === 'object')
      ? { on: !!d.on, stocks: Array.isArray(d.stocks) ? d.stocks.slice(0, 5) : [] }
      : { on: false, stocks: [] };
  }
  function floatApply(d) {
    store.set('mm_float_watch', d);
    try {
      const np = w.NativePulse;
      if (np && np.setFloatWatch) np.setFloatWatch(d.on ? 1 : 0, JSON.stringify(d.stocks));
    } catch (e) { }
  }
  /* 浮窗相关 UI 的统一点击委托（设置页每次重绘都重新生成 DOM，委托最稳） */
  d.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#swFloat')) {
      const np = w.NativePulse;
      if (!np || !np.setFloatWatch) { toast('浮窗盯盘仅安卓 APP 内可用'); return; }
      const dnow = floatData();
      if (dnow.on) { dnow.on = false; floatApply(dnow); renderSettings(); return; }
      if (np.floatCanDraw && !np.floatCanDraw()) {
        toast('请先授予「显示在其他应用上层」权限');
        try { np.openFloatPerm(); } catch (e2) { }
        return;
      }
      if (!dnow.stocks.length) { toast('先在下面添加盯盘股票'); return; }
      dnow.on = true; floatApply(dnow); renderSettings();
      return;
    }
    if (t.closest('#fwPerm')) { try { w.NativePulse.openFloatPerm(); } catch (e) { } return; }
    const del = t.closest('[data-fwdel]');
    if (del) {
      const dnow = floatData();
      dnow.stocks.splice(+del.dataset.fwdel, 1);
      floatApply(dnow); renderSettings();
      return;
    }
    if (t.closest('#fwAdd')) {
      const inp = $('#fwQ');
      const q = inp ? inp.value.trim() : '';
      if (!q) { toast('先输入代码或名称'); return; }
      const btn = t.closest('#fwAdd');
      btn.textContent = '搜索中';
      sugList(q, (rows) => {
        btn.textContent = '搜索';
        const host = $('#fwSug'); if (!host) return;
        host._rows = rows.slice(0, 6);
        host.innerHTML = host._rows.length
          ? host._rows.map((r, i) => `<div class="set-row"><div><b>${esc(r.name)}</b><span>${esc(r.code)} · ${esc(r.type || '')}</span></div><button class="mini-btn" data-fwpick="${i}">加入</button></div>`).join('')
          : '<div class="set-row"><div><span>没有匹配结果</span></div></div>';
      });
      return;
    }
    const pick = t.closest('[data-fwpick]');
    if (pick) {
      const host = t.closest('#fwSug');
      const rows = (host && host._rows) || [];
      const r = rows[+pick.dataset.fwpick];
      if (!r) return;
      const dnow = floatData();
      if (dnow.stocks.length >= 5) { toast('盯盘最多 5 只'); return; }
      if (dnow.stocks.some(x => x.code === r.code)) { toast('已在盯盘列表'); return; }
      try { U.synthSecid(r.secid, r.code, r.name); } catch (e) { }
      dnow.stocks.push({ secid: r.secid, code: r.code, name: r.name });
      floatApply(dnow); renderSettings();
      return;
    }
  });

  /* ---------------- 添加品种 ---------------- */
  function openPicker() {
    const box = $('#picker');
    const groups = {};
    U.keys().forEach(k => {
      const g = U.get(k).grp;
      (groups[g] = groups[g] || []).push(k);
    });
    const order = groupOrder().filter(g => groups[g]);
    const renderList = (kw) => {
      const q = (kw || '').trim().toLowerCase();
      const hit = (k) => {
        if (!q) return true;
        const a = U.get(k);
        if (k.toLowerCase().indexOf(q) >= 0
          || (a.name || '').toLowerCase().indexOf(q) >= 0
          || (a.short || '').toLowerCase().indexOf(q) >= 0
          || (a.secid || '').toLowerCase().indexOf(q) >= 0
          || (a.tv || '').toLowerCase().indexOf(q) >= 0) return true;
        /* v150：首字母搜索 —— 输入 zjxc 命中「中际旭创」。
         * 只在查询本身是纯字母时才走这条，中文查询交给上面的字面匹配。 */
        if (!/^[a-z]+$/.test(q)) return false;
        const up = q.toUpperCase();
        return pyInitials(a.name || '').indexOf(up) >= 0
          || pyInitials(a.short || '').indexOf(up) >= 0;
      };
      const body = box.querySelector('.pk-body');
      /* v150：全市场名录动态搜索 —— 「中际旭创」这类不在精选表里的票，
       * 之前不管输中文、代码还是首字母都搜不到（图一「没找到匹配品种」）。
       * 这里直接从 CN_STOCKS(5927) + GLOBAL_STOCKS(12721) 里搜，
       * 命中后现场合成进 ASSETS，点「＋」即可加入自选。 */
      const dynHTML = () => {
        if (!q) return '';
        const limit = 12;
        const found = [], seen = Object.create(null);
        const up = /^[a-z]+$/.test(q) ? q.toUpperCase() : '';
        const push = (code, nm) => {
          /* v59：原来这里用 `U.get(code)` 去重 —— 那是「懒合成」：
           * 只要代码在 GLOBAL_STOCKS 名录里就返回对象，于是**只有懒合成失败的**才能进列表。
           * 实测后果：搜「海力士」只出韩股 000660（synthCN 对它返回 null），
           * 美股 SKHY（synthGlobal 成功 → truthy）被静默跳过，中文名和 SKHY 缩写都搜不到。
           * 现在只跳过「已在自选里」的（上面精选区已经显示过），其余一律进全市场匹配。 */
          if (found.length >= limit || seen[code] || S.watch.indexOf(String(code)) >= 0) return;
          seen[code] = 1;
          found.push({ code: String(code), nm: String(nm || code) });
        };
        const CN = w.CN_STOCKS || {};
        const G = w.GLOBAL_STOCKS || {};
        /* v61：首字母改成「前缀优先、包含兜底」两档。
         * 原来用 indexOf 判首字母，输入 sk 会把「网宿科技(WSKJ)」「当升科技(DSKJ)」
         * 这类中间命中全捞上来，把真正以 SK 开头的挤到后面。
         * 现在先收「代码/中文名包含」与「首字母以 SK 开头」的强匹配，
         * 强匹配不够 12 条才用「首字母中间包含」补位。 */
        const strongM = [], weakM = [];
        const consider = (code, nm) => {
          const c6 = String(code), n = String(nm || '');
          if (!c6) return;
          if (c6.toLowerCase().indexOf(q) >= 0 || n.toLowerCase().indexOf(q) >= 0) { strongM.push([c6, n]); return; }
          if (!up) return;
          const py = pyInitials(n);
          if (py.indexOf(up) < 0) return;
          (py.indexOf(up) === 0 ? strongM : weakM).push([c6, n]);
        };
        for (const c in CN) consider(c, CN[c]);
        for (const c in G) consider(c, (G[c] || [])[0]);
        strongM.concat(weakM).forEach(([c, n]) => push(c, n));
        if (!found.length && /^[1-9]\d{3}$/.test(q)) {
          /* 台股 4 位代码不在中/港/美名录里（名录只有 6 位 A 股与字母美股），
           * 直接按代码收一条 —— 加进来后首次拉分钟线会用 Yahoo 的
           * shortName 把名称回填成「鸿海」这类真名（见 api.js intraday）。 */
          push(q, q);
        }
        /* v273：远程建议（ETF/基金/美股杠杆，含正两倍负两倍这类杠杆产品）。
         * 渲染前先 synthSecid 预写进 ASSETS，点「＋」时现有委托直接能加。 */
        const sug = (S._pkSug || []).filter(x =>
          x && !seen[x.code] && S.watch.indexOf(String(x.code)) < 0);
        const sugHTML = sug.map(x => {
          try { U.synthSecid(x.secid, x.code, x.name); } catch (e) { }
          return `<button class="pk-i" data-k="${esc(x.code)}">
            <span>${esc(x.name)}<em>${esc(x.code)} · ${esc(x.type || 'ETF')}</em></span><i>＋</i>
          </button>`;
        }).join('');
        const items = found.map(f => {
          /* 6 位纯数字走 A 股合成（沪深按首位判）；4 位交给 universe 判台股/日股
           * （v64：4 位代码台日撞车，之前直接 synthGlobal 会让日码搜不到也加不进）；
           * 其余走港股/美股合成。 */
          const a = /^\d{6}$/.test(f.code) ? U.synthCN(f.code)
            : (/^\d{4}$/.test(f.code) ? U.get(f.code) : U.synthGlobal(f.code));
          if (!a) return '';
          const on = S.watch.indexOf(f.code) >= 0;
          return `<button class="pk-i ${on ? 'on' : ''}" data-k="${esc(f.code)}">
            <span>${esc(f.nm)}<em>${esc(f.code)}</em></span><i>${on ? '已添加' : '＋'}</i>
          </button>`;
        }).join('');
        const main = items ? `<div class="pk-g"><div class="pk-gh" style="color:#8b95a6">全市场匹配</div>${items}</div>` : '';
        const sugBlock = sugHTML ? `<div class="pk-g"><div class="pk-gh" style="color:#ffd43b">ETF / 全市场建议</div>${sugHTML}</div>` : '';
        if (!main && !sugBlock) return '';
        return sugBlock + main;
      };
      const dyn = dynHTML();
      const has = order.some(g => groups[g].some(hit));
      body.innerHTML = (dyn || has)
        ? dyn + (has ? order.map(g => {
          const list = groups[g].filter(hit);
          if (!list.length) return '';
          const meta = U.GROUPS[g] || { label: g, color: '#8b95a6' };
          return `<div class="pk-g"><div class="pk-gh" style="color:${meta.color}">${esc(meta.full || meta.label)}</div>
            ${list.map(k => `<button class="pk-i ${S.watch.indexOf(k) >= 0 ? 'on' : ''}" data-k="${esc(k)}">
              <span>${esc(U.get(k).kind === 'index' ? U.get(k).name : (U.get(k).short || U.get(k).name))}<em>${esc(k)}</em></span><i>${S.watch.indexOf(k) >= 0 ? '已添加' : '＋'}</i>
            </button>`).join('')}
          </div>`;
        }).join('') : '')
        : '<div class="empty"><b>没找到匹配品种</b><span>支持代码（000660 / 285A / 300308）、中文名（SK海力士 / 中际旭创）或首字母（zjxc）</span></div>';
    };
    box.innerHTML = `<div class="pk-panel">
      <div class="pk-h"><b>添加 / 移除品种</b><button class="pk-x">✕</button></div>
      <div class="pk-search"><input type="search" id="pkSearch" placeholder="输代码或名称搜索：SK海力士 / 铠侠 / 国巨 / 000660 / 285A…" autocomplete="off"></div>
      <div class="pk-body"></div>
    </div>`;
    box.classList.add('on');
    renderList('');
    /* 添加品种面板同样支持「点任意处关闭」。 */
    bindTapClose(box, '.pk-body', () => box.classList.remove('on'));
    box.querySelector('.pk-x').onclick = () => box.classList.remove('on');
    box.onclick = (e) => { if (e.target === box) box.classList.remove('on'); };
    /* v273：本地渲染 + 远程 suggest 双层。suggest 防抖 350ms，回来后重渲染，
     * 「ETF / 全市场建议」区块出现在「全市场匹配」上方。 */
    let sugT = 0, sugQ = '';
    box.querySelector('#pkSearch').addEventListener('input', (e) => {
      renderList(e.target.value);
      const q = (e.target.value || '').trim();
      clearTimeout(sugT);
      if (!q || /^\d{1,3}$/.test(q)) { S._pkSug = []; return; }
      sugT = setTimeout(() => {
        sugQ = q;
        sugList(q, (rows) => {
          if (sugQ !== q) return;
          S._pkSug = rows.slice(0, 8);
          const cur = box.querySelector('#pkSearch');
          if (cur) renderList(cur.value);
        });
      }, 350);
    });
    box.querySelector('.pk-body').addEventListener('click', (e) => {
      const b = e.target.closest('.pk-i');
      if (!b) return;
      const k = b.dataset.k;
      const i = S.watch.indexOf(k);
      if (i >= 0) S.watch.splice(i, 1); else S.watch.push(k);
      store.set('mm_watch2', S.watch);
      b.classList.toggle('on', S.watch.indexOf(k) >= 0);
      const it = b.querySelector('i');
      if (it) it.textContent = S.watch.indexOf(k) >= 0 ? '已添加' : '＋';
      renderMarket();
    });
  }

  /* ---------------- 设置 ---------------- */
  /* v135：按用户要求，桥接缺失时不再渲染任何诊断卡片（1.0 壳没有原生桥接，
   * 那张红卡会被当成「功能坏了」）。没有桥就整块不显示，回到 v127 的干净设置页。 */
  /** 头部「壳版本」徽标：网页来自线上、壳是本地安装的，两者版本独立。
   *  直接显示原生壳版本；旧壳(1.2.x 无 appVer 桥接)标红提示更新。 */
  function updateShellPill() {
    const el = document.getElementById('shellPill');
    if (!el) return;
    try {
      const np = w.NativePulse;
      if (!np) { el.textContent = '网页版'; el.className = 'shell-pill web'; el.title = '当前在浏览器 / PWA 中打开，不是 App 壳'; return; }
      if (typeof np.appVer === 'function') {
        const v = JSON.parse(np.appVer() || '{}');
        el.textContent = '壳 ' + (v.name || '?');
        el.className = 'shell-pill ok';
        el.title = '原生 App 壳版本 ' + (v.name || '?') + '（build ' + (v.code || 0) + '）';
        return;
      }
      el.textContent = '壳 1.2 需更新';
      el.className = 'shell-pill old';
      el.title = '检测到旧版 App 壳（无版本桥接），请安装 1.3.2';
    } catch (e) { el.textContent = '壳?'; el.className = 'shell-pill'; }
  }
  function renderSettings() {
    const st = w.API.status;
    /* v273：浮窗盯盘状态（仅安卓 APP 有原生桥；浏览器隐藏权限行、开关给提示） */
    const fw = floatData();
    const fwPerm = (w.NativePulse && w.NativePulse.floatCanDraw) ? !!w.NativePulse.floatCanDraw() : true;
    const badge = (v) => v === 'ok' ? '<span class="badge ok">在线</span>'
      : v === 'fail' ? '<span class="badge bad">异常</span>' : '<span class="badge">待连接</span>';

    $('#setBody').innerHTML = `
      <div class="set-card">
        <div class="set-row"><div><b>界面主题</b><span>深色适合盯盘，浅色适合白天与打印截图</span></div>
          <div class="thm-seg">
            <button data-thm="dark" class="${S.theme === 'dark' ? 'on' : ''}">深色</button>
            <button data-thm="light" class="${S.theme === 'light' ? 'on' : ''}">浅色</button>
          </div></div>
        <div class="set-row"><div><b>异动弹窗</b><span>右上角浮层提示，任何页面都能看到</span></div>
          <button class="sw ${S.toastOn ? 'on' : ''}" data-sw="toast"><i></i></button></div>
        <div class="set-row"><div><b>S 级全屏弹窗</b><span>关闭后仅保留声音、横幅与列表高亮</span></div>
          <button class="sw ${S.modalOn ? 'on' : ''}" data-sw="modal"><i></i></button></div>
      </div>

      <div class="set-card">
        <div class="set-card-h">通知与提醒</div>
        <div class="set-row"><div><b>预警通知</b><span>S 级快讯 / 异动 / 股价提醒的系统弹窗，可独立开关</span></div>
          <button class="sw ${S.notify ? 'on' : ''}" data-sw="notify"><i></i></button></div>
        <div class="set-row"><div><b>S 级快讯</b><span>黑天鹅警报的声音 / 震动</span></div>
          <div class="ap-pair">
            <span class="ap-it"><i>声音</i><button class="sw sm ${alertPrefs('s').sound ? 'on' : ''}" data-atype="s" data-ap="sound"><i></i></button></span>
            <span class="ap-it"><i>震动</i><button class="sw sm ${alertPrefs('s').vib ? 'on' : ''}" data-atype="s" data-ap="vib"><i></i></button></span>
          </div></div>
        <div class="set-row"><div><b>异动提醒</b><span>异动看板提醒的声音 / 震动</span></div>
          <div class="ap-pair">
            <span class="ap-it"><i>声音</i><button class="sw sm ${alertPrefs('anom').sound ? 'on' : ''}" data-atype="anom" data-ap="sound"><i></i></button></span>
            <span class="ap-it"><i>震动</i><button class="sw sm ${alertPrefs('anom').vib ? 'on' : ''}" data-atype="anom" data-ap="vib"><i></i></button></span>
          </div></div>
        <div class="set-row"><div><b>股价预警</b><span>自设预警触发的声音 / 震动</span></div>
          <div class="ap-pair">
            <span class="ap-it"><i>声音</i><button class="sw sm ${alertPrefs('price').sound ? 'on' : ''}" data-atype="price" data-ap="sound"><i></i></button></span>
            <span class="ap-it"><i>震动</i><button class="sw sm ${alertPrefs('price').vib ? 'on' : ''}" data-atype="price" data-ap="vib"><i></i></button></span>
          </div></div>
        <div class="set-row"><div><b>发送测试通知</b><span>按「S 级快讯」的声音/震动开关发一条模拟通知，即时检验效果</span></div>
          <button class="mini-btn" id="btnTestNotify">测试</button></div>
        <div class="set-row"><div><b>5 秒后测试后台通知</b><span>点完立刻切到后台或锁屏。5 秒后应响铃 + 震动 + 通知栏；计时在 APP 原生层，不受网页定时器冻结影响。没响＝后台进程被系统冻结，去「后台防杀」设为无限制</span></div>
          <button class="mini-btn" id="btnTestDelayed">5 秒</button></div>
        <div class="set-row"><div><b>后台防杀</b><span>跳转系统电池优化，把本 APP 设为「无限制」避免后台被清理</span></div>
          <button class="mini-btn" id="btnBattery">去设置</button></div>
      </div>

      <div class="set-card">
        <div class="set-card-h">浮窗盯盘（安卓）</div>
        <div class="set-row"><div><b>悬浮窗盯盘</b><span>桌面悬浮气泡显示盯盘股票涨跌，点气泡展开列表；APP 全屏时自动隐藏。需授予「显示在其他应用上层」权限</span></div>
          <button class="sw ${fw.on ? 'on' : ''}" id="swFloat"><i></i></button></div>
        ${(!fwPerm) ? `<div class="set-row"><div><b>悬浮窗权限</b><span>未授权时气泡不会显示</span></div>
          <button class="mini-btn" id="fwPerm">去授权</button></div>` : ''}
        <div class="set-row"><div><b>盯盘股票与展示时间</b><span>添加 / 删除 / 排序 / 交易时段都在<b>桌面浮窗</b>里：点开气泡，右上角 ⚙ 进入设置（v1.5.26 起）</span></div></div>
      </div>

      <div class="set-card">
        <div class="set-row"><div><b>只跑平台标红</b><span>只显示各平台自己筛过的稿子：财联社加红 / 见闻 score≥2 / 金十重要 / 东财标红 / 财联社深度精选。关掉即恢复全量；「全部」档始终是全量，方便回查被筛掉了什么</span></div>
          <button class="sw ${S.redOnly ? 'on' : ''}" data-sw="red"><i></i></button></div>
      </div>

      <div class="set-card">
        <div class="set-row"><div><b>标级纠错</b><span>长按任意快讯卡片 0.55 秒弹出改判面板：选 S / A / B / C，下面的输入框自己写一句原因（可留空）。改判立刻生效（排序、计数、筛选全部跟着变），并记入纠错单。</span></div>
          <em class="fix-n${fixStore.list.length ? ' on' : ''}">${fixStore.list.length} 条</em></div>
        <div class="set-row"><div><b>纠错单</b><span>${fixStore.list.length
          ? '攒够一批再点「复制」，一次性粘给 AI —— 它会按这批样本改规则、记台账、补回归用例。'
          : '还没有改判记录。遇到判错的长按卡片改一次，就会出现在这里；攒一批再一起复制。'}</span></div>
          <span class="fix-btns"><button class="mini-btn" id="fixCopy"${fixStore.list.length ? '' : ' disabled'}>复制修复指令</button></span></div>
        ${fixStore.list.length ? `<div class="set-row col"><div class="fix-prev">${fixStore.list.slice(0, 8).map(x =>
          `<div class="fix-prev-i"><b>${esc(x.to)}←${esc(x.from)}</b><span>${esc(String(x.title || '').slice(0, 44))}</span>`
          + `<i>${esc(x.reason || '未填原因')}</i></div>`
        ).join('')}${fixStore.list.length > 8 ? `<div class="fix-prev-i more">…另有 ${fixStore.list.length - 8} 条</div>` : ''}</div></div>` : ''}
        <div class="set-row"><div><b>清空纠错单</b><span>回传并写入规则之后再清，否则这批样本就丢了</span></div>
          <button class="mini-btn danger" id="fixClear"${fixStore.list.length ? '' : ' disabled'}>清空</button></div>
      </div>

      <div class="set-card">
        <div class="set-row"><div><b>异动矩阵展示</b><span>按大小：异动越大的方块越大、排得越靠前（默认）；按颜色：等大方块用底色深浅表达强度</span></div>
          <div class="thm-seg">
            <button data-mxm="size" class="${S.mxMode === 'size' ? 'on' : ''}">按大小</button>
            <button data-mxm="color" class="${S.mxMode === 'color' ? 'on' : ''}">按颜色</button>
          </div></div>
        <div class="set-row col">
          <div><b>监控池与实际阈值</b><span>阈值<b>按每个品种自己的波动率分六个时间尺度单独标定</b>：1 / 2 / 3 / 5 / 15 / 30 分钟窗口并联，任一越线即报警。<b>为什么最快的三档是 1~3 分钟</b>——闪崩和垂直拉升的真实时间常数就是几十秒到两三分钟，等 30 分钟窗口走完只能事后复述。5/15/30 分钟阈值由 TradingView 真实 5 分钟 K 线（A股 106 个交易日、其余 19~28 个）按「触发日占比」反解（5% / 4.5% / 4%）；1/2/3 分钟用近 5 个交易日真实 1 分钟数据量出「等稀有度比例」（r1=0.66 / r2=0.78 / r3=0.88 · t5），严格单调递增；分类下限 floor 对 1~3 分钟按自身标定等比缩放，不再垫高外汇等低波品种。<b>阈值会自己漂移</b>——页面每 20 秒把当日窗口极值写进本地波动率库，跨天累积后与静态标定值按样本量加权；样本 ≥15 日还会做「近 15 日 0.7 + 全量 0.3」双窗口融合，平静期收紧、高波日放宽（双向 ±15%），40 个交易日后以实盘分布为主（仍受标定值 0.6~2.0 倍夹紧，防脏数据打穿）。<b>重复提醒只认瞬时脉冲</b>——首次报警后：横盘磨洋工绝不重报（15/30 长窗残留、冷却到期、阶梯跨档都不例外）；反向短窗脉冲立即破锁，报「快速反弹 / 高台跳水」；同向再下一台阶（当日幅度比上次再扩大 1 个 5 分钟阈值，或距上次超 15 分钟后短窗独立再越线）立即升级，报「跌幅 / 涨幅已扩大至 X%」。当日累计幅度跨 1.0 / 1.8 / 2.6 / 3.5 倍当日阈值时逐档升级并豁免冷却。</span></div>
          <div class="pool-list">${U.RADAR.map(r => {
            const st = radar && radar.state && radar.state[r.k];
            const live = st ? st.thr : null;
            const src = st ? st.thrSrc : '';
            const dyn = src === 'adaptive' || src === 'blend';
            const winTxt = st ? (st.win || 5) + 'm' : '5m';
            return `<div class="pool-i"><span>${esc(U.name(r.k))}</span>
              <em title="1 分钟 / 5 分钟 / 30 分钟三档标定阈值">${r.t1.toFixed(2)}·${r.t5.toFixed(2)}·${r.t30.toFixed(2)}</em>
              <b class="${dyn ? 'dyn' : ''}" title="${dyn ? '动态阈值（已累积 ' + (st.thrScaleDays || 0) + ' 个交易日样本）· 当前生效尺度 ' + winTxt : '静态标定先验 · 当前生效尺度 ' + winTxt}">${live != null ? live.toFixed(2) + '%' : r.t5.toFixed(2) + '%'}</b>
              <i class="${(radar && radar.state[r.k] && (radar.state[r.k].status === 'unattributed')) ? 'hot' : ''}">${(radar && radar.state[r.k]) ? (ST_TEXT[radar.state[r.k].status] || '') : '--'}</i>
            </div>`;
          }).join('')}</div>
        </div>
        <div class="set-row"><div><b>立即自检</b><span>手动点亮一次「未归因异动」红灯，确认提醒链路通畅</span></div>
          <button class="mini-btn" id="demoAlarm">触发</button></div>
      </div>

      <div class="set-card">
        <div class="set-row"><div><b>东财行情</b><span>批量快照 · K线 · 分时</span></div>${badge(st.em)}</div>
        <div class="set-row"><div><b>VIX 恐慌指数</b><span>${st.cboe === 'ok'
          ? 'CBOE 官方 CDN · 延迟 15 分钟（指数本身即延迟报价）'
          : 'CBOE 官方 CDN（不开放跨域，浏览器版需代理通道；APK 版内置直取）'}</span></div>${badge(st.cboe)}</div>
        <div class="set-row"><div><b>加密行情</b><span>${st.binance === 'ok' && st.bnAlt ? '币安不可达，已自动切 OKX / 火币' : '币安多域名 + OKX / 火币兜底'}</span></div>${badge(st.binance)}</div>
        <div class="set-row"><div><b>链上价格</b><span>DexScreener 池子价 + Hyperliquid 暗盘（CEX 交叉校验）</span></div>${badge(
          (st.dex === 'ok' || st.hl === 'ok') ? 'ok' : (st.dex === 'fail' || st.hl === 'fail') ? 'fail' : 'unknown'
        )}</div>
        <div class="set-row col"><div><b>代理通道（跨境中转）</b><span>${(() => {
          const ph = w.LiveNews && typeof w.LiveNews.proxyHealth === 'function' ? w.LiveNews.proxyHealth() : [];
          if (!ph.length) return '未启用 —— 当前所有源都走直连';
          const live = ph.filter(x => !x.cooling).length;
          return `${live}/${ph.length} 个通道可用 · ` + ph.map(x =>
            `${x.id}${x.cooling ? '(冷却)' : x.ok ? '✓' : x.fail ? '✕' : '?'}`).join(' · ')
            + '。财联社 / KZG / 川普言论 这几个站没有 CORS 头，必须经中转；'
            + '国内网络下 r.jina.ai 常被墙，会自动改用其他镜像，全挂时这几个源标失败，不影响其余源。';
        })()}</span></div></div>
        <div class="set-row"><div><b>快讯源</b><span>${(() => {
          const det = srcDetailList();
          if (!det.length) return '未接入 —— 本终端不提供任何伪造新闻兜底，检查网络后自动恢复';
          const okN = det.filter(x => x.ok).length;
          return `${okN}/${det.length} 个源本轮可用 · ` + det.map(x => x.name).join(' · ');
        })()}</span></div>
          <span class="badge ${S.flashState === 'live' ? 'ok' : 'bad'}">${S.flashState === 'live' ? '实时' : '未接入'}</span></div>
        <div class="set-row"><div><b>博主源</b><span>${(() => {
          const det = srcDetailList().filter(x => /KZG|川普/.test(x.name));
          if (!det.length) return '口罩哥KZG（老虎社区）、川普社媒：尚未抓取';
          const okN = det.filter(x => x.ok).length;
          return '口罩哥KZG（老虎社区）、川普社媒（X/Truth Social 镜像）—— 只放行 S / A 级；'
            + (okN === det.length ? '本轮两个源都取到了。'
              : okN ? '本轮 ' + okN + '/' + det.length + ' 个可用，其余需中转通道（APK 版内置直取）。'
                : '两个源都需要中转通道：它们不开放跨域，浏览器版取不到，APK 版可直取。');
        })()}</span></div>
          <span class="badge ${(() => {
            const det = srcDetailList().filter(x => /KZG|川普/.test(x.name));
            if (!det.length) return '';
            const okN = det.filter(x => x.ok).length;
            return okN === det.length ? 'ok' : okN ? '' : 'bad';
          })()}">${(() => {
            const det = srcDetailList().filter(x => /KZG|川普/.test(x.name));
            if (!det.length) return '待抓取';
            const okN = det.filter(x => x.ok).length;
            return okN === det.length ? '已接入' : okN ? '部分可用' : '需中转';
          })()}</span></div>
        ${srcDetailList().length ? `<div class="set-row col">
          <div><b>逐源状态（本轮实抓）</b><span>✓ = 抓通并给出条数，✕ = 该源不可用并附原因。失败源下轮自动重试。</span>
          ${renderSrcList()}
          <span style="margin-top:6px">原始 ${S.liveStats.fetched} 条 → 入库 ${S.liveStats.kept} 条（S ${S.liveStats.s} / A ${S.liveStats.a} / B ${S.liveStats.b || 0}），丢弃 ${S.liveStats.filtered} 条</span></div>
        </div>` : ''}
      </div>

      <div class="set-card">
        <div class="set-row"><div><b>清空本地偏好</b><span>行情自选、阈值、提醒开关全部恢复默认</span></div>
          <button class="mini-btn danger" id="resetAll">重置</button></div>
        <div class="set-row col"><div><b>口径说明</b>
          <span>行情为真实数据（东财 / 腾讯 / 新浪 / CNBC / 币安），非交易时段显示最后成交价并标注「休市」，加密另给链上池子价。快讯由金十 / 华尔街见闻 / 财联社 / 财联社深度 / 格隆汇 / 同花顺 / 东方财富 / 新浪 / 口罩哥KZG / 川普言论 十源聚合，跨源去重后统一分级打标；全部使用源站真实时间戳，抓不到的源直接标失败，不用相对时间凑数。</span></div></div>
        <div class="set-row col"><div><b>免责声明</b>
          <span>本终端仅做信息聚合与可视化，不构成任何投资建议。行情可能延迟，交易决策请以券商/交易所数据为准。</span></div></div>
      </div>

      <div class="set-foot">异动看板 · MACRO PULSE · 突发快讯 × 资产瞬时映射 × 事件追踪</div>`;
  }

  /* ---------------- 详情面板 ---------------- */
  let chart = null;

  /* 暗盘 / 链上 —— 内联面板
   * v150 用户口径（图5）：「这个页面不需要显示盘后价，只要显示暗盘跟链上价；
   *   如果同时有暗盘和链上两个价格，要分别显示」。
   * 所以这里彻底不渲染 ex（盘前/盘后），只渲染：
   *   ① 暗盘 = Hyperliquid RWA 永续（S.alt, kind=hl）
   *   ② 链上 = DexScreener DEX 现货池（S.dexAlt, kind=dex）
   * 两者数据源不同、价格天然不同，各自一行，谁也不盖谁。 */
  function extBodyHTML(key, alt, ex) {
    const a = U.get(key);
    const rows = [];
    const withUnit = (px) => {
      if (px == null) return '--';
      return (a && a.unit && a.unit !== 'USD') ? U.fmt(key, px) + ' ' + a.unit : U.fmt(key, px);
    };
    const spOf = (sp) => (sp != null)
      ? ` <b class="${sp >= 0 ? 'up' : 'down'}">${sp >= 0 ? '+' : ''}${sp.toFixed(2)}%</b>` : '';
    // ⓪ 日股夜盤PTS（Japannext J-Market）
    const pj = S.pts[key];
    if (pj) {
      rows.push(
        `<div class="ext-row"><span class="ext-tag ext-pts">夜盤PTS</span>`
        + `<span class="ext-val">${withUnit(pj.price)}${spOf(pj.pct)}</span>`
        + `<span class="ext-meta">Japannext J-Market 夜間取引（17:00–06:00 JST）· 相对东证收盘</span></div>`
      );
    }
    // ① 暗盘（Hyperliquid）
    const dark = (alt && alt.kind === 'hl') ? alt : null;
    if (dark) {
      /* v64：跨市场 ADR/GDR（SKHX / TSM / SMSN…）不是本币挂牌，
       * 价格与本地股价量级不同（TSM 还是 1:5），必须写清标的与币种。 */
      if (dark.adr) {
        rows.push(
          `<div class="ext-row"><span class="ext-tag ext-dark">暗盘</span>`
          + `<span class="ext-val">$${dark.price.toFixed(2)}${spOf(dark.spread)}</span>`
          + `<span class="ext-meta">Hyperliquid ${esc(dark.adr.label)}(${esc(dark.sym)}) · 美元计价，未换算本币</span></div>`
        );
      } else {
        rows.push(
          `<div class="ext-row"><span class="ext-tag ext-dark">暗盘</span>`
          + `<span class="ext-val">${withUnit(dark.price)}${spOf(dark.spread)}</span>`
          + `<span class="ext-meta">Hyperliquid 暗盘池${dark.spread != null ? ' · 与主报价基差' : ''}</span></div>`
        );
      }
    }
    // ② 链上（DexScreener）
    const dex = (S.dexAlt && S.dexAlt[key]) || ((alt && alt.kind === 'dex') ? alt : null);
    if (dex) {
      rows.push(
        `<div class="ext-row"><span class="ext-tag ext-dex">链上</span>`
        + `<span class="ext-val">$${U.fmt(key, dex.price)}${spOf(dex.spread)}</span>`
        + `<span class="ext-meta">${esc(dex.pair ? 'DEX ' + dex.pair : '链上 DEX 池子实时成交价')}${dex.spread != null ? ' · 与主报价基差' : ''}</span></div>`
      );
    }
    // ③ 延展时段（既不是暗盘也不是链上的替代价，如无 hl 的韩股）
    if (alt && alt.kind === 'ext') {
      rows.push(
        `<div class="ext-row"><span class="ext-tag ext-dark">延展</span>`
        + `<span class="ext-val">${withUnit(alt.price)}${spOf(alt.spread)}</span>`
        + `<span class="ext-meta">延展时段报价</span></div>`
      );
    }
    if (!rows.length) {
      rows.push('<div class="ext-empty">该品种暂无暗盘 / 链上数据。<br>'
        + '暗盘来自 Hyperliquid 的 RWA 永续（7×24 成交），链上来自 DexScreener 的 DEX 现货池；'
        + '美股个股通常两者都有，韩股 / 台股 / A股 没有同名链上标的。</div>');
    }
    return rows.join('');
  }

  function extPanelHTML(key) {
    const a = U.get(key);
    const alt = S.alt[key], ex = S.ext[key];
    const isCrypto = a && a.grp === 'crypto';
    const notes = isCrypto
      ? ['加密 7×24 连续交易，无传统「暗盘」；此处直接展示链上（On-chain）DEX 池子价与中心化报价的基差。',
         '当 CEX 与 DEX 价差 > 0.5% 时，通常意味着链上有大额吃单或 MEV 套利，可作为领先信号。']
      : ['暗盘 / 链上数据均已在本页内接入并实时刷新，无需跳转外部站点。',
         '暗盘 = Hyperliquid 的 RWA 永续（7×24 成交）；链上 = DexScreener 的 DEX 现货池，两者价格天然不同。',
         /* v64：按各市场真实规则重写 —— 用户自己核过市场结构，不能再用一句笼统说法。 */
         '美股：盘前 04:00–09:30 ET、盘后 16:00–20:00 ET，逐笔齐全，「盘后分时」只对美股开放。',
         '日股：东证主板没有盘前盘后，但 Japannext 的 J-Market 提供 17:00–06:00（JST）夜間PTS 连续交易，这里展示其最新成交价与東証終値比（该源无逐笔序列，不画曲线）。',
         '韩股：盘后已接入 Nextrade 애프터마켓 的真实分钟（15:40–16:00 为收盘定价单一价，16:00–20:00 连续成交，源为 Naver 分钟接口）；盘前 08:00–08:50 该源不提供，故不画。',
         '台股：没有美股式盘前盘后，盘后仅 14:00–14:30 定盘单一价且与收盘同价，故不提供盘后分时。',
         '暗盘 = Hyperliquid 的 7×24 个股永续。韩/日/台标的在链上是同公司的海外挂牌（SKHX / TSM / SMSN …），美元计价、换算比例可能不是 1:1，因此只作参考价、不与本地价格算基差。'];
    return `<div class="ext-wrap">
      <div class="ext-h">暗盘 · 链上 <span class="ext-src">页内已接入 · Hyperliquid / DexScreener / Japannext PTS</span></div>
      <div class="ext-rows">${extBodyHTML(key, alt, ex)}</div>
      <div class="ext-notes">${notes.map(n => `<p>· ${esc(n)}</p>`).join('')}</div>
    </div>`;
  }

  /* 进入「暗盘·链上」页时，确保数据已拉取再内联填充（避免空面板一闪） */
  async function renderExtInline(key) {
    const fill = () => {
      if (S.sheetKey !== key) return;
      const e2 = d.querySelector('#shExt .ext-rows');
      if (e2) e2.innerHTML = extBodyHTML(key, S.alt[key], S.ext[key]);
    };
    fill();
    const a = U.get(key);
    if (!a) return;
    const q = QuoteHub.get(key);
    const mkSpread = (px) => {
      let sp = (q && q.price) ? (px - q.price) / q.price * 100 : null;
      if (sp != null && Math.abs(sp) > 8) sp = null;
      return sp;
    };
    try {
      if (a.grp === 'crypto') {
        if (!S.alt[key]) {
          const dx = await w.API.dexQuote(key);
          if (dx && dx.price) {
            S.alt[key] = { kind: 'dex', price: dx.price, spread: mkSpread(dx.price), pair: dx.pair, at: Date.now() };
          }
        }
      } else {
        /* v150：打开「暗盘·链上」页时把暗盘与链上两条都补齐 ——
         * 用户要的是两个价格同时看到，缺哪条补哪条，不能只补暗盘。 */
        /* v64：日股先补夜盤PTS（Japannext），这是东证主板之外唯一的连续夜盘 */
        if (a.grp === 'jpstock' && !S.pts[key]) {
          try {
            const pj = await w.API.jpPtsQuote(key);
            if (pj) { S.pts[key] = pj; fill(); }
          } catch (e) {}
        }
        if (!S.alt[key] && (a.hl || a.grp === 'usstock' || a.grp === 'us'
            || (w.UNIVERSE.adrOf && w.UNIVERSE.adrOf(key)))) {
          try {
            const hp = await w.API.hlQuote(key);
            if (hp) {
              S.alt[key] = { kind: 'hl', price: hp.price, spread: hp.adr ? null : mkSpread(hp.price), at: Date.now(), sym: hp.sym, adr: hp.adr || null };
              fill();
            }
          } catch (e) {}
        }
        if (!S.dexAlt[key]) {
          try {
            const dx = await w.API.dexQuote(key);
            const off = (dx && dx.price && q && q.price) ? Math.abs(dx.price - q.price) / q.price : 0;
            if (dx && dx.price && off <= 0.5) {
              S.dexAlt[key] = { kind: 'dex', price: dx.price, spread: mkSpread(dx.price), pair: dx.pair, at: Date.now() };
              fill();
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    fill();
  }

  function relNewsHTML(key) {
    const rel = S.news.filter(n => [...(n.direct || []), ...(n.us || []), ...(n.cn || [])].some(x => x.k === key)).slice(0, 6);
    if (!rel.length) return '<div class="empty sm">暂无关联快讯</div>';
    return rel.map(n => `<div class="rel-n" data-id="${esc(n.id)}">
      <span class="lv ${LVCLS[n.level] || 'lv-b'}">${n.level}</span>
      ${liveBadge(n)}
      <div class="rel-t">${esc(n.title)}<em>${hhmm(n.ts)} · ${esc(n.cat)}</em></div>
    </div>`).join('');
  }

  /* ---------------- 品种 → 消息 倒查面板 ----------------
   * 矩阵里点一个品种，直接告诉你「它最近的异动是哪些消息造成的」。
   * 找不到消息时反而更重要 —— 无消息的异动通常是资金先行或程序化触发。
   * -------------------------------------------------- */
  function jumpToNews(id) {
    const mark = (el) => {
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    };
    const el = d.querySelector(`.card[data-id="${cssq(id)}"]`);
    if (el) { mark(el); return; }
    // 被筛选挡住了，先放开筛选再定位
    S.grade = 'all';
    S.topic = 'all';
    store.set('mm_grade', 'all');
    renderFeed();
    setTimeout(() => mark(d.querySelector(`.card[data-id="${cssq(id)}"]`)), 420);
  }

  function openKeyPanel(key) {
    const a = U.get(key);
    if (!a) return;
    const st = radar && radar.state && radar.state[key];
    const box = $('#keyPanel');

    const list = S.news
      .filter(n => n.live === true)
      .filter(n => Date.now() - n.ts < 12 * 3600 * 1000)
      .filter(n => (n.direct || []).some(x => x.k === key) || (n.cn || []).some(x => x.k === key))
      .sort((x, y) => y.ts - x.ts)
      .slice(0, 8);

    const head = st
      ? `${st.win || 30} 分钟 <b class="${st.chg >= 0 ? 'up' : 'down'}">${chgLabel(st)}</b> · 阈值 ${st.thr.toFixed(2)}%`
      : '等待行情数据';

    // 阈值依据：三个尺度各一条，让用户看清「为什么这条会亮」
    let thrNote = '';
    if (st) {
      const SRC_TEXT = { adaptive: '动态阈值（真实行情漂移）', blend: '动态 + 标定加权', prior: '静态标定先验' };
      const rows = (st.hits || []).map(h => {
        const on = h.ratio >= 1;
        const v = (h.chg >= 0 ? '+' : '') + h.chg.toFixed(2) + '%';
        return `<span>${h.win} 分钟 <em class="${on ? 'hot' : ''}">${v}</em>
          / 阈值 <em>${h.thr.toFixed(2)}%</em>${on ? ' · 已越线' : ''}</span>`;
      }).join('');
      thrNote = `<div class="kp-thr">
        <b>三尺度阈值（该品种专属）</b>
        ${rows || '<span>三尺度数据不足，本轮跳过判定</span>'}
        <span class="kp-thr-t">任一尺度越线即报警，5 分钟尺度用于捕捉几分钟内的闪崩/暴力拉升。
          阈值来源：${SRC_TEXT[st.thrSrc] || '静态标定'}${st.thrScaleDays ? ' · 已累积 ' + st.thrScaleDays + ' 个交易日样本' : ''}。低于此线视为日内正常波动。</span>
      </div>`;
    }

    box.innerHTML = `<div class="kp-mask"></div>
      <div class="kp-body">
        <div class="kp-h">
          <div><b>${esc(a.name)}</b><span>${head}</span></div>
          <button class="kp-x">×</button>
        </div>
        <div class="kp-sub">最近 12 小时与它直接相关的快讯 · ${list.length} 条</div>
        ${thrNote}
        <div class="kp-list">
          ${list.length ? list.map(n => `
            <button class="kp-i" data-go="${esc(n.id)}">
              <span class="lv ${LVCLS[n.level] || 'lv-b'}">${n.level}</span>
              <div>
                <p>${esc(n.title)}</p>
                <em>${hhmm(n.ts)} · ${agoText(n.ts)} · ${esc(n.cat)}</em>
              </div>
            </button>`).join('')
            : `<div class="kp-none">最近 12 小时没有直接相关消息
                <span>这类「无消息异动」往往是资金先行或程序化触发，值得盯</span></div>`}
        </div>
        <button class="kp-full" data-full="${esc(key)}">看完整走势 →</button>
      </div>`;
    box.className = 'keyp on';
    /* 品种倒查面板同样支持「点任意处关闭」。 */
    bindTapClose(box, '.kp-body', () => { box.className = 'keyp'; box.innerHTML = ''; });

    box.onclick = (e) => {
      const close = () => { box.className = 'keyp'; box.innerHTML = ''; };
      if (e.target.closest('.kp-mask') || e.target.closest('.kp-x')) { close(); return; }
      const full = e.target.closest('[data-full]');
      if (full) { const k = full.dataset.full; close(); openSheet(k); return; }
      const go = e.target.closest('[data-go]');
      if (go) { const id = go.dataset.go; close(); switchTab('feed'); jumpToNews(id); }
    };
  }

  /* ---------------- 快讯详情 ----------------
   * 卡片上只有标题，「到底发生了什么」看不了。详情页给四件事：
   *   1) 完整正文（源里带的全文段，不再截断成两行）
   *   2) 影响链：类别 → 直接标的 → A股映射
   *   3) 真实影响：消息前后 1 分钟走势 + 幅度，逐个品种并排
   *   4) 同期相关快讯，可以一路点下去
   * 落不到品种的「全局事件」，改看四个风险偏好探针（美股/美债/黄金/美元）。
   * ------------------------------------------ */
  const MACRO_PROBE = [{ k: 'SPX' }, { k: 'US10Y' }, { k: 'GOLD' }, { k: 'DXY' }];

  // 详情页用的大号走势图：虚线 = 消息发布时刻
  function sparkBig(spark, up) {
    if (!spark || spark.length < 4) return '<div class="ns-ph">分钟线还没覆盖到这条消息</div>';
    const W = 300, H = 58, P = 7;
    const vs = spark.map(p => p.v).concat([0]);
    let mx = Math.max.apply(null, vs), mn = Math.min.apply(null, vs);
    if (mx - mn < 1e-9) { mx = 0.05; mn = -0.05; }
    const x = i => P + (i / (spark.length - 1)) * (W - P * 2);
    const y = v => H - P - ((v - mn) / (mx - mn)) * (H - P * 2);
    const dd = spark.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    const mi = spark.findIndex(p => p.i === 0);
    const zero = y(0).toFixed(1);
    const col = up ? 'var(--up)' : 'var(--down)';
    return `<svg class="ns-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="0" y1="${zero}" x2="${W}" y2="${zero}" stroke="var(--hair2)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${mi >= 0 ? `<line x1="${x(mi).toFixed(1)}" y1="0" x2="${x(mi).toFixed(1)}" y2="${H}" stroke="var(--tx3)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ''}
      <path d="${dd}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function nsChips(list, label) {
    if (!list || !list.length) return '';
    return `<div class="ns-sec">
      <div class="ns-sec-h">${label}</div>
      <div class="ns-chips">${list.map(x => {
        const a = U.get(x.k); if (!a) return '';
        const q = QuoteHub.get(x.k);
        return `<button class="ns-chip qrow" data-k="${esc(x.k)}">
          <span class="ns-chip-n">${esc(a.short || a.name)}</span>
          <b class="qpx" data-k="${esc(x.k)}">${q && q.price != null ? U.fmt(x.k, q.price) : '--'}</b>
          <i class="qp" data-k="${esc(x.k)}">${q ? U.changeLabel(x.k, q) : '--'}</i>
        </button>`;
      }).join('')}</div>
    </div>`;
  }

  async function openNews(id) {
    const n = S.news.find(x => x.id === id);
    if (!n) return;
    S.curNews = n;
    const box = $('#newsSheet');
    box.className = 'nsheet on';
    syncLock();
    box.scrollTop = 0;
    /* 【需求 3】快讯详情小窗也能「点任意处关闭」，不用非得找右上角那个 ✕。
     * 正文区（.ns-scroll）是滚动容器，用滚动距离区分「滑动阅读」与「轻点关闭」。 */
    bindTapClose(box, '.ns-scroll', closeNews);

    const keys = [].concat(n.direct || [], n.us || [], n.cn || []).map(x => x.k);
    if (n.noAsset) MACRO_PROBE.forEach(x => keys.push(x.k));
    QuoteHub.refresh(Array.from(new Set(keys)));

    const tps = w.TOPICS.of(n);
    const probe = n.noAsset ? Object.assign({}, n, { direct: MACRO_PROBE }) : n;

    const shell = (bodyHTML) => `<div class="ns-mask"></div>
      <div class="ns-body">
        <div class="ns-h">
          <div class="ns-meta">
            <span class="lv ${LVCLS[n.level] || 'lv-b'}">${n.level}</span>
            <span class="c-cat">${esc(n.cat)}</span>
            ${n.noAsset ? '<span class="c-macro">全局</span>' : ''}
            ${liveBadge(n)}
            <em>${hhmm(n.ts)} · ${agoText(n.ts)}</em>
            <button class="ns-x" aria-label="关闭">✕</button>
          </div>
          <h2 class="ns-title">${esc(n.title)}</h2>
            <div class="ns-by">${srcHTML(n, 'ns-src-link')}${tps.length ? ' · ' + tps.map(t => esc(w.TOPICS.label(t))).join(' / ') : ''}</div>
        </div>
        <div class="ns-scroll">${bodyHTML}</div>
      </div>`;

    box.innerHTML = shell(`<div class="ns-loading">正在拉取这条消息之后的真实走势…</div>`);

    let r = null;
    // 演示条目没有真实发布时间，不去做「消息后 5 分钟」行情归因，
    // 否则会给一条编造的新闻安上一条看似真实但毫无根据的因果链
    if (n.live === true) {
      try { r = await w.NewsVerify.check(probe); } catch (e) {}
    }
    if (box.className !== 'nsheet on') return;
    if (S.news.indexOf(n) < 0) return;

    // 正文：源里的 brief 已经是「去掉标题后的全文段」，直接整段给
    const body = (n.brief || '').trim();
    // 来源链接：有原文给原文（站内小窗打开），没有就给该源的频道页，并说清楚
    const chUrl = srcChannelOf(n.src);
    const srcLink = n.url
      ? srcButton(n.url, '查看原文（站内小窗）', 'in')
      : (chUrl
        ? srcButton(chUrl, '该源未提供原文链接 · 去 ' + (n.src || '').split(' / ')[0] + ' 快讯频道页核实')
        : '');
    // 演示条目额外挂一条醒目的说明，避免被当成真新闻读
    const demoNotice = n.demo
      ? `<div class="ns-demo-note"><b>演示数据 · 非真实新闻</b><span>这条内容是为演示界面而编造的占位样本，不对应任何真实事件、真实机构或真实行情，也不参与任何行情归因计算。</span></div>`
      : (n.live !== true
        ? `<div class="ns-demo-note sample"><b>示例条目 · 来源未标记为真实抓取</b><span>该条目没有「实时抓取」标记，可能是历史残留或示例内容。引用前请自行核实。</span></div>`
        : '');
    const bodyHTML = demoNotice
      + (body
        ? `<div class="ns-text">${esc(body)}</div>${srcLink}`
        : `<div class="ns-text ns-text-empty">该来源只推了标题，没有正文段。可以看下面的影响链和真实走势判断影响。</div>${srcLink}`)
      /* 【中英对照】推文 / 博主原话整段贴出英文原文 —— 用户口径：
       * 「如果翻译出错了，我还可以看英文」。译文在上、原文在下，一眼可核。
       * 翻译没成功时 titleEn === title，此时不重复。 */
      + (n.titleEn && String(n.titleEn).trim() !== String(n.title || '').trim()
          && /川普言论|口罩哥KZG/.test(String(n.src || ''))
        ? `<div class="ns-sec ns-en">
            <div class="ns-sec-h">英文原文 <u>未经改动的原话，便于核对译文</u></div>
            <div class="ns-en-text">${esc(n.titleEn)}</div>
          </div>`
        : '')
      /* 全文区：只在「这条快讯本身太短（<120 字，基本只有标题）」时才去源站补。
       * 财联社 / 金十 / 见闻的快讯正文本来就是完整一条，再抓一次纯属浪费，
       * 还会让详情页长时间挂着「正在提取…」。 */
      + (n.url && n.live === true && body.length < 120
        ? `<div class="ns-sec ns-full" data-full="${esc(n.url)}">
            <div class="ns-sec-h">全文 <u>来自源站原文，正在提取…</u></div>
            <div class="ns-ftext"><div class="ns-loading">正在读取 ${esc(hostOf(n.url))} 的原文正文…</div></div>
          </div>`
        : '');

    const chainHTML = (n.chain && n.chain.length)
      ? `<div class="ns-sec">
          <div class="ns-sec-h">影响链${n.demo ? '（演示占位，非真实传导关系）' : ''}</div>
          <div class="ns-chain">${n.chain.map((x, i) => `<span class="ns-ch ${i === 0 ? 'first' : ''}">${esc(x)}</span>`).join('')}</div>
        </div>` : '';

    // 真实影响
    let impHTML = '';
    if (r && r.items.length) {
      const rows = r.items.map(it => {
        const f = w.NewsVerify.fmt(it);
        const pre = (it.pre != null && Math.abs(it.pre) >= w.NewsVerify.scaleOf(it.k).clear
          && Math.sign(it.pre) === Math.sign(it.chg))
          ? '<i class="ns-pre">抢跑</i>' : '';
        return `<div class="ns-imp-r">
          <div class="ns-imp-h">
            <span class="ns-imp-n">${esc(f.name)}${pre}</span>
            <b class="${f.up ? 'up' : 'down'}">${f.text}</b>
            <em>${it.moved ? '有效波动' : '几乎没动'}</em>
          </div>
          ${sparkBig(it.spark, f.up)}
        </div>`;
      }).join('');
      impHTML = `<div class="ns-sec">
        <div class="ns-sec-h">消息后 5 分钟的真实走势${n.noAsset ? '（风险偏好四探针）' : ''}
          <u>${r.partial ? '数据还在积累' : r.label + ' · 最大 ' + (r.maxTxt || '')}</u></div>
        <div class="ns-imps">${rows}</div>
        <p class="ns-note">虚线是消息发布的那一刻。曲线在虚线之前就已经同向跑，说明资金抢跑；虚线之后才拉，才是这条消息打的。</p>
      </div>`;
    } else if (n.noAsset) {
      impHTML = `<div class="ns-sec">
        <div class="ns-sec-h">影响面</div>
        <p class="ns-note">这条消息没有落到单一品种，也没有可以直接对照的分钟线。它改变的是整体风险偏好 —— 通常体现为美股承压、美债收益率下行、黄金走强、美元走弱这类「组合式」反应。</p>
      </div>`;
    }

    // 相关快讯：同类别 + 共享标的，各取最近几条
    const keySet = new Set(keys);
    const rel = S.news
      .filter(x => x.id !== n.id)
      .map(x => {
        const shared = [].concat(x.direct || [], x.cn || []).filter(y => keySet.has(y.k)).length;
        const score = (x.cat === n.cat ? 2 : 0) + Math.min(3, shared);
        return { x, score };
      })
      .filter(o => o.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.x.ts - a.x.ts))
      .slice(0, 5)
      .map(o => o.x);

    const relHTML = rel.length ? `<div class="ns-sec">
      <div class="ns-sec-h">同期相关</div>
      <div class="ns-rel">${rel.map(x => `
        <button class="ns-rel-i" data-news="${esc(x.id)}">
          <span class="lv ${LVCLS[x.level] || 'lv-b'}">${x.level}</span>
          ${liveBadge(x)}
          <div><p>${esc(x.title)}</p><em>${hhmm(x.ts)} · ${esc(x.cat)}</em></div>
        </button>`).join('')}</div>
    </div>` : '';

    box.innerHTML = shell(
      bodyHTML + chainHTML
      + nsChips(n.direct, '直接关联标的')
      + nsChips(n.us, '美股映射')
      + nsChips(n.hk, '港股映射')
      + nsChips(n.cn, 'A股映射')
      + impHTML + relHTML
      + `<div class="ns-foot">${esc(n.src)} · ${hhmm(n.ts)} 发布 · 共 ${S.news.length} 条在库</div>`
    );

    // 全文异步填充：不阻塞首屏，取到就贴进「全文」区
    const fullEl = box.querySelector('.ns-full');
    if (fullEl && n.url) loadFullText(fullEl, n.url);
  }

  /** 把源站正文贴进详情页的「全文」区 */
  function loadFullText(el, url) {
    const want = url;
    (w.LiveNews && w.LiveNews.readable ? w.LiveNews.readable(want) : Promise.resolve(''))
      .then(text => {
        if (!el.isConnected || el.dataset.full !== want) return;
        const box = el.querySelector('.ns-ftext');
        const head = el.querySelector('.ns-sec-h u');
        if (!box) return;
        if (!text) {
          el.hidden = true;      // 取不到就不占版面，正文段已经够读
          return;
        }
        /* 源站原文可能是**整页 HTML**（用户截图：详情页「全文」区显示
         * <!DOCTYPE html><html class=""><head><meta charset="utf-8">… 一坨源码）。
         * readable() 拿到的是页面源码，这里必须剥干净再渲染；剥完为空就整块隐藏。 */
        const cleanText = (w.LiveNews && typeof w.LiveNews._stripHtml === 'function')
          ? w.LiveNews._stripHtml(text) : text;
        if (!cleanText || cleanText.length < 20) {
          el.hidden = true;
          return;
        }
        // 正文段和全文高度重复时只留全文，避免同一段话出现两遍
        const brief = (el.parentNode && el.parentNode.querySelector('.ns-text')) ?
          (el.parentNode.querySelector('.ns-text').textContent || '') : '';
        const dup = brief.length > 40 && cleanText.indexOf(brief.trim().slice(0, 40)) >= 0;
        if (dup) {
          const bt = el.parentNode.querySelector('.ns-text');
          if (bt) bt.hidden = true;
        }
        if (head) head.textContent = '源站原文 · ' + cleanText.length + ' 字';
        box.innerHTML = `<div class="lv-text">${esc(cleanText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</div>`;
      })
      .catch(() => { el.hidden = true; });
  }

  /* 统一管理 body 滚动锁。
   * 现在弹层可以叠开（行情面板上再开快讯详情小窗），如果每处各自
   * add/remove 'locked'，关掉上层会把下层的锁也解掉，页面在底层还开着
   * 的时候就能滚了 —— 观感上像「卡住一层透明膜」。改成按当前实际打开的
   * 弹层数量统一算。 */
  function syncLock() {
    const any = ['#sheet', '#newsSheet', '#linkView', '#keyPanel', '#picker']
      .some(sel => {
        const el = d.querySelector(sel);
        return el && (el.classList.contains('on') || el.className.indexOf(' on') >= 0);
      });
    if (any) d.body.classList.add('locked');
    else d.body.classList.remove('locked');
  }

  function closeNews() {
    const box = $('#newsSheet');
    box.className = 'nsheet';
    box.innerHTML = '';
    syncLock();
  }

  /* ---------------- 站内原文小窗 ----------------
   * 用户诉求：「点链接不要跳到浏览器、也不要开新页面，就在这个 H5 里开一个
   *   小窗显示原链接的内容，小窗有个叉可以关掉。」
   *
   * 实现分两层，自适应：
   *   ① 先嵌 iframe —— 站点允许被嵌（无 X-Frame-Options / CSP frame-ancestors）
   *      就直接显示原页面，和点开一模一样；
   *   ② 站点禁止嵌入（财联社等常见）→ 自动切到「正文」模式，用只读代理把
   *      原文转成纯文本渲染，仍然是原链接里的内容，仍在同一个页面里。
   *   底部永远留一个「在浏览器打开」的兜底 —— 有些页面（需要登录/重交互）
   *   嵌进来也不好用。
   */
  const LINK = { on: false, url: '', mode: 'frame', title: '', src: '' };

  function openLink(url, title, src, body, isChannel) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return;
    const box = $('#linkView');
    if (!box) return;
    LINK.on = true; LINK.url = u; LINK.title = title || u; LINK.src = src || '';
    LINK.body = String(body || '').trim();
    LINK.channel = !!isChannel;
    /* 默认给「正文」而不是原页面：
     * 国内财经站（东财 / 财联社 / 新浪 / 见闻 / 金十）几乎全部用
     * X-Frame-Options + CSP 禁止嵌入，而且被拒时 iframe 照样会触发 onload，
     * 根本没法用 onload 判断 —— 用户看到的就是一片白。
     *
     * 正文优先用「这条快讯本身抓到的全文」：
     * 财联社 / 金十 / 见闻的快讯正文本身就是完整一条，直接贴即可，
     * 不依赖任何代理，也不消耗额度。只有这条只有标题时，
     * 才去网上补（见 paintLinkMode）。 */
    /* 频道页（该源没给这条的原文）没有「正文」可言，直接开原页面；
     * 允许嵌入就正常显示，不允许就由页面底部的说明兜住。 */
    LINK.mode = LINK.channel ? 'frame' : 'text';
    box.className = 'lview on';
    /* 站内原文小窗同样支持「点任意处关闭」。 */
    bindTapClose(box, '.lv-body', closeLink);
    box.innerHTML = `<div class="lv-mask"></div>
      <div class="lv-body">
        <div class="lv-h">
          <button class="lv-x" aria-label="关闭">✕</button>
          <div class="lv-t">
            <b>${esc(LINK.title).slice(0, 90)}</b>
            <span>${esc(LINK.src || '原文')} · ${esc(hostOf(u))}</span>
          </div>
          <div class="lv-seg">
            <button data-lvm="text">正文</button>
            <button data-lvm="frame">原页面</button>
          </div>
        </div>
        <div class="lv-stage" id="lvStage">
          <div class="lv-load"><i></i><span>正在载入原文…</span></div>
        </div>
        <div class="lv-f">
          <span>${LINK.channel
            ? esc(hostOf(u)) + ' 快讯频道页 · 该源没给这条的原文链接；若这里空白，说明它不允许被嵌入'
            : '内容来自 ' + esc(hostOf(u)) + '，在本页内查看，不跳转'}</span>
          <button class="lv-out" data-lvout="1">在浏览器打开 ↗</button>
        </div>
      </div>`;
    syncLock();
    paintLinkMode();
  }

  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return u; }
  }

  function closeLink() {
    const box = $('#linkView');
    if (!box) return;
    LINK.on = false;
    box.className = 'lview';
    box.innerHTML = '';
    syncLock();
  }

  /* iframe 是否被站点拒绝，浏览器不会报错 —— 用「能不能拿到 contentWindow 的
   * 文档」+ 超时兜底：8 秒内没 onload 就认为被拦，自动切正文模式。 */
  function paintLinkMode() {
    const box = $('#linkView');
    const stage = box && $('#lvStage');
    if (!stage) return;
    $$('.lv-seg button', box).forEach(b => b.classList.toggle('on', b.dataset.lvm === LINK.mode));

    if (LINK.mode === 'frame') {
      stage.innerHTML = `<div class="lv-load"><i></i><span>正在载入原文…</span></div>`;
      const fr = d.createElement('iframe');
      fr.className = 'lv-frame';
      fr.setAttribute('referrerpolicy', 'no-referrer');
      fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 超时没加载完 → 大概是被 X-Frame-Options 拦了，切正文
        LINK.mode = 'text';
        paintLinkMode();
      }, 9000);
      fr.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ph = stage.querySelector('.lv-load');
        if (ph) ph.remove();
      };
      stage.innerHTML = '';
      stage.appendChild(fr);
      fr.src = LINK.url;
      return;
    }

    // 正文模式
    /* 先把正文里的 HTML 剥干净 ——
     * 实测金十某条把**整页 HTML** 当正文塞进来，小窗里直接显示
     * `<!DOCTYPE html><html lang="zh-CN"><head>…` 一大坨源码（用户截图）。
     * 剥完为空就走下面的「网上补正文」或空态提示，不再展示源码。 */
    const cleanBody = (w.LiveNews && typeof w.LiveNews._stripHtml === 'function')
      ? w.LiveNews._stripHtml(LINK.body || '')
      : (LINK.body || '');
    LINK.bodyClean = cleanBody;
    // ① 这条快讯自己抓到的正文（多数源给的就是完整一条，最稳、零依赖）
    if (cleanBody && cleanBody.length >= 40) {
      stage.innerHTML = `<div class="lv-text">${esc(cleanBody).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</div>
        <div class="lv-note">以上是本站抓到的快讯正文。要核对原网页（含配图与后续更新），点右上角「原页面」或底部「在浏览器打开」。</div>`;
      stage.scrollTop = 0;
      return;
    }
    // ② 只有标题时，才联网补正文
    stage.innerHTML = `<div class="lv-load"><i></i><span>正在尝试补全原文正文…</span></div>`;
    const want = LINK.url;
    (w.LiveNews && w.LiveNews.readable ? w.LiveNews.readable(want) : Promise.resolve(''))
      .then(text => {
        if (!LINK.on || LINK.url !== want || LINK.mode !== 'text') return;
        const st = $('#lvStage');
        if (!st) return;
        /* 网上补回来的正文也可能是整页 HTML（同花顺/金十的频道页），
         * 同样先剥干净再显示，剥空了就按「拿不到正文」处理。 */
        const cleanText = (w.LiveNews && typeof w.LiveNews._stripHtml === 'function')
          ? w.LiveNews._stripHtml(text) : text;
        st.innerHTML = cleanText
          ? `<div class="lv-text">${esc(cleanText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</div>`
          : `<div class="lv-fail">
              <b>这条只推了标题，原网页也不允许被嵌入</b>
              <span>国内财经站普遍用 X-Frame-Options 拒绝嵌入，浏览器端也拿不到它的正文。可以点上方「原页面」试试，或点右下角「在浏览器打开」。</span>
            </div>`;
        st.scrollTop = 0;
      })
      .catch(() => {
        const st = $('#lvStage');
        if (st) st.innerHTML = `<div class="lv-fail"><b>正文提取失败</b><span>可以点上方「原页面」试试，或点右下角「在浏览器打开」。</span></div>`;
      });
  }

  /** 详情页里的来源按钮 → 站内小窗 */
  function srcButton(url, label, cls) {
    if (!url) return '';
    return `<button class="ns-src-link ${cls || ''}" data-open="${esc(url)}">${esc(label)}</button>`;
  }

  function openSheet(key) {
    if (!U.get(key)) return;
    S.sheetKey = key;
    S.sheetMode = 'min';
    const a = U.get(key);
    const g = U.grp(key);
    const sess = w.Session.state(key);
    const sheet = $('#sheet');
    /* 【修复 11-06】行情面板可能被从「详情小窗 / 站内原文 / 选股器」等上层弹窗里点开，
     * 必须压在它们之上，否则行情会跑到小窗后面（用户反馈：详情小窗点布伦特原油，
     * 行情被小窗挡住，得关掉小窗才看得到）。动态取当前最上层弹窗的 z-index +10，
     * 比写死一个值更稳 —— 以后再加新的弹窗也不会漏。 */
    const topZ = (() => {
      let z = 0;
      ['.nsheet.on', '.lview.on', '.keyp.on', '.pk.on', '.smodal.on'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) { const v = Number(getComputedStyle(el).zIndex) || 0; if (v > z) z = v; }
      });
      return z;
    })();
    sheet.style.zIndex = String(Math.max(95, topZ + 10));
    sheet.classList.add('on');
    syncLock();

    const q = QuoteHub.get(key);
    /* v215：美股指数没有连续盘前/盘后成交，头部也不挂「盘前/盘后」，统一「已收盘」。
     * v255：与列表同口径 —— 拿到真实延展报价（VIX 的 CNBC 盘前）时不强制「已收盘」。 */
    const _extNow = S.ext[key];
    const _idxExt = (a.grp === 'us' || a.grp === 'usstock') && a.kind === 'index'
      && (sess.phase === 'pre' || sess.phase === 'post')
      && !(_extNow && _extNow.phase);
    const _sessLbl = _idxExt ? '已收盘' : sess.label;
    sheet.innerHTML = `
      <div class="sh-panel">
        <div class="sh-head">
          <button class="sh-x" aria-label="关闭">✕</button>
          <div class="sh-id">
            <div class="sh-name">${esc(a.name)}</div>
            <div class="sh-sub">
              <span style="color:${gColor(g)}">${esc(g.label)}</span>
              <span class="sh-sess ${_idxExt ? '' : (sess.open ? 'open' : '')}">${esc(_sessLbl)}</span>
              ${a.unit && a.kind !== 'index' ? '· ' + esc(a.unit) + ' ' : ''}· ${a.src === 'binance' ? 'Binance' : (a.rt === 'tx' ? '腾讯 · 新浪' : (a.rt === 'cnbc' ? 'CNBC' : (a.src === 'cboe' ? 'CBOE' : '东方财富')))}${a.lag ? ' · 延' + Math.round(a.lag / 60) + '分' : ''}
            </div>
          </div>
          <div class="sh-px">
            <b class="qpx" data-k="${esc(key)}">${q && q.price != null ? U.fmt(key, q.price) : '--'}</b>
            <span class="qp" data-k="${esc(key)}">${q ? U.pct(q.pct) : '--'}</span>
            <div class="sh-exthead" id="shHeadExt" hidden></div>
          </div>
        </div>
        <div class="sh-tabs">
          <button data-m="min" class="on">分时</button>
          <button data-m="d">日K</button>
          <button data-m="w">周K</button>
          <button data-m="m">月K</button>
          <button data-m="ext">暗盘·链上</button>
        </div>
        <div class="sh-chartbar" id="shChartBar" hidden>
          <button class="cb-ind" id="cbInd" title="主图指标：裸K线 / 三五法则">裸K ▾</button>
          <button class="cb-cfg" id="cbGapCfg" title="跳空缺口设置：开关 / 显示几个缺口">缺口</button>
          <div class="cb-seg" id="cbScale">
            <button data-s="linear" class="on" title="等差坐标（普通坐标）：价格每变动同样数值，占同样高度">等差</button>
            <button data-s="log" title="对数坐标：价格每变动同样百分比，占同样高度（适合长周期、涨幅巨大的品种）">对数</button>
          </div>
          <button class="cb-draw" id="cbDraw" title="画图工具：线段 / 射线 / 波段延伸">画</button>
          <button class="cb-bell" id="cbAlert" title="股价预警：涨到 / 跌到 / 涨跌幅 / 创新高新低">🔔<i class="cb-badge" id="cbAlertN" hidden>0</i></button>
          <button class="cb-fs" id="cbFull" title="横屏全屏：图表铺满屏幕，方便画图">⛶</button>
        </div>
        <div class="sh-minbar" id="shMinBar" hidden>
          <button data-x="0" class="on" title="只看常规时段 09:30–16:00 ET">常规分时</button>
          <button data-x="1" title="按当前时段把盘前或盘后的成交接到分时图上">延展分时</button>
        </div>
        <div class="sh-minnote" id="shMinNote" hidden></div>
        <div class="sh-legend" id="shLegend"><span class="lg-loading">加载中…</span></div>
        <div class="chart-host" id="chartHost"></div>
        <div class="sh-ext" id="shExt" hidden></div>
        <div class="sh-news-h">关联快讯 <span>(${S.news.filter(n => [...(n.direct || []), ...(n.us || []), ...(n.cn || [])].some(x => x.k === key)).length})</span></div>
        <div class="sh-news" id="shNews">${relNewsHTML(key)}</div>
        <div class="sh-foot">数据来源：东方财富 · 腾讯 · 新浪 · CNBC · 币安 · TradingView · 链上（Hyperliquid / DEX）· 行情为真实数据，非交易时段显示最后成交价</div>
      </div>`;

    sheet.querySelector('.sh-x').onclick = closeSheet;
    sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
    /* v164：等比/对数 + 画图工具 */
    const indBtn = sheet.querySelector('#cbInd');
    if (indBtn) indBtn.onclick = () => openIndMenu();
    const gapCfgBtn = sheet.querySelector('#cbGapCfg');
    if (gapCfgBtn) gapCfgBtn.onclick = () => openGapCfg();
    const scaleBox = sheet.querySelector('#cbScale');
    if (scaleBox) {
      scaleBox.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          const m = b.dataset.s;
          if (chart) chart.setScaleMode(m);
          else if (w.DRAW_SCALE) w.DRAW_SCALE.set(m);
          scaleBox.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.s === m));
        };
      });
    }
    const drawBtn = sheet.querySelector('#cbDraw');
    if (drawBtn) {
      drawBtn.onclick = () => {
        const p = $('#drawPanel');
        if (p && !p.hidden) closeDrawPanel(); else openDrawPanel();
      };
    }
    const bellBtn = sheet.querySelector('#cbAlert');
    if (bellBtn) bellBtn.onclick = () => openAlertSheet(key);
    const fsBtn = sheet.querySelector('#cbFull');
    if (fsBtn) fsBtn.onclick = () => toggleChartFS();
    /* 【需求 2】行情面板（从矩阵卡片点开 / 从行情页点开）也能「点任意处关闭」，
     * 不用再去找左上角那个 ✕。判定口径见 bindTapClose 的注释。 */
    bindTapClose(sheet, '.sh-panel', closeSheet);

    const tabs = sheet.querySelectorAll('.sh-tabs button');
    tabs.forEach(b => b.onclick = () => {
      tabs.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      S.sheetMode = b.dataset.m;
      syncSheetMode();
    });

    chart = chart || new w.AssetChart($('#chartHost'), $('#shLegend'));
    chart.host = $('#chartHost');
    chart.legendEl = $('#shLegend');

    /* 「盘后分时」开关：默认常规分时（＝点进去就是普通分时），
     * 打开了才把盘前/盘后接上去。选择记在本机，下次打开沿用。 */
    const minBar = sheet.querySelector('#shMinBar');
    if (minBar) {
      minBar.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          const on = b.dataset.x === '1';
          S.minExt = on;
          store.set('mm_minext', on);
          syncMinBar();
          if (S.sheetKey && chart && S.sheetMode === 'min') {
            chart.showExt = on;
            chart.render(S.sheetKey, 'min');
          }
        };
      });
    }
    syncSheetMode();

    /* 盘前 / 盘后：大号价格仍是「最近一次常规收盘价」，延展时段的成交单独挂在下面。
     * 先按缓存渲染一次（有就立刻出现），再异步补一次（打开时多半还没有）。 */
    renderExtHead(key);
    refreshExt([key]).then(() => {
      if (S.sheetKey !== key) return;
      renderExtHead(key);
      /* 延展价是异步到的：到了再决定「盘后分时」开关要不要露出来，
       * 否则台股这类没有盘后价差的品种会先闪一个点了没反应的按钮。 */
      try { syncMinBar(); } catch (e) {}
    });

    if (!q) QuoteHub.refresh([key]);
    if (a.grp === 'crypto') {
      w.API.dexQuote(key).then(dx => {
        const el = $('#shLegend');
        if (el) el.insertAdjacentHTML('beforeend',
          `<span class="lg-item">链上池子<b>$${U.fmt(key, dx.price)}</b></span>`);
      }).catch(() => {});
    }
  }

  /* 「盘后分时」开关只在分时页、且该品种确实有盘前/盘后数据时才露出来。
   * 指数（.SPX 之类）没有延展成交，给它一个点了没反应的开关没意义；
   * 但只要账户里有美股个股，就按品种逐个判断，而不是一刀切全站显示。
   *
   * 默认值：用户没手动选过时，按**当前时段**自动 —— 正处在盘前/盘后就把延展段接上，
   * 其余时候给普通分时（和富途一致）。手动点过之后就记住用户的选择。 */
  function effMinExt() {
    if (S.minExt === true || S.minExt === false) return S.minExt;
    const a = S.sheetKey ? U.get(S.sheetKey) : null;
    if (!a) return false;
    const st = w.Session && w.Session.state ? w.Session.state(S.sheetKey) : null;
    return !!(st && (st.phase === 'pre' || st.phase === 'post'));
  }

  function syncMinBar() {
    const bar = $('#shMinBar');
    if (!bar) return;
    const a = S.sheetKey ? U.get(S.sheetKey) : null;
    // v62：除了「这个品种理论上可能有延展时段」，还要求**确实拿到了延展价**。
    // 台积电这类：TV 的 postmarket_close 等于常规收盘（台股盘后是 14:00–14:30
    // 定盘单一价），合成出来没有任何一段，开关点开与不点一模一样 ——
    // 用户看到的是「盘后分时没加载出来吧」。没有数据就不给开关，别制造假象。
    /* v63：只有**美股**才提供「盘后分时」。
     * 韩股/台股的盘后是定盘单一价撮合，三个源（东财 / Yahoo / TV）都拿不到盘后逐笔，
     * 之前用「收盘价 → 盘后价」两点连线画出的斜坡是编的（用户截图里那条 90 度直线）。
     * 现在这两类市场不再合成任何盘后段，开关也不出现，盘后价只以真实成交价
     * 显示在页面顶部与「暗盘·链上」页，分时页用一行说明讲清原因。 */
    const isUS = !!(a && (a.grp === 'usstock' || a.grp === 'us'));
    /* v65：韩股盘后（Nextrade 애프터마켓 15:40–20:00）现在有真实分钟序列了
     * （Naver fchart 源，见 api.js krNaverMinutes），所以开关也对韩股开放。
     * 拿不到数据时 hasExt 会因 ext=false 自动隐藏，不会留个点了没反应的按钮。 */
    const isKr = !!(a && a.grp === 'krstock');
    /* 还要看这一条序列实际有没有延展段：纳斯达克取数失败会回退东财常规时段，
     * 那时 data.ext=false，开关点下去毫无变化（用户会以为「没加载出来」）。
     * chart.extAvailable 由 charts.js 在每次 render 后写入。
     * v236：改成「必须确认为 true 才显示」，并靠 chart.onRendered 在每次渲染后
     * 重新同步一次。以前用 !== false，渲染前读到的是上一场的旧值（或 undefined），
     * 于是「这一场压根没取到盘前数据」也照样亮着一个点了没反应的「盘前分时」。 */
    const dataOk = !chart || chart.extAvailable === true;
    const hasExt = !!(a && a.tv && (isUS || isKr) && dataOk);
    const show = S.sheetMode === 'min' && hasExt;
    bar.hidden = !show;
    const note = $('#shMinNote');
    if (note) {
      let text = '';
      if (S.sheetMode === 'min' && !show && a) {
        if (a.grp === 'twstock') text = '台股没有美股式盘前盘后（盘后仅 14:00–14:30 定盘单一价，与收盘同价），故不提供延展时段分时';
        else if (a.grp === 'krstock') text = '韩股盘后（Nextrade 애프터마켓 15:40–20:00）分钟数据暂未取到；盘前 08:00–08:50 该源不提供';
        else if (a.grp === 'jpstock') text = '日股东证主板没有盘前盘后；Japannext「夜間PTS」17:00–06:00 有真实成交，但只提供最新价（见行情页「夜盤PTS」行），没有逐笔分时';
        /* v214：美股指数（纳指/费半/标普等）本身没有盘前盘后逐笔 —— 实测东财 trends2、
         * Nasdaq 官方 chart、Yahoo 三个源对指数都只返回常规时段 9:30–16:00 ET。
         * 按「没有数据就不给开关」的口径隐藏按钮，并说明原因，不拿 ETF/期货代画。 */
        /* VIX 例外：它走 CNBC 的 1 分钟线，覆盖 03:15–16:15 ET 的 GTH 全时段，
         * 那条「只有常规时段」的说明对它不成立，挂上去反而自相矛盾。 */
        else if ((a.grp === 'us' || a.grp === 'usstock') && a.kind === 'index' && !a.minSpan) text = '美股指数没有盘前盘后逐笔行情（东财 / Nasdaq / Yahoo 三源均只提供常规时段 9:30–16:00 ET），故不提供延展时段分时';
      }
      note.textContent = text;
      note.hidden = !text;
    }
    if (!show) return;
    // 按钮文案随时段切换：盘前时段显示「盘前分时」，其余（盘后 / 常规）显示「盘后分时」
    const st = w.Session && w.Session.state ? w.Session.state(S.sheetKey) : null;
    const secLabel = (st && st.phase === 'pre') ? '盘前分时' : '盘后分时';
    const secBtn = bar.querySelector('button[data-x="1"]');
    if (secBtn) secBtn.textContent = secLabel;
    const on = effMinExt();
    bar.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', (b.dataset.x === '1') === on);
    });
  }

  function syncSheetMode() {
    const key = S.sheetKey;
    const mode = S.sheetMode;
    const host = $('#chartHost');
    const ext = $('#shExt');
    if (!host) return;
    if (mode === 'ext') {
      host.style.display = 'none';
      ext.hidden = false;
      ext.innerHTML = extPanelHTML(key);
      $('#shLegend').innerHTML = '';
      syncMinBar();
      renderExtInline(key);
      return;
    }
    host.style.display = '';
    ext.hidden = true;
    syncMinBar();
    syncChartBar();
    if (!chart) return;
    chart.host = host;
    chart.legendEl = $('#shLegend');
    chart.showExt = effMinExt();
    /* v236：每次渲染结束后重新判定「盘前分时」开关要不要露出来（见 syncMinBar 的 dataOk） */
    chart.onRendered = syncMinBar;
    /* 画图工具：数量变化与工具切换回传给面板 */
    chart.onDrawCount = (n) => {
      const b = $('#dpClear');
      if (b) { b.disabled = !n; b.textContent = n ? ('清空(' + n + ')') : '清空'; }
    };
    chart.onDrawTool = (t) => {
      const p = $('#drawPanel');
      if (p) p.querySelectorAll('.dp-tool').forEach(x => x.classList.toggle('on', x.dataset.tool === t));
      const cb = $('#cbDraw');
      if (cb) cb.classList.toggle('on', !!t);
      syncChartInter();
    };
    /* v166：点了哪条线 / 换了什么颜色，色板要跟着高亮，
     * 否则用户不知道「现在这条线是哪个色、下一条会用哪个色」。 */
    chart.onColor = (c) => syncPaletteUI(c);
    /* v167：选中状态变化 → 面板的「删除选中」可用性 + 提示 */
    chart.onDrawSelect = () => { syncDrawSel(); syncChartInter(); };
    /* v171：主图指标切换结果回传 → 右上角按钮文案/可用态 */
    chart.onMainInd = (m, canUse) => syncIndBtn(m, canUse);
    /* render 是异步的：拿到数据后才知道有没有延展段，再同步一次开关显隐 */
    const _p = chart.render(key, mode);
    if (_p && _p.then) _p.then(() => { if (S.sheetKey === key) { try { syncMinBar(); syncChartBar(); } catch (e) {} } }).catch(() => {});
  }

  /* ---- v171：主图指标选择器（右上角） ----
   * 用户口径：要像图 2 那样有个明确的地方选「裸 K 线 / 主图公式」，
   * 之前那个浮在图上、10px 的小胶囊根本看不见。 */
  function syncIndBtn(m, canUse) {
    const b = $('#cbInd');
    if (!b) return;
    /* v184：参数齿轮已移进下拉菜单里的「三五法则」行，工具条不再单独占位 */
    b.textContent = (m === 's35' ? '三五法则' : '裸K') + ' ▾';
    b.classList.toggle('on', m === 's35' && !!canUse);
    b.classList.toggle('na', !canUse);
    b.title = canUse
      ? '主图指标：裸K线 / 三五法则（点击切换）'
      : '三五法则只在日线可用（分时/周线/月线先切回日K）';
  }

  function closeIndMenu() {
    const m = $('#indMenu');
    if (m) m.remove();
    if (S._indMenuDoc) {
      document.removeEventListener('pointerdown', S._indMenuDoc, true);
      S._indMenuDoc = null;
    }
  }

  function openIndMenu() {
    const b = $('#cbInd');
    if (!b || !chart) return;
    if ($('#indMenu')) { closeIndMenu(); return; }
    const cur = chart.mainInd || 'bare';
    const canUse = !!chart._ind;
    const m = document.createElement('div');
    m.id = 'indMenu'; m.className = 'ind-menu';
    /* v184：⚙ 放进「三五法则」这一行的右侧（图 2），工具条不再单列一个齿轮 */
    m.innerHTML =
      `<div class="ind-mi ${cur === 'bare' ? 'on' : ''}">`
      + `<button class="ind-mi-main" data-m="bare">裸 K 线<i>只画蜡烛，最干净</i></button></div>`
      + `<div class="ind-mi ${cur === 's35' ? 'on' : ''}${canUse ? '' : ' na'}">`
      + `<button class="ind-mi-main" data-m="s35">三五法则<i>RSI背离 · 计步 · 红黑棒${canUse ? '' : '（仅日线）'}</i></button>`
      + `<button class="ind-mi-cfg" id="indMenuCfg" title="三五法则参数设置（红黑棒 / 反向过滤）">⚙</button></div>`;
    document.body.appendChild(m);
    const r = b.getBoundingClientRect();
    m.style.top = Math.round(r.bottom + 6) + 'px';
    /* v211：竖屏下「三五法则」按钮贴在最左，原来用 right 锚定会让菜单从按钮右缘
     * 向左展开、溢出屏幕左边界被裁掉一半。改为按按钮左缘定位，再夹进视口
     * [8, innerWidth - 菜单宽 - 8]，右侧按钮也不会超出屏幕。 */
    const mw = m.offsetWidth || 200;
    const left = Math.max(8, Math.min(Math.round(r.left), Math.round(w.innerWidth - mw - 8)));
    m.style.left = left + 'px';
    m.style.right = 'auto';
    m.querySelectorAll('.ind-mi-main').forEach(x => {
      x.onclick = (e) => {
        e.stopPropagation();
        if (x.dataset.m === 's35' && !canUse) { toast2('三五法则只在日K可用，先切到日K'); closeIndMenu(); return; }
        chart.setMainInd(x.dataset.m);
        syncIndBtn(chart.mainInd, !!chart._ind);
        closeIndMenu();
      };
    });
    const cfgBtn = m.querySelector('#indMenuCfg');
    if (cfgBtn) cfgBtn.onclick = (e) => {
      e.stopPropagation();
      if (!canUse) { toast2('三五法则只在日K可用，先切到日K'); closeIndMenu(); return; }
      closeIndMenu();
      openIndCfg();
    };
    /* 点别处关掉（捕获阶段，避免被面板的「点空白关闭」抢走） */
    S._indMenuDoc = (e) => {
      if (!m.contains(e.target) && e.target !== b && !b.contains(e.target)) closeIndMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', S._indMenuDoc, true), 0);
  }

  /* ---- v172：指标参数设置（图三那种：参数名 / 最小值 / 当前值 / 最大值） ---- */
  function closeIndCfg() {
    const el = $('#indCfg');
    if (el) el.remove();
  }

  function openIndCfg() {
    if (!chart) return;
    const R = (w.Indicator && w.Indicator.paramRange) || {};
    const P = chart.indParams();
    const cur = Object.assign({}, P);
    const keys = Object.keys(R);
    if (!keys.length) { toast2('该指标没有可调参数'); return; }

    const rows = keys.map(k => {
      const r = R[k];
      return `<div class="icfg-row" data-k="${k}">
        <span class="icfg-n">${esc(r.label)}</span>
        <span class="icfg-min">${r.min}</span>
        <div class="icfg-step">
          <button data-d="-1" aria-label="减小">−</button>
          <b data-v>${cur[k]}</b>
          <button data-d="1" aria-label="增大">＋</button>
        </div>
        <span class="icfg-max">${r.max}</span>
      </div>`;
    }).join('');

    const tips = keys.map(k => `<li><b>${esc(R[k].label)}</b>（${R[k].min}~${R[k].max}）：${esc(R[k].desc || '')}</li>`).join('');

    const el = d.createElement('div');
    el.id = 'indCfg'; el.className = 'icfg';
    el.innerHTML = `<div class="icfg-hd">
        <button class="icfg-back" id="icfgBack">‹</button>
        <b>指标参数设置</b>
        <button class="icfg-save" id="icfgSave">保存</button>
      </div>
      <div class="icfg-body">
        <div class="icfg-name"><span>指标名称</span><b>三五法则</b><i class="icfg-tag">主图</i><i class="icfg-tag s">日线</i></div>
        <div class="icfg-sec">指标参数</div>
        <div class="icfg-head"><span>参数名</span><span>最小值</span><span>当前值</span><span>最大值</span></div>
        ${rows}
        <div class="icfg-sec">使用说明</div>
        <ul class="icfg-tips">${tips}</ul>
        <div class="icfg-note">参数与通达信一致，改完点「保存」立即重算（只影响主图显示，不改原始 K 线数据）。</div>
      </div>
      <div class="icfg-ft"><button id="icfgReset">恢复默认值</button></div>`;
    d.body.appendChild(el);

    el.querySelector('#icfgBack').onclick = closeIndCfg;
    el.querySelector('#icfgSave').onclick = () => {
      chart.setIndParams(cur);
      syncIndBtn(chart.mainInd, !!chart._ind);
      closeIndCfg();
      toast2('参数已保存：红黑棒 ' + cur.REDBLACK + ' · 反向过滤 ' + cur.REV_FILTER);
    };
    el.querySelector('#icfgReset').onclick = () => {
      const D = (w.Indicator && w.Indicator.paramDef) || { REDBLACK: 1, REV_FILTER: 1 };
      keys.forEach(k => { cur[k] = +D[k] ? 1 : 0; });
      el.querySelectorAll('.icfg-row').forEach(row => {
        const k = row.dataset.k;
        row.querySelector('[data-v]').textContent = cur[k];
      });
    };
    el.querySelectorAll('.icfg-step button').forEach(btn => {
      btn.onclick = () => {
        const row = btn.closest('.icfg-row');
        const k = row.dataset.k, r = R[k];
        const step = r.step || 1;
        let v = cur[k] + (btn.dataset.d === '1' ? step : -step);
        v = Math.max(r.min, Math.min(r.max, v));
        cur[k] = v;
        row.querySelector('[data-v]').textContent = v;
      };
    });
  }

  /* ---- v183：跳空缺口设置（开关 + 显示最近的几个未回补缺口） ---- */
  function gapCfgGet() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem('mm_gap_cfg') || '{}') || {}; } catch (e) {}
    let n = (c.n == null) ? 3 : (+c.n || 3);
    return { on: c.on !== false, n: Math.max(1, Math.min(20, n)) };
  }
  function gapCfgSet(o) {
    try { localStorage.setItem('mm_gap_cfg', JSON.stringify(o)); } catch (e) {}
    if (chart && chart.drawLayer) chart.drawLayer.redraw();
  }
  function closeGapCfg() { const el = $('#gapCfg'); if (el) el.remove(); }

  function openGapCfg() {
    closeGapCfg();
    const cur = gapCfgGet();
    const el = d.createElement('div');
    el.id = 'gapCfg'; el.className = 'icfg';
    el.innerHTML = `<div class="icfg-hd">
        <button class="icfg-back" id="gapCfgBack">‹</button>
        <b>跳空缺口设置</b>
        <button class="icfg-save" id="gapCfgDone">完成</button>
      </div>
      <div class="icfg-body">
        <div class="icfg-name"><span>辅助显示</span><b>跳空缺口</b><i class="icfg-tag s">K 线</i></div>
        <div class="icfg-sec">显示设置（改动立即生效）</div>
        <div class="gapcfg-row">
          <div><b>显示跳空缺口</b><span>只显示尚未回补的缺口；已经回补的自动不再显示。</span></div>
          <button class="sw ${cur.on ? 'on' : ''}" id="gapCfgOn"><i></i></button>
        </div>
        <div class="gapcfg-row">
          <div><b>显示缺口数量</b><span>填 3 = 只显示最近的 3 个未回补跳空缺口（1~20）。</span></div>
          <div class="icfg-step gapcfg-step">
            <button data-d="-1" aria-label="减少">−</button>
            <input type="number" id="gapCfgN" min="1" max="20" step="1" value="${cur.n}" inputmode="numeric" aria-label="显示缺口数量">
            <button data-d="1" aria-label="增加">＋</button>
          </div>
        </div>
        <div class="icfg-sec">说明</div>
        <ul class="icfg-tips">
          <li><b>灰色实体横线</b>＝尚未回补的跳空缺口区间，从缺口那根 K 线向右延伸到现在。</li>
          <li>上涨跳空：当根最低价高于前一根最高价；下跌跳空：当根最高价低于前一根最低价。</li>
          <li>之后只要有 K 线把价格走回并穿越整个缺口区间，即视为已回补，不再显示。</li>
          <li>当前页面能看到的最高价 / 最低价用中性灰数字标在对应 K 线旁，深浅主题下都清晰。</li>
        </ul>
        <div class="icfg-note">设置保存在本机，只影响主图显示，不改 K 线数据。</div>
      </div>`;
    d.body.appendChild(el);

    el.querySelector('#gapCfgBack').onclick = closeGapCfg;
    el.querySelector('#gapCfgDone').onclick = closeGapCfg;
    const onBtn = el.querySelector('#gapCfgOn');
    onBtn.onclick = () => {
      cur.on = !cur.on;
      onBtn.classList.toggle('on', cur.on);
      gapCfgSet({ on: cur.on, n: cur.n });
    };
    const nInput = el.querySelector('#gapCfgN');
    const setN = (v) => {
      cur.n = Math.max(1, Math.min(20, isFinite(v) ? Math.round(v) : cur.n));
      nInput.value = cur.n;
      gapCfgSet({ on: cur.on, n: cur.n });
    };
    nInput.onchange = () => setN(parseInt(nInput.value, 10));
    nInput.onkeydown = (e) => { if (e.key === 'Enter') nInput.blur(); };
    el.querySelectorAll('.icfg-step button').forEach(btn => {
      btn.onclick = () => setN(cur.n + (btn.dataset.d === '1' ? 1 : -1));
    });
  }

  /* ---- v164：等比/对数 + 画图工具 的界面同步 ---- */
  function syncChartBar() {
    const bar = $('#shChartBar');
    if (!bar) return;
    const isK = S.sheetMode !== 'min';
    /* v167：分时也要能设预警 —— 只把「等差/对数」「画」收起来，铃铛与全屏常驻；
     * 「暗盘·链上」那一页没有图，整条工具条直接收起。 */
    bar.hidden = (S.sheetMode === 'ext');
    const seg = bar.querySelector('#cbScale');
    if (seg) seg.hidden = !isK;
    const dr = bar.querySelector('#cbDraw');
    if (dr) dr.hidden = !isK;
    const ib = bar.querySelector('#cbInd');
    if (ib) ib.hidden = !isK;
    const gb = bar.querySelector('#cbGapCfg');
    if (gb) gb.hidden = !isK;   // 缺口只在 K 线周期有意义
    if (isK) syncIndBtn((chart && chart.mainInd) || 'bare', !!(chart && chart._ind));
    syncAlertBadge();
    const cur = (chart && chart.scaleMode) || (w.DRAW_SCALE && w.DRAW_SCALE.get()) || 'linear';
    bar.querySelectorAll('#cbScale button').forEach(b => b.classList.toggle('on', b.dataset.s === cur));
    const cb = $('#cbDraw');
    if (cb) cb.classList.toggle('on', !!(chart && chart.drawLayer && (chart.drawLayer.tool || chart.drawLayer.editOnly)));
    /* v186：把右侧价格轴的实际宽度交给 CSS，工具条整体左移，别压在坐标轴数字上 */
    let axisW = 64;
    try {
      if (chart && chart.chart && chart.chart.priceScale) {
        const aw = chart.chart.priceScale('right').width();
        if (aw > 0 && isFinite(aw)) axisW = Math.round(aw);
      }
    } catch (e) {}
    bar.style.setProperty('--axis-w', axisW + 'px');
    if (!isK) closeDrawPanel();
  }

  function ensureDrawPanel() {
    if ($('#drawPanel')) return;
    const div = d.createElement('div');
    div.id = 'drawPanel';
    div.className = 'draw-panel';
    div.hidden = true;
    div.innerHTML =
      '<div class="dp-h">画图工具</div>'
      + '<button class="dp-tool" data-tool="seg"><i>╱</i>线段</button>'
      + '<button class="dp-tool" data-tool="ray"><i>↗</i>射线</button>'
      + '<button class="dp-tool" data-tool="ext"><i>⇈</i>波段延伸</button>'
      + '<label class="dp-chk"><input type="checkbox" id="dp200" checked><span>显示 200% 目标</span></label>'
      + '<div class="dp-colors" id="dpColors"></div>'
      + '<div class="dp-pts" id="dpPts" hidden></div>'
      + '<div class="dp-acts"><button id="dpDel" disabled>删除选中</button></div>'
      + '<div class="dp-acts"><button id="dpClear" disabled>清空</button><button id="dpDone" class="pri">完成</button></div>'
      + '<div class="dp-tip">' + drawTipFor(null) + '</div>';
    d.body.appendChild(div);

    div.querySelectorAll('.dp-tool').forEach(b => {
      b.onclick = () => {
        const t = b.dataset.tool;
        const on = b.classList.contains('on');
        div.querySelectorAll('.dp-tool').forEach(x => x.classList.remove('on'));
        try { if (!on) localStorage.setItem('mm_draw_tool', t); } catch (e) {}
        if (chart) {
          chart.setTool(on ? null : t);
          /* 再点一次取消工具：只是不画新线，面板仍在编辑态（已有线照样能选/拖/删） */
          if (chart.drawLayer) chart.drawLayer.setEditOnly(true);
        }
        if (!on) b.classList.add('on');
        const cb = $('#cbDraw');
        if (cb) cb.classList.add('on');
        const tip = div.querySelector('.dp-tip');
        if (tip) tip.innerHTML = on ? drawTipFor(null) : drawTipFor(t);
      };
    });
    const chk = div.querySelector('#dp200');
    if (chk) {
      const on = !(chart && chart.drawLayer && chart.drawLayer.ext200 === false);
      chk.checked = on;
      chk.onchange = () => { if (chart) chart.setExt200(chk.checked); };
    }
    /* v166：画线颜色（六色，记住上次选择；新线用它，选中线点色板直接换色） */
    const cbox = div.querySelector('#dpColors');
    if (cbox && w.DrawLayer) {
      const PAL = w.DrawLayer.PALETTE;
      let cur = null;
      try { cur = localStorage.getItem('mm_draw_color'); } catch (e) {}
      if (!cur || PAL.indexOf(cur) < 0) cur = PAL[0];
      cbox.innerHTML = PAL.map(c => `<span class="dp-c" data-c="${c}" style="background:${c}"></span>`).join('');
      cbox.querySelectorAll('.dp-c').forEach(el => {
        el.classList.toggle('on', el.dataset.c === cur);
        el.onclick = () => {
          cbox.querySelectorAll('.dp-c').forEach(x => x.classList.remove('on'));
          el.classList.add('on');
          if (chart && chart.drawLayer) chart.drawLayer.setColor(el.dataset.c);
        };
      });
    }
    const clr = div.querySelector('#dpClear');
    if (clr) clr.onclick = () => { if (chart) chart.clearDraw(); };
    const del = div.querySelector('#dpDel');
    if (del) del.onclick = () => {
      if (!chart) return;
      if (chart.deleteDraw()) toast2('已删除选中的画线');
      syncDrawSel();
    };
    const done = div.querySelector('#dpDone');
    if (done) done.onclick = () => closeDrawPanel();
  }

  /* 选中线时锁住图表平移/缩放（v176） */
  function syncChartInter() {
    if (chart && chart.syncChartInteraction) { try { chart.syncChartInteraction(); } catch (e) {} }
  }

  /* v188：画图手势提示按当前工具给，避免选中/取消选中后提示串成「不点工具」 */
  function drawTipFor(t) {
    if (!t) return '<b>不点工具＝只编辑已有线</b>：可选中、拖动、删线、改点位，绝不会误画出新线。';
    if (t === 'ext') return '<b>波段延伸：在 A 点长按、拖到 B 点松手</b>定基准波段，'
      + '再<b>点一下 C</b>（回调结束的锚点），自动投射 100% / 200% 目标位；点一下不会落点。';
    return '<b>线段 / 射线：长按起笔、拖到终点松手</b>即成一条线（点一下不会落点）。';
  }

  /* 画图面板里「选中」相关状态（删除选中按钮 + 锚点价格输入框 + 提示文案） */
  function syncDrawSel() {
    const del = $('#dpDel');
    const id = (chart && chart.drawSelected) ? chart.drawSelected() : null;
    const has = !!id;
    if (del) del.disabled = !has;
    const box = $('#dpPts');
    if (box) {
      const item = has && chart.drawLayer ? chart.drawLayer.selectedItem() : null;
      if (!item || !item.pts || !item.pts.length) {
        box.hidden = true; box.innerHTML = '';
      } else {
        const dec = (chart && isFinite(chart.dec)) ? chart.dec : 2;
        const names = ['A', 'B', 'C', 'D', 'E'];
        const day = (t) => {
          try {
            const z = new Date(+t * 1000), p = (n) => String(n).padStart(2, '0');
            return z.getUTCFullYear() + '-' + p(z.getUTCMonth() + 1) + '-' + p(z.getUTCDate());
          } catch (e) { return ''; }
        };
        box.innerHTML = '<div class="dp-pts-h">锚点价格 · 可直接输入</div>'
          + item.pts.map((pt, i) => {
            const v = Number(pt.p);
            return '<div class="dp-pt"><label>' + (names[i] || (i + 1)) + '</label>'
              + '<input type="number" inputmode="decimal" step="' + Math.pow(10, -dec) + '"'
              + ' value="' + (isFinite(v) ? v.toFixed(dec) : '') + '"'
              + ' data-i="' + i + '" title="' + esc(day(pt.t)) + '"></div>';
          }).join('');
        box.hidden = false;
        box.querySelectorAll('input').forEach(inp => {
          inp.onchange = () => {
            const v = Number(inp.value);
            if (inp.value === '' || !isFinite(v)) { syncDrawSel(); return; }
            if (chart && chart.drawLayer && chart.drawLayer.setPointPrice(id, +inp.dataset.i, v)) {
              toast2('锚点价格已更新');
              syncDrawSel();
            } else syncDrawSel();
          };
          inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
        });
      }
    }
    const p = $('#drawPanel');
    const tip = p && p.querySelector('.dp-tip');
    if (tip && has) tip.innerHTML = '已选中一条线：可整体拖动、拖端点微调、改锚点价格、换色，点「删除选中」删除。';
    else if (tip) tip.innerHTML = drawTipFor(chart && chart.drawLayer ? chart.drawLayer.tool : null);
  }

  function toast2(msg) {
    const box = $('#toasts') || d.body;
    const el = d.createElement('div');
    el.className = 'toast mini';
    el.innerHTML = '<div class="t-b"><b>' + esc(msg) + '</b></div>';
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); }, 1800);
  }

  function syncPaletteUI(c) {
    const box = $('#dpColors');
    if (!box || !c) return;
    box.querySelectorAll('.dp-c').forEach(x => x.classList.toggle('on', x.dataset.c === c));
  }

  function openDrawPanel() {
    ensureDrawPanel();
    const p = $('#drawPanel');
    if (!p) return;
    if (S.sheetMode === 'min') { toast('画图工具只在 K 线周期可用'); return; }
    p.hidden = false;
    d.body.classList.add('draw-open');      // 横屏时把图表让出右侧一列（v179）
    /* v182：打开面板**不自动选工具**（用户口径：不点工具就是为了避免误触画出新线）。
     * 但面板开着时 editOnly=true，已有线照样能选中 / 拖端点 / 整条拖 / 删除 / 改点位。 */
    if (chart && chart.drawLayer) {
      chart.setTool(null);
      chart.drawLayer.setEditOnly(true);
      p.querySelectorAll('.dp-tool').forEach(x => x.classList.remove('on'));
    }
    if (chart && chart.drawLayer) syncPaletteUI(chart.drawLayer.currentColor());
    syncDrawSel();
    const cb = $('#cbDraw');
    if (cb) cb.classList.add('on');
    const chk = $('#dp200');
    if (chk && chart && chart.drawLayer) chk.checked = chart.drawLayer.ext200On();
    const clr = $('#dpClear');
    if (clr && chart) { const n = chart.drawCount(); clr.disabled = !n; clr.textContent = n ? ('清空(' + n + ')') : '清空'; }
  }

  function closeDrawPanel() {
    const p = $('#drawPanel');
    if (p) p.hidden = true;
    d.body.classList.remove('draw-open');
    if (chart) {
      if (chart.drawLayer) chart.drawLayer.setEditOnly(false);
      chart.setTool(null);
    }
    const cb = $('#cbDraw');
    if (cb) cb.classList.remove('on');
    syncChartInter();
  }

  /* ================= v167：股价预警 =================
   * 用户口径：铃铛按钮放在「画」右边；页面参考同花顺预警页，但**左边那一列分类整列不要**
   * （盘口指标 / 技术指标 / 走势异动 / 财务指标 / 选股指标），只留「股价提醒」8 个条件。
   * 检测靠前端轮询（QuoteHub 25s 缓存 + 15s 心跳），页面关掉就没人盯了 ——
   * 这点必须在界面上写清楚，不能让人以为能后台推送。 */
  const AL = { k: null, tab: 'add' };
  let alertTick = null;

  function alertTypeDef(t) {
    if (!w.Alert) return null;
    return w.Alert.types.filter(x => x.id === t)[0] || null;
  }

  function syncAlertBadge() {
    const n = $('#cbAlertN');
    if (!n) return;
    const k = S.sheetKey;
    const c = (w.Alert && k) ? w.Alert.countFor(k) : 0;
    n.hidden = !c;
    n.textContent = c > 99 ? '99+' : String(c);
  }

  function ensureAlertSheet() {
    if ($('#alertSheet')) return;
    const div = d.createElement('div');
    div.id = 'alertSheet';
    div.className = 'al-sheet';
    div.hidden = true;
    d.body.appendChild(div);
  }

  function openAlertSheet(k) {
    if (!w.Alert) { toast2('预警模块未加载'); return; }
    ensureAlertSheet();
    AL.k = k;
    AL.tab = 'add';
    const el = $('#alertSheet');
    el.hidden = false;
    el.style.zIndex = String(Math.max(150, (Number(getComputedStyle($('#sheet')).zIndex) || 95) + 10));
    initAlertEngine();
    renderAlertSheet();
  }

  function closeAlertSheet() {
    const el = $('#alertSheet');
    if (el) el.hidden = true;
    syncAlertBadge();
  }

  function alertNotifyPerm() {
    try {
      if (w.Notification && Notification.permission === 'default') Notification.requestPermission();
    } catch (e) {}
  }

  function renderAlertSheet() {
    const el = $('#alertSheet');
    if (!el || el.hidden) return;
    const k = AL.k;
    const a = U.get(k) || { name: k };
    const q = QuoteHub.get(k);
    const dec = U.decimals(k);
    const items = w.Alert ? w.Alert.forKey(k) : [];
    const fired = items.filter(x => x.firedAt).length;
    const ups = q && q.pct != null && q.pct >= 0;

    el.innerHTML = `
      <div class="al-panel">
        <div class="al-head">
          <button class="al-x" id="alClose" aria-label="关闭">✕</button>
          <div class="al-t">
            <b>${esc(a.name)}</b>
            <span>${esc(k)} · 最新
              <em class="qpx" data-k="${esc(k)}">${q && q.price != null ? U.fmt(k, q.price) : '--'}</em>
              <em class="${ups ? 'up' : 'down'} qp" data-k="${esc(k)}">${q ? U.pct(q.pct) : '--'}</em>
            </span>
          </div>
        </div>
        <div class="al-tabs">
          <button data-t="add" class="${AL.tab === 'add' ? 'on' : ''}">添加预警</button>
          <button data-t="list" class="${AL.tab === 'list' ? 'on' : ''}">当前预警${items.length ? ' <i>' + items.length + '</i>' : ''}</button>
        </div>
        <div class="al-body" id="alBody"></div>
        <div class="al-foot">
          <span>已添加条件 <b>${items.length}</b>${fired ? '（已触发 ' + fired + '）' : ''}</span>
          <button class="al-done pri" id="alDone">${AL.tab === 'add' ? '确认添加' : '完成'}</button>
        </div>
      </div>`;

    el.querySelector('#alClose').onclick = closeAlertSheet;
    el.querySelector('#alDone').onclick = () => {
      if (AL.tab === 'add') { AL.tab = 'list'; renderAlertSheet(); return; }
      closeAlertSheet();
    };
    el.querySelectorAll('.al-tabs button').forEach(b => {
      b.onclick = () => { AL.tab = b.dataset.t; renderAlertSheet(); };
    });

    const body = el.querySelector('#alBody');
    if (AL.tab === 'add') body.innerHTML = alertAddHTML(items, q, k, dec);
    else body.innerHTML = alertListHTML(items, k, q, dec);
    if (AL.tab === 'add') wireAlertAdd(body, k, q);
    else wireAlertList(body, k);
  }

  function alertAddHTML(items, q, k, dec) {
    if (!w.Alert) return '';
    const has = (t) => items.some(x => x.type === t);
    const unitOf = (t) => t.unit === 'pct' ? '%' : (t.unit === 'days' ? '日' : '');
    const rows = w.Alert.types.map(t => `
      <div class="al-row" data-t="${t.id}">
        <span class="al-lb">${t.label}</span>
        <button class="al-add${has(t.id) ? ' has' : ''}" data-t="${t.id}">${has(t.id) ? '再加一条' : '添加'}</button>
        <div class="al-form" hidden>
          <input class="al-inp" type="number" step="any" inputmode="decimal">
          <span class="al-unit">${unitOf(t)}</span>
          <button class="al-ok">确定</button>
          <button class="al-cancel">取消</button>
        </div>
      </div>`).join('');
    return rows + `
      <div class="al-note">
        <b>提示</b>：预警只在「异动看板」打开时检测（浏览器限制，关掉页面就停了）。
        点一次「添加」会申请系统通知权限，允许后停在别的页面也能收到横幅。
      </div>`;
  }

  function wireAlertAdd(body, k, q) {
    body.querySelectorAll('.al-row').forEach(row => {
      const t = row.dataset.t;
      const def = alertTypeDef(t);
      if (!def) return;
      const addBtn = row.querySelector('.al-add');
      const form = row.querySelector('.al-form');
      const inp = row.querySelector('.al-inp');
      addBtn.onclick = () => {
        if (def.unit === 'none') { doAlertAdd(k, t, null); return; }
        addBtn.hidden = true;
        form.hidden = false;
        /* 默认值：价格给现价、百分比给 3、N 日新高低给 20（用户参考图 3 就是 20 日） */
        inp.value = def.unit === 'price'
          ? (q && q.price != null ? String(q.price) : '')
          : (def.unit === 'days' ? String(def.def || 20) : '3');
        inp.focus();
        try { inp.select(); } catch (e) {}
      };
      row.querySelector('.al-cancel').onclick = () => { form.hidden = true; addBtn.hidden = false; };
      row.querySelector('.al-ok').onclick = () => {
        const v = parseFloat(inp.value);
        if (!isFinite(v)) { toast2('请填一个数字'); return; }
        doAlertAdd(k, t, v);
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') row.querySelector('.al-ok').click(); };
    });
  }

  function doAlertAdd(k, t, v) {
    if (!w.Alert) return;
    const item = w.Alert.add(k, t, v);
    if (!item) { toast2('这个条件添加失败，请检查数值'); return; }
    alertNotifyPerm();
    toast2('已添加：' + w.Alert.text(item, U.decimals(k)));
    renderAlertSheet();
    syncAlertBadge();
  }

  function alertListHTML(items, k, q, dec) {
    if (!items.length) {
      return '<div class="al-empty">还没有设置预警。<br>切到「添加预警」选一个条件吧 —— 比如「股价涨到 1,200」。</div>';
    }
    const now = q && q.price != null ? q.price : null;
    const cards = items.map(x => {
      const t = alertTypeDef(x.type);
      const fired = !!x.firedAt;
      const freqTxt = { once: '仅一次', daily: '每日一次', multi: '每日多次' }[x.freq || 'once'] || '仅一次';
      const when = fired ? new Date(x.firedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="al-item${fired ? ' fired' : ''}" data-id="${esc(x.id)}" title="点开编辑预警">
          <div class="al-i-b">
            <b>${esc(w.Alert.text(x, dec))}</b>
            <span>${fired ? ('已触发 · ' + when) : ('监控中 · ' + freqTxt + (now != null ? ' · 现价 ' + U.fmt(k, now) : ''))}</span>
          </div>
          ${fired ? '<button class="al-rearm">重新启用</button>' : ''}
          <button class="al-del">删除</button>
          <span class="al-i-arrow" aria-hidden="true">›</span>
        </div>`;
    }).join('');
    const log = (w.Alert.log() || []).filter(x => x.k === k).slice(-4).reverse();
    const logHTML = log.length ? `
      <div class="al-log">
        <div class="al-log-h">最近触发</div>
        ${log.map(x => `<div class="al-log-r"><span>${esc(w.Alert.text(x, dec))}</span><em>${new Date(x.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</em></div>`).join('')}
      </div>` : '';
    return `<div class="al-list">${cards}</div>${logHTML}
      <div class="al-note"><b>说明</b>：点卡片可编辑条件数值与提醒频次。「仅提醒一次」触发后预警自动消失；
      「每日一次 / 每日多次」会一直保留并继续监控。提醒只在「异动看板」打开时检测。</div>
      <div class="al-clear"><button id="alClearKey">清空该品种全部预警</button></div>`;
  }

  function wireAlertList(body, k) {
    body.querySelectorAll('.al-item').forEach(el => {
      const id = el.dataset.id;
      /* v189：点卡片（不点按钮）→ 打开「编辑预警」窗口 */
      el.onclick = (e) => {
        if (e.target.closest('button')) return;
        openAlertEdit(id);
      };
      const del = el.querySelector('.al-del');
      if (del) del.onclick = () => { w.Alert.remove(id); renderAlertSheet(); syncAlertBadge(); };
      const re = el.querySelector('.al-rearm');
      if (re) re.onclick = () => { w.Alert.rearm(id); renderAlertSheet(); syncAlertBadge(); };
    });
    const clr = body.querySelector('#alClearKey');
    if (clr) clr.onclick = () => { w.Alert.clearKey(k); renderAlertSheet(); syncAlertBadge(); };
  }

  /* ================= v189：编辑预警窗口 =================
   * 用户口径：点「当前预警」里的某条 → 弹出「编辑预警」页（参考通达信截图），
   * 只保留「预警条件」和「提醒频次」两张卡片。
   * 「推送方式」（APP / 微信 / PC 推送）整卡不出现 —— 我们做不到后台推送，
   * 挂在那里没有意义，也不许假装支持。
   * 提醒频次默认且仅支持「仅提醒一次」：触发并提醒后这条预警自动消失。 */
  function closeAlertEdit() {
    const el = $('#alertEdit');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function openAlertEdit(id) {
    if (!w.Alert) return;
    const it = (w.Alert.all() || []).filter(x => x.id === id)[0];
    if (!it) return;
    const k = it.k;
    const a = U.get(k) || { name: k };
    const q = QuoteHub.get(k);
    const def = alertTypeDef(it.type) || { label: '预警条件', unit: 'price' };
    const unit = def.unit === 'pct' ? '%' : (def.unit === 'days' ? '日' : '元');
    const dec = U.decimals(k);
    const up = !!(q && q.pct != null && q.pct >= 0);
    const curFreq = it.freq || 'once';
    let pickFreq = curFreq;
    closeAlertEdit();
    const div = d.createElement('div');
    div.id = 'alertEdit';
    div.className = 'al-edit';
    div.innerHTML = `
      <div class="ae-panel">
        <div class="ae-head">
          <button class="ae-back" id="aeBack" aria-label="返回">‹</button>
          <b>编辑预警</b>
          <button class="ae-x" id="aeX" aria-label="关闭">✕</button>
        </div>
        <div class="ae-quote">
          <div class="ae-qname"><b>${esc(a.name)}</b><span>${esc(k)}</span></div>
          <div class="ae-qnum">最新价 <em class="${up ? 'up' : 'down'}">${q && q.price != null ? U.fmt(k, q.price) : '--'}</em>
            <span class="${up ? 'up' : 'down'}">${q ? U.pct(q.pct) : '--'}</span></div>
        </div>
        <div class="ae-body">
          <section class="ae-card">
            <h3>预警条件</h3>
            <div class="ae-cond">
              <span class="ae-lb">${esc(def.label)}</span>
              <input id="aeVal" type="number" step="any" inputmode="decimal" value="${it.val == null ? '' : it.val}">
              <span class="ae-unit">${unit}</span>
            </div>
            <button class="ae-more" id="aeMore">+ 继续添加预警</button>
          </section>
          <section class="ae-card">
            <h3>提醒频次</h3>
            <div class="ae-freq${curFreq === 'once' ? ' on' : ''}" data-f="once">
              <div><b>仅提醒一次</b><span>股价触发、提醒完成，这条预警会自动消失</span></div><i>✓</i>
            </div>
            <div class="ae-freq${curFreq === 'daily' ? ' on' : ''}" data-f="daily">
              <div><b>每日一次</b><span>每天最多提醒一次，次日自动重新生效</span></div><i>✓</i>
            </div>
            <div class="ae-freq${curFreq === 'multi' ? ' on' : ''}" data-f="multi">
              <div><b>每日多次</b><span>每次股价重新触及条件都提醒</span></div><i>✓</i>
            </div>
          </section>
          <div class="ae-note">提醒仅在「异动看板」打开时检测；每次触发会留一条「最近触发」记录。</div>
        </div>
        <div class="ae-foot"><button class="ae-save pri" id="aeSave">保存预警</button></div>
      </div>`;
    d.body.appendChild(div);
    const back = () => { closeAlertEdit(); renderAlertSheet(); };
    div.querySelector('#aeBack').onclick = back;
    div.querySelector('#aeX').onclick = back;
    div.querySelector('#aeMore').onclick = () => {
      closeAlertEdit();
      AL.tab = 'add';
      renderAlertSheet();
    };
    /* v191：三个频次互斥可选，默认「仅提醒一次」 */
    div.querySelectorAll('.ae-freq').forEach(row => {
      row.onclick = () => {
        pickFreq = row.dataset.f;
        div.querySelectorAll('.ae-freq').forEach(x => x.classList.toggle('on', x === row));
      };
    });
    div.querySelector('#aeSave').onclick = () => {
      const v = parseFloat(div.querySelector('#aeVal').value);
      if (!isFinite(v)) { toast2('请填一个有效数值'); return; }
      if (def.unit === 'days' && v < 2) { toast2('天数至少 2 日'); return; }
      w.Alert.update(id, v, pickFreq);
      toast2('预警已保存');
      closeAlertEdit();
      renderAlertSheet();
      syncAlertBadge();
    };
  }

  /* 预警触发的表现：页面内红色 toast + 可选系统通知 + 一声提示音 */
  function alertFire(item, q) {
    const k = item.k;
    const a = U.get(k) || { name: k };
    const cond = w.Alert ? w.Alert.text(item, U.decimals(k)) : '';
    const nowTxt = (q && q.price != null) ? U.fmt(k, q.price) : '--';
    try { beep(2, 'price'); } catch (e) {}

    const box = $('#toasts') || d.body;
    const el = d.createElement('div');
    el.className = 'toast alert';
    el.innerHTML = `<span class="t-dot"></span>
      <div class="t-b"><b>🔔 ${esc(a.name)} 预警触发</b>
      <span>${esc(cond)} · 现价 ${esc(nowTxt)}</span></div>
      <button class="t-go">看图</button>
      <button class="t-x">✕</button>`;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    const kill = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); };
    const timer = setTimeout(kill, 20000);
    el.querySelector('.t-x').onclick = () => { clearTimeout(timer); kill(); };
    el.querySelector('.t-go').onclick = () => { clearTimeout(timer); kill(); openSheet(k); };
    while (box.children.length > 3) box.firstChild.remove();

    sysNotify('🔔 ' + a.name + ' 预警触发', cond + ' · 现价 ' + nowTxt, 'mm-alert-' + item.id, 'price');
  }

  function initAlertEngine() {
    if (!w.Alert || initAlertEngine._done) return;
    initAlertEngine._done = true;
    w.Alert.onFire = (item, q) => alertFire(item, q);
    w.Alert.onChange = () => { syncAlertBadge(); renderAlertSheet(); };
    /* N 日新高/新低要一个参照区间：用日 K 算「前 N 个交易日」的最高/最低
     * （把今天那根还没走完的剔掉，否则今天的高点永远等于现价，一加就触发）。 */
    const alertDailyCache = {};
    async function alertDailyRange(k, n) {
      const now = Date.now();
      let e = alertDailyCache[k];
      if (!e || now - e.at > 10 * 60000) {
        const d = await w.API.candles(k, 'd');
        e = alertDailyCache[k] = { at: now, pts: (d && d.points) || [] };
      }
      const pts = e.pts.slice();
      const today = new Date().toISOString().slice(0, 10);
      if (pts.length && new Date(pts[pts.length - 1].time * 1000).toISOString().slice(0, 10) === today) pts.pop();
      const arr = pts.slice(-Math.max(2, Math.round(n || 20)));
      let hi = null, lo = null;
      for (const p of arr) {
        if (isFinite(p.high) && p.high > 0) hi = (hi == null) ? p.high : Math.max(hi, p.high);
        if (isFinite(p.low) && p.low > 0) lo = (lo == null) ? p.low : Math.min(lo, p.low);
      }
      return { high: hi, low: lo };
    }

    const tick = async () => {
      try {
        const keys = w.Alert.activeKeys();
        if (!keys.length) return;
        await QuoteHub.refresh(keys.concat(S.sheetKey ? [S.sheetKey] : []));
        /* 先把「创新高/新低」的参照区间补齐 */
        const items = (w.Alert.all() || []).filter(x => !x.firedAt && (x.type === 'newHigh' || x.type === 'newLow'));
        const seen = {};
        for (const it of items) {
          const n = Math.max(2, Math.round(it.val || 20));
          const sk = it.k + ':' + n;
          if (seen[sk]) continue;
          seen[sk] = 1;
          try {
            const r = await alertDailyRange(it.k, n);
            if (r.high != null) w.Alert.daily[sk] = r;
          } catch (e) {}
        }
        w.Alert.check(QuoteHub.cache);
        syncAlertBadge();
      } catch (e) {}
    };
    if (!alertTick) alertTick = setInterval(tick, 15000);
    setTimeout(tick, 6000);
    d.addEventListener('visibilitychange', () => { if (!d.hidden) tick(); });
  }

  /* ---- v164：横屏全屏（画图时把图表铺满屏幕） ----
   * 用户的场景：手机竖屏 300px 高的图根本没法精细画线，参考图也是横屏大盘面。
   * 做法：body 挂 chart-fs 类 → 隐藏标题/周期条/资讯，图表 fixed 铺满；
   * 同时尝试原生全屏 + 锁横屏（Android Chrome 支持，WebView 里多半会被拒，拒了就只保留铺满效果）。 */
  function setFsBtn(on) {
    const btn = $('#cbFull');
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    /* v186：全屏后不再放 ✕（太容易误触），退出统一用手机返回键 */
    btn.textContent = '⛶';
    btn.title = '横屏全屏：图表铺满屏幕，方便画图（按手机返回键退出）';
    btn.hidden = !!on;
  }

  function ensureFsHint() {
    const old = document.getElementById('fsHint');
    if (old) old.parentNode && old.parentNode.removeChild(old);
    const h = document.createElement('div');
    h.id = 'fsHint'; h.className = 'fs-hint';
    h.innerHTML = '<span>已全屏 · 把手机横过来即可横向看图（点此关闭提示）</span>';
    h.onclick = () => { if (h.parentNode) h.parentNode.removeChild(h); };
    d.body.appendChild(h);
    /* 3.6 秒后自己淡出，不做常驻遮罩 —— 之前那个 inset:0 的提示层
     * 会把整个图表盖住点不到，等于「进了全屏反而不能画」。 */
    setTimeout(() => { if (h && h.parentNode) h.classList.add('out'); }, 3600);
    setTimeout(() => { if (h && h.parentNode) h.parentNode.removeChild(h); }, 4600);
  }

  /* 手机横竖屏 / 进出全屏时，图表容器尺寸会变；lightweight-charts 的 autoSize
   * 会自己重排，但覆盖层 canvas 必须跟着重算一次，否则画笔坐标会整体偏移。 */
  function _fsResizeSoon() {
    const kick = () => { if (chart && chart.drawLayer) chart.drawLayer.resize(); };
    [80, 260, 520, 900].forEach(t => setTimeout(kick, t));
  }

  function _tryLockLandscape(tries) {
    try {
      const so = w.screen && w.screen.orientation;
      if (!so || !so.lock) return;
      const p = so.lock('landscape');
      if (p && p.catch) p.catch(() => {
        /* 部分浏览器要求「进入全屏之后」才能锁方向，失败就再等一拍重试 */
        if (tries > 0) setTimeout(() => _tryLockLandscape(tries - 1), 320);
      });
    } catch (e) {
      if (tries > 0) setTimeout(() => _tryLockLandscape(tries - 1), 320);
    }
  }

  function enterChartFS() {
    d.body.classList.add('chart-fs');
    setFsBtn(true);
    /* v196：返回键交给统一分层返回栈；哨兵由全局 click / popstate 监听重算，
     * 这里不自己压，避免「关闭瞬间」多压一条导致返回键空转。 */
    const el = d.documentElement;
    let p = null;
    try {
      if (el.requestFullscreen) p = el.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) { p = null; }
    /* 用户口径：「要横向全屏，不是竖着铺满」。
     * Android Chrome/Edge 在真全屏下能强制锁横屏（即使系统关了自动旋转），
     * 这是唯一能让「点一下就变横屏」的路径；PWA/WebView 里锁不动的，
     * 靠 manifest 的 orientation:"any" 让用户转手机就能横过来，此时给一条轻提示。 */
    const after = () => {
      _tryLockLandscape(2);
      /* v255：WebView 里 screen.orientation.lock 通常锁不动 —— 直接调原生桥
       * 强制横屏（APK v1.5.8 NativePulse.setLandscape）。浏览器里没这个桥，静默跳过。 */
      try {
        const np = w.NativePulse;
        if (np && np.setLandscape) np.setLandscape(true);
      } catch (e) {}
      const portrait = () => (w.innerHeight || 0) > (w.innerWidth || 0);
      setTimeout(() => { if (portrait() && d.body.classList.contains('chart-fs')) ensureFsHint(); }, 700);
    };
    if (p && p.then) p.then(after).catch(() => after()); else after();
    _fsResizeSoon();
  }

  function exitChartFS() {
    if (!d.body.classList.contains('chart-fs')) return;
    d.body.classList.remove('chart-fs');
    setFsBtn(false);
    /* v180：退出全屏时画图面板必须一起收起。
     * 原来只退全屏、面板留着 → 面板是 position:fixed 的，退出后还挂在页面上
     * 盖住行情列表（用户反馈「退出全屏后划线工具还在页面上面」）。
     * 面板本来就属于「全屏画图」场景，退出即结束画图，语义也一致。 */
    try { closeDrawPanel(); } catch (e) {}
    const h = document.getElementById('fsHint');
    if (h && h.parentNode) h.parentNode.removeChild(h);
    try { if (d.fullscreenElement && d.exitFullscreen) d.exitFullscreen(); } catch (e) {}
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } catch (e) {}
    /* v255：退出图表全屏 → 回竖屏（与进入时 setLandscape(true) 配对） */
    try {
      const np = w.NativePulse;
      if (np && np.setLandscape) np.setLandscape(false);
    } catch (e) {}
    _fsResizeSoon();
    /* v272：退出全屏必须回收/重算 history 哨兵。
     * v197 把配对逻辑挪进 bkSync 后，只在 click/Esc/popstate 触发；
     * 原生返回键走 handleBack() 直接退全屏（无 click、无 popstate），
     * 哨兵就残留在 history 里，第二次返回空转 —— 这里补上配对。
     * 延迟 60ms：等 fullscreenchange 把 fullscreenElement 清空再重算。 */
    setTimeout(() => { try { bkSync(); } catch (e) {} }, 60);
  }

  function toggleChartFS() {
    if (d.body.classList.contains('chart-fs')) exitChartFS(); else enterChartFS();
  }

  /* 横竖屏切换 / 用户按返回键退出系统全屏时，同步状态并重算画笔尺寸 */
  w.addEventListener('orientationchange', () => setTimeout(_fsResizeSoon, 280));
  d.addEventListener('fullscreenchange', () => {
    _fsResizeSoon();
    if (!d.fullscreenElement && d.body.classList.contains('chart-fs')) exitChartFS();
  });
  /* ============ v196：手机返回键分层退出 ============
   * 原生壳 onBackPressed → web.canGoBack() → web.goBack() → popstate。
   * 只要当前有「可关闭的层」，就保持一条哨兵 history 条目；
   * 按返回键弹出哨兵 → 只关最上面那一层，回到它的主界面（新闻页/事件页/行情页），
   * 而不是直接走「再按一次退出 APP」。所有层都关掉后不再补哨兵，
   * 此时再按返回键才轮到原生双击退出，符合手机习惯。
   * 用户口径：行情详情→行情页、事件详情→事件页、新闻详情→新闻页。 */
  let bkGuard = false, bkIgnore = 0;

  function bkTop() {
    if ($('#alertEdit')) return closeAlertEdit;
    if ($('#gapCfg')) return closeGapCfg;
    if ($('#indCfg')) return closeIndCfg;
    const lk = $('#linkView'); if (lk && lk.classList.contains('on')) return closeLink;
    const pk = $('#picker'); if (pk && pk.classList.contains('on')) return () => pk.classList.remove('on');
    const sm = $('#sModal'); if (sm && sm.classList.contains('on')) return () => sm.classList.remove('on');
    if (d.body.classList.contains('chart-fs')) return exitChartFS;
    /* v272【全屏返回按两次 · 网页侧配对】系统全屏（赚钱效应 iframe 全屏等）
     * 也要算一层。原来 bkTop 只认 chart-fs，iframe 全屏时顶层是 null、不压哨兵，
     * H5 层级与原生/浏览器的全屏状态对不齐。 */
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      return function exitSysFs() { try { if (w.__exitFs) w.__exitFs(); } catch (e) {} };
    }
    const ns = $('#newsSheet'); if (ns && ns.classList.contains('on')) return closeNews;
    const sh = $('#sheet'); if (sh && sh.classList.contains('on')) return closeSheet;
    if (S.eventOpen) return () => { S.eventOpen = null; renderEvent(); };
    const dp = $('#drawPanel'); if (dp && !dp.hidden) return closeDrawPanel;
    return null;
  }

  function bkSync() {
    const has = !!bkTop();
    if (has && !bkGuard) {
      try { w.history.pushState({ mmGuard: 1 }, ''); bkGuard = true; } catch (e) {}
    } else if (!has && bkGuard) {
      bkGuard = false;
      bkIgnore++;
      try { w.history.back(); } catch (e) { bkIgnore--; }
    }
  }

  w.addEventListener('popstate', () => {
    if (bkIgnore > 0) { bkIgnore--; return; }
    if (!bkGuard) return;
    bkGuard = false;                 // 哨兵已被返回键弹出
    const fn = bkTop();
    if (fn) { try { fn(); } catch (e) {} }
    /* v257【返回键退出全屏要回竖屏】原生侧 onHideCustomView 已补方向恢复；
     * 这里再兜一层：任何一层被返回键关掉后，只要当前没有系统全屏元素，
     * 就把 WebView 方向恢复成竖屏，避免停在横屏要用户手动翻转。 */
    setTimeout(() => {
      try {
        const np = w.NativePulse;
        if (np && np.setLandscape && !d.fullscreenElement) np.setLandscape(false);
      } catch (e) {}
    }, 80);
    /* 关掉一层后重算：还有层 → 再压一条哨兵（下次继续逐层退）；
     * 没有层 → 不补，下一次返回键才轮到原生「再按一次退出 APP」。 */
    setTimeout(() => { try { bkSync(); } catch (e) {} }, 0);
  });
  /* 任何点击 / Esc 之后重算哨兵（覆盖点 ×、点返回按钮、点空白关闭等所有入口） */
  d.addEventListener('click', () => setTimeout(() => { try { bkSync(); } catch (e) {} }, 0), true);
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTimeout(() => { try { bkSync(); } catch (er) {} }, 0); });
  /* v1.5.10：原生返回键会调它 —— 除了退出主站 chart-fs，还要通知赚钱效应
   * iframe 退出它自己的全屏（iframe 的 fullscreenElement 在 iframe 文档里，
   * 父页面 document.exitFullscreen() 管不到），否则竖屏回来了但页面还是全屏态。 */
  w.__exitFs = () => {
    if (d.body.classList.contains('chart-fs')) exitChartFS();
    /* v266：赚钱效应 iframe 的全屏由顶层文档发起，返回键要同时退全屏 + 回竖屏 */
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement)
        (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d);
    } catch (e) {}
    try { if (w.NativePulse && w.NativePulse.setLandscape) w.NativePulse.setLandscape(false); } catch (e) {}
    try {
      const f = $('#effectFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage({ mm_exit_fs: 1 }, '*');
    } catch (e) {}
    const fb = $('#effFull'); if (fb) fb.textContent = '全屏';
    /* v272：原生返回键调这里退全屏，同样要重算哨兵（无 click / 无 popstate） */
    setTimeout(() => { try { bkSync(); } catch (e) {} }, 60);
  };
  w.__bkSync = bkSync;
  /* 返回栈调试/测试句柄：只读，不参与业务逻辑（供 tools/check_back_fullscreen.py 实测） */
  w.__bkDebug = function () {
    const f = bkTop();
    return {
      guard: bkGuard, ignore: bkIgnore, top: f ? (f.name || 'anon') : null,
      fs: !!(d.fullscreenElement || d.webkitFullscreenElement),
      chartfs: d.body.classList.contains('chart-fs'),
      state: w.history.state || null
    };
  };

  function closeSheet() {
    try { closeDrawPanel(); } catch (e) {}
    try { exitChartFS(); } catch (e) {}
    const sheet = $('#sheet');
    sheet.classList.remove('on');
    sheet.style.zIndex = '';   // 还原内联 z-index，免得影响下次的层叠
    syncLock();
  }

  /* ---------------- 真实快讯接入 ---------------- */
  let liveIds = new Set();

  function normItem(it) {
    /* 空值保护：hydrateFromPool / backfill / pollFlash 三条链路都会调它，
     * 任何一条传进半成品（null、无 id、无标题）都不能把整个首屏打崩 ——
     * 之前 normItem(null) 抛异常，直接导致「刷新后全屏空白 10 秒」。 */
    if (!it || !it.id || !it.title) return null;
    const item = {
      id: it.id,
      ts: it.ts ? new Date(it.ts).getTime() : Date.now(),
      level: (it.level || 'A').toUpperCase(),
      cat: it.cat || '快讯',
      region: it.region || '',
      title: it.title,
      brief: it.brief || '',
      /* 【中英对照】订阅源（川普推文 / 口罩哥）的英文原文必须带进信息流对象。
       * 池子和抓取链路都存了 titleEn / briefEn，但这里只映射固定字段，
       * 少这两行 → 卡片和详情页永远拿不到原文，中英对照等于没做。 */
      titleEn: it.titleEn || '',
      briefEn: it.briefEn || '',
      src: it.src || '实时源',
      url: it.url || '',
      /* 【关键】标红标记必须带进信息流对象。
       * 以前这里没有 important，导致 S.news 里每条 important 都是 undefined，
       * 「只显示标红」的 passRed 闸完全失效（red 统计永远是 0），
       * 用户才会看到 300+ 条非标红新闻 —— 这是「只标红没效果」的真正根因。 */
      important: !!it.important,
      impIdx: Number(it.impIdx || 0),
      direct: Array.isArray(it.direct) ? it.direct.filter(x => x && U.get(x.k)) : [],
      cn: Array.isArray(it.cn) ? it.cn.filter(x => x && U.get(x.k)) : [],
      us: Array.isArray(it.us) ? it.us.filter(x => x && U.get(x.k)) : [],
      hk: Array.isArray(it.hk) ? it.hk.filter(x => x && U.get(x.k)) : [],
      // 行情验证结果：新闻声称的「拉升/暴跌」是否被 K 线印证（由 news-spike 回写）
      assets: Array.isArray(it.assets) ? it.assets
        : (Array.isArray(it.direct) ? it.direct.map(x => x && x.k).filter(Boolean) : []),
      spike: it.spike || null,
      chain: Array.isArray(it.chain) ? it.chain : null,
      noAsset: !!it.noAsset,
      // 公司类新闻的标记要带进前端：合并/归因时不能给它挂宏观标的
      firm: !!(it.firm || it.cat === '公司事项' || it.cat === '公司重大'),
      // 分级规则版本：写进池子，下次启动时版本对不上就用新规则重算
      gv: it.gv || (w.LiveNews && w.LiveNews.GRADE_VER) || 0,
      live: true
    };
    /* 用户手改过的分级必须一路带着走：池子会按 gv 重算，
     * 不在这里覆盖的话，重启一次改判就白做了。 */
    return fixApply(item);
  }

  /* ---------------- 本地缓存池（localStorage · 72 小时 · 上限 800 条） ----------------
   * 用户诉求：「每次打开 H5 都是刷新抓取的，而且只抓取最近几条。
   *   如果我没打开页面的时候有暴涨暴跌我也不知道。」
   *
   * 所以打开页面不再等网络：先把上次落盘的**已富化**条目（已分级 / 已翻译 /
   * 已打标）按 ts 倒序铺到首屏，再去补增量。缓存模块在 pool.js。 */
  function hydrateFromPool() {
    const P = w.NewsPool;
    if (!P) return 0;
    let list = [];
    try { list = P.list(72) || []; } catch (e) { return 0; }
    if (!list.length) return 0;
    list.sort((a, b) => b.ts - a.ts);
    const out = [];
    const GV = (w.LiveNews && w.LiveNews.GRADE_VER) || 0;
    list.forEach(it => {
      try {
      if (!it || !it.id || !it.title) return;
      /* 池子里历史残留的 C 级（v76 那版曾把「值得复核的 C」留过池，
       * 后来用户否掉了）直接跳过 —— 否则「C」档计数永远挂着个 1，
       * 用户看着就是「C 不是让你去掉了吗怎么还有」。 */
      if (String(it.level || '').toUpperCase() === 'C') return;
      /* v119 回退 v101：冷启动首屏也铺全部快讯（含非标红普通稿），
       * 不再按 important 过滤 —— 红闸已移到渲染层且默认关闭。仅 C 级不进流。 */
      let src = it;
      /* 分级口径升级过（gv 对不上）→ 用当前规则重算一遍再铺。
       * 不重算的话，池子里 72 小时的旧分级会一直生效：
       * 用户报「A 类 143 条」，其中大半是老口径放进来的，
       * 光改规则不改存量，用户永远看不到变化。 */
      if (GV && it.gv !== GV) {
        let fresh = null;
        try {
          fresh = w.LiveNews._enrich({
            id: it.id, ts: it.ts, title: it.title, brief: it.brief,
            src: it.src, url: it.url, important: it.important,
            stocks: it.stocks, titleEn: it.titleEn, briefEn: it.briefEn,
          });
        } catch (e) { fresh = null; }
        /* 【不因重算判 C 就丢】重算是为了口径升级后更正分级，
         * 但它是拿池子里的精简字段算的，判不准时会返回 null。
         * 直接丢掉的后果就是用户看到的「刷新一下 72 条变 11 条」。
         * 标红条目（平台已判为重要）宁可保留原级别，也不让它在首屏消失。 */
        if (fresh) src = fresh;
        /* v119：重算失败的非标红条目保留原级别，不再丢弃（回退「什么都抓」）。
         * 原 C 级已在上方被 C 跳过挡住，不会漏进流。 */
        /* 标红 → 保留原级，条数不缩。
         * 【别再写 src = fresh】fresh 为 null 时这行会把 src 冲成 null，
         * 紧接着 normItem(null) 抛 TypeError，整个 hydrateFromPool 中断，
         * buildNews 的 catch 把 S.news 清空 —— 用户看到的就是
         * 「下拉后全屏空白、等近 10 秒才靠网络把新闻拉回来」。
         * 这条分支一旦走到（每次分级口径升级后的首次启动都会走到），
         * 缓存等于白存。 */
      }
      const n = normItem(src);
      if (!n) return;              // 单条数据不全就跳过，绝不让它拖垮整个首屏
      n.fromCache = true;          // 标记来源：这批是本地缓存，不是本轮抓到的
      /* 【口径版本写回】normItem 只映射固定字段，会把 gv 丢掉。
       * 这里补回当前口径版本，随后 poolSync() 会把它 merge 回池子 ——
       * 下次启动这条就不再被当成"旧口径"重算，缓存条数才能稳定不缩。 */
      if (GV) n.gv = GV;
      out.push(n);
      liveIds.add(it.id);          // 后续轮询遇到同一个 id 不再重复插入
      } catch (e) { /* 单条脏数据只丢这一条，绝不让整池首屏陪葬 */ }
    });
    /* 先把「已灌入的部分」落到 S.news —— 后面的处理即使出问题，
     * 首屏也绝不会是空的（这是「下拉后全屏空白」的最后一道兜底）。 */
    S.news = out;
    /* 【v56 存量窄合并】只走「地缘同事件」一条判据（同实体 + 同动作 + 6h + 数字不冲突），
     * 用来清掉用户截图里那几对历史重复（也门爆炸声 / 霍尔木兹油轮起火 / 胡塞空袭）。
     * 不走全局 _dedupe —— 原因见下面那段（会误合真实不同的新闻、条数骤降）。 */
    try {
      if (w.LiveNews && typeof w.LiveNews.mergeGeoDup === 'function') {
        S.news = w.LiveNews.mergeGeoDup(S.news);
      }
    } catch (e) { /* 合并失败不影响首屏，保持原样 */ }
    /* 【不再在启动时全局 _dedupe —— 这就是「刷新后 73 条变 40 条、10 秒后又回 73」的根因】
     *
     * _dedupe（dedupe()）的判重比运行时 pollFlash 用的 findDup 激进得多：
     *   dedupe 用 3 天窗口 + sameNewsBody / sameMoveBurst / sameSyncEvent，
     *   findDup 用 6 小时窗口 + 长度预筛。
     * 结果就是：运行时能合法共存的条目（不同公司的回购、不同市场的熔断、
     *   不同人物的发言）被 findDup 判为「不是同一件事」而各自入库；
     *   重载时 _dedupe 却把它们当成「同一件事」合并掉 —— 条数骤降。
     * 10 秒后 pollFlash 又把这批「被误合并」的新闻抓回来，条数又涨回去。
     * 用户看到的就是「下拉后先变少、再等几秒变回来」，跟「只增不减」背道而驰。
     *
     * 而且 _dedupe 合并掉的是**真实不同的新闻**（中际旭创回购 ≠ 联讯仪器回购），
     * 属于误合并，不该保留。真正的跨源跨轮去重由运行时 findDup 负责，
     * 池子在写入前也已经过 collect 的 dedupe(kept)，这里再全局重排属于重复去重。
     *
     * 所以这里直接信任池子：池子有多少、页面就显示多少，与运行时保持一致，
     * 重载后条数不再跳变（唯一例外是 24 小时窗口自然滚动把旧闻推出列表）。 */
    /* 立刻把补好的 gv 写回池子：否则要等下一轮网络抓取才 merge，
     * 用户一重载又全部重算一遍（就是「刷新后条数骤降」）。 */
    try { poolSync(); } catch (e) { /* 落盘失败不影响首屏 */ }
    return out.length;
  }

  /** 把当前信息流回写进池子（pool 内部 5 秒合并一次落盘，配额不足自动降级） */
  function poolSync() {
    const P = w.NewsPool;
    if (!P) return;
    try {
      P.prune(72);                 // 先清掉超过 3 天的
      P.merge(S.news.filter(n => n && !n.demo));
    } catch (e) { /* 缓存坏了只是不落盘，不能影响信息流渲染 */ }
  }

  let bfStarted = false;

  /** 首屏之后做一次「过去 24 小时回溯」，补齐没打开页面时漏掉的暴涨暴跌 */
  function startBackfill() {
    if (bfStarted) return;
    if (!w.LiveNews || !w.LiveNews.backfill) return;

    let st = null;
    try { st = w.NewsPool ? w.NewsPool.stats() : null; } catch (e) { st = null; }
    let lastAt = 0;
    try { lastAt = Number(store.get('mm_bfAt', 0)) || 0; } catch (e) { lastAt = 0; }
    // 池子已经覆盖满 24 小时、且 6 小时内回溯过 → 跳过，别每次刷新都去翻页
    if (st && st.total >= 20 && st.spanH >= 23 && Date.now() - lastAt < 6 * 3600 * 1000) return;

    bfStarted = true;
    try { store.set('mm_bfAt', Date.now()); } catch (e) {}

    w.LiveNews.backfill(24, items => {
      if (!items || !items.length) return;
      let added = 0, merged = 0;
      items.forEach(it => {
        if (!it || !it.id || !it.title) return;
        if (S.news.some(n => n.id === it.id)) return;
        if (liveIds.has(it.id)) return;
        // 缓存条目和网络新条目共用同一套判重内核，绝不会出现两张重复卡
        const dup = w.LiveNews.findDup(S.news, it, 6 * 3600 * 1000);
        if (dup) { w.LiveNews.mergeNews(dup, it); fixApply(dup); merged++; return; }
        liveIds.add(it.id);
        const n = normItem(it);
        if (!n) return;              // 半成品不入流，避免 null 进渲染
        S.news.push(n);
        added++;
      });
      S.news.sort((a, b) => b.ts - a.ts);
      poolSync();
      if (added || merged) { renderFeed(); renderSNR(); renderSrcGrid(); }
    }).catch(() => { /* 回溯失败就维持现状，用户看到的是缓存 + 正常轮询 */ });
  }

  async function pollFlash(soft) {
    const firstPoll = !pollFlash._inited;
    pollFlash._inited = true;
    /* 冷启动（清过缓存/首次打开）先把状态置成「正在接入」，别让顶部显示「未接入」
     * 误导用户以为抓取坏了 —— 池子里本就有上次的内容在展示，只是源还在连。 */
    /* 【v201】只有「冷启动首次接入」才逐源刷状态区。
     * 以前 soft=true（用户主动下拉）也会 showStatus=true，于是 S._srcProg 被清空、
     * 每个源就绪就重绘一次 —— 用户看到「10 个源瞬间变 9 个、过一会又接回 10 个」，
     * 像把全部源重新连了一遍。快讯本就 25 秒自动轮询，下拉只负责「立刻拿最新」，
     * 源连接状态保持不动（后台轮询会照常如实更新，某源真挂了仍会显示）。 */
    const showStatus = firstPoll;
    if (firstPoll && S.flashState !== 'live') S.flashState = 'connecting';
    if (firstPoll) S._srcProg = [];
    /* 逐源进度：每个源一就绪就刷新源状态网格（1/11 → 11/11），避免「正在接入」死板不动 */
    const onProg = (p) => {
      if (!p || !showStatus) return;
      const i = S._srcProg.findIndex(d => d.name === p.name);
      const rec = { name: p.name, ok: p.ok, count: p.count, err: p.err || '', via: '' };
      if (i >= 0) S._srcProg[i] = rec; else S._srcProg.push(rec);
      S.liveStats = {
        srcDetail: S._srcProg.slice(),
        sources: S._srcProg.filter(d => d.ok).map(d => d.name + ':' + d.count),
        restored: false, connecting: true,
      };
      renderSrcGrid(); renderSNR();
    };
    /* soft = 应用内下拉刷新：跳过 25 秒 TTL 立刻拿最新，
     * 但绝不重载页面，也不重建任何已连通的源。 */
    const res = soft && w.API && typeof w.API.newsSoft === 'function'
      ? await w.API.newsSoft(showStatus ? onProg : null)
      : await w.API.news(false, showStatus ? onProg : null);
    if (!res) {
      /* 下拉抓取失败：保持现有「全部已连接」，别把顶栏打成「未接入」 */
      if (!soft) S.flashState = 'off';
      if (showStatus) { renderSNR(); renderSrcGrid(); }
      return;
    }
    // 统计先落库：即使这轮一条都没抓到，逐源状态也得能显示「哪些源挂了、为什么」
    if (res.stats) {
      saveSrcState(res.stats);
      /* v201：下拉期间不用本轮逐源进度覆盖（刚开抓时只完成了一部分源，
       * 覆盖就会短暂显示 9/N），保持 10/10；后台 25s 轮询照常更新，
       * 某源真挂了依然会如实显示掉线。 */
      if (!soft) S.liveStats = res.stats;
      if (showStatus) { renderSrcGrid(); renderSNR(); }
    }
    if (!res.items || !res.items.length) {
      const det = srcDetailList();
      const anyOk = det.some(d => d.ok);
      S.flashState = anyOk ? 'live' : 'off';
      if (showStatus) { renderSNR(); renderSrcGrid(); }
      return;
    }
    S.flashState = 'live';

    let added = 0, newS = null, merged = 0;
    const freshItems = [];
    const LN = w.LiveNews;
    res.items.forEach(it => {
      if (!it || !it.id || !it.title) return;
      const norm = normItem(it);
      if (!norm) return;           // 兜底：normItem 有权拒收不合格条目
      const idx = S.news.findIndex(n => n.id === it.id);
      if (idx >= 0) {
        // 保留上一次的行情验证结果，别被重新拉取的原始条目冲掉
        const prev = S.news[idx];
        S.news[idx] = Object.assign(norm, {
          spike: (prev && prev.spike) || norm.spike || null,
          /* 【关键】fromCache 必须一起保留。
           * 这批条目最早是 hydrateFromPool() 从本地缓存灌进来的（fromCache=true），
           * 结果 norm 里没有这个字段，一覆盖就丢了「这是缓存里的旧条目」标记 ——
           * 于是老 S 级快讯被当成「本轮新抓到」，冷启动时又顶一次横幅。
           * 这正是用户反馈的「关掉 app 再打开，S 级预警又跑出来」。 */
          fromCache: (prev && prev.fromCache) || false
        });
        return;
      }
      if (liveIds.has(it.id)) return;
      /* 【跨轮去重】
       * 不同源报同一件事：id 全不一样，标题还常带【】前缀或长短差异。
       * 所以除了 id，还要按「同一事件」判一次 —— 6 小时内命中就合并来源，
       * 而不是再插一条。用户看到的「前两分钟显示过、后两分钟又出现」
       * 就是缺了这一步。 */
      if (LN && LN.findDup) {
        const dup = LN.findDup(S.news, norm, 6 * 3600 * 1000);
        if (dup) {
          LN.mergeNews(dup, norm);
          /* 合并会把级别按规则重算 —— 用户手工改判过的要立刻盖回来，
           * 否则「改判 B→A」遇到另一家媒体报同一件事就悄悄退回 B。 */
          fixApply(dup);
          // 合并后按显示标题重算成 C 的，等同于「这条不该进流」，撤掉
          if (dup.level === 'C') {
            const di = S.news.indexOf(dup);
            if (di >= 0) S.news.splice(di, 1);
          }
          liveIds.add(it.id);   // 记住这个 id，避免每轮重复合并
          merged++;
          return;
        }
      }
      liveIds.add(it.id);
      S.news.push(norm);
      freshItems.push(norm);
      added++;
      if (norm.level === 'S' && !firstPoll) newS = norm;
    });

    S.news.sort((a, b) => b.ts - a.ts);
    if (added || merged) renderFeed();
    poolSync();
    if (showStatus) { renderSNR(); renderSrcGrid(); }
    if (S.tab === 'set') renderSettings();
    // 事件页的「相关报道」要跟着快讯实时增长
    if (S.tab === 'event') renderEvent();
    if (newS) sAlert(newS);
    else if (firstPoll) {
      /* 冷启动：只有「本轮真实抓到、此前从未出现过」的 S 级才需要报。
       * 缓存里的旧条目（fromCache）不算新事件 —— 用户口径
       * 「出现过预警就不再出现，除非振幅持续扩大」。 */
      const freshS = S.news.filter(n => n.level === 'S' && n.live === true
        && !n.fromCache && !sLevelSeen(n.id));
      if (freshS.length) {
        if (S.modalOn) sAlert(freshS[0]);
        else showSoftSBanner();
      }
    }
    /* 全屏强提醒被用户关掉时，顶部软横幅是「新事件一定被报到」的兜底通道 */
    if (!S.modalOn) showSoftSBanner();

    // 新闻驱动异动：新到的新闻里若有「突然拉升/暴跌」表述，
    // 拿该品种真实分钟线验证，通过就生成「新闻已验证」异动并重绘信息流角标
    if (freshItems.length && radar) {
      radar.ingestNews(freshItems).then(list => {
        if (!list || !list.length) return;
        if (S.tab === 'flash') renderFeed();
        // 新闻补获的异动直接落到异动页，立即可见
        if (S.tab === 'radar') renderRadar(Object.values(radar.state), radar);
      }).catch(() => {});
    }
  }

  /* ---------------- 应用内下拉刷新（v101） ----------------
   * 用户口径（11-06）：「下拉刷新的时候所有的源会重新连接，其实不需要…
   * 我下拉刷新更多的用意还是为了让新闻显示到最新」。
   *
   * 根因：以前根本没有应用内下拉手势，用户下拉触发的是**浏览器原生整页重载**
   * （index.html 里那句「刷新是整页重载」说的就是它）。整页一重载，9 个源
   * 全部重新初始化，状态格又从「连接中」亮一遍。
   * 其实快讯本来就每 25 秒自动轮询、行情每 30 秒刷新，新闻一直在实时更新。
   *
   * 现在：用手势接管下拉，只做一次「立即拉取」，页面不重载、连接不重建；
   * 走 API.newsSoft → LiveNews.collect(soft) 跳过 TTL，并对上一轮失败的源
   * 清掉失败缓存强制重试。已有连接在正常轮询，不会被打断开。 */
  const PULL_TRIGGER = 72;
  let pullY0 = 0, pullDy = 0, pullActive = false, pullBusy = false;

  function pullHintSet(dy, ready, text) {
    const el = $('#pullHint');
    if (!el) return;
    el.style.height = Math.max(0, Math.min(dy, 92)) + 'px';
    if (text) el.textContent = text;
    else el.textContent = ready ? '松开立即刷新快讯' : '下拉刷新快讯';
    el.classList.toggle('ready', !!ready);
  }
  function pullToast(msg) {
    const box = $('#toasts');
    if (!box) return;
    const el = d.createElement('div');
    el.className = 'pull-toast';
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 260); }, 2200);
  }
  async function pullRefresh() {
    if (pullBusy) return;
    pullBusy = true;
    pullHintSet(46, false, '正在拉取最新快讯…');
    const before = S.news.length;
    try {
      await pollFlash(true);
      const delta = S.news.length - before;
      pullToast(delta > 0 ? '已拉取最新快讯 · 新增 ' + delta + ' 条' : '已是最新 · 无新增快讯');
    } catch (e) {
      pullToast('刷新未完成，25 秒后会自动重试');
    }
    pullHintSet(0, false, '下拉刷新快讯');
    pullBusy = false;
  }
  /* ---------------- 重载后恢复滚动位置 ----------------
   * 微信 X5/XWeb 等 webview 的下拉刷新是 webview 层实现的（不走浏览器的
   * overscroll 规则），前端 preventDefault 拦不住，只能真重载。
   * 那就把重载做成「用户感知不到」：内容由本地池 100ms 内铺满，
   * 滚动位置也回到原处 —— 用户看到的是「下拉一下，位置没动，多了几条新的」。 */
  const SCROLL_KEY = 'mm_scroll_v1';
  function bindScrollMemo() {
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
    const save = () => {
      try { sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY || 0))); } catch (e) {}
    };
    /* 滚动时实时记（节流 300ms）。
     * 只靠 pagehide/beforeunload 不可靠：部分 webview 被下拉刷新重载时
     * 这两个事件不保证触发，位置就丢了。 */
    let stTimer = null;
    window.addEventListener('scroll', () => {
      if (stTimer) return;
      stTimer = setTimeout(() => { stTimer = null; save(); }, 300);
    }, { passive: true });
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    d.addEventListener('visibilitychange', () => {
      if (d.visibilityState === 'hidden') save();
    });
    const restore = () => {
      let y = 0;
      try { y = Number(sessionStorage.getItem(SCROLL_KEY)) || 0; } catch (e) { y = 0; }
      if (y <= 4) return;
      /* 用户已经开始自己滚了就别抢方向盘 */
      if ((window.scrollY || 0) > 4) return;
      try { window.scrollTo(0, y); } catch (e) {}
    };
    /* 【刷新一律回顶部】原本这里会在重载后把「上次滚动位置」恢复出来，
     * 但用户期望刷新后看到最新新闻（顶部），且上次若在底部会被再次
     * 甩到底部。所以不再恢复滚动位置 —— 重载后页面停在顶部。
     * （save() 仍保留，仅作记录，不再读回滚动。） */
  }

  function bindPullRefresh() {
    const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 1;
    const overlay = () => !!document.querySelector('.nsheet.on, .sheet.on, #sheet.on, #sModal.on, .pk.on, .lview.on, .keyp.on');
    /* 【v201】只有「快讯」页需要下拉刷新。矩阵 / 事件 / 行情本来就 20~30 秒
     * 自动轮询实时更新，下拉既无意义，还会触发整页重载/重连、把用户甩回首页。
     * 其他页仍然要 preventDefault 吃掉 WebView 原生下拉（否则会真重载），
     * 只是松手不执行任何刷新动作、也不显示「下拉刷新快讯」提示。 */
    const feedOnly = () => S.tab === 'feed';
    d.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || overlay()) { pullActive = false; return; }
      /* 【关键修复】这里不再要求「touchstart 时已经在顶部」。
       * 用户真实动作常常是：在列表中部往上滑，滑到顶部后继续下拉 ——
       * 旧逻辑在 touchstart（中部）时就 return，pullActive 永远为 false，
       * 之后的 touchmove 直接 return、不 preventDefault，
       * 于是浏览器原生下拉刷新接管 → 整页重载 → 全屏空白 + 全部源重连。
       * 现在只记录起点，是否要拦 PTR 交给 touchmove 按「当前是否在顶部」实时判断。 */
      pullY0 = e.touches[0].clientY;
      pullDy = 0;
      pullActive = true;
    }, { passive: true });
    d.addEventListener('touchmove', e => {
      if (!pullActive) return;
      pullDy = e.touches[0].clientY - pullY0;
      /* 在顶部且向下拉 → 吃掉浏览器原生下拉刷新（这是「不再整页重载」的核心）。
       * 非快讯页照吃不误，但不显示下拉提示、松手也不刷新。 */
      if (atTop() && pullDy > 0) {
        if (e.cancelable) e.preventDefault();
        if (feedOnly() && !pullBusy) pullHintSet(pullDy * 0.55, pullDy >= PULL_TRIGGER);
        else pullHintSet(0, false);
      } else if (pullDy <= 0) {
        pullHintSet(0, false, feedOnly() ? '下拉刷新快讯' : '');
      }
    }, { passive: false });
    const end = () => {
      if (!pullActive) return;
      pullActive = false;
      if (feedOnly() && pullDy >= PULL_TRIGGER && atTop()) pullRefresh();
      else pullHintSet(0, false, feedOnly() ? '下拉刷新快讯' : '');
      pullDy = 0;
    };
    d.addEventListener('touchend', end, { passive: true });
    d.addEventListener('touchcancel', end, { passive: true });
  }

  /* ---------------- 演示推流 ----------------
   * 【重要】这里的数据 100% 是编造的演示样本，不是新闻。
   * 只在用户手动点「演示」按钮时注入，且会被强制打上 demo 标记：
   *   · 标题前缀「【演示】」
   *   · src 固定为「演示数据（非真实新闻）」
   *   · 渲染时显示橙色「演示」角标
   *   · 不触发 S 级全屏警报（避免冒充真实黑天鹅）
   * 任何时候都不允许把演示数据当作真实新闻呈现。 */
  const DEMO_POOL = [
    {
      id: 'D-001', level: 'A', cat: '演示', region: 'CN', heat: 0,
      title: '【演示】这是一条用于演示界面效果的示例数据，不是真实新闻',
      brief: '演示用途：仅用于展示快讯卡片、详情页与角标的渲染效果。内容为编造，不对应任何真实事件、真实时间或真实机构。',
      src: '演示数据（非真实新闻）',
      demo: true,
      direct: [{ k: 'SPX', d: 1, note: '演示关联标的' }],
      cn: [{ k: '600030', d: 1, note: '演示 A 股映射' }],
      chain: ['演示条目', '→ 仅用于界面演示', '→ 不代表任何真实传导关系']
    },
    {
      id: 'D-002', level: 'A', cat: '演示', region: 'US', heat: 0,
      title: '【演示】第二条示例数据，用于验证列表排序与筛选',
      brief: '演示用途：这条也是编造的示例数据，来源栏固定标注「演示数据（非真实新闻）」。',
      src: '演示数据（非真实新闻）',
      demo: true,
      direct: [{ k: 'GOLD', d: 1, note: '演示关联标的' }],
      cn: [],
      chain: ['演示条目', '→ 仅用于界面演示']
    }
  ];

  function demoPush() {
    const item = DEMO_POOL[S.demoIdx % DEMO_POOL.length];
    S.demoIdx++;
    const n = {
      ...item,
      ts: Date.now(),
      id: item.id + '-' + S.demoIdx,
      demo: true,
      src: '演示数据（非真实新闻）'
    };
    S.news.unshift(n);
    S.grade = 'all';
    S.topic = 'all';
    renderFeed();
    renderSNR();
    // 演示数据一律不触发 S 级全屏警报，避免被误当成真实黑天鹅
    beep(1);
  }

  /* ---------------- 事件追踪页 ----------------
   * 数据在 events.js 的 w.EVENTS；这里负责渲染卡片列表 / 单事件详情。
   * 多事件 → 卡片；单事件 → 直接平铺详情。相关报道从 S.news 按 newsKeys 匹配。
   *
   * 【动态化】
   * 事件卡片不再是纯静态快照：
   *   · 带 asset 的指标 → 用 QuoteHub 实时报价覆盖显示，标「实时」角标，
   *     并把人工快照值保留为对照（显示偏离幅度）；
   *   · 相关标的 → 直接显示当前报价与涨跌幅；
   *   · 相关报道 → 快讯轮询拿到新条目后重绘，实时增长；
   *   · 整页每 30 秒自动刷新一次行情，快讯每 25 秒刷新一次。
   * 不能实时化的部分（预测概率、人工指数、席位、民调）仍明确标注为人工快照。 */
  S.eventOpen = null;

  /* 事件 <> 快讯的匹配规则（v70 修「美联储事件抓到欧洲央行」）：
   * 原来只要命中 newsKeys 里任意一个词就算 —— 但 fed 的 keys 里有裸「加息」
   * 「降息」，于是「欧洲央行官员称12月加息的可能性」「欧元区10月通胀率创新高
   * 12月加息预期升温」全被塞进美联储的时间线。
   * 现在三层：
   *   newsExcl —— 出现即排除（别的央行）
   *   newsKeys —— 至少命中一个
   *   newsMust —— 若配置，还必须再命中其一（确认是本事件的主体）
   * 三者都只匹配标题，不用正文，避免正文里顺带提到就被抓。 */
  function eventNews(ev) {
    const keys = (ev.newsKeys || []).map(k => String(k).toLowerCase());
    if (!keys.length) return [];
    const m = (w.evMatchNews) ? w.evMatchNews : function (e, title) {
      const tt = String(title || '').toLowerCase();
      return (e.newsKeys || []).some(k => tt.indexOf(String(k).toLowerCase()) >= 0);
    };
    const live = S.news.filter(n => m(ev, n.title));
    /* v271【相关资讯兜底】实时快讯源可能因 CORS / 代理限流一条都抓不到，
     * 这时用卡片内置的「人工核实」条目顶上，保证卡片不空。
     * ts 只用于排序（按当天 08:00 北京），对外只显示 dateLabel，
     * 绝不编造具体分钟。实时优先，同标题去重。 */
    const yr = new Date().getFullYear();
    const seed = (ev.seedNews || []).filter(n => m(ev, n.title)).map(n => {
      const dl = String(n.dateLabel || '').replace(/[^\d-]/g, '');
      const ts = Date.parse(yr + '-' + dl + 'T08:00:00+08:00');
      return {
        id: n.id, title: n.title, level: n.level || 'A', cat: n.cat || '快讯',
        src: n.src || '人工核实', dateLabel: n.dateLabel || '', seed: true,
        ts: isFinite(ts) ? ts : 0
      };
    });
    const seen = Object.create(null), out = [];
    live.concat(seed).sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(n => {
      const key = String(n.title || '').replace(/\s+/g, '');
      if (!key || seen[key]) return;
      seen[key] = 1; out.push(n);
    });
    return out.slice(0, 8);
  }

  /* v271【自动更新 · 状态/头条】按快讯标题推进事件阶段。
   * 只作用在配了 autoProgress 的事件上，其它卡片完全不受影响。
   * 规则按优先级从高到低匹配；neg 是防误判闸门（「不会同意停火」不算达成）。
   * 返回浅拷贝，绝不污染 events.js 里的原始数据。 */
  const EV_STAGE_KEY = 'mm_ev_stage_v1';
  let _evStage = null;
  function evStageMap() {
    if (!_evStage) {
      try { _evStage = store.get(EV_STAGE_KEY, {}) || {}; } catch (e) { _evStage = {}; }
    }
    return _evStage;
  }
  function eventAutoView(ev, news) {
    const rules = ev.autoProgress || [];
    if (!rules.length) return ev;
    const win = (ev.autoWindowH || 72) * 3600 * 1000;
    const titles = (news || []).filter(n => (n.ts || 0) >= Date.now() - win)
      .map(n => String(n.title || ''));
    let idx = -1;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      let re, neg = null;
      try {
        re = new RegExp(r.re);
        if (r.neg) neg = new RegExp(r.neg);
      } catch (e) { continue; }
      if (titles.some(t => re.test(t) && !(neg && neg.test(t)))) { idx = i; break; }
    }
    /* v271【单调推进】快讯池每 25 秒刷新、前 8 条会变，若每次都按当下
     * 的匹配结果取阶段，卡片页与详情页会显示两个不同状态（实测复现）。
     * 阶段一旦推进到更高优先级就锁住不回退，并持久化到 localStorage，
     * 刷新页面也保持同一阶段；只有出现更高阶段的新快讯才继续推进。 */
    const memo = evStageMap();
    if (memo[ev.id]) {
      const saved = rules.findIndex(r => r.status === memo[ev.id]);
      if (saved >= 0 && (idx < 0 || saved < idx)) idx = saved;
    }
    if (idx < 0) return ev;
    const hit = rules[idx];
    if (memo[ev.id] !== hit.status) {
      memo[ev.id] = hit.status;
      try { store.set(EV_STAGE_KEY, memo); } catch (e) { /* 隐私模式下只保内存 */ }
    }
    return Object.assign({}, ev, {
      status: hit.status || ev.status,
      statusCls: hit.statusCls || ev.statusCls,
      headline: Object.assign({}, ev.headline || {}, { value: hit.value || (ev.headline || {}).value })
    });
  }

  /* v271【自动更新 · 进度指标】auto.daysSince 按日期自动推算「已进行 N 天」，
   * 每天自己 +1，不需要人工改 events.js。 */
  function eventAutoMetric(m) {
    if (!m || !m.auto || m.auto.type !== 'daysSince') return m;
    const d = Date.parse(String(m.auto.date) + 'T00:00:00+08:00');
    if (!isFinite(d)) return m;
    const days = Math.max(1, Math.floor((Date.now() - d) / 86400000) + 1);
    return Object.assign({}, m, { value: days, max: Math.max(m.max || 7, days + 2) });
  }
  /* 兜底资讯不标「示例」（那是编造数据的角标），改成在副行写明来源与口径 */
  function evNewsWhen(n) {
    return n.seed ? (esc(n.dateLabel || '') + ' · 人工核实') : hhmm(n.ts);
  }
  /* 自动化实测句柄：不参与业务渲染，只用来验证阶段推进与进度推算 */
  w.evAutoView = eventAutoView;
  w.evAutoMetric = eventAutoMetric;

  /* 事件里所有能绑定到实时行情的键：相关标的 + 带 asset 的指标 + headline */
  function eventQuoteKeys() {
    const out = [];
    const add = k => { if (k && U.get(k) && out.indexOf(k) < 0) out.push(k); };
    (w.EVENTS || []).forEach(ev => {
      (ev.assets || []).forEach(add);
      (ev.metrics || []).forEach(m => add(m.asset));
      if (ev.headline) add(ev.headline.asset);
    });
    return out;
  }

  function evUnit(k) {
    const a = U.get(k);
    if (!a) return '';
    if (a.unit === '%') return '%';
    return a.unit ? ' ' + a.unit : '';
  }

  /* 实时报价（含与人工快照的偏离）—— 有报价才返回 */
  function evLive(k) {
    if (!k) return null;
    const q = QuoteHub.get(k);
    if (!q || q.price == null) return null;
    return q;
  }

  /* headline —— 卡片与详情页共用同一套渲染。
   *
   * 【关键】如果 headline 绑定了行情键（asset），就用 QuoteHub 的实时报价覆盖，
   * 绝不显示人工快照值。用户反馈：「卡片显示石油价格100是老数据，
   * 点进去显示的是实时价格，让卡片也显示实时」——
   * 说明同一个数在两处显示成两个值，比没显示更糟。
   *
   * @param ev   事件对象
   * @param cls  外层 class（'ev-hl' 详情页 / 'ev-card-hl' 卡片页） */
  function eventHeadlineHTML(ev, cls) {
    const h = ev.headline;
    if (!h) return '';
    /* v171：headline 也可以接预测市场（events.js 里配 pred 即可）。
     * 之前只有指标行接了，导致大数永远停在写死的值上。 */
    if (h.pred) {
      const cached = (w.Predict && w.Predict.instant) ? w.Predict.instant(h.pred) : null;
      const cur = cached ? (cached.settled
        ? ('已结算 · ' + (cached.p >= 50 ? 'Yes' : 'No'))
        : cached.p.toFixed(1) + '%') : (h.value || '--');
      return `<div class="${cls}" data-pred="${esc(h.pred.slug || '')}"
        data-pred-q="${esc(h.pred.q || '')}"
        data-pred-ev="${esc(h.pred.event || '')}"
        data-pred-out="${esc(h.pred.outcome || '')}"
        data-pred-mk="${esc(h.pred.market || '')}">
        <span>${esc(h.label)}</span>
        <b data-pred-v${cached && cached.settled ? ' class="settled"' : ''}>${esc(cur)}${cached ? '' : '<i class="ev-livetag">预测市场</i>'}</b>
        <em data-pred-note>${esc(cached ? ('Polymarket 合约价 · ' + hhmm(cached.at)) : (h.sub || ''))}</em>
      </div>`;
    }
    const q = evLive(h.asset);
    if (!q) {
      // 没有行情源 —— 人工快照，原样显示并标明
      return `<div class="${cls}"><span>${esc(h.label)}</span><b>${esc(h.value)}</b>`
        + `<em>${esc(h.sub || '')}</em></div>`;
    }
    const up = q.pct >= 0;
    const disp = U.fmt(h.asset, q.price) + evUnit(h.asset);
    const chg = U.changeLabel(h.asset, q);
    // 快照对照：把维护时点的旧值和偏离幅度一并给出，用户能看出实时价 vs 快照差多少
    const snap = parseFloat(String(h.value || '').replace(/[^0-9.\-]/g, ''));
    let em;
    if (isFinite(snap)) {
      const dev = q.price - snap;
      em = `${chg} · 快照 ${snap} · 偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}`;
    } else {
      em = chg;
    }
    const label = esc(String(h.label).replace(/（[^）]*快照[^）]*）/g, '').trim() || h.label);
    return `<div class="${cls}"><span>${label}</span>`
      + `<b class="${up ? 'up' : 'down'}">${disp}<i class="ev-livetag">实时</i></b>`
      + `<em>${em}</em></div>`;
  }

  function eventMetricBar(m, i) {
    /* —— 情形 A：该指标本身就是一个可实时报价的品种 —— */
    const q = evLive(m.asset);
    if (q) {
      const up = q.pct >= 0;
      const disp = U.fmt(m.asset, q.price) + evUnit(m.asset);
      const snap = (typeof m.value === 'number' && isFinite(m.value)) ? m.value : null;
      const dev = snap != null ? (q.price - snap) : null;
      const devTxt = dev == null ? '' :
        `快照 ${snap} · 偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(m.asset === 'US10Y' ? 3 : 2)}`;
      /* note 里的「维护时点值」在这个分支已经不成立了 ——
       * 显示的是实时价，不是维护时点的值。留着会自相矛盾。 */
      const liveNote = m.note
        ? String(m.note).replace(/·\s*维护时点值/g, '').replace(/维护时点值/g, '').replace(/^\s*·\s*/, '').trim()
        : '';
      return `<div class="ev-m ev-m-live">
        <div class="ev-mh"><span>${esc(String(m.name).replace(/（快照）$/, ''))}</span>`
        + `<b class="${up ? 'up' : 'down'}">${disp}<i class="ev-livetag">实时</i></b></div>
        <div class="ev-live-sub"><span class="${up ? 'up' : 'down'}">${U.changeLabel(m.asset, q)}</span>`
        + (devTxt ? `<em>${devTxt}</em>` : '') + '</div>'
        + (liveNote ? `<div class="ev-mn">${esc(liveNote)}</div>` : '')
        + '</div>';
    }
    /* —— 情形 B：接了预测市场的指标 ——
     * events.js 里配一行 `pred: { slug: 'xxx', outcome: 'Yes' }`，
     * 先按原值渲染，再异步换成 Polymarket 的实时概率。
     * 拿不到（无活跃合约 / 代理不通）就保留原值，不能让人以为那是活的。 */
    if (m.pred) {
      const max0 = m.max || 100;
      /* 首屏优先用「上一次拿到的实时值」垫底：
       * 页面每 30 秒整块重绘，若还用写死的快照值，屏幕上会先闪一下旧数。 */
      const cached = (w.Predict && w.Predict.instant) ? w.Predict.instant(m.pred) : null;
      const cur = cached ? cached.p : m.value;
      const pct0 = Math.max(0, Math.min(100, (cur / max0) * 100));
      return `<div class="ev-m" data-pred="${esc(m.pred.slug || '')}"
        data-pred-q="${esc(m.pred.q || '')}"
        data-pred-ev="${esc(m.pred.event || '')}"
        data-pred-out="${esc(m.pred.outcome || '')}"
        data-pred-mk="${esc(m.pred.market || '')}">
        <div class="ev-mh"><span>${esc(m.name)}</span><b style="color:${m.color}" data-pred-v>${cur}${cached ? '%<i class="ev-livetag">预测市场</i>' : (m.unit || '')}</b></div>
        <div class="ev-bar"><i data-pred-bar style="width:${pct0.toFixed(1)}%;background:${m.color}"></i></div>
        <div class="ev-mn" data-pred-note>${esc(cached ? ('Polymarket 实时合约价 · ' + hhmm(cached.at)) : (m.note || ''))}</div>
      </div>`;
    }
    /* —— 情形 C：人工快照指标（预测 / 人工指数），无外部数据源 —— */
    const max = m.max || 100;
    const pct = Math.max(0, Math.min(100, (m.value / max) * 100));
    const disp = m.max ? `${m.value}<i>/ ${m.max}</i>` : `${m.value}${m.unit || ''}`;
    return `<div class="ev-m">
      <div class="ev-mh"><span>${esc(m.name)}</span><b style="color:${m.color}">${disp}</b></div>
      <div class="ev-bar"><i style="width:${pct.toFixed(1)}%;background:${m.color}"></i></div>
      ${m.note ? `<div class="ev-mn">${esc(m.note)}</div>` : ''}
    </div>`;
  }

  /* 相关标的按钮 —— 带上实时报价与涨跌幅 */
  function eventAssetBtn(k) {
    const a = U.get(k);
    if (!a) return '';
    const q = evLive(k);
    const cls = q ? (q.pct >= 0 ? 'up' : 'down') : '';
    const price = q ? U.fmt(k, q.price) + evUnit(k) : '--';
    const chg = q ? U.changeLabel(k, q) : '';
    return `<button class="ev-asset${q ? ' has-q' : ''}" data-evk="${esc(k)}">`
      + `<span>${esc(a.short || a.name)}${a.kind === 'index' ? '<i>指数</i>' : ''}</span>`
      + `<b class="${cls}">${price}</b>`
      + (chg ? `<em class="${cls}">${chg}</em>` : '')
      + '</button>';
  }

  function eventSeats(ev) {
    if (!ev.seats) return '';
    const s = ev.seats;
    const seatBar = (label, dem, rep) => {
      const tot = dem + rep;
      const dp = tot ? (dem / tot * 100) : 50;
      return `<div class="ev-seat">
        <div class="ev-sh">${esc(label)}<span>民主 ${dem} · 共和 ${rep}</span></div>
        <div class="ev-seat-bar"><i class="d" style="width:${dp.toFixed(1)}%"></i><i class="r" style="width:${(100 - dp).toFixed(1)}%"></i></div>
        <div class="ev-seat-lg"><b class="d">民主党 ${dem}</b><b class="r">共和党 ${rep}</b></div>
      </div>`;
    };
    return `<div class="ev-sec"><div class="ev-sec-h">两院席位态势</div>${seatBar('众议院（当前）', s.house.dem, s.house.rep)}${seatBar('参议院（当前）', s.senate.dem, s.senate.rep)}</div>`;
  }

  function eventDetailHTML(ev) {
    const news = eventNews(ev);
    const view = eventAutoView(ev, news);
    const metrics = (view.metrics || []).map(eventAutoMetric).map(eventMetricBar).join('');
    const battleground = (ev.battleground || []).map(x => `<span class="ev-chip">${esc(x)}</span>`).join('');
    // 时间线节点区分「已报道的既成事实」与「预期/关键节点」，避免把预测读成已发生
    const timeline = (ev.timeline || []).map(x => {
      const fc = x.k === 'forecast';
      return `<div class="ev-tl-i${fc ? ' is-fc' : ''}"><em>${esc(x.t)}</em>`
        + `<i class="ev-tl-k${fc ? ' fc' : ''}">${fc ? '预期' : '已报道'}</i>`
        + `<p>${esc(x.txt)}</p></div>`;
    }).join('');
    /* 自动进展：把该事件匹配到的 24 小时内快讯挂到人工时间线上方。
     * 用户要的是「俄乌和谈的进展能自己动」—— 人工时间线是叙事，不能天天手改，
     * 所以新进展直接由快讯池流入，标注「自动」，与人工节点分开。 */
    const winMs = (ev.autoWindowH || 72) * 3600 * 1000;
    const fresh = news.filter(n => Date.now() - (n.ts || 0) < winMs).slice(0, 6);
    const autoTl = fresh.map(n =>
      `<div class="ev-tl-i is-auto"><em>${n.seed ? esc(n.dateLabel || '') : hhmm(n.ts)}</em>`
      + `<i class="ev-tl-k auto">${n.seed ? '核实' : '自动'}</i><p>${esc(n.title)}</p></div>`).join('');
    const themes = (ev.themes || []).map(x => `<span class="ev-chip t">${esc(x)}</span>`).join('');
    const assets = (ev.assets || []).filter(k => U.get(k)).map(eventAssetBtn).join('');
    const newsHTML = news.length
      ? news.map(n => `<div class="ev-news" data-evn="${esc(n.id)}"><span class="lv ${LVCLS[n.level] || 'lv-b'}">${n.level}</span>${n.seed ? '' : liveBadge(n)}<div><b>${esc(n.title)}</b><em>${evNewsWhen(n)} · ${esc(n.cat)}${n.src ? ' · ' + esc(n.src) : ''}</em></div></div>`).join('')
      : '<div class="empty sm">暂无匹配快讯（快讯源连通后自动归集）</div>';

    /* headline —— 与卡片页共用同一个渲染函数，两处绝不会显示成两个值 */
    const headline = eventHeadlineHTML(view, 'ev-hl');

    const liveAt = evLastQuoteAt();

    return `<div class="ev-detail">
      <div class="ev-hd">
        <div class="ev-icon">${esc(ev.icon || '◉')}</div>
        <div class="ev-hdt">
          <div class="ev-tit">${esc(view.title)}<span class="ev-st ${esc(view.statusCls || 'watch')}">${esc(view.status || '')}</span></div>
          <div class="ev-cat">${esc(view.cat || '')} · 叙事维护于 ${esc(view.updated || '--')}${view.hot ? ' · 热度 ' + '★'.repeat(view.hot) : ''}${view.autoProgress ? ' · 进度自动跟随快讯' : ''}</div>
        </div>
      </div>
      <div class="ev-sum">${esc(ev.summary || '')}</div>
      ${headline}
      ${metrics ? `<div class="ev-sec"><div class="ev-sec-h">关键指标<span class="ev-hint-inline">标「实时」= 当前报价；其余为人工快照</span></div>${metrics}</div>` : ''}
      ${eventSeats(ev)}
      ${autoTl ? `<div class="ev-sec"><div class="ev-sec-h">${(view.seedNews || []).length ? '最新进展（快讯自动归集 · 人工核实兜底）' : '最新进展（自动抓取 · 每 25 秒更新）'}</div><div class="ev-tlx">${autoTl}</div></div>` : ''}
      ${timeline ? `<div class="ev-sec"><div class="ev-sec-h">时间线（已报道 = 事实转述 · 预期 = 预测/关键节点）</div><div class="ev-tlx">${timeline}</div></div>` : ''}
      ${battleground ? `<div class="ev-sec"><div class="ev-sec-h">关键变量 / 战场</div><div class="ev-chips">${battleground}</div></div>` : ''}
      ${themes ? `<div class="ev-sec"><div class="ev-sec-h">主题</div><div class="ev-chips">${themes}</div></div>` : ''}
      ${assets ? `<div class="ev-sec"><div class="ev-sec-h">相关标的（点击看行情）</div><div class="ev-assets">${assets}</div></div>` : ''}
      <div class="ev-sec"><div class="ev-sec-h">${(view.seedNews || []).length ? '相关报道（实时抓取 · 人工核实兜底）' : '相关报道（实时抓取，每 25 秒更新）'}</div>${newsHTML}</div>
      <div class="ev-src"><b>行情与报道实时更新</b>（每 30 秒刷新报价 · 每 25 秒刷新快讯${liveAt ? ' · 最近报价 ' + liveAt : ''}）；<b>叙事部分为人工维护快照</b>，非本终端核验。${(view.metrics || []).some(mm => mm.pred) ? '<b>预测概率已接 Polymarket 合约价</b>（标「预测市场」，每 5 分钟刷新，并显示较昨日变化）' : '<b>本卡片不接预测市场概率</b>；状态与进度由归集快讯自动推进，标「核实」的条目为人工核实后内置、只标日期'}；人工估算类指标仍为维护时点值。参考来源：${esc(view.src || '--')}</div>
      <div class="ev-tapback">轻点页面任意处返回事件列表</div>
    </div>`;
  }

  function eventCardHTML(ev) {
    const news = eventNews(ev);
    const view = eventAutoView(ev, news);
    /* 卡片上挑 2 个可实时报价的标的，直接显示当前价格 */
    const picks = (ev.assets || []).filter(k => U.get(k) && evLive(k)).slice(0, 3);
    const strip = picks.length
      ? `<div class="ev-card-q"><span class="ev-qh">实时行情<i class="ev-livetag">实时</i></span>${picks.map(k => {
          const q = evLive(k);
          const cls = q.pct >= 0 ? 'up' : 'down';
          return `<span class="ev-qi"><em>${esc(U.name(k))}</em>`
            + `<b class="${cls}">${U.fmt(k, q.price)}${evUnit(k)}</b>`
            + `<i class="${cls}">${U.changeLabel(k, q)}</i></span>`;
        }).join('')}</div>`
      : '';
    return `<button class="ev-card" data-evid="${esc(ev.id)}">
      <div class="ev-icon">${esc(ev.icon || '◉')}</div>
      <div class="ev-card-bd">
        <div class="ev-tit">${esc(view.title)}<span class="ev-st ${esc(view.statusCls || 'watch')}">${esc(view.status || '')}</span></div>
        <div class="ev-card-sum">${esc(ev.summary || '')}</div>
        ${eventHeadlineHTML(view, 'ev-card-hl')}
        ${strip}
        <div class="ev-card-ft">${esc(ev.cat || '')} · 叙事维护于 ${esc(ev.updated || '--')}${news.length ? ` · 相关快讯 ${news.length}` : ''}</div>
      </div>
      <i class="ev-arrow">›</i>
    </button>`;
  }

  /* 最近一次报价时间（用于在卡片上显示"数据新鲜度"） */
  function evLastQuoteAt() {
    let at = 0;
    eventQuoteKeys().forEach(k => {
      const q = QuoteHub.get(k);
      if (q && q.at && q.at > at) at = q.at;
    });
    return at ? hhmmss(at) : '';
  }

  /* ---------------- 事件卡片的「显示顺序 / 隐藏」----------------
   * 用户口径：「新事件的加入和旧事件剔除还是掌握在我手里，
   *   你负责现在事件的自动更新进度就行。卡片页面有一个编辑，
   *   点编辑可以把当前卡片选择删除或移动排序，这样我就可以自己剔除卡片了。」
   *
   * 所以这里只存两样东西：哪些 id 被隐藏了、显示顺序是什么。
   * 事件内容本身仍来自 events.js，我不动。 */
  const EV_LAYOUT_KEY = 'mm_ev_layout';
  function evLayout() {
    const d = store.get(EV_LAYOUT_KEY, null);
    if (d && typeof d === 'object') return { hidden: d.hidden || [], order: d.order || [] };
    return { hidden: [], order: [] };
  }
  function saveEvLayout(v) { store.set(EV_LAYOUT_KEY, v); }

  /** 按用户排布过滤 + 排序 */
  function applyEvLayout(list) {
    const L = evLayout();
    const hidden = L.hidden || [];
    const order = L.order || [];
    let out = list.filter(x => x && x.id && hidden.indexOf(x.id) < 0);
    if (order.length) {
      out = out.slice().sort((a, b) => {
        const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
        if (ia < 0 && ib < 0) return 0;
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
      });
    }
    return out;
  }

  /** 编辑模式下的工具条 + 每张卡的操作按钮 */
  /** 编辑按钮现在放在「事件追踪」标题那一行的右侧（用户反馈：原来太小、字挤在一起）。
   *  这里只保留状态提示和「恢复默认」，放列表上方。 */
  function evToolbar(allN, shownN) {
    const L = evLayout();
    const hidN = (L.hidden || []).length;
    if (!S.evEdit && !hidN) return '';
    return `<div class="ev-bar">
      <span class="ev-bar-t">显示 ${shownN}/${allN}${hidN ? ' · 已隐藏 ' + hidN : ''}</span>
      ${S.evEdit && (hidN || (L.order || []).length)
        ? '<button class="ev-bar-b" data-ev-reset>恢复默认</button>' : ''}
    </div>`;
  }

  /** 同步标题栏上那个「编辑 / 完成」按钮 */
  function syncEvEditBtn() {
    const b = $('#eventEdit');
    if (!b) return;
    b.hidden = !!S.eventOpen;                 // 详情页里不显示
    b.textContent = S.evEdit ? '完成' : '编辑';
    b.classList.toggle('on', !!S.evEdit);
  }

  /** 把带 data-pred 的指标换成预测市场的实时概率 */
  function hydratePredictions() {
    const P = w.Predict;
    if (!P || typeof P.prob !== 'function') return;
    $$('[data-pred]').forEach(el => {
      const slug = el.getAttribute('data-pred');
      const q = el.getAttribute('data-pred-q') || '';
      if (!slug && !q) return;
      P.prob({
        slug: slug,
        q: q,
        event: el.getAttribute('data-pred-ev') || '',
        outcome: el.getAttribute('data-pred-out') || '',
        market: el.getAttribute('data-pred-mk') || ''
      }).then(r => {
        if (!el.isConnected) return;
        if (!r) { setPredStale(el); return; }
        const v = el.querySelector('[data-pred-v]');
        const bar = el.querySelector('[data-pred-bar]');
        const note = el.querySelector('[data-pred-note]');
        /* 概率本身是慢变量（用户口径：一天更新一次就够），真正有用的是
         * 「比昨天动了多少」—— 所以除了数值，再挂一个日变化标签。
         * 用中性色，不用红绿：概率上升不等于利好。 */
        /* 已结算盘口：价格是 0/1 定值，**不能**当「实时概率」显示 ——
         * 用户看到「停火延续至年底 0%」会以为抓取坏了，其实那是这个盘口
         * 已经结算为 No（停火没延续到年底）。明写「已结算」才不误导。 */
        if (v) {
          if (r.settled) {
            v.classList.add('settled');
            v.innerHTML = '<i class="ev-settled">已结算 · ' + (r.p >= 50 ? 'Yes' : 'No') + '</i>';
          } else {
            v.classList.remove('settled');
            let delta = '';
            if (r.base && isFinite(r.base.p)) {
              const d = r.p - r.base.p;
              if (Math.abs(d) >= 0.1) {
                delta = `<i class="ev-delta" title="较 ${esc(r.base.d)}">${d > 0 ? '↑' : '↓'}${Math.abs(d).toFixed(1)}</i>`;
              }
            }
            v.innerHTML = r.p.toFixed(1) + '%<i class="ev-livetag">预测市场</i>' + delta;
          }
        }
        if (bar) bar.style.width = Math.max(0, Math.min(100, r.p)).toFixed(1) + '%';
        if (note) {
          note.textContent = r.settled
            ? ('Polymarket · 盘口已结算（' + (r.p >= 50 ? 'Yes' : 'No') + '）· ' + hhmm(r.at))
            : ('Polymarket · ' + hhmm(r.at) + ' 更新' + (r.base ? ` · 昨日 ${r.base.p}%` : ''));
        }
      }).catch(() => setPredStale(el));
    });
  }

  /* 实时源取不到时，**如实**告诉用户这是快照，别再假装「实时 · 某日更新」。
   * 事故：Polymarket 取数走 r.jina.ai，代理被限流后卡片一直显示 11-05 的值，
   * 界面上却写着「合约价（实时）」，用户以为数据坏了。 */
  function setPredStale(el) {
    if (!el || !el.isConnected) return;
    const note = el.querySelector('[data-pred-note]');
    if (note) note.textContent = 'Polymarket 实时源暂不可用 · 当前显示人工快照值';
    const tag = el.querySelector('.ev-livetag');
    if (tag) tag.textContent = '快照';
  }

  function renderEvent() {
    const body = $('#eventBody');
    const back = $('#eventBack');
    /* 【已回滚】v58 曾把这里换成 HotEvents 的「主题聚类」，用户明确否掉：
     *   「事件不要给我动，原来的事件就是最好的。那些是真实事件，
     *    比如中期选举、俄乌冲突，而不是像你现在的主题 —— 这主题没有任何意义。」
     * 恢复为人工维护的真实事件。
     * 以后要做自动进出，必须作用在**具名真实事件**上（俄乌冲突 / 中期选举），
     * 用主题把新闻归类（原油与能源 / 亚太股市）对用户没有意义。 */
    const evs = w.EVENTS || [];
    if (!evs.length) {
      body.innerHTML = '<div class="empty"><b>暂无重点事件</b><span>当出现全球瞩目的重大事件时，这里会自动生成追踪卡片</span></div>';
      if (back) back.hidden = true;
      return;
    }
    // 自动刷新时保留当前滚动位置，避免每 30 秒把用户位置弹回顶部
    const keepY = w.scrollY || 0;
    // 单事件直接平铺详情，多事件用卡片列表
    if (evs.length === 1) {
      S.eventOpen = evs[0].id;
    }
    if (S.eventOpen) {
      const ev = evs.find(x => x.id === S.eventOpen) || evs[0];
      if (back) back.hidden = false;
      body.innerHTML = eventDetailHTML(ev);
    } else {
      if (back) back.hidden = true;
      const shown = applyEvLayout(evs);
      if (!shown.length) {
        body.innerHTML = evToolbar(evs.length, 0)
          + '<div class="empty"><b>卡片都被你收起来了</b>'
          + '<span>点上面的「编辑 → 恢复默认」可以把它们放回来</span></div>';
      } else {
        body.innerHTML = evToolbar(evs.length, shown.length)
          + shown.map(ev => S.evEdit
            ? `<div class="ev-wrap" data-ev-wrap="${esc(ev.id)}">
                 <div class="ev-ops">
                   <button data-ev-op="up" title="上移">↑</button>
                   <button data-ev-op="down" title="下移">↓</button>
                   <button data-ev-op="del" class="del" title="从列表移除">移除</button>
                 </div>
                 ${eventCardHTML(ev)}
               </div>`
            : eventCardHTML(ev)).join('');
      }
    }
    syncEvEditBtn();
    hydratePredictions();
    if (keepY) w.scrollTo(0, keepY);
  }

  /* 事件页自动刷新：拉最新报价 + 重绘。
   * 只在事件页可见时干活，避免无谓的接口消耗。 */
  let evTimer = null;
  function ensureEventTimer() {
    if (evTimer) return;
    evTimer = setInterval(async () => {
      if (S.tab !== 'event') return;
      const keys = eventQuoteKeys();
      if (keys.length) {
        try { await QuoteHub.refresh(keys); } catch (e) { /* ignore */ }
      }
      renderEvent();
    }, 30000);
  }

  /* ---------------- 视图切换 ---------------- */
  /* ---------------- 赚钱效应指标（iframe 嵌入 /breadth/） ----------------
   * 独立页有自己的全局名与裸标签样式，直接搬进主站会冲突，用 iframe 隔离。
   * 懒加载：第一次点进 tab 才赋 src，避免拖慢首屏。主题经 postMessage 同步；
   * 同源 localStorage 的 mm_theme 也能被 iframe 读到，双保险。 */
  let _effectLoaded = false;
  function postEffectTheme() {
    try {
      const f = $('#effectFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage({ mm_theme: S.theme }, location.origin);
    } catch (e) {}
  }
  function ensureEffectFrame() {
    const f = $('#effectFrame');
    if (!f || _effectLoaded) return;
    _effectLoaded = true;
    f.src = f.dataset.src || './breadth/?embed=1';
    f.onload = postEffectTheme;
  }

  function switchTab(tab) {
    S.tab = tab;
    /* v201：记下当前页，供 WebView 层下拉刷新整页重载后原地恢复。
     * 用 sessionStorage —— 彻底关掉 App 重开时自然失效，仍默认从快讯页起步。 */
    try { sessionStorage.setItem('mm_last_tab', tab); } catch (e) {}
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.view').forEach(v => v.classList.remove('on'));
    const v = $('#view-' + tab);
    if (v) v.classList.add('on');
    if (tab === 'feed') { S.feedNewS = 0; updateFeedDot(); }
    if (tab === 'market') renderMarket();
    if (tab === 'set') renderSettings();
    if (tab === 'event') {
      renderEvent();
      ensureEventTimer();
      // 进入事件页立刻拉一次行情，避免先看到空报价再等 30 秒
      const ks = eventQuoteKeys();
      if (ks.length) {
        QuoteHub.refresh(ks).then(() => {
          if (S.tab === 'event') renderEvent();
        }).catch(() => {});
      }
    }
    if (tab === 'radar') {
      Object.keys(S.session).forEach(k => delete S.session[k]);
      renderRadar(radar ? Object.values(radar.state) : [], radar);
    }
    if (tab === 'effect') ensureEffectFrame();
    syncAlerts(radar);
  }

  /* ---------------- 全局事件 ---------------- */
  function bind() {
    $('#tabs').onclick = (e) => {
      const b = e.target.closest('button');
      if (b) switchTab(b.dataset.tab);
    };
    $('#gradeFilters').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.grade = b.dataset.g;
      S.limit = 60;              // 换档回到首屏 60 组
      store.set('mm_grade', S.grade);
      renderFeed(false);         // 换档是用户主动换视角 → 回顶部
      try { window.scrollTo(0, 0); } catch (err) {}
    };

    /* 长按卡片 0.55 秒 → 改判面板。
     * 用 pointer 事件而不是 touch/mouse 各写一套：安卓 WebView 和 iOS Safari
     * 都支持，且能同时拿到鼠标（桌面调试）。位移超过 10px 视为滚动，取消长按。 */
    (function bindLongPress() {
      const list = $('#feedList');
      if (!list) return;
      let timer = null, sx = 0, sy = 0, target = null;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } target = null; };
      list.addEventListener('pointerdown', (e) => {
        /* 卡片里的按钮（N 条进展、来源、关联标的）有自己的点击语义，不抢 */
        if (e.target.closest('button, a, .chips, .c-imp')) return;
        // 母卡和子卡都能改判：子卡是折叠起来的那几条，标级同样可能错
        const card = e.target.closest('.card');
        const sub = e.target.closest('.ev-tl[data-tlid]');
        const id = (card && card.dataset.id) || (sub && sub.dataset.tlid);
        if (!id) return;
        cancel();                    // 先清掉上一轮（cancel 会把 target 置空）
        target = id;
        sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => {
          timer = null;
          const id = target;
          target = null;
          if (id) { fixGuardAt = Date.now(); openFixPanel(id); }
        }, 550);
      }, { passive: true });
      list.addEventListener('pointermove', (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
      }, { passive: true });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => list.addEventListener(t, cancel, { passive: true }));
      /* 安卓长按会先弹系统的「选择/复制」菜单，等它弹出来面板就被盖住了 */
      list.addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });
    })();
    $('#topicFilters').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.topic = b.dataset.t;
      renderFeed();
    };
    /* v199：按涨跌独立按钮，循环 关闭→组内涨幅降序→组内涨幅升序；
     * 只动各组卡片内部的行序，分组卡片位置不动。 */
    const chgBtn2 = $('#mktChg');
    if (chgBtn2) chgBtn2.onclick = () => {
      S.marketSort = S.marketSort === 'fixed' ? 'desc' : (S.marketSort === 'desc' ? 'asc' : 'fixed');
      store.set('mm_msort', S.marketSort);
      renderMarket();
    };
    $('#mktEdit').onclick = () => {
      S.marketEdit = !S.marketEdit;
      // ▲▼ 只在默认组内顺序下有意义
      if (S.marketEdit && S.marketSort !== 'fixed') {
        S.marketSort = 'fixed';
        store.set('mm_msort', 'fixed');
      }
      renderMarket();
    };
    const sessBtn = $('#mktSess');
    if (sessBtn) sessBtn.onclick = () => {
      S.sessFirst = !S.sessFirst;
      store.set('mm_sessfirst', S.sessFirst);
      renderMarket();
    };
    /* v198：分时预览开关从分类栏移到「时段优先」旁边，避免和横栏打架 */
    const spTog = $('#mktSpTog');
    if (spTog) spTog.onclick = () => {
      mktSparkOn = !mktSparkOn;
      store.set('mm_mktspark', mktSparkOn);
      renderMarket();
    };
    $('#mktAdd').onclick = openPicker;

    // 快讯卡片 → 详情。点标的标签仍然走品种详情，不进新闻详情
    $('#feedList').onclick = (e) => {
      // 刚才是长按（改判面板），这一个 click 不要当成「点开详情」
      if (fixGuardAt && Date.now() - fixGuardAt < 800) { fixGuardAt = 0; return; }
      // 「N 条进展」气泡：展开 / 收起同事件的时间轴
      const evb = e.target.closest('.ev-badge');
      if (evb) {
        e.stopPropagation();
        const g = evb.closest('.ev-group');
        const on = g.classList.toggle('on');
        evb.setAttribute('aria-expanded', on ? 'true' : 'false');
        return;
      }
      // 「C 级待复核」折叠区：展开 / 收起（状态记在本地，重绘后不跳回）
      const crh = e.target.closest('.c-review-h');
      if (crh) {
        e.stopPropagation();
        const sec = crh.closest('.c-review');
        const on = sec.dataset.cr !== '1';
        sec.dataset.cr = on ? '1' : '0';
        crh.setAttribute('aria-expanded', on ? 'true' : 'false');
        const cb = sec.querySelector('.c-review-b');
        if (cb) cb.hidden = !on;
        store.set('mm_crev', on ? '1' : '0');
        return;
      }
      // 「加载更多」：B / 全部档每次多铺 60 组（见 renderFeed 的 PAGE）
      const more = e.target.closest('[data-more]');
      if (more) {
        S.limit = Math.max(60, S.limit || 60) + 60;
        renderFeed();
        return;
      }
      // 「显示全部来源」：退出按源筛选
      if (e.target.closest('[data-src-clear]')) {
        S.srcFilter = '';
        renderSrcGrid();
        renderFeed();
        return;
      }
      if (e.target.closest('.chip')) return;
      /* 子卡（折叠时间轴里的每一条）：小字被截成 34 个字，看不全 ——
       * 用户 11-05 要求「下面的子卡也要能点开看详情」。
       * 走的是和母卡一样的新闻详情页（完整标题 + 正文段 + 来源 + 关联标的）。 */
      const tl = e.target.closest('.ev-tl[data-tlid]');
      if (tl && tl.dataset.tlid) { openNews(tl.dataset.tlid); return; }
      // 点来源按钮 → 页内小窗（不打开这条新闻的详情）
      const op = e.target.closest('[data-open]');
      if (op && op.dataset.open) {
        const nn = S.news.find(x => x.url === op.dataset.open);
        openLink(op.dataset.open, nn ? nn.title : '',
          (op.textContent || '').replace(/[↗\s]/g, '').trim(), nn ? nn.brief : '', op.dataset.ch === '1');
        return;
      }
      const c = e.target.closest('.card');
      if (c && c.dataset.id) openNews(c.dataset.id);
    };
    $('#newsSheet').onclick = (e) => {
      if (e.target.closest('.ns-mask') || e.target.closest('.ns-x')) { closeNews(); return; }
      const op = e.target.closest('[data-open]');
      if (op && op.dataset.open) {
        const cur = S.curNews || {};
        openLink(op.dataset.open, cur.title || '', cur.src || '', cur.brief || '', op.dataset.ch === '1');
        return;
      }
      const chip = e.target.closest('[data-k]');
      if (chip && chip.dataset.k) { openSheet(chip.dataset.k); return; }
      const rel = e.target.closest('[data-news]');
      if (rel && rel.dataset.news) openNews(rel.dataset.news);
    };

    $('#linkView').onclick = (e) => {
      if (e.target.closest('.lv-mask') || e.target.closest('.lv-x')) { closeLink(); return; }
      const seg = e.target.closest('[data-lvm]');
      if (seg) { LINK.mode = seg.dataset.lvm; paintLinkMode(); return; }
      if (e.target.closest('[data-lvout]')) {
        try { w.open(LINK.url, '_blank', 'noopener'); } catch (err) {}
      }
    };

    $('#marketBody').onclick = (e) => {
      const mv = e.target.closest('[data-mv]');
      if (mv && mv.dataset.k) { moveKey(mv.dataset.k, mv.dataset.mv === 'up' ? -1 : 1); return; }
      const del = e.target.closest('.mk-x');
      if (del && del.dataset.del) {
        S.watch = S.watch.filter(k => k !== del.dataset.del);
        store.set('mm_watch2', S.watch);
        renderMarket();
        return;
      }
      const row = e.target.closest('.mk-row');
      if (row && !S.marketEdit) openSheet(row.dataset.k);
    };

    $('#radarActive').onclick = (e) => {
      /* v100：「归因：新闻标题」/「新闻补获」的链接要先于卡片本身处理，
       * 否则会冒泡到 .ra 的 data-k，点开的是行情面板而不是新闻详情。 */
      const rel = e.target.closest('[data-news]');
      if (rel && rel.dataset.news) { openNews(rel.dataset.news); return; }
      const op = e.target.closest('[data-open]');
      if (op && op.dataset.open) {
        const nn = S.news.find(x => x.url === op.dataset.open);
        openLink(op.dataset.open, nn ? nn.title : (op.textContent || '').trim(),
          nn ? nn.src : '', nn ? nn.brief : '', false);
        return;
      }
      const go = e.target.closest('[data-k]');
      if (go) { openSheet(go.dataset.k); return; }
      const card = e.target.closest('.ra');
      if (card) openSheet(card.dataset.k);
    };
    /* 方块：轻点 → 直接打开该商品的行情详情（分时/K线）；长按 600ms → 倒查该品种最近消息 */
    let mxPress = null, mxHeld = false;
    const mxClear = () => { if (mxPress) { clearTimeout(mxPress.t); mxPress = null; } };
    $('#mxGrid').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.mx-cell');
      if (!b) return;
      mxHeld = false;
      mxClear();
      mxPress = {
        k: b.dataset.k,
        t: setTimeout(() => { mxHeld = true; mxPress = null; openKeyPanel(b.dataset.k); }, 600),
      };
      b.classList.add('pressing');
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => {
      $('#mxGrid').addEventListener(ev, (e) => {
        mxClear();
        const b = e.target.closest && e.target.closest('.mx-cell');
        if (b) b.classList.remove('pressing');
      });
    });
    $('#mxGrid').onclick = (e) => {
      const b = e.target.closest('.mx-cell');
      if (!b) return;
      if (mxHeld) { mxHeld = false; return; }   // 长按已经弹过消息面板
      // 直接打开对应商品的行情详情（分时/K线），而不是只跳到「行情」列表页。
      openSheet(b.dataset.k);
    };

    // 事件追踪页：卡片→详情、返回、相关标的→行情、相关报道→新闻详情
    $('#eventBack').onclick = () => { S.eventOpen = null; renderEvent(); };

    /* 详情页「再点一下就退出」——用户口径：「退出目前只能用右上角按钮，
     * 我觉得可以设置成再点一下页面就退出」。
     * 只认「轻点」：手指/鼠标按下到抬起位移不超过 12px、且期间页面没滚动、
     * 间隔在 1.5 秒内，才算一次退出点击。翻详情时的滑动、拖拽不会误退。 */
    const evBody = $('#eventBody');
    let evTap = null;
    evBody.addEventListener('pointerdown', (e) => {
      evTap = { x: e.clientX, y: e.clientY, top: w.scrollY || 0, ts: Date.now() };
    }, { passive: true });
    /* 标题栏的「编辑 / 完成」 */
    const editBtn = $('#eventEdit');
    if (editBtn) {
      editBtn.onclick = () => { S.evEdit = !S.evEdit; renderEvent(); };
    }

    evBody.onclick = (e) => {
      /* ---- 编辑模式的操作（v61）---- */
      if (e.target.closest('[data-ev-edit]')) {
        S.evEdit = !S.evEdit;
        renderEvent();
        return;
      }
      if (e.target.closest('[data-ev-reset]')) {
        saveEvLayout({ hidden: [], order: [] });
        renderEvent();
        toast('已恢复默认顺序');
        return;
      }
      const op = e.target.closest('[data-ev-op]');
      if (op) {
        const wrap = op.closest('[data-ev-wrap]');
        const id = wrap && wrap.dataset.evWrap;
        if (!id) return;
        const L = evLayout();
        const all = w.EVENTS || [];
        // 以「当前可见顺序」为基础维护 order
        let cur = applyEvLayout(all).map(x => x.id);
        const i = cur.indexOf(id);
        const kind = op.dataset.evOp;
        if (kind === 'del') {
          L.hidden = (L.hidden || []).concat([id]);
          saveEvLayout(L);
          renderEvent();
          toast('已从列表移除，可在「编辑 → 恢复默认」放回来');
          return;
        }
        if (i < 0) return;
        const j = kind === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= cur.length) return;
        const tmp = cur[i]; cur[i] = cur[j]; cur[j] = tmp;
        L.order = cur;
        saveEvLayout(L);
        renderEvent();
        return;
      }
      /* 编辑模式下点卡片不进入详情，避免误触 */
      if (S.evEdit && e.target.closest('.ev-card')) return;

      const card = e.target.closest('.ev-card');
      if (card && card.dataset.evid) {
        S.eventOpen = card.dataset.evid;
        renderEvent();
        w.scrollTo(0, 0);
        return;
      }
      const ak = e.target.closest('.ev-asset');
      if (ak && ak.dataset.evk) { openSheet(ak.dataset.evk); return; }
      const nk = e.target.closest('.ev-news');
      if (nk && nk.dataset.evn) { openNews(nk.dataset.evn); return; }
      // 详情页里点空白 / 正文 → 直接回列表
      if (S.eventOpen) {
        const moved = evTap ? Math.hypot(e.clientX - evTap.x, e.clientY - evTap.y) : 0;
        const scrolled = evTap ? Math.abs((w.scrollY || 0) - evTap.top) > 4 : false;
        const fresh = evTap ? Date.now() - evTap.ts < 1500 : true;
        if (moved <= 12 && !scrolled && fresh) {
          S.eventOpen = null;
          renderEvent();
          w.scrollTo(0, 0);
        }
      }
    };

    d.addEventListener('click', (e) => {
      // 任何「来源链接」都在页内小窗打开，不跳浏览器
      const op = e.target.closest('[data-open]');
      if (op && op.dataset.open && !e.target.closest('#newsSheet')) {
        const nn = S.news.find(x => x.url === op.dataset.open);
        openLink(op.dataset.open, nn ? nn.title : (e.target.textContent || '').trim(),
          (e.target.textContent || '').replace(/[↗\s]/g, '').trim(), nn ? nn.brief : '',
          op.dataset.ch === '1');
        return;
      }
      const chipEl = e.target.closest('.chip');
      if (chipEl && chipEl.dataset.k) { openSheet(chipEl.dataset.k); return; }
      const tk = e.target.closest('.tk');
      if (tk && tk.dataset.k) { openSheet(tk.dataset.k); return; }
      const rel = e.target.closest('.rel-n');
      if (rel) {
        /* 【需求 3】个股行情里的「关联快讯」要能点开看详情，
         * 跟第一个页面（快讯流）点开卡片是同一个小窗。
         *
         * 原来的行为是跳去 openSheet(f.k) —— 也就是跳到这条快讯关联的
         * 另一个品种的行情面板（用户点 A 股票的关联快讯，却跳到了 B 品种，
         * 根本看不到这条快讯说了什么，等于「点了没反应」）。
         * 现在直接开这条快讯自己的详情小窗。 */
        const n = S.news.find(x => x.id === rel.dataset.id);
        if (n) { openNews(n.id); return; }
      }
    });

    d.addEventListener('click', (e) => {
      if (e.target.id === 'demoAlarm' || e.target.id === 'radarTest') {
        radar.fire('BRENT', -1.82);
        beep(2);
        if (e.target.id === 'demoAlarm') {
          switchTab('radar');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
      const apBtn = e.target.closest('.sw[data-atype]');
      if (apBtn) {
        const t = apBtn.dataset.atype, k = apBtn.dataset.ap;
        const cur = alertPrefs(t);
        setAlertPref(t, k, !cur[k]);
        apBtn.classList.toggle('on', !cur[k]);
        return;
      }
      if (e.target.id === 'btnTestNotify') {
        const np = w.NativePulse;
        if (np && typeof np.testNotify === 'function') {
          try {
            const pf = alertPrefs('s');
            const why = np.testNotify(pf.sound, pf.vib);
            toast2(why || '已发送测试通知');
          }
          catch (err) { toast2('测试通知失败：' + err); }
        } else {
          sysNotify('🔔 测试通知', '这是一条测试：请检查声音与震动表现', 'mm-test-notify', 's');
          alertNotifyPerm();
          toast2('已在浏览器发送测试通知');
        }
        return;
      }
      if (e.target.id === 'btnTestDelayed') {
        const np = w.NativePulse;
        if (np && typeof np.scheduleTest === 'function') {
          try {
            const pf = alertPrefs('s');
            np.scheduleTest(5, pf.sound, pf.vib);
            toast2('已设定：5 秒后响，请立刻切到后台');
          } catch (err) { toast2('设定失败：' + err); }
        } else {
          /* 浏览器没有原生计时通道，只能前台验证；明确告知别误判成后台通过 */
          toast2('浏览器模式：5 秒后发（请保持页面在前台，切后台测请用 APP）');
          setTimeout(() => {
            sysNotify('⏱ 后台通知测试', '5 秒延时测试（浏览器前台）', 'mm-test-delay', 's');
            alertNotifyPerm();
          }, 5000);
        }
        return;
      }
      if (e.target.id === 'btnBattery') {
        const np = w.NativePulse;
        if (np && typeof np.openBattery === 'function') {
          try { np.openBattery(); } catch (err) { toast2('跳转失败，请到系统设置 → 电池手动设置'); }
        } else {
          toast2('仅手机 APP 支持此功能，请在 APP 内操作');
        }
        return;
      }
      if (e.target.id === 'fixCopy') {
        const label = '复制修复指令';
        const txt = fixPrompt();
        if (!txt) return;
        const done = () => { e.target.textContent = '已复制'; setTimeout(() => { e.target.textContent = label; }, 1600); };
        const fallback = () => {
          /* 非安全上下文 / 老 WebView 没有 clipboard API：塞进一个只读文本域让用户长按复制 */
          const ta = d.createElement('textarea');
          ta.value = txt;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          d.body.appendChild(ta);
          ta.select();
          try { d.execCommand('copy'); done(); } catch (err) { alert(txt); }
          setTimeout(() => ta.remove(), 300);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(fallback);
        } else { fallback(); }
        return;
      }
      if (e.target.id === 'fixClear') {
        if (!confirm('清空 ' + fixStore.list.length + ' 条纠错记录？改判本身仍然生效，但回传样本会没了。')) return;
        fixStore.list = [];
        fixStore.map = {};
        store.set(FIX_KEY, []);
        S.news.forEach(n => { delete n.fixed; });
        renderSettings();
        return;
      }
      if (e.target.id === 'resetAll') {
        ['mm_sound', 'mm_modal', 'mm_toast', 'mm_vib', 'mm_thr', 'mm_watch2', 'mm_msort',
          'mm_seenS', 'mm_grade', 'mm_sessfirst', 'mm_mxmode', 'mm_theme'].forEach(k => localStorage.removeItem(k));
        location.reload();
        return;
      }
      const thm = e.target.closest('[data-thm]');
      if (thm) {
        applyTheme(thm.dataset.thm);
        $$('[data-thm]').forEach(b => b.classList.toggle('on', b.dataset.thm === S.theme));
        return;
      }
      const mxm = e.target.closest('[data-mxm]');
      if (mxm) {
        S.mxMode = mxm.dataset.mxm;
        store.set('mm_mxmode', S.mxMode);
        $$('[data-mxm]').forEach(b => b.classList.toggle('on', b.dataset.mxm === S.mxMode));
        renderRadar(radar ? Object.values(radar.state) : [], radar);
        return;
      }
      const sw = e.target.closest('.sw');
      if (!sw) return;
      const map = { sound: 'sound', toast: 'toastOn', modal: 'modalOn', vib: 'vibrate', red: 'redOnly', notify: 'notify' };
      const key = map[sw.dataset.sw];
      if (!key) return;
      S[key] = !S[key];
      const SK = { vib: 'mm_vib', red: 'mm_redonly', notify: 'mm_notify' };
      store.set(SK[sw.dataset.sw] || ('mm_' + sw.dataset.sw), S[key]);
      sw.classList.toggle('on', S[key]);
      /* v194：声音/震动开关变化时同步原生（渠道/铃声/震动的即时开关） */
      if (sw.dataset.sw === 'sound' || sw.dataset.sw === 'vib') {
        try {
          const np = w.NativePulse;
          if (np && typeof np.setNotifyPrefs === 'function') np.setNotifyPrefs(S.sound, S.vibrate);
        } catch (e) {}
      }
      /* 标红开关会改变列表口径，切完立刻重绘（否则要点一下刷新才生效） */
      if (sw.dataset.sw === 'red') {
        S.limit = 60;
        renderFeed();
        renderGradeFilters();
        renderTopicFilters();
      }
    });

    /* v137：灵敏度滑杆已移除 —— 阈值完全由波动率库自适应决定，
     * 不再保留人工系数入口（旧版存过的 mm_thr 也不再读取）。 */

    $('#btnDemo').onclick = demoPush;
    const tb = $('#btnTheme');
    if (tb) tb.onclick = () => applyTheme(S.theme === 'light' ? 'dark' : 'light');
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (LINK.on) { closeLink(); return; }
        closeNews();
        closeSheet();
        $('#sModal').classList.remove('on');
        $('#picker').classList.remove('on');
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function startClock() {
    const el = $('#clock');
    const tick = () => {
      const t = new Date();
      el.textContent = [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    };
    tick(); setInterval(tick, 1000);
  }

  function trackTopbarHeight() {
    const bar = $('.topbar');
    const mktBar = $('#mktBar');
    const apply = () => {
      d.documentElement.style.setProperty('--topH', bar.offsetHeight + 'px');
      /* v198：分类栏要吸在 .mkt-bar 下面，得知道 .mkt-bar 的实际高度 */
      if (mktBar) d.documentElement.style.setProperty('--mktBarH', mktBar.offsetHeight + 'px');
    };
    apply();
    if (w.ResizeObserver) {
      const ro = new ResizeObserver(apply);
      ro.observe(bar);
      if (mktBar) ro.observe(mktBar);
    } else {
      w.addEventListener('resize', apply);
    }
  }

  /* ---------------- 底部菜单栏夹紧 ----------------
   *
   * 用户反馈：「最下面那一行菜单栏，下滑的时候会被隐藏掉」。
   *
   * 根因不是 z-index，而是移动端的视口高度差：
   *   position:fixed; bottom:0 是相对 **layout viewport** 定位的，
   *   而 Android WebView / 手机浏览器在地址栏收放、状态栏变化、软键盘弹出时，
   *   visualViewport 会比 layout viewport 矮一截（甚至错位 offsetTop）。
   *   菜单栏于是被顶到「可见区域下方」——看着就是滑一下整个底栏不见了。
   *
   * 修法：用 visualViewport 算出视觉视口底部和布局视口底部的差，
   *   把底栏整体上移同样的距离，任何视口变化都重新夹一次。
   *   顺手保证 .main 的底部留白 ≥ 底栏高度，最后一条内容不会被盖住。 */
  let pinTick = 0;
  function pinTabbar() {
    const bar = $('#tabs');
    if (!bar) return;
    // 万一被某个带 transform 的祖先「劫持」了定位上下文，直接挪回 body
    if (bar.parentNode && bar.parentNode !== d.body) {
      try { d.body.appendChild(bar); } catch (e) {}
    }
    const vv = w.visualViewport;
    let bottom = 0;
    if (vv && vv.height) {
      bottom = Math.max(0, (w.innerHeight - vv.height - (vv.offsetTop || 0)));
    }
    bar.style.bottom = bottom > 0.5 ? bottom + 'px' : '0px';
    const h = bar.getBoundingClientRect().height || 46;
    const main = d.querySelector('.main');
    if (main) main.style.paddingBottom = (h + 30) + 'px';
  }
  function startPinTabbar() {
    pinTabbar();
    [120, 400, 1200].forEach(t => setTimeout(pinTabbar, t));
    if (w.visualViewport) {
      w.visualViewport.addEventListener('resize', pinTabbar);
      w.visualViewport.addEventListener('scroll', pinTabbar);
    }
    w.addEventListener('resize', pinTabbar);
    w.addEventListener('orientationchange', () => setTimeout(pinTabbar, 350));
    // 滚动时也夹一次：WebView 里地址栏收起/展开只触发 scroll 不触发 resize
    w.addEventListener('scroll', () => {
      if (pinTick) return;
      pinTick = 1;
      (w.requestAnimationFrame || setTimeout)(() => { pinTick = 0; pinTabbar(); });
    }, { passive: true });
    // 切 tab / 打开详情后布局会变，补一次
    d.addEventListener('click', () => setTimeout(pinTabbar, 60), true);
  }

  function startSrcPill() {
    const el = $('#srcStatus');
    const tick = () => {
      const st = w.API.status;
      const ok = st.em === 'ok' || st.binance === 'ok';
      const bad = st.em === 'fail' && st.binance === 'fail';
      const short = bad ? '离线' : ok ? '在线' : '连接中';
      const lbl = bad ? '数据离线' : ok ? '数据在线' : '连接中';
      // 快讯维度：显示「N/M 源在线」，一眼看出有没有源没抓到
      const det = srcDetailList();
      const okN = det.filter(x => x.ok).length;
      let flashTxt = '', flashTip = '';
      if (det.length) {
        flashTxt = `快讯 ${okN}/${det.length}`;
        flashTip = '\n' + det.map(d => (d.ok ? '✓ ' : '✕ ') + d.name
          + (d.ok ? `：${d.count} 条（${d.via || '直连'}）` : `：${d.err || '不可用'}`)).join('\n');
      } else if (S.flashState === 'live') {
        flashTxt = '快讯实时';
      }
      const fs = flashTxt ? ' · ' + flashTxt : '';
      const fss = flashTxt ? '·' + flashTxt : '';
      el.title = '快讯逐源状态' + flashTip;
      // 窄屏只留短标签，避免顶栏被挤成两行
      el.innerHTML = `<span class="sp-l">${lbl}${fs}</span>`
        + `<span class="sp-s">${short}${fss}</span>`;
      el.className = 'src-pill ' + (bad ? 'bad' : ok || S.flashState === 'live' ? 'ok' : '');
    };
    tick(); setInterval(tick, 4000);
  }

  function buildNews() {
    // 信息流不从任何硬编码种子起手 —— 只有真实抓取到的快讯才会进入 S.news。
    // 抓不到就是空列表，让用户看到「没有快讯」，而不是用编造的新闻填空。
    //
    // 唯一例外是**本地缓存**：那是上一次真实抓取并已富化的条目（见 pool.js），
    // 打开就渲染，用户不必盯着空屏等第一批网络数据。
    S.news = [];
    try { hydrateFromPool(); } catch (e) { /* 单条已保护；不清空，保住已灌入的部分 */ }
  }

  function showSoftSBanner() {
    if (S.bannerDismissed) return;
    const bar = $('#alarmBanner');
    if (bar.classList.contains('soft')) return;   // 软横幅已经挂着，别重复渲染
    /* 【防重播】用户反馈：「关掉 app 再打开，S 级预警又跑出来」。
     *
     * 根因（两处，缺一不可）：
     *   ① showSoftSBanner() 在**首次轮询**时调用，而 S.news 此刻
     *      已经由 hydrateFromPool() 灌入了本地缓存里的历史条目 ——
     *      每次冷启动都会把那条**旧 S 级快讯**重新挂到顶部。
     *   ② pollFlash 合并同 id 条目时用新拉的 norm 覆盖整个对象，
     *      把 fromCache 标记冲掉了 —— 于是旧条目被当成「本轮新抓到」。
     *
     * 修法：只有「本会话真实抓到、且此前从未出现过」的 S 级才配顶横幅。
     *   · fromCache === true → 这条在之前的会话里就出现过（它在缓存池里），
     *     按用户口径「出现过预警就不再出现」，不再顶。
     *   · seen 表（mm_s_seen_v1）再兜一层：同一条 id 只提醒一次。
     */
    const sItems = S.news.filter(n => n.level === 'S' && n.live === true && !n.fromCache);
    if (!sItems.length) return;
    const unseen = sItems.filter(n => !sLevelSeen(n.id));
    if (!unseen.length) return;
    const top = unseen[0];
    if (bar.classList.contains('on')) {
      /* 顶部被**硬横幅**（行情异动）占着 —— 硬预警优先级更高。
       * 这条 S 级先不标记，等硬横幅退下后由 flushSoftBanner() 补挂，
       * 否则就会「永远不出现」（既没展示、又被 seen 表记上）。 */
      S.pendingSoftS = top.id;
      return;
    }
    S.pendingSoftS = '';
    bar.className = 'alarm on soft';
    bar.dataset.k = '';        // 软横幅不占任何品种的 key（否则会被误判成「这条已在屏」）
    bar.innerHTML = `<div class="al-ic">S</div>
      <div class="al-tx"><b>最新 S 级：${esc(top.title)}</b>
      <span>${esc(top.cat)} · ${hhmm(top.ts)} · 点此查看关联标的</span></div>
      <button class="al-x">✕</button>`;
    markAllSSeen([top]);
    bar.onclick = (e) => {
      if (e.target.classList.contains('al-x')) {
        bar.className = 'alarm';
        S.bannerDismissed = true;
        return;
      }
      const f = (top.cn && top.cn[0]) || (top.direct && top.direct[0]);
      if (f) openSheet(f.k);
    };
  }

  /** 硬横幅退下后，把被挡住的 S 级补挂上去 */
  function flushSoftBanner() {
    if (!S.pendingSoftS) return;
    const bar = $('#alarmBanner');
    if (bar.classList.contains('on')) return;
    const hit = S.news.find(n => n.level === 'S' && n.live === true && !n.fromCache
      && String(n.id) === String(S.pendingSoftS));
    if (!hit) { S.pendingSoftS = ''; return; }
    S.pendingSoftS = '';
    showSoftSBanner();
  }

  /* ---------------- S 级快讯「已展示过」记忆 ----------------
   * 落盘，跨重启生效。同一条 S 级快讯只提醒一次；
   * 新到的 S 级不在记录里，照常提醒。 */
  function sSeenStore() { return 'mm_s_seen_v1'; }
  function sSeenList() {
    try {
      const raw = localStorage.getItem(sSeenStore());
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function sLevelSeen(id) {
    if (!id) return false;
    return sSeenList().indexOf(String(id)) >= 0;
  }
  /** 把这批 S 级快讯全部标记为「已展示」，只保留最近 60 条 */
  function markAllSSeen(items) {
    try {
      const a = sSeenList();
      items.forEach(n => { if (n.id && a.indexOf(String(n.id)) < 0) a.push(String(n.id)); });
      localStorage.setItem(sSeenStore(), JSON.stringify(a.slice(-60)));
    } catch (e) { /* 静默降级 */ }
  }

  /* 版本戳只认一个来源：sw.js 里的缓存版本号。
   * 之前 index.html 手写死 "v18"，代码早升到 v23，用户点开一看还是 v18，
   * 完全没法判断自己装的是不是新包 —— 这种「凭记忆同步两处」的约定一定会漂。
   * 现在 index.html 的字面量由 tools/bump_version.py 统一写，页面再读 sw.js 校验；
   * 两边对不上（说明走到了旧缓存）就清一次 CacheStorage 重载，自己爬出新版。 */
  function syncVerPill() {
    const el = $('#verPill');
    if (!el || !w.fetch) return;
    /* v61：除了启动时查一次，回到前台 / 重新聚焦也要查（下面 checkUpd 会调）。
     * 手机上的 PWA 从后台恢复时不会触发导航，SW 也就不会去检查更新 ——
     * 用户看到的一直是几天前的旧包（截图版本戳 v148、线上早已 v153）。
     * 30 秒节流，避免频繁切前后台时反复请求。 */
    const now = Date.now();
    if (syncVerPill._t && now - syncVerPill._t < 30000) return;
    syncVerPill._t = now;
    const local = (el.textContent || '').trim();
    fetch('sw.js', { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : ''))
      .then(t => {
        const m = /macro-pulse-(v\d+)/.exec(t || '');
        if (!m) return;
        const remote = m[1];
        // 页面是旧缓存、sw.js 已经是新版本：清缓存重载一次（sessionStorage 防死循环）
        if (local && local !== remote) {
          let done = false;
          try { done = sessionStorage.getItem('mm_ver_fix') === remote; } catch (e) {}
          if (!done) {
            try { sessionStorage.setItem('mm_ver_fix', remote); } catch (e) {}
            if (w.caches && caches.keys) {
              caches.keys()
                .then(ks => Promise.all(ks.map(k => caches.delete(k))))
                .then(() => location.reload())
                .catch(() => { el.textContent = remote; });
              return;
            }
          }
        }
        el.textContent = remote;
      })
      .catch(() => {});
  }

  function boot() {
    try { initAlertEngine(); } catch (e) {}
    /* 自动化/调试抓手：闭包读模块级 chart，任何时候调用都指向「当前真正在用的」图表 */
    w.__chart = () => chart;
    w.__draw = () => (chart ? chart.drawLayer : null);
    // 允许 ?theme=light 直接进浅色（方便分享 / 截图 / 打印）
    try {
      const q = new URLSearchParams(location.search).get('theme');
      if (q === 'light' || q === 'dark') S.theme = q;
    } catch (e) {}
    applyTheme(S.theme, true);
    syncVerPill();
    /* 【版本更新 → 只清新闻缓存，不动设置】
     * 用户口径（11-06）：「检测版本更新后新闻缓存要清空，不然就会出现修复的去重
     *   还存在的问题，我现在每次都要手动到 app 后台清除数据，很麻烦，
     *   而且这样操作我的设置也会被重置」。
     *
     * 为什么必须整池清掉、而不是只是重算分级：
     * 池子里存的是**已经合并过的结果**（重复条目早已被并成一条、其余被丢弃），
     * 去重规则改好以后，重新 enrich 也变不回那些被扔掉的原文。
     * 所以口径变了（DATA_VER 或 GRADE_VER 任一变化）就整池清空、重新抓一轮。
     * 只删 mm_pool_v2 这一个键：主题、档位、标红开关、标级纠错全部原样保留。 */
    try {
      const dv = DATA_VER + '|' + gradeVerOf();
      const prev = store.get('mm_data_ver', null);
      if (prev !== null && prev !== dv) {
        if (w.NewsPool && typeof w.NewsPool.clear === 'function') w.NewsPool.clear();
        S.news = [];
      }
      store.set('mm_data_ver', dv);
    } catch (e) { /* 存储不可用（隐私模式）→ 跳过，不影响正常抓取 */ }
    buildNews();
    /* 【改造1·首屏快照】在首次渲染行情前，回填上次的报价 + 分时线，
     * 让打开瞬间即有价格和分时，不等首轮网络。随后 refresh 会静默覆盖。 */
    try { loadQuoteSnap(); } catch (e) {}
    try { loadSparkSnap(); } catch (e) {}
    /* 先把上一轮的逐源状态铺上（重载后立刻显示「已接入 N/N」，不闪"未接入"） */
    try { restoreSrcState(); } catch (e) { /* 恢复失败就按空状态起步 */ }
    /* 微信 / 部分 webview 的下拉刷新由 webview 自己实现，前端拦不住。
     * 既然重载拦不住，就把「重载」做得跟没重载一样：内容从本地池秒出（见
     * hydrateFromPool），滚动位置也回到原处，用户才不会有「新闻全被重刷一遍」的感觉。 */
    bindScrollMemo();
    bind();
    startClock();
    trackTopbarHeight();
    startPinTabbar();
    startSrcPill();
    renderTicker();
    renderSNR();
    renderSrcGrid();
    renderFeed();
    renderSettings();
    updateShellPill();

    Object.keys(U.ASSETS).forEach(k => { S.session[k] = null; });
    Object.keys(U.ASSETS).forEach(k => sessionOf(k));

    radar = new w.Radar({
      // 归因只认「事件型」快讯；行情播报（跌超/跳水/跌幅扩大）是结果，不是原因
      newsLookup: (key, min) => newsFor(key, min, ['cause']).length > 0,
      /* v100：把「具体是哪条事件新闻」交给 Radar，卡片/列表才能写出归因。
       * 只取 cause 类型（行情播报已被 newsKind 排掉），按时间倒序取最新一条。 */
      newsCause: (key, min) => {
        const list = newsFor(key, min, ['cause']).sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return list[0] || null;
      },
      newsEchoOnly: (key, min) => newsEchoOnly(key, min),
      onUpdate: (results, inst) => {
        S.activeAlerts = {};
        results.forEach(r => { if (r.status !== 'quiet') S.activeAlerts[r.key] = r; });
        if (S.tab === 'radar') renderRadar(results, inst);
        else syncAlerts(inst);
      },
      onAlert: (r) => {
        /* v197：网页内深红 .toast 浮窗已下线（用户口径「黑色弹窗」）。
         * 异动只保留顶部粉色 alarm 横幅 + 系统通知栏那条通知，
         * 不再同一件事弹两个网页浮窗。新闻驱动异动同样不弹全屏黑天鹅。 */
        if (!(r && r.kind === 'news')) showAlarm(r);
        if (S.tab === 'set') renderSettings();
      }
    });
    radar.setThresholdScale(S.thrScale);
    radar.start(20000);
    /* v201：WebView 原生下拉刷新有时会整页重载（前端 preventDefault 拦不住），
     * 重载后 S.tab 默认回 'feed'，用户就被甩回首页。这里等 radar 等依赖都就绪后，
     * 把重载前的 tab 原地恢复 —— 在矩阵/事件/行情页下拉也不再跳页。 */
    try {
      const lastTab = sessionStorage.getItem('mm_last_tab');
      if (lastTab && lastTab !== 'feed' && $('#view-' + lastTab)) switchTab(lastTab);
    } catch (e) {}

    // 调试/自检句柄：让用户能在控制台直接查看当前每个品种的实际阈值、
    // 阈值来源与历史画像，便于核对「为什么这条会亮/不亮」
    window.__radar = radar;
    // 归因分类是「不许拿结果当原因」的核心规则，暴露出来便于逐条用例核对
    window.__newsKind = newsKind;
    window.__newsEchoOnly = newsEchoOnly;
    // 预警措辞是「口径正确性」的关键，单独暴露出来便于逐条用例核对
    window.__alarmWords = alarmWords;
    window.__state = S;
    // 折叠口径自检句柄：同一商品 12h 母卡的分组与切窗，便于逐条用例核对
    window.__fold = { eventKeyOf, foldEvents, foldByTopic, commodityKeyOf, renderFeed, CM_WINDOW };
    window.__pull = { pullRefresh, bindPullRefresh, PULL_TRIGGER };
    /* 标红口径自检句柄：统计池子里有多少条带平台红标（含各源分布），
     * 用来确认「只跑标红」这一刀到底切掉了什么，不必翻 localStorage。 */
    window.__red = {
      passRed: passRed,
      stat: () => {
        const since = Date.now() - 24 * 3600 * 1000;
        const all = S.news.filter(n => n.ts >= since);
        const reds = all.filter(n => n.important);
        const by = {}, allBy = {}, byLevel = {}, allByLevel = {};
        all.forEach(n => {
          const k = String(n.src || '').split(' / ')[0];
          allBy[k] = (allBy[k] || 0) + 1;
          if (n.important) by[k] = (by[k] || 0) + 1;
          const lv = String(n.level || '?').toUpperCase();
          allByLevel[lv] = (allByLevel[lv] || 0) + 1;
          if (n.important) byLevel[lv] = (byLevel[lv] || 0) + 1;
        });
        return {
          redOnly: S.redOnly,
          gateOn: redGateOn(),
          grade: S.grade,
          in24: all.length,
          red: reds.length,
          kept: all.filter(passRed).length,
          visible: all.filter(n => passRed(n) && matchFilter(n)).length,
          bySrc: by,
          allBySrc: allBy,
          redByLevel: byLevel,
          allByLevel: allByLevel,
          noLevel: all.filter(n => !n.level).length,
        };
      },
    };
    // 原生壳点通知 / 常驻服务「通知设置」时，就地切到设置页（不整页重载）
    window.__switchTab = switchTab;
    // 弹层句柄：便于自检脚本直接打开/关闭某个弹层，核对「点任意处关闭」的行为
    window.__openSheet = openSheet;
    window.__closeSheet = closeSheet;
    window.__openNews = openNews;
    // 事件页的实时报价与渲染句柄，便于核对「卡片上的实时值到底取自哪
    window.__quoteHub = QuoteHub;
    window.__event = { eventQuoteKeys, eventMetricBar, eventCardHTML, eventDetailHTML, renderEvent };

    setInterval(() => { QuoteHub.refresh(allNewsKeys().slice(0, 12)); }, 60000);
    /* v242：v241 的 15 秒 force 全量轮询会和缩略图的 intraday 请求抢东财连接，
     * 一旦 intraday 失败又被永久缓存 null，整页缩略图就都变成灰块。
     * 「上次」标签的真正根因是 paintQuote 没清 snap 类，跟刷新频率无关，
     * 所以这里退回温和轮询：25 秒、按 TTL 自然过期、不强制全量。
     * 既把报价从 120 秒提到 25 秒，又不额外制造请求压力。 */
    setInterval(() => {
      if (S.tab !== 'market' || document.hidden) return;
      QuoteHub.refresh(mktCatKeys().filter(k => U.get(k)));
    }, 25000);
    /* v242：残留占位符定时补拉。任何一次网络抖动都能自愈，不必等 120 秒整页重绘。 */
    setInterval(() => {
      if (S.tab !== 'market' || document.hidden || !mktSparkOn) return;
      if (!document.querySelector('.mk-sp-ph[data-mksp]')) return;
      fillMkSparks();
    }, 12000);
    setInterval(() => { if (S.tab === 'market') renderMarket(); }, 120000);
    /* 盘前/盘后价 60 秒刷一次：延展时段成交稀、变化快，
     * 等 120 秒整页重绘太慢；这里只就地改那一行，不重排列表。 */
    setInterval(() => { if (S.tab === 'market') refreshExt(S.watch); }, 60000);
    // 交易时段每 30 秒重算一次标记
    setInterval(() => { Object.keys(S.session).forEach(k => delete S.session[k]); }, 30000);

    pollFlash();
    setInterval(pollFlash, 25000);
    bindPullRefresh();   // v101：接管浏览器原生下拉（整页重载 → 只拉最新新闻）

    // 启动 2 秒后主动探一遍四个数据通道，让设置页的
    // 「在线 / 异常 / 待连接」立刻是真实状态，而不是一直挂着「待连接」。
    // 链上价平时只有休市才调用，不主动探的话永远不知道通不通。
    setTimeout(() => {
      if (!w.API || typeof w.API.probeSources !== 'function') return;
      w.API.probeSources().then(r => {
        S.probe = r;
        if (S.tab === 'set') renderSettings();
      }).catch(() => {});
    }, 2000);
    setInterval(() => {
      if (!w.API || typeof w.API.probeSources !== 'function') return;
      w.API.probeSources().then(r => {
        S.probe = r;
        if (S.tab === 'set') renderSettings();
      }).catch(() => {});
    }, 5 * 60 * 1000);

    // 首屏（缓存）已经画完，再在后台补「过去 24 小时」—— 不阻塞渲染
    setTimeout(startBackfill, 1200);

    setTimeout(showSoftSBanner, 1500);

    /* 从推送通知 / 常驻服务通知点进来（壳内带 &tab=set）→ 直接落在通知设置卡片。
     * 就地切 Tab 失败时原生会退回带这个参数的整页导航，所以两条路径都覆盖。 */
    try {
      if (new URLSearchParams(location.search).get('tab') === 'set') switchTab('set');
    } catch (e) {}

    // 注册 Service Worker：手机「添加到主屏幕」后能秒开、弱网也不白屏
    // （file:// 协议下浏览器不允许注册，静默跳过即可）
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      /* v151：回到前台就主动查一次新版本。
       * 用户反复报「你说的都没改」，实际是 PWA 从后台恢复时不会自动触发
       * SW 更新检查，页面一直停在旧缓存（截图里版本戳 v148，线上早已 v150）。
       * 这里在 visibilitychange 恢复时 update()，新 SW 接管后重载一次。 */
      try {
        const checkUpd = () => {
          /* v61：先做一次「页面版本 vs sw.js 版本」比对 —— 不一致就清缓存重载。
           * 这一步比 reg.update() 更关键：SW 更新只在导航时触发，
           * 从后台恢复的场景下永远等不到，用户就一直卡在旧包。 */
          try { syncVerPill(); } catch (e) {}
          const r = navigator.serviceWorker.controller && navigator.serviceWorker.getRegistration
            ? navigator.serviceWorker.getRegistration() : null;
          (r && r.catch ? r : Promise.resolve(null)).then(reg => {
            if (!reg) return;
            if (reg.waiting) { try { sessionStorage.setItem('mm_sw_pending', '1'); } catch (e) {} }
            if (reg.update) reg.update();
          }).catch(() => {});
        };
        d.addEventListener('visibilitychange', () => { if (!d.hidden) checkUpd(); });
        w.addEventListener('focus', checkUpd);
        setTimeout(checkUpd, 8000);
        /* 新 SW 接管后自动刷一次（只刷一次，避免死循环）。
         * 首次安装时 controllerchange 也会触发，此时页面本来就是最新版，
         * 靠 hadController 把它排除掉。 */
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController) return;
          if (sessionStorage.getItem('mm_sw_pending')) {
            sessionStorage.removeItem('mm_sw_pending');
            location.reload();
          }
        });
      } catch (e) {}
    }
  }

  /* ============ v266：赚钱效应工具条（主站原生控制，iframe 只出内容） ============ */
  function effectPost(msg) {
    try {
      const f = $('#effectFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
    } catch (e) {}
  }
  let _effCompareOn = false;
  function toggleEffectFS() {
    const f = $('#effectFrame');
    if (!f) return;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      try { (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d); } catch (e) {}
      return;
    }
    /* 顶层文档对 iframe 元素发起全屏 → WebView 走 onShowCustomView，
     * 比 iframe 内部自己 requestFullscreen 可靠；同时锁横屏。 */
    try {
      const req = f.requestFullscreen || f.webkitRequestFullscreen;
      if (req) req.call(f);
    } catch (e) {}
    try { if (w.NativePulse && w.NativePulse.setLandscape) w.NativePulse.setLandscape(true); } catch (e) {}
    _tryLockLandscape(2);
    const fb = $('#effFull'); if (fb) fb.textContent = '退出';
  }
  /* 底栏高度写死 64 会多留 20px 空白：直接量 tabbar 顶边，
   * 把「视口高 - 顶边」写进 --tabHReal，含安全区，一次算准。 */
  function syncEffectH() {
    try {
      const t = $('#tabs');
      if (!t) return;
      const h = Math.max(44, Math.round(w.innerHeight - t.getBoundingClientRect().top));
      d.documentElement.style.setProperty('--tabHReal', h + 'px');
    } catch (e) {}
  }
  function initEffectBar() {
    syncEffectH();
    setTimeout(syncEffectH, 300);
    w.addEventListener('resize', syncEffectH);
    try { if (w.visualViewport) w.visualViewport.addEventListener('resize', syncEffectH); } catch (e) {}
    const cmp = $('#effCompare'), full = $('#effFull');
    if (cmp) cmp.onclick = () => {
      _effCompareOn = !_effCompareOn;
      effectPost({ mm_compare: _effCompareOn });
      cmp.classList.toggle('on', _effCompareOn);
    };
    if (full) full.onclick = toggleEffectFS;
    w.addEventListener('message', (e) => {
      const m = e.data || {};
      if (typeof m.mm_compare_state === 'boolean') {
        _effCompareOn = m.mm_compare_state;
        if (cmp) cmp.classList.toggle('on', _effCompareOn);
      }
      if (m.mm_theme_req) effectPost({ mm_theme: S.theme });
      if (m.mm_status) {
        const st = $('#effStatusText'), dot = $('#effDot');
        if (st) st.textContent = m.mm_status.text || '';
        if (dot) dot.classList.toggle('old', !m.mm_status.fresh);
      }
    });
    d.addEventListener('fullscreenchange', () => {
      const on = !!(d.fullscreenElement || d.webkitFullscreenElement);
      if (full) full.textContent = on ? '退出' : '全屏';
      if (!on) {
        try { if (w.NativePulse && w.NativePulse.setLandscape) w.NativePulse.setLandscape(false); } catch (e) {}
      }
      /* v272：系统全屏进出都重算哨兵，保证返回键按一次层级就对齐 */
      setTimeout(() => { try { bkSync(); } catch (e) {} }, 60);
    });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', () => { boot(); initEffectBar(); });
  else { boot(); initEffectBar(); }
})(window, document);
