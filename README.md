# dsh-ccswitch-usage

把 **DeepSeek Harness（DSH）** 每次模型调用消耗的 token 记进 **CC Switch** 的用量统计，
让 DSH 和 Claude Code、Codex、OpenCode 这些 CLI 一起出现在 CC Switch 的用量面板里。

## 它做什么

DSH 每完成一次模型调用，都会在会话日志里写一条 `assistant/message`，带
`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`。
本插件监听这个事件流，把每次调用折成一行用量，写进 CC Switch 的
`proxy_request_logs` 表（`app_type = 'dsh'`）。

写进去之后：

- **总用量 / 成本 / 缓存命中率** 含 DSH 的数据；
- **模型统计**里能看到 DSH 用过的模型；
- **请求明细**里能逐条看到每次调用；
- 费用按 CC Switch 自己的 `model_pricing` 表计算，和它算别的应用用的是同一张价目表。

首次启用时会自动回填历史会话（幂等，可反复执行）。

## 安装

### 桌面版（DeepSeek Harness.app）

桌面版独占管理 `desktop` profile，**必须用 App 自带的 CLI**。
普通的全局 `dsh` 命令会被拒绝：

```
$ dsh plugin --profile desktop add ...
error: profile "desktop" is managed exclusively by the Electron application
```

改用 App 内的 CLI（注意是**整条路径**，不是 `dsh`）：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /path/to/dsh-ccswitch-usage
```

实测输出：

```
dependencies:
+ dsh-ccswitch-usage 0.1.0 <- ../../../path/to/dsh-ccswitch-usage
Done in 2s using pnpm v11.28.5
```

这条命令会做三件事：

1. 装进 `~/.dsh/profiles/desktop/node_modules/`（`link:` 依赖，软链到源码目录）；
2. **自动把包名追加到 `dsh.profile.bundles`**——`dsh plugin` 在 pnpm 成功后执行
   `reconcile()`，凡是新装且声明了 `dsh.bundle` 的包都会被加进 bundles，不需要手工编辑；
3. 更新 `pnpm-lock.yaml`。

生效时机：**下次 DSH 启动时加载**。如果 App 正在运行，插件要等它重启（Cmd+Q 再打开）
才会挂上——插件是 Host 侧代码，刷新网页不够。
(实测中 App 会在 profile 变更后自行重新加载，此时无需手动重启；但不要依赖这一点，
以重启为准最稳。)

验证装上了：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop list | grep ccswitch
```

卸载：把 `add` 换成 `remove dsh-ccswitch-usage`。

### 非桌面版 / 自建 profile

```bash
dsh plugin --profile <profile 名> add /path/to/dsh-ccswitch-usage
```

### 手动安装（不想用 CLI 时）

编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "dsh-ccswitch-usage": "link:/绝对路径/dsh-ccswitch-usage"
  },
  "dsh": { "profile": { "bundles": [ "...", "dsh-ccswitch-usage" ] } }
}
```

然后在 profile 目录装依赖并重启：

```bash
cd ~/.dsh/profiles/desktop
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop install
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖默认值：

```yaml
- id: dsh-ccswitch-usage
  name: dsh-ccswitch-usage
  config:
    enabled: true
    ccSwitchDbPath: ''      # 留空 = $CC_SWITCH_HOME/cc-switch.db，否则 ~/.cc-switch/cc-switch.db
    backfillOnStart: true   # 启动时补历史用量
    refreshPricing: true    # 60 秒后重新读定价，改价无需重启
```

## 数据落在哪

只写两张表，字段与 CC Switch 自带的会话导入器（`session_usage_dsh.rs`）逐字段一致：

| 表 | 用途 |
|---|---|
| `proxy_request_logs` | 一条记录 = 一次模型调用 |
| `session_usage_dedup` | 去重台账，`request_id = 'dsh:<message.id>'` |

| 列 | 值 |
|---|---|
| `app_type` | `dsh` |
| `provider_id` | `_dsh_session`；DeepSeek 账号路由为 `_dsh_account_session` |
| `data_source` | `dsh_session` |
| `input_token_semantics` | `2`（FRESH）— DSH 的 `inputTokens` 不含缓存 |
| `session_id` | DSH 的会话 id |

**为什么刻意照抄官方导入器**：CC Switch 的 master 分支已经内置 DSH 导入器。
本插件产出**同样的行**，所以将来升级到带原生导入器的版本时，双方的
`INSERT OR IGNORE` 会互相跳过，**不会重复计数**。

## 已知限制

- **本机装的 CC Switch 4.0.21 用量面板顶部没有单独的 "DSH" 筛选按钮**
  （它的 `KNOWN_APP_TYPES` 里还没有 `dsh`）。数据照常计入总量、模型统计和请求明细，
  只是不能单独按 DSH 过滤。等 CC Switch 发布带 DSH 导入器的版本，筛选项会自然出现，
  历史数据已经写好了。
- 只有**走完一次完整模型调用**才记账。失败的调用（`assistant/attempt`）没有用量数据，
  不记账——和 CC Switch 官方导入器口径一致。
- 拿不到 `step/start` 时间戳的调用，`latency_ms` 记 0。
- **不做 LIKE 前缀查价兜底**：定价表里没有精确命中的模型记 0 成本，而不是猜一个价。
  行本身是正确的，CC Switch 日后补价时可以重算。
- CC Switch 正在写库时会 `SQLITE_BUSY`，插件重试后跳过并记一条 warn，不卡会话。

## 卸载

从 profile 依赖和 `dsh.profile.bundles` 移除即可。已经写进 CC Switch 的用量
**不会**被删除——那是 CC Switch 的数据。

## 开发

```bash
npm test              # 94 个单元 + 集成测试
npm run smoke         # 用假 Cordis 上下文驱动一次完整调用
npm run edge-cases    # 定价/精度/事务回滚等边界
npm run concurrency   # 回填与实时写入并发
npm run dry-run       # 对真实 CC Switch 库的**副本**演练回填（绝不写线上库）
```

架构与模块契约见 [docs/CONTRACT.md](docs/CONTRACT.md)。

### 设计取舍

- **零运行时依赖**：`lib/` 只 import Node 内置模块。不碰 `@deepseek-ai/*`，
  这样插件在裸 `node`、Electron 的 Node、以及 DSH 自己的模块图里都能加载。
- **写库完全脱离会话路径**：事件监听只做折叠和入队，串行 drainer 做 SQLite。
  任何失败只记日志，绝不把异常抛回会话。
- **为什么必须逐帧解 zstd**：DSH 的 `.zstd` 日志是首尾相接的独立帧，
  整文件 `zstdDecompressSync` 只会解出第一帧（实测 235 字节 / 全文件数百 KB）。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
