# Schema Atlas 表关系探索器

Schema Atlas 用于批量导入 PDM JSON 表定义，并从全局业务域逐层下钻到 0 级域、1 级域、数据表、上下游外键和字段映射。

## 主要能力

- 批量导入 JSON；每批设置 0 级域，1 级域自动读取有效的 `folder`
- 合并 `foreignKeys` 与 `referencedBy` 中的对称关系描述
- 全局、0 级域、1 级域和单表四层关系图
- “我依赖谁 / 谁依赖我 / 同时展示”双向筛选和两层追踪
- 跨域关系聚合展示；表自引用保留在详情中，不绘制回环线
- 域树目录与全部表铺平目录
- 主键、字段备注、关系约束及复合外键映射详情
- 外键字段完整性检查；依赖表或映射字段未导入时即时告警
- 0 级域、1 级域改名；没有 1 级域的表直接挂在 0 级域下
- 一表一类；配置类名、类描述和类别名
- 字段筛选、属性名、别名、详细描述、语义标志和枚举标注
- 表/字段删除、外键映射同步清理和可导出的变更记录
- 按约定目录导出 Ontology、RDB Mapping 和枚举 JSON 的 ZIP
- 本地 Claude Code CLI 批量生成全表标注草稿，不使用 SDK 或 RAG
- 表级 AI 审核对话、人工澄清 TODO 和可恢复的 Session 中心
- 导入表与人工标注保存在浏览器；AI Session、草稿和完整对话保存在服务器

## 快速部署

要求 Node.js `22.13.0` 或更高版本、npm `10` 或更高版本，并确保非 root 用户 `claude` 已安装并登录 Claude Code。

```bash
npm ci
npm run build
sudo bash scripts/install-systemd.sh
```

访问：`http://服务器IP:3000`。安装命令会打印网页登录用户名和随机密码。

查看服务和日志：

```bash
systemctl status schema-atlas
journalctl -u schema-atlas -f
```

不安装 systemd 时，可以前台启动完整服务：

```bash
npm run start:local
```

完整安装和参考资料目录配置见 [INSTALL.md](./INSTALL.md)。

## 连接本机 Claude Code

Schema Atlas 不需要 Claude SDK 或 API Key，网页通过本地桥接进程调用 `claude` 命令。首次部署前，以运行服务的 Linux 用户完成一次登录：

```bash
sudo -iu claude
claude --version
claude auth login
claude auth status
exit
```

如果 `auth status` 已显示登录成功，可以跳过 `auth login`。随后执行 `sudo bash scripts/install-systemd.sh`；安装脚本会自动找到该用户的 Node.js 和 Claude Code 路径，并让网页、AI 桥接层随系统启动。页面“AI 标注 → 资料”中可以检查运行账户、CLI 版本、登录状态和允许读取的目录。

## Claude Code 标注流程

1. 顶部点击“AI 标注”，选择全部域或一个 0级域，配置本地代码仓库、历史标注 JSON 等参考路径。
2. 系统为每张表创建独立 Claude Code Session，使用 `--dangerously-skip-permissions` 执行，并把结果保存在草稿层。
3. Claude Code 无法确定的概念进入人工 TODO；填写答案后，系统恢复原 Session 继续修订。
4. 在表详情点击“AI 审核此表”，查看完整对话、低置信字段和草稿摘要，也可以继续对话纠正。
5. 人工确认并应用后，正式标注才会变化，同时写入该表自己的变更记录。

Session 由 Schema Atlas 生成 UUID 并登记，前端不会混入用户在其他目录手工创建的 Claude Code 会话。服务器只把允许根目录中的路径传给 `--add-dir`，Claude Code直接读取文件，不建立向量索引。

## 关系方向

- `foreignKeys`：当前表是子表，回答“我依赖谁”；箭头为子表 → 父表。
- `referencedBy`：当前表是父表，回答“谁依赖我”。
- 两份 JSON 中同一条物理外键会自动去重，不会重复画线。
- 聚焦一张表后，可以只看任一方向、同时看两边，并切换 1 层或 2 层。
- 跨 0 级域和跨 1 级域外键都支持；域外端点会聚合到画布右侧。
- 父子表相同的自引用不画回环线，可在表详情的“本表自引用”中查看。

### 依赖字段完整性提示

