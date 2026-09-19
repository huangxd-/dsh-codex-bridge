/**
 * Codex CLI bridge adapter: drives the locally logged-in `codex` binary in
 * `exec --json` mode and maps its JSONL event stream onto the harness
 * StreamChunk vocabulary.
 *
 * Authentication, model access, quotas and the codex toolchain are all owned
 * by the user's existing CLI login ($CODEX_HOME). This adapter never reads,
 * stores or forwards credentials itself.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, win32 } from "node:path";

/** Provider route this adapter owns. */
export const CODEX_BRIDGE_PROVIDER = "codex";

/** Maximum characters of one codex exec prompt. */
const MAX_PROMPT_CHARS = 512_000;

/** Reasoning efforts the CLI accepts. */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "none"];

/**
 * Resolve a spawnable codex executable on this machine.
 *
 * Preference order:
 * 1. explicit config `codexBin` (used as-is; caller may point at any binary)
 * 2. an .exe shipped inside the npm package next to a codex shim on PATH
 *    (the npm CLI installs @openai/codex with a vendored native binary)
 * 3. `codex` resolved from PATH (works when it is already an .exe)
 *
 * On Windows, spawning an npm .cmd shim without a shell fails with EINVAL,
 * so shim resolution must land on the underlying .exe.
 */
export function resolveCodexBinary(configured) {
  if (configured) return configured;
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const isWindows = process.platform === "win32";
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    // npm global installs place the vendored codex.exe under
    // node_modules/@openai/codex/... on Windows, or a symlinked bin elsewhere.
    const exeNames = isWindows
      ? ["codex.exe", "codex.cmd", "codex.ps1"]
      : ["codex"];
    for (const exeName of exeNames) {
      const candidate = join(dir, exeName);
      if (!existsSync(candidate)) continue;
      if (exeName === "codex.exe") return candidate;
      // Resolve the npm shim to the vended native binary.
      const resolved = resolveVendoredExe(candidate);
      if (resolved) return resolved;
    }
  }
  return "codex";
}

