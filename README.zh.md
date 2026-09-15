# dsh-codex-bridge

English | [中文](README.md)

把本地**已登录的 Codex CLI** 接入 DeepSeek Harness（DSH）作为模型提供方。无需重新登录、无需配置 API Key——插件通过 `codex exec --json --ephemeral` 驱动真实 CLI，认证、模型权限、配额与推理能力全部复用你现有的 codex 登录状态。

## 功能

- 在 DSH 模型选择页注册 `codex` 提供方路由
- 实时流式输出 `text-delta` / `reasoning-delta` / `usage`（来自 codex 的 JSONL 事件流）
- 自动发现 CLI 可用的模型（读取 `~/.codex/config.toml` 与 CC-Switch 模型目录）
- DSH 的推理强度选择映射到 `codex exec -c model_reasoning_effort`
- 绝不读取、存储或转发凭据——认证完全由 codex CLI 自己管理

## 前置条件

- DeepSeek Harness（`dsh`）web profile
- 已安装并**已登录**的 Codex CLI（`codex login status` 显示已登录）

## 安装

本地目录安装：

```sh
dsh plugin --profile web add D:/DshWorkspace/codex-bridge/dsh-codex-bridge
```

然后重启 DSH（`dsh web` 或重启桌面应用），在模型页选择 **Codex CLI (local login)** 提供方。

## 配置

插件零配置即可使用。可选设置写在 profile 的 `cordis.patch.yml`（`llm-codex-bridge` 条目）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `codexBin` | 自动解析 | codex 可执行文件路径（Windows 下会自动解析 npm shim 背后的原生 `.exe`） |
| `sandboxMode` | `read-only` | 传给 codex exec 的沙箱模式：`read-only`、`workspace-write`、`danger-full-access` |
| `cwd` | 进程工作目录 | codex exec 的工作目录 |
| `defaultReasoningEffort` | `high` | 请求未指定时使用的推理强度：`low`/`medium`/`high`/`xhigh`/`none` |

示例：

```yaml
- insert:
    - id: llm-codex-bridge
      name: dsh-codex-bridge
      config:
        sandboxMode: read-only
        defaultReasoningEffort: high
```

## 工作原理

1. DSH 的 agent loop 构建请求并选择 `codex` 提供方
2. 适配器把会话历史（system + 历史对话 + 最新用户消息）渲染为单个 prompt
3. 启动 `codex exec --json --ephemeral --skip-git-repo-check -s read-only -m <模型>`，prompt 写入 stdin
4. codex 的 JSONL 事件（`item.completed` 的 `agent_message`/`reasoning`、`turn.completed` 的 usage）实时翻译为 DSH StreamChunk
5. 关闭块、上报 usage、终止流——与其他 DSH 模型提供方完全一致

## 已知限制

- **codex 以完整 agent 身份运行**：每次请求都是一个全新的临时 codex 会话，它可能在配置的沙箱内使用自己的内建工具（如 shell）。它产出的文本作为 assistant 消息返回；其工具活动不会投影到 DSH 会话记录中。
- **对话历史以文本形式每轮重发**（跨模型稳健，但无提供方侧 KV-cache 复用）。
- **图片输入**仅在选择模型支持时宣告；DSH 文件/图片块当前渲染为占位文本。

## 许可证

Apache-2.0
