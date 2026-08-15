# dsh-memory-hermes

Hermes 式有界策划记忆,做成 DeepSeek Harness(dsh)的用户侧插件。不改 dsh 本体,`dsh plugin add` 即装即用。

设计蓝本是 Nous Research Hermes Agent 的记忆系统:**小容量、模型自己策划、每 session 冻结注入**。与「越攒越多的记忆库」相反,它逼着模型维护一份精炼的长期事实清单。

## 机制速览

| 机制 | 行为 |
|---|---|
| 双文件 | `MEMORY.md`(agent 笔记,默认 2,200 字符)+ `USER.md`(用户画像,默认 1,375 字符),存于 `$DSH_HOME/memory/` |
| 单工具 | `memory`,action 枚举 `add / replace / remove`,**没有 read**——内容已在系统提示里 |
| 冻结快照 | session 开始时读一次注入系统提示,会话内不再变(prompt-cache 友好);会话内写入落盘、工具结果回显实时态,下个 session 才进快照 |
| 定位条目 | `replace`/`remove` 用唯一子串匹配,**条目全文精确匹配优先**(条目互为子串时的逃生口);0 命中或多命中报错,错误里附**锁内实时盘面**的条目全文(快照可能过期,这是模型的自救通道) |
| 溢出纪律 | **增长型**超限写入不落盘,报错附当前全部条目,并要求**当轮合并重试、不丢新信息**;缩小型操作(remove/变短的 replace)总是放行——文件已超限(调小上限/手改)时才能逐步收敛回来 |
| 安全扫描 | 写入时 + 注入渲染时 + **错误载荷**三处同一规则表:不可见 Unicode、注入话术、外传形状;命中即拒/隐藏 |
| 审批闸门 | `approval: true` 时每次写走 dsh 审批(默认关) |
| 并发安全 | 进程内 promise 链串行 + 跨进程 `.lock` 文件锁 + 原子写(照 dsh settings-file 同款姿势) |

## 安装

前置:Node 22+,dsh CLI 可用。

```bash
cd dsh-memory-hermes
npm install
npm run build
```

```bash
dsh plugin --profile memory-lab add "C:/Users/<你>/OneDrive/Desktop/dsh-memory-hermes"
```

- profile 首次使用自动创建;装完 `dsh --profile memory-lab --dump-config` 应能看到 `memory-hermes` 层。
- 目录在 OneDrive 下如遇 link 异常,把整个目录复制到本地盘(如 `C:\dev\`)再 add。

## 配置

四个配置项,全部可省(schema 默认兜底)。改法:在 profile 的用户层 patch(`$DSH_HOME/profiles/memory-lab/cordis.patch.yml`)加一条 id 覆盖:

```yaml
- id: memory-hermes
  name: dsh-memory-hermes
  config:
    memoryCharLimit: 2200   # MEMORY.md 上限(codepoint 计),最小 200
    userCharLimit: 1375     # USER.md 上限,最小 200
    securityScan: true      # 写入+注入双侧扫描
    approval: false         # true = 每次写弹审批
```

注意:id 覆盖是**整体替换 config,不深合并**——要改就把想要的字段写全(未写的字段回 schema 默认,恰好也是安全的)。

## 数据与卸载

- 记忆数据:`$DSH_HOME/memory/MEMORY.md` 与 `USER.md`(`$DSH_HOME` 默认 `~/.dsh`)。纯文本,每行一条 `- ` 前缀,可手工检查/编辑;手改在**下个 session** 生效。
- 卸载:`dsh plugin --profile memory-lab remove dsh-memory-hermes`(`dsh plugin` 就是 pnpm 转发)。数据文件不会被删,不要了手工删 `$DSH_HOME/memory/`。

## 已知边界(设计取舍,非 bug)

- **扫描是启发式denylist,不是完整防御**。真正的边界是:记忆文件是你本地的、可手工检查的纯文本。已知误伤(接受并文档化):
  - ZWJ 组合 emoji(如家庭 emoji)会被 `invisible.zero-width` 拒——零宽段整段拒收;
  - "post/send … https://…" 的名词歧义句可能被 `exfil.send-url` 误拒;
  - 「system prompt」这个短语**刻意不封**(harness 研究笔记的合法高频词)。
- 条目里的相邻花括号 `{{` 在系统提示里显示为 `{ {`(盘上原文不变)——dsh 对提示 section 做严格 `{{name}}` 模板插值,不打断会让整个 session 组装崩溃。
- 写入用 0o600/0o700 权限位;**Windows(NTFS)上 Node 只落实只读位**,「仅属主可读写」不生效,真正的访问控制靠 `~/.dsh` 继承的用户目录 ACL。别把 0o600 当成 POSIX 级「仅我可读」。
- 记忆文件目录并发写有跨进程 `.lock` 文件锁;若写入进程被强杀留下孤儿锁,后续写会等 2 秒后报 `MEMORY_LOCK_BUSY`,错误里带锁文件路径——确认没有别的 dsh 进程在跑后手工删掉即可。
- 原子写不 fsync(与 dsh settings 同款):崩溃可能丢最后一笔写,下个 session 读盘上现状即可。
- 错误的 `code` 字段是 best-effort:`link:` 安装可能出现 `HarnessError` 双副本导致 code 丢失,因此**模型需要的信息全部在 message 文本里**,不依赖 code。
- 溢出上限按 codepoint 计(与 Hermes 的 Python `len()` 一致);中文信息密度高,同字符数装得下更多事实,嫌紧可调大。

## 实测

装载后按 [docs/playbook.zh.md](docs/playbook.zh.md) 十步走一遍:写入→fresh 召回→冻结→溢出→扫描→审批→session-query→并发→模型矩阵→卸载。
