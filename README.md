# Schema Atlas 表关系探索器

Schema Atlas 用于批量导入 PDM JSON 表定义，并从全局业务域逐层下钻到 0 级域、1 级域、数据表、上下游外键和字段映射。

## 主要能力

- 批量导入 JSON；每批设置 0 级域，1 级域自动读取有效的 `folder`
- 合并 `foreignKeys` 与 `referencedBy` 中的对称关系描述
- 全局、0 级域、1 级域和单表四层关系图
- “我依赖谁 / 谁依赖我 / 同时展示”双向筛选和两层追踪
- 跨域关系聚合展示；表自引用保留在详情中，不绘制回环线
- 域树目录与全部表铺平目录
- 主键、字段备注、命名约束及复合外键映射详情；默认 `RESTRICT` 不占用界面，`CASCADE` 等特殊行为单独告警
- 外键字段完整性检查；依赖表或映射字段未导入时即时告警
- 0 级域、1 级域改名；没有 1 级域的表直接挂在 0 级域下
- 一表一类；配置类名、类描述和类别名
- 字段筛选、属性名、别名、详细描述、语义标志和枚举标注
- 表级“未标注 / 标注中 / 已完整标注”状态，以及可恢复的标注清空
- 表/字段删除、外键映射同步清理，以及可恢复、可导出的表级变更记录
- 按约定目录导出 Ontology、RDB Mapping 和枚举 JSON 的 ZIP
- 本地 Claude Code CLI 批量生成全表标注草稿，不使用 SDK 或 RAG
- 导入表自动同步为后台数据集快照，按外键向 Claude Code 提供关联表完整字段
- 全屏 Claude Code 标注台，待审核与待澄清按 0级域分组，并提供完整执行轨迹和可批量清理的 Session 中心
- 前端可见、可编辑、可恢复默认的 Claude Code 完整提示词模板
- 导入表、人工标注、域、变更记录和 AI 生成配置统一保存在 Linux 服务器，所有访问者共享可见

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

### 多人访问与共享数据

同一 Linux 地址允许多人同时访问。当前安装脚本配置一组共享的网页账号，不提供独立用户角色；登录后看到的是同一个团队工作区：表、字段、域、正式标注、表级变更记录、提示词模板、参考资料路径、批量生成要求、AI Session、待审核和待澄清都由服务器统一保存。

浏览器每 4 秒检查一次表数据版本，生成配置每 5 秒检查一次。不同表上的并行修改会自动合并；两个人基于旧版本修改同一张表或同一份生成配置时，界面会显示同步冲突并要求显式载入服务器版本，不会静默覆盖对方结果。首次升级时，如果服务器尚无共享工作区，第一个打开新版页面的浏览器会把现有本地表、标注、变更记录和 AI 配置迁移到服务器。

## 连接本机 Claude Code

Schema Atlas 不需要 Claude SDK 或 API Key，网页通过本地桥接进程调用 `claude` 命令。首次部署前，以运行服务的 Linux 用户完成一次登录：

```bash
sudo -iu claude
claude --version
claude auth login
claude auth status
exit
```

如果 `auth status` 已显示登录成功，可以跳过 `auth login`。随后执行 `sudo bash scripts/install-systemd.sh`；安装脚本会自动找到该用户的 Node.js 和 Claude Code 路径，并让网页、AI 桥接层随系统启动。页面“AI 标注 → 批量生成 → 生成配置”中可以检查运行账户、CLI 版本、登录状态和允许读取的目录。

## Claude Code 标注流程

1. 界面导入或修改表后，完整数据集会自动同步到 `.schema-atlas-ai/datasets/`；“AI 标注 → 批量生成 → 生成配置”可查看落盘状态。
2. 启动单表或批量任务时，系统再次确认快照最新，然后为每张表创建独立 Claude Code Session。
3. Claude Code 先读取当前表、双向关系和直接关联表，再以表名、字段名精确检索 RB、WEB、DB 中的代码、SQL、配置和常量；同域表按需读取，避免无目的遍历。
4. 检索后仍无明确依据或发现冲突的概念才进入人工 TODO，并显示“已检索”来源；低置信度本身不会直接产生 TODO。
5. 在表详情点击“AI 审核此表”进入全屏双栏标注台：左侧保留原 Session 对话，右侧按类和字段审核结构化草稿。物理字段与本体属性使用“对应”关系明确标注，不使用可能被误解为修改操作的箭头；字段的中文和英文业务描述分区展示、分开编辑，保存及导出时仍按目标 JSON 的单个 `description` 字段合并。每个字段还单独展示“AI 标注分析”和“证据依据”：前者解释业务理解、命名、别名、枚举证据、外键语义与不确定性，后者列出可回查的资料来源。`is_local_id`、`is_code`、`is_display_name` 和 `is_semantic` 只允许人工设置，服务端会忽略 Claude 对这些值的修改。可从任一类或字段把修订要求带入左侧继续对话，也可直接“人工编辑”；人工修改先持久化到当前 Session 草稿，点击“应用到当前表”后才写入正式标注和表级变更记录。在 `Sessions` 中选中历史会话后也可直接继续对话。“生成第一版”的默认单表要求只在新建 Session 时预填，进入审核或续聊时输入框保持空白。
6. 人工确认并应用后，正式标注才会变化，同时写入该表自己的变更记录。

