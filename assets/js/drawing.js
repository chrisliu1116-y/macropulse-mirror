/* ============================================================================
 * 画图工具覆盖层 v166
 *
 * 用户口径（逐条对应）：
 *   ① 线段 / 射线 / 波段延伸（Fib Extension）：A、B 定基准波段，C 回调锚点，
 *      自动投射 100%（等长浪）与 200%（加速目标），200% 可单独关。
 *   ② 点第一个点就要**立刻看得见**（落点 + 跟手橡皮筋），不能等第二个点才出现。
 *   ③ 画完能**按住端点拖动**调整。
 *   ④ 线的**颜色可选**（六色板）；点一下线可以选中它，再点色板直接换色。
 *
 * 实现：lightweight-charts 4.1.3 没有画图 API（primitives 是 v5），
 * 用透明 canvas 覆盖层；锚点只存「时间 + 价格」，重绘时用
 * timeScale().timeToCoordinate() / series.priceToCoordinate() 换算像素，
 * 缩放、平移、切周期自动贴合。
 *
 * 存储：localStorage['mm_draw_v1'] = { '代码:周期': [ {id, tool, color, pts:[{t,p}]} ] }
 * ========================================================================== */
(function (w) {
  'use strict';

  var LS_DRAW = 'mm_draw_v1';
  var LS_EXT200 = 'mm_draw_ext200';
  var LS_COLOR = 'mm_draw_color';

  /* 画线调色板：深浅主题下都够醒目的六个色 */
  var PALETTE = ['#3d8bfd', '#ff9f43', '#2ecc71', '#ff5c7a', '#b085ff', '#e8edf5'];

  var HIT_END = 16;    // 端点命中半径（手指按不准，比鼠标要宽）
  var HIT_LINE = 9;    // 线身命中距离

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(LS_DRAW) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveAll(o) {
    try { localStorage.setItem(LS_DRAW, JSON.stringify(o)); } catch (e) {}
  }
  /* v167：画线改为**按个股**保存（原来按「个股+周期」，切到周K就看不见日K画的线）。
   * 老库里的 '2330:d' / '2330:w' 这类键一次性合并到 '2330'，按 id 去重。 */
  function migrateKeys() {
    var all = loadAll(), changed = false;
    Object.keys(all).forEach(function (k) {
      var m = /^(.+):(d|w|m)$/.exec(k);
      if (!m) return;
      var base = m[1], arr = all[base] || [], ids = {};
      for (var i = 0; i < arr.length; i++) ids[arr[i].id] = 1;
      var old = all[k] || [];
      for (var j = 0; j < old.length; j++) {
        if (!ids[old[j].id]) { arr.push(old[j]); ids[old[j].id] = 1; }
      }
      all[base] = arr;
      delete all[k];
      changed = true;
    });
    if (changed) saveAll(all);
  }
  try { migrateKeys(); } catch (e) {}

  function loadColor() {
    try {
      var c = localStorage.getItem(LS_COLOR);
      return (c && PALETTE.indexOf(c) >= 0) ? c : PALETTE[0];
    } catch (e) { return PALETTE[0]; }
  }

  function DrawLayer(host) {
    this.host = host;
    this.chart = null;
    this.series = null;
    this.key = '';
    this.mode = 'd';
    this.dec = 2;
    this.lastTime = null;
    this.tool = null;
    /* v182：面板开着但**没选工具**时仍能选中/拖动/删除已有线（用户口径：
     * 「不点工具是为了避免误触画出线」）。tool 只控制「画新线」，editOnly 只控制「改旧线」。 */
    this.editOnly = false;
    this.pending = [];
    /* v190：取点放大镜状态（_press=手指/鼠标按住中，_hoverXY=当前触点画布坐标） */
    this._press = false;
    this._hoverXY = null;
    this._loupeRect = null;
    this._loupeLayers = null;  /* v400：放大镜图层几何快照（按下冻结、松手清空） */
    this._loupeBg = null;      /* v401：按下时预合成的背景离屏 canvas（避免每帧 GPU 回读） */
    this._loupeBgAt = 0;       /* v402：快照生成时刻（3 秒内复用，避免每次按下重做回读） */
    this._loupeKRange = null;  /* v402：可视 K 线的价格区间(映射成 y)，用于夹住放大镜源区域 */
    this._loupeData = null;    /* v402b：按下时缓存的 K 线数据（供按触点x取局部价格区间） */
    /* v192：正在拖动的锚点（端点），供放大镜取价格；整条平移时为 null */
    this._dragPt = null;
    this.hover = null;
    this.hoverId = null;
    this.drag = null;          // {id, i}：正在拖动的端点
    this.selectedId = null;    // 选中的线（色板换色作用在它身上）
    this.visible = true;
    this.color = loadColor();
    this._w = 0; this._h = 0; this._dpr = 1;
    this._subscribed = null;
    this.onCount = null;
    this.onTool = null;
    this.onColor = null;
    this.onSelect = null;

    var cv = document.createElement('canvas');
    cv.className = 'draw-layer';
    this.cv = cv;
    /* v401【拖动卡顿第二根因】放大镜每帧要 drawImage 读取本层像素。若 canvas 由
     * GPU 合成，每次读取都会触发 GPU→CPU 回读（真机几十毫秒/次），拖动就一卡一卡。
     * willReadFrequently 让浏览器把本层放在 CPU 内存（软件渲染）：本层只画几条线，
     * 绘制开销可忽略，但读取变成内存拷贝 —— 配合背景预合成，放大镜全程零 GPU 回读。
     * 【必须在第一次 getContext 时声明】之后再传参无效，所以这里预取 context。 */
    try { this._ctx = cv.getContext('2d', { willReadFrequently: true }); } catch (e) { this._ctx = null; }
    host.appendChild(cv);

    /* 【为什么挂在 host 的捕获阶段，而不是 canvas 自己】
     * canvas 只要 pointer-events:auto 就会把图表的拖动/缩放一起吃掉（用户点了线才有反应，
     * 没点线连图都拖不动）；pointer-events:none 又收不到「选中已有线」的点击。
     * 挂在 host 捕获阶段：先自己判定，命中线才 preventDefault 吞掉事件，
     * 没命中就什么都不做、事件继续冒泡给 lightweight-charts —— 两边都不误伤。 */
    var self = this;
    this._h = {
      down: function (e) { self._down(e); },
      move: function (e) { self._move(e); },
      up: function (e) { self._up(e); },
      cancel: function () { self._cancel(); },
      leave: function () { self.hover = null; self.hoverId = null; self.redraw(); },
      menu: function (e) {
        if (!self.tool) return;
        e.preventDefault();
        /* v189：触屏长按也会触发 contextmenu（button=0），不能当成「右键撤点」——
         * 否则真机上按得稍久再拖，刚落下的 A 点会被 pop 掉，线就画不出来。
         * 只有鼠标右键（button=2）才撤一个点。 */
        if (e.button !== 2) return;
        if (self.pending.length) { self.pending.pop(); self.redraw(); }
      }
    };
    this._host = host;
    /* 【必须拦 click】行情面板挂了「点空白关闭」(bindTapClose)，画图这一下点击如果
     * 继续冒泡，会被它当成"点了空白"→ 直接把面板关掉，顺带 setTool(null) 清掉刚落的点
     * （现场：点第一个点，面板自己关了）。所以吃掉 pointerdown 的同一轮，也把 click 吃掉。 */
    this._h.click = function (e) {
      if (!self._swallow) return;
      self._swallow = false;
      e.stopPropagation();
      e.preventDefault();
    };
    host.addEventListener('click', this._h.click, true);
    host.addEventListener('pointerdown', this._h.down, true);
    host.addEventListener('pointermove', this._h.move, true);
    host.addEventListener('pointerup', this._h.up, true);
    host.addEventListener('pointercancel', this._h.cancel, true);
    host.addEventListener('pointerleave', this._h.leave, true);
    host.addEventListener('contextmenu', this._h.menu, true);
    if (w.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(host);
    } else {
      w.addEventListener('resize', function () { self.resize(); });
    }
    this.resize();
  }

  DrawLayer.prototype = {
    attach: function (chart, series, meta) {
      meta = meta || {};
      /* 【为什么要判 sameCtx】图表重新 render（报价刷新 / 数据到位 / 切周期）会再 attach 一次，
       * 原来这里无条件把 pending 清空 —— 用户点下第一个点时刚好赶上一次刷新，点就"消失"了，
       * 表现就是「第一点不出来、第二点才连线」。同一个品种+周期下必须保住正在画的点。 */
      var sameCtx = (this.key === (meta.key || '') && this.mode === (meta.mode || 'd'));
      this.chart = chart || null;
      this.series = series || null;
      this.key = meta.key || '';
      this.mode = meta.mode || 'd';
      this.dec = (meta.dec == null ? 2 : meta.dec);
      this.lastTime = meta.lastTime || null;
      this.visible = !meta.isMin;
      this.drag = null;
      this._press = false;
      this._hoverXY = null;
      this._dragPt = null;
      this._loupeLayers = null;
      this._loupeBg = null;
      this._loupeBgAt = 0;      /* v402：换品种/周期 → 快照必然过期，强制重建 */
      this._loupeData = null;
      if (this._hold) { clearTimeout(this._hold.timer); this._hold = null; }
      if (!sameCtx) {
        this.pending = [];
        this.selectedId = null;
        this.hover = null;
        this.hoverId = null;
      }
      this._times = null;      // 数据的时间序列（整线拖动按索引平移用）
      this._timesSeries = null;

      var self = this;
      /* 【为什么要看门狗】图表的价格轴会在我们画完之后自己再 autoScale 一次
       * （切区间 / 切品种 / 指标开关都会），这时逻辑区间没变、只有 y 坐标变了，
       * 覆盖层不会重绘 → 红黑棒/画线整体偏移。这里每 300ms 探一次最后一根收盘价的
       * y 坐标，变了就重画。只比一个数，开销可以忽略。 */
      if (chart) this._startScaleWatch(chart);
      if (chart && this._subscribed !== chart) {
        this._subscribed = chart;
        try {
          chart.timeScale().subscribeVisibleLogicalRangeChange(function () {
            self.redraw();   /* 立即画一次（跟手） */
            /* v420【缩放漂移根治】LWC 可见范围/timeScale 是异步生效的：回调触发这一刻，
             * timeToCoordinate/priceToCoordinate 往往还是旧坐标系，这一笔画下去线就停在旧位置；
             * 等坐标系真正更新后没有第二笔，线就相对 K 线错位（用户缩放后线漂移）。
             * 用两级 rAF + 一次短延迟补画，覆盖坐标系稳定后的重绘，确保端点重新贴回 K 线。 */
            var kick = function () { try { self.redraw(); } catch (e) {} };
            var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
            try { raf(function () { raf(kick); }); } catch (e) {}
            if (self._rangeKick) clearTimeout(self._rangeKick);
            self._rangeKick = setTimeout(kick, 120);
          });
        } catch (e) {}
      }
      if (!this.visible) {
        this.tool = null; this.pending = []; this.drag = null;
        this.cv.classList.remove('drawing');
        if (this._host) { this._host.classList.remove('draw-mode'); this._host.style.cursor = ''; }
      }
      this.resize();
    },

    _startScaleWatch: function (chart) {
      var self = this;
      if (this._sw) { clearInterval(this._sw); this._sw = null; }
      this._sw = setInterval(function () {
        if (!self.cv || !self.series || self.chart !== chart) return;
        try {
          var d = self.series.data();
          if (!d || !d.length) return;
          var y = self._yOf(d[d.length - 1].close);
          /* v420：X 漂移用「可视逻辑范围」探测，而不是最后一根的 x ——
           * 最后一根在缩放看更多历史时会被挤出可视区（x 变 null/极右），
           * 平移时它又一直变，都会误触发。range 变才是缩放/平移的真正信号。 */
          var r = null;
          try { r = chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
          var rx = r ? r.from : null, ry = r ? r.to : null;
          if (y == null) return;
          if (self._probeY == null) { self._probeY = y; self._probeFrom = rx; self._probeTo = ry; return; }
          /* Y 变(autoscale) 或 可视范围变(缩放/平移) → 重绘。
           * Y 阈值 0.6px 忽略亚像素抖动；range 用 0.05 根容差。 */
          if (Math.abs(y - self._probeY) > 0.6 ||
              (rx != null && self._probeFrom != null && Math.abs(rx - self._probeFrom) > 0.05) ||
              (ry != null && self._probeTo != null && Math.abs(ry - self._probeTo) > 0.05)) {
            self._probeY = y; self._probeFrom = rx; self._probeTo = ry; self.redraw();
          }
        } catch (e) {}
      }, 300);
    },

    destroy: function () {
      if (this._sw) { clearInterval(this._sw); this._sw = null; }
      if (this._h && this._host) {
        var H = this._host;
        H.removeEventListener('click', this._h.click, true);
        H.removeEventListener('pointerdown', this._h.down, true);
        H.removeEventListener('pointermove', this._h.move, true);
        H.removeEventListener('pointerup', this._h.up, true);
        H.removeEventListener('pointercancel', this._h.cancel, true);
        H.removeEventListener('pointerleave', this._h.leave, true);
        H.removeEventListener('contextmenu', this._h.menu, true);
        H.style.cursor = '';
        H.classList.remove('draw-mode');
        this._h = null;
      }
      if (this._ro) { try { this._ro.disconnect(); } catch (e) {} this._ro = null; }
      if (this.cv && this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
      this.cv = null; this.chart = null; this.series = null;
    },

    /* ---------------- 状态 ---------------- */
    setTool: function (t) {
      this.tool = t || null;
      this.pending = [];
      this._press = false;
      this._hoverXY = null;
      this._dragPt = null;
      this._loupeLayers = null;
      this._loupeBg = null;
      this._loupeBgAt = 0;
      this._loupeData = null;
      this.drag = null;
      if (this._hold) { clearTimeout(this._hold.timer); this._hold = null; }
      if (this._lp) { clearTimeout(this._lp.timer); this._lp = null; }
      /* v186：切换工具时清掉选中态，避免「选中射线却切到线段工具」这种错配；
       * 同时刷新面板里的锚点输入区 / 删除按钮。 */
      this.selectedId = null;
      if (this.onSelect) this.onSelect(null);
      if (this.cv) this.cv.classList.toggle('drawing', !!this.tool);
      if (this._host) {
        this._host.classList.toggle('draw-mode', !!this.tool);
        this._host.style.cursor = this.tool ? 'crosshair' : '';
      }
      if (this.onTool) this.onTool(this.tool);
      this.redraw();
      /* v402【刚进工具画第一根线特别卡】首次执行 _freezeLoupe（querySelectorAll +
       * 多次 getBoundingClientRect + 两次 GPU 回读预合成）是冷路径：V8 解释执行、
       * GPU canvas 首次回读，用户体感就是"一卡一卡，过一会儿才好"。
       * 进入画图工具时先异步预热一次，把冷路径提前跑掉；按下时直接命中 3 秒缓存。 */
      if (this.tool) {
        var selfWarm = this;
        setTimeout(function () {
          try { if (!selfWarm._press) selfWarm._freezeLoupe(true); } catch (e) {}
        }, 80);
      }
    },
    setVisible: function (v) { this.visible = !!v; this.redraw(); },
    setEditOnly: function (v) { this.editOnly = !!v; this.redraw(); },
    /* v182：选中线后，面板里可以逐个锚点输入精确价格（波段延伸 3 个点都要能改） */
    setPointPrice: function (id, i, p) {
      if (!isFinite(p)) return false;
      var arr = this.list(), hit = false;
      for (var k = 0; k < arr.length; k++) {
        if (arr[k].id !== id || !arr[k].pts || !arr[k].pts[i]) continue;
        arr[k].pts[i] = { t: arr[k].pts[i].t, p: Number(p),
          dx: (arr[k].pts[i].dx != null ? arr[k].pts[i].dx : undefined) };  /* v423：保留留白像素偏移 */
        hit = true; break;
      }
      if (!hit) return false;
      this.save(arr);
      this.redraw();
      return true;
    },
    selectedItem: function () {
      if (!this.selectedId) return null;
      var arr = this.list();
      for (var k = 0; k < arr.length; k++) if (arr[k].id === this.selectedId) return arr[k];
      return null;
    },
    setExt200: function (v) {
      this.ext200 = !!v;
      try { localStorage.setItem(LS_EXT200, this.ext200 ? '1' : '0'); } catch (e) {}
      this.redraw();
    },
    ext200On: function () {
      if (this.ext200 == null) {
        var v = null;
        try { v = localStorage.getItem(LS_EXT200); } catch (e) {}
        this.ext200 = (v === null) ? true : v === '1';
      }
      return this.ext200;
    },
    /* 色板：既作为「下一条线的颜色」，也直接作用在已选中的那条线上 */
    setColor: function (c) {
      if (PALETTE.indexOf(c) < 0) return;
      this.color = c;
      try { localStorage.setItem(LS_COLOR, c); } catch (e) {}
      if (this.selectedId) {
        var arr = this.list(), hit = false;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].id === this.selectedId) { arr[i].color = c; hit = true; break; }
        }
        if (hit) this.save(arr);
      }
      if (this.onColor) this.onColor(c);
      this.redraw();
    },
    currentColor: function () { return this.color; },
    selected: function () { return this.selectedId; },
    list: function () {
      var all = loadAll();
      return (all[this._dk()] || []).slice();
    },
    save: function (arr) {
      var all = loadAll();
      all[this._dk()] = arr;
      saveAll(all);
      if (this.onCount) this.onCount(arr.length);
    },
    clear: function () {
      this.pending = []; this.selectedId = null;
      this.save([]); this.redraw();
      if (this.onSelect) this.onSelect(null);
    },
    /* 存储维度＝个股（不再拼周期）：日K 画的线在周K/月K 也看得到，符合「跟着个股走」 */
    _dk: function () { return String(this.key); },

    /* 数据的时间序列（升序）。整线拖动必须按**索引**平移：
     * 交易日之间夹着周末/停牌，直接给 time 加 86400 会落到不存在的日子。 */
    _dataTimes: function () {
      if (this._times && this._timesSeries === this.series) return this._times;
      var arr = [];
      try {
        var data = this.series && this.series.data ? this.series.data() : [];
        for (var i = 0; i < data.length; i++) arr.push(data[i].time);
      } catch (e) { arr = []; }
      this._times = arr; this._timesSeries = this.series;
      return arr;
    },
    _idxOfTime: function (t, times) {
      if (!times || !times.length || t == null) return null;
      var lo = 0, hi = times.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (times[mid] === t) return mid;
        if (times[mid] < t) lo = mid + 1; else hi = mid - 1;
      }
      return Math.max(0, Math.min(times.length - 1, lo));
    },
    /* 删除选中的那一条（用户口径：要能「单根删除」，不能只能清空） */
    deleteSelected: function () {
      if (!this.selectedId) return false;
      var arr = this.list(), out = [];
      for (var i = 0; i < arr.length; i++) if (arr[i].id !== this.selectedId) out.push(arr[i]);
      this.selectedId = null;
      this.save(out);
      if (this.onSelect) this.onSelect(null);
      this.redraw();
      return true;
    },

    /* ---------------- 尺寸 / 坐标 ---------------- */
    resize: function () {
      var cv = this.cv;
      if (!cv || !this.host) return;
      var wpx = Math.max(1, this.host.clientWidth);
      var hpx = Math.max(1, this.host.clientHeight);
      var dpr = Math.min(2, w.devicePixelRatio || 1);
      if (cv.width !== Math.round(wpx * dpr) || cv.height !== Math.round(hpx * dpr)) {
        cv.width = Math.round(wpx * dpr);
        cv.height = Math.round(hpx * dpr);
      }
      cv.style.width = wpx + 'px';
      cv.style.height = hpx + 'px';
      this._w = wpx; this._h = hpx; this._dpr = dpr;
      /* v402：尺寸变了，快照与图层几何全部失效（漏清 _loupeLayers 会引用旧尺寸 canvas） */
      this._loupeBg = null; this._loupeBgAt = 0; this._loupeKRange = null; this._loupeLayers = null;
      this._loupeData = null;
      this.redraw();
    },
    /* 绘图区右边界（不含右侧价格轴）。
     * 用户口径：线画到坐标轴就该停，坐标轴是一列覆盖在上面的东西，
     * 不该出现 K 线/画线穿透过去。lightweight-charts 4 的价格轴宽度可以直接问，
     * 问不到就退化成「画布宽 - 60」。 */
    _plotRight: function () {
      var axisW = 0;
      try {
        var ps = this.chart.priceScale('right');
        if (ps && typeof ps.width === 'function') axisW = ps.width();
      } catch (e) { axisW = 0; }
      if (!axisW || !isFinite(axisW)) axisW = 56;
      return Math.max(20, this._w - axisW - 2);
    },
    _xOf: function (t) {
      try { var x = this.chart.timeScale().timeToCoordinate(t); return (x == null) ? null : x; } catch (e) { return null; }
    },
    _yOf: function (p) {
      try { var y = this.series.priceToCoordinate(p); return (y == null || !isFinite(y)) ? null : y; } catch (e) { return null; }
    },
    _priceOf: function (y) {
      try {
        var v = this.series.coordinateToPrice(y);
        return (v == null || !isFinite(v)) ? null : v;
      } catch (e) { return null; }
    },
    _timeOf: function (x) {
      try { return this.chart.timeScale().coordinateToTime(x); } catch (e) { return null; }
    },
    _ptOf: function (ev) {
      if (!this.cv || !this.chart || !this.series) return null;
      var r = this._rectOf();
      var x = ev.clientX - r.left, y = ev.clientY - r.top;
      /* 【为什么要有 lastTime 兜底】手指点在最后一根右边的留白区（rightOffset=8）时
       * coordinateToTime 返回 null，原来的实现直接 return null → 第一个点放不下去。
       * v423【恢复拖到最右 + 不漂】留白区端点存 t=最后一根的绝对时间 + dx=固定像素偏移。
       * dx 是画点那一刻的像素差（绝对值），不随数据重载/缩放变化；绘制 x=_xOf(t)+dx，
       * 既能拖到最右留白，又因 t、dx 都是绝对量而永不横漂。不用任何相对逻辑索引。 */
      var t = this._timeOf(x);
      var dx = null;
      if (t == null) {
        t = this.lastTime;
        if (t != null) {
          try { var lx = this._xOf(t); if (lx != null && isFinite(lx)) dx = x - lx; } catch (e) {}
        }
      }
      var p = this._priceOf(y);
      if (t == null || p == null) return null;
      var out = { t: t, p: p };
      if (dx != null && Math.abs(dx) > 0.5) out.dx = dx;
      return out;
    },
    /* v225：getBoundingClientRect 会强制同步布局，pointermove 每帧调一次
     * 就是典型的「拖起来一卡一卡」。按下时取一次、松手/离开时失效；
     * 待机 hover 走 120ms 的短缓存，滚动页面也能跟上。 */
    _rectOf: function () {
      if (this._rc) return this._rc;
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      if (this._rcVal && this._rcAt && now - this._rcAt < 120) return this._rcVal;
      this._rcVal = this.cv.getBoundingClientRect();
      this._rcAt = now;
      return this._rcVal;
    },
    _xy: function (ev) {
      if (!this.cv) return { x: 0, y: 0 };
      var r = this._rectOf();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    },

    /* v423：端点 X = timeToCoordinate(绝对t) + 固定像素dx（留白区能拖最右且不漂） */
    _xOfPt: function (pt) {
      var x = this._xOf(pt.t);
      if (x != null && isFinite(x) && pt.dx != null && isFinite(pt.dx)) x += pt.dx;
      return x;
    },
    /* 一条线的像素点（不含射线远方端点） */
    _px: function (d) {
      var self = this, out = [];
      for (var i = 0; i < d.pts.length; i++) {
        out.push({ x: self._xOfPt(d.pts[i]), y: self._yOf(d.pts[i].p), p: d.pts[i].p });
      }
      return out;
    },

    /* 端点命中：返回 {d, i}（线对象 + 点下标），没命中 null。
     * v186：选了具体工具时只命中同类型的线 —— 这样「在线段上取 A 点画波段线」
     * 不会被旧线段抢走长按手势；没选工具（只打开面板）时所有线都能命中。 */
    _hitEnd: function (xy) {
      var arr = this._arr(), best = null, bestD = HIT_END * HIT_END;
      var only = this.tool;
      for (var i = arr.length - 1; i >= 0; i--) {
        if (only && arr[i].tool !== only) continue;
        var q = this._px(arr[i]);
        for (var j = 0; j < q.length; j++) {
          if (q[j].x == null || q[j].y == null) continue;
          var dx = xy.x - q[j].x, dy = xy.y - q[j].y, dd = dx * dx + dy * dy;
          if (dd <= bestD) { bestD = dd; best = { d: arr[i], i: j }; }
        }
      }
      return best;
    },

    /* 点到线段的距离 */
    _segDist: function (xy, a, b) {
      var vx = b.x - a.x, vy = b.y - a.y;
      var wx = xy.x - a.x, wy = xy.y - a.y;
      var len = vx * vx + vy * vy;
      var t = len ? (wx * vx + wy * vy) / len : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var px = a.x + vx * t, py = a.y + vy * t;
      var dx = xy.x - px, dy = xy.y - py;
      return Math.sqrt(dx * dx + dy * dy);
    },

    /* 线身命中（选中用）。射线按「到远端」算，波段延伸只算 A-B、B-C 两段 */
    _hitLine: function (xy) {
      var arr = this._arr();
      var only = this.tool;
      for (var i = arr.length - 1; i >= 0; i--) {
        var d = arr[i];
        if (only && d.tool !== only) continue;   // v186：只跟当前工具同类型的线交互
        var q = this._px(d);
        var segs = [];
        if (d.tool === 'seg' && q.length >= 2) segs.push([q[0], q[1]]);
        else if (d.tool === 'ray' && q.length >= 2) {
          var dx = q[1].x - q[0].x, dy = q[1].y - q[0].y;
          var tx = (dx >= 0) ? this._plotRight() : 2;
          var k = Math.abs(dx) < 0.001 ? 1 : (tx - q[0].x) / dx;
          if (k < 1) k = 1;
          segs.push([q[0], { x: q[0].x + dx * k, y: q[0].y + dy * k }]);
        } else if (d.tool === 'ext' && q.length >= 3) {
          segs.push([q[0], q[1]]); segs.push([q[1], q[2]]);
          /* 目标位横线也能点中（否则只能在 A→B 那一段上点，很难选） */
          var lvs = this._extLevels(d);
          for (var t2 = 0; t2 < lvs.length; t2++) {
            if (lvs[t2].y == null || lvs[t2].y < 1 || lvs[t2].y > this._h - 1) continue;
            segs.push([{ x: q[2].x, y: lvs[t2].y }, { x: this._plotRight(), y: lvs[t2].y }]);
          }
        }
        for (var s = 0; s < segs.length; s++) {
          var a = segs[s][0], b = segs[s][1];
          if (a.x == null || a.y == null || b.x == null || b.y == null) continue;
          if (this._segDist(xy, a, b) <= HIT_LINE) return d;
        }
      }
      return null;
    },

    /* 开始拖动一条已有线（端点或整线），由「未选工具」路径和延迟判定共用 */
    _beginDrag: function (hit, ln, ev, startPt) {
      var arr = this.list(), orig = [], id, idx = null, color;
      if (hit) {
        id = hit.d.id; idx = hit.i; color = hit.d.color;
      } else {
        id = ln.id; color = ln.color;
        for (var q = 0; q < arr.length; q++) {
          if (arr[q].id !== id) continue;
          for (var r = 0; r < arr[q].pts.length; r++) orig.push({ t: arr[q].pts[r].t, p: arr[q].pts[r].p });
          break;
        }
      }
      this.drag = { id: id, i: idx, arr: arr, start: startPt || (ev ? this._ptOf(ev) : null), orig: orig };
      if (idx == null) this.drag.moved = false;
      /* v192：按住端点那一刻放大镜就该出现（手指正好挡住它）；整条平移不需要 */
      this._dragPt = (idx != null) ? (startPt || this.drag.start) : null;
      this.selectedId = id;
      if (color) this.color = color;
      try { this._host.setPointerCapture && this._host.setPointerCapture(ev && ev.pointerId); } catch (e) {}
      if (this.onSelect) this.onSelect(hit ? hit.d : ln);
      if (hit && this.onTool) this.onTool(this.tool || 'drag');
      if (ln && this.onColor) this.onColor(this.color);
      this._swallow = true;
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      this.redraw();
    },

    /* 长按成立：忽略这次命中，按「在空白处起笔」落第一个点 */
    _holdFire: function () {
      var h = this._hold;
      if (!h || h.fired) return;
      h.fired = true;
      this._hold = null;
      this.selectedId = null;
      if (this.onSelect) this.onSelect(null);
      this._lp = { x: h.x, y: h.y, pt: h.pt, fired: false, moved: false, timer: null };
      this._lpFire();
    },

    /* 长按期间手指滑开：改判成「拖动命中的那条线」 */
    _holdToDrag: function () {
      var h = this._hold;
      if (!h) return;
      clearTimeout(h.timer);
      this._hold = null;
      this._beginDrag(h.hit, h.line, null, h.pt);
    },

    /* 落一个点：点数够了就收尾（v180 抽出，给「点击落点」用） */
    _addPoint: function (pt) {
      if (!pt) return;
      var need = this.tool === 'ext' ? 3 : 2;
      this.pending.push(pt);
      this.hover = null;
      if (this.pending.length >= need) this._commit();
      else this.redraw();
    },

    /* ---------------- 交互 ---------------- */
    _down: function (ev) {
      /* 按下即冻结画布矩形：整个拖动过程不再触发 getBoundingClientRect（回流） */
      try { this._rc = this.cv ? this.cv.getBoundingClientRect() : null; } catch (e) { this._rc = null; }
      if (!this.visible || !this.cv || !this.chart || !this.series) return;
      var xy = this._xy(ev);

      /* v177 + v182：画图面板没打开时，点击/拖动一律交给图表（平移、缩放），
       * 既不落点也不选中；面板开着时，无论有没有选工具，已有线都能命中编辑。 */
      if (!this.tool && !this.editOnly) return;
      /* v190：按住期间显示取点放大镜 */
      this._press = true;
      this._hoverXY = xy;
      /* v400/v401：按下这一刻冻结图层几何 + 预合成背景（一次性开销放在按下时，
       * 拖动过程中不再有任何布局读取和 GPU 回读）。
       * v408：复用由「图表状态签名」决定（见 _freezeLoupe）——图表没动就复用
       * （按下零开销），平移/缩放/新数据后自动重建（保准确）。 */
      try { this._freezeLoupe(); } catch (e) {}

      /* ① 已经在画（落了点、还没收尾）：这一下**永远是下一个点**。
       * 【v180 关键修复】原来这一支排在命中检测后面：用户点 C 时手指只要压到
       * 任何一条已有线（哪怕只是挨着），就会被判成「拖那条线」——波段延伸没落成，
       * 旧线反被拖成一条水平线，表现就是「画出来的线完全错了」。 */
      if (this.pending.length) {
        var pnx = this._ptOf(ev);
        if (!pnx) return;
        this._swallow = true;
        ev.preventDefault();
        ev.stopPropagation();
        this._addPoint(pnx);
        return;
      }

      /* ② / ③ 命中已有线（端点优先）。
       * v187：选了具体工具（要画新线）时改成「延迟判定」：
       *   · 长按 220ms 不动 → 起笔画新线（起点即使压在旧线上也能落 A）；
       *   · 期间移动超过 10px → 转为拖动这条线；
       *   · 短按抬起 → 只选中。
       * 没选工具（只打开画图面板）时保持「一压上就拖」。
       * 【修的 bug】原来命中检测排在起笔前面：画完第一条线后，想在已有线上
       * 或它附近取点画第二条，长按会被判成「拖第一条线」，于是只能画一条。 */
      var hit = this._hitEnd(xy);
      var ln = hit ? null : this._hitLine(xy);
      if (hit || ln) {
        var p0h = this._ptOf(ev);
        /* v418【端点吸附】按在端点上 = 一定拖端点，不走延迟判定。
         * v187 当初引入延迟判定，是为了「在一条线段的中间起笔画新线」不被误判成拖线；
         * 但用户实际从不「从端点起新线」，只要一碰端点就是想调端点。
         * 所以：命中端点(hit) → 直接 _beginDrag 拖端点；
         *      只有命中线身(ln) → 才保留「长按起笔 / 短按选中」的延迟判定。 */
        if (hit) {
          this._beginDrag(hit, null, ev, p0h);
          return;
        }
        if (this.tool && p0h) {
          var self = this;
          this.selectedId = hit ? hit.d.id : ln.id;
          var hc = hit ? hit.d.color : ln.color;
          if (hc) this.color = hc;
          if (this.onSelect) this.onSelect(hit ? hit.d : ln);
          this._hold = {
            x: xy.x, y: xy.y, pt: p0h, hit: hit, line: ln, fired: false,
            timer: setTimeout(function () { self._holdFire(); }, 220)
          };
          this._swallow = true;
          ev.preventDefault();
          ev.stopPropagation();
          try { this._host.setPointerCapture && this._host.setPointerCapture(ev.pointerId); } catch (e) {}
          this.redraw();
          return;
        }
        this._beginDrag(hit, ln, ev, this._ptOf(ev));
        return;
      }

      /* ⑤ v188：波段延伸不再「点一下就落点」。
       * 用户口径：**在 A 点长按、拖到 B 点松手**定基准波段（一次落 A/B 两点），
       * 然后**点一下 C**（回调结束的锚点）收尾，自动投射 100% / 200%。
       * 所以这里不做任何 ext 特判，直接走下面统一的长按起笔路径（⑦）。
       * 短按 A 不落点，避免误触；A→B 之后的「点 C」由上面的 ① 分支接住。 */

      /* ⑥ 面板开着但没选工具：空白处只清选中、绝不落点（防误触画新线）。
       * pointer 事件不拦，图表照样能平移；只吞掉 click，避免「点空白关闭面板」。 */
      if (!this.tool) {
        if (this.selectedId) {
          this.selectedId = null;
          if (this.onSelect) this.onSelect(null);
          this.redraw();
        }
        this._swallow = true;
        return;
      }

      /* ⑦ 空白处（线段 / 射线 / 波段延伸）：**长按**才起笔 ——
       *    短按/轻点一律不落点，避免「按到哪就在哪多出一个点」的误触。
       *    长按到阈值 → 出现 A 点（锚点），继续拖到 B 松手 →
       *    线段/射线直接成线；波段延伸保留 A/B 两点，等下一次「点一下 C」收尾。 */
      var p0 = this._ptOf(ev);
      if (!p0) return;
      this._swallow = true;
      ev.preventDefault();
      ev.stopPropagation();
      try { this._host.setPointerCapture && this._host.setPointerCapture(ev.pointerId); } catch (e) {}
      var self = this;
      if (this._lp) { clearTimeout(this._lp.timer); this._lp = null; }
      this._lp = {
        x: xy.x, y: xy.y, pt: p0, fired: false, moved: false,
        timer: setTimeout(function () { self._lpFire(); }, 220)
      };
      /* 轻点空白＝取消选中（只清选中，不落点） */
      if (this.selectedId) {
        this.selectedId = null;
        if (this.onSelect) this.onSelect(null);
      }
      this.redraw();
    },

    /* 长按触发：第一个点出现（线段 / 射线） */
    _lpFire: function () {
      if (!this._lp || this._lp.fired) return;
      this._lp.fired = true;
      this.pending = [this._lp.pt];
      this.hover = this._lp.pt;
      this.redraw();
    },

    /* 点数够了就落库 */
    _commit: function () {
      var need = this.tool === 'ext' ? 3 : 2;
      if (this.pending.length < need) { this.redraw(); return; }
      var arr = this.list();
      arr.push({
        id: 'd' + Date.now() + Math.random().toString(16).slice(2, 6),
        tool: this.tool,
        color: this.color,
        pts: this.pending.slice()
      });
      this.save(arr);
      this.pending = [];
      this.hover = null;
      if (this.onCount) this.onCount(arr.length);
      this.redraw();
    },

    _move: function (ev) {
      if (!this.cv || !this.chart || !this.series) return;
      var xy = this._xy(ev);
      this._hoverXY = xy;

      /* v189【关键修复】真机手指按下后往往**立刻就拖**，不会静止等满 220ms。
       * 原来这里「未触发长按就移动」直接 clearTimeout 并丢弃 _lp ——
       * 于是「按下→拖动」永远落不了 A 点，现象就是用户反馈的
       * 「长按只出现十字光标、什么线都画不出来」。v188 把波段延伸也并入
       * 长按起笔路径后，三种工具全部受影响，所以整版都画不了线。
       * 现在：一有实质位移就立即起笔（等同长按成立），继续跟手续拖；
       * 短按、手指原地轻抖（<10px）仍不落点，防误触照旧。 */
      if (this._lp && !this._lp.fired) {
        if (Math.abs(xy.x - this._lp.x) > 10 || Math.abs(xy.y - this._lp.y) > 10) {
          this._lpFire();
        }
      }

      /* v187：延迟判定期间手指滑开 → 改成拖动命中的那条线 */
      if (this._hold && !this._hold.fired) {
        if (Math.abs(xy.x - this._hold.x) > 10 || Math.abs(xy.y - this._hold.y) > 10) {
          this._holdToDrag();
        }
      }

      if (this.drag) {
        var arr = this.drag.arr || this.list();
        var pt = this._ptOf(ev);
        if (this.drag.i == null && this.drag.orig) {
          this._dragPt = null;   /* v192：整条平移不弹放大镜 */
          /* 整条平移：价格按差值、时间按**索引**差值（跨周末不会落到空档日） */
          if (pt && this.drag.start) {
            var dP = pt.p - this.drag.start.p;
            var times = this._dataTimes(), dI = 0;
            if (times.length) {
              var i0 = this._idxOfTime(this.drag.start.t, times);
              var i1 = this._idxOfTime(pt.t, times);
              if (i0 != null && i1 != null) dI = i1 - i0;
            }
            for (var m = 0; m < arr.length; m++) {
              if (arr[m].id !== this.drag.id) continue;
              var src = this.drag.orig, next = [];
              for (var j = 0; j < src.length; j++) {
                var t = src[j].t;
                if (times.length) {
                  var base = this._idxOfTime(src[j].t, times);
                  if (base != null) {
                    var idx = Math.max(0, Math.min(times.length - 1, base + dI));
                    t = times[idx];
                  }
                }
                next.push({ t: t, p: src[j].p + dP });
              }
              arr[m].pts = next;
              break;
            }
            if (Math.abs(dP) > 1e-9 || dI !== 0) this.drag.moved = true;
          }
        } else if (pt) {
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].id === this.drag.id) { arr[i].pts[this.drag.i] = pt; break; }
          }
          this._dragPt = pt;      /* v192：放大镜跟着被拖的锚点走 */
        }
        if (ev.cancelable) ev.preventDefault();
        /* 【关键】拖动期间必须连 pointermove 也 stopPropagation：
         * 只 preventDefault 挡不住 lightweight-charts 自己的拖拽，图会跟着一起平移。 */
        ev.stopPropagation();
        this.redraw();
        return;
      }

      if (this.pending.length) {
        /* 起笔后：跟手橡皮筋 */
        if (this._lp && this._lp.fired) {
          if (Math.abs(xy.x - this._lp.x) > 10 || Math.abs(xy.y - this._lp.y) > 10) this._lp.moved = true;
        }
        /* 跟手橡皮筋：波段延伸 A→B 已定、等 C 时，移动光标就预览 C 与目标位 */
        this.hover = this._ptOf(ev);
        this.redraw();
        return;
      }

      /* 待机：悬停端点/线身给反馈（光标 + 加粗），提示「这里可以拖 / 可以点」 */
      var overEnd = this._hitEnd(xy);
      var overLine = overEnd ? null : this._hitLine(xy);
      var cur = overEnd ? 'move' : (overLine ? 'pointer' : (this.tool ? 'crosshair' : ''));
      if (this._host && this._host.style.cursor !== cur) this._host.style.cursor = cur;
      var hid = overEnd ? overEnd.d.id : (overLine ? overLine.id : null);
      if (this.hoverId !== hid) { this.hoverId = hid; this.redraw(); }
    },

    _up: function (ev) {
      this._rc = null;
      if (!this.cv) { this.drag = null; return; }
      /* v190：松手即收起放大镜 */
      this._press = false;
      this._hoverXY = null;
      this._dragPt = null;
      /* v408：快照不清空 —— 复用由「图表状态签名」判断（_freezeLoupe）：
       * 松手后没动图表就复用（下次按下零开销），平移/缩放后签名变化自动重建。 */
      /* v187：短按（长按计时未到就抬手）→ 只保留选中，不拖线也不落点 */
      if (this._hold) {
        clearTimeout(this._hold.timer);
        this._hold = null;
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.redraw();
        return;
      }
      /* 长按起笔的收尾：拖到了 B 就落下第二点。
       * · 线段 / 射线：两点即成线，直接落库；
       * · 波段延伸：A→B 只是「基准波段」，清掉跟手点、保留 2 点，
       *   等下一次「点一下 C」由 ① 分支落第三点并收尾。 */
      if (this._lp) {
        var lp = this._lp;
        clearTimeout(lp.timer);
        this._lp = null;
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (lp.fired && this.pending.length === 1) {
          if (lp.moved) {
            var pEnd = this._ptOf(ev) || this.hover;
            if (pEnd) {
              this.pending.push(pEnd);
              this.hover = null;
              if (this.tool === 'ext') this.redraw();
              else this._commit();
            }
          } else {
            this.pending = [];
            this.hover = null;
            this.redraw();
          }
        }
        if (!this.drag) return;
      }
      if (this.drag) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (this.drag.moved !== false) this.save(this.drag.arr || this.list());
        this.drag = null;
        /* v182：拖完端点/整线后刷新面板里的锚点价格输入框 */
        if (this.onSelect) this.onSelect(this.selectedItem());
        if (this.onTool) this.onTool(this.tool);
        this.redraw();
      }
    },
    _cancel: function () {
      this._rc = null;
      this._press = false;
      this._hoverXY = null;
      this._dragPt = null;
      /* v408：快照不清空，复用由签名判断（同 _up） */
      if (this._hold) { clearTimeout(this._hold.timer); this._hold = null; }
      if (this._lp) { clearTimeout(this._lp.timer); this._lp = null; this.pending = []; this.hover = null; }
      if (this.drag) { this.save(this.drag.arr || this.list()); this.drag = null; this.redraw(); }
    },

    /* 画的时候要画「拖动中的最新值」，不是库里的旧值 */
    _arr: function () {
      return (this.drag && this.drag.arr) ? this.drag.arr : this.list();
    },

    /* ---------------- 绘制 ---------------- */
    /* v225：rAF 节流。拖动时 pointermove 一帧可能触发好几次，
     * 每次都 clearRect + 全量重画会明显掉帧（用户：一卡一卡、拖不过去）。 */
    redraw: function () {
      if (this._raf) return;
      var self = this;
      var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      this._raf = raf(function () { self._raf = null; self._draw(); });
    },
    _draw: function () {
      var cv = this.cv;
      if (!cv || !this.chart || !this.series) return;
      /* v401：复用构造时用 willReadFrequently 预取的 context（换参数重新 getContext 无效） */
      var ctx = this._ctx || cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, this._w, this._h);
      this._loupeRect = null;
      if (!this.visible) return;

      var light = document.body.classList.contains('light');
      this.C = {
        txt: light ? '#1b2230' : '#e8edf5',
        bg: light ? 'rgba(255,255,255,0.92)' : 'rgba(18,23,33,0.88)',
        aux: light ? 'rgba(110,120,140,0.85)' : 'rgba(150,162,180,0.85)'
      };

      /* 裁剪到绘图区：任何线（含射线、波段延伸的水平目标线）都不许越过右侧价格轴 */
      var plotR = this._plotRight();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotR, this._h);
      ctx.clip();

      /* v403【拖动卡顿】缺口标注 / 指标（红黑棒）都是静态背景层：缺口每帧要遍历缺口
       * 列表 + 读轴宽，红黑棒要对每根 K 线做 5 次坐标转换（上千根时极贵）。拖动取点/
       * 拖线时用户只关心线和落点，这些背景不必每帧重算 —— 拖动期间跳过，松手恢复。
       * 注意：只在**真正拖动**（drag 或按住起笔）时跳过，普通 hover 仍照常显示。 */
      var dragging = !!(this.drag || (this._press && this.pending.length));
      /* 缺口 + 可视最高/最低价先画在最底层，再叠主图指标与画线 */
      if (!dragging && this.extraPainter) { try { this.extraPainter(ctx, this); } catch (e) {} }
      /* 主图指标（如三五法则的红/黑棒）先画在底层，画线再叠上去 */
      if (!dragging && this.painter) { try { this.painter(ctx, this); } catch (e) {} }

      var arr = this._arr();
      /* 选中的线先判一下还在不在（切品种 / 清空后要自动失效） */
      if (this.selectedId) {
        var found = false;
        for (var k = 0; k < arr.length; k++) if (arr[k].id === this.selectedId) { found = true; break; }
        if (!found) this.selectedId = null;
      }
      for (var i = 0; i < arr.length; i++) this._paint(arr[i], ctx, false);

      /* 放点中：已放的点必须当帧可见 + 橡皮筋跟手（v166 修的重点） */
      if (this.pending.length) {
        var ghost = { tool: this.tool, pts: this.pending.slice(), color: this.color, preview: true };
        if (this.hover) ghost.pts.push(this.hover);
        this._paint(ghost, ctx, true);
      }
      ctx.restore();

      /* v190/v192：按住拖动**取点**时在对侧画放大镜 ——
       *   · 画新线（pending 中）→ 跟手点；
       *   · 拖动已有线的端点 A/B/C（drag.i != null）→ 被拖的锚点；
       *   · 整条平移（drag.i == null）不画，用户看的是整条线不需要放大。
       * 放在 clip 之外，避免圆角窗口被绘图区裁剪；仍受 plotR 限制，不盖价格轴。 */
      var loupePt = this.pending.length ? this.hover
        : (this.drag && this.drag.i != null ? this._dragPt : null);
      if (this._press && loupePt && this._hoverXY) {
        try { this._loupe(ctx, loupePt, this._hoverXY, plotR); } catch (e) {}
      }

      /* 记下本次绘制时的价格轴基准，供看门狗判断“轴有没有变”。
       * v401：`series.data()` 返回整个数据集（日K 上千根），拖动时每帧调用会
       * 反复分配大数组 → 移动端掉帧。看门狗只需要「轴有没有变」，400ms 采一次足够。 */
      var nowTs = Date.now();
      if (!this._probeAt || nowTs - this._probeAt > 400) {
        this._probeAt = nowTs;
        try {
          var dd = this.series && this.series.data ? this.series.data() : null;
          if (dd && dd.length) this._probeY = this._yOf(dd[dd.length - 1].close);
        } catch (e) {}
      }
    },

    _fmt: function (p) {
      var d = this.dec == null ? 2 : this.dec;
      return Number(p).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    },

    _paint: function (d, ctx, preview) {
      if (!d || !d.pts || !d.pts.length) return;
      var q = this._px(d);
      var color = d.color || this.color || this.C.aux;
      var sel = !preview && this.selectedId === d.id;
      var hov = !preview && this.hoverId === d.id;
      var right = this._plotRight();

      ctx.save();
      ctx.lineWidth = preview ? 1.3 : (sel ? 2.6 : 1.8);
      ctx.setLineDash(preview ? [4, 4] : []);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = color;

      if (d.tool === 'seg' && q.length >= 2) {
        if (q[0].x != null && q[1].x != null && q[0].y != null && q[1].y != null) {
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.stroke();
        }
        /* v168：用户口径「画线不需要显示价格」——末端价格标签已去掉 */
      } else if (d.tool === 'ray' && q.length >= 2) {
        if (q[0].x != null && q[1].x != null && q[0].y != null && q[1].y != null) {
          var dx = q[1].x - q[0].x, dy = q[1].y - q[0].y;
          var tx = (dx > 0) ? right : 2;
          var k = (Math.abs(dx) < 0.001) ? 1 : (tx - q[0].x) / dx;
          if (k < 1) k = 1;
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y);
          ctx.lineTo(q[0].x + dx * k, q[0].y + dy * k);
          ctx.stroke();
          /* 同上：不标价格 */
        }
      } else if (d.tool === 'ext' && q.length >= 3) {
        this._ext(ctx, q, right, color, preview);
        ctx.restore();
        this._ends(ctx, q, color, sel, hov, preview, d);
        return;
      } else if (preview) {
        /* 还没点满：把已定的点之间的辅助线画出来（A→B、B→跟手点） */
        if (q.length >= 2 && q[0].x != null && q[1].x != null && q[0].y != null && q[1].y != null) {
          ctx.strokeStyle = this.C.aux;
          ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y); ctx.stroke();
        }
      }

      /* 每个锚点都要看得见 —— 点太小看不见就等于「点了没落点」 */
      this._ends(ctx, q, color, sel, hov, preview, d);
      ctx.restore();
    },

    /* 锚点：实心圆；拖动/选中/预览时放大并加外圈，明确「这里能按住拖」。
     * v169：**没开画图工具时不画端点**（用户：画完关掉工具后那两个点很丑，
     * 只留一条线；再次进画图工具才出现端点，方便调整）。 */
    _ends: function (ctx, q, color, sel, hov, preview, d) {
      /* v186：选了具体工具时，只显示同类型线的端点，避免「看得到却拖不动」 */
      if (this.tool && d && !preview && d.tool !== this.tool) return;
      var show = preview || !!this.tool || this.editOnly || sel || hov;
      if (!show) return;
      for (var j = 0; j < q.length; j++) {
        if (q[j].x == null || q[j].y == null) continue;
        var big = sel || hov || preview;
        this._dot(ctx, q[j], color, big ? 4.2 : 3.2);
        if (sel || hov) {
          ctx.save();
          ctx.setLineDash([]);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.42;
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(q[j].x, q[j].y, 8, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }
    },

    /* 波段延伸（Swing Extension / 斐波那契扩展线，TradingView 的 Fib Extension）
     *
     * 定义（用户口径，三步）：
     *   ① A、B 定基准波段：上涨 A=低点、B=前高；下跌 A=高点、B=前低。幅度 AB = B − A。
     *   ② C 是回调结束的锚点，新一段行情从 C 出发。
     *   ③ 投射：100% = C + AB（等长浪），200% = C + 2AB（加速目标）。
     *
     * 画法（对齐专业软件，一眼能看懂「从哪起、到哪去」）：
     *   A→B 实线（基准波段本体）／B→C 细虚线（回调段）／C 处竖向投射虚线／
     *   目标位水平实线 + 右端价签。目标落在屏幕外时也给价签并标 ↑↓，
     *   否则用户会以为「画完什么都没出来」。 */
    _extLevels: function (d) {
      if (!d || d.tool !== 'ext' || !d.pts || d.pts.length < 3) return [];
      var ab = d.pts[1].p - d.pts[0].p, C = d.pts[2];
      var pcts = [1];
      if (this.ext200On()) pcts.push(2);
      var out = [];
      for (var i = 0; i < pcts.length; i++) {
        var price = C.p + ab * pcts[i];
        out.push({ pct: pcts[i], price: price, y: this._yOf(price) });
      }
      return out;
    },

    _ext: function (ctx, q, right, color, preview) {
      var A = q[0], B = q[1], Cp = q[2];

      /* ① 基准波段 A→B：实线、用主色（这是「这一波」） */
      ctx.setLineDash([]);
      ctx.lineWidth = preview ? 1.3 : 1.8;
      ctx.strokeStyle = color;
      if (A.x != null && B.x != null && A.y != null && B.y != null) {
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }

      /* ② 回调段 B→C：细虚线、辅助色（不抢主色） */
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.C.aux;
      if (B.x != null && Cp.x != null && B.y != null && Cp.y != null) {
        ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(Cp.x, Cp.y); ctx.stroke();
      }
      ctx.restore();

      if (Cp.x == null || Cp.y == null) return;

      var lv = this._extLevels({ tool: 'ext', pts: [{ p: A.p }, { p: B.p }, { p: Cp.p }] });

      /* ③ C 处的竖向投射虚线：从 C 连到最远的那个目标，表示「从 C 起算」 */
      var far = null;
      for (var i = 0; i < lv.length; i++) {
        if (lv[i].y == null) continue;
        if (far == null || Math.abs(lv[i].y - Cp.y) > Math.abs(far - Cp.y)) far = lv[i].y;
      }
      if (far != null && Math.abs(far - Cp.y) > 2) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(Cp.x, Cp.y); ctx.lineTo(Cp.x, far); ctx.stroke();
        ctx.restore();
      }

      /* ④ 目标位横线 + 价签（屏幕外也给签，标 ↑ / ↓） */
      var x0 = Math.max(Cp.x, 2);
      var TOP = 34, BOT = this._h - 12;   // 顶部留出图例/工具条的位置，别压住按钮
      var lastY = null;
      for (var j = 0; j < lv.length; j++) {
        var y = lv[j].y;
        if (y == null) continue;
        var on = (y > 1 && y < this._h - 1);
        if (on) {
          ctx.setLineDash(preview ? [4, 4] : []);
          ctx.lineWidth = preview ? 1.2 : 1.8;
          ctx.strokeStyle = color;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(right, y); ctx.stroke();
          ctx.setLineDash([]);
          /* 起算点的短竖标：让「从 C 出发」更直观 */
          ctx.globalAlpha = 0.5;
          ctx.beginPath(); ctx.moveTo(x0, y - 4); ctx.lineTo(x0, y + 4); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        var label = Math.round(lv[j].pct * 100) + '%  ' + this._fmt(lv[j].price);
        var cy = on ? y : (y < 0 ? TOP : BOT);
        if (!on) label = (y < 0 ? '↑ ' : '↓ ') + label;
        if (lastY != null && Math.abs(cy - lastY) < 15) cy = lastY + (cy < this._h / 2 ? 15 : -15);
        cy = Math.max(TOP, Math.min(BOT, cy));
        lastY = cy;
        this._chip(ctx, right, cy, label, color);
      }
      /* v190：用户口径 —— C 点只是「回调锚点」，不用单独标价；
       * 右侧只保留 100% / 200% 两个目标价签，画面更干净。 */
    },

    /* v190：取点放大镜 —— 手指按住拖动时看不到落点（被手挡住），
     * 在对侧画一个局部放大窗，把落点周围的 K 线放大 2.4 倍。
     * 位置规则（用户口径）：取点在右半屏 → 窗口在左；取点在左半屏 → 窗口在右；
     * 上下同样取对侧（对角），保证手指/手背都盖不到放大窗。
     * 窗口不越出绘图区右边界（plotR），不会盖住价格轴。 */
    /* v400：放大镜图层几何快照。按下时取一次，整个过程复用，松手清空。
     * 避免每帧 querySelectorAll + N 次 getBoundingClientRect（强制同步布局→拖动卡顿）。
     * v401【放大镜没有 K 线】根因：`.pane-main` 用 `left:calc(-1*var(--paneL))` 向左外扩
     * 一个价格轴宽（实测 -56px），原来用「canvas.left 必须等于 host.left（±2px）」筛选，
     * 正好把主图 K 线层全部滤掉，只剩 drawing 自己的层 → 放大镜里只有线。
     * 现在改成：按「尺寸/所属面板」筛选（排除副图、价格轴窄条、时间轴矮条），
     * 并记录每层相对 host 的物理像素偏移 (ox,oy)，源区域按偏移修正，内容不再错位。
     * v401【拖动一卡一卡】根因：真机上 LWC 的 canvas 由 GPU 合成，每帧 drawImage 抓像素
     * 会触发 GPU→CPU 回读（几十毫秒/层）；桌面 headless 的 canvas 在 CPU 内存里，
     * 所以本地测只有 0.02ms、真机却卡死。这里在**按下时一次性**把背景层合成到
     * 离屏普通 canvas，之后每帧只读这张（CPU），回读次数从 N 降到 0。 */
    _freezeLoupe: function (force) {
      var now = Date.now();
      /* v408【签名缓存】快照是否可复用不由时间决定，由「图表状态签名」决定：
       * 可视范围 / 最后一根K线的时间与收盘 / 画布尺寸 —— 任一变化（平移、缩放、
       * 实时数据推新、轴宽变化）都意味着旧快照与当前坐标错位，必须重建；
       * 签名相同（纯拖端点/画线）→ 复用，按下零开销。
       * v406 的 3 秒时间缓存在「拖→松手→平移→再拖」场景复用了错位旧快照，
       * 正是用户看到的「K 线不在红点周围、跑到角落」（错位 30~40px）。 */
      var sig = 'err';
      try {
        var vrS = this.chart.timeScale().getVisibleLogicalRange();
        var ddS = (this.series && this.series.data) ? this.series.data() : null;
        sig = (vrS ? Math.round(vrS.from) + '-' + Math.round(vrS.to) : 'nv') +
          '|' + (ddS && ddS.length ? ddS[ddS.length - 1].time : 0) +
          '|' + (ddS && ddS.length ? ddS[ddS.length - 1].close : 0) +
          '|' + this._w + 'x' + this._h;
      } catch (e) {}
      if (!force && this._loupeBg && (this._loupeSig === sig || sig === 'err')) {
        return this._loupeLayers || [];
      }
      this._loupeSig = sig;
      var out = [];
      var host = this._host;
      this._loupeBg = null;
      this._loupeKRange = null;
      if (!host) { this._loupeLayers = out; return out; }
      var hr = null;
      try { hr = host.getBoundingClientRect(); } catch (e) {}
      var cvs = host.querySelectorAll('canvas');
      for (var c = 0; c < cvs.length; c++) {
        var sc = cvs[c];
        if (!sc.width || !sc.height || !sc.getBoundingClientRect) continue;
        /* 自己（画线层）不参与预合成 —— 每帧单独叠一次，保证「正在画的线」实时 */
        if (sc === this.cv) continue;
        /* 副图（成交量/成交额）不放大：放大镜只看主图 */
        if (sc.closest && sc.closest('.pane-vol')) continue;
        var rr;
        try { rr = sc.getBoundingClientRect(); } catch (e) { continue; }
        if (!rr.width || !rr.height) continue;
        /* 价格轴（窄条 ~58px）与时间轴（矮条 ~28px）排除，避免把刻度数字放大进去 */
        if (rr.width < this._w * 0.5) continue;
        if (rr.height < this._h * 0.5) continue;
        var k = sc.width / rr.width;
        out.push({
          cv: sc, k: k,
          ox: hr ? (hr.left - rr.left) * k : 0,
          oy: hr ? (hr.top - rr.top) * k : 0
        });
      }
      this._loupeLayers = out;
      /* v406【恢复背景预合成】把主图各层按物理偏移对齐画进一张 host 尺寸的离屏 CPU canvas。
       * 一次性开销（按下时，3 秒缓存复用），换来每帧只读 CPU canvas（真机零 GPU 回读）。
       * 关键：像素快照的源矩形用触点 xy（屏幕坐标），与 canvas 像素一一对应，不涉及
       * priceToCoordinate —— 因此不存在 v402 担心的"快照与价格映射错位"（那是矢量重画的问题）。 */
      try {
        if (out.length && this._w > 0 && this._h > 0) {
          var dpr2 = this._dpr || 1;
          var bg = document.createElement('canvas');
          bg.width = Math.round(this._w * dpr2);
          bg.height = Math.round(this._h * dpr2);
          var bctx = bg.getContext('2d');
          if (bctx) {
            for (var b = 0; b < out.length; b++) {
              try { bctx.drawImage(out[b].cv, -out[b].ox, -out[b].oy); } catch (e) {}
            }
            this._loupeBg = bg;
          }
        }
      } catch (e) { this._loupeBg = null; }
      /* v402【放大镜整窗空白】触点可能远离 K 线（画趋势线时手落在空白区），
       * 2 倍放大只取触点周围一小块 → 放大镜里只剩网格和线，看起来像"没 K 线"。
       * 这里记下**可视范围内 K 线的价格区间**（映射成 y），供 _loupe 把源区域
       * 垂直中心夹进去：触点再偏，窗口里也一定能看到 K 线。
       * 只在按下时算一次（可视范围约百来根），不进每帧路径。 */
      try {
        var vr = (this.chart && this.chart.timeScale) ? this.chart.timeScale().getVisibleLogicalRange() : null;
        var dd = (this.series && this.series.data) ? this.series.data() : null;
        if (dd && dd.length) this._loupeData = dd;   /* v402b：缓存给 _loupe 按 x 取局部区间 */
        if (vr && dd && dd.length) {
          var from = Math.max(0, Math.floor(vr.from));
          var to = Math.min(dd.length - 1, Math.ceil(vr.to));
          var lo = Infinity, hi = -Infinity;
          for (var ii = from; ii <= to; ii++) {
            var bar = dd[ii];
            if (!bar) continue;
            var bl = (bar.low != null) ? bar.low : bar.close;
            var bh = (bar.high != null) ? bar.high : bar.close;
            if (bl < lo) lo = bl;
            if (bh > hi) hi = bh;
          }
          var yA = (lo < Infinity) ? this._yOf(lo) : null;
          var yB = (hi > -Infinity) ? this._yOf(hi) : null;
          if (yA != null && yB != null && isFinite(yA) && isFinite(yB)) {
            this._loupeKRange = { top: Math.min(yA, yB), bot: Math.max(yA, yB) };
          }
        }
      } catch (e) { this._loupeKRange = null; }
      this._loupeBgAt = now;
      return out;
    },

    _loupe: function (ctx, pt, xy, plotR) {
      if (!pt || !xy) return;
      /* v404【根因修复】真实页面里 DrawLayer.canvas 挂在 .pane-main 上，而 .pane-main
       * 用 CSS `left: calc(-1 * var(--paneL))` 向左外扩——canvas 左边缘在可见区左边约
       * 54px（真机价格数字更宽，实测更大）。原来窗口按 canvas 坐标 0..plotR 定位，
       * lx 最小=6 → 屏幕位置 = -paneL+6 < 0 → **整个放大镜被 host 的 overflow:hidden
       * 裁在左边缘**（用户截图：窗口只剩右半、价格标签被截成 84/45、×2.0 却完整）。
       * 修法：窗口只在【可见绘图区】[paneL, plotR] 内选边，左右判断也用可见区中点。 */
      var paneL = 0;
      try { paneL = Math.round(this.chart.priceScale('left').width() || 0); } catch (e) { paneL = 0; }
      if (!isFinite(paneL) || paneL < 0) paneL = 0;
      var visL = paneL, visR = Math.max(paneL + 80, (plotR || this._w) - 2);
      var visW = visR - visL;
      var W = Math.min(148, Math.max(100, visW * 0.34));
      var H = Math.min(108, Math.max(74, this._h * 0.32));
      var Z = 2.0;
      var rightSide = (xy.x >= (visL + visR) / 2);
      var lx = rightSide ? (visL + 6) : (visR - W - 6);
      var ly = (xy.y >= this._h / 2) ? 6 : (this._h - H - 6);
      lx = Math.max(visL + 2, Math.min(visR - W - 2, lx));
      ly = Math.max(2, Math.min(this._h - H - 2, ly));
      this._loupeRect = { x: lx, y: ly, w: W, h: H, side: rightSide ? 'left' : 'right' };
      var light = document.body.classList.contains('light');
      var cx = lx + W / 2, cy = ly + H / 2;
      /* v423：放大镜中心与绘制端点共用 _xOfPt（含留白 dx），保持对齐 */
      var y0 = this._yOf(pt.p), x0 = this._xOfPt(pt);
      if (y0 == null) y0 = xy.y;
      if (x0 == null) x0 = xy.x;
      /* v404【根因修复②】放大镜的源中心必须是【端点的真实坐标】(x0,y0)，不能用触点 xy。
       * 拖动已有线端点时，xy 是手指位置，一旦它与端点数据坐标有偏差（坐标系/捕获抖动），
       * 放大的就是旁边那根 K 线 —— 用户："放大镜放大的不是我端点拖到的位置"。
       * 统一用端点真实坐标后：端点 X(pt.t)=cx、Y(pt.p)=cy 落在窗口正中，红点也在正中，
       * K 线矢量与画线层(像素抓取)共用同一源中心，三者必然对齐。 */
      var cySrc = y0;
      var self = this;
      var X = function (t) { var v = self._xOf(t); return (v == null) ? null : cx + (v - x0) * Z; };
      var Y = function (p) { var v = self._yOf(p); return (v == null) ? null : cy + (v - cySrc) * Z; };

      ctx.save();
      /* 底板 + 边框 */
      ctx.fillStyle = light ? 'rgba(255,255,255,0.97)' : 'rgba(20,26,37,0.96)';
      ctx.fillRect(lx, ly, W, H);
      ctx.strokeStyle = light ? 'rgba(90,105,135,0.7)' : 'rgba(150,165,190,0.75)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lx + 0.5, ly + 0.5, W - 1, H - 1);
      ctx.beginPath(); ctx.rect(lx + 1, ly + 1, W - 2, H - 2); ctx.clip();

      /* ① 屏幕局部放大：直接把底层图表 canvas 的像素放大 2.4 倍。
       *    这是「放大镜」而不是「重画 K 线」—— 取点常落在 K 线下方空白区，
       *    此时窗口里就该是空白 + 网格 + 已有画线（用户给的通达信图 3 正是这样）；
       *    按价格轴重绘 K 线会把 K 线推到窗口外，结果什么都看不到。
       *    按 DOM 顺序把所有主图层（含**自己的覆盖层**）叠进窗口：
       *    自己的这层此刻已画好主图指标、已有线与正在画的橡皮筋线，
       *    所以放大镜里也能看到「正在画的线」，与通达信图 2/图 3 一致。
       *    drawImage 读的是当前像素快照，画到自身不会递归。
       *    跳开右侧价格轴（宽约 58）与底部时间轴（高约 26）。
       *    【坑】主 pane canvas 的 CSS 宽 = host 宽 - 价格轴宽（例 630→572），
       *    按 host 宽去匹配会把 K 线层全部漏掉，放大镜里就只剩十字线。 */
      /* v406【回到像素快照】矢量重画（v402~v405）以"触点价格"为中心、只画价格落在窗口窄区间
       * 内的 K 线，价格稍远的 K 线全被推出窗口外——用户："十字光标处有 K 线、放大镜里没有"
       * （诊断 ok=1 但视觉无 K 线）。像素快照直接放大触点周围的真实画面：K 线影线、相邻 K 线、
       * 网格、画线全都在，这才是"放大端点周围"。源中心 = 触点 xy（诊断已证 x0≈xy.x、y0≈xy.y）。 */
      var sx = xy.x - W / (2 * Z), sw = W / Z, sh = H / Z;
      var sy = xy.y - H / (2 * Z);
      /* v400：按下时冻结图层几何（避免高频 pointermove 里 querySelectorAll + N 次
       * getBoundingClientRect 强制 reflow → 卡顿）。drawImage 仍读实时像素。 */
      var layers = this._loupeLayers || this._freezeLoupe();
      var dpr = this._dpr || 1;
      /* ① 背景（K线/网格/指标）：**逐层实时直抓**（v409）。
       * v406~v408 的「预合成离屏快照」在真机 DPR=3 时彻底错位：
       * drawing 的 dpr 被 Math.min(2,..) 限到 2，而 LWC 层是 3 倍物理像素，
       * 预合成 drawImage(cv,-ox,-oy) 按 3 倍画进 2 倍快照、读取又按 2 倍 →
       * K 线被放大 1.5 倍并偏移（诊断 CSS 坐标全对、视觉全错，正是用户现象）。
       * 逐层直抓用「每层自己的 k」换算源矩形，任何 DPR 都自洽；主图只有 2 层，
       * 且只在按住期间执行，性能可接受（本地实测 <3ms）。 */
      /* 【坐标基准】ctx 已 setTransform(dpr=dprClamped,..)，目标矩形 lx/ly/W/H 是 CSS 坐标。
       * 每一层的源矩形必须换算到「该层自己的物理像素」：源 = CSS坐标 × L.k + 物理偏移。
       * L.k 是该层 canvas.width / cssWidth（LWC 在真机 DPR=3 时为 3，而 drawing 的 dpr
       * 被 clamp 到 2），各层独立换算后，drawImage 会把任意比例的源正确缩放进同一目标。 */
      for (var c = 0; c < layers.length; c++) {
        var L = layers[c];
        try { ctx.drawImage(L.cv, sx * L.k + L.ox, sy * L.k + L.oy, sw * L.k, sh * L.k, lx, ly, W, H); } catch (e) {}
      }
      /* ② 画线层（自己的 canvas）：本层 k = dpr（canvas 按 this._dpr 建立），实时叠加。 */
      if (this.cv) {
        try {
          ctx.drawImage(this.cv, sx * dpr, sy * dpr, sw * dpr, sh * dpr, lx, ly, W, H);
        } catch (e) {}
      }

      /* ③ 十字准线 + 落点红点。v403：撤销 clamp 后源中心就是触点，落点＝窗口中心。 */
      var cyReal = cy;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = light ? 'rgba(90,105,135,0.55)' : 'rgba(160,175,200,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lx + 2, cyReal); ctx.lineTo(lx + W - 2, cyReal);
      ctx.moveTo(cx, ly + 2); ctx.lineTo(cx, ly + H - 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff3b52';
      ctx.beginPath(); ctx.arc(cx, cyReal, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

      /* ③ 顶栏：当前价格 + 放大倍率 */
      ctx.font = '10px -apple-system,"SF Mono",Menlo,monospace';
      ctx.fillStyle = light ? '#1b2230' : '#e8edf5';
      ctx.fillText(this._fmt(pt.p), lx + 7, ly + 13);
      ctx.font = '9px -apple-system,"SF Mono",Menlo,monospace';
      ctx.fillStyle = light ? '#8a93a5' : '#8b95a8';
      var zt = '×2.0';
      ctx.fillText(zt, lx + W - 7 - ctx.measureText(zt).width, ly + 13);
      /* v410：移除 v405 的临时诊断两行小字（DPR 根因已由 v409 修复并确认） */
      ctx.restore();
    },

    _dot: function (ctx, q, color, r) {
      if (q.x == null || q.y == null) return;
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(q.x, q.y, r || 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    },

    _label: function (ctx, x, y, text, color) {
      if (!text || x == null || y == null) return;
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = '10px -apple-system,"SF Mono",Menlo,monospace';
      var wpx = ctx.measureText(text).width;
      var px = Math.min(x, this._w - wpx - 8);
      ctx.fillStyle = this.C.bg;
      ctx.fillRect(px - 2, y - 10, wpx + 5, 13);
      ctx.fillStyle = color;
      ctx.fillText(text, px, y);
      ctx.restore();
    },

    _chip: function (ctx, right, y, text, color) {
      if (y == null) return;
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = '9.5px -apple-system,"SF Mono",Menlo,monospace';
      var wpx = ctx.measureText(text).width + 8;
      var x = right - wpx;
      var yy = Math.max(10, Math.min(this._h - 4, y));
      ctx.fillStyle = this.C.bg;
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, yy - 8, wpx, 14, 3); ctx.fill(); }
      else ctx.fillRect(x, yy - 8, wpx, 14);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 4, yy + 1.5);
      ctx.restore();
    }
  };

  DrawLayer.PALETTE = PALETTE;
  w.DrawLayer = DrawLayer;

  /* 等差(linear) / 对数(log)：0=Normal(等差) 1=Logarithmic
   * v167：改为**每个个股各自记**（用户口径：坐标设置也单独保存在对应个股）。
   * 键值存在 mm_scale_v1 = { '代码': 'log'|'linear' }；
   * 老版本那个全局 mm_scale_mode 保留为「新个股的默认值」，不丢用户上次的选择。 */
  var LS_SCALE = 'mm_scale_v1';
  function scaleAll() {
    try { return JSON.parse(localStorage.getItem(LS_SCALE) || '{}') || {}; } catch (e) { return {}; }
  }
  w.DRAW_SCALE = {
    get: function (key) {
      try {
        var all = scaleAll();
        if (key && all[key]) return all[key] === 'log' ? 'log' : 'linear';
        /* 没记录过＝默认等差。**不能**回落到老版本的全局偏好：
         * 那样在 A 股设了对数，切到别的股票也变对数，就违背了「按个股各自保存」。 */
        return 'linear';
      } catch (e) { return 'linear'; }
    },
    set: function (key, m) {
      var v = (m === 'log') ? 'log' : 'linear';
      try {
        if (key) {
          var all = scaleAll();
          all[key] = v;
          localStorage.setItem(LS_SCALE, JSON.stringify(all));
        }
        localStorage.setItem('mm_scale_mode', v);
      } catch (e) {}
    }
  };
})(window);
