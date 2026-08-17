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
| 后台自省 | 后台 fork 循环重看会话,双路分流:**memory 路**收窄(用户画像/行为期望/当前状态),**skill 路**沉淀技术经验进 skill 库;触发:turn 结束(按策略)、compaction 收割、`/memory review [focus]` |
| 自省可观测 | 每次 review 落一条记录进 storage-domain sidecar(`memory_hermes` 域),设置页「活动」页签可查:跑了没、存了几条、为何失败、**逐步工具调用 trace** |
| skill 库 | 技术经验落地 `$DSH_HOME/skills/`(dsh 自带用户 skill 根,watcher 热发现):类级 skill + references/templates/scripts/assets;`created_by: agent` 标记的才归 curator 管,手写的一律受保护 |
| 记忆活动投影 | 注册 sessionProjections 单元 `memoryActivity`,从本会话日志 fold 出 memory 工具调用统计——日志派生物,resume 免费 |
| 设置页与命令 | dsh web 设置导航「记忆」页(文件 + 活动两个页签)+ `/memory`、`/memory review [focus]`、`/memory compact`、`/memory skills` 斜杠命令 |
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
    skillReview: true            # v3:review 的 skill 路(技术经验进 skill 库)
    reviewMaxSteps: 8            # fork 循环的最大 LLM 步数
    skillMaxBytes: 65536         # 单个 skill 文件的字节上限
    # skillRoot: C:/Users/<你>/.dsh/skills  # skill 库根;默认就是 dsh 用户 skill 根
    # reviewProvider: deepseek   # review/compact 换模型用;默认跟主会话(吃前缀缓存)
    # reviewModel: deepseek-chat
    curatorEnabled: true         # v4:库维护层总开关(遥测+标记+调度+LLM pass)
    curatorConsolidate: true     # LLM 归并 pass(有意与 Hermes 默认相反:开)
    curatorIntervalHours: 168    # 两次 curator run 的最小间隔(Hermes 7 天)
    curatorMinIdleHours: 2       # 触发前要求的用户空闲时长
    curatorStaleAfterDays: 30    # stale 标记窗口(never-used 宽限同窗)
    curatorMaxSteps: 16          # curator fork 循环的最大 LLM 步数
    curatorMaxTokens: 4000       # 单步输出 token 预算
    curatorTimeoutMs: 300000     # 整个 curator run 的超时(毫秒)
    curatorMaxBackups: 5         # run 前快照保留份数(轮替删最老)
    # curatorProvider: deepseek  # curator 换模型用;缺省回落 reviewProvider/Model,再回落会话默认模型
    # curatorModel: deepseek-chat
    topicsEnabled: true          # v5:主题文件细节层(关 = 动作运行时拒绝,schema 需重载插件才变)
    topicMaxBytes: 32768         # 单个主题文件存储上限(字节),最小 4096
    topicMaxFiles: 100           # 主题文件数量上限
    topicReadLines: 400          # topic_read 默认(也是最大)行窗
    topicReadMaxBytes: 8192      # topic_read 单次读出字节帽
    # topicRoot: C:/Users/<你>/.dsh/memory/topics  # 主题目录覆盖;默认 $DSH_HOME/memory/topics
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

## 记忆/技能分流(v3)

v2 及以前,review 把所有类别(技术经验、环境事实、用户偏好)都塞进 2200 码点的 MEMORY.md——长得快是必然的。v3 对齐 Hermes 的真实分流(依据 `agent/background_review.py` 与 `tools/skill_manager_tool.py` 源码):

| 路 | 存什么 | 存到哪 |
|---|---|---|
| **memory 路** | 用户是谁:persona、偏好、个人细节、对 agent 的行为期望、当前状态 | 有界双文件(不变) |
| **skill 路** | 怎么干这类活:技术教训、工作流修正、踩坑修复 | `$DSH_HOME/skills/` 无界 skill 库 |

