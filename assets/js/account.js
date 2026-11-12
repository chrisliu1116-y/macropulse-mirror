/* ============================================================
 * account.js — 账号与设置同步（v6：WorkBuddy 主 / CF KV 备 / GitHub 备（待启用）/ 本机哈希兜底）
 * ------------------------------------------------------------
 * 核实结论（cloud-service skill references/auth/code-generation.md）：
 *   · auth.signUp 强制 verificationToken —— 注册建号必须一次性 OTP；
 *   · auth.signInWithPassword({ email|phone, password }) 是纯账号+密码登录，
 *     参数里不含、也不需要任何验证码 / verificationToken —— 登录永不需验证码。
 * 因此架构成立：注册那一次走 OTP 完成 WorkBuddy 建号，并把「真实 email/phone
 * 身份（wbId）+ PBKDF2 哈希派生值」写进凭据；之后（含换设备）仅用
 * signInWithPassword 重建会话，无需再 OTP。
 *   · 主通道 = WorkBuddy Cloud Service（user_profiles，读写需 WorkBuddy 会话）
 *   · 备通道 = Cloudflare Worker 的 /account/*（Workers KV）
 *   · 备通道 = GitHub（可配置开关；未拿到可写 token 前默认「未启用」）
 *   · 兜底 = 本机 PBKDF2 哈希缓存（云通道全挂也能离线登录）
 * 密码绝不落明文：本地 Web Crypto PBKDF2(100000 轮 / SHA-256 / 16B 随机 salt)
 *   生成 pwd_hash = "pbkdf2$100000$<salt_base64>$<hash_base64>"。
 *   明文密码与一次性验证码只在函数局部变量中，绝不写入 localStorage /
 *   云端 / 日志 / DOM value；发给 WorkBuddy 的 password 是哈希派生值，绝非明文。
 * 前端绝不出现任何 GitHub Token / 密钥输入框。
 * ============================================================ */
