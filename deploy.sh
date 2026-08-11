#!/usr/bin/env bash
# ============================================================
# CDT-Monitor Worker 一键部署脚本
# 用法: ./deploy.sh   （首次运行会自动打开浏览器登录 Cloudflare）
#
# 自动完成: 登录检查 → 创建 D1 数据库 → 初始化表结构 → 部署 Worker
# 重复运行安全：已创建的资源会复用，不会重复创建
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info()  { echo -e "${GREEN}✔${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✘${NC} $1"; exit 1; }

DB_NAME="cdt_monitor"
TOML="wrangler.toml"

# ---------- 1. 登录检查 ----------
echo -e "${BOLD}[1/4] 检查 Cloudflare 登录状态...${NC}"
if ! npx wrangler whoami >/dev/null 2>&1; then
  warn "未登录，正在打开浏览器授权（如无浏览器请用 API Token: export CLOUDFLARE_API_TOKEN=xxx）"
  npx wrangler login
fi
npx wrangler whoami 2>&1 | grep -q "You are not authenticated" && err "登录失败，请重试"
info "已登录 Cloudflare"

# ---------- 2. 创建/复用 D1 数据库 ----------
echo -e "${BOLD}[2/4] 检查 D1 数据库...${NC}"
if grep -q 'REPLACE_WITH_D1_DATABASE_ID' "$TOML"; then
  # 尝试创建新库
  if create_out=$(npx wrangler d1 create "$DB_NAME" --json 2>/dev/null); then
    DB_ID=$(echo "$create_out" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['database_id'])")
    info "D1 数据库 [$DB_NAME] 创建成功"
  else
    # 已存在则从列表复用
    if list_out=$(npx wrangler d1 list --json 2>/dev/null); then
      DB_ID=$(echo "$list_out" | python3 -c "
import sys,json
for d in json.load(sys.stdin):
    if d['name']=='$DB_NAME': print(d['uuid']); break")
      [ -n "$DB_ID" ] && info "D1 数据库 [$DB_NAME] 已存在，复用"
    fi
  fi
  [ -z "${DB_ID:-}" ] && err "无法获取 D1 数据库 ID，请手动运行: npx wrangler d1 create $DB_NAME"
  # 写回配置
  sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/" "$TOML"
  info "database_id 已写入 wrangler.toml"
else
  info "D1 数据库 ID 已配置，跳过创建"
fi

# ---------- 3. 初始化表结构 ----------
echo -e "${BOLD}[3/4] 初始化数据库表结构...${NC}"
npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql >/dev/null 2>&1 || npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql
info "表结构初始化完成"

# ---------- 4. 部署 ----------
echo -e "${BOLD}[4/4] 部署 Worker...${NC}"
npx wrangler deploy

echo
echo -e "${GREEN}==============================================${NC}"
echo -e "${GREEN} ✅ 部署完成！${NC}"
echo -e "${GREEN}==============================================${NC}"
echo "  面板地址: 见上方 deploy 输出的 https://cdt-monitor.*.workers.dev"
echo "  首次访问会自动进入初始化向导（设置管理员密码 + 添加阿里云账号）"
echo