- **fork 循环**:review 从"一次 LLM 调用"升级为有界 agent 循环(默认最多 `reviewMaxSteps: 8` 步):模型可以 `skills_list`(L0 目录)→ `skill_view`(L1 正文 / L2 支持文件)→ `skill_manage`(六动作 create/edit/patch/delete/write_file/remove_file)逐步干活;每步的工具调用与结果写进 sidecar 的 **trace**(活动页签可见)。
- **两道保护闸**(对齐 Hermes):① **provenance**——只有带 `created_by: agent` frontmatter 标记的 skill 归 curator 管,你手写的 skill 一律拒改(fail-closed);② **read-before-write**——fork 必须先 `skill_view` 读过目标才能 patch/edit 它,不许凭对话印象盲改。
- **catalog 集成零接线**:skill 落点就是 dsh 自带的用户 skill 根(`$DSH_HOME/skills`,含 junction 联接),dsh 的 filesystem skill provider 热发现——新 skill 自动出现在所有会话的 skill 目录里,前台用原生 `skill` 工具加载;`skillReview: false` 可关掉 skill 路(退回纯 memory review)。
- **模型路由**(对齐 Hermes):review 默认跟会话同 provider/model 全量重放(吃前缀缓存);`reviewProvider`/`reviewModel` 指到异模型时改发 digest 回放(末尾 24 条 + 早期合成摘要),冷缓存省 token。
- 与 Hermes 的三处有意偏差:provenance 标记存 frontmatter 而非遥测台账(规避记录缺失竞态);skill 工具只在 fork 循环内注册(前台创建 skill 用普通文件工具,产物无标记即受保护);不移植 skill_usage 使用遥测。
- 注意:skill 建的勤不勤取决于模型对指令的遵守度(Hermes 原文同款提示词;"Be ACTIVE");库全是 user-owned 时弱模型可能保守地说"Nothing to save"——`/memory review <focus>` 可以点名让它建。

## 库维护(curator,v4)

skill 库只进不出会退化成一堆一次性窄条目。v4 移植 Hermes 的第二层维护(`agent/curator.py` 的 curator run):与 turn 级 review 独立的周期性**库自身**审查。五件事:

1. **使用遥测**:前台每次真实使用 skill(dsh 原生 `skill` 工具成功加载,或 `/名字` 手动调用)在 sidecar 的 `skill_usage` 表记一笔(次数、时刻)。fork 内部的巡库读取**不**计数——维护性读取计入会把所有 skill 刷成 active,致盲 stale 检测。
2. **确定性 stale 标记**(零破坏):每次 curator run 先重算生命周期状态——用过但超过 `curatorStaleAfterDays` 没再用 → 标 `stale`;从没用过的给一个同窗宽限(「无使用是证据缺失,不是过时证据」);pinned 一律豁免;再次被用即回 `active`。标记只是给 LLM pass 的证据输入,自己不动任何文件。
3. **LLM 归并 pass**(`curatorConsolidate`,默认开):后台 fork(Hermes CURATOR_REVIEW_PROMPT 平移)对着全库清单做 umbrella 化——前缀簇归并成带小节的类级 skill、窄条目降级成 `references/` 支持文件、确认废弃的删除。硬规则:只动 `created_by: agent` 的;pinned 禁碰;删除前必须本 run 内 `skill_view` 过(read-before-write 闸强制);umbrella 必须建在库根层(dsh 只发现深度 1)。
4. **run 前快照**:每次将要有损的 run 前,把全部 curator-managed skill 目录 + 遥测表复制到 `$DSH_HOME/skill-backups/<时间戳>/`,保留 `curatorMaxBackups` 份轮替。**恢复是手工的**:把 `<时间戳>/<名字>/` 拷回 `$DSH_HOME/skills/` 即可;**不要**贴回旧遥测——旧的 lastUsedAt 会让它立刻再被标 stale,让下个 run 重新 seed(宽限重启)才对。
5. **调度**:常驻 server 没有「agent 空闲」原语,用近似——每小时探一次,`用户空闲 ≥ curatorMinIdleHours` 且 `距上次 run ≥ curatorIntervalHours` 才触发;活跃度只认真实用户动作(用户消息、turn 结束),标题补写等后台事件不算。首次装载只锚定周期不立刻跑;重启后至少等满一个空闲窗。同一时刻只允许一个 run(手动/调度撞车,后到者拒绝)。

与 Hermes 的两处**有意偏离**:归并 pass 默认**开**(Hermes 默认关——我们的定位是无人审查的自动库,靠快照+read-before-write 兜底而非人审);**无 archive 层**,delete 就是真删(Hermes 的 `.archive/` 90 天档在无人审查前提下是死重)。

## 主题文件(渐进式披露细节层,v5)

