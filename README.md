# 宏观脉冲 H5 · 备用源

主站：https://macro-pulse.app.workbuddy.host/?sharecode=OLR2DCILRE
备用：https://chrisliu1116-y.github.io/macropulse-mirror/

本仓库是主站 `dist/` 的**静态镜像**，GitHub Pages 托管在 `main` 分支根目录。
主站（WorkBuddy）若下架或域名失效，把 App 启动地址改成上面的备用地址即可继续用。

- 纯静态、相对路径资源，挂在项目子路径下也能跑；`.nojekyll` 防止 Jekyll 改写。
- 无后端：`/api/news`、`/__proxy`、`/__fetch` 在备用源上不存在，
  页面已按域名自动跳过这些通道，改走浏览器直连 / 第三方中转（功能略有差异）。
- 市场宽度页 `/breadth/` 从 `insum-cloud` 仓库的 raw JSON 取数，与主站一致。
- 全站资源都是相对路径，Service Worker 按 `registration.scope` 判断路径，
  根部署与子路径部署行为一致。

同步方式：`python ../2026-11-03-23-29-44/tools/sync_mirror.py` （发版时执行）。
