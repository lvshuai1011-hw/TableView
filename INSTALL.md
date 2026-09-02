# 安装与部署

## 1. 环境要求

- Node.js `22.13.0` 或更高版本
- npm `10` 或更高版本
- 推荐 Linux；项目构建脚本使用 Bash 与 GNU `timeout`
- 生产服务器建议至少 1 核 CPU、1 GB 内存

确认版本：

```bash
node --version
npm --version
```

## 2. 本地开发

解压源码后进入目录：

```bash
unzip schema-atlas-source-v4.zip
cd schema-atlas-source-v4
npm ci
npm run dev
```

开发服务器启动后，以终端输出的地址为准。Vite 默认使用 `http://localhost:5173`。

局域网访问：

```bash
npm run dev -- --host 0.0.0.0
```

## 3. 生产构建

```bash
npm run lint
npm run build
npm run start -- --hostname 0.0.0.0 --port 3000
```

访问 `http://服务器IP:3000`。构建产物位于 `dist/`。

长期运行时可使用 systemd、Supervisor 或其他进程管理器守护上述启动命令，并在前方配置 Nginx 或 Caddy。

## 4. Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name schema.example.com;

    location /claude-sidecar/ {
        proxy_pass http://127.0.0.1:4318/;
        proxy_http_version 1.1;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置 HTTPS 时，可使用 Certbot 或由现有网关终止 TLS。

## 5. JSON 导入规则

系统导入的是已经清理和标准化后的表结构 JSON。每个 JSON 文件代表一张表，必须包含：

- `tableName`
- `description`
- `folder`
- `columns`
- `foreignKeys`
- `referencedBy`

导入一个批次时只需填写 0 级域；每张表的 1 级域由 `folder` 自动生成。空的 0 级域进入“未归类”，空的 `folder` 进入“根目录”。

## 6. 当前存储方式

导入和删除结果保存在当前浏览器的 `localStorage` 中，没有服务端数据库，也不需要环境变量。刷新页面后数据仍会保留；清除该站点的浏览器数据会同时清空表数据。

当前方式适合单机使用。团队共享时建议接入 SQLite / PostgreSQL，或将清理后的 JSON 保存到对象存储后由服务端生成关系索引。

## 7. 常用命令

```bash
npm run dev          # 开发模式
npm run ai:sidecar   # 本机 Claude Code sidecar
npm run lint         # 代码检查
npm run build        # 生产构建
npm run start        # 启动生产服务
```

## 8. 本地 Claude Code 标注助手

AI 标注功能不使用 Anthropic SDK，也不直接调用模型 API。Schema Atlas 通过同机 Node sidecar 启动系统已经安装和登录的 `claude` CLI。

先确认 Claude Code 本机可用：

```bash
claude --version
claude auth status
```

启动 sidecar：

```bash
cd /home/AI_BUILD/TableView
npm run ai:sidecar
```

默认监听：

```text
127.0.0.1:4318
```

开发模式下 Vite 会把 `/claude-sidecar/*` 自动代理到这个端口。生产部署使用上面的 Nginx `/claude-sidecar/` location，避免把 sidecar 端口直接暴露到网络。

sidecar 调用 Claude Code 时默认固定使用：

```text
--dangerously-skip-permissions
```

并根据前端设置把参考资料目录转换为多个：

```text
--add-dir /path/to/repo
--add-dir /path/to/approved-json
--add-dir /path/to/specs
```

因此参考资料目录建议在操作系统层面挂载为只读。Schema Atlas 自己的 AI 临时输入会写入：

```text
.schema-atlas-ai/jobs/
```

该目录已经加入 `.gitignore`。

### AI 输入事实边界

浏览器中已经导入并清理好的 Schema JSON 是表结构的唯一事实来源。Claude Code 可以读取代码仓库、已审核 JSON、业务规范等参考资料来理解业务概念和学习标注方式，但不能根据参考资料反向修改表名、字段名、数据库类型或表关系，也不需要知道这些 JSON 最初来自什么建模工具。

### Session 浏览与继续纠正

Claude Code 本地 session transcript 直接读取自：

```text
~/.claude/projects/
```

前端的 `Sessions` 页签会列出这些本地 session，点击后可以查看用户消息、Claude 回复以及工具调用过程。选择“设为当前并继续”后，后续纠正通过 Claude Code 原生：

```text
--resume <session-id>
```

继续同一个会话，不另外维护一套对话数据库。

### AI 标注流程

1. 导入全部清理后的 Schema JSON。
2. 在 AI 面板设置本地代码仓库、已审核 JSON、规范资料等参考目录。
3. 点击“AI 生成全部标注”。
4. Claude Code 主动读取这些目录并生成类和字段标注 Proposal。
5. 无法可靠判断的业务概念进入“人工澄清 Todo”。
6. 人工填写澄清答案后继续同一 Claude Code session。
7. 对不正确的标注可以在右侧继续自然语言纠正。
8. 人工确认 Proposal 后再写回 Schema Atlas 正式标注。
