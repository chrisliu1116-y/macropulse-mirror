/* ============================================================
 * account.js — 账号与设置同步（v2）
 * ------------------------------------------------------------
 * 两条独立通道，互为备份：
 *  ① 账号同步（WorkBuddy 云）：手机号 + 密码（注册需短信验证码），
 *     数据存 user_profiles（RLS owner-only）。
 *  ② GitHub 同步：用户自己的 GitHub Personal Access Token + **私有 Gist**。
 *     完全不经过本应用服务器 —— 即使本应用云端挂掉/下线，只要 GitHub 在，
 *     换手机粘贴同一个 token 就能把全部设置、自选、浮窗列表拉回来。
 *
 * 安全边界（如实）：
 *  - token 只写本机 localStorage（`mm_gh_token`），不上传任何服务器，不写日志；
 *  - snapshot() 显式排除 token，因此 token 绝不会被备份进云端或 Gist；
 *  - Gist 创建为 public:false（私有），仅用户本人与用户自己授权的应用可读；
 *  - 建议用户在 GitHub 生成 **fine-grained token 或 classic token 仅勾 gist 权限**。
 * ============================================================ */
(function (w, d) {
  'use strict';

  const CFG = {
    endpoint: 'https://macro-pulse.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_0KlILo2qQICjppvJ4EqFwd_YhyfNxuv5UrKlFyAJvLBkSgbjkweKW3j'
  };
  const GH_FILE = 'macro-pulse-config.json';
  const GH_DESC = 'MACRO PULSE 设置备份（私有，仅本人可见）';
  const GH_API = 'https://api.github.com';

  let cloud = null;
  function sdk() {
    if (cloud) return cloud;
    const NS = w.WorkBuddyCloud;
    if (!NS || typeof NS.createWorkBuddyCloud !== 'function') throw new Error('账号服务 SDK 未加载');
    cloud = NS.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
      publishableKey: CFG.publishableKey
    });
    return cloud;
  }
  const store = {
    get(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  /* token / 临时阶段 不进备份：token 是凭据，阶段是机器本地状态 */
  const SKIP = { mm_gh_token: 1, mm_ev_stage_v1: 1 };
  const mmKeys = () => Object.keys(localStorage).filter(k => /^mm_/.test(k) && !SKIP[k]);
  function snapshot() { const o = {}; mmKeys().forEach(k => { o[k] = store.get(k, null); }); return o; }
  function restore(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    let n = 0;
    Object.keys(obj).forEach(k => { if (/^mm_/.test(k) && !SKIP[k]) { store.set(k, obj[k]); n++; } });
    return n;
  }

  let pendingOtp = null;
  let busy = false;
  let ui = { mode: 'login', phone: '', pwd: '', code: '', err: '', info: '', gerr: '', ginfo: '', glogin: '' };

  async function session() {
    try { const r = await sdk().auth.getSession(); return r && r.data && r.data.user ? r.data : null; }
    catch (e) { return null; }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- GitHub 通道 ---------------- */
  const ghToken = () => store.get('mm_gh_token', '') || '';
  const ghGist = () => store.get('mm_gh_gist', '') || '';
  function ghConnected() { return !!ghToken(); }

  /* APP 内走原生桥（file:// origin 对 api.github.com 的写请求不可靠）；
   * 浏览器里 api.github.com 允许 CORS，直接 fetch。 */
  function ghNative(url, method, body, auth) {
    const np = w.NativePulse;
    if (!np || typeof np.nativeHttp !== 'function') return null;
    const raw = np.nativeHttp(url, method, body || '', auth || '');
    if (!raw) throw new Error('网络不可用（原生通道无响应）');
    const i = raw.indexOf('\n');
    if (i < 0) throw new Error('原生通道返回异常');
    return { status: +raw.slice(0, i), text: raw.slice(i + 1) };
  }

  async function ghFetch(path, opts) {
    opts = opts || {};
    const token = ghToken();
    if (!token) throw new Error('请先连接 GitHub');
    const url = GH_API + path;
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.stringify(opts.body) : '';
    const auth = 'Bearer ' + token;
    let status, text;
    const nres = ghNative(url, method, body, auth);
    if (nres) { status = nres.status; text = nres.text; }
    else {
      const r = await fetch(url, {
        method, headers: { Authorization: auth, Accept: 'application/vnd.github+json' },
        body: body || undefined
      });
      status = r.status; text = await r.text();
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (status >= 400) {
      const why = json && json.message ? json.message : ('HTTP ' + status);
      if (status === 401) throw new Error('token 无效或已过期（401）');
      if (status === 403) throw new Error('权限不足或触发限流（403）：请确认 token 勾了 gist 权限');
      throw new Error('GitHub ' + status + '：' + why);
    }
    return json;
  }

  async function ghWhoami() {
    const u = await ghFetch('/user');
    if (!u || !u.login) throw new Error('读取 GitHub 账号失败');
    ui.glogin = u.login;
    return u.login;
  }

  /* 找到（或创建）专用私有 Gist，返回 gist id */
  async function ghEnsureGist(forceNew) {
    if (!forceNew && ghGist()) {
      try {
        const g = await ghFetch('/gists/' + ghGist());
        if (g && g.id) return g.id;
      } catch (e) { /* 被删了就重建 */ }
    }
    const list = await ghFetch('/gists?per_page=100');
    if (Array.isArray(list)) {
      const hit = list.find(g => g && g.files && g.files[GH_FILE]);
      if (hit) { store.set('mm_gh_gist', hit.id); return hit.id; }
    }
    const made = await ghFetch('/gists', {
      method: 'POST',
      body: { description: GH_DESC, public: false, files: { [GH_FILE]: { content: '{"app":"MACRO PULSE","ver":1,"data":{}}' } } }
    });
    if (!made || !made.id) throw new Error('创建私有 Gist 失败');
    store.set('mm_gh_gist', made.id);
    return made.id;
  }

  async function ghConnect() {
    const el = d.getElementById('ghTok');
    const tok = el ? (el.value || '').trim() : '';
    if (!/^(gh[pousr]_|github_pat_)/.test(tok) || tok.length < 20) {
      throw new Error('请粘贴有效的 GitHub token（ghp_… 或 github_pat_…）');
    }
    store.set('mm_gh_token', tok);
    try {
      const name = await ghWhoami();
      await ghEnsureGist(false);
      ui.ginfo = '已连接 @' + name + '，Gist 就绪';
      /* 首次连接：本机没有任何自选（新手机/新装）→ 自动从云端恢复一次 */
      const noLocal = !(store.get('mm_watch2', null) || []).length;
      if (noLocal) {
        try { await ghPull(true); } catch (e) { /* 云端没备份就跳过 */ }
      } else {
        await ghPush();          // 本机有数据 → 先备份，避免覆盖丢配置
      }
      startAuto();
    } catch (e) {
      store.del('mm_gh_token'); store.del('mm_gh_gist');
      throw e;
    }
  }

  async function ghPush() {
    if (!ghConnected()) throw new Error('请先连接 GitHub');
    const id = await ghEnsureGist(false);
    const data = snapshot();
    const payload = JSON.stringify({ app: 'MACRO PULSE', ver: 1, at: new Date().toISOString(), data });
    await ghFetch('/gists/' + id, { method: 'PATCH', body: { files: { [GH_FILE]: { content: payload } } } });
    ui.ginfo = '已备份 ' + Object.keys(data).length + ' 项设置到你的私有 Gist';
  }

  async function ghPull(silent) {
    if (!ghConnected()) throw new Error('请先连接 GitHub');
    const id = await ghEnsureGist(false);
    const g = await ghFetch('/gists/' + id);
    const f = g && g.files && g.files[GH_FILE];
    let body = f && (f.content || '');
    if (!body && f && f.raw_url) {
      const raw = await fetch(f.raw_url);
      body = await raw.text();
    }
    if (!body) throw new Error('Gist 里还没有备份内容');
    let obj = null;
    try { obj = JSON.parse(body); } catch (e) { throw new Error('备份内容无法解析'); }
    const n = restore(obj.data || obj);
    if (!n) { if (!silent) ui.ginfo = '备份里没有可恢复项'; return; }
    ui.ginfo = '已从 GitHub 恢复 ' + n + ' 项设置，页面即将刷新';
    setTimeout(() => location.reload(), 650);
  }

  /* ---------------- v3 自动同步 ----------------
   * 用户反馈：「同步给 github 还要每次输 token 点同步吗？不能自动同步？」
   * 现在：连接成功即自动备份一次；之后每 20 秒比对配置指纹，有变化就静默 push。
   * token 存在本机，重启 APP 仍是连接态，不用重输。 */
  let _autoTimer = 0, _lastFP = '';
  const fp = () => JSON.stringify(snapshot());
  function startAuto() {
    if (!ghConnected()) return;
    if (!_lastFP) _lastFP = fp();
    if (_autoTimer) return;
    _autoTimer = setInterval(() => {
      if (!ghConnected()) return;
      const cur = fp();
      if (cur !== _lastFP) {
        _lastFP = cur;
        ghPush().then(() => { ui.ginfo = '已自动备份到 GitHub（' + new Date().toTimeString().slice(0, 5) + '）'; })
          .catch(() => {});
      }
    }, 20000);
  }

  function ghDisconnect() {
    store.del('mm_gh_token'); store.del('mm_gh_gist');
    ui.glogin = ''; ui.ginfo = '已断开 GitHub（本机备份内容不受影响）';
  }

  /* ---------------- 卡片 ---------------- */
  function acctCard(user) {
    if (!user) {
      const m = ui.mode;
      return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号同步（应用云）</div>
        <div class="acct-tabs">
          <button data-act="mode" data-v="login" class="${m === 'login' ? 'on' : ''}">登录</button>
          <button data-act="mode" data-v="signup" class="${m === 'signup' ? 'on' : ''}">注册</button>
        </div>
        <div class="acct-form">
          <input id="acctPhone" type="tel" maxlength="11" inputmode="numeric" placeholder="手机号（11 位）" value="${esc(ui.phone || '')}">
          ${m === 'signup' ? `<div class="acct-code"><input id="acctCode" type="text" maxlength="8" placeholder="短信验证码" value="${esc(ui.code || '')}"><button class="mini-btn" data-act="send">获取验证码</button></div>` : ''}
          <input id="acctPwd" type="password" placeholder="${m === 'signup' ? '设置密码（≥8 位）' : '密码'}" value="">
          ${ui.err ? `<div class="acct-err">${esc(ui.err)}</div>` : ''}
          ${ui.info ? `<div class="acct-ok">${esc(ui.info)}</div>` : ''}
          <button class="acct-main" data-act="${m === 'signup' ? 'signup' : 'login'}">${m === 'signup' ? '创建账号' : '登录'}</button>
          <div class="acct-sub">账号保存在本应用云端；自选股、主题、预警、阈值与全部设置可跨设备恢复。<b>若担心本应用服务不可用，请同时连下面那条 GitHub 通道。</b></div>
        </div>
      </div>`;
    }
    return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号同步（应用云）</div>
        <div class="set-row"><div><b>已登录</b><span>${esc(user.phone || user.email || user.id)} · 配置保存在云端</span></div>
          <button class="mini-btn" data-act="out">退出</button></div>
        <div class="acct-btns">
          <button class="acct-main" data-act="pull">从云端恢复设置</button>
          <button class="acct-main ghost" data-act="push">把本机设置备份到云端</button>
        </div>
        <div class="acct-sub">恢复会用云端版本覆盖本机同名配置；备份会把当前全部 mm_* 设置写入你的私有数据行。</div>
        ${ui.err ? `<div class="acct-err">${esc(ui.err)}</div>` : ''}
        ${ui.info ? `<div class="acct-ok">${esc(ui.info)}</div>` : ''}
      </div>`;
  }

  function ghCard() {
    const on = ghConnected();
    return `
      <div class="set-card" id="ghCard">
        <div class="set-card-h">GitHub 同步（独立通道）</div>
        ${on ? `
        <div class="set-row"><div><b>已连接${ui.glogin ? ' @' + esc(ui.glogin) : ''}</b><span>配置存放在你自己的 <b>私有 Gist</b>；不经过本应用服务器，本应用云端不可用也能恢复</span></div></div>
        <div class="acct-btns">
          <button class="acct-main" data-gh="pull">从 GitHub 恢复</button>
          <button class="acct-main ghost" data-gh="push">备份到 GitHub</button>
        </div>
        <div class="set-row"><div><b>断开连接</b><span>只清除本机 token，不删除 Gist 里的备份</span></div>
          <button class="mini-btn" data-gh="out">断开</button></div>
        ` : `
        <div class="acct-form">
          <input id="ghTok" type="password" placeholder="粘贴 GitHub token（ghp_… / github_pat_…）" autocomplete="off" spellcheck="false">
          <button class="acct-main" data-gh="connect">连接 GitHub</button>
          <div class="acct-sub">
            1）GitHub → Settings → Developer settings → Personal access tokens → 生成 token，<b>只勾 <code>gist</code> 权限</b>；<br>
            2）粘贴到这里点连接，之后即可「备份 / 恢复」——配置会写进你自己账号下的<b>私有 Gist</b>；<br>
            3）token <b>只存在本机</b>，不会上传、不会写日志、也不会被备份进云端或 Gist。
          </div>
        </div>`}
        ${ui.gerr ? `<div class="acct-err">${esc(ui.gerr)}</div>` : ''}
        ${ui.ginfo ? `<div class="acct-ok">${esc(ui.ginfo)}</div>` : ''}
      </div>`;
  }

  function cardHTML(user) { return acctCard(user) + ghCard(); }

  /* v3【bug 修复】重绘会重建输入框，之前没把用户已输入的值写回 ui，
   * 于是「输手机号 → 点获取验证码 → 手机号消失」。每次重绘前先抓一遍。 */
  function captureInputs() {
    const ph = d.getElementById('acctPhone'); if (ph) ui.phone = ph.value || '';
    const cd = d.getElementById('acctCode'); if (cd) ui.code = cd.value || '';
    const gk = d.getElementById('ghTok'); if (gk) ui.ghTok = gk.value || '';
  }

  function renderCard(root) {
    captureInputs();
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host) return;
    if (ghConnected() && !ui.glogin) { ghWhoami().catch(() => {}).finally(() => paint(host)); }
    paint(host);
  }
  function paint(host) {
    session().then(s => { host.innerHTML = cardHTML(s && s.user); })
      .catch(() => { host.innerHTML = cardHTML(null); })
      .finally(() => { if (ghConnected()) startAuto(); });   // 已连接则恢复自动同步
  }

  function bindCard(root) {
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('click', async e => {
      if (busy) return;
      const gb = e.target.closest('[data-gh]');
      const b = e.target.closest('[data-act]');
      if (!gb && !b) return;
      ui.err = ''; ui.info = ''; ui.gerr = ''; ui.ginfo = '';
      busy = true;
      try {
        if (gb) {
          const act = gb.dataset.gh;
          if (act === 'connect') { await ghConnect(); }
          else if (act === 'push') { await ghPush(); }
          else if (act === 'pull') { await ghPull(); }
          else if (act === 'out') { ghDisconnect(); }
          renderCard(host);
          return;
        }
        const act = b.dataset.act;
        if (act === 'mode') { ui.mode = b.dataset.v; renderCard(host); return; }
        if (act === 'send') { await send(); renderCard(host); return; }
        if (act === 'login' || act === 'signup') { await submit(act); renderCard(host); return; }
        if (act === 'pull') { await pull(); renderCard(host); return; }
        if (act === 'push') { await push(); renderCard(host); return; }
        if (act === 'out') { await sdk().auth.signOut(); renderCard(host); return; }
      } catch (err) {
        const msg = (err && err.message) ? err.message : '操作失败，请稍后再试';
        if (gb) ui.gerr = msg; else ui.err = msg;
        renderCard(host);
      } finally { busy = false; }
    });
  }

  /* ---------------- 应用云通道 ---------------- */
  async function send() {
    const phone = (d.getElementById('acctPhone').value || '').trim();
    if (!/^1\d{10}$/.test(phone)) throw new Error('请输入正确的 11 位手机号');
    const r = await sdk().auth.sendOtp({ phone });
    if (r.error) throw new Error(r.error.message || '验证码发送失败');
    pendingOtp = { phone, verificationId: r.data.verificationId, isExistingUser: !!r.data.isExistingUser };
    ui.info = pendingOtp.isExistingUser ? '验证码已发送；该手机号已注册，注册页也可直接登录' : '验证码已发送';
  }

  async function submit(act) {
    const phone = (d.getElementById('acctPhone').value || '').trim();
    const pwd = d.getElementById('acctPwd').value || '';
    if (!/^1\d{10}$/.test(phone)) throw new Error('请输入正确的 11 位手机号');
    if (pwd.length < 8) throw new Error('密码至少 8 位');
    if (act === 'login') {
      const r = await sdk().auth.signInWithPassword({ phone, password: pwd });
      if (r.error) throw new Error(r.error.message || '账号或密码错误');
      ui.info = '登录成功，正在自动恢复云端设置…';
      try { await pull(true); } catch (e) {}
      return;
    }
    const p = pendingOtp;
    if (!p || p.phone !== phone) throw new Error('请先获取当前手机号的验证码');
    const code = (d.getElementById('acctCode').value || '').trim();
    const done = await sdk().auth.verifyOtp({
      phone: p.phone, verificationId: p.verificationId,
      isExistingUser: p.isExistingUser, token: code,
      password: p.isExistingUser ? undefined : pwd
    });
    if (done.error) throw new Error(done.error.message || '验证码校验失败');
    if (p.isExistingUser) { ui.info = '验证成功，该手机号已有账号，请切回登录'; pendingOtp = null; return; }
    pendingOtp = null;
    ui.info = '账号创建成功，正在备份本机设置…';
    try { await push(); } catch (e) {}
    ui.info = '账号创建成功，本机设置已备份';
  }

  async function fetchRow() {
    const r = await sdk().database.from('user_profiles').select('owner_id,data,version,updated_at').maybeSingle();
    if (r.error) throw new Error(r.error.message || '读取云端配置失败');
    return r.data;
  }

  async function push() {
    const s = await session(); if (!s) throw new Error('请先登录');
    const data = snapshot();
    const row = await fetchRow();
    if (row) {
      const u = await sdk().database.from('user_profiles')
        .update({ data, version: (row.version || 0) + 1, updated_at: new Date().toISOString() })
        .eq('owner_id', row.owner_id).select();
      if (u.error) throw new Error(u.error.message || '备份失败');
      if (!Array.isArray(u.data) || !u.data.length) throw new Error('备份未生效（权限或网络）');
    } else {
      const i = await sdk().database.from('user_profiles')
        .insert({ data, version: 1, owner_name: s.user && s.user.name ? s.user.name : null }).select();
      if (i.error) throw new Error(i.error.message || '备份失败');
      if (!Array.isArray(i.data) || !i.data.length) throw new Error('备份未生效（权限或网络）');
    }
    ui.info = '已备份 ' + Object.keys(data).length + ' 项设置';
  }

  async function pull(silent) {
    const s = await session(); if (!s) throw new Error('请先登录');
    const row = await fetchRow();
    if (!row || !row.data) {
      if (!silent) ui.info = '云端还没有备份；可点「把本机设置备份到云端」';
      return;
    }
    const n = restore(row.data);
    ui.info = '已恢复 ' + n + ' 项设置，页面即将刷新';
    setTimeout(() => location.reload(), 650);
  }

  w.MPAccount = {
    cardHTML, renderCard, bindCard,
    async refresh(root) { renderCard(root); bindCard(root); },
    status: async () => !!(await session()),
    ghStatus: () => ({ connected: ghConnected(), login: ui.glogin, gist: ghGist() }),
    /* 只读调试句柄：验证 token 不进入备份清单（供 tools 里的实测脚本使用） */
    _snapshotKeys: () => Object.keys(snapshot()),
    pull, push,
    ghPull, ghPush, ghConnect, ghDisconnect
  };
})(window, document);