注入侧本来已是渐进式(条目一行一条,索引即全文)。v5 补的是**索引后面的那一层**(蓝本:Claude Code auto memory——MEMORY.md 索引每会话只注前 200 行/25KB,主题文件按需读,2026-08-16 官方文档核实):

- **结构**:`~/.dsh/memory/topics/<名字>.md`(kebab-case 命名)。细节(命令示例、排错叙事、部署拓扑)写进主题文件;索引条目保持一行,行尾挂指针 `→ topics/<名字>.md`。**主题文件不进系统提示**,模型按需用 `memory_topic` 工具的 `topic_read` 读。
- **`memory_topic` 工具**五动作:`topic_list` / `topic_read` / `topic_write` / `topic_append` / `topic_remove`。与 `memory` 工具分立(dsh 输出 schema 方言限制,且读写契约更干净)。
- **读出默认有界**:`topic_read` 默认返回前 `topicReadLines`(400)行 + `topicReadMaxBytes`(8192)字节帽,截断会教模型用 `offset=N` 续读(1-based,对齐 dsh read 工具)。存储上限(32768)和读出上限是两个数。
- **分级 read-before-write 闸**:覆盖已存在文件、删除,要求本上下文先**完整读**过(截断读不开闸,报错教「读完剩余部分再重试」);追加只需任意读过;新建免读;**写入即知情**(topic_write 后该文件算完全知情,append 不升级)。粒度:前台按会话、后台 fork 按 run。闸的补偿效应:被删/被覆盖的正文必然完整进过会话日志,误删可从 session log 人工捞回——这是主题层不上快照的底气。
- **扫描是子集**(`scanBulk`):主题内容只在显式 topic_read 时以工具结果出现(与 fs 读普通文件同级,dsh fs 读零扫描),所以条目扫描里的语义规则(injection.*、exfil.send-url)和多行禁令不作用于主题文件;保留的只有隐蔽夹带三规则(zero-width/bidi/tags)和 exfil.md-image(防的是人——markdown 预览会拉远程图;报错教改成普通链接)。
- **指针保全**:compact 指令、溢出报错、GUIDANCE 三处都写明「`→ topics/<name>.md` 结尾的条目是索引指针,合并时必须保留」——否则压缩会把指针条目当普通条目丢掉,细节文件变孤儿。孤儿(没有任何索引引用的主题文件)在 `/memory topics` 和设置页文件页签可见。
- **review fork 自动获得**:fork 的工具面来自会话 header,工具注册即到位;review 指令在 topicsEnabled 时追加一段 TOPIC_ADDENDUM(两个正例一个反例:部署拓扑→主题文件;怎么调试一类崩溃→skill references,不是主题文件)。
- 索引预算 2200/1375 **不动**——溢出压力正是把细节赶进主题层的动力。

## 设置页与 /memory 命令

- **设置页**:dsh web 设置导航里的「记忆」页(settings.section 注册),三个页签:
  - **文件**:MEMORY.md / USER.md 两区,各带用量条与条目列表;条目可内联编辑、两击确认删除、输入框新增;尾部列主题文件清单(名称/大小/孤儿徽标,只读)。面板编辑**不走审批闸、不受扫描拒写**(操作者就是审批人);会被扫描命中的条目带三角警示标记,仅提示不拦截。
  - **技能**:后台 review 沉淀的 curator skill 一览(只显示 `created_by: agent` 的;你手写的 skill 不属于这里),v4 起每行带遥测:用过几次/最近何时、沉寂(stale)标记、置顶(pinned)标记。
  - **活动**:后台 review 与 curator 记录列表(curator run 显示为「库维护」)。每条一行摘要(时间、类型、人话结论:存了几条/动了哪些 skill/没有新内容)+ 人性化时长;失败行只显示清理后的错误单行(嵌套 JSON 已解开);逐步工具调用 trace 收在「过程(N 步)」折叠里,Refresh 拉取。
