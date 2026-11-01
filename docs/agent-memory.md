# 智能体记忆（agent-memory）

一句话：PiDeck 给**所有后端**（pi / DSH / ACP）提供同一份长期记忆——Markdown 是唯一真值，SQLite 只是索引，经由一个本地 stdio MCP 服务器以工具形式暴露。

对齐的参考实现是 `pi-hermes-memory`（pi 扩展），复刻它的取舍见文末「与 hermes 的差异」。本文件是这一领域的唯一设计入口；宿主通道边界另见 `docs/host-boundaries.md` 例外八。

**状态**：M2 已完成（服务器 + 采集 + pi/ACP 挂载 + 两个测试文件）。DSH 侧为设计待办，见 §5。

## 1. 为什么是「独立 stdio MCP 服务器」

| 方案 | 三后端覆盖 | 结论 |
|---|---|---|
| 宿主内建领域模块 | pi 只能靠系统提示注入；ACP 需要 PiDeck 转发 ACP 会话 | 排除 |
| pi 扩展（像 hermes 那样） | 只覆盖 pi，另外两个后端要各写一遍 | 排除（M1 的教训） |
| **stdio MCP 服务器** | pi 内置 MCP 支持 `command` 形态；ACP `session/new` 的 `mcpServers` 也只有 stdio 形态 | **采用** |

同一份代码、同一份数据、三端零重复实现；不需要监听端口、不需要令牌、不需要新增 IPC。脚本在 `resources/agent-memory/`，随包进 `extraResources`；宿主编排在 `src/main/agentMemory/`（注意与内存剖析的 `src/main/memory/` 不是同一领域）。

进程由宿主用 `ELECTRON_RUN_AS_NODE=1 <electron> server.mjs` 拉起，因此跑在 Node 24 上，`node:sqlite`（含 FTS5）可用。

## 2. 存储模型

```
<userData>/agent-memory/
├── MEMORY.md              # 全局事实（预算 8000 字符 / 120 条）
├── USER.md                # 用户画像（4000 / 60）
├── STANDING.md            # 常驻指令（4000 / 40，暂无写入工具）
├── failures.md            # 教训，条目带 [category] 前缀（8000 / 120）
├── projects/<projectKey>/MEMORY.md + failures.md
└── memory.db              # SQLite 镜像 + 会话索引（可随时删，自愈重建）
```

- **条目格式**：条目之间用 `\n§\n` 分隔，纯文本，用户用任意编辑器都能改。解析宽容空行/CRLF。
- **projectKey**：由会话 `cwd` 派生（`C--Users-me-proj` 形态），跨后端共享——同一个项目在 pi 和 ACP 里看到的是同一份项目记忆。
- **Markdown 是真值**：SQLite 只是可重建的镜像。任何写入先落 Markdown，再对账索引；索引坏了不影响读写与检索（退化为子串匹配）。
- **预算**：超预算从**最老的**条目开始丢（文件按追加顺序排列）。单条上限 2000 字符。
- **去重**：折叠空白后比对，同一句话重复写不会产生第二条。
- **原子写**：同目录临时文件 + rename，不产生半截文件。

## 3. 工具面（7 个）

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `memory_add` | 写一条事实 | `target` ∈ memory/user/project/failure；project 必须有 projectId |
| `memory_replace` | 改一条（事实变了用它，别加第二条） | 定位必须唯一，歧义报 `entry-ambiguous` |
| `memory_remove` | 删一条 | 同上 |
| `memory_search` | 全文检索（全局+项目+教训） | target 过滤在 FTS 与 LIKE 两条通道都生效 |
| `memory_get` | 按 target 列举（旧→新） | 分页 |
| `session_search` | 跨后端检索历史会话 | 采集源为空时报 `session-sources-empty` |
| `memory_status` | 预算用量 + 索引规模 | 用于诊断「记忆到底有没有在工作」 |

业务错误走 MCP `isError: true` + `{ok:false,error:{code,detail}}`，模型能据此自我纠正；协议错误才走 JSON-RPC error。单条请求失败不会杀掉服务器（客户端会判定服务器已死）。

**消息 id 只在会话内唯一**：PiDeck 的 fork 会话是父会话的字节前缀副本，两边共享同一批 pi entry id。`messages` 表因此用 `rowid` 主键 + `(session_id, msg_id)` 唯一索引——用全局主键会让 fork 插入撞键、整份事务回滚（首次实测 676 会话里失败 199 个）。

## 4. 三端挂载

**总开关 `settings.agentMemoryEnabled`，默认 `false`**（设置 → 通用 → 智能体记忆）。关闭时不注册、不写用户 `mcp.json`、不给 ACP 会话挂工具，与引入前完全一致；开启后启动即幂等注册，设置里改了立刻同步（`syncAgentMemoryRegistration`：开→注册、关→只删自己那一项）。关掉开关不删记忆文件。

