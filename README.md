# CDT-Monitor Worker ☁️

> [wang4386/CDT-Monitor](https://github.com/wang4386/CDT-Monitor) 的 **Cloudflare Workers 移植版**
> 阿里云 CDT 流量监控与自动化熔断工具，完整保留原版全部功能，零服务器成本部署。

## 功能（与原版 100% 对齐）

- ✅ **多账号聚合监控** — 统一面板管理多个阿里云账号 CDT 流量与 ECS 实例状态
- ✅ **流量熔断** — 阈值自定义（默认 95%），超限自动停机（普通/节省停机）或仅告警
- ✅ **实例保活** — 抢占式实例在工作时段意外关机自动拉起
- ✅ **定时任务** — 每日定时开关机计划（Asia/Shanghai 时区）
- ✅ **通知推送** — SMTP 邮件 / Telegram / Webhook，支持测试发送
- ✅ **费用分析** — 余额 + 实例当月账单（BSS API，带 6 小时缓存）
- ✅ **历史图表** — 近 24 小时曲线 + 近 30 天柱状图（ECharts）
- ✅ **系统日志** — 动作日志 / 心跳日志双 Tab，自动清理
- ✅ **登录保护** — HMAC 签名会话 Cookie + IP 失败锁定（15 分钟 5 次）
- ✅ **前端面板** — 原版 Vue + Tailwind 面板，未改动一行 UI 逻辑

## 架构对比

| | 原版 (PHP) | 本版 (Workers) |
|---|---|---|
| 运行环境 | PHP 8 + Nginx + Composer | **Cloudflare Workers（免费额度）** |
| 存储 | SQLite 文件 | **D1 数据库** |
| 定时任务 | Crontab 每分钟 | **Workers Cron Triggers 每分钟** |
| 阿里云 API | alibabacloud SDK | 原生 fetch + HMAC-SHA1 签名（WebCrypto） |
| SMTP | PHPMailer | Workers Socket API 实现（SSL/STARTTLS） |
| 费用 | VPS 月租 | **免费**（10 万请求/天） |

## 部署

### 🚀 方式一：Workers Builds（Git 集成，push 即自动部署）

连接你**已有的** GitHub 仓库，代码 push 后 Cloudflare 自动重新部署。

1. **创建 D1 数据库**（一次）
   - Dashboard → Workers & Pages → **D1** → **Create database** → 名字 `cdt_monitor`
2. **连接仓库**
   - Workers & Pages → **Create** → **Workers** → **Deploy with Git**
   - 授权 GitHub → 选择 `kfqkfy/cdt-monitor-worker` → 分支 `main`
   - 构建/部署命令保持默认（`npm run deploy` 与 `npx wrangler deploy` 等价）
3. **⚠️ 关键：绑定 D1（必须做，否则部署报 10021）**
   - 项目 → **Settings** → **Bindings** → **Add binding**
   - Type: `D1 database`，Variable name: **`DB`**（必须精确），Database: `cdt_monitor`
4. **添加 Cron 触发器**
   - **Settings** → **Triggers** → **Cron Triggers** → `* * * * *`
5. **初始化表结构**
   - 项目 → **Console** 运行（或本地执行）：
   ```bash
   npx wrangler d1 execute cdt_monitor --remote --file=./schema.sql
   ```
6. **完成** — 以后每次 `git push` 到 main 自动重新部署

> ⚠️ 常见错误 `binding DB of type d1 must have a valid database_id [code: 10021]`：
> 仓库 `wrangler.toml` 中的 `database_id` 是占位符，必须按第 3 步在 Dashboard 添加 D1 Binding 覆盖它，然后 Retry deployment。

### 🚀 方式二：一键脚本（自动创建 D1 + 建表 + 部署）

只需 Node.js 18+，一条命令：

```bash
git clone git@github.com:kfqkfy/cdt-monitor-worker.git
cd cdt-monitor-worker
./deploy.sh
```

脚本自动完成：登录检查（首次会打开浏览器授权）→ 创建 D1 数据库 → 写入 `wrangler.toml` → 初始化表结构 → 部署。**重复运行安全**，已创建的资源自动复用。

### 方式三：Deploy Button（一次性部署，仅适合尝鲜）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kfqkfy/cdt-monitor-worker)

点击按钮 → 授权 → 按引导创建资源并部署。⚠️ 每次部署独立，**代码更新不会自动重新部署**，且需要手动处理 D1 绑定，长期使用请用方式一或方式二。

```bash
git clone git@github.com:kfqkfy/cdt-monitor-worker.git
cd cdt-monitor-worker
npm install
npx wrangler d1 create cdt_monitor        # 把输出的 database_id 填入 wrangler.toml
npx wrangler d1 execute cdt_monitor --remote --file=./schema.sql
npx wrangler deploy
```

部署成功后你会看到 `https://cdt-monitor.你的子域.workers.dev`。

### 初始化系统

浏览器打开上面的 URL → 首次访问进入初始化向导 → 设置管理员密码 → 添加阿里云账号（AccessKey/Secret、区域、实例 ID、流量上限、定时计划）→ 保存。

## 本地开发

```bash
npx wrangler d1 execute cdt_monitor --local --file=./schema.sql   # 初始化本地 D1
npx wrangler dev --local                                          # 本地启动 :8787
curl "http://localhost:8787/cdn-cgi/local/scheduled" -X POST      # 手动触发定时任务
```

## 阿里云权限要求

监控账号的 AccessKey 需要以下权限：

- `AliyunCDTReadOnlyAccess` — CDT 流量查询
- `AliyunECSReadOnlyAccess` — 实例状态查询
- `AliyunECSFullAccess`（自动停机/开机需要）— 实例控制
- BSS 只读权限（费用分析需要，可选）— 余额/账单查询

> ⚠️ 安全建议：使用 RAM 子账号并授予最小权限，不要把主账号 AccessKey 填入。

## 注意事项

- 定时任务按 **Asia/Shanghai** 时区执行（与原版 Docker 一致）
- 通知渠道 SMTP 依赖 Workers 的 Socket API，免费计划可用
- Telegram 支持自定义 API 代理地址（`proxy_type=custom`）
- 数据存在 Cloudflare D1（免费 5GB），账号密钥以明文存储于 D1（与原版 SQLite 一致），请勿公开面板地址

## License

MIT