- **`/memory`**:输出两文件用量头与条目全文(任意端)。
- **`/memory review [focus]`**:立刻对当前会话跑一次后台 review(绕过触发策略,记为 manual);focus 文本会追加进 review 指令(对齐 Hermes 的 /refine 聚焦语义),如 `/memory review 把刚才的调试过程存成 skill`。
- **`/memory skills`**:列出 skill 库(名称 + 描述 + user-owned 标记 + 遥测列 `[use=N state=… pinned]`)。
- **`/memory topics`**:列出主题文件(名称 + 大小),没有任何索引条目引用的标 `[orphan]`。
- **`/memory compact`**:一次 LLM 调用产出合并方案并**直接应用**(store.rewrite,同锁内原子写路径)——跑这条命令本身就是授权,没有审批环节;回复里给出前后条目数与用量对比。方案畸形或安全扫描命中时一个字不写。
- **`/memory curator`**:立刻跑一次库维护 pass(绕过 idle/interval 门,与调度触发互斥);回复里带 sweep 结果、动作计数、快照位置。
- **`/memory curator status`**:上次 run/下次预计/最近用户活跃/库形状(curator-managed、stale、pinned、user-owned 各几个)。
- **`/memory pin <名字>` / `/memory unpin <名字>`**:置顶豁免——pinned 的 skill 跳过 stale 标记、LLM pass 硬规则禁碰。
- **`/memory adopt <名字>`**:把你手写的 skill 移交给 curator 管(frontmatter 补 `created_by: agent`,其余键原样保留)——移交后它进入自动归并/删除的管辖范围。
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
- 主题文件:`$DSH_HOME/memory/topics/<名字>.md`(v5 细节层)。纯文本,可手工检查/编辑/删除;删了记得把指向它的索引条目一并清掉(否则留下死指针,反之则成孤儿)。
- skill 库:`$DSH_HOME/skills/`(dsh 自带用户根,与手写 skill 混居,靠 `created_by: agent` 区分管辖)。
- curator 快照:`$DSH_HOME/skill-backups/<时间戳>/`(每次有损 run 前自动留,轮替保 `curatorMaxBackups` 份)。
- review / curator 记录与使用遥测:storage-domain sidecar(`memory_hermes` 域,后端介质由 storage 层决定)。
- 卸载:`dsh plugin --profile web remove dsh-memory-hermes`。数据文件不会被删,不要了手工删 `$DSH_HOME/memory/`、`$DSH_HOME/skill-backups/`;`$DSH_HOME/skills/` 里的 skill 是通用资产,留不留看你。

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
- `topicsEnabled` 的行为半边(动作运行时拒绝、review 不追加 addendum)热生效,但工具 schema 是 apply 时静态注册的——schema 半边(动作从工具列表消失)要重载插件才变。同理,minimal preset 的会话没有 GUIDANCE 段落(persona complete 抑制装配期追加),memory_topic 只能靠工具描述自行发现,与 memory 工具现状一致。
- **code preset 会话的后台 review 整体不可用**(v3 起既有边界):code 模式下所有工具调用都走 `run_code` 包装,而 review fork 按名分发、拒绝 run_code——memory 写与 memory_topic 写在这些会话里都会被拒。standard preset 不受影响。
- `topicsEnabled: false` 时,overflowError 与 GUIDANCE 基线段里的「写进主题文件」文案不会跟着关(这两处拿不到开关,修起来成本高于收益);工具运行时会拒绝,以工具报错为准。
- 手工建的非 kebab-case 主题文件(如 `My Notes.md`)在 `/memory topics`、面板、`topic_list` 三处都不可见——模型本来也寻址不到它们,合理;它们只占磁盘。
- 读闸的新鲜度用「字节数 + 行数」做代理:**等长同行的整体重写检测不到**(如 `aaaa\nbbbb\n` → `cccc\ndddd\n`)。触发条件极苛刻,且重写者自己必被闸要求完整读过(内容进过它的上下文),补偿论证换个会话仍成立;要彻底堵就把 evidence 的字节数换成内容 hash,暂不值得。
- 面板刷新是拉取不是推送(dsh 的 client 推送通道是白名单制,插件进不去):别处写入(模型工具 / review / 另一进程)后,点 Refresh 或重开设置页才可见。
- 插件**不**往 session 日志 append 自定义事件类型:dsh 的日志事件词汇是白名单制,未知类型会让整份日志重放被拒。自省可观测性走 sidecar,不走日志。

## 实测

装载后按 [docs/playbook.zh.md](docs/playbook.zh.md) 走一遍:写入→fresh 召回→冻结→溢出→扫描→审批→session-query→并发→模型矩阵→卸载→后台自省→设置页。