(function (w, d) {
  'use strict';

  /* ACCT_API：Cloudflare Worker 备选通道统一入口（/account/* 五路由 + Workers KV）。
   * 前端不发任何鉴权头；Worker 在服务端持有密钥。 */
  const ACCT_API = 'https://macropulse-edge.mp-7962af18.workers.dev';

  const CFG = {
    endpoint: 'https://macro-pulse.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_0KlILo2qQICjppvJ4EqFwd_YhyfNxuv5UrKlFyAJvLBkSgbjkweKW3j'
  };

  /* GitHub 备份通道开关：默认「未启用」，绝不假装可用。
   * 阻塞原因：现有 PAT 无 Gist 写权限（POST /gists 403）、两仓库均 public，
   * 不能落盘账号凭据。要启用需用户先提供其一：
   *   classic PAT 的 gist scope；
   *   fine-grained PAT 的 Gists: Read and write；
   *   私有仓的 Contents: Read and write（并配置 Worker 侧 GH_BACKUP_*）。
   * 未启用时健康状态如实显示「未启用 + 所需权限」。 */
  const GH_BACKUP = {
    enabled: false,
    reason: '未拿到可写 token：需 classic gist / fine-grained Gists: Read and write / 私有仓 Contents: Read and write'
  };

  const CRED_KEY = 'mm_account_cred';   // 本机哈希凭据缓存（仅哈希，绝无明文）
  const USER_KEY = 'mm_acct_user';      // 本机登录态标记（仅账号名，绝无密码）
  const PBKDF2_ITER = 100000;
  const SALT_BYTES = 16;
  const WB_TIMEOUT = 8000;             // 主通道超时（ms）
  const API_TIMEOUT = 8000;            // 备选通道超时（ms）

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
  /* token / 临时阶段 / 凭据哈希缓存 / 登录态 / 一次性验证码不进设置备份。
   * 历史遗留的 GitHub / Gist 键同样排除，确保任何密钥都不会被快照带走。 */
  const SKIP = { mm_gh_token: 1, mm_ev_stage_v1: 1, mm_account_cred: 1, mm_acct_user: 1, mm_acct_otp: 1 };
  const mmKeys = () => Object.keys(localStorage).filter(k => /^mm_/.test(k) && !SKIP[k]);
  function snapshot() { const o = {}; mmKeys().forEach(k => { o[k] = store.get(k, null); }); return o; }
  function restore(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    let n = 0;
    Object.keys(obj).forEach(k => { if (/^mm_/.test(k) && !SKIP[k]) { store.set(k, obj[k]); n++; } });
    return n;
  }

  let busy = false;
  /* 登录态来自本机标记（与 WorkBuddy 会话解耦，WorkBuddy 挂了也能进） */
  const loggedUser = () => store.get(USER_KEY, null);

  /* 同步状态：primary = WorkBuddy 主通道，backup = CF KV 备通道，github = GitHub 备通道。
   * 文本里只放 ✓/✗ 与失败原因，绝不出现任何密钥。 */
  let ui = {
    mode: 'login', account: '', wbId: '',
    err: '', info: '',
    primary: '', primaryOk: false,
    backup: '', backupOk: false,
    github: '', githubOk: false,
    otp: { pending: null, sent: false }   // 一次性验证码 challenge（仅内存，绝不落盘）
  };

  async function session() {
    try { const r = await sdk().auth.getSession(); return r && r.data && r.data.user ? r.data : null; }
    catch (e) { return null; }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- Web Crypto / 密码哈希 ---------------- */
  function cryptoOK() {
    return !!(w.crypto && w.crypto.subtle && typeof w.crypto.getRandomValues === 'function' && typeof w.TextEncoder === 'function');
  }
  function noCryptoMsg() {
    return '当前环境不支持 Web Crypto（crypto.subtle 不可用，例如以 file:// 直接打开）。密码只能以哈希保存，不会回退明文；请用 https 网页或 App 内打开后再注册 / 登录。';
  }
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return w.btoa(s);
  }
  function unb64(str) {
    const s = w.atob(String(str));
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  async function pbkdf2Hash(password, saltU8, iter) {
    const key = await w.crypto.subtle.importKey('raw', new w.TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await w.crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltU8, iterations: iter, hash: 'SHA-256' }, key, 256);
    return b64(new Uint8Array(bits));
  }
  /* 常数时间比较（不短路） */
  function ctEqual(a, b) {
    a = String(a); b = String(b);
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }
  async function buildCred(account, password, wbId, wbKind) {
    if (!cryptoOK()) throw new Error(noCryptoMsg());
    const salt = new Uint8Array(SALT_BYTES);
    w.crypto.getRandomValues(salt);
    const saltB64 = b64(salt);
    const hashB64 = await pbkdf2Hash(password, salt, PBKDF2_ITER);
    return {
      account,
      pwd_hash: 'pbkdf2$' + PBKDF2_ITER + '$' + saltB64 + '$' + hashB64,
      salt: saltB64,
      iter: PBKDF2_ITER,
      /* 真实 email/phone：注册那次 OTP 用它建 WorkBuddy 账号；之后登录
       * signInWithPassword 复用同一身份，永不需验证码。空 = 仅本机注册。 */
      wbId: String(wbId || ''),
      wbKind: String(wbKind || ''),
      updated: new Date().toISOString()
    };
  }
  function credParams(cred) {
    const parts = String((cred && cred.pwd_hash) || '').split('$');
    if (parts.length === 4 && parts[0] === 'pbkdf2') {
      const iter = parseInt(parts[1], 10);
      if (iter > 0 && parts[2] && parts[3]) return { iter, saltB64: parts[2], hashB64: parts[3] };
    }
    return null;
  }
  async function verifyCred(password, cred) {
    if (!cryptoOK()) throw new Error(noCryptoMsg());
    const p = credParams(cred);
    if (!p) throw new Error('账号凭据格式损坏，请重新注册');
    const candidate = await pbkdf2Hash(password, unb64(p.saltB64), p.iter);
    return ctEqual(candidate, p.hashB64);   // 常数时间比较
  }

  /* ---------------- 通用：带超时的 Promise / 错误归一 ---------------- */
  function withTimeout(task, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error((label || '通道') + '超时')); } }, ms);
      const run = (typeof task === 'function') ? task : () => task;
      Promise.resolve().then(run).then(
        v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        e => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
      );
    });
  }
  function errMsg(r) { return (r && r.message) ? r.message : String(r || '未知错误'); }
  function now() { return new Date().toTimeString().slice(0, 5); }

  /* ---------------- 备通道：Cloudflare Worker HTTP API ----------------
   * 前端不发任何鉴权头；统一超时、统一错误转中文，便于上层回退判断。 */
  async function edgeApi(path, method, body) {
    const init = { method: method || 'GET' };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await withTimeout(fetch(ACCT_API + path, init), API_TIMEOUT, '备份通道');
    } catch (e) {
      throw new Error('备份通道不可用：' + errMsg(e));
    }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) {
      const why = (json && (json.error || json.message)) || ('HTTP ' + res.status);
      throw new Error('备份通道返回 ' + res.status + '：' + why);
    }
    return json;
  }
  /* 从 login / restore 的响应里稳健取出目标对象（兼容多种包装） */
  function pickCred(json) {
    if (!json) return null;
    const c = json.cred || json;
    return (c && c.account && c.pwd_hash) ? c : null;
  }
  function pickSnapshot(json) {
    if (!json) return null;
    const s = json.snapshot || json.data || json;
    return (s && typeof s === 'object') ? s : null;
  }

  /* 备通道 4 个接口：注册 / 取凭据 / 备份设置 / 恢复设置
   * register 透传 wbId/wbKind（Worker 把 body 全量存入 KV），保证换设备后
   * 仍能拿到 WorkBuddy 身份用于 signInWithPassword。 */
  async function edgeRegister(cred) {
    await edgeApi('/account/register', 'POST', {
      account: cred.account,
      pwd_hash: cred.pwd_hash,
      salt: cred.salt,
      iter: cred.iter,
      wbId: cred.wbId || '',
      wbKind: cred.wbKind || ''
    });
  }
  async function edgeLogin(account) {
    const j = await edgeApi('/account/login', 'POST', { account });
    return pickCred(j);
  }
  async function edgeBackup(data) {
    await edgeApi('/account/backup', 'POST', { snapshot: data });
  }
  async function edgeRestore() {
    const j = await edgeApi('/account/restore', 'GET');
    return pickSnapshot(j);
  }

  /* ---------------- WorkBuddy 身份（真实 email / phone） ----------------
   * 注册那次 OTP 必须发到能收信的真实 email 或手机号；v5 用账号字符串
   * 哈希成的伪邮箱收不到验证码，是 WorkBuddy 通道一直建不了号的根因。 */
  function wbIdOf(v) {
    const s = String(v || '').trim();
    return { wbId: s, wbKind: s.indexOf('@') >= 0 ? 'email' : 'phone' };
  }
  function validWbId(wbId, wbKind) {
    if (!wbId || wbId.length > 64) return false;
    if (wbKind === 'phone') return /^1\d{10}$/.test(wbId);   // 大陆 11 位手机号
    return /.+@.+\..+/.test(wbId);                            // 简单 email 校验
  }
  function wbIdentity(wbId, wbKind) {
    return wbKind === 'phone' ? { phone: wbId } : { email: wbId };
  }

  /* 一次性 OTP：仅注册时调用。sendOtp 发码并保存 challenge；verifyOtp 校验后
   * SDK 内部完成 /v1/signup（带 password）+ 建立 WorkBuddy 会话。
   * 之后所有登录走 signInWithPassword，永不需验证码。 */
  async function otpSend(wbId, wbKind) {
    const sent = await sdk().auth.sendOtp(wbIdentity(wbId, wbKind));
    if (sent && sent.error) throw new Error(sent.error.message || '验证码发送失败');
    const data = (sent && sent.data) || {};
    ui.otp.pending = {
      wbId, wbKind,
      verificationId: data.verificationId,
      isExistingUser: !!data.isExistingUser
    };
    ui.otp.sent = true;
  }
  async function otpVerifyAndSignup(token, pwdHash) {
    const p = ui.otp.pending;
    if (!p) throw new Error('请先点击「获取验证码」');
    const args = {
      verificationId: p.verificationId,
      isExistingUser: p.isExistingUser,
      token: String(token || '').trim()
    };
    if (p.wbKind === 'phone') args.phone = p.wbId; else args.email = p.wbId;
    if (!p.isExistingUser) args.password = pwdHash;   // 哈希派生值，绝非明文
    const completed = await sdk().auth.verifyOtp(args);
    if (completed && completed.error) throw new Error(completed.error.message || '验证码校验失败');
    ui.otp.pending = null;
    ui.otp.sent = false;
    return true;   // verifyOtp 成功后 SDK 已持有 WorkBuddy 会话
  }

  /* ---------------- 主通道：WorkBuddy Cloud Service ---------------- */
  async function fetchRow() {
    const r = await sdk().database.from('user_profiles').select('owner_id,data,version,updated_at').maybeSingle();
    if (r.error) throw new Error(r.error.message || '读取云端配置失败');
    return r.data;
  }

  /* 重建 WorkBuddy 会话：纯 signInWithPassword（无验证码、无 verificationToken）。
   * 不再调用无 token 的 signUp —— 那一定失败（历史报错原文即来自它）。
   * 账号须已在注册那次 OTP 中建好；pwdHash 为注册时设定的同一派生值。 */
  async function wbEnsureSession(wbId, wbKind, pwdHash) {
    const cur = await session();
    if (cur) return cur;
    if (!wbId) throw new Error('缺少 WorkBuddy 身份（wbId）；需完成一次性验证码建号');
    const r = await sdk().auth.signInWithPassword(Object.assign(wbIdentity(wbId, wbKind), { password: pwdHash }));
    if (r && r.error) throw new Error(r.error.message || 'WorkBuddy 会话未建立');
    return await session();
  }
  async function wbSaveCred(cred) {
    await wbEnsureSession(cred.wbId, cred.wbKind, cred.pwd_hash);
    const row = await fetchRow();
    const data = Object.assign({}, snapshot(), { [CRED_KEY]: cred });
    if (row) {
      const u = await sdk().database.from('user_profiles')
        .update({ data, version: (row.version || 0) + 1, updated_at: new Date().toISOString() })
        .eq('owner_id', row.owner_id).select();
      if (u.error) throw new Error(u.error.message || 'WorkBuddy 凭据写入失败');
      if (!Array.isArray(u.data) || !u.data.length) throw new Error('WorkBuddy 凭据写入未生效（权限或网络）');
    } else {
      const i = await sdk().database.from('user_profiles')
        .insert({ data, version: 1, owner_name: cred.account }).select();
      if (i.error) throw new Error(i.error.message || 'WorkBuddy 凭据写入失败');
      if (!Array.isArray(i.data) || !i.data.length) throw new Error('WorkBuddy 凭据写入未生效（权限或网络）');
    }
  }
  async function wbLoadCred() {
    const s = await session(); if (!s) return null;
    try { const row = await fetchRow(); return (row && row.data && row.data[CRED_KEY]) || null; }
    catch (e) { return null; }
  }

  /* ---------------- 通道协作 ----------------
   * v6（2026-11-12 定案）：核实「仅 auth.signUp 强制 verificationToken，
   * auth.signInWithPassword 登录不要验证码」后，把 WorkBuddy 摆回主通道。
   *   注册：一次性 OTP 建 WorkBuddy 账号 → 凭据（PBKDF2 哈希 + wbId）主备多写；
   *   登录：取回凭据 → 本地校验哈希 → signInWithPassword 重建会话（无验证码）；
   *   写：主备并行，任一条成功即可；读：WorkBuddy 主 → CF KV 备 → 本机兜底。
   *   两条云通道失败不阻断注册（本机哈希缓存兜底，离线可登录）。 */
  async function saveCred(cred) {
    const [p, b] = await Promise.allSettled([
      withTimeout(wbSaveCred(cred), WB_TIMEOUT, 'WorkBuddy 主通道'),
      withTimeout(edgeRegister(cred), API_TIMEOUT, 'CF KV 备通道')
    ]);
    ui.primaryOk = p.status === 'fulfilled';
    ui.backupOk = b.status === 'fulfilled';
    ui.primary = (ui.primaryOk ? '✓ 已写入 user_profiles' : '✗ 失败：' + errMsg(p.reason)) + ' · ' + now();
    ui.backup = (ui.backupOk ? '✓ 已写入' : '✗ 失败：' + errMsg(b.reason)) + ' · ' + now();
    /* GitHub 备通道：开关关闭时如实显示「未启用 + 所需权限」，不发起请求、不假装可用。 */
    ui.githubOk = false;
    ui.github = GH_BACKUP.enabled
      ? '✓ 已启用 · ' + now()
      : ('未启用 · ' + GH_BACKUP.reason);
    /* 关键：云通道全挂也不能挡住注册。本机已保存 PBKDF2 哈希凭据和登录态，
     * 离线照样能登录；通道状态在卡片里如实显示。 */
    return { primary: ui.primaryOk, backup: ui.backupOk, github: ui.githubOk,
             offline: !ui.primaryOk && !ui.backupOk };
  }
  const saveCredBoth = saveCred;   // 兼容旧接口名

  async function loadCred(account) {
    let cred = null, src = '';
    const local = store.get(CRED_KEY, null);   // 本机缓存兜底（离线可用）

    // 主通道：WorkBuddy（仅当已持有会话；换设备首次登录会在 login 里重建会话）
    if (await session()) {
      try {
        const c = await withTimeout(wbLoadCred(), WB_TIMEOUT, 'WorkBuddy 主通道');
        if (c && c.account === account) { cred = c; src = 'WorkBuddy 主通道'; }
        ui.primaryOk = true;
        ui.primary = '✓ 主通道' + (src ? '已取回凭据' : '可达（无此账号）') + ' · ' + now();
      } catch (e) {
        ui.primaryOk = false;
        ui.primary = '✗ 失败：' + errMsg(e) + ' · ' + now();
      }
    } else {
      ui.primaryOk = false;
      ui.primary = '待登录后用账号+密码重建会话（无需验证码） · ' + now();
    }

    // 主通道没拿到 → 回退 CF KV 备通道
    if (!cred) {
      try {
        const c = await withTimeout(edgeLogin(account), API_TIMEOUT, 'CF KV 备通道');
        if (c && c.account === account) { cred = c; src = 'CF KV 备通道'; }
        ui.backupOk = true;
        ui.backup = (src ? '✓ 已回退 CF KV' : '✓ 可达（无此账号）') + ' · ' + now();
      } catch (e2) {
        ui.backupOk = false;
        ui.backup = '✗ 失败：' + errMsg(e2) + ' · ' + now();
      }
    }

    // GitHub 备通道：默认未启用，跳过并如实标注
    ui.githubOk = false;
    ui.github = GH_BACKUP.enabled ? (ui.github || '已启用 · ' + now()) : ('未启用 · ' + GH_BACKUP.reason);

    // 两条云端通道都没拿到 → 本机缓存兜底
    if (!cred && local && local.account === account) { cred = local; src = '本机哈希缓存'; }

    if (!cred) {
      throw new Error('未找到账号凭据：WorkBuddy 主通道与 CF KV 备通道均无法取得该账号，且本机无缓存，请先注册');
    }
    return { cred, src };
  }

  async function push() {
    const data = snapshot();
    const cred = store.get(CRED_KEY, null);
    if (cred) data[CRED_KEY] = cred;   // 设置备份里保留凭据副本（仅哈希，无明文）

    const primaryTask = (async () => {
      const row = await fetchRow();
      if (row) {
        const u = await sdk().database.from('user_profiles')
          .update({ data, version: (row.version || 0) + 1, updated_at: new Date().toISOString() })
          .eq('owner_id', row.owner_id).select();
        if (u.error) throw new Error(u.error.message || '备份失败');
        if (!Array.isArray(u.data) || !u.data.length) throw new Error('备份未生效（权限或网络）');
      } else {
        const i = await sdk().database.from('user_profiles')
          .insert({ data, version: 1 }).select();
        if (i.error) throw new Error(i.error.message || '备份失败');
        if (!Array.isArray(i.data) || !i.data.length) throw new Error('备份未生效（权限或网络）');
      }
    })();

    const [p, b] = await Promise.allSettled([
      withTimeout(primaryTask, WB_TIMEOUT, 'WorkBuddy 主通道'),
      withTimeout(edgeBackup(data), API_TIMEOUT, 'CF KV 备通道')
    ]);
    ui.primaryOk = p.status === 'fulfilled';
    ui.backupOk = b.status === 'fulfilled';
    ui.primary = (ui.primaryOk ? '✓ 已写入' : '✗ 失败：' + errMsg(p.reason)) + ' · ' + now();
    ui.backup = (ui.backupOk ? '✓ 已写入' : '✗ 失败：' + errMsg(b.reason)) + ' · ' + now();
    if (!ui.primaryOk && !ui.backupOk) {
      throw new Error('设置备份失败：WorkBuddy 主通道与 CF KV 备通道均不可用，请检查网络后重试');
    }
    ui.info = '已备份 ' + Object.keys(data).length + ' 项设置到' +
      (ui.primaryOk && ui.backupOk ? '主备两条通道' : (ui.primaryOk ? 'WorkBuddy 主通道' : 'CF KV 备通道'));
  }

  async function pull(silent) {
    let data = null, src = '';

    // 先试主通道
    try {
      const row = await withTimeout(fetchRow(), WB_TIMEOUT, 'WorkBuddy 主通道');
      if (row && row.data) { data = row.data; src = 'WorkBuddy 主通道'; }
      ui.primaryOk = true;
      ui.primary = '✓ 主通道' + (src ? '已取回备份' : '可达（暂无备份）') + ' · ' + now();
    } catch (e) {
      ui.primaryOk = false;
      ui.primary = '✗ 失败：' + errMsg(e) + ' · ' + now();
    }

    // 主通道没有可用数据 → 自动回退 CF KV 备通道
    if (!data) {
      try {
        const s = await withTimeout(edgeRestore(), API_TIMEOUT, 'CF KV 备通道');
        if (s && typeof s === 'object') { data = s; src = 'CF KV 备通道'; }
        ui.backupOk = true;
        ui.backup = (src ? '✓ 已回退 CF KV' : '✓ 备通道可达（暂无备份）') + ' · ' + now();
      } catch (e2) {
        ui.backupOk = false;
        ui.backup = '✗ 失败：' + errMsg(e2) + ' · ' + now();
      }
    }

    if (!data) {
      if (silent) return;
      throw new Error('恢复失败：WorkBuddy 主通道与 CF KV 备通道均没有可用备份，或均连接失败');
    }
    const cred = data[CRED_KEY];
    const n = restore(data);                       // restore 跳过 SKIP（含 CRED_KEY）
    if (cred) store.set(CRED_KEY, cred);           // 显式恢复哈希凭据（仅哈希，无明文）
    ui.info = '已从' + src + '恢复 ' + n + ' 项设置' + (n ? '，页面即将刷新' : '');
    if (n) setTimeout(() => location.reload(), 650);
  }

  /* ---------------- 注册 / 登录 / 退出 ---------------- */
  function readField(id) { const el = d.getElementById(id); return el ? (el.value || '') : ''; }
  function accountOf(v) {
    const a = String(v || '').trim();
    if (!a || a.length > 64) return null;
    return a;
  }

  async function signup(account, pwd, wbId, wbKind, otpToken) {
    const cred = await buildCred(account, pwd, wbId, wbKind);   // 绝不存明文
    /* 一次性 OTP：仅注册时需要，用于建立 WorkBuddy 账号与会话。
     * 失败（Provider 未启用 / 发码失败 / 验证码错）不阻断本机注册，如实记录原因。 */
    let otpNote = '';
    if (otpToken && ui.otp.pending) {
      const p = ui.otp.pending;
      cred.wbId = p.wbId; cred.wbKind = p.wbKind;   // 与发码身份一致，保证后续 signInWithPassword 命中同一账号
      try {
        await withTimeout(otpVerifyAndSignup(otpToken, cred.pwd_hash), WB_TIMEOUT, '验证码校验');
        otpNote = 'WorkBuddy 账号已通过一次性验证码建立，之后登录（含换设备）永不需验证码';
      } catch (e) {
        otpNote = 'WorkBuddy 一次性验证码未完成（' + errMsg(e) + '），主通道会话可能未建立，可稍后重试';
      }
    } else {
      otpNote = '未走一次性验证码，WorkBuddy 主通道会话未建立；本机注册不受影响';
    }
    store.set(CRED_KEY, cred);                         // 本机哈希缓存（仅哈希）
    store.set(USER_KEY, { account, at: new Date().toISOString() });  // 本机登录态立即成立
    ui.mode = 'login';
    ui.info = '注册成功，已直接登录。' + otpNote;
    /* 云通道写入全部后台执行：两条云通道失败不阻断注册，本机态已成立；
     * 完成后仅刷新同步状态卡片。 */
    (async () => {
      const sync = await saveCred(cred);               // 主备多写；全败不阻断
      ui.info = '注册成功，已直接登录。' + otpNote +
        (sync.offline ? '；云端两条通道暂不可用，凭据已安全存于本机，恢复后可重新同步' : '');
      try { renderCard(); } catch (e) {}
      try { await push(); } catch (e) {}               // 顺带备份设置（best-effort）
    })();
  }

  async function login(account, pwd) {
    /* 取凭据（主优先 / 失败回退 / 本机兜底）→ 取回哈希 → 同 salt/iter 重算 → 常数时间比较 */
    const r = await loadCred(account);
    const ok = await verifyCred(pwd, r.cred);
    if (!ok) throw new Error('账号或密码错误');
    store.set(CRED_KEY, r.cred);
    store.set(USER_KEY, { account, at: new Date().toISOString() });
    /* 用凭据里的 wbId + 哈希派生值重建 WorkBuddy 会话：纯 signInWithPassword，无验证码。
     * best-effort，失败不影响登录（登录态来自本机标记）。 */
    try {
      await withTimeout(wbEnsureSession(r.cred.wbId, r.cred.wbKind, r.cred.pwd_hash), WB_TIMEOUT, 'WorkBuddy 主通道');
      ui.primaryOk = true;
      ui.primary = '✓ 会话已重建（无需验证码） · ' + now();
    } catch (e) {
      ui.primaryOk = false;
      ui.primary = '✗ 会话未重建：' + errMsg(e) + ' · ' + now();
    }
    ui.info = '登录成功（哈希校验来源：' + r.src + '；登录无需验证码）';
    try { await pull(true); } catch (e) {}
  }

  async function signout() {
    store.del(USER_KEY);                               // 清登录态，保留哈希缓存以便离线登录
    try { await sdk().auth.signOut(); } catch (e) {}
    ui.info = '已退出';
  }

  async function submit(act) {
    const account = accountOf(readField('acctPhone'));
    const pwd = readField('acctPwd');                  // 明文密码只在局部变量中
    if (!account) throw new Error('请输入账号（或手机号）');
    if (!cryptoOK()) throw new Error(noCryptoMsg());
    if (act === 'signup') {
      const pwd2 = readField('acctPwd2');
      if (pwd.length < 8) throw new Error('密码至少 8 位');
      if (pwd2 !== pwd) throw new Error('两次输入的密码不一致');
      /* wbId 可选：填了才走一次性 OTP；不填则仅本机注册，云通道失败不阻断。 */
      const wb = wbIdOf(readField('acctWbId'));
      let wbId = '', wbKind = '';
      if (wb.wbId) {
        if (!validWbId(wb.wbId, wb.wbKind)) throw new Error('手机号 / 邮箱格式不正确（手机号 11 位，或有效邮箱）');
        wbId = wb.wbId; wbKind = wb.wbKind;
      }
      ui.wbId = wbId;
      await signup(account, pwd, wbId, wbKind, readField('acctOtp'));
      return;
    }
    if (!pwd) throw new Error('请输入密码');
    await login(account, pwd);
  }

  /* ---------------- 卡片 ---------------- */
  function syncBlock() {
    return `
      <div class="acct-sync">
        <div class="acct-sync-h">同步状态（WorkBuddy 主 / CF KV 备 / GitHub 备）</div>
        <div class="acct-sync-row ${ui.primaryOk ? 'ok' : 'bad'}"><span>WorkBuddy 主通道</span><b>${esc(ui.primary || '尚未检测')}</b></div>
        <div class="acct-sync-row ${ui.backupOk ? 'ok' : 'bad'}"><span>CF KV 备份</span><b>${esc(ui.backup || '尚未检测')}</b></div>
        <div class="acct-sync-row ${ui.githubOk ? 'ok' : 'off'}"><span>GitHub 备份</span><b>${esc(ui.github || ('未启用 · ' + GH_BACKUP.reason))}</b></div>
      </div>`;
  }

  function acctCard(user) {
    if (!user) {
      const m = ui.mode;
      return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号</div>
        <div class="acct-tabs">
          <button data-act="mode" data-v="login" class="${m === 'login' ? 'on' : ''}">登录</button>
          <button data-act="mode" data-v="signup" class="${m === 'signup' ? 'on' : ''}">注册</button>
        </div>
        <div class="acct-form">
          <input id="acctPhone" type="text" maxlength="64" autocomplete="username" placeholder="账号 / 手机号" value="${esc(ui.account || '')}">
          <input id="acctPwd" type="password" autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}" placeholder="${m === 'signup' ? '设置密码（≥8 位）' : '密码'}" value="">
          ${m === 'signup' ? `
          <input id="acctPwd2" type="password" autocomplete="new-password" placeholder="再输一次密码" value="">
          <input id="acctWbId" type="text" maxlength="64" autocomplete="off" placeholder="手机号 / 邮箱（接收一次性验证码，可选）" value="${esc(ui.wbId || '')}">
          <div class="acct-otp-row">
            <input id="acctOtp" type="text" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="验证码（仅注册需要）" value="">
            <button type="button" class="acct-otp-btn" data-act="sendotp">获取验证码</button>
          </div>
          <div class="acct-otp-hint" id="acctOtpHint">验证码仅注册时需要一次，登录不需要验证码；换设备登录也只需账号 + 密码，永不需验证码。</div>
          ` : '<div class="acct-otp-hint">登录只需账号 + 密码，无需验证码。</div>'}
          ${ui.err ? `<div class="acct-err">${esc(ui.err)}</div>` : ''}
          ${ui.info ? `<div class="acct-ok">${esc(ui.info)}</div>` : ''}
          <button class="acct-main" data-act="${m === 'signup' ? 'signup' : 'login'}">${m === 'signup' ? '创建账号' : '登录'}</button>
          <div class="acct-sub">${m === 'signup'
            ? '注册时填手机号 / 邮箱并验证一次即可建立 WorkBuddy 账号；之后登录永不需验证码。密码仅在本机以 PBKDF2 哈希保存；APP 不需要、也不会接触任何密钥。'
            : '只输账号 + 密码即可登录（登录不需要验证码）。密码仅在本机以 PBKDF2 哈希保存，APP 不需要、也不会接触任何密钥。'}</div>
        </div>
        ${syncBlock()}
      </div>`;
    }
    return `
      <div class="set-card" id="acctCard">
        <div class="set-card-h">账号</div>
        <div class="set-row"><div><b>已登录：${esc(user.account || '')}</b><span>账号 + 密码；密码仅以哈希保存，WorkBuddy / CF KV 各存一份；两条云都不可用时本机仍可登录；登录永不需验证码</span></div>
          <button class="mini-btn" data-act="out">退出</button></div>
        <div class="acct-btns">
          <button class="acct-main" data-act="synccred">同步账号凭据到两条通道</button>
          <button class="acct-main ghost" data-act="pull">恢复设置</button>
          <button class="acct-main ghost" data-act="push">备份本机设置</button>
        </div>
        ${ui.err ? `<div class="acct-err">${esc(ui.err)}</div>` : ''}
        ${ui.info ? `<div class="acct-ok">${esc(ui.info)}</div>` : ''}
        <div class="acct-sub">恢复会用云端版本覆盖本机同名配置；备份把当前 mm_* 设置写入主备两条通道。凭据始终以哈希保存，不含明文，也不含任何密钥。</div>
        ${syncBlock()}
      </div>`;
  }

  /* 不再渲染 GitHub 卡片：账号卡片不含任何密钥输入入口。 */
  function cardHTML(user) { return acctCard(user); }

  /* 重绘会重建输入框，重绘前只抓账号 / wbId（密码与验证码不回显、不写入 ui，
   * 避免明文进 DOM value）。 */
  function captureInputs() {
    const ph = d.getElementById('acctPhone'); if (ph) ui.account = ph.value || '';
    const wb = d.getElementById('acctWbId'); if (wb) ui.wbId = wb.value || '';
  }

  function renderCard(root) {
    captureInputs();
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host) return;
    paint(host);
  }
  function paint(host) {
    try { host.innerHTML = cardHTML(loggedUser()); }
    catch (e) { host.innerHTML = '<div class="set-card">账号卡片加载失败</div>'; }
  }

  function bindCard(root) {
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('click', async e => {
      if (busy) return;
      const b = e.target.closest('[data-act]');
      if (!b) return;
      ui.err = ''; ui.info = '';
      busy = true;
      try {
        const act = b.dataset.act;
        if (act === 'mode') { ui.mode = b.dataset.v; ui.otp.pending = null; renderCard(host); return; }
        /* 获取验证码：局部更新提示，不整卡重绘，避免清空用户已填的密码 / 验证码。 */
        if (act === 'sendotp') {
          const wb = wbIdOf(readField('acctWbId'));
          let msg = '';
          if (!validWbId(wb.wbId, wb.wbKind)) {
            msg = '请填写正确的手机号（11 位）或邮箱，用于接收一次性验证码';
          } else {
            ui.account = readField('acctPhone'); ui.wbId = wb.wbId;
            try {
              await withTimeout(otpSend(wb.wbId, wb.wbKind), API_TIMEOUT, '验证码通道');
              msg = '验证码已发送，请输入后点「创建账号」';
            } catch (err) {
              msg = '验证码发送失败：' + errMsg(err) + '（可先完成本机注册，启用 Provider 后重试）';
            }
          }
          const hint = host.querySelector('#acctOtpHint');
          if (hint) hint.textContent = msg;
          return;
        }
        if (act === 'login' || act === 'signup') { await submit(act); renderCard(host); return; }
        if (act === 'synccred') {
          const cred = store.get(CRED_KEY, null);
          if (!cred) throw new Error('本机没有账号凭据哈希，请重新注册或登录后重试');
          await saveCred(cred);
          ui.info = '账号凭据已重新写入两条通道（见下方同步状态）';
          renderCard(host); return;
        }
        if (act === 'pull') { await pull(); renderCard(host); return; }
        if (act === 'push') { await push(); renderCard(host); return; }
        if (act === 'out') { await signout(); renderCard(host); return; }
      } catch (err) {
        ui.err = (err && err.message) ? err.message : '操作失败，请稍后再试';
        renderCard(host);
      } finally { busy = false; }
    });
  }

  /* 兼容旧工具脚本的 GitHub 接口名：新架构的 GitHub 通道为「可配置开关 + 待启用」。
   * ghConnect 探测 Worker /account/health 的 github.enabled；未启用时如实回报。 */
  async function ghConnect() {
    try {
      const j = await withTimeout(edgeApi('/account/health', 'GET'), API_TIMEOUT, '备份通道');
      const on = !!(j && j.github && j.github.enabled);
      ui.githubOk = on;
      ui.github = on ? ('✓ 已启用 · ' + now())
                     : ('未启用 · ' + ((j && j.github && j.github.reason) || GH_BACKUP.reason));
      ui.info = on ? 'GitHub 备份通道已启用' : 'GitHub 备份通道未启用（需可写 token）';
      return on;
    } catch (e) {
      ui.githubOk = false;
      ui.github = '✗ 探测失败：' + errMsg(e) + ' · ' + now();
      ui.info = 'GitHub 备份通道探测失败，按未启用处理';
      return false;
    }
  }
  function ghDisconnect() {
    store.del('mm_gh_token'); store.del('mm_gh_gist'); store.del('mm_gh_acct_gist');
    ui.githubOk = false;
    ui.github = '未启用 · ' + GH_BACKUP.reason;
    ui.info = '本机已无 GitHub 连接（历史密钥缓存已清理）；备份通道保持待启用';
  }

  w.MPAccount = {
    cardHTML, renderCard, bindCard,
    async refresh(root) { renderCard(root); bindCard(root); },
    status: () => !!loggedUser(),
    /* 遗留接口名：返回 GitHub 备份通道开关状态（不假装已连接）。 */
    ghStatus: () => ({ connected: GH_BACKUP.enabled, enabled: GH_BACKUP.enabled, login: '', gist: '', reason: GH_BACKUP.reason }),
    /* 只读调试句柄：验证密钥 / 凭据 / 验证码不进入设置备份清单 */
    _snapshotKeys: () => Object.keys(snapshot()),
    pull, push,
    ghPull: pull, ghPush: push, ghConnect, ghDisconnect,
    saveCred, saveCredBoth, verifyCred
  };
})(window, document);
