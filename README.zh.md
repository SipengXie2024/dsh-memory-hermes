# dsh-memory-hermes

Hermes 式有界策划记忆,做成 DeepSeek Harness(dsh)的用户侧插件。不改 dsh 本体,`dsh plugin add` 即装即用。

设计蓝本是 Nous Research Hermes Agent 的记忆系统:**小容量、模型自己策划、每 session 冻结注入**。与「越攒越多的记忆库」相反,它逼着模型维护一份精炼的长期事实清单。v2 起,配置、可观测性、检索全部落在 dsh 自己的机制面上(settings 命名空间、storage-domain sidecar、projection、sessionQuery),不再是插件私有轮子。

## 机制速览

| 机制 | 行为 |
|---|---|
| 双文件 | `MEMORY.md`(agent 笔记,默认 2,200 字符)+ `USER.md`(用户画像,默认 1,375 字符),存于 `$DSH_HOME/memory/` |
| 单工具 | `memory`,action 枚举 `add / replace / remove`,**没有 read**——内容已在系统提示里 |
| 冻结快照 | session 开始时读一次注入系统提示,会话内不再变(prompt-cache 友好);会话内写入落盘、工具结果回显实时态,下个 session 才进快照 |
| 定位条目 | `replace`/`remove` 用唯一子串匹配,**条目全文精确匹配优先**(条目互为子串时的逃生口);0 命中或多命中报错,错误里附**锁内实时盘面**的条目全文(快照可能过期,这是模型的自救通道) |
| 溢出纪律 | **增长型**超限写入不落盘,报错附当前全部条目,并要求**当轮合并重试、不丢新信息**;缩小型操作(remove/变短的 replace)总是放行——文件已超限(调小上限/手改)时才能逐步收敛回来 |
| 安全扫描 | 写入时 + 注入渲染时 + **错误载荷**三处同一规则表:不可见 Unicode、注入话术、外传形状;命中即拒/隐藏 |
| 审批闸门 | `approval: true` 时每次写弹审批——实现为 dsh 设计的 `tools/pre-execute` 策略监听器(ask 决策),工具本体无策略;无审批渠道时运行时 fail-closed(默认关) |
| 并发安全 | 进程内 promise 链串行 + 跨进程 `.lock` 文件锁 + 原子写(照 dsh settings-file 同款姿势) |
| 后台自省 | 后台 LLM 调用重看会话、自动提取值得长期记住的事实写入记忆;三种触发:turn 结束(按策略)、**compaction 收割**(上下文折叠前抢救)、`/memory review` 手动 |
| 自省可观测 | 每次 review 落一条记录进 storage-domain sidecar(`memory_hermes` 域),设置页「活动」页签可查:跑了没、存了几条、为何失败 |
| 记忆活动投影 | 注册 sessionProjections 单元 `memoryActivity`,从本会话日志 fold 出 memory 工具调用统计——日志派生物,resume 免费 |
| 设置页与命令 | dsh web 设置导航「记忆」页(文件 + 活动两个页签)+ `/memory`、`/memory review`、`/memory compact` 斜杠命令 |
| 检索层(可选) | 配合 dsh 船载 session-query(sqlite 全文索引)实现跨会话检索,见下文「配套:会话检索」 |

## 安装

前置:Node 22+(dsh 要求 ^22.19 || >=24),dsh CLI 可用(`npm install -g @deepseek-ai/dsh@0.1.0-rc.6`,钉版本)。

```bash
cd dsh-memory-hermes
npm install
npm run build
npm pack
```

```bash
dsh plugin --profile web add "./dsh-memory-hermes-<version>.tgz"
```

两条硬规矩(2026-08-15 实测教训,违反会得到两种运行时崩溃):

- **必须用 `npm pack` 出的 tgz 安装,不要裸目录/`link:`**。链接安装时 Node 会顺着 realpath 解析到插件自己 devDeps 的 `node_modules`,`TypertRemoteService` 等基类变成插件本地副本,宿主认不出这个服务 → 面板 RPC 全部 404。
- **装进内置 profile(web/tui/headless),不要在自定义 profile 里手动补装 `@deepseek-ai/dsh-web-app`**。dsh 把运行时物化在 `$DSH_HOME/profiles/node_modules` 共享层,自定义 profile 里 pnpm 装的 web-app 副本会遮蔽它,工具调度器的 Symbol 跨副本查空 → 每次工具调用整轮失败(`Cannot read properties of undefined (reading 'prepare')`)。内置 web profile 的模板自带 base + web-app,从共享层单树解析。

装完 `dsh --profile web --dump-config` 应能看到 `memory-hermes` 层。改代码后的更新:`npm run build && npm pack`,重新 `add`;**host 半边的更新要重启 dsh 才生效**,client 半边(设置页)刷新页面即可。

## 配置

