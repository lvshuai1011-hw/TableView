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

每个 JSON 文件代表一张表，必须包含：

- `tableName`
- `description`
- `folder`
- `columns`
- `foreignKeys`
- `referencedBy`

导入一个批次时只需填写 0 级域；每张表的 1 级域由 `folder` 自动生成。空的 0 级域进入“未归类”，空的 `folder` 进入“根目录”。

## 6. 当前存储方式

导入和删除结果保存在当前浏览器的 `localStorage` 中，没有服务端数据库，也不需要环境变量。刷新页面后数据仍会保留；清除该站点的浏览器数据会同时清空表数据。

当前方式适合单机使用。团队共享时建议接入 SQLite / PostgreSQL，或将原始 JSON 保存到对象存储后由服务端生成关系索引。

## 7. 常用命令

```bash
npm run dev      # 开发模式
npm run lint     # 代码检查
npm run build    # 生产构建
npm run start    # 启动生产服务
```