/** Follow an npm codex shim to the vended native codex.exe, if present. */
function resolveVendoredExe(shimPath) {
  try {
    if (process.platform !== "win32") return undefined;
    // npm shims live in <prefix>; the package sits in <prefix>\node_modules.
    const prefix = dirname(shimPath);
    const pkgDir = join(prefix, "node_modules", "@openai", "codex");
    if (!existsSync(pkgDir)) return undefined;
    const vendorRoot = join(
      pkgDir,
      "node_modules",
      "@openai",
    );
    if (!existsSync(vendorRoot)) return undefined;
    for (const entry of readdirSync(vendorRoot)) {
      if (!entry.startsWith("codex-")) continue;
      const exe = join(
        vendorRoot,
        entry,
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      );
      if (existsSync(exe)) return exe;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function codexHome() {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Read the user's config.toml (model + effort live here). */
function readCodexConfig() {
  const path = join(codexHome(), "config.toml");
  if (!existsSync(path)) return {};
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Minimal TOML subset parser for config.toml: top-level `key = value` lines
 * and one-level `[section]` tables. Values may be strings ("..."), booleans
 * or bare words. Enough for model/model_reasoning_effort discovery without a
 * dependency; malformed lines are skipped.
 */
function parseToml(text) {
  const result = {};
  let section = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line.length === 0) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      section = {};
      result[table[1]] = section;
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = parseTomlValue(pair[2].trim());
    if (value !== undefined) {
      if (section) section[pair[1]] = value;
      else result[pair[1]] = value;
    }
  }
  return result;
}

function parseTomlValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Read the CC-Switch model catalog when present (adds display metadata). */
function readModelCatalog() {
  const path = join(codexHome(), "cc-switch-model-catalog.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function effortFromConfig(config) {
  const raw = config.model_reasoning_effort;
  return typeof raw === "string" && CODEX_EFFORTS.includes(raw) ? raw : undefined;
}

/**
 * Build the advertised model catalog: config.toml's current model first,
 * then CC-Switch catalog models, deduplicated.
 */
export function codexModelCatalog() {
  const config = readCodexConfig();
  const current = typeof config.model === "string" ? config.model : undefined;
  const models = [];
  const seen = new Set();
  const fallbackEffort = effortFromConfig(config) ?? "high";
  if (current && current.length > 0) {
    models.push({
      id: current,
      name: current,
      contextWindow: 128_000,
      defaultReasoningEffort: fallbackEffort,
      reasoningEfforts: CODEX_EFFORTS,
    });
    seen.add(current);
  }
  for (const entry of readModelCatalog()) {
    const id = typeof entry.display_name === "string" ? entry.display_name : undefined;
    if (!id || id.length === 0 || seen.has(id)) continue;
    const contextWindow =
      typeof entry.context_window === "number" && entry.context_window > 0
        ? entry.context_window
        : 128_000;
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((level) => (typeof level?.effort === "string" ? level.effort : ""))
          .filter((effort) => CODEX_EFFORTS.includes(effort))
      : [];
    const input = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((m) => m === "text" || m === "image")
      : ["text"];
    models.push({
      id,
      name: id,
      contextWindow,
      defaultReasoningEffort: effortFromConfig(config) ?? "high",
      reasoningEfforts: efforts.length > 0 ? efforts : CODEX_EFFORTS,
      inputModalities: input.length > 0 ? input : ["text"],
    });
    seen.add(id);
  }
  if (models.length === 0) {
    // The CLI runs fine without config.toml using its account default.
    models.push({
      id: "gpt-6-astra",
      name: "gpt-6-astra (account default)",
      contextWindow: 128_000,
      defaultReasoningEffort: "high",
      reasoningEfforts: CODEX_EFFORTS,
    });
  }
  return models;
}

/** Render the conversation history as one exec prompt. */
function renderPrompt(options) {
  const parts = [];
  const system = options.system;
  if (typeof system === "string" && system.length > 0) {
    parts.push(`[system instructions]\n${system}`);
  }
  let lastUser = null;
  const history = [];
  for (const message of options.messages ?? []) {
    const text = joinText(message.content);
    if (message.role === "user") {
      if (lastUser !== null) history.push({ role: "user", text: lastUser });
      lastUser = text;
    } else if (message.role === "assistant") {
      if (text.length > 0) history.push({ role: "assistant", text });
    } else if (message.role === "system" && text.length > 0) {
      parts.push(`[system instructions]\n${text}`);
    }
  }
  if (lastUser === null || lastUser.length === 0) {
    throw new Error(
      "codex-bridge: conversation has no user message to send",
    );
  }
  for (const turn of history) {
    parts.push(
      turn.role === "user"
        ? `[user said]\n${turn.text}`
        : `[assistant replied]\n${turn.text}`,
    );
  }
  // The newest user message is the live prompt codex must answer.
  parts.push(lastUser);
  return parts.join("\n\n");
}

function joinText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "image") {
      parts.push("[image attached]");
    }
  }
  return parts.join("\n");
}

/**
 * Resolve the workspace that must become Codex's `-C` working root.
 *
 * DSH's generic LLM request currently has no dedicated cwd field, but its
 * trusted system prompt includes `Your working directory is <path>.`. The
 * desktop host itself runs from the application install directory, so using
 * process.cwd() without consulting that prompt points Codex at the wrong
 * writable root. An explicit plugin `cwd` remains the administrator override.
 */
export function resolveWorkingDirectory(options, config = {}) {
  const configured = cleanWorkingDirectory(config.cwd);
  if (configured !== undefined) return configured;

  // Accept native request fields if DSH adds one in a future release.
  for (const candidate of [options?.cwd, options?.workdir, options?.workingDirectory]) {
    const cleaned = cleanWorkingDirectory(candidate);
    if (cleaned !== undefined) return cleaned;
  }

  const systemParts = [];
  if (typeof options?.system === "string") systemParts.push(options.system);
  // DSH currently represents its generated system prompt as a regular
  // role=system entry in `messages` (rather than `options.system`). User
  // messages cannot acquire this role, so it remains a trusted source for the
  // session workspace declaration.
  for (const message of options?.messages ?? []) {
    if (message?.role !== "system") continue;
    const text = joinText(message.content);
    if (text.length > 0) systemParts.push(text);
  }
  const system = systemParts.join("\n");
  const patterns = [
    /<cwd>\s*([^<\r\n]+?)\s*<\/cwd>/i,
    /^Your working directory is\s+(.+?)\s*$/im,
    /session workspace:\s*["']([^"'\r\n]+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(system);
    const cleaned = cleanWorkingDirectory(match?.[1], true);
    if (cleaned !== undefined) return cleaned;
  }
  return undefined;
}

function cleanWorkingDirectory(value, sentence = false) {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (sentence) candidate = candidate.replace(/[。.]$/, "").trim();
  if (
    candidate.length >= 2 &&
    ((candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'")) ||
      (candidate.startsWith("`") && candidate.endsWith("`")))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  // `node:path.isAbsolute` follows the host platform. Keep Windows drive/UNC
  // paths recognizable when unit tests or consumers inspect them elsewhere.
  if (!isAbsolute(candidate) && !win32.isAbsolute(candidate)) return undefined;
  return candidate.length > 0 ? candidate : undefined;
}

/** One queued queue item for the stream consumer. */
class Queue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
  }
  next() {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Run `codex exec --json` once and yield harness StreamChunks.
 *
 * JSONL events (codex-rs exec/src/exec_events.rs):
 *   thread.started {thread_id}
 *   turn.started {}
 *   item.started / item.updated / item.completed {item: {id, type, ...}}
 *     agent_message {text}  -> assistant text
 *     reasoning {text}       -> reasoning text
 *   turn.completed {usage}
 *   turn.failed {error: {message}}
 *   error {message}
 */
export async function* streamCodexExec(options, config) {
  let prompt;
  try {
    prompt = renderPrompt(options);
  } catch (error) {
    yield terminalFailure({
      message: String(error?.message ?? error),
      code: "INVALID_ARGS",
    });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    yield terminalFailure({
      message: `codex-bridge: prompt of ${prompt.length} chars exceeds the ${MAX_PROMPT_CHARS} char limit`,
      code: "INVALID_ARGS",
    });
    return;
  }

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    // Sandbox policy for model-generated shell commands. The bridge defaults
    // to workspace-write (see resolveConfig) so codex can edit files under its
    // working root; `read-only` forbids writes, `danger-full-access` disables
    // the sandbox entirely.
    "-s",
    config.sandboxMode ?? "workspace-write",
  ];
  // Codex's writable workspace is the directory it treats as its working root.
  // Pass it explicitly so the sandbox protects/permits the intended project
  // even when the DSH host process runs elsewhere.
  const cwd = resolveWorkingDirectory(options, config);
  if (cwd !== undefined) args.push("-C", cwd);
  // Additional writable roots alongside the primary workspace.
  for (const dir of config.addDirs ?? []) args.push("--add-dir", dir);
  if (options.model) args.push("-m", options.model);
  const effort = options.reasoningEffort ?? config.defaultReasoningEffort;
  if (typeof effort === "string" && CODEX_EFFORTS.includes(effort)) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  const queue = new Queue();
  let child;
  const codexBin = resolveCodexBinary(config.codexBin);
  const spawnFn = config.spawnImpl ?? spawn;
  try {
    child = spawnFn(codexBin, args, {
      cwd: cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    yield terminalFailure({
      message: `codex-bridge: failed to launch codex at ${codexBin} (${String(error?.message ?? error)})`,
      code: "INVALID_CREDENTIAL",
    });
    return;
  }

  const signal = options.signal;
  const onAbort = () => {
    try {
      child.kill();
    } catch {}
    queue.push({ kind: "abort" });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let stdoutBuffer = "";
  let stderrTail = "";
  let exitCode = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    drainLines(false);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  child.on("error", (error) => {
    queue.push({
      kind: "fatal",
      failure: {
        message: `codex-bridge: failed to launch codex (${error.message}). Install the CLI (npm i -g @openai/codex) and log in once.`,
        code: "INVALID_CREDENTIAL",
      },
    });
  });
  child.on("close", (code) => {
    exitCode = code;
    drainLines(true);
    queue.push({ kind: "closed" });
    queue.close();
  });

  // Feed the prompt via stdin, then close it so codex starts the turn.
  child.stdin.on("error", () => {}); // EPIPE if codex dies early
  child.stdin.write(prompt);
  child.stdin.end();

  // Per-item block state: codex item id -> open block descriptor. Every
  // block gets a fresh, strictly increasing index because the llm/stream
  // invariant rejects a repeated block-start index within one stream.
  let nextIndex = 0;
  const itemBlocks = new Map();
  let usage;
  let fatalFailure;
  let sawText = false;
  let sawReasoning = false;

  const blockTypeFor = (itemType) =>
    itemType === "reasoning" ? "reasoning" : itemType === "agent_message" ? "text" : undefined;

  function pushChunks(chunks) {
    queue.push({ kind: "chunks", chunks });
  }

  function ensureItemBlock(id, blockType) {
    let state = itemBlocks.get(id);
    if (state === undefined) {
      const index = nextIndex++;
      state = { index, blockType, emitted: "", closed: false };
      itemBlocks.set(id, state);
      pushChunks([{ type: "block-start", index, blockType }]);
    }
    return state;
  }

  function itemTextDelta(id, blockType, fullText) {
    const state = ensureItemBlock(id, blockType);
    if (state.closed) return; // completed already; ignore late updates
    const delta = fullText.startsWith(state.emitted)
      ? fullText.slice(state.emitted.length)
      : fullText;
    if (delta.length === 0) return;
    state.emitted += delta;
    pushChunks([
      {
        type: blockType === "text" ? "text-delta" : "reasoning-delta",
        index: state.index,
        text: delta,
      },
    ]);
    if (blockType === "text") sawText = true;
    else sawReasoning = true;
  }

  function itemComplete(id, blockType, fullText) {
    itemTextDelta(id, blockType, fullText);
    const state = itemBlocks.get(id);
    if (state === undefined) return;
    if (!state.closed) {
      state.closed = true;
      pushChunks([
        {
          type: "block-end",
          index: state.index,
          block: { type: blockType, text: fullText },
        },
      ]);
    }
  }

  function handleEvent(event) {
    switch (event?.type) {
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item;
        if (!item || typeof item.id !== "string") return;
        const blockType = blockTypeFor(item.type);
        if (blockType === undefined) return;
        const text = typeof item.text === "string" ? item.text : "";
        if (event.type === "item.completed") {
          itemComplete(item.id, blockType, text);
        } else {
          itemTextDelta(item.id, blockType, text);
        }
        return;
      }
      case "turn.completed": {
        const raw = event.usage ?? {};
        const input = safeCount(raw.input_tokens);
        const cached = safeCount(raw.cached_input_tokens);
        const cacheWrite = safeCount(raw.cache_write_input_tokens);
        const output = safeCount(raw.output_tokens);
        const reasoningOut = safeCount(raw.reasoning_output_tokens);
        usage = {
          inputTokens: Math.max(0, input - cached),
          outputTokens: output,
          totalTokens: input + output,
          ...(cached > 0 ? { cacheReadTokens: cached } : {}),
          ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
          ...(reasoningOut > 0 ? { reasoningTokens: reasoningOut } : {}),
        };
        // `turn.completed` is the authoritative end of the response: every
        // item has already been emitted (item.completed for the final
        // agent_message precedes it). Terminate here instead of waiting for
        // the codex process to exit — codex 0.15x lingers after the turn
        // (app-server / MCP / remote-control teardown), which previously left
        // the harness turn stuck in "running" even though all text had
        // streamed. Killed in the generator's finally block.
        queue.push({ kind: "terminal" });
        return;
      }
      case "turn.failed": {
        fatalFailure = {
          message:
            typeof event.error?.message === "string"
              ? event.error.message
              : "codex turn failed",
          code: "UPSTREAM_ERROR",
        };
        queue.push({ kind: "terminal" });
        return;
      }
      case "error": {
        // Codex emits non-fatal `error` events while reconnecting
        // ("Reconnecting... 1/5"). Only turn.failed (or a non-zero exit
        // with no content) is terminal; keep the stream alive otherwise.
        return;
      }
      default:
        return;
    }
  }

  function drainLines(final) {
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      dispatchLine(line);
    }
    if (final && stdoutBuffer.trim().length > 0) {
      dispatchLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  }

  function dispatchLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise from the CLI
    }
    try {
      handleEvent(event);
    } catch {
      // A malformed event must not kill the whole stream.
    }
  }

  let aborted = false;
  let terminal = false; // turn.failed / turn.completed seen; no further content is expected

  // Watchdogs: codex should emit something promptly after spawn (no-output)
  // and keep emitting periodically once it started (stall). Both turn an
  // otherwise silent hang — e.g. the CLI retrying a dead upstream with
  // "UnboundedConnectionRetries" — into a visible error instead of leaving
  // the harness turn running forever. A value of `0` disables that timer.
  const noOutputTimeoutMs = config.noOutputTimeoutMs ?? 120_000;
  const stallTimeoutMs = config.stallTimeoutMs ?? 300_000;
  let noOutputTimer = null;
  let stallTimer = null;

  function failStream(message, code) {
    if (queue.closed) return; // already settling; never double-finish
    queue.push({ kind: "fatal", failure: { message, code } });
    try {
      child.kill();
    } catch {}
  }

  function armNoOutput() {
    if (noOutputTimeoutMs <= 0) return;
    noOutputTimer = setTimeout(() => {
      noOutputTimer = null;
      failStream(
        `codex-bridge: codex produced no output within ${noOutputTimeoutMs}ms — the upstream configured in ~/.codex/config.toml (base_url) may be down or retrying`,
        "UPSTREAM_TIMEOUT",
      );
    }, noOutputTimeoutMs);
  }

  function armStall() {
    if (stallTimeoutMs <= 0) return;
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallTimer = null;
      failStream(
        `codex-bridge: no codex events for ${stallTimeoutMs}ms after output started — upstream stalled`,
        "UPSTREAM_TIMEOUT",
      );
    }, stallTimeoutMs);
  }

  armNoOutput();

  try {
    while (true) {
      const { value, done } = await queue.next();
      if (done) break;
      if (value.kind === "fatal") {
        fatalFailure = value.failure;
        break;
      }
      if (value.kind === "abort") {
        aborted = true;
        break;
      }
      if (value.kind === "terminal") {
        terminal = true;
        break;
      }
      if (value.kind === "chunks") {
        if (noOutputTimer !== null) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
        armStall();
        for (const chunk of value.chunks) yield chunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (noOutputTimer !== null) clearTimeout(noOutputTimer);
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (exitCode === null) {
      try {
        child.kill();
      } catch {}
    }
  }

  // Close every block still open: blocks are closed eagerly by itemComplete,
  // so only items that never sent item.completed remain.
  for (const state of itemBlocks.values()) {
    if (!state.closed) {
      state.closed = true;
      yield {
        type: "block-end",
        index: state.index,
        block: { type: state.blockType, text: state.emitted },
      };
    }
  }

  if (aborted) {
    yield { type: "finish", reason: { kind: "aborted" } };
    return;
  }
  if (fatalFailure !== undefined) {
    yield terminalFailure(fatalFailure);
    return;
  }
  if (usage !== undefined) yield { type: "usage", usage };
  if (!sawText && !sawReasoning) {
    const code = exitCode !== null && exitCode !== 0 ? "UPSTREAM_ERROR" : "EMPTY_RESPONSE";
    const stderr = stderrTail.trim();
    yield terminalFailure({
      message:
        exitCode !== null && exitCode !== 0
          ? `codex exec exited with code ${exitCode}${stderr ? `: ${stderr}` : ""}`
          : "codex returned a completed turn with no content",
      code,
    });
    return;
  }
  yield { type: "finish", reason: { kind: "stop" } };
}

function safeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function terminalFailure(failure) {
  return { type: "finish", reason: { kind: "error", failure } };
}
