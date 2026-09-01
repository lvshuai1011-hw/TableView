# Schema Atlas 表关系探索器

Schema Atlas 用于批量导入 PDM JSON 表定义，并从全局业务域逐层下钻到 0 级域、1 级域、数据表、上下游外键和字段映射。

## 主要能力

- 批量导入 JSON；每批设置 0 级域，1 级域自动读取 `folder`
- 合并 `foreignKeys` 与 `referencedBy` 中的对称关系描述
- 全局、0 级域、1 级域和单表四层关系图
- 关系画布缩放、平移、回溯、父子表筛选和两层追踪
- 域树目录与全部表铺平目录
- 主键、字段备注、关系约束及复合外键映射详情
- 单表删除、勾选批量删除和关系同步清理
- 浏览器本地持久化；刷新页面后保留导入与删除结果

## 快速部署

要求 Node.js `22.13.0` 或更高版本、npm `10` 或更高版本。

```bash
npm ci
npm run build

nohup npm run start -- --hostname 0.0.0.0 --port 3000 \
  > schema-atlas.log 2>&1 < /dev/null &
echo $! > schema-atlas.pid
```

访问：`http://服务器IP:3000`

查看日志：

```bash
tail -f schema-atlas.log
```

停止服务：

```bash
kill "$(cat schema-atlas.pid)"
```

完整安装与 Nginx 配置见 [INSTALL.md](./INSTALL.md)。

## 删除表

- 单表：打开表详情，点击“删除此表”；域树和全部表列表也提供删除按钮。
- 批量：进入“全部表”，点击“管理”，勾选表后点击“批量删除”。
- 删除会同步移除相关字段、关系线和本地保存记录；需要恢复时重新导入 JSON。

## 企业 Linux 环境问题解决方案

### 新终端中 nvm/Node 不生效

```bash
touch ~/.bashrc
cat >> ~/.bashrc <<'EOF'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
EOF

source ~/.bashrc
nvm install 22
nvm alias default 22
node --version
```

### `curl: (60) self-signed certificate in certificate chain`

长期方案是把公司根证书加入系统信任库。SUSE/openSUSE：

```bash
cp company-root-ca.crt /etc/pki/trust/anchors/
update-ca-certificates
```

RHEL/CentOS：

```bash
cp company-root-ca.crt /etc/pki/ca-trust/source/anchors/
update-ca-trust
```

仅临时跳过校验：

```bash
curl -kfsSL URL
export npm_config_strict_ssl=false
```

### npm 返回 `E407 Proxy Authentication Required`

先使用公司提供的实际代理地址；不要把账号或密码提交到仓库。

```bash
export http_proxy='http://代理主机:8080'
export https_proxy="$http_proxy"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$http_proxy"

# 强制 npm 使用与 curl 相同的代理
export npm_config_proxy="$http_proxy"
export npm_config_https_proxy="$https_proxy"
export npm_config_strict_ssl=false

npm ping --registry=https://registry.npmjs.org
```

代理需要账号密码时，使用公司规定的认证方式；URL 中的特殊字符必须进行百分号编码。

### 华为镜像返回 `504`

本仓库的锁文件已使用 npm 官方源。旧锁文件仍指向华为镜像时执行：

```bash
cp -a package-lock.json package-lock.json.huawei.bak
sed -i \
  's#https://mirrors\.tools\.huawei\.com/npm/#https://registry.npmjs.org/#g' \
  package-lock.json
```

然后重新安装：

```bash
npm ci \
  --registry=https://registry.npmjs.org/ \
  --maxsockets=3 \
  --fetch-retries=1 \
  --fetch-timeout=60000 \
  --no-audit \
  --no-fund
```

### `npm ci` 长时间无进度或出现 `MaxListenersExceededWarning`

停止原进程，再用可观察且快速失败的方式定位请求：

```bash
npm ci \
  --foreground-scripts \
  --loglevel=http \
  --maxsockets=3 \
  --fetch-retries=0 \
  --fetch-timeout=30000 \
  --no-audit \
  --no-fund
```

持续出现 `fetch ... 200` 表示正在下载；`407` 是代理认证问题；`504` 是当前镜像或上游超时。

### 提前缓存后离线安装

在可联网且操作系统、CPU 架构一致的机器上：

```bash
npm ci --cache ./npm-cache --ignore-scripts \
  --registry=https://registry.npmjs.org/
tar -czf npm-cache.tar.gz npm-cache
```

把缓存包复制到服务器后：

```bash
tar -xzf npm-cache.tar.gz
npm ci --cache ./npm-cache --offline
```

## 核心目录

- `app/page.tsx`：关系图谱、目录、导入、删除和详情交互
- `app/data.ts`：数据类型及 `PE_PLAN_POLICY` 示例
- `app/globals.css`：工作台与关系画布样式
- `components/ui/`：界面基础组件
- `public/`：站点图标与静态资源

## 数据存储

导入结果保存在当前浏览器的 `localStorage` 中，不需要服务端数据库。它适合单机使用；清除浏览器站点数据会同时清除已导入内容。多人共享或集中管理时，应接入数据库或后端存储。
