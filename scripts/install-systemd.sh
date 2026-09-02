#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="schema-atlas"
RUN_USER="${SCHEMA_ATLAS_USER:-claude}"
APP_DIR="$(realpath "${1:-$PWD}")"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/schema-atlas.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo bash scripts/install-systemd.sh 执行"
  exit 1
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "Linux 用户 $RUN_USER 不存在"
  exit 1
fi
if [ ! -f "$APP_DIR/local-ai/supervisor.mjs" ] || [ ! -d "$APP_DIR/dist" ]; then
  echo "当前目录不是已完成构建的 Schema Atlas，请先执行 npm ci 和 npm run build"
  exit 1
fi

RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
RUN_GROUP="$(id -gn "$RUN_USER")"
NODE_BIN="$(runuser -u "$RUN_USER" -- bash -lc 'command -v node' 2>/dev/null || true)"
CLAUDE_BIN="$(runuser -u "$RUN_USER" -- bash -lc 'command -v claude' 2>/dev/null || true)"

if [ -z "$NODE_BIN" ] && [ -d "$RUN_HOME/.nvm/versions/node" ]; then
  NODE_BIN="$(find "$RUN_HOME/.nvm/versions/node" -type f -path '*/bin/node' -perm -u+x | sort -V | tail -n 1)"
fi
if [ -z "$CLAUDE_BIN" ] && [ -n "$NODE_BIN" ]; then
  NODE_DIRECTORY="$(dirname "$NODE_BIN")"
  if [ -x "$NODE_DIRECTORY/claude" ]; then CLAUDE_BIN="$NODE_DIRECTORY/claude"; fi
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "未在 $RUN_USER 用户环境中找到 Node.js"
  exit 1
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "未在 $RUN_USER 用户环境中找到 Claude Code，请先以该用户完成安装和登录"
  exit 1
fi

install -d -o "$RUN_USER" -g "$RUN_GROUP" "$APP_DIR/.schema-atlas-ai"

if [ ! -f "$ENV_FILE" ]; then
  {
    echo "SCHEMA_ATLAS_HOST=0.0.0.0"
    echo "SCHEMA_ATLAS_PORT=3000"
    echo "SCHEMA_ATLAS_REFERENCE_ROOTS=${APP_DIR}:$RUN_HOME"
  } > "$ENV_FILE"
fi

AUTH_CREATED="false"
if ! grep -q '^SCHEMA_ATLAS_AUTH_USER=' "$ENV_FILE"; then
  echo "SCHEMA_ATLAS_AUTH_USER=claude" >> "$ENV_FILE"
fi
if ! grep -q '^SCHEMA_ATLAS_AUTH_PASSWORD=' "$ENV_FILE"; then
  AUTH_PASSWORD="$($NODE_BIN -e "process.stdout.write(require('node:crypto').randomBytes(18).toString('base64url'))")"
  echo "SCHEMA_ATLAS_AUTH_PASSWORD=$AUTH_PASSWORD" >> "$ENV_FILE"
  AUTH_CREATED="true"
fi
chmod 0600 "$ENV_FILE"

NODE_DIRECTORY="$(dirname "$NODE_BIN")"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Schema Atlas with local Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOME=$RUN_HOME
Environment=USER=$RUN_USER
Environment=PATH=$NODE_DIRECTORY:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CLAUDE_BIN=$CLAUDE_BIN
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/local-ai/supervisor.mjs
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"

echo
echo "安装完成，访问 http://服务器IP:3000"
echo "网页登录用户：$(sed -n 's/^SCHEMA_ATLAS_AUTH_USER=//p' "$ENV_FILE" | tail -n 1)"
if [ "$AUTH_CREATED" = "true" ]; then
  echo "网页初始密码：$AUTH_PASSWORD"
else
  echo "网页密码保存在 $ENV_FILE（权限为 600）"
fi
echo "日志命令：journalctl -u $SERVICE_NAME -f"
