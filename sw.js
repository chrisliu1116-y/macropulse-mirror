/* ============================================================
 * sw.js — Service Worker
 * 让「异动看板」可以添加到手机主屏幕当 App 用，并在弱网/断网时秒开。
 *
 * 缓存策略在 v25 做了根本性调整：**网络优先，缓存只做兜底**。
 * 原因（真实事故）：以前是 cache-first，APK 升级后 WebView 里
 * 仍然是上一版 index.html（版本戳一直停在 v18），用户完全没法
 * 判断自己装的是不是新包，网页更新也传不进去。
 * 现在：先请求网络（最多等 2.5 秒），拿到就顺手更新缓存；
 * 网络慢/断网才回退缓存 —— 既保证「打开就是最新版」，又不丢秒开。
 * ============================================================ */
const CACHE = 'macro-pulse-v308';
const NET_TIMEOUT = 1200;

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/css/app.css',
  './assets/js/cn-stocks.js',
  './assets/js/universe.js',
  './assets/js/session.js',
  './assets/js/topics.js',
  './assets/js/news-zh.js',
  './assets/js/pool.js',
  './assets/js/news-live-client.js',
  './assets/js/api.js',
  './assets/js/alert.js',
  './assets/js/indicator.js',
  './assets/js/drawing.js',
  './assets/js/charts.js',
  './assets/js/anomaly.js',
  './assets/js/news-spike.js',
  './assets/js/volprofile.js',
  './assets/js/verify.js',
  './assets/js/events.js',
  './assets/js/app.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 缓存查找统一忽略 ?v= 指纹。
 * 关键事故：CORE 预缓存的是「无 ?v」的路径（./assets/js/app.js），
 * 而页面请求的是「带 ?v」的（assets/js/app.js?v=106）。caches.match 精确匹配
 * 永远 miss → 每个资源都走网络。20 个同步脚本（含 505KB 的 cn-stocks.js）
 * 在弱网下排队等网络，累积成「下拉后全屏空白 10 秒」。
 * ignoreSearch 让带 ?v 的请求命中预缓存；发版后 CACHE 名变化 + activate
 * 清旧缓存，保证不会读到上一版内容。 */
function matchCache(req) {
  return caches.match(req, { ignoreSearch: true });
}

/* 文档（index.html）网络优先，最多等 NET_TIMEOUT：保证「打开就是最新版」。
 * 超时/失败才回退缓存 —— 网络请求不取消，跑完仍写缓存，下次就新了。 */
function netFirst(req) {
  const cached = matchCache(req).then(hit => hit || caches.match('./index.html'));
  const net = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') {
      const cp = res.clone();
      caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
    }
    return res;
  });

  return Promise.race([
    net.catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT))
  ]).then(res => {
    if (res) return res;
    return cached.then(hit => hit || net.catch(() => new Response('', { status: 504 })));
  });
}

/* 资源（js/css/图标）stale-while-revalidate：有缓存立即返回（0 延迟），
 * 后台静默拉网络并更新缓存。这样整页重载不再逐个资源等网络。 */
function staleWhileRevalidate(req) {
  const cached = matchCache(req);
  const net = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') {
      const cp = res.clone();
      caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
    }
    return res;
  }).catch(() => null);
  return cached.then(hit => hit || net.then(res => res || new Response('', { status: 504 })));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 外部 API 与行情源一律直连，不缓存
  if (url.origin !== location.origin) return;
  /* 【备用源兼容】主站在域名根，GitHub Pages 备用源挂在项目子路径
   * （/macropulse-mirror/…）。原来一律按绝对路径判断会全部失配：
   * 404 被当静态资源缓存、/breadth/data/ 被 stale 缓存顶一天。
   * 改成相对 SW scope 判断，根部署与子路径部署都成立。 */
  let BASE = '/';
  try { BASE = new URL(self.registration.scope).pathname; } catch (e) {}
  const p = url.pathname.indexOf(BASE) === 0
    ? url.pathname.slice(BASE.length) : url.pathname.replace(/^\//, '');
  // 接口不缓存
  if (p.indexOf('api/') === 0) return;
  /* 原生同源代理必须绕过 SW！
   * APK 壳在 WebViewClient.shouldInterceptRequest 里拦 /__fetch，
   * 但 Service Worker 自己发出的 fetch 不走 WebViewClient ——
   * 一旦 SW 接管这个路径，请求会直接打到真实服务器，拿回 404，
   * 网页侧就以为「原生通道坏了」，好端端的代理被 SW 亲手废掉。
   * （财联社这类源看起来正常，是因为它们的请求从主线程发起，没被 SW 吃。） */
  if (p.indexOf('__fetch') === 0) return;
  /* 同源转发代理 /__proxy 必须绕过 SW！
   * 【真实事故】matchCache 用了 ignoreSearch:true（为了命中带 ?v= 的静态资源），
   * 于是 /__proxy?u=<财联社> 和 /__proxy?u=<格隆汇> 被当成同一个缓存键 ——
   * 第二个源直接拿到第一个源的响应。表现就是：格隆汇解析器读到财联社 JSON、
   * 抛「无有效条目」，源时通时断，标红忽有忽无。
   * 代理响应一律不进缓存，交给网络。 */
  if (p.indexOf('__proxy') === 0) return;
  /* 市场宽度页（/breadth/）：数据 JSON 每天收盘后重写，必须每次直连网络，
   * 不能被 staleWhileRevalidate 用旧缓存顶一天。 */
  if (p.indexOf('breadth/data/') === 0) return;
  /* 上证同期对比子页（/sse/）：数据 JSON 同样每天更新，必须直连网络。 */
  if (p.indexOf('sse/data/') === 0) return;
  /* v265【用户实测「链接没变化」的根因】matchCache 用 ignoreSearch:true，
   * /sse/assets/app.js?v=3 / ?v=4 / ?v=5 会被当成同一个缓存键，
   * staleWhileRevalidate 一直回吐旧脚本，升版本号也换不掉。
   * /sse/ 整条子页（含 index / assets / data）一律绕过 SW 直连网络。 */
  if (p.indexOf('sse/') === 0) return;
  // sw.js 自身交给浏览器更新机制，别被自己的缓存锁住
  if (p === 'sw.js' || /\/sw\.js$/.test(p)) return;

  /* 文档导航走网络优先（拿新版），其余静态资源走 stale（秒开） */
  const isDoc = req.mode === 'navigate'
    || url.pathname === '/' || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html');
  e.respondWith(isDoc ? netFirst(req) : staleWhileRevalidate(req));
});