| 后端 | 机制 | 状态 |
|---|---|---|
| pi | 写 `~/.pi/agent/mcp.json` 的 `pideck-agent-memory` 条目（`planPiMcpRegistration` 只增改自己那一项，`mcpServers` 形状不对就跳过而不是抢修覆盖；脚本不存在时不写悬空条目） | ✅ 已验证落盘 |
| ACP | `AcpHandshakeDeps.mcpServers(cwd)` → `session/new` 与 `session/load` 的 `mcpServers`；`AcpMcpServer = {name,command,args?,env?}`；开关关闭时给空数组（该字段必填） | ✅ 类型检查 + 单测形态 |
| DSH | 见 §5 | ⛔ 未接 |

环境变量（`AGENT_MEMORY_ENV` + 实际值）是服务器唯一的配置入口：

- `PIDECK_AGENT_MEMORY_DIR`：记忆根（缺省时服务器**拒绝启动**——默认值会写到某个进程的 cwd 里，那是更坏的失败模式）
- `PIDECK_AGENT_MEMORY_PROJECT_CWD`：会话 cwd，用于推导项目键
- `PIDECK_AGENT_MEMORY_SOURCES`：会话采集源 JSON `[{backend:"pi"|"acp",dir,project?}]`，服务器自己不猜路径

## 5. DSH 为什么还没接

DSH 不走 MCP（`src/main/dsh/` 里没有 MCP 客户端），所以工具面进不去。可行的注入路径是它的 `dsh-agent-instructions` 插件的 `instructionFileCandidates`：宿主落一份 `AGENTS.memory.md` 到项目根的候选位置，DSH 自己读进上下文。

未做的原因：这等于给 DSH 造一条"记忆块文件"的新约定（还要处理候选优先级、`maxBytes` 截断、与用户自己的 `AGENTS.md` 冲突），且 DSH 自带 `session_query` 系列工具，会话采集也可以交给它自己。属于独立的一次交付，不塞进 M2。

## 6. 安全

- **注入扫描**（写记忆、写技能都过）：零宽/双向控制字符、`ignore previous instructions` 类句式、疑似凭据（`AKIA…`、`sk-…` 等）。命中即拒绝，返回稳定错误码。
- **会话采集是只读的**：只读已落盘文件，跳过 system 消息（整份系统提示会把索引撑爆）、跳过工具结果（体量不可控），工具名单独入库便于"上次那个 grep 怎么用"这类检索。
- **单文件上限** 64MB、单会话保留最近 2000 条消息、单条入库消息截断到 `MAX_INDEXED_MESSAGE_CHARS`。超限跳过而不是让 MCP 进程吃满内存。
- **stdout 只放协议**：调试输出一律 stderr，否则客户端解析失败。
- **不写用户仓库**：一切路径都在 `<userData>` 下。

## 7. 验证

```bash
node --test tests/agentMemoryServer.test.mjs   # 工具层 + 协议层（真进程走 stdio）
node --test tests/agentMemoryMounts.test.mjs   # 挂载形态、mcp.json 合并/幂等/可撤销、开关动作、项目键
node --test tests/agentMemorySettings.test.mjs  # 开关默认关、非法入参、渲染层与主进程接线
node --test tests/zhTwCopy.test.mjs            # 改了 zh-CN 词典后必须重跑生成器
npm run typecheck
```

守卫测试固定的行为：重复写入幂等、目标隔离、写入扫描拒绝、替换/删除歧义报错、CJK 子串检索、target 过滤不漏、会话指纹未变时跳过、追加后整份重灌不重复、`system` 消息不入库、fork 会话共享消息 id 时两边都要入索引、`cwd` 必须能派生出项目键、mcp.json 损坏时不覆盖、打包/开发两态脚本路径。

## 8. 与 hermes 的差异

| 维度 | hermes | 这里 | 原因 |
|---|---|---|---|
| 学习循环 | 每 N 轮起子进程让模型从对话里提炼记忆 | 不做 | 三后端都跑得起的"提炼"要么各写一遍会话读取，要么给宿主加一条模型调用通道；先做确定性的工具面 |
| 常驻注入 | 每轮把记忆块塞进系统提示 | pi 不做（工具按需检索）；DSH 走 §5 | pi 走注入要改 pi 侧扩展，等于再开一条通道 |
| 纠正检测 | 三趟正则 + 挂起确认 | 不做 | 同上，依赖"每轮都看到对话" |
| 技能/合并/固化 | `skill_manage` + 自动 consolidator | 不做 | 记忆先跑通，技能库是另一条产品线 |
| 作用域键 | `<slug>-<sha1(path)>` | 派生 slug + 长路径哈希 | 同一意图，少一层哈希成本 |

## 9. 剩余工作（按价值排序）

1. **状态页**：`memory_status` 工具已能查预算与索引规模，但设置页还看不到（没有记忆文件大小/会话条数的展示与「清空索引」按钮）。
2. **DSH 注入**（§5）：落 `AGENTS.memory.md` + 候选配置。
3. **常驻指令 `STANDING.md` 的写入入口**：文件与预算已在，缺工具与 UI。
4. **采集扩容**：DSH 会话、`imported` 会话（claude/qoder 等）的 JSONL 都能接同一套解析器，只需加 adapter。
