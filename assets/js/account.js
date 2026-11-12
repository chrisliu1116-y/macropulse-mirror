/* ============================================================
 * account.js — 本地设置备份 / 还原（v296：账号与云端同步功能已整体删除）
 *
 * 用户决策（2026-11-13 00:24）：WorkBuddy 云账号注册/登录链路反复失败，
 * 直接删除账号功能，不保留任何登录、注册、云端同步、凭据代码。
 * 只保留「把本机设置导出成 JSON 文件 / 从文件还原」，并明确告知保存位置。
 * ============================================================ */
(function (w, d) {
  'use strict';

  const BACKUP_APP = 'MACRO-PULSE';
  const BACKUP_SCHEMA = 'macropulse-settings';
  const BACKUP_VERSION = 1;
  const SKIP = {
    mm_account_cred: 1, mm_acct_user: 1, mm_acct_otp: 1,
    mm_gh_token: 1, mm_gh_gist: 1, mm_gh_acct_gist: 1,
    mm_ev_stage_v1: 1
  };
  const SENSITIVE = /(token|cred|otp|secret|passwd|password|pwd|hash|salt|auth|session|private|cipher|bearer|apikey|api_key)/i;
  function backupable(k) {
    return /^mm_/.test(k) && !SKIP[k] && !SENSITIVE.test(k);
  }
  function backupDate() {
    const t = new Date(), p = n => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }
  function backupSnapshot() {
    const data = {};
    Object.keys(localStorage).forEach(k => {
      if (!backupable(k)) return;
      try { const v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {}
    });
    return data;
  }
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('文件读取失败'));
      fr.readAsText(file, 'utf-8');
    });
  }

  const ui = { err: '', info: '', path: '' };
  let busy = false;
  const $ = (s, r) => (r || d).querySelector(s);

  function localBackup() {
    const data = backupSnapshot();
    const payload = {
      app: BACKUP_APP, schema: BACKUP_SCHEMA, version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      count: Object.keys(data).length, data: data
    };
    const text = JSON.stringify(payload, null, 2);
    const fileName = 'macropulse-backup-' + backupDate() + '.json';
    try {
      const np = w.NativePulse;
      if (np && typeof np.saveBackup === 'function') {
        const path = np.saveBackup(fileName, text);
        if (path) return { count: payload.count, fileName: fileName, path: path, native: true };
        /* 有桥但返回空 = 原生侧写入失败，明确报错（不回落到 blob 假下载） */
        return { count: payload.count, fileName: fileName, failed: true };
      }
    } catch (e) { return { count: payload.count, fileName: fileName, failed: true }; }
    const u = w.URL || w.webkitURL;
    const blob = new Blob([text], { type: 'application/json' });
    const url = u.createObjectURL(blob);
    const a = d.createElement('a');
    a.href = url; a.download = fileName;
    d.body.appendChild(a); a.click(); d.body.removeChild(a);
    setTimeout(() => { try { u.revokeObjectURL(url); } catch (e) {} }, 1000);
    return { count: payload.count, fileName: fileName };
  }

  function latestLocalBackup() {
    try {
      const np = w.NativePulse;
      if (!np || typeof np.latestBackup !== 'function') return null;
      const raw = np.latestBackup();
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || !j.ok || !j.data) return null;
      return { path: j.path || j.name || '最新备份', data: j.data };
    } catch (e) { return null; }
  }

  function applyLocalRestore(text) {
    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { throw new Error('文件不是有效 JSON（已损坏）'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('文件结构不正确');
    if (payload.app !== BACKUP_APP || payload.schema !== BACKUP_SCHEMA) {
      throw new Error('不是本应用导出的备份文件（app / schema 不匹配）');
    }
    if (payload.version !== BACKUP_VERSION) {
      throw new Error('备份文件版本不兼容（需要 v' + BACKUP_VERSION + '，实际 v' + String(payload.version) + '）');
    }
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份文件缺少 data 数据体');
    let n = 0, skipped = 0;
    Object.keys(data).forEach(k => {
      if (!backupable(k) || typeof data[k] !== 'string') { skipped++; return; }
      try { localStorage.setItem(k, data[k]); n++; } catch (e) { skipped++; }
    });
    ui.info = '还原完成：成功 ' + n + ' 项 / 跳过 ' + skipped + ' 项，正在自动刷新…';
    /* v298【还原后自动刷新】此前只写「刷新后生效」，用户不手动清缓存/重进就看不到
     * 还原回来的自选与设置。现在写完 localStorage 直接重载页面，
     * 让 boot() 重新读设置、自选、监控池，全部立刻可见。 */
    setTimeout(function () {
      try { w.location.reload(); } catch (e) {}
    }, 700);
    return { n, skipped };
  }

  function paint(host) {
    host.innerHTML = `
      <div class="set-card">
        <div class="set-card-h">本地备份</div>
        <div class="set-row"><div><b>备份到本地文件</b>${ui.path ? `<span>${ui.path}</span>` : ''}</div>
          <button class="mini-btn" data-act="localbackup">备份</button></div>
        <div class="set-row"><div><b>从本地文件还原</b></div>
          <button class="mini-btn" data-act="localrestore">还原</button></div>
        ${ui.info ? `<div class="set-row col"><div><span>${ui.info}</span></div></div>` : ''}
        ${ui.err ? `<div class="set-row col"><div><span style="color:#ff6b6b">${ui.err}</span></div></div>` : ''}
        <!-- v298：去掉 accept（部分 Android WebView 对 accept 会吞掉第一次文件选择），
             用定位隐藏替代 hidden 属性，保证 input.click() 稳定拉起系统选择器 -->
        <input type="file" id="acctRestoreFile" style="position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0">
      </div>`;
  }

  function refresh(root) {
    const host = (root && root.nodeType === 1) ? root : d.getElementById('acctHost');
    if (!host) return;
    paint(host);
  }

  d.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('[data-act]');
    if (!btn || !t.closest('#acctHost')) return;
    const act = btn.dataset.act;
    ui.err = ''; ui.info = '';
    try {
      if (act === 'localbackup') {
        const r = localBackup();
        /* v296【不许谎报成功】APP 内有原生桥但写入返回空（权限/系统限制）时，
         * 明确报失败并给替代路径，不再说「已保存到下载目录」让用户找不到文件。 */
        if (r.failed) {
          ui.err = '保存失败：系统未写入文件（存储权限被限制或目录不可写）。请到 系统设置→应用→MACRO PULSE→权限 允许「文件和媒体」，再重试。';
          refresh(btn.closest('#acctHost'));
          return;
        }
        if (r.native) {
          /* v298：只留「位置」一行（用户：下面那条重复的已导出提示不要） */
          ui.path = '位置：' + String(r.path || '').replace(/^Download\//, '手机存储/Download/');
          ui.info = '';
        } else {
          ui.path = '';
          ui.info = '已导出 ' + r.count + ' 项到浏览器下载目录（文件名 ' + r.fileName + '）';
        }
        refresh(btn.closest('#acctHost'));
        return;
      }
      if (act === 'localrestore') {
        const latest = latestLocalBackup();
        if (latest) {
          if (!w.confirm('从「' + latest.path + '」还原设置？现有设置会被覆盖。')) return;
          applyLocalRestore(latest.data);
          refresh(btn.closest('#acctHost'));
          return;
        }
        const input = $('#acctRestoreFile', btn.closest('#acctHost'));
        if (input) input.click();
        return;
      }
    } catch (err) {
      ui.err = (err && err.message) ? err.message : '操作失败';
      refresh(btn.closest('#acctHost'));
    }
  });

  d.addEventListener('change', async (e) => {
    const input = e.target;
    if (!input || input.id !== 'acctRestoreFile') return;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || busy) return;
    busy = true;
    ui.err = ''; ui.info = '';
    try {
      const text = await readFileText(file);
      applyLocalRestore(text);
    } catch (err) {
      ui.err = '还原失败：' + ((err && err.message) || '文件读取失败') + '（现有设置未被改动）';
    } finally {
      busy = false;
      refresh($('#acctHost'));
    }
  });

  w.MPAccount = {
    refresh: refresh,
    autoSync: function () {},
    localBackup: localBackup,
    applyLocalRestore: applyLocalRestore
  };
})(window, document);
