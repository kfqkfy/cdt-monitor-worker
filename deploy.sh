#!/usr/bin/env bash
# ============================================================
# CDT-Monitor Worker 一键部署脚本
# 用法: ./deploy.sh   （首次运行会自动打开浏览器登录 Cloudflare）
#
# 自动完成: 登录检查 → 部署 Worker（D1 数据库由 wrangler 自动创建/复用）→ 初始化表结构
# 重复运行安全：数据库已存在会自动复用，表结构 CREATE IF NOT EXISTS 幂等
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info()  { echo -e "${GREEN}✔${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✘${NC} $1"; exit 1; }

DB_NAME="cdt_monitor"

# ---------- 1. 登录检查 ----------
echo -e "${BOLD}[1/3] 检查 Cloudflare 登录状态...${NC}"
if ! npx wrangler whoami >/dev/null 2>&1; then
  warn "未登录，正在打开浏览器授权（如无浏览器请用 API Token: export CLOUDFLARE_API_TOKEN=xxx）"
  npx wrangler login
fi
npx wrangler whoami 2>&1 | grep -q "You are not authenticated" && err "登录失败，请重试"
info "已登录 Cloudflare"

# ---------- 2. 部署（D1 自动创建/复用） ----------
echo -e "${BOLD}[2/3] 部署 Worker（D1 数据库自动 provisioning）...${NC}"
npx wrangler deploy
info "部署完成"

# ---------- 3. 初始化表结构 ----------
echo -e "${BOLD}[3/3] 初始化数据库表结构...${NC}"
npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql >/dev/null
info "表结构初始化完成"

echo
echo -e "${GREEN}==============================================${NC}"
echo -e "${GREEN} ✅ 部署完成！${NC}"
echo -e "${GREEN}==============================================${NC}"
echo "  面板地址: 见上方 deploy 输出的 https://cdt-monitor.*.workers.dev"
echo "  首次访问会自动进入初始化向导（设置管理员密码 + 添加阿里云账号）"
echo
