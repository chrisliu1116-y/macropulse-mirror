/* ============================================================
 * account.js — 云端账号与设置同步（v1）
 * ------------------------------------------------------------
 * 使用 WorkBuddy Cloud Service：手机号 + 密码（注册需短信验证码）。
 * 数据库表 user_profiles（RLS owner-only），同步内容 = 本机全部 mm_*
 * 配置（自选、主题、预警、阈值、浮窗等）。
 * 换手机登录后一键「从云端恢复」。token/密码不落日志。
 * ============================================================ */
(function (w, d) {
  'use strict';

  const CFG = {
    endpoint: 'https://macro-pulse.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_0KlILo2qQICjppvJ4EqFwd_YhyfNxuv5UrKlFyAJvLBkSgbjkweKW3j'
  };

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
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const mmKeys = () => Object.keys(localStorage).filter(k => /^mm_/.test(k) && k !== 'mm_ev_stage_v1');
  function snapshot() { const o = {}; mmKeys().forEach(k => { o[k] = store.get(k, null); }); return o; }
  function restore(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    let n = 0;
    Object.keys(obj).forEach(k => { if (/^mm_/.test(k)) { store.set(k, obj[k]); n++; } });
    return n;
  }

  let pendingOtp = null;
  let busy = false;
  let ui = { mode: 'login', phone: '', pwd: '', code: '', err: '', info: '' };

  async function session() {
    try { const r = await sdk().auth.getSession(); return r && r.data && r.data.user ? r.data : null; }
    catch (e) { return null; }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function cardHTML(user) {
    if (!user) {
      const m = ui.mode;
      return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号同步</div>
        <div class="acct-tabs">
          <button data-act="mode" data-v="login" class="${m === 'login' ? 'on' : ''}">登录</button>
          <button data-act="mode" data-v="signup" class="${m === 'signup' ? 'on' : ''}">注册</button>
        </div>
        <div class="acct-form">
          <input id="acctPhone" type="tel" maxlength="11" inputmode="numeric" placeholder="手机号（11 位）" value="${esc(ui.phone)}">
          ${m === 'signup' ? `<div class="acct-code"><input id="acctCode" type="text" maxlength="8" placeholder="短信验证码" value="${esc(ui.code)}"><button class="mini-btn" data-act="send">获取验证码</button></div>` : ''}
          <input id="acctPwd" type="password" placeholder="${m === 'signup' ? '设置密码（≥8 位）' : '密码'}" value="">
          ${ui.err ? `<div class="acct-err">${esc(ui.err)}</div>` : ''}
          ${ui.info ? `<div class="acct-ok">${esc(ui.info)}</div>` : ''}
          <button class="acct-main" data-act="${m === 'signup' ? 'signup' : 'login'}">${m === 'signup' ? '创建账号' : '登录'}</button>
          <div class="acct-sub">账号保存在本应用云端；自选股、主题、预警、阈值与全部设置可跨设备恢复。</div>
        </div>
      </div>`;
    }
    return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号同步</div>
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

  function renderCard(root) {
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host) return;
    session().then(s => { host.innerHTML = cardHTML(s && s.user); }).catch(() => { host.innerHTML = cardHTML(null); });
  }

  function bindCard(root) {
    const card = (root && root.nodeType === 1) ? root : d.getElementById('acctCard');
    if (!card) return;
    card.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b || busy) return;
      const act = b.dataset.act;
      ui.err = ''; ui.info = '';
      try {
        if (act === 'mode') { ui.mode = b.dataset.v; renderCard(); return; }
        if (act === 'send') { await send(); renderCard(); return; }
        if (act === 'login' || act === 'signup') { await submit(act); renderCard(); return; }
        if (act === 'pull') { await pull(); renderCard(); return; }
        if (act === 'push') { await push(); renderCard(); return; }
        if (act === 'out') { await sdk().auth.signOut(); renderCard(); return; }
      } catch (err) {
        ui.err = (err && err.message) ? err.message : '操作失败，请稍后再试';
        renderCard();
      }
    });
  }

  async function send() {
    const phone = (d.getElementById('acctPhone').value || '').trim();
    if (!/^1\d{10}$/.test(phone)) throw new Error('请输入正确的 11 位手机号');
    const r = await sdk().auth.sendOtp({ phone });
    if (r.error) throw new Error(r.error.message || '验证码发送失败');
    pendingOtp = { phone, verificationId: r.data.verificationId, isExistingUser: !!r.data.isExistingUser };
    ui.info = pendingOtp.isExistingUser ? '验证码已发送；该手机号已注册，注册页也可直接登录' : '验证码已发送';
  }

  async function submit(act) {
    if (busy) return;
    busy = true;
    try {
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
    } finally { busy = false; }
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
    async refresh(root) { await renderCard(root); const c = d.getElementById('acctCard'); if (c) bindCard(c); },
    status: async () => !!(await session()),
    pull, push
  };
})(window, document);
