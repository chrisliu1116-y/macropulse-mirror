/* ============================================================
 * charts.js — 图表引擎（TradingView Lightweight Charts v4）
 * 分时 / 日K / 周K / 月K 共用一套实例管理，避免移动端重复创建导致卡顿。
 * ============================================================ */
(function (w) {
  'use strict';

  const LC = w.LightweightCharts;
  const U = w.UNIVERSE;
  const UP = '#f6465d';
  const DOWN = '#0ecb81';

  /* v286【行情可信白名单 / 渲染硬闸】图表只认这些真实数据源的序列。
   * 与 api.js 的 REAL_SOURCES 一致。渲染前先断言：未失败 + 非合成 + src 在白名单，
   * 三者全过才画；任何伪造 / 无源 / 合成 / 未登记来源的序列一律拒绝并报「取数失败」。
   * 这是 series.setData 之前的最后一道闸，杜绝「顶部真报价 + 图上假曲线」重现。 */
  const SRC_NAME = Object.freeze({
    em: '东财', tencent: '腾讯', sina: '新浪', cboe: 'CBOE', cnbc: 'CNBC',
    yahoo: 'Yahoo', binance: '币安', nasdaq: '纳斯达克', naver: 'Naver',
    mixed: '多源合并', tx: '腾讯外盘', tv: 'TradingView', 'jp-pts': '日股'
  });

  // 图表配色跟随深浅主题（每次建图时重新取，切主题后重绘即可生效）
  const isLight = () => !!(w.document && w.document.body && w.document.body.classList.contains('light'));
  function pal() {
    return isLight()
      ? { grid: 'rgba(15,23,36,0.075)', axis: 'rgba(15,23,36,0.14)', text: '#5b6678', labelBg: '#ffffff', base: 'rgba(15,23,36,0.38)' }
      : { grid: 'rgba(255,255,255,0.045)', axis: 'rgba(255,255,255,0.10)', text: '#78839a', labelBg: '#1b2436', base: 'rgba(255,255,255,0.32)' };
  }

  /* v183：跳空缺口显示配置（设置页写入 localStorage，图表每次重绘现读）。
   * on=开关；n=显示最近的几个未回补缺口（1~20，默认 3）。 */
  function gapConf() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem('mm_gap_cfg') || '{}') || {}; } catch (e) {}
    let n = (c.n == null) ? 3 : (+c.n || 3);
    n = Math.max(1, Math.min(20, n));
    return { on: c.on !== false, n: n };
  }

  function timeFmt(mode) {
    const p2 = (v) => String(v).padStart(2, '0');
    return (t, tickType) => {
      const d = new Date(t * 1000);
      const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
      const h = d.getUTCHours(), mi = d.getUTCMinutes();
      if (mode === 'min') return p2(h) + ':' + p2(mi);
      /* v187：日K / 周K / 月K 统一成「年在前」的时间坐标轴。
       * 原来 日K、周K 写 9/3、1/2 —— 既没年份，也分不清 9月3日 / 3月9日；
       * 月K 本来就是 年/月。现在三种周期共用同一套格式：
       *   月/年刻度 → 2026/09
       *   日刻度（放大后）→ 2026/09/03，避免同一个月里的刻度文字重复。 */
      if (tickType === 2) return Y + '/' + p2(M) + '/' + p2(D);
      return Y + '/' + p2(M);
    };
  }

  class AssetChart {
    constructor(host, legendEl) {
      w.__mc = this;              // 调试/自动化用：指向当前图表实例
      this.host = host;
      this.legendEl = legendEl;
      this.chart = null;
      this.mode = 'min';
      this.key = null;
      this.reqId = 0;
      /* 分时图是否把盘前 / 盘后接进来（「盘后分时」开关，默认关＝只画常规时段）。
       * 由 app.js 根据用户选择设置，见 detail 页的 .sh-minbar。 */
      this.showExt = false;
      /* v164：画图工具覆盖层 + 等比/对数偏好（见 drawing.js） */
      this.drawLayer = null;
      this.scaleMode = 'linear';   // 每次 render 时按个股取（见 render）
      this.mainInd = (function () {
        try { return localStorage.getItem('mm_main_ind') === 's35' ? 's35' : 'bare'; } catch (e) { return 'bare'; }
      })();
      this._ind = null;            // 三五法则计算结果
      this._indPts = null;
      this._mainSeries = null;
      this._lastPtTime = null;
      /* v231：分时「活线」—— 分时图渲染完是静态的，报价却一直在动，
       * 不主动续尾就会出现「顶部 03:20、图上停在 03:17」。 */
      this._live = null;
      this._liveTimer = null;
      this._liveBusy = false;
      this._extS = null;           // 盘前/盘后 line series 的引用（活线要续在对应段上）
      /* v204：真分栏 —— 主图与副图指标是两个独立的 chart 实例（参考图3/4 结构） */
      this.paneMain = null; this.paneVol = null; this.volChart = null;
      this._volSeries = null; this._volDataMap = null; this._unsync = null;
    }

    /* v284：取数失败时在图区正中摆一行说明 + 「重试」按钮。
     * 只靠左上角图例那行小字，用户很容易以为「图还在加载」；
     * 明确写清「取数失败 + 具体原因（哪个源/HTTP 码）」，并给一个能立刻再试的入口。 */
    _showFailHint(msg) {
      if (!this.host) return;
      this._clearFailHint();
      const el = document.createElement('div');
      el.className = 'ch-fail';
      const t = document.createElement('span');
      t.textContent = msg;
      el.appendChild(t);
      const btn = document.createElement('button');
      btn.className = 'ch-retry';
      btn.textContent = '重试';
      btn.onclick = () => { this._clearFailHint(); this.render(this.key, this.mode); };
      el.appendChild(btn);
      this.host.appendChild(el);
      this._failEl = el;
    }

    _clearFailHint() {
      if (this._failEl && this._failEl.parentNode) this._failEl.parentNode.removeChild(this._failEl);
      this._failEl = null;
    }

    destroy() {
      this._stopLive();
      this._extS = null;
      if (this.drawLayer) { try { this.drawLayer.destroy(); } catch (e) {} this.drawLayer = null; }
      if (this._unsync) {
        this._unsync.forEach(([c, h]) => { try { c.timeScale().unsubscribeVisibleLogicalRangeChange(h); } catch (e) {} });
        this._unsync = null;
      }
      if (this.volChart) { try { this.volChart.remove(); } catch (e) {} this.volChart = null; }
      if (this.chart) { try { this.chart.remove(); } catch (e) {} this.chart = null; }
      if (this.host) this.host.innerHTML = '';
      this.paneMain = this.paneVol = null;
      this._volSeries = null; this._volDataMap = null;
    }

    _mk(mode) {
      this.destroy();
      const P = pal();
      /* v204 真分栏：主图（分时/K线）与副图指标（成交量/成交额）是**两个独立的
       * 图表实例**，各有自己的数轴、网格与面板边界 —— 参考图3/4 的结构。
       * 以前是同一个 chart 用 scaleMargins 挤出上下两块再画一条线，副图区域
       * 上永远叠着主图的刻度与网格，怎么加线都「没有真正分隔」。 */
      const mainEl = document.createElement('div');
      mainEl.className = 'pane-main';
      this.host.appendChild(mainEl);
      this.paneMain = mainEl;
      const chart = LC.createChart(mainEl, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: P.text,
          fontFamily: "'SF Mono',ui-monospace,Menlo,Consolas,monospace",
          fontSize: 10
        },
        /* v205：所有网格线统一由自画的横格提供（只有横格、全部一样淡）。
         * 库自带的竖格 / priceScale 边框比横格深，用户反馈「两边粗中间淡」，
         * 且副图那根数轴边框会出现在画面中间——干脆全部关掉。 */
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        /* v205：主图不显示数轴文字与边框，但**必须让 priceScale 参与布局**。
         * 直接 visible:false 会把价格轴压成 0 高度（实测 hi/lo 都映射到 ~10px），
         * 分时线全部挤在顶端 —— 正是用户说的「走势线跑到外面、上面没显示完」。
         * 正确做法：visible:true + borderVisible:false + minimumWidth:0，
         * 各 series 再用空 formatter 让刻度文字消失（价格改由左侧小字给出）。 */
        rightPriceScale: { visible: true, borderVisible: false, minimumWidth: 0, scaleMargins: { top: 0.05, bottom: 0.05 } },
        leftPriceScale: { visible: true, borderVisible: false, minimumWidth: 0 },
        timeScale: {
          borderColor: P.axis,
          /* 时间刻度统一放到副图底部（同参考图3）；缩放/平移手势仍在主图 */
          visible: false,
          secondsVisible: false,
          /* v205：不留右侧空白，fitContent() 后从最左开盘到最右收盘铺满 */
          rightOffset: 0,
          barSpacing: mode === 'min' ? 3 : 6,
          /* 【必须放开】盘后分时一天有 960 根分钟点（04:00–20:00 ET），
           * 手机屏 ~400px 只有 0.4px/根，而默认 minBarSpacing 是 0.5 ——
           * 库会拒绝压缩，于是 setVisibleLogicalRange 被夹住，画面只剩最后
           * 8 个多小时：盘前段整段看不到，用户以为「还是正常时段的分时」。 */
          minBarSpacing: 0.12,
          fixLeftEdge: true,
          tickMarkFormatter: timeFmt(mode)
        },
        crosshair: {
          mode: LC.CrosshairMode.Normal,
          vertLine: { color: 'rgba(90,150,255,0.55)', width: 1, style: 3, labelBackgroundColor: P.labelBg },
          horzLine: { color: 'rgba(90,150,255,0.55)', width: 1, style: 3, labelBackgroundColor: P.labelBg }
        },
        localization: {
          locale: 'zh-CN',
          timeFormatter: (t) => {
            const d = new Date(t * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
          }
        }
      });
      this.chart = chart;
      /* v181：指标左上角的背离提示要跟着十字光标走——
       * 光标指到哪根 K 线，就显示那根的背离状态（没有就消失）；
       * 光标离开图表时回落到最后一根（即「当前」状态）。 */
      try {
        const self2 = this;
        chart.subscribeCrosshairMove(function (param) { self2._onCross(param); });
      } catch (e) {}
      /* v164：等比 / 对数（0=Normal 等比，1=Logarithmic） */
      try {
        chart.priceScale('right').applyOptions({ mode: this.scaleMode === 'log' ? 1 : 0 });
      } catch (e) {}
      return chart;
    }

    /* v204：副图指标面板（成交量 / 成交额）—— 独立 chart 实例、独立数轴。
     * 右轴显示的是量/额自己的刻度（不再是主图的价格），时间刻度在本面板底部。 */
    _mkVol(mode) {
      const P = pal();
      const volEl = document.createElement('div');
      volEl.className = 'pane-vol';
      this.host.appendChild(volEl);
      this.paneVol = volEl;
      const chart = LC.createChart(volEl, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: 'transparent' },
          textColor: P.text,
          fontFamily: "'SF Mono',ui-monospace,Menlo,Consolas,monospace",
          fontSize: 10
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        /* v205：副图同样要让 priceScale 参与布局（visible:false 会把柱子压扁），
         * 但边框和刻度数字都不显示 —— 没有那根中间的竖线、没有成交额数字，
         * 柱子从最左一路铺到最右（同参考图4/5）。 */
        rightPriceScale: { visible: true, borderVisible: false, minimumWidth: 0, scaleMargins: { top: 0.10, bottom: 0 } },
        timeScale: {
          borderColor: P.axis, timeVisible: mode === 'min', secondsVisible: false,
          rightOffset: 0, barSpacing: mode === 'min' ? 3 : 6,
          minBarSpacing: 0.12, fixLeftEdge: true,
          tickMarkFormatter: timeFmt(mode)
        },
        crosshair: {
          mode: LC.CrosshairMode.Normal,
          vertLine: { color: 'rgba(90,150,255,0.55)', width: 1, style: 3, labelBackgroundColor: P.labelBg },
          horzLine: { visible: false }
        },
        /* 手势全部交给主图，副图只跟着主图的时间范围走 */
        handleScroll: false, handleScale: false,
        localization: {
          locale: 'zh-CN',
          timeFormatter: (t) => {
            const d = new Date(t * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
          }
        }
      });
      this.volChart = chart;
      this._syncTime();
      return chart;
    }

    /* v204：主图 / 副图时间范围双向同步 —— 缩放、平移谁动都把另一边拉齐 */
    _syncTime() {
      const a = this.chart, b = this.volChart;
      if (!a || !b) return;
      if (this._unsync) {
        this._unsync.forEach(([c, h]) => { try { c.timeScale().unsubscribeVisibleLogicalRangeChange(h); } catch (e) {} });
      }
      this._unsync = [];
      let lock = false;
      const self = this;
      const wire = (src, dst) => (r) => {
        if (lock || !r) return;
        lock = true;
        try { dst.timeScale().setVisibleLogicalRange(r); } catch (e) {}
        /* v205：缩放/平移后 K 线左侧的价格小字要跟着重算 */
        try { self._paintKPrices(); } catch (e) {}
        lock = false;
      };
      try {
        const h1 = wire(a, b); a.timeScale().subscribeVisibleLogicalRangeChange(h1); this._unsync.push([a, h1]);
        const h2 = wire(b, a); b.timeScale().subscribeVisibleLogicalRangeChange(h2); this._unsync.push([b, h2]);
      } catch (e) {}
    }

    /* v204 / v205：主图横向网格 —— 6 等分，中线就是零轴，上下各 3 格对称。
     * v205：所有线（中线也一样）必须同样淡，不再单独加深中线。 */
    _drawEqualGrid(el) {
      const g = document.createElement('div');
      g.className = 'pane-grid';
      let html = '';
      for (let i = 1; i < 6; i++) html += `<i${i === 3 ? ' class="mid"' : ''} style="top:${(i / 6 * 100).toFixed(3)}%"></i>`;
      g.innerHTML = html;
      el.appendChild(g);
    }

    /* v205：把 priceScale 的轴区挤出可视范围，让绘图区真正从最左铺到最右。
     * LC 即使刻度文字为空，左右 priceScale 仍固定占位（实测各 54px），
     * 408px 的面板里绘图区只剩 300px —— 用户看到的「中间才在跑、两边被
     * 分隔开、图被缩小」就是它。这里按实际轴宽把两个面板左右外扩，
     * 配合 .chart-host{overflow:hidden} 把轴裁掉，绘图区正好等于 host 宽度。 */
    _expandPanes() {
      const run = () => {
        if (!this.chart || !this.host) return;
        let L = 0, R = 0;
        try {
          L = Math.min(80, Math.max(0, Math.round(this.chart.priceScale('left').width() || 0)));
          R = Math.min(80, Math.max(0, Math.round(this.chart.priceScale('right').width() || 0)));
        } catch (e) {}
        this.host.style.setProperty('--paneL', L + 'px');
        this.host.style.setProperty('--paneR', R + 'px');
        this._paneL = L; this._paneR = R;
        /* 面板宽度变了，K 线极值标注的夹取边界也必须跟着重算，
         * 否则会把实际在右侧的最低价硬夹到中间（用户：位置不理想）。 */
        try { this._paintKPrices(); } catch (e) {}
        /* v213【分时铺满校正】：fitContent 在面板外扩（--paneL/--paneR）生效前执行时，
         * barSpacing 是按未扩宽的绘图区算的（实测 270px/391点=0.69），扩宽后绘图区变
         * 378px，多出的宽度全成了右侧空白 —— 无副图的品种（费半 SOX 全天 volume=0
         * 不建副图）没有任何东西来纠正，分时只铺 71%；有副图的品种靠副图 fitContent
         * + _syncTime 回写碰巧被拉回满宽。这里在面板宽度定稿后按数据首尾时间重钉。 */
        this._refitMin();
      };
      /* priceScale.width() 要等布局完成才量得到（render 当场读是 0），
       * 所以下一帧和 150ms 各补量一次。 */
      run();
      try { requestAnimationFrame(() => { run(); setTimeout(run, 150); }); } catch (e) {}
    }

    /* v220：分时图 X 轴固定成「当天完整交易时段」。
     * 原来 _refitMin 用 fitContent 按**数据首尾**铺满 —— 盘中看就是
     * 「才开盘一小时，线已经走到最右边」。这里把当天还没到的时段补成
     * whitespace 点（只有 time、没有 value），lightweight-charts 会给它们
     * 留槽位但不画线，于是线只画到当前时刻、右侧留白（对齐通达信）。
     * 返回的点直接 concat 到 series.setData 的末尾。 */
    /* v232：分时「全天格数」——只用来钉可视范围，不再往 series 里塞空白点。
     * 【真实 bug】原来 _buildPad 补 {time} 无 value 的 whitespace 点：
     *   ① BaselineSeries 会在数据段顶部画出一条贯穿全段的红色水平线
     *      （用户截图：韩国 KOSPI 09:47 顶部那条红线）；
     *   ② 刚开盘 n 很小，线只占 n/want ≈ 7% 宽，看着就是「打开 10 秒还空白」
     *      （用户截图：恒生 09:48 空白，其实数据早就到了）。
     * 现在 series 只放真实点，用 setVisibleLogicalRange 把右边界钉到「当前应有格数」，
     * 右侧留白交给库画，不再有假数据。两种部署（主站 / GitHub Pages）行为一致。 */
    _minBars(pts, key) {
      let total = 0, gran = 1;
      try {
        const a = (U && U.get) ? U.get(key) : null;
        /* VIX 的 GTH 03:15–16:15 ET 共 780 分钟，比美股常规 390 长一倍 */
        if (a && a.minSpan) total = a.minSpan;
        else {
          let sk = a && a.sess;
          if (!sk && U && U.grp) { const g = U.grp(key); sk = g && g.session; }
          total = (w.Session && w.Session.fullMinutes) ? w.Session.fullMinutes(sk) : 0;
        }
      } catch (e) { total = 0; }
      if (!total || !pts || pts.length < 2) return null;
      /* 粒度取「最常见的相邻间隔」：A股/港股午休那个 90 分钟大跳空会被排除 */
      const c = {};
      for (let i = 1; i < pts.length; i++) {
        const d = Math.round((pts[i].time - pts[i - 1].time) / 60);
        if (d > 0 && d <= 30) c[d] = (c[d] || 0) + 1;
      }
      let best = 0;
      for (const k in c) if (c[k] > best) { best = c[k]; gran = +k; }
      return { want: Math.round(total / gran), n: pts.length };
    }

    /* 把分时可视范围钉到「开盘 → 当前应有位置」。
     * 右侧留白随交易推进收窄：刚开盘给约 2.2 倍宽度（线占 ~45%，看得清），
     * 数据接近全天格数时才铺满 —— 既不「一开盘就走满」，也不「只剩一条缝」。
     * keepUserZoom=true 时（活线每 8 秒的追加）若用户自己缩放过就不抢视野。 */
    _pinMin(pts, key, keepUserZoom) {
      if (this.mode !== 'min' || !this.chart || !pts) return;
      /* v236：盘前/盘后段在画的时候按「全部点」铺满，不按单一时段的格数钉，
       * 否则延展段会被切到可视区外（见 render 里 _extView 的注释）。 */
      if (this._extView) {
        try {
          this.chart.timeScale().fitContent();
          if (this.volChart) this.volChart.timeScale().fitContent();
        } catch (e) {}
        return;
      }
      const m = this._minBars(pts, key);
      if (!m) return;
      const to = Math.min(m.want, Math.max(m.n + 8, Math.round(m.n * 2.2)));
      try {
        if (keepUserZoom && this._pinTo != null) {
          const r = this.chart.timeScale().getVisibleLogicalRange();
          if (r && Math.abs(r.to - this._pinTo) > 2) return;
        }
        const range = { from: -1, to: to };
        this.chart.timeScale().setVisibleLogicalRange(range);
        if (this.volChart) this.volChart.timeScale().setVisibleLogicalRange(range);
        const rr = this.chart.timeScale().getVisibleLogicalRange();
        this._pinTo = rr ? rr.to : to;
      } catch (e) {}
    }

    /* ===== v231 分时「活线」 =====
     * 用户报的「还是有延迟」不是取数慢，而是**图不会自己往前走**：
     * 分时图只在 render 那一刻取一次数据（那一刻线尾已被 withLiveTip 补到当前分钟），
     * 之后报价每几秒刷新、顶部价格在跳，图却停在打开时的那一分钟 ——
     * 放 3 分钟就看着「慢 3 分钟」，放 10 分钟就「慢 10 分钟」。
     * 所有品种都中招，只是恰好被英伟达的截图抓到。
     * 这里每 8 秒用实时报价把线尾续到当前分钟；缺口 >5 分钟（已收盘 / 源断了）不动。 */
    _stopLive() {
      if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
      this._live = null;
    }

    _liveSetup(key, o) {
      this._stopLive();
      this._live = { key: key, arr: o.arr, series: o.series, paint: o.paint, hasPad: !!o.hasPad, seg: o.seg || null };
      this._liveTimer = setInterval(() => this._liveTick(), 8000);
    }

    async _liveTick() {
      const L = this._live;
      if (!L || this.mode !== 'min' || !L.series || !L.arr || !L.arr.length) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this._liveBusy) return;
      let q = (w.API && w.API.cachedQuote) ? w.API.cachedQuote(L.key) : null;
      if (!q || !(q.price > 0)) {
        /* 报价缓存没热（刚进详情页）就补一次，别让线头干等 */
        this._liveBusy = true;
        try {
          const r = await w.API.batchQuote([L.key]);
          q = (r && r[L.key]) ? r[L.key] : null;
        } catch (e) { q = null; }
        this._liveBusy = false;
        if (this._live !== L) return;          // 期间切了品种 / 周期
      }
      if (!q || !(q.price > 0)) return;
      /* v287：报价时间戳超过 3 分钟就别再续点了。
       * 以前只要缓存里有个旧价，活线每 8 秒都会把它写到「当前分钟」，
       * 图上看着一直在走，其实是把同一个旧价复制了一整条尾巴。
       * 与 app.js paintQuote 的 snap-old 阈值保持一致。 */
      if (q.at && Date.now() - q.at > 180000) return;
      let px = q.price;
      /* v236：延展段的实时价不能取批量报价（那是常规收盘价），改取 extQuotes
       * 的盘前/盘后价；取不到就这一轮不动，绝不把线尾拉回昨收。 */
      if (L.seg === 'pre' || L.seg === 'post') {
        let e = null;
        try {
          const m = await w.API.extQuotes([L.key]);
          e = m && m[L.key];
        } catch (err) { e = null; }
        if (this._live !== L) return;
        if (!e || !(e.price > 0)) return;
        if (e.phase && e.phase !== L.seg) return;   // 时段变了（盘前→盘中），别混着画
        px = e.price;
      }
      const nowMin = Math.floor((Date.now() + 8 * 3600e3) / 60000) * 60;
      const last = L.arr[L.arr.length - 1];
      if (!last || !isFinite(last.close)) return;
      const gap = nowMin - last.time;
      if (gap < 0 || gap > 300) return;
      let np = last, added = false;
      if (gap === 0) {
        last.close = px;
        if (!(last.high >= px)) last.high = px;
        if (!(last.low <= px)) last.low = px;
      } else {
        np = {
          time: nowMin, open: last.close, close: px,
          high: Math.max(last.close, px), low: Math.min(last.close, px),
          volume: 0
        };
        if (last.seg) np.seg = last.seg;       // 盘前/盘后段续尾时保住段标签
        /* 当前这一分钟还没有成交量、均价也还没结算：继承上一根，
         * 否则顶部信息行的「均 / 量」会在活线补点后整块消失。 */
        if (last.avg) np.avg = last.avg;
        if (last.volume) np.volume = last.volume;
        if (last.amount) np.amount = last.amount;
        L.arr.push(np);
        added = true;
      }
      try {
        /* 一律 setData 重建：主图末尾补了「当天剩余时段」的 whitespace 点，
         * update({time}) 只能往后追加，时间落在空白段之前会被库拒掉（Cannot update oldest data）。
         * 重建后时间跨度不变，可视范围不会跳。 */
        const d = L.arr.map(p => ({ time: p.time, value: p.close }));
        L.series.setData(d);
      } catch (e) { return; }
      this._pinMin(L.arr, L.key, true);
      try { L.paint(np); } catch (e) {}
    }

    /* v213/v215：分时模式下在面板宽度定稿后重新铺满可视范围。
     * 用 fitContent 而不是「按主图首尾 setVisibleRange」—— 盘前/盘后段是
     * **独立的 line series**（不在主图里），只按主图范围钉会把它们切掉。
     * v220：主图/副图数据末尾已补了当天剩余时段的 whitespace 点，
     * 所以这里的 fitContent 会正好铺满「开盘→收盘」整段，而不是数据首尾。
     * 只在前 150ms 的 _expandPanes 补量里调用，不覆盖用户后续的缩放/平移。 */
    _refitMin() {
      if (this.mode !== 'min' || !this.chart) return;
      this._pinMin(this._minPts, this._minKey, false);
    }

    /* v205：K 线不显示数轴，价格信息用最左侧的灰色小字（参考图5）。
     * 与 6 等分横格严格对应：第 i 条线 = hi - (hi-lo)*i/6。
     * 缩放/平移时由 _syncTime 的回调重算。 */
    _paintKPrices() {
      const el = this.paneMain, view = this._kview;
      if (!el || !view || !view.length || this.mode === 'min' || !this.chart) return;
      let lo = null, hi = null, hiI = -1, loI = -1, a = 0, b = view.length - 1;
      try {
        const r = this.chart.timeScale().getVisibleLogicalRange();
        if (r) { a = Math.max(0, Math.floor(r.from)); b = Math.min(view.length - 1, Math.ceil(r.to)); }
      } catch (e) {}
      for (let i = a; i <= b; i++) {
        const p = view[i];
        if (!p || !isFinite(p.low) || !isFinite(p.high) || p.low <= 0) continue;
        if (lo == null || p.low < lo) { lo = p.low; loI = i; }
        if (hi == null || p.high > hi) { hi = p.high; hiI = i; }
      }
      if (lo == null || hi == null || hi <= lo) return;
      let box = el.querySelector('.pane-prices');
      if (!box) { box = document.createElement('div'); box.className = 'pane-prices'; el.appendChild(box); }
      let html = '';
      for (let i = 1; i < 6; i++) {
        html += `<span style="top:${(i / 6 * 100).toFixed(3)}%">${(hi - (hi - lo) * i / 6).toFixed(this.dec)}</span>`;
      }
      /* v206：最高/最低价不再由 DrawLayer 的 canvas 画（坐标基准会偏，
       * 用户：4258.86 跑到前一波高点去了）。直接用 chart API 把小字
       * 精确定位到**实际极值那根 K 线**的正上方 / 正下方（对齐参考图4）。 */
      const mk = (idx, price, cls) => {
        const p = view[idx];
        if (!p) return '';
        let x = null, y = null;
        try { x = this.chart.timeScale().timeToCoordinate(p.time); } catch (e) {}
        try { y = this._mainSeries.priceToCoordinate(price); } catch (e) {}
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) return '';
        /* 面板左右各外扩了一个 priceScale 宽度并被 overflow 裁掉，极值又常
         * 正好落在可视区上下边界（y=0 / y=高），必须夹回可视区才看得见。
         * 62px ≈ 实测轴宽 54 + 8 余量，水平仍紧贴实际极值点。 */
        /* chart.timeScale().timeToCoordinate 返回的是**绘图区坐标**，
         * 而标签挂在 pane-main（左右各外扩了一个轴宽）上，必须补 L 才是面板坐标。
         * 以前没补，加上按外扩前宽度硬夹，最低价就被推到了画面中间。 */
        const L = this._paneL || 0, R = this._paneR || 0;
        const pw = el.clientWidth || 516, ph = el.clientHeight || 186;
        let px = x + L;
        px = Math.max(L + 24, Math.min(pw - R - 24, px));
        y = Math.max(14, Math.min(ph - 18, y));
        return `<span class="k-ext ${cls}" style="left:${px.toFixed(1)}px;top:${y.toFixed(1)}px">${price.toFixed(this.dec)}</span>`;
      };
      html += mk(hiI, hi, 'hi') + mk(loI, lo, 'lo');
      box.innerHTML = html;
    }

    async render(key, mode) {
      if (!this.host) return;
      /* v231：换品种 / 换周期前先掐掉旧的活线定时器，否则会往已经销毁的 series 上写数据 */
      this._stopLive();
      this._clearFailHint();
      this._extS = null;
      const myReq = ++this.reqId;
      this.key = key;
      this.mode = mode;
      /* v167：坐标模式（等差/对数）按个股各记各的，切品种时先取这只股的偏好 */
      this.scaleMode = (w.DRAW_SCALE && w.DRAW_SCALE.get) ? w.DRAW_SCALE.get(key) : 'linear';
      const dec = U.decimals(key);
      this.dec = dec;
      const priceFmt = (v) => U.fmt(key, v);
      const chart = this._mk(mode);

      const isMin = mode === 'min';
      let data;
      try {
        data = isMin ? await w.API.intraday(key) : await w.API.candles(key, mode);
      } catch (e) {
        if (this.legendEl) this.legendEl.innerHTML = '<span class="lg-err">数据加载失败</span>';
        this._showFailHint('数据加载失败：' + ((e && e.message) || '网络异常'));
        return;
      }
      if (myReq !== this.reqId) return; // 已被更新的请求取代

      const pts = data.points || [];
      /* v286【行情可信断言 / 白名单硬闸】只有「未失败 + 非合成 + src 在真实源白名单」
       * 的序列才允许被画成行情。任何伪造 / 无源 / 合成 / 未登记来源的序列一律
       * 拒绝渲染并明确报错 —— 即使上游将来又误塞进假序列，也到不了 series.setData。 */
      const srcOk = !!(data && Object.prototype.hasOwnProperty.call(SRC_NAME, data.src));
      const rejected = !!(data && data.failed) || (data && data.synthetic === true) || !srcOk;
      if (!pts.length || rejected) {
        const reason = (data && data.failed)
          ? String(data.error || '数据源无响应')
          : (rejected && !srcOk)
            ? ('数据来源未通过校验（' + ((data && data.src) || '无源') + '）')
            : '数据源无响应';
        const pretty = reason.replace(/Failed to fetch/gi, '连接被断开');
        const why = (data && data.failed) || rejected
          ? ('取数失败：' + pretty + '（稍后会自动重试）')
          : ('暂无' + (isMin ? '分时' : 'K线') + '数据');
        if (this.legendEl) {
          this.legendEl.innerHTML = '';
          const s = document.createElement('span');
          s.className = 'lg-err';
          s.textContent = (data && data.failed) || rejected ? '取数失败' : '暂无数据';
          s.title = why;
          this.legendEl.appendChild(s);
        }
        this._showFailHint(why);
        return;
      }
      /* v284【来源三要素】数据源 + 时间戳（图例里的 HH:MM）+ 是否延迟（app.js 的
       * 「延迟」角标）。来源直接标在图例上，用户不必猜这条线是谁给的。 */
      const srcName = SRC_NAME[data.src];
      /* v183：K 线缺口只算一次（含「是否已被回补」判定），重绘时只做筛选 */
      this._buildGaps(pts);

      /* 清掉上一轮的副图标签：render 每次重建图表，但标签是挂在 host 上的 DOM，
       * 不清理会累积；切到「既无成交额也无成交量」的品种时还会残留旧的 AMO。 */
      if (this._subTag && this._subTag.parentNode) this._subTag.parentNode.removeChild(this._subTag);
      this._subTag = null;
      /* v201：四角小字标签也是挂 host 的 DOM，切品种/切周期前要清掉，
       * 否则 K 线图上会残留分时的小字。 */
      if (this._axisTag && this._axisTag.parentNode) this._axisTag.parentNode.removeChild(this._axisTag);
      this._axisTag = null;
      if (this._paneSep && this._paneSep.parentNode) this._paneSep.parentNode.removeChild(this._paneSep);
      this._paneSep = null;

      // ---------- 副图一：成交额优先，其次成交量，都没有就不画 ----------
      /* 用户口径：有成交额就显示成交额（AMO，单位亿/万），没有成交额退回成交量（VOL），
       * 两者都没有就别占地方（主图自己铺满）。 */
      const hasAmt = pts.some(p => (p.amount || 0) > 0);
      const hasVol = pts.some(p => (p.volume || 0) > 0);
      const useAmt = hasAmt;
      const hasSub = useAmt || hasVol;
      /* v205：提到顶层 —— 顶部信息行也用同一个格式显示成交额/成交量
       * （副图不再显示数轴数字，量/额改到开高低收那一行，十字游标跟着走）。 */
      const fmtAmt = (v) => {
        if (!isFinite(v) || v <= 0) return '--';
        if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
        if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
        return String(Math.round(v));
      };
      /* v204：无副图的品种，主面板铺满整个 host */
      this.host.classList.toggle('no-vol', !hasSub);
      if (hasSub) {
        /* v204：成交量 / 成交额画进**独立的副图面板**（自己的 chart、自己的数轴），
         * 右轴刻度是量/额自己的值，不再是主图的价格。 */
        const volChart = this._mkVol(mode);
        const volSeries = volChart.addHistogramSeries({
          /* v205：副图不显示数轴数字（量/额改到顶部开高低收那一行，
           * 十字游标放上去即可看到）；空 formatter 让刻度文字消失。 */
          priceFormat: { type: 'custom', minMove: 1, formatter: () => '' },
          lastValueVisible: false,
          priceLineVisible: false
        });
        volSeries.setData(pts.map(p => ({
          time: p.time,
          value: useAmt ? (p.amount || 0) : (p.volume || 0),
          color: (p.close >= p.open) ? 'rgba(246,70,93,0.42)' : 'rgba(14,203,129,0.42)'
        })));
        this._volSeries = volSeries;
        this._volDataMap = new Map(pts.map(p => [p.time, useAmt ? (p.amount || 0) : (p.volume || 0)]));
        /* 主图十字光标带动副图垂直线（单向；副图手势已禁用） */
        try {
          const self3 = this;
          chart.subscribeCrosshairMove((param) => {
            const vc = self3.volChart, vs = self3._volSeries;
            if (!vc || !vs) return;
            try {
              /* v205：必须是真实指针在图上（param.point 存在）才联动。
               * 图表初始化时 LC 也会发一次带 time 但没有 point 的事件，
               * 以前会因此在副图正中间留下一条永久竖线（用户明确要求不要）。 */
              if (param && param.point && param.time && self3._volDataMap && self3._volDataMap.has(param.time)) {
                vc.setCrosshairPosition(self3._volDataMap.get(param.time), param.time, vs);
              } else vc.clearCrosshairPosition();
            } catch (e) {}
          });
        } catch (e) {}
        /* 副图左上角的「AMO / VOL」标签 */
        const tag = document.createElement('div');
        tag.className = 'sub-tag';
        /* v172：只显示 AMO / VOL 两个字母，不再跟数字 ——
         * 用户口径：那么大的数字对判断没帮助，反而挡视线。 */
        tag.innerHTML = '<b>' + (useAmt ? 'AMO' : 'VOL') + '</b>';
        this.paneVol.appendChild(tag);
        this._subTag = tag;
      }

      let mainSeries;
      let view = pts;              // 实际画出来的点集（常规 or 含延展）
      let useExt = false;          // 这次是否把盘前/盘后接上去
      /* v231：活线要用的两个值从 isMin 块里带出来（mainPts/hasSeg 都是块内 const） */
      let liveArr = null, liveHasSeg = false;
      if (isMin) {
        const hasSeg = pts.some(p => p.seg);
        /* 【盘后分时】用户口径：★默认点进去就是正常分时（和富途一样），
         * 另有一个「盘后分时」开关，打开了才把盘前 04:00–09:30 ET、
         * 盘后 16:00–20:00 ET 的成交接上去，并分别上色。 */
        useExt = !!this.showExt && !!data.ext;
        /* v236【盘前分时的 0% 基准】接了延展段之后，零轴必须是「最近一次常规收盘」
         * （regClose），不能再拿 preClose。preClose 是「上一交易日涨跌幅的分母」，
         * 比常规收盘早一天：美光现价 733.15 时 preClose=690（733.15 正是相对 690
         * 的 +6.25%），拿 690 当 0 轴，盘前 -1.64% 会被画成 +4.7%，整条盘前线贴到
         * 图顶、右轴 ±7.84% 也和顶部「盘前 -0.87%」对不上（用户 11-10 20:15 截图）。
         * 常规分时（不接延展段）继续用 preClose —— 那是它自己那一场的昨收。 */
        const base = (useExt && data.regClose) ? data.regClose : (data.preClose || pts[0].close);
        /* 把「这条序列到底有没有延展段」记在实例上，供 app.js 决定
         * 「盘后分时」开关要不要露出来。纳斯达克偶尔取数失败会回退东财
         * 常规时段（只有 reg 点），此时开关点下去没有任何变化 ——
         * 用户看到的就是「盘后分时没加载出来」。 */
        this.extAvailable = !!data.ext;
        const regPts = hasSeg ? pts.filter(p => p.seg === 'reg') : pts;
        view = (hasSeg && !useExt && regPts.length > 3) ? regPts : pts;
        let mainPts = view;
        if (hasSeg && useExt) mainPts = regPts.length ? regPts : view;
        liveArr = mainPts; liveHasSeg = hasSeg;
        this._minPts = mainPts; this._minKey = key; this._pinTo = null;

        /* v187：分时的零轴＝昨收(0%)，上下限＝当天最大振幅的**对称** ±amp。
         * 用户口径：最低 -3%、最高 +5% → 上限 +5%、下限 -5%、0% 落在正中；
         * 即使全天都在昨收之上（如 +2.33% ~ +6.84%），也要画成 ±6.84%，
         * 零轴在中间，才看得出"离昨收多远"。
         * 右轴(价格)与左轴(百分比)都强制成同一段线性区间，刻度才能逐格对齐。 */
        const pctOf = (c) => (c - base) / base * 100;
        let amp = 0;
        const ampSrc = useExt ? pts : mainPts;
        for (let i = 0; i < ampSrc.length; i++) {
          const a = Math.abs(pctOf(ampSrc[i].close));
          if (isFinite(a) && a > amp) amp = a;
          /* v204：均价也计入振幅 —— 高开回落时均价可能高于全部 close，
           * 不算它均价线会画出主面板（用户：走势线跑到外面去了）。 */
          const g = ampSrc[i].avg;
          if (g > 0) {
            const b2 = Math.abs((g - base) / base * 100);
            if (isFinite(b2) && b2 > amp) amp = b2;
          }
        }
        if (!isFinite(amp) || amp <= 0) amp = 1;
        const ampPrice = base * amp / 100;
        /* 留个引用便于自动化验收核对左右轴是否都按 ±amp 对称 */
        this._minBase = base;
        this._minAmp = amp;

        /* v235：分时主图改用普通 LineSeries。
         * BaselineSeries 会在昨收基准线 / 填充边界处额外画一条水平实线，
         * 且只画到「有数据的最后一格」——用户截图里 KOSPI、恒生、沪深300
         * 都出现「一条卡在半路、末端带方块的红色横线」。实测关掉
         * baseLineVisible、把四个填充色改成透明、改 topLineColor 都去不掉，
         * 清空主图数据才消失 —— 是库内部的 baseline 渲染，不是行情源问题。
         * 换成只画一条线的 LineSeries 后彻底消失；零轴仍由 6 等分横格中线表示。 */
        const lastPx = mainPts.length ? mainPts[mainPts.length - 1].close : base;
        /* v288：分时主线统一用蓝色（对齐目标详情页），不再按涨跌染红/绿；
         * 涨跌仍由右侧报价数字与图例颜色表达。深浅主题各一档蓝。 */
        mainSeries = chart.addLineSeries({
          color: isLight() ? '#2b6fd6' : '#4f9dff',
          lineWidth: 2,
          priceFormat: { type: 'custom', minMove: Math.pow(10, -dec), formatter: () => '' },
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false
        });
        mainSeries.setData(mainPts.map(p => ({ time: p.time, value: p.close })));

        /* 盘前 / 盘后两段单独画线：
         *   · 盘前＝蓝（沿用暗盘那套冷色，表示「还没开盘」）
         *   · 盘后＝琥珀（和行情页 .mk-ext 同一色，一眼能对上）
         * v215：盘前段不一定在常规段**前面** —— 盘前时段拼出来的是
         * 「上一交易日 reg + 今天 pre」，pre 在 reg 之后。所以不能再用
         * slice(0, firstReg) 那套按位置切的写法，改成按 seg 取点，
         * 再按时间判断该接首根还是末根常规点，保证接缝不断。 */
        if (useExt && hasSeg) {
          const regIdx = [];
          pts.forEach((p, j) => { if (p.seg === 'reg') regIdx.push(j); });
          const extLine = (arr, color, seg) => {
            if (arr.length < 2) return;
            const s = chart.addLineSeries({
              color: color, lineWidth: 2, lastValueVisible: false,
              priceLineVisible: false, crosshairMarkerVisible: false,
              /* v201：盘前/盘后段也不许往右轴写密集刻度 */
              priceFormat: { type: 'custom', minMove: Math.pow(10, -dec), formatter: () => '' },
              /* v203：盘前/盘后段同样锁在 ±amp 区间（amp 已按含延展的点集算过） */
              autoscaleInfoProvider: () => ({ priceRange: { minValue: base - ampPrice, maxValue: base + ampPrice } })
            });
            s.setData(arr.map(p => ({ time: p.time, value: p.close })));
            /* v231：记住这一段的 series 与点集 —— 活线要把线尾续在「当前正在走的那一段」上 */
            this._extS = this._extS || {};
            this._extS[seg] = { s: s, arr: arr };
          };
          const drawExt = (segPts, color, seg) => {
            if (!segPts.length) return;
            let arr = segPts.slice();
            if (regIdx.length) {
              const firstReg = pts[regIdx[0]];
              const lastReg = pts[regIdx[regIdx.length - 1]];
              if (segPts[0].time > lastReg.time) arr = [lastReg].concat(arr);            // 隔夜盘前：接在常规收盘后
              else if (segPts[segPts.length - 1].time < firstReg.time) arr = arr.concat([firstReg]); // 同日盘前：接到开盘
            }
            extLine(arr, color, seg);
          };
          drawExt(pts.filter(p => p.seg === 'pre'), isLight() ? 'rgba(63,110,216,0.95)' : 'rgba(122,162,255,0.95)', 'pre');
          drawExt(pts.filter(p => p.seg === 'post'), isLight() ? 'rgba(210,128,26,0.95)' : 'rgba(255,196,84,0.95)', 'post');
        }
        /* 【v187】对称振幅定轴：右轴 [昨收-amp, 昨收+amp]。
         * 原来是「把昨收拉进 min/max」，全天飘红时 0% 就被挤到画面最底下，
         * 看起来像以开盘为零轴、也读不出实际涨跌。 */
        mainSeries.applyOptions({
          /* 不回传 margins：original() 的数据边距会把 ±amp 再撑大一圈，
           * 右轴就会变成 1180~1380 这种不对称区间，0% 也不再居中。 */
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: base - ampPrice, maxValue: base + ampPrice }
          })
        });
        /* v201：零轴只保留一条淡虚线，去掉右侧黑色「昨收 3649.18」价签
         * （用户口径：黑标挡住分时图）。昨收价改到左侧灰色小字角标上。 */
        /* v206：零轴不再单独画虚线 —— 6 等分横格的中线就落在零轴上，
         * 以前那条 createPriceLine 与横格差 1~2px、两条并在一起很难看
         * （用户：直接把背景横线当零轴用，这样就很清爽）。 */

        const avgPts = pts.filter(p => p.avg).map(p => ({ time: p.time, value: p.avg }));
        if (avgPts.length > 5) {
          const avgSeries = chart.addLineSeries({
            /* v288：均价线改橙色实线（目标详情页），与蓝色主线区分 */
            color: isLight() ? '#d97b06' : '#ffa726', lineWidth: 1, lastValueVisible: false,
            priceLineVisible: false, crosshairMarkerVisible: false,
            /* v201：均价线同样不往右轴写刻度文字 */
            priceFormat: { type: 'custom', minMove: Math.pow(10, -dec), formatter: () => '' },
            /* v203【关键修复】：均价线必须锁在与主图同一段价格区间（±振幅）。
             * 它没有 provider 时库走默认 autoscale，会把 right 轴区间撑大 ——
             * 零轴不再落在几何中点（用户：昨收价格浮在零轴上面），上限也贴不到
             * 网格顶。均价本来就生在 ±amp 之内，锁死只会更准不会裁切。 */
            autoscaleInfoProvider: () => ({ priceRange: { minValue: base - ampPrice, maxValue: base + ampPrice } })
          });
          avgSeries.setData(avgPts);
        }

        /* 【v143】左侧百分比轴 —— 用户口径：「要在分时图上能知道涨跌幅，
         * 就像正常盘中行情一样」。
         *
         * 做法：再挂一条**完全透明**的曲线，值是相对昨收的百分比，挂在 left 轴上，
         * 用自定义 formatter 把刻度写成 +1.23% / -0.45%。
         * 为什么不直接改右轴格式：右轴还要给「昨收」价签和最后价用，价格必须留着。
         * 两条曲线是同一份收盘价的线性变换，只要 scaleMargins 和右轴一致，
         * 左轴的 0% 就正好落在昨收那条虚线上，刻度也逐格对齐 —— 这才是
         * 「像正常盘中行情」的样子（同花顺/富途的分时图也是左百分比右价格）。
         * 颜色设成全透明：只要它参与定轴，不需要真的画出一条线。 */
        if (base) {
          /* v204：主面板独占 pane，左右轴统一 5%/95%，零轴必然落在正中 50% */
          const margins = { top: 0.05, bottom: 0.05 };
          const pctSeries = chart.addLineSeries({
            priceScaleId: 'left',
            color: 'rgba(0,0,0,0)',
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            /* v201：左轴密集百分比刻度不再写字，改由四角小字呈现 */
            priceFormat: {
              type: 'custom',
              minMove: 0.01,
              formatter: () => ''
            }
          });
          /* v187：左轴强制 [-amp, +amp]，与右轴 [昨收-amp价, 昨收+amp价]
           * 是同一个线性变换，0% 正好落在昨收虚线上、且处于画面正中。 */
          pctSeries.applyOptions({
            autoscaleInfoProvider: () => ({ priceRange: { minValue: -amp, maxValue: amp } })
          });
          pctSeries.setData(view.map(p => ({ time: p.time, value: (p.close - base) / base * 100 })));
          this._pctSeries = pctSeries;
          /* v205：分时/K线两侧数轴都隐藏（_mk 里已设 visible:false），
           * 只保留 scaleMargins 让左右轴与自画横格对齐。 */
          chart.priceScale('left').applyOptions({ scaleMargins: margins });
        }

        /* 【v201·清爽轴 / v204·真分栏】对齐参考图二 / 三：
         * 只留四角小字，不再有密集刻度、红色最新价线 / 红价签、黑色「昨收」价签。
         *   左侧：上=上限价(红) · 中=昨收价(灰，落在零轴) · 下=下限价(绿)
         *   右侧：上=+amp%(红) · 下=-amp%(绿)
         * 角标挂在主面板（pane-main）上：5% / 50% / 95% —— 上限贴面板顶、
         * 零轴正中、下限贴面板底，与 6 等分网格完全对齐。 */
        const axisTag = document.createElement('div');
        axisTag.className = 'min-axis';
        const fP = (v) => Number(v).toFixed(dec);
        axisTag.style.setProperty('--maTop', '5%');
        axisTag.style.setProperty('--maMid', '50%');
        axisTag.style.setProperty('--maBot', '95%');
        axisTag.innerHTML =
          `<span class="ma-l ma-top up">${fP(base + ampPrice)}</span>`
          + `<span class="ma-l ma-mid">${fP(base)}</span>`
          + `<span class="ma-l ma-bot down">${fP(base - ampPrice)}</span>`
          + `<span class="ma-r ma-top up">+${amp.toFixed(2)}%</span>`
          + `<span class="ma-r ma-bot down">-${amp.toFixed(2)}%</span>`;
        this.paneMain.appendChild(axisTag);
        this._axisTag = axisTag;
      } else {
        mainSeries = chart.addCandlestickSeries({
          upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
          /* v168：关掉「收盘价水平虚线」和右轴上的价格标签（用户：画面上的虚线不要）。
           * priceLine 默认就是虚线样式，会把裸 K 画面切成两半。 */
          priceLineVisible: false,
          lastValueVisible: false,
          /* v205：K 线右轴不再写价格数字（价格信息改到左侧灰色小字，参考图5） */
          priceFormat: { type: 'custom', minMove: Math.pow(10, -dec), formatter: () => '' }
        });
        mainSeries.setData(pts.map(p => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close })));
        /* v172：三五法则把「红棒/黑棒」直接填在 K 线实体上，而我们的 K 线本来就是实心，
         * 实心红 vs 红棒信号根本分不清（用户口径：要像通达信那样用空心阳线）。
         * 这里按主图模式切样式：三五法则 → 阳线空心（透明填充 + 红边框），阴线仍实心绿。 */
        this._mainSeries = mainSeries;
        this._applyCandleStyle();
        /* v164：把价格轴收敛到数据真实区间。
         * 实测（000660 日K，数据 42 万～299 万）轴却从 0 画到 350 万 —— 图的下半被浪费，
         * 画图工具的点击换算也跟着失真。根因没完全查明（数据里没有 0 值柱），
         * 但用 autoscaleInfoProvider 显式给「可见数据的 high/low 区间」就能锁死，
         * 对数坐标也同样生效。 */
        const kview = view;
        this._kview = kview;
        /* 【v166 必须按「可视窗口」算，不能再按全量】放开全历史后 kview 有 9000 根
         * （费半从 1991 年的 250 点一路到 17000 点），按全量取 min/max 会把价格轴
         * 拉成 0～17500，最近一年被压成一条细线、画图完全没法用。
         * 现在只统计**当前可视区间**内的 high/low；可视区间拿不到时退回库自己的
         * original()，两路都失败才交给库默认处理。 */
        const visWindow = () => {
          try {
            const r = chart.timeScale().getVisibleLogicalRange();
            if (!r) return null;
            return [Math.max(0, Math.floor(r.from)), Math.min(kview.length - 1, Math.ceil(r.to))];
          } catch (e) { return null; }
        };
        mainSeries.applyOptions({
          autoscaleInfoProvider: (original) => {
            const win = visWindow();
            let lo = null, hi = null;
            if (win) {
              for (let i = win[0]; i <= win[1]; i++) {
                const p = kview[i];
                if (!p || !isFinite(p.low) || !isFinite(p.high) || p.low <= 0) continue;
                lo = (lo == null) ? p.low : Math.min(lo, p.low);
                hi = (hi == null) ? p.high : Math.max(hi, p.high);
              }
            }
            if (lo != null && hi != null && hi > lo) {
              return { priceRange: { minValue: lo, maxValue: hi } };
            }
            try { return original(); } catch (e) { return null; }
          }
        });
        /* v205：K 线价格区间映射到整个主面板（0%~100%），
         * 左侧灰字价格才能与 6 等分横格精确对应（无数轴，参考图5）。 */
        try { chart.priceScale('right').applyOptions({ scaleMargins: { top: 0, bottom: 0 } }); } catch (e) {}

        /* v168：只画裸 K（用户口径：不要均线）。
         * 原 MA5/10/20 三条线已移除；要指标时走后续「主副图指标」能力，不在这里硬编码。 */
      }

      /* 【v166】全历史都加载进来了（日K 可能 9000 根），但一屏塞 9000 根就是一根根
       * 头发丝、根本没法画图。所以初始视野只铺最近 N 根，往左拖 / 双指缩小
       * 可以一直翻到上市第一根 —— 这才是用户要的「有行情那天到今天都在」。
       * 分时（min）例外：一天 960 根必须整段铺开，否则又变成「只剩最后两小时」。 */
      const showN = mode === 'min' ? 0 : (mode === 'd' ? 260 : mode === 'w' ? 200 : 120);
      chart.timeScale().setVisibleLogicalRange({
        from: showN ? Math.max(-1, view.length - showN) : -1,
        to: view.length + 5
      });

      // ---------- 十字光标图例 ----------
      const regClose = (isMin && data.regClose) || 0;
      const last = view[view.length - 1];
      this._lastPtTime = last ? last.time : null;
      const prev = isMin ? (data.preClose || last.close) : pts[Math.max(0, pts.length - 2)].close;
      const byTime = new Map(pts.map(p => [p.time, p]));

      /* 图上出现盘前/盘后段时，图例先标出这一段属于哪个时段，
       * 再给「相对常规收盘」的盘后涨跌幅 —— 富途那儿的「盘后 +0.69%」就是这个口径，
       * 和「全天 +5.85%（相对昨收）」不是一回事，两个都给才不歧义。 */
      const extTagText = (arr) => {
        const hasPre = arr.some(p => p.seg === 'pre');
        const hasPost = arr.some(p => p.seg === 'post');
        if (hasPre && hasPost) return '含盘前盘后';
        if (hasPre) return '含盘前';
        if (hasPost) return '含盘后';
        return '含延展时段';
      };

      const segChip = (p) => {
        if (!isMin || !p || !p.seg) return '';
        if (p.seg === 'pre') {
          /* v215：盘前涨跌幅的基准是「上一交易日常规收盘」（regClose），
           * 不是 data.preClose（那是常规段的昨收，比常规收盘早一天）。
           * 以前拿 preClose 当分母，盘前 +1.18% 会被算成 +2.x%。 */
          const basePre = regClose || prev;
          const v = basePre ? (p.close - basePre) / basePre * 100 : null;
          return `<span class="lg-item lg-pre">盘前${v != null ? ' ' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : ''}</span>`;
        }
        if (p.seg === 'post') {
          /* v62：韩股（KRX 시간외단일가）/ 台股（盤後定盤）的盘后是**定盘单一价**，
           * 没有连续逐笔。图上那段是阶梯（跳一下再平推），必须在图例里说清，
           * 否则用户会以为「盘后又走了 3.89% 的单边行情」。 */
          const auc = p.auction
            ? '<span class="lg-item lg-ext" title="韩股 15:40–16:00 的收盘定价（장후 종가매매）：整段只有一个成交价，之后 16:00 起才是 Nextrade 连续盘后">收盘定价</span>'
            : '';
          if (!regClose) return '<span class="lg-item lg-post">盘后</span>' + auc;
          const v = (p.close - regClose) / regClose * 100;
          return `<span class="lg-item lg-post">盘后 <b>${priceFmt(p.close)}</b> ${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>` + auc;
        }
        return '';
      };

      /* v205：量/额显示到顶部信息行。十字游标移动时按该时间点取值，
       * 默认（最后一根）显示当根的量/额；副图不再显示数轴数字。 */
      const amtTag = (p) => {
        if (!p) return '';
        const src = byTime.get(p.time) || p;
        const v = hasAmt ? (src.amount || 0) : (src.volume || 0);
        if (!v) {
          /* v215：整条序列都没有量/额时（费半、日经、美债、美元指数、外汇、黄金等
           * 无集中撮合成交量的品种），明确标一个「量 --」，避免用户以为是加载失败。 */
          if (!hasSub) return `<span class="lg-item lg-na" title="该品种的行情源不提供分时成交量/成交额">${hasAmt ? '额' : '量'} --</span>`;
          return '';
        }
        return `<span class="lg-item" title="${hasAmt ? '该时刻成交额' : '该时刻成交量'}">${hasAmt ? '额' : '量'} <b>${fmtAmt(v)}</b></span>`;
      };

      const paint = (p, ref) => {
        if (!this.legendEl) return;
        const base = isMin ? prev : (ref || prev);
        const chg = p.close - base;
        const pct = base ? (chg / base) * 100 : 0;
        const cls = chg >= 0 ? 'up' : 'down';
        if (isMin) {
          const d0 = new Date(p.time * 1000);
          const tm = String(d0.getUTCHours()).padStart(2, '0') + ':' + String(d0.getUTCMinutes()).padStart(2, '0');
          this.legendEl.innerHTML =
            `<span class="lg-item">${tm}</span>` +
            `<span class="lg-item">价 <b class="${cls}">${priceFmt(p.close)}</b></span>` +
            (p.avg ? `<span class="lg-item">均 <b>${priceFmt(p.avg)}</b></span>` : '') +
            segChip(p) +
            /* v236：盘前/盘后点不再显示「全天 x%」。那个数是相对 preClose（上一交易日
             * 涨跌幅的分母，比最近一次常规收盘早一天）算的：英伟达盘前 177.15 实际
             * 只比昨收 178.67 低 0.85%，却被写成「全天 -5.08%」（用户 11-10 截图）。
             * 延展时段的涨跌口径由上面的「盘前 / 盘后 x%」负责，这里不再重复且不冲突。 */
            ((p.seg && p.seg !== 'reg') ? '' :
              `<span class="lg-item ${cls}" title="相对昨收 ${priceFmt(prev)}">全天 ${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`) +
            (useExt ? `<span class="lg-item lg-ext" title="这条曲线把延展时段接进来了（美股：盘前 04:00–09:30 ET / 盘后 16:00–20:00 ET；韩股：收盘定价 15:40–16:00 + Nextrade 애프터마켓 16:00–20:00）">${extTagText(pts)}</span>` : '') +
            amtTag(p) +
            (srcName ? `<span class="lg-item lg-src" title="分时数据源：${srcName}">${srcName}</span>` : '');
        } else {
          this.legendEl.innerHTML =
            `<span class="lg-item">开 <b>${priceFmt(p.open)}</b></span>` +
            `<span class="lg-item">高 <b>${priceFmt(p.high)}</b></span>` +
            `<span class="lg-item">低 <b>${priceFmt(p.low)}</b></span>` +
            `<span class="lg-item">收 <b class="${cls}">${priceFmt(p.close)}</b></span>` +
            `<span class="lg-item ${cls}">${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>` +
            amtTag(p) +
            (srcName ? `<span class="lg-item lg-src" title="K线数据源：${srcName}">${srcName}</span>` : '');
        }
      };
      paint(last);

      /* v231：把分时线尾交给「活线」定时器（见 _liveTick 注释）。
       * 续在「当前正在走的那一段」上：常规时段续主图，盘前/盘后续对应的 ext 线。
       * 续错段会把常规收盘线拉进盘后，所以按最后一点的 seg 选。 */
      if (isMin) {
        const tailSeg = (useExt && liveHasSeg && last && last.seg) ? last.seg : null;
        const extRef = (tailSeg && this._extS) ? this._extS[tailSeg] : null;
        /* v236：盘前 / 盘后段的活线必须换价格来源。
         * 活线原来续的是批量报价的 price，而美股盘前时段那个 price 还是「最近一次
         * 常规收盘」（英伟达盘前 176.74 时报价仍是 178.67），续进 pre 段等于每 8 秒
         * 把线尾拉回昨收：末端竖起假尖峰、图例跳成「盘前 +0.00%」（线上 21:03 实测）。
         * 现在把段标签带进活线，_liveTick 见到 pre/post 就改用 extQuotes 的盘前盘后价。 */
        if (extRef) this._liveSetup(key, { arr: extRef.arr, series: extRef.s, paint: paint, hasPad: false, seg: tailSeg });
        else this._liveSetup(key, { arr: liveArr || view, series: mainSeries, paint: paint, hasPad: true });
      }
      /* 十字游标移开后要回到「最新一点」—— 活线会不断追加，不能回退到打开时那根 */
      const tailNow = () => (this._live && this._live.arr && this._live.arr.length)
        ? this._live.arr[this._live.arr.length - 1] : last;

      chart.subscribeCrosshairMove((param) => {
        if (!param || !param.time || !param.seriesData) { paint(tailNow()); return; }
        if (isMin) {
          const src = byTime.get(param.time);
          if (src) paint(src);
          return;
        }
        const d = param.seriesData.get(mainSeries);
        if (!d) { paint(tailNow()); return; }
        paint(d, d.open);
      });

      this._mainSeries = mainSeries;
      /* v169：主图指标（三五法则）只在日线算；周/月/分时不启用 */
      this._ind = null;
      this._indPts = null;
      if (!isMin && mode === 'd' && w.Indicator) {
        try { this._ind = w.Indicator.s35(pts, this.indParams()); this._indPts = pts; } catch (e) { this._ind = null; }
      }

      /* v164：挂上画图覆盖层（每次 render 重建图表，这里重新 attach） */
      this._mountDraw(mainSeries, isMin);
      /* v205：分时 / K 线统一只有自画的 6 等分淡横格（无竖格、无数轴）；
       * K 线价格信息用左侧灰色小字，缩放时由 _syncTime 回调重算。 */
      this._drawEqualGrid(this.paneMain);
      if (!isMin) this._paintKPrices();
      this._expandPanes();
      /* v205：只有分时做 fitContent —— 一天 240 个分钟点铺满，
       * 从最左开盘到最右收盘，主图与副图都满屏且逐点对齐。
       * 【K 线千万不能 fitContent】K 线是全历史（几千根），全塞进来会让
       * 最近一年被压成一条细线、左侧价格轴也变成全历史高低；保持库默认的
       * 最近可视窗口即可（rightOffset 已设 0，本身也是铺满的）。 */
      /* v236：接了盘前/盘后段时不能按「一个常规时段」的格数钉范围。
       * _minBars 按 fullMinutes（美股 390 格）算 want，而盘前段是**独立 series**，
       * 钉到 0..390 会把 200 多个盘前点整段切到画布外 —— 用户看到的还是「昨天的
       * 常规分时 + 右端一个小蓝尖」，等于盘前分时没生效（11-10 20:15 两张截图）。
       * 这时交给 fitContent 铺满全部点，两段都完整可见。 */
      this._extView = !!(isMin && useExt);
      if (isMin) this._pinMin(this._minPts, this._minKey, false);
      /* v169：主图指标按钮 / 着色 / 卖点图标 */
      this._applyMainInd();
      /* 图表重建后 applyOptions 会回到默认值，这里按当前是否有选中线恢复 */
      this._interOn = null;
      this.syncChartInteraction();
      /* v236：render 结束回告一次 —— app.js 的「盘前分时」开关要按
       * chart.extAvailable（这一场到底有没有接到延展段）决定露不露。
       * 以前 syncMinBar 在 render 之前调用，读到的是上一次渲染留下的 extAvailable，
       * 于是「这次根本没取到盘前数据」的品种照样显示一个点了没反应的按钮。 */
      if (typeof this.onRendered === 'function') { try { this.onRendered(this); } catch (e) {} }
    }

    /* ---- v164：画图工具 / 坐标模式的对外接口（app.js 调这几个） ---- */
    _mountDraw(mainSeries, isMin) {
      if (!w.DrawLayer) return;
      /* destroy() 会把 canvas 一起清掉，这里必须能重建 ——
       * 否则并发 render 时（切周期连点两下）会留下一个 cv=null 的死层。 */
      if (!this.drawLayer || !this.drawLayer.cv) this.drawLayer = new w.DrawLayer(this.paneMain);
      this.drawLayer.attach(this.chart, mainSeries, {
        key: this.key, mode: this.mode, dec: this.dec,
        isMin: !!isMin, lastTime: this._lastPtTime
      });
      w.__activeDraw = this.drawLayer;
      this.drawLayer.setExt200(this.drawLayer.ext200On());
      if (this.onDrawCount) this.drawLayer.onCount = this.onDrawCount;
      if (this.onDrawTool) this.drawLayer.onTool = this.onDrawTool;
      if (this.onColor) this.drawLayer.onColor = this.onColor;
      if (this.onDrawSelect) this.drawLayer.onSelect = this.onDrawSelect;
      if (this.onDrawCount) this.onDrawCount(this.drawLayer.list().length);
      /* v182：跳空缺口 + 当前可视区间最高/最低价。每次 render 都要重挂，
       * 因为 destroy() 会重建 DrawLayer；画的时候读当前可视区间，缩放平移自动跟随。 */
      const self2 = this;
      this.drawLayer.extraPainter = function (ctx, L) { self2._paintExtras(ctx, L); };
    }

    /* v183/v185：跳空缺口（含「部分回补后收缩」）。
     * 用后缀 min(low)/max(high) 做 O(n) 判定，避免 O(n²) 全历史扫描：
     *   向上缺口（K 线在缺口上方）→ 后续最低 low 决定被侵蚀到哪，剩余 [lo, minLow]；
     *   向下缺口（K 线在缺口下方）→ 后续最高 high 决定被侵蚀到哪，剩余 [maxHigh, hi]。
     * v185 用户口径：缺口 100~80，后面 K 线到了 90，就只该显示 100~90 ——
     * 被 K 线侵蚀掉的那一段不能再铺灰色，否则灰带会盖在 K 线上。
     * 侵蚀到 lo（向上）/ hi（向下）时视为完全回补，整条不显示。 */
    _buildGaps(pts) {
      this._gapPts = pts;
      this._gapList = [];
      const n = pts ? pts.length : 0;
      if (n < 2 || pts[0].high == null) return;
      try {
        const minLow = new Float64Array(n), maxHigh = new Float64Array(n);
        minLow[n - 1] = pts[n - 1].low; maxHigh[n - 1] = pts[n - 1].high;
        for (let i = n - 2; i >= 0; i--) {
          minLow[i] = Math.min(pts[i].low, minLow[i + 1]);
          maxHigh[i] = Math.max(pts[i].high, maxHigh[i + 1]);
        }
        for (let i = 1; i < n; i++) {
          const a = pts[i - 1], b = pts[i];
          if (a.high == null || b.low == null || a.low == null || b.high == null) continue;
          let lo, hi, up;
          if (b.low > a.high + 1e-6) { lo = a.high; hi = b.low; up = true; }
          else if (b.high < a.low - 1e-6) { lo = b.high; hi = a.low; up = false; }
          else continue;
          /* v208：恢复 v185 口径（用户明确：「部分回补的只显示剩余片段」）。
           * 按后续 K 线的极值把「被吃掉」的部分裁掉，只留还没被碰过的价格区间；
           * 完全回补（eaten 越过另一侧边界）才整条不画。 */
          if (up) {
            const eaten = Math.min(hi, minLow[i]);
            if (eaten <= lo + 1e-6) continue;
            this._gapList.push({ i: i, lo: lo, hi: eaten, up: true });
          } else {
            const eaten = Math.max(lo, maxHigh[i]);
            if (eaten >= hi - 1e-6) continue;
            this._gapList.push({ i: i, lo: eaten, hi: hi, up: false });
          }
        }
      } catch (e) { this._gapList = []; }
    }

    /* v182/v183：跳空缺口（灰色实体、只显示未回补） + 当前可视区间最高/最低价。
     * 每次重绘现读可视逻辑区间 → 缩放、平移、切周期自动跟随。分时跳过。 */
    _paintExtras(ctx, L) {
      if (!this.chart || !this._mainSeries || !L || this.mode === 'min') return;
      let data;
      try { data = this._mainSeries.data(); } catch (e) { return; }
      if (!data || data.length < 2 || data[0].high == null) return;
      let vr = null;
      try { vr = this.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
      const from = Math.max(1, Math.floor(vr ? vr.from : 0));
      const to = Math.min(data.length - 1, Math.ceil(vr ? vr.to : data.length - 1));
      if (to <= from) return;
      const right = L._plotRight();
      const light = isLight();
      const cfg = gapConf();
      /* v184：颜色就取「最高/最低点原先那条淡灰引导线」的灰，不再用更深的边线；
       * 用户口径：深灰实体太重，那个淡灰刚刚好。 */
      const gapFill = light ? 'rgba(120,130,150,0.45)' : 'rgba(165,175,195,0.45)';

      /* ① 灰色实体缺口：只画可视范围内、未回补、且属于「最近 N 个」的。
       *    v183 用户口径：虚线太乱 → 改成实心灰带；已回补的不显示；数量可设。 */
      if (cfg.on && this._gapList && this._gapList.length) {
        const visible = this._gapList.filter(g => g.i >= from && g.i <= to);
        const picked = visible.slice(-cfg.n);       // 最近的 N 个（列表按 i 升序）
        for (let k = 0; k < picked.length; k++) {
          const g = picked[k], src = this._gapPts && this._gapPts[g.i];
          if (!src) continue;
          /* v209：用户口径「缺口最好像参考图一样，从前一根 K 线延伸出来」。
           * 缺口由 a = pts[i-1] 与 b = pts[i] 之间产生，灰带价格区间正好从
           * a.high（向上缺口）/ a.low（向下缺口）起算，把左端放到 a 那根 K 线
           * 上不会盖住任何实体，视觉上就是从那根 K 水平延伸出来，而不是悬空
           * 在两根 K 之间。只把「起点」往前挪一根，往右延伸与剩余片段口径不变。 */
          const prev = this._gapPts && this._gapPts[g.i - 1];
          const x0 = L._xOf(prev ? prev.time : src.time), yTop = L._yOf(g.hi), yBot = L._yOf(g.lo);
          if (x0 == null || yTop == null || yBot == null) continue;
          /* v208【真正的 bug】：_xOf( = timeToCoordinate ) 返回的是**绘图区坐标**，
           * 但 extraPainter 的 canvas 覆盖整个 pane-main（左右各外扩了一个轴宽）。
           * 以前直接拿 x0 当 canvas 坐标用，灰带整体左移了一个左轴宽 →
           * 看上去就是「从缺口左边延伸过来」。补上左轴宽，灰带才严格贴着
           * 起点那根 K 线往右画、绝不向左越界。这里现读轴宽，不依赖异步字段。 */
          let paneL = 0;
          try { paneL = Math.round(this.chart.priceScale('left').width() || 0); } catch (e) {}
          const px = x0 + paneL;
          if (px > right) continue;
          const y0 = Math.min(yTop, yBot), hgt = Math.max(2, Math.abs(yBot - yTop));
          ctx.save();
          ctx.fillStyle = gapFill;
          ctx.fillRect(px, y0, Math.max(2, right - px), hgt);
          ctx.restore();
        }
      }

      /* v206：最高价 / 最低价标注已移到 _paintKPrices() 的 HTML 小字，
       * 用 chart.timeScale().timeToCoordinate + series.priceToCoordinate
       * 精确定位到实际极值那根 K 线（原来在 canvas 里画，坐标基准会偏）。
       * 这里只保留跳空缺口灰带。 */
    }

    setScaleMode(m) {
      this.scaleMode = (m === 'log') ? 'log' : 'linear';
      if (w.DRAW_SCALE) w.DRAW_SCALE.set(this.key, this.scaleMode);
      try { this.chart.priceScale('right').applyOptions({ mode: this.scaleMode === 'log' ? 1 : 0 }); } catch (e) {}
      if (this.drawLayer) this.drawLayer.redraw();
    }

    /* ---------------- v176：选中画线时锁住图表平移/缩放 ----------------
     * 用户口径：选中线以后拖动应该只动线，不能把整张 K 线图拖着跑；
     * 没有选中线时才允许平移/双指缩放。 */
    syncChartInteraction() {
      /* 画图模式（工具激活）或已选中某条线时，图表平移/缩放一律锁死：
       * 用户口径「没按画那个按钮时，拖动才是拖 K 线图」。 */
      const dl = this.drawLayer;
      const busy = !!(dl && (dl.tool || dl.selectedId));
      this.setChartInteraction(!busy);
    }

    setChartInteraction(on) {
      if (this._interOn === on) return;
      this._interOn = on;
      try {
        this.chart.applyOptions({
          handleScroll: { mouseWheel: on, pressedMouseMove: on, horzTouchDrag: on, vertTouchDrag: on },
          handleScale: { axisPressedMouseMove: on, mouseWheel: on, pinch: on }
        });
      } catch (e) {}
    }

    /* ---------------- v172：指标参数表（红黑棒 / 反向过滤） ---------------- */
    indParams() {
      const D = (w.Indicator && w.Indicator.paramDef) || { REDBLACK: 1, REV_FILTER: 1 };
      let o = {};
      try { o = JSON.parse(localStorage.getItem('mm_ind_params') || '{}') || {}; } catch (e) { o = {}; }
      const pick = (k) => (o[k] == null ? (+D[k] ? 1 : 0) : (o[k] ? 1 : 0));
      return { REDBLACK: pick('REDBLACK'), REV_FILTER: pick('REV_FILTER') };
    }

    setIndParams(patch) {
      const cur = this.indParams();
      const next = Object.assign({}, cur, patch || {});
      try { localStorage.setItem('mm_ind_params', JSON.stringify(next)); } catch (e) {}
      /* 参数变了要重算一遍指标，不然只改了存储、画面不动 */
      if (this._indPts && w.Indicator) {
        try { this._ind = w.Indicator.s35(this._indPts, next); } catch (e) {}
      }
      this._applyMainInd();
      return next;
    }

    /* 蜡烛样式：裸K=实心；三五法则=阳线空心（方便看清红棒/黑棒填充） */
    _applyCandleStyle() {
      const s = this._mainSeries;
      if (!s) return;
      const hollow = (this.mainInd === 's35' && this.mode === 'd');
      try {
        if (hollow) {
          s.applyOptions({
            borderVisible: true,
            upColor: 'rgba(0,0,0,0)',      // 阳线：透明实体 → 空心
            borderUpColor: UP,
            wickUpColor: UP,
            downColor: DOWN,               // 阴线：实心（黑棒覆盖后能区分）
            borderDownColor: DOWN,
            wickDownColor: DOWN
          });
        } else {
          s.applyOptions({
            borderVisible: false,
            upColor: UP, borderUpColor: UP, wickUpColor: UP,
            downColor: DOWN, borderDownColor: DOWN, wickDownColor: DOWN
          });
        }
      } catch (e) {}
    }

    /* ---------------- v169：主图指标（裸K / 三五法则） ---------------- */
    setMainInd(m) {
      this.mainInd = (m === 's35') ? 's35' : 'bare';
      try { localStorage.setItem('mm_main_ind', this.mainInd); } catch (e) {}
      this._applyCandleStyle();
      this._applyMainInd();
    }

    _applyMainInd() {
      const chart = this.chart, d = this.drawLayer;
      if (!chart) return;
      /* v171：切换入口从「图内浮层」挪到**右上角工具条**（用户口径：像图 2 那样
       * 有个明确的地方选裸K / 主图公式）。图内只留左上角的背离提示文字。 */
      if (!this._indTag || this._indTag.parentNode !== this.paneMain) {
        /* v181：面板重建会换一个新的 #chartHost，旧的 _indTag 还挂在旧 host 上
         * （parentNode 非空），原来的 `!parentNode` 判断检测不到 → 标签变成孤儿，
         * 从文档里消失了。这里改成「不在当前 host 下就重建」。 */
        const t = document.createElement('div');
        t.className = 'ind-tag';
        this.paneMain.appendChild(t);
        this._indTag = t;
      }
      const canUse = !!(this._ind && this.mode === 'd');
      /* 把「当前主图 + 能不能用」回传给工具条，让按钮文案跟着变 */
      if (this.onMainInd) { try { this.onMainInd(this.mainInd, canUse); } catch (e) {} }

      const clearAll = () => {
        if (this._indTag) this._indTag.innerHTML = '';
        if (d) { d.painter = null; d.redraw(); }
        try { if (this._mainSeries) this._mainSeries.setMarkers([]); } catch (e) {}
      };
      if (!canUse || this.mainInd !== 's35') { clearAll(); return; }

      const pts = this._indPts, ind = this._ind;
      const sp = () => {
        try { return Math.max(1, Math.min(16, chart.timeScale().options().barSpacing || 6)); } catch (e) { return 6; }
      };
      /* 红棒 / 黑棒：在蜡烛上覆盖同色实体（lightweight-charts 4 不支持单根上色，
       * 于是用画线覆盖层 canvas 盖上去，视觉与图 2 一致） */
      /* v175：红黑棒固定两种画法（不再给选项）——
       * 深色主题：红棒＝高亮高对比纯红（带光晕），黑棒＝实心白；
       * 浅色主题：红棒＝同样的高亮红，黑棒＝墨黑（就是通达信原生的红/黑棒）。
       * 【为什么不用 ctx.shadowBlur】1200+ 根柱子每帧开阴影会明显掉帧，
       * 改成「先铺一层半透明放大底 + 再填实心」，视觉接近光晕但只多一次 fillRect。 */
      d.painter = function (ctx, L) {
        /* 【主题必须每帧现读】原来在闭包里取一次，用户中途切浅色/深色时
         * 画法不会跟着变（白棒在白底上直接消失）。这里每次重绘现算，成本可忽略。 */
        const light = !!(w.document && w.document.body && w.document.body.classList.contains('light'));
        /* 深色：高亮红 + 光晕，黑棒实心白；
         * 浅色：按通达信原色（实测采样 红≈rgb(254,0,2)、黑=rgb(0,0,0)），红块不加光晕/亮边。 */
        /* v218b：颜色保持 v217 原样（#ff0026 高亮纯红 + 同色光晕），
         * 用户明确「不要碰颜色」—— 之前改成 UP(#f6465d) 偏粉，是错的。
         * 只解决「粗 / 侵占邻K / 描边」：
         *   ① 光晕只往垂直方向扩，不再横向扩 2px（横向扩才是盖到隔壁的真凶）；
         *   ② 去掉 RED_EDGE 外描边。 */
        const RED = light ? '#ff0000' : '#ff0026';
        const RED_HALO = 'rgba(255,0,38,.22)';
        const BLK = light ? '#000000' : '#ffffff';
        /* 柱宽跟着蜡烛实体走（0.98 倍，与蜡烛同宽，不越过 barSpacing）。 */
        const bw = Math.max(1, sp() * 0.98);
        /* v210：红黑棒与缺口同理 —— _xOf(=timeToCoordinate) 返回的是**绘图区坐标**，
         * 但这个 canvas 覆盖整个 pane-main（v205 起左右各外扩了一个轴宽）。不补左轴宽，
         * 红黑棒整体左移一个轴宽、直接飘出屏幕（正是用户反馈的「三五法则 K 线全漂移」）。 */
        let paneL = 0;
        try { paneL = Math.round(chart.priceScale('left').width() || 0); } catch (e) {}
        for (let i = 0; i < pts.length; i++) {
          if (!ind.redBar[i] && !ind.blackBar[i]) continue;
          const x0 = L._xOf(pts[i].time);
          if (x0 == null) continue;
          const x = x0 + paneL;
          const yh = L._yOf(pts[i].high), yl = L._yOf(pts[i].low);
          const yc = L._yOf(pts[i].close), yo = L._yOf(pts[i].open);
          if (yh == null || yl == null || yc == null || yo == null) continue;
          const isRed = ind.redBar[i];
          const color = isRed ? RED : BLK;
          const top = Math.min(yc, yo), hgt = Math.max(1, Math.abs(yc - yo));
          ctx.save();
          if (isRed && !light) {
            /* 光晕只在垂直方向扩 1px：横向扩会把红块推到隔壁 K 线上 */
            ctx.fillStyle = RED_HALO;
            ctx.fillRect(x - bw / 2, top - 1, bw, hgt + 2);
          }
          ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x, yl); ctx.stroke();
          ctx.fillRect(x - bw / 2, top, bw, hgt);
          ctx.restore();
        }
      };
      d.redraw();

      /* 卖点图标 */
      const mk = [];
      for (let i = 0; i < pts.length; i++) {
        if (!ind.sell[i]) continue;
        /* v173：卖点＝绿色实心箭头，不再带「卖」字（用户：信号越多越乱） */
        mk.push({ time: pts[i].time, position: 'aboveBar', color: DOWN, shape: 'arrowDown', size: 1 });
      }
      try { this._mainSeries.setMarkers(mk); } catch (e) {}

      /* 左上角：背离提示 + 计数（v181：默认显示最后一根，光标悬停时跟光标走） */
      this._updateIndTag(null);
    }

    /* 十字光标移动 → 找到悬停那根 K 线的下标，刷新左上角指标标签 */
    _onCross(param) {
      if (!this._ind || !this._indPts || this.mainInd !== 's35' || this.mode !== 'd') return;
      if (!param || param.time == null || param.logical == null || !param.point) {
        this._updateIndTag(null); return;
      }
      const pts = this._indPts;
      let i = Math.round(param.logical);
      if (!(i >= 0 && i < pts.length && pts[i].time === param.time)) {
        /* logical 与 time 对不上（数据刚刷新/重排）→ 按 time 从后往前找 */
        i = -1;
        for (let k = pts.length - 1; k >= 0; k--) { if (pts[k].time === param.time) { i = k; break; } }
        if (i < 0) { this._updateIndTag(null); return; }
      }
      this._updateIndTag(i);
    }

    /* 左上角指标标签：i=null 表示「当前」（最后一根），否则显示第 i 根的背离状态 */
    _updateIndTag(i) {
      if (!this._indTag) return;
      const ind = this._ind, pts = this._indPts;
      if (!ind || !pts || !pts.length || this.mainInd !== 's35' || this.mode !== 'd') {
        this._indTag.innerHTML = ''; return;
      }
      const li = (i == null) ? pts.length - 1 : Math.max(0, Math.min(pts.length - 1, i));
      const parts = [];
      if (ind.top[li]) parts.push('<div class="il-warn">【警惕：当前波段RSI顶背离】</div>');
      else if (ind.bot[li]) parts.push('<div class="il-ok">【关注：当前波段RSI底背离】</div>');
      const nums = [];
      /* v182：底背离信号只留「当前波段」这句文字（它随光标出现/消失），
       * 原来重复的「底背离 1.00」数字去掉 —— 用户口径：通达信那句只跟最后一根，
       * 所以当初才另设了 底背离:1；现在文字本身也跟光标了，数字就冗余了。 */
      if (ind.topStep[li] != null) nums.push('<span class="il-r">顶背离 ' + ind.topStep[li] + '</span>');
      if (ind.topStepOrange[li] != null) nums.push('<span class="il-b">顶背离 ' + ind.topStepOrange[li] + '</span>');
      if (ind.distHigh[li] != null) nums.push('<span class="il-d">距离高点 ' + ind.distHigh[li] + '</span>');
      if (nums.length) parts.push('<div class="il-nums">' + nums.join('') + '</div>');
      this._indTag.innerHTML = parts.join('');
    }

    setTool(t) { if (this.drawLayer) this.drawLayer.setTool(t); }
    clearDraw() { if (this.drawLayer) this.drawLayer.clear(); }
    deleteDraw() { return this.drawLayer ? this.drawLayer.deleteSelected() : false; }
    drawSelected() { return this.drawLayer ? this.drawLayer.selected() : null; }
    setExt200(v) { if (this.drawLayer) this.drawLayer.setExt200(v); }
    drawCount() { return this.drawLayer ? this.drawLayer.list().length : 0; }
  }

  w.AssetChart = AssetChart;
})(window);