Session 由 Schema Atlas 生成 UUID 并登记，前端不会混入用户在其他目录手工创建的 Claude Code 会话。继续对话时复用同一个 Session ID，并通过 Claude Code `--resume` 保留此前上下文、草稿和澄清结果，不会悄悄新建会话。每个 Session 绑定一个内容哈希数据集版本，保证后续可以确认当时参考了哪些表。服务器只把落盘数据集和允许根目录中的路径传给 `--add-dir`，不建立向量索引。

### 提示词配置

默认完整提示词保存在 [`config/default-annotation-prompt.txt`](./config/default-annotation-prompt.txt)，默认单表和批量要求也分别位于 `config/default-table-instruction.txt`、`config/default-batch-instruction.txt`，不会隐藏在服务端业务代码中。“AI 标注 → 批量生成”的“生成配置”会把完整模板、本地资料路径和连接状态放在同一工作面；模板可直接编辑、自动保存到团队共享工作区，也可一键恢复默认。默认检索顺序是原始 JSON 与关系、RB/WEB/DB 中的精确表名和字段名、必要的同域资料；Teleco_Context 每个任务只读取一个 entity-class 样例，必要时再读取一个 enum 样例，且只用于输出格式与标注粒度。单表生成、批量生成和 TODO 澄清续写都使用发起任务时的当前模板。逐字段 AI 标注分析只保存在 Session 审核草稿中，不会增加或污染最终导出的 Ontology 与 RDB Mapping JSON 字段。

Claude 结构化输出只校验 JSON 结构和字段类型，不设置描述字数、别名数量、数组长度或中英文格式正则。内容完整性由默认提示词引导，并在人工审核及最终导出校验中提示，不会因为任意字数门槛导致整轮生成失败。

可用占位符：`{{table_name}}`、`{{mode}}`、`{{dataset_context}}`、`{{reference_paths}}`、`{{clarifications}}`、`{{user_message}}`。其中 `{{dataset_context}}` 会展开为数据集、关系索引、当前表和直接关联表的真实落盘路径。页面会阻止包含未知占位符的任务；批量任务要求和单表对话内容通过 `{{user_message}}` 注入。

## 关系方向

- `foreignKeys`：当前表是子表，回答“我依赖谁”；箭头为子表 → 父表。
- `referencedBy`：当前表是父表，回答“谁依赖我”。
- 两份 JSON 中同一条物理外键会自动去重，不会重复画线。
- 聚焦一张表后，可以只看任一方向、同时看两边，并切换 1 层或 2 层。
- 跨 0 级域和跨 1 级域外键都支持；域外端点会聚合到画布右侧。
- 父子表相同的自引用不画回环线，可在表详情的“本表自引用”中查看。
- `RESTRICT` 是本数据集的默认删除/更新行为，关系卡片不再重复展示；只有 `CASCADE`、`SET NULL`、`SET DEFAULT` 等非默认行为才醒目标出。

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

### 表级标注状态与清空

- `未标注`：新导入的表，或已执行“清空标注”的表；只保留原始表结构和导入资料。
- `标注中`：已启动 Claude Code 生成、继续对话或 TODO 修订，或者已手工填写部分标注但尚未满足完整性校验。
- `已完整标注`：类名、类说明、类别名，以及所有纳入导出的字段名称、详细说明、别名和已启用枚举均通过必填校验；应用审核通过的 AI 草稿后也会进入此状态。
- 状态会显示在域树、全部表列表、关系图节点、全屏表详情和顶部汇总中；编辑内容后会自动重新计算，不依赖人工猜测。
- 在全屏表详情点击“清空标注”，确认后会清除类级和字段级标注，并恢复为刚导入时的默认标注状态。表名、原始描述、字段、`description`、`remark`、域、外键关系及 Claude Code Session 都会保留。
- 清空是该表的一条独立变更记录，可在该表详情的“变更”页签中恢复；恢复动作本身也会继续留痕。

