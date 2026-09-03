# Schema Atlas 本地部署（不使用 Docker）

本版本包含网页服务和本地 Claude Code 桥接服务。推荐使用 systemd 托管，关闭 SSH 后仍会运行，并在系统重启后自动启动。

## 1. 检查 `claude` 用户环境

服务固定使用非 root 用户 `claude`。先切换到该用户，确认 Node.js 22.13 以上，并完成 Claude Code 登录：

```bash
sudo -iu claude
node --version
claude --version
claude auth status
claude -p "只回复 OK"
exit
```

最后一条命令成功返回后，网页发起的任务才能复用同一用户的登录状态。不要把 root 用户下的 `~/.nvm` 或 `~/.claude` 直接复制给 `claude`。

## 2. 安装并构建

进入源码目录：

```bash
cd /你的源码目录/schema-atlas
npm ci --no-audit --no-fund
npm run build
```

运行环境自检：

```bash
sudo -iu claude
cd /你的源码目录/schema-atlas
npm run ai:doctor
exit
```

如果 Node.js 通过 NVM 安装，上面的 `npm` 可能不在非交互式 PATH 中。这不影响安装脚本：它会从 `claude` 用户的 NVM 目录寻找最新可执行版本。

## 3. 一条命令安装后台服务

在源码根目录执行：

```bash
sudo bash scripts/install-systemd.sh
```

安装脚本会：

- 用 `claude` 用户运行服务，拒绝 root 运行；
- 自动确定 Node.js 与 `claude` 的绝对路径；
- 同时启动网页和 Claude Code 桥接层；
- 只对外开放一个网页端口 `3000`；
- 自动生成网页登录密码，保护高权限 Claude Code 接口；
- 保存导入表数据集、关系索引、Session、对话、草稿和 TODO 到 `.schema-atlas-ai/`；
- 默认允许 Claude Code读取源码目录和 `/home/claude`。

访问：

```text
http://服务器IP:3000
```

浏览器会弹出登录框。用户名和首次生成的随机密码会由安装命令直接打印；密码也保存在仅 root 可读的 `/etc/schema-atlas.env`。

常用管理命令：

```bash
systemctl status schema-atlas
journalctl -u schema-atlas -f
systemctl restart schema-atlas
systemctl stop schema-atlas
```

## 4. 配置可读取的参考资料目录

编辑：

```bash
sudo vi /etc/schema-atlas.env
```

多个允许根目录用冒号分隔：

```ini
SCHEMA_ATLAS_HOST=0.0.0.0
SCHEMA_ATLAS_PORT=3000
SCHEMA_ATLAS_AUTH_USER=claude
SCHEMA_ATLAS_AUTH_PASSWORD=请换成强随机密码
SCHEMA_ATLAS_REFERENCE_ROOTS=/home/claude/repos:/home/claude/annotations:/data/domain-docs
```

如果 Claude Code 访问外网也必须经过公司代理，把代理写在同一文件中，systemd 才能继承：

```ini
HTTP_PROXY=http://代理主机:8080
HTTPS_PROXY=http://代理主机:8080
NO_PROXY=127.0.0.1,localhost
NODE_EXTRA_CA_CERTS=/etc/pki/trust/anchors/company-root-ca.crt
```

优先配置公司根证书，不要长期关闭 TLS 校验。网页登录采用 HTTP Basic Auth；若端口会经过不可信网络，请在前面配置 HTTPS 反向代理，或只监听 `127.0.0.1` 并使用 SSH 隧道。

随后重启：

```bash
sudo systemctl restart schema-atlas
```

界面中填写的代码仓库、标注 JSON 或文档路径必须位于这些根目录内，同时 `claude` 用户需要读取权限。例如：

```bash
sudo setfacl -R -m u:claude:rX /data/domain-docs
```

### 配置生成提示词

安装后在页面打开“AI 标注 → 提示词”，可查看和修改发送给 Claude Code 的完整模板。修改自动保存在当前浏览器，下一轮单表、批量或 TODO 续写任务立即使用；“恢复默认”会重新载入仓库中的 `config/default-annotation-prompt.txt`。

默认模板要求 Claude Code 先检查当前表、后台关系索引、已导入的直接关联表、相关同域表、现有草稿和配置的参考资料，再生成详细的中英文业务语义、类别名、字段别名和可核验的结构化枚举。除布尔开关及未启用的枚举外，生成 JSON 的普通信息均为必填，不能用空字符串或空别名数组占位。只有检索后仍没有明确依据或资料互相冲突时，才会创建待澄清项，并在界面列出已检索来源。

“AI 标注”会打开独立的全屏标注台。顶部“待审核”和“待澄清”分别管理两类人工工作；“Sessions”可以查看 Claude Code 的完整对话、工具调用与返回结果，并支持全选清理。批量生成页可停止单个任务，也可一次停止全部正在执行或排队的任务。

## 5. 不安装 systemd 的临时运行方式

用 `claude` 用户执行：

```bash
npm run start:local
```

未配置网页登录凭据时，临时方式只监听 `127.0.0.1`。从另一台电脑访问可建立 SSH 隧道：

```bash
ssh -L 3000:127.0.0.1:3000 用户名@服务器IP
```

然后打开 `http://127.0.0.1:3000`。

需要关闭 SSH 后继续运行时：

```bash
nohup npm run start:local > schema-atlas.log 2>&1 < /dev/null &
echo $! > schema-atlas.pid
```

## 6. 更新版本

更新源码后执行：

```bash
npm ci --no-audit --no-fund
npm run build
sudo systemctl restart schema-atlas
```

`.schema-atlas-ai/` 不会被 Git 或构建覆盖，其中包含落盘数据集、关系索引、Claude Code Session 和完整对话记录。界面“AI 标注 → 资料”显示“已落盘”后，才表示当前浏览器中的全部表已成功同步到本地服务。

## 7. 常见问题

### 界面显示“本地 AI 服务不可用”

```bash
systemctl status schema-atlas
journalctl -u schema-atlas -n 100 --no-pager
sudo -iu claude claude --version
sudo -iu claude claude auth status
```

### systemd 找不到 NVM 中的 Node.js

重新运行安装脚本即可。脚本会把确定后的绝对路径写入服务，而不是依赖 `.bashrc`。

### 参考路径被拒绝

确认该路径位于 `SCHEMA_ATLAS_REFERENCE_ROOTS` 之一，并且 `claude` 用户能够读取。服务会解析真实路径，因此软链接也不能绕过根目录限制。

### `--dangerously-skip-permissions`

Schema Atlas 创建的每轮 Claude Code 命令默认携带此参数。它不会提升 Linux 用户权限，但 Claude Code可以操作 `claude` 用户本身有权访问的内容，因此只应配置可信参考目录。
