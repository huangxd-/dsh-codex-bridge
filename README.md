# dsh-codex-bridge

[中文](README.zh.md) | English

Use your locally logged-in **Codex CLI** as a model provider inside DeepSeek Harness (DSH). No re-login, no API key setup — the plugin drives `codex exec --json --ephemeral` so authentication, model access, quotas and reasoning all come from your existing `codex` login.

## What it does

- Registers a `codex` provider route in DSH's Models page
- Streams `text-delta` / `reasoning-delta` / `usage` chunks from codex's JSONL event stream
- Advertises the models your CLI can use (from `~/.codex/config.toml` + CC-Switch catalog)
- Maps DSH reasoning-effort selection to `codex exec` `-c model_reasoning_effort`
- Never reads, stores or forwards credentials — codex owns auth entirely

## Requirements

- DeepSeek Harness (`dsh`) with the web profile
- Codex CLI installed and **already logged in** (`codex login status` shows logged in)

## Install

From a local checkout:

```sh
dsh plugin --profile web add D:/DshWorkspace/codex-bridge/dsh-codex-bridge
```

Then restart DSH (`dsh web` or restart the desktop app) and pick the **Codex CLI (local login)** provider in the Models page.

## Configuration

The plugin works with zero configuration. Optional settings live in your profile's `cordis.patch.yml` under the `llm-codex-bridge` entry:

| Field | Default | Meaning |
|---|---|---|
| `codexBin` | auto-resolved | Path to the codex executable (resolves the vendored `.exe` behind npm shims on Windows) |
| `sandboxMode` | `read-only` | Codex sandbox for the spawned exec: `read-only`, `workspace-write`, `danger-full-access` |
| `cwd` | process cwd | Working directory passed to codex exec |
| `defaultReasoningEffort` | `high` | Effort used when a request doesn't select one: `low`/`medium`/`high`/`xhigh`/`none` |

Example:

```yaml
- insert:
    - id: llm-codex-bridge
      name: dsh-codex-bridge
      config:
        sandboxMode: read-only
        defaultReasoningEffort: high
```

## How it works

1. DSH's agent loop builds a request and selects the `codex` provider
2. The adapter renders the conversation history (system + prior turns + latest user message) as one prompt
3. It spawns `codex exec --json --ephemeral --skip-git-repo-check -s read-only -m <model>` and writes the prompt to stdin
4. Codex's JSONL events (`item.completed` `agent_message`/`reasoning`, `turn.completed` usage) are translated to harness StreamChunks in real time
5. Blocks close, usage is reported, and the stream finishes — exactly like any other DSH model provider

## Known limitations

- **Codex runs as a full agent**: each request is a fresh ephemeral codex session. It may use its own built-in tools (shell, etc.) within the configured sandbox. The text it produces is returned as the assistant message; its tool activity is not projected into the DSH transcript.
- **Conversation history is re-sent as prompt text** each turn (robust across models, but no provider-side KV-cache reuse).
- **Image input** is advertised only when the selected model supports it; DSH file/image blocks are currently rendered as handle text.

## License

Apache-2.0
