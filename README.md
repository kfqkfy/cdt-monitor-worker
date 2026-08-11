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

### 前置条件

- Node.js 18+
- Cloudflare 账号（[注册](https://dash.cloudflare.com/signup)）
- 本机已登录 wrangler（`npx wrangler login`）

### 1. 获取代码

```bash
git clone git@github.com:kfqkfy/cdt-monitor-worker.git
cd cdt-monitor-worker
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create cdt_monitor
```

把输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cdt_monitor"
database_id = "你的-d1-database-id"   # ← 粘贴到这里
```

### 3. 初始化表结构

```bash
npx wrangler d1 execute cdt_monitor --file=./schema.sql
```

### 4. 部署

```bash
npx wrangler deploy
```

部署成功后你会看到 `https://cdt-monitor.你的子域.workers.dev`。

### 5. 初始化系统

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