- 顶部状态栏汇总所有关系中的字段缺口数量。
- 关系详情会逐项检查 `columnMapping` 的父表字段与子表字段，并分别提示“依赖表未导入”“依赖字段未导入”或“引用字段未导入”。
- 表和字段后续补充导入后，提示会自动消失；无需重新创建关系。
- 字段已存在但被标记为“不导出”时显示黄色提示，不计为缺失，避免把人工筛选误报为导入错误。

## 域与目录规则

- `folder` 有有效值时成为 1 级域。
- `folder` 为空、`根目录`、`DIAGRAM 1`、`DIAGRAM_1` 或 `DIAGRAM-1` 时，不创建 1 级域。
- 域树中点击域名右侧的编辑按钮可改名；1 级域改为空会把表直接挂到 0 级域。
- 改名会同步影响目录、关系图、表归属和导出路径。

## 表、字段和变更记录

- 单表：打开表详情，点击“删除此表”；域树和全部表列表也提供删除按钮。
- 批量：进入“全部表”，点击“管理”，勾选表后点击“批量删除”。
- 字段：打开表详情的“字段”，进入字段标注后点击“删除字段”。
- 删除字段会从复合外键中清除对应映射；若一条关系已无任何列映射，则移除整条关系。
- 每张表拥有独立历史；在表详情的“变更”页签中查看或导出本表记录。
- 主界面不提供全局变更列表；必须先打开目标表，再查看该表的历史。
- 批量导入会拆分为逐表记录；表被删除后，其历史和删除前快照仍保留。
- 删除表或外键字段时，关系清理会同时写入受影响父表、子表各自的历史。
- 0 级域和 1 级域改名会分别写入域内每张受影响表。
- 变更记录只能按当前表导出；旧版扁平记录会在首次读取时自动拆分到对应表。

## 类和字段标注

每张表必须对应唯一 `class_name`。在表详情点击“配置类”可设置：

- 类名、详细中文描述、多个类别名
- 字段是否导出、`attr_name`、多个别名和详细中文描述
- `is_local_id`、`is_display_name`、`is_semantic`、`is_code`；值为 `false` 时不写入导出 JSON
- 枚举引用 `enum_ref`、枚举说明、取值、中文说明、英文说明和别名
- 辅助治理信息：语义角色、单位、范围、标签、敏感级别（本地保留）

数据库类型的导出映射：

| 数据库类型 | 导出 `data_type` / `type` |
|---|---|
| NUMBER、INTEGER、DECIMAL、FLOAT 等数字类型 | `number` |
| VARCHAR、CHAR、CLOB、TEXT 等字符串类型 | `string` |
| DATE、TIME、TIMESTAMP | `datetime` |
| BOOLEAN、BOOL、BIT | `boolean` |
| 其他未识别类型 | `unknown` |

## 标注 JSON 导出

点击顶部“导出标注”会下载 ZIP，目录结构如下：

```text
ontologies/<0级域>/entity-classes/<类名>.json
ontologies/<0级域>/enums/<枚举名>.json
rdb-mapping/<0级域>/entity-classes/<类名>-rdb-mapping.json
```

Ontology 类文件包含 `class_name`、`description`、`aliases`、`attributes` 和空数组 `metrics`。RDB Mapping 包含 `class_name`、数据库表名及已筛选字段的属性名、数据库列名和固定类型。字段配置了 `enum_ref` 时，枚举定义只写入同一 0 级域下的 `enums` 目录。

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
- `app/schema-utils.ts`：数据迁移、导出格式校验和 ZIP 生成
- `app/editor-dialogs.tsx`：类、字段、枚举、域和变更记录编辑界面
- `app/ai-panel.tsx`：批量生成、表级审核、Session 与 TODO 工作台
- `local-ai/`：本地 Claude Code 进程、持久化 API 和单端口服务
- `scripts/install-systemd.sh`：非 root 后台服务安装脚本
- `app/globals.css`：工作台与关系画布样式
- `components/ui/`：界面基础组件
- `public/`：站点图标与静态资源

## 数据存储

导入结果、字段标注和变更记录保存在当前浏览器的 `localStorage` 中；AI Session、草稿、执行记录和 TODO 保存在服务端 `.schema-atlas-ai/`。变更历史使用表名分桶保存。它适合单机使用；清除浏览器站点数据会同时清除正式标注和表级历史。需要迁移前，请逐表导出重要记录和标注 ZIP。多人共享或集中管理时，应接入数据库或后端存储。
