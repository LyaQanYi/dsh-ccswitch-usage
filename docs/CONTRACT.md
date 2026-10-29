# 架构与模块契约

> 本文记录**已实现**的架构，不是计划稿。改动接口前先改这里。

## 关键背景

1. **DSH 的 token 是互斥计数**：`inputTokens` 只含未命中缓存的新增输入，
   `cacheReadTokens` / `cacheWriteTokens` 单独上报。
   → 写 CC Switch 时用 `input_token_semantics = 2`（FRESH），计费时**不要**再减缓存。
2. **CC Switch 的 master 分支已内置 DSH 导入器**（`session_usage_dsh.rs`；
   本机装的 4.0.21 还没有）。本插件刻意产出与它**逐字段一致**的行：
   `app_type='dsh'`、`provider_id='_dsh_session'`、`data_source='dsh_session'`、
   `request_id='dsh:<message.id>'`、以及 `session_usage_dedup` 台账。
   这样两套实现共存时 `INSERT OR IGNORE` 互相跳过，**不会重复计数**。
3. **零运行时依赖**：`lib/` 只 import Node 内置模块。DSH 的插件在它自己的模块图里
   运行，但保持入口无外部 import 意味着它在裸 node / Electron node / DSH 里都能加载。
4. **本机 CC Switch 4.0.21 的 `KNOWN_APP_TYPES` 没有 `dsh`**，所以用量面板顶部的
   应用筛选按钮暂时没有单独一项；总量/模型统计/请求明细都包含这些行。
5. 本机 DB `~/.cc-switch/cc-switch.db`：`journal_mode=delete`（非 WAL），
   所以必须设 `busy_timeout` 并容忍 `SQLITE_BUSY`。`proxy_request_logs` 无外键。

## 模块

| 文件 | 职责 |
|---|---|
| `lib/zstd-frames.js` | 扫描拼接 zstd 帧、逐帧解压、读纯 JSONL |
| `lib/extract.js` | 会话事件 → `UsageRecord`（有状态折叠） |
| `lib/ccswitch-db.js` | 路径解析、开库、定价、幂等写入 |
| `lib/backfill.js` | 扫描历史会话日志并回填 |
| `lib/index.js` | Cordis 插件入口：订阅事件、队列、串行 drain、卸载 flush |

## 数据模型

```js
/** @typedef {{
 *   requestId: string,     // 'dsh:<message.id>'；无 id 时 'dsh:'+sha256(事件JSON)
 *   model: string,
 *   sessionId: string,
 *   createdAtMs: number,
 *   latencyMs: number,     // step/start -> assistant/message；不可信时 0
 *   firstTokenMs: number|null,
 *   usage: { inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number },
 *   viaAccount: boolean,   // source.provider === 'deepseek-account'
 * }} UsageRecord */
```

## 各模块接口

### lib/zstd-frames.js

```js
export function scanZstdFrames(buf)      // => Array<[start, end)>  只结构扫描，不解压
export function readSessionLogSync(path) // => string  逐帧解压后拼接；读不到返回 ''
```

**为什么必须逐帧**：DSH 的 `.zstd` 日志是首尾相接的独立帧，整文件
`zstdDecompressSync` 只解出第一帧（实测 235 字节 vs 全文件数百 KB）。

### lib/extract.js

```js
export class UsageExtractor {
  constructor(sessionId)
  push(event) // => UsageRecord | undefined
}
export function extractRecords(jsonlText, sessionId) // => UsageRecord[]
export function parseJsonlLines(text)                // => unknown[]（坏行丢弃）
```

规则：
- 只处理 `assistant/message`；`data.usage` 四项 token 全 0 或缺 usage → 不产出。
- `latencyMs` = `event.time - stepStartTime`，只在 `[100, 3600000]` 内采用，否则 0。
- `firstTokenMs` = (stream 里 `time`/`time0` 最小值) - stepStartTime，须 `>0 且 <=latencyMs`。
- 产出后才清掉该 step 的起点（与 CC Switch 的 Rust 实现一致）。
- token 只接受正整数；缺省/负数/小数按 0。
- 模型 id 缺失 → `'unknown'`。

### lib/ccswitch-db.js

```js
export function resolveCcSwitchDbPath(explicitPath, env) // 显式 > $CC_SWITCH_HOME > ~/.cc-switch
export function openCcSwitchDb(path)                     // => DatabaseSync（busy_timeout=5000）
export function loadPricing(db)                          // => Map<小写 model_id, pricing>
export function resolvePricing(pricingMap, model)        // => { pricedAs, pricing }
export function pricingModelColumn(model, pricingMap)    // => string|null
export function insertUsage(db, record, pricingMap)      // => 'inserted' | 'skipped'
```

写入语义（与 CC Switch 官方导入器一致）：
- 同一事务（`BEGIN IMMEDIATE`）内先写 `session_usage_dedup` 台账，
  `changes===0` → `'skipped'`；再 `INSERT OR IGNORE` 明细行。