v2 起配置走 dsh **settings 服务**:插件注册 `memory-hermes` 命名空间,bundle patch 的 entry config 作为 `base`(组合层打底),`$DSH_HOME/settings.yaml` 文档里的同名 section 作为用户层覆盖,**热生效**(`settings/updated` 驱动,限额/扫描/review 策略即时切换;已冻结的会话快照不变)。没有 settings 服务的 profile 退化为只用 entry config。

注意(rc.6 边界):dsh web 的设置 GUI 只暴露白名单内的命名空间(apiproxy 硬编码;「插件自暴露」在官方 deferred work 清单里),所以本插件的配置通道是 **settings.yaml 文档**——在文档里加:

```yaml
memory-hermes:
  memoryCharLimit: 3000   # 只写要覆盖的字段,其余回 base/默认
```

保存即生效,无需重启(已实测:外部编辑 → chokidar 监视 → 热发布)。

全部配置项(schema 默认兜底;写在 profile 用户层 patch `$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: memory-hermes
  name: dsh-memory-hermes
  config:
    memoryCharLimit: 2200        # MEMORY.md 上限(codepoint 计),最小 200
    userCharLimit: 1375          # USER.md 上限,最小 200
    securityScan: true           # 写入+注入双侧扫描
    approval: false              # true = 每次写弹审批(同时抑制后台 review)
    backgroundReview: true       # 后台自省总开关
    reviewTrigger: token-delta   # every-turn | token-delta | manual
    reviewTokenDeltaTokens: 4000 # token-delta 触发阈值(tokenMeter 估算)
    compactionHarvest: true      # compaction/start 时做收割 review
    reviewMaxTokens: 1000        # 单次 review 的输出 token 预算
    reviewTimeoutMs: 60000       # 单次 review 超时(毫秒),最小 1000
    reviewHistoryLimit: 200      # sidecar 保留的 review 记录条数
    consolidateMaxTokens: 2000   # /memory compact 合并调用的输出预算
    # reviewProvider: deepseek   # review/compact 换模型用;默认跟主会话(吃前缀缓存)
    # reviewModel: deepseek-chat
```

注意:id 覆盖是**整体替换 config,不深合并**——要改就把想要的字段写全(未写的字段回 schema 默认,恰好也是安全的)。

## 后台自省(background review)

每个正常完成(completed)的 turn 结束后(按触发策略),插件在后台发起一次独立 LLM 调用重看本会话,提取「值得长期记住、且记忆里还没有」的事实,按 memory 工具同一套写入语义存盘。主对话不被打断,也看不到这次调用。

- **触发策略**(`reviewTrigger`):
  - `every-turn`:每个 completed turn 都跑(前缀缓存友好的 provider 划算);
  - `token-delta`(默认):用 host 的 tokenMeter 估算会话压力,自上次 review 增长超过 `reviewTokenDeltaTokens` 才跑——无缓存 provider 不再每 turn 付一次全前缀;无 tokenMeter 时退化为 every-turn;session 首次接触只建基线,长会话恢复不会立刻触发;
  - `manual`:只有 `/memory review` 和 compaction 收割会跑。
- **compaction 收割**(`compactionHarvest`):dsh 真正的遗忘点是上下文折叠,不是 turn 结束。插件监听 `compaction/start` 事件,**在回调里同步快照**当前消息再异步跑收割 review——折叠先落地也丢不了输入。
- **可观测性**:每次 review 结束落一条记录(触发类型、turn、存/弃条数、条目摘要、错误)进 storage-domain sidecar(`memory_hermes` 域的 `runs` 表,环形保留 `reviewHistoryLimit` 条),设置页「活动」页签拉取展示。「跑了没存」和「没跑」从此可分。
- **抢占**:同一会话新触发会作废(abort)还没跑完的旧 review——新调用覆盖到最新的全会话视图。
- **与审批互斥**:`approval: true` 时 review 触发被抑制——后台写无法弹审批,绕过闸门又违背开审批的本意(v2 起改为触发时判定,配置热切换即时生效)。
- **失败静默**:review 调用出错只记 warn 日志 + sidecar 错误记录,不重试、不打扰主对话。

## 设置页与 /memory 命令

- **设置页**:dsh web 设置导航里的「记忆」页(settings.section 注册),两个页签:
  - **文件**:MEMORY.md / USER.md 两区,各带用量条与条目列表;条目可内联编辑、两击确认删除、输入框新增。面板编辑**不走审批闸、不受扫描拒写**(操作者就是审批人);会被扫描命中的条目带三角警示标记,仅提示不拦截。
  - **活动**:后台 review 记录列表(时间、触发类型、turn、存/弃/失败、条目摘要),Refresh 拉取。
- **`/memory`**:输出两文件用量头与条目全文(任意端)。
- **`/memory review`**:立刻对当前会话跑一次后台 review(绕过触发策略,记为 manual)。
- **`/memory compact`**:一次 LLM 调用产出合并方案,经 dsh 审批服务**人审**通过后整体重写两文件(store.rewrite,同锁内原子写路径);无审批渠道时只展示方案不落盘。
- profile 没装 commands 插件时命令静默不注册。

## preset 交互与 tools.restrict

工具从 bundle 层注册进 dsh-tools 的**全局层**,所有 preset(standard/code/minimal/cordis)的会话都能看见 memory 工具。但 minimal preset 的 persona 是 `complete: true`,装配期追加被抑制——minimal 会话**没有** Persistent memory 快照段落,模型只能靠工具描述自行发现。

不想让某个 preset 看到 memory 工具?组合问题在组合层解决:dsh-tools 提供作用域 `restrict` 缝,preset 作者在自己 preset 的某个插件行里调一行即可:

```js
// Inside any plugin row of your preset copy — scoped to that preset's agents.
ctx.tools.restrict({ deny: ['memory'] })
```

(「插件全局注册 + preset 用 restrict 退出」,选择权在 preset 作者。)

## 配套:会话检索(session-query)

记忆是有界策划;原始历史的全文检索是 dsh 船载能力(sessionQuery + sqlite 后端 + tool-session-query 五个工具,默认未启用)。启用方法见 [docs/session-query.snippet.yml](docs/session-query.snippet.yml):插工具行 + 把 sqlite 后端从 `:memory:`/never 指向持久路径。启用后「save a pointer」纪律闭环:记忆里可以只存指针,模型用 session_search 自己搜回细节(搜索范围按 workspace 限定)。

## 数据与卸载

- 记忆数据:`$DSH_HOME/memory/MEMORY.md` 与 `USER.md`。纯文本,每行一条 `- ` 前缀,可手工检查/编辑;手改在**下个 session** 生效。
- review 记录:storage-domain sidecar(`memory_hermes` 域,后端介质由 storage 层决定)。
- 卸载:`dsh plugin --profile web remove dsh-memory-hermes`。数据文件不会被删,不要了手工删 `$DSH_HOME/memory/`。

## 已知边界(设计取舍,非 bug)

- **扫描是启发式 denylist,不是完整防御**。真正的边界是:记忆文件是你本地的、可手工检查的纯文本。已知误伤(接受并文档化):
  - ZWJ 组合 emoji(如家庭 emoji)会被 `invisible.zero-width` 拒——零宽段整段拒收;
  - "post/send … https://…" 的名词歧义句可能被 `exfil.send-url` 误拒;
  - 「system prompt」这个短语**刻意不封**(harness 研究笔记的合法高频词)。
- 条目里的相邻花括号 `{{` 在系统提示里显示为 `{ {`(盘上原文不变)——dsh 对提示 section 做严格 `{{name}}` 模板插值,不打断会让整个 session 组装崩溃。
- 写入用 0o600/0o700 权限位;**Windows(NTFS)上 Node 只落实只读位**,「仅属主可读写」不生效,真正的访问控制靠 `~/.dsh` 继承的用户目录 ACL。别把 0o600 当成 POSIX 级「仅我可读」。
- 记忆文件目录并发写有跨进程 `.lock` 文件锁;若写入进程被强杀留下孤儿锁,后续写会等 2 秒后报 `MEMORY_LOCK_BUSY`,错误里带锁文件路径——确认没有别的 dsh 进程在跑后手工删掉即可。
- 原子写不 fsync(与 dsh settings 同款):崩溃可能丢最后一笔写,下个 session 读盘上现状即可。
- 错误的 `code` 字段是 best-effort:`link:` 安装可能出现 `HarnessError` 双副本导致 code 丢失,因此**模型需要的信息全部在 message 文本里**,不依赖 code。
- 溢出上限按 codepoint 计(与 Hermes 的 Python `len()` 一致);中文信息密度高,同字符数装得下更多事实,嫌紧可调大。
- review 失败静默是取舍:后台调用出错只记日志与 sidecar,不重试,主对话永远不因 review 受影响;「没存上」在设置页活动页签可见。
- review 的写入质量(存不存、存多准)取决于模型对 review 指令的遵守度,因模型而异;不满意就关掉或换 `reviewModel`。
- 面板刷新是拉取不是推送(dsh 的 client 推送通道是白名单制,插件进不去):别处写入(模型工具 / review / 另一进程)后,点 Refresh 或重开设置页才可见。
- 插件**不**往 session 日志 append 自定义事件类型:dsh 的日志事件词汇是白名单制,未知类型会让整份日志重放被拒。自省可观测性走 sidecar,不走日志。

## 实测

装载后按 [docs/playbook.zh.md](docs/playbook.zh.md) 走一遍:写入→fresh 召回→冻结→溢出→扫描→审批→session-query→并发→模型矩阵→卸载→后台自省→设置页。