- 单表：打开表详情，点击“删除此表”；域树和全部表列表也提供删除按钮。
- 批量：进入“全部表”，点击“管理”，可全选当前筛选结果后批量删除。
- 字段：打开全屏表详情的“字段”，可直接点击删除按钮；也可进入字段标注后删除。
- 删除字段会从复合外键中清除对应映射；若一条关系已无任何列映射，则移除整条关系。
- 删除字段后，本地 AI 服务会在下一次数据集同步时自动移除该字段的审核草稿项，并让仅指向该字段的待澄清项失效；同表其他字段、类级草稿和澄清项保持不变。
- 删除表后，该表的 Session 会自动移出“待审核”和“待澄清”，但完整对话、Claude Code 执行轨迹及旧草稿不会物理删除，仍可在 `Sessions` 中审计。
- 恢复表或字段时，此前因删除而暂停且仍适用于当前结构的待澄清项会重新进入队列；缺失字段对应的项继续保持失效。相关 Session 会显示“结构已变化”，并阻止直接应用旧草稿。继续原 Session 重新核对，或人工编辑并保存当前结构后，才会解除该状态。正在执行的 Session 不会被同步过程强制改写，任务结束后再自动完成对账。
- 每张表拥有独立历史；在表详情的“变更”页签中查看、恢复或导出本表记录。
- 主界面不提供全局变更列表；必须先打开目标表，再查看该表的历史。
- 批量导入会拆分为逐表记录；表被删除后，其历史和删除前快照仍保留，可在“全部表 → 已删除表”恢复。
- 删除表或外键字段时，关系清理会同时写入受影响父表、子表各自的历史。
- 0 级域和 1 级域改名会分别写入域内每张受影响表。
- “恢复”表示恢复到所选记录发生前；恢复操作本身会新增一条本表记录，因此仍可恢复到恢复前状态。
- 变更记录只能按当前表导出；旧版扁平记录会在首次读取时自动拆分到对应表。没有保存完整前态的旧记录只可查看，界面不会冒险恢复。

## 类和字段标注

每张表必须对应唯一 `class_name`。在表详情点击“配置类”可设置：

- 类名、详细中英文业务语义描述、多个中英文类别名
- 字段是否导出、`attr_name`、多个中英文别名和详细中英文业务语义描述
- 四个人工判断的布尔开关：`is_local_id` 表示内部标识/引用 ID（主键、外键）；`is_display_name` 表示实体的对外显示名称（UI/报表中使用的可读名）；`is_semantic` 表示承载业务语义、需纳入语义建模的名称/状态/标记位；`is_code` 表示外部或人工可读、区别于内部 ID 的业务编码
- 枚举引用开关、可编辑的 `enum_ref`、枚举说明，以及结构化的取值、双语说明和别名

类名、类的中英文业务说明、类别名均为必填。字段开启“导出该字段”后，`attr_name`、中英文业务说明和至少一个别名均为必填；上述开关为 `false` 时只是不输出对应的布尔键，不影响该字段是否导出，字段是否导出仅由“导出该字段”控制。开启枚举后，系统默认把 `attr_name` 首字母大写作为 `enum_ref`（如 `accountClass` → `AccountClass`），仍可手工修改；枚举说明及每项的 `value`、`aliases`、中英文 `description` 都必须填写。

字段编辑器中的原始 `description` 与 `remark` 来自导入 JSON，只在实际有值时显示，并作为同一字段的参考资料；不会再建立单独的“备注”页签。所有空的可选信息均不显示占位栏。

字段编辑弹窗采用固定标题和操作区，中间表单独立滚动；必填项未完成时，顶部提示和底部“定位未填项”会滚动并聚焦到第一个缺失字段。

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

Ontology 类文件包含 `class_name`、`description`、`aliases`、`attributes` 和空数组 `metrics`。RDB Mapping 包含 `class_name`、数据库表名及已筛选字段的属性名、数据库列名和固定类型。字段开启 `enum_ref` 后，必须同时完成结构化枚举定义，系统会在同一 0 级域的 `enums` 目录生成文件；每个枚举值只输出 `value`、`aliases` 和一个包含中英文语义的 `description`，不再输出 `description_en`。

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

团队工作区保存在 `.schema-atlas-ai/shared-workspace.json`，内容包括导入表、域、类与字段标注、枚举配置、表级变更记录、提示词模板、参考资料路径和批量生成要求。稳定表状态还会按内容哈希写入 `.schema-atlas-ai/datasets/<dataset-id>/tables/`，并生成 `manifest.json` 和 `relation-index.json`，供 Claude Code 跨表分析和 Session 追溯。AI Session、草稿、完整执行记录、任务及 TODO 同样保存在 `.schema-atlas-ai/`。

`localStorage` 不再是业务数据源，只在两种情况下使用：从旧版本首次迁移尚未上云的浏览器数据，或者 Linux 共享服务不可达时提供明确标记的临时浏览器模式。共享连接恢复后以服务器版本为准；关系图顶部会显示“团队共享”“正在共享”“同步冲突”或“浏览器临时模式”。