- 失败整体 `ROLLBACK`，台账不残留（有测试专门验证）。
- 金额是 TEXT，BigInt 精确运算，输出纯十进制、无科学计数法。
- 无定价 → 五项费用全 `'0'`，但行照写（`pricing_model` 记裸名，日后补价能重算）。
- `SQLITE_BUSY` 抛带 `code:'SQLITE_BUSY'` 的 Error，由调用方重试。

### lib/backfill.js

```js
export async function backfill({ db, pricingMap, sessionsRoot, logger, state, signal })
  // => { files, scannedFiles, inserted, skipped, errors }
```

- 只认 `session.<版本>.jsonl` / `.jsonl.zstd`；会话目录名即 sessionId。
- `state.files[path] = { mtimeMs, size, inserted }` 让未变文件免读。
- 单文件失败进 `errors`，不中断整轮。

### lib/index.js

```js
export const name = 'dsh-ccswitch-usage'
export const Config = { '~standard': { version: 1, vendor, validate } }  // Standard Schema
export function apply(ctx, config)
```

- 订阅 `ctx.on('session/event')`：只做折叠 + 入队，**绝不在事件路径上做 IO**。
- 串行 drainer：并发调用共享同一个 `state.draining` promise，保证写入有序且不并发开事务。
- `enabled` 只 gate 监听器，不 gate drain —— 卸载时先关监听再 flush 队列。
- `ensureDb` 失败按指数退避重试（15s 起，上限 5min），不永久禁用。
- `ctx.effect` 的 disposer 在卸载时 flush 并关库；Cordis 会 await 它。
- 回填状态持久化在 `$DSH_HOME/cache/dsh-ccswitch-usage/backfill-state.json`。

## 测试

`npm test`（`node --test`）。**绝不能写真实 `~/.cc-switch/`**：
所有测试用 `node:os` 临时目录建库。

| 文件 | 覆盖 |
|---|---|
| `test/zstd-frames.test.js` | 帧扫描边界、残缺尾帧、多帧拼接、纯 JSONL |
| `test/extract.test.js` | 折叠规则、latency/firstToken、去重 id、异常输入 |
| `test/ccswitch-db.test.js` | 字段映射、幂等、定价回落、金额精度、事务回滚 |
| `test/backfill.test.js` | 目录遍历、幂等、坏文件隔离、状态游标 |
| `test/integration.test.js` | 端到端：事件 → 库行 → 聚合口径 |
| `test/plugin.test.js` | 插件入口：配置、挂载、卸载 flush、重试、零外部依赖 |

### 验证脚本（`scripts/`，不在 npm test 里）

| 脚本 | 作用 |
|---|---|
| `npm run smoke` | 用假 Cordis 上下文驱动一次完整调用 |
| `npm run edge-cases` | 定价/精度/事务回滚等对抗性用例 |
| `npm run concurrency` | 回填与实时写入并发 |
| `npm run dry-run` | 对真实库**副本**演练回填（绝不写线上库） |
| `npm run cordis-mount` | 用 DSH 真实的 Cordis 运行时挂载插件并验证落库 |


## 审查后加固的地方（2026-10-30）

独立审查发现并已修复的问题，改代码前请先读这节：

1. **卸载时静默丢数据（已修）**：原实现 `drain` 先 `shift` 再开库，开库失败就直接丢。
   现在记录**留在队首**，只有写成功或确定不可重试（schema 拒绝）才出队；
   卸载时若仍有残留，会明确 warn 一条「N 条未能写入，下次启动由回填恢复」。
2. **卸载时的重试退避（已修）**：`ensureDb(force=true)` 让 disposer 的最后一次 flush 忽略退避窗口。
3. **drain 无限递归（已修）**：记录取不出队时不能再次调度 drain，否则死循环。
   只有「本轮至少成功 retirement 了一条」才继续排下一轮。
4. **队列无界（已修）**：上限 `QUEUE_MAX_DEPTH=10000`，超出丢最旧的并计数；
   丢弃是可接受的，因为用量永远能从会话日志回填。
5. **backfill 与卸载无同步（已修）**：`AbortController` + `state.backfillPromise`，
   disposer 先 abort 再 await，避免在已关闭的句柄上刷一批错误。
6. **closed 错误识别太窄（已修）**：除 `database is not open`/`database is closed`，
   还匹配 `Cannot use a closed database` 与 `database connection is not open`。

### 有意不修的

- **drop 的队列项不落盘**：用量在会话日志里，下次启动回填即可恢复，
  为它加一个持久化队列属于过度设计。
- **单文件全量解压**：实测 20 个会话 / 2.6 秒 / 峰值 +31MB、GC 后回落，
  最大单文件 2.3MB。流式解压会把代码复杂度翻倍而收益很小。
- **不做 LIKE 前缀查价**：宁可 0 成本也不猜错价；行本身正确，CC Switch 补价时可重算。

### 审查确认无问题的部分

`requestId` 去重键、`input_token_semantics=2`、费用不减缓存（`CACHE_INCLUSIVE_APP_TYPES`
不含 `dsh`，**不会少算钱**）、`pricing_model` 规则、`INSERT OR IGNORE` 两步法 ——
与 `session_usage_dsh.rs` 逐字段一致，**未发现重复计数**。
