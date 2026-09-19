/** Unit test: mock the codex process through the spawnImpl seam. */
import assert from "node:assert";
import { streamCodexExec } from "../src/adapter.js";

const spawnCalls = [];
const stdinWrites = [];
const killCalls = [];

/** Build a fake codex that emits the given JSONL events and exits. */
function makeFakeSpawn({ events, exitCode = 0 } = {}) {
  return function fakeSpawn(bin, args, options) {
    spawnCalls.push({ bin, args, options });
    const stdoutL = [];
    const stderrL = [];
    const closeL = [];
    const child = {
      stdin: {
        write(data) { stdinWrites.push(String(data)); },
        end() { setTimeout(finish, 5); },
        on() {},
      },
      stdout: {
        setEncoding() {},
        on(e, f) { if (e === "data") stdoutL.push(f); },
        once() {},
        off() {},
      },
      stderr: {
        setEncoding() {},
        on(e, f) { if (e === "data") stderrL.push(f); },
      },
      on(e, f) { if (e === "close") closeL.push(f); },
      kill() {},
    };
    function finish() {
      const stream = events
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
      for (const fn of stdoutL) fn(stream);
      setTimeout(() => {
        for (const fn of closeL) fn(exitCode);
      }, 5);
    }
    return child;
  };
}

/** Fake line-delimited JSON-RPC app-server with true message deltas. */
function makeFakeAppServerSpawn(requests) {
  return function fakeAppServerSpawn(bin, args, options) {
    spawnCalls.push({ bin, args, options });
    const stdoutL = [];
    const closeL = [];
    let inputBuffer = "";
    const emit = (message) => {
      const line = `${JSON.stringify(message)}\n`;
      for (const fn of stdoutL) fn(line);
    };
    const child = {
      stdin: {
        write(data) {
          inputBuffer += String(data);
          let newline;
          while ((newline = inputBuffer.indexOf("\n")) !== -1) {
            const line = inputBuffer.slice(0, newline);
            inputBuffer = inputBuffer.slice(newline + 1);
            if (line.trim().length === 0) continue;
            const request = JSON.parse(line);
            requests.push(request);
            if (request.method === "initialize") {
              emit({ id: request.id, result: { userAgent: "fake-codex" } });
            } else if (request.method === "thread/start") {
              emit({ id: request.id, result: { thread: { id: "thread_1" } } });
            } else if (request.method === "turn/start") {
              emit({ id: request.id, result: { turn: { id: "turn_1" } } });
              setTimeout(() => {
                emit({
                  method: "item/reasoning/summaryTextDelta",
                  params: { threadId: "thread_1", turnId: "turn_1", itemId: "rs_1", summaryIndex: 0, delta: "思" },
                });
                emit({
                  method: "item/reasoning/summaryTextDelta",
                  params: { threadId: "thread_1", turnId: "turn_1", itemId: "rs_1", summaryIndex: 0, delta: "考" },
                });
                emit({
                  method: "item/agentMessage/delta",
                  params: { threadId: "thread_1", turnId: "turn_1", itemId: "ag_1", delta: "你" },
                });
                emit({
                  method: "item/agentMessage/delta",
                  params: { threadId: "thread_1", turnId: "turn_1", itemId: "ag_1", delta: "好" },
                });
                emit({
                  method: "thread/tokenUsage/updated",
                  params: {
                    threadId: "thread_1",
                    turnId: "turn_1",
                    tokenUsage: {
                      last: {
                        totalTokens: 15,
                        inputTokens: 10,
                        cachedInputTokens: 2,
                        cacheWriteInputTokens: 0,
                        outputTokens: 5,
                        reasoningOutputTokens: 2,
                      },
                    },
                  },
                });
                const items = [
                  { type: "reasoning", id: "rs_1", summary: ["思考"], content: [] },
                  { type: "agentMessage", id: "ag_1", text: "你好" },
                ];
                for (const item of items) {
                  emit({
                    method: "item/completed",
                    params: { threadId: "thread_1", turnId: "turn_1", item },
                  });
                }
                emit({
                  method: "turn/completed",
                  params: {
                    threadId: "thread_1",
                    turn: { id: "turn_1", status: "completed", items, error: null },
                  },
                });
              }, 5);
            }
          }
        },
        end() {},
        on() {},
      },
      stdout: {
        setEncoding() {},
        on(event, fn) { if (event === "data") stdoutL.push(fn); },
      },
      stderr: { setEncoding() {}, on() {} },
      on(event, fn) { if (event === "close") closeL.push(fn); },
      kill() {},
    };
    return child;
  };
}

async function collect(options, spawnImpl, extraConfig = {}) {
  const chunks = [];
  for await (const chunk of streamCodexExec(options, {
    transport: "exec",
    sandboxMode: "read-only",
    defaultReasoningEffort: "high",
    codexBin: "fake-codex",
    spawnImpl,
    ...extraConfig,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Fake codex that streams events but never exits (stuck after completion). */
function makeHangingSpawn(events, { trackKills = false } = {}) {
  return function fakeSpawn(bin, args, options) {
    spawnCalls.push({ bin, args, options });
    const stdoutL = [];
    const child = {
      stdin: { write(d) { stdinWrites.push(String(d)); }, end() {}, on() {} },
      stdout: { setEncoding() {}, on(e, f) { if (e === "data") stdoutL.push(f); }, once() {}, off() {} },
      stderr: { setEncoding() {}, on() {} },
      on() {},
      kill() { if (trackKills) killCalls.push(1); },
    };
    if (events) {
      setTimeout(() => {
        for (const fn of stdoutL) {
          fn(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        }
      }, 5);
    }
    return child;
  };
}

/** Race a collection against a deadline so a regression fails, not hangs. */
async function collectWithin(options, spawnImpl, extraConfig, ms, label) {
  const running = collect(options, spawnImpl, extraConfig);
  return Promise.race([
    running,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: stream did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

/** Enforce the llm/stream invariant grammar over emitted chunks. */
function assertInvariant(chunks, label) {
  const open = new Map();
  let usageSeen = false;
  let finished = false;
  for (const chunk of chunks) {
    assert.ok(!finished, `${label}: chunk after terminal finish`);
    switch (chunk.type) {
      case "block-start":
        assert.ok(!open.has(chunk.index), `${label}: repeated block-start index ${chunk.index}`);
        assert.ok(Number.isSafeInteger(chunk.index) && chunk.index >= 0, `${label}: bad index`);
        open.set(chunk.index, chunk.blockType);
        break;
      case "text-delta":
        assert.equal(open.get(chunk.index), "text", `${label}: text delta needs open text block`);
        break;
      case "reasoning-delta":
        assert.equal(open.get(chunk.index), "reasoning", `${label}: reasoning delta needs open reasoning block`);
        break;
      case "block-end": {
        assert.equal(open.get(chunk.index), chunk.block.type, `${label}: block-end type mismatch`);
        open.delete(chunk.index);
        break;
      }
      case "usage":
        assert.ok(!usageSeen, `${label}: usage twice`);
        usageSeen = true;
        break;
      case "finish":
        assert.ok(open.size === 0 || chunk.reason.kind === "error" || chunk.reason.kind === "aborted",
          `${label}: finish with ${open.size} open block(s)`);
        finished = true;
        break;
    }
  }
  assert.ok(finished, `${label}: stream ended without finish`);
}

const baseOptions = {
  provider: "codex",
  model: "gpt-6-astra",
  system: "Be helpful.",
  reasoningEffort: "high",
  messages: [
    { role: "user", content: [{ type: "text", text: "6*7?" }] },
    { role: "assistant", content: [{ type: "text", text: "是 42。" }] },
    { role: "user", content: [{ type: "text", text: "再问一次" }] },
  ],
};

// ---------- 1. happy path ----------
const chunks = await collect(baseOptions, makeFakeSpawn({
  events: [
    { type: "thread.started", thread_id: "th_1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "rs_1", type: "reasoning" } },
    { type: "item.completed", item: { id: "rs_1", type: "reasoning", text: "Let me compute." } },
    { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "答案是 42。" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 5,
      },
    },
  ],
}));
assertInvariant(chunks, "happy");

const text = chunks
  .filter((c) => c.type === "text-delta").map((c) => c.text).join("");
assert.equal(text, "答案是 42。", "text assembled");
const reasoning = chunks
  .filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
assert.equal(reasoning, "Let me compute.", "reasoning assembled");

const usage = chunks.find((c) => c.type === "usage")?.usage;
assert.equal(usage.inputTokens, 80, "usage input excludes cache");
assert.equal(usage.outputTokens, 30, "usage output");
assert.equal(usage.totalTokens, 130, "usage total");
assert.equal(usage.cacheReadTokens, 20, "usage cache read");
assert.equal(usage.reasoningTokens, 5, "usage reasoning");
const finish = chunks.find((c) => c.type === "finish");
assert.equal(finish?.reason?.kind, "stop", "finish stop");

// block indices are distinct
const starts = chunks.filter((c) => c.type === "block-start").map((c) => c.index);
assert.equal(new Set(starts).size, starts.length, "distinct block indices");

// spawn args
const call = spawnCalls[0];
assert.equal(call.bin, "fake-codex", "uses configured bin");
assert.ok(call.args.includes("exec"), "exec subcommand");
assert.ok(call.args.includes("--json"), "json flag");
assert.ok(call.args.includes("--ephemeral"), "ephemeral flag");
assert.equal(call.args[call.args.indexOf("-m") + 1], "gpt-6-astra");
assert.ok(
  call.args[call.args.indexOf("-c") + 1].includes('model_reasoning_effort="high"'),
  "effort override",
);

// prompt rendering
const stdin = stdinWrites[0];
assert.ok(stdin.includes("[system instructions]"), "system rendered");
assert.ok(stdin.includes("[assistant replied]"), "assistant history rendered");
assert.ok(stdin.includes("[user said]"), "prior user turns rendered");
assert.ok(stdin.endsWith("再问一次"), "latest user message last");

// ---------- 2. multiple reasoning + message items get fresh indices ----------
const multiChunks = await collect(
  { ...baseOptions, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  makeFakeSpawn({
    events: [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "rs_1", type: "reasoning", text: "think A" } },
      { type: "item.completed", item: { id: "rs_2", type: "reasoning", text: "think B" } },
      { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "ans A" } },
      { type: "item.completed", item: { id: "ag_2", type: "agent_message", text: "ans B" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  }),
);
assertInvariant(multiChunks, "multi");
const mStarts = multiChunks.filter((c) => c.type === "block-start");
assert.equal(mStarts.length, 4, "four blocks");
assert.equal(
  new Set(mStarts.map((c) => c.index)).size, 4, "four distinct indices",
);
const mText = multiChunks
  .filter((c) => c.type === "text-delta").map((c) => c.text).join("");
assert.equal(mText, "ans Aans B", "multi text assembled");
const mEnds = multiChunks.filter((c) => c.type === "block-end");
assert.equal(mEnds.length, 4, "all blocks closed");

// ---------- 3. reconnect errors must not kill the stream ----------
const reconnectChunks = await collect(
  baseOptions,
  makeFakeSpawn({
    events: [
      { type: "thread.started", thread_id: "th_2" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 1/5 (high demand)" },
      { type: "error", message: "Reconnecting... 2/5 (high demand)" },
      { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "recovered answer" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    ],
  }),
);
assertInvariant(reconnectChunks, "reconnect");
const rText = reconnectChunks
  .filter((c) => c.type === "text-delta").map((c) => c.text).join("");
assert.equal(rText, "recovered answer", "stream survives reconnect errors");
assert.equal(
  reconnectChunks.find((c) => c.type === "finish")?.reason?.kind, "stop",
  "reconnect case finishes stop",
);

// ---------- 4. turn.failed maps to error finish, closes open blocks ----------
const failedChunks = await collect(
  baseOptions,
  makeFakeSpawn({
    events: [
      { type: "thread.started", thread_id: "th_3" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "rs_1", type: "reasoning" } },
      { type: "item.updated", item: { id: "rs_1", type: "reasoning", text: "partial thought" } },
      { type: "turn.failed", error: { message: "We're experiencing high demand." } },
    ],
    exitCode: 1,
  }),
);
assertInvariant(failedChunks, "failed");
const fFinish = failedChunks.find((c) => c.type === "finish");
assert.equal(fFinish?.reason?.kind, "error", "turn.failed -> error finish");
assert.match(fFinish?.reason?.failure?.message ?? "", /high demand/, "failure message");
assert.equal(fFinish?.reason?.failure?.code, "UPSTREAM_ERROR");
const fReasoning = failedChunks
  .filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
assert.equal(fReasoning, "partial thought", "partial reasoning kept before failure");

// ---------- 5. empty response maps to EMPTY_RESPONSE ----------
const emptyChunks = await collect(
  baseOptions,
  makeFakeSpawn({
    events: [
      { type: "thread.started", thread_id: "th_4" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 0 } },
    ],
  }),
);
assertInvariant(emptyChunks, "empty");
const eFinish = emptyChunks.find((c) => c.type === "finish");
assert.equal(eFinish?.reason?.kind, "error", "empty -> error finish");
assert.equal(eFinish?.reason?.failure?.code, "EMPTY_RESPONSE");

// ---------- 6. abort mid-stream -> aborted finish ----------
const abortController = new AbortController();
const abortingSpawn = makeFakeSpawn({
  events: [
    { type: "turn.started" },
    { type: "item.updated", item: { id: "ag_1", type: "agent_message", text: "partial" } },
    // no turn.completed / close: hangs like a stuck process
  ],
  exitCode: null,
});
// custom spawn that never closes, aborted externally
const hangingSpawn = function (bin, args, options) {
  spawnCalls.push({ bin, args, options });
  const stdoutL = [];
  const child = {
    stdin: { write(d) { stdinWrites.push(String(d)); }, end() {}, on() {} },
    stdout: { setEncoding() {}, on(e, f) { if (e === "data") stdoutL.push(f); }, once() {}, off() {} },
    stderr: { setEncoding() {}, on() {} },
    on() {},
    kill() {},
  };
  setTimeout(() => {
    for (const fn of stdoutL) {
      fn(
        JSON.stringify({ type: "item.updated", item: { id: "ag_1", type: "agent_message", text: "partial" } }) + "\n",
      );
    }
    setTimeout(() => abortController.abort(), 10);
  }, 5);
  return child;
};
const abortChunks = [];
for await (const chunk of streamCodexExec(
  { ...baseOptions, signal: abortController.signal },
  { transport: "exec", sandboxMode: "read-only", defaultReasoningEffort: "high", codexBin: "fake-codex", spawnImpl: hangingSpawn },
)) {
  abortChunks.push(chunk);
}
assertInvariant(abortChunks, "abort");
const aFinish = abortChunks.find((c) => c.type === "finish");
assert.equal(aFinish?.reason?.kind, "aborted", "abort -> aborted finish");

// ---------- 7. turn.completed settles the stream even if the process never exits ----------
// Regression for "text streamed but the turn stays running": codex 0.15x
// emits all items + turn.completed then lingers (app-server/MCP teardown).
// The stream must terminate at turn.completed, not wait for process exit.
const completedChunks = await collectWithin(
  { ...baseOptions, messages: [{ role: "user", content: [{ type: "text", text: "背一下99乘法表" }] }] },
  makeHangingSpawn([
    { type: "thread.started", thread_id: "th_7" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "九九八十一" } },
    { type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } },
  ]),
  { noOutputTimeoutMs: 0, stallTimeoutMs: 0 },
  2000,
  "completed-terminates",
);
assertInvariant(completedChunks, "completed-terminates");
const cText = completedChunks
  .filter((c) => c.type === "text-delta").map((c) => c.text).join("");
assert.equal(cText, "九九八十一", "text delivered before completion");
const cFinish = completedChunks.find((c) => c.type === "finish");
assert.equal(cFinish?.reason?.kind, "stop", "finish stop without process exit");
assert.equal(
  completedChunks.find((c) => c.type === "usage")?.usage?.outputTokens, 7,
  "usage recorded from turn.completed",
);

// ---------- 8. no-output watchdog: silent codex (never emits, never exits) ----------
// Guard for "runs in background forever": a codex exec that produces nothing
// (e.g. retrying a dead upstream) must surface a visible error promptly.
const noOutputKillsBefore = killCalls.length;
const noOutputChunks = await collectWithin(
  baseOptions,
  makeHangingSpawn(null, { trackKills: true }),
  { noOutputTimeoutMs: 60, stallTimeoutMs: 0 },
  2000,
  "no-output-watchdog",
);
assertInvariant(noOutputChunks, "no-output-watchdog");
const nFinish = noOutputChunks.find((c) => c.type === "finish");
assert.equal(nFinish?.reason?.kind, "error", "no output -> error finish");
assert.equal(nFinish?.reason?.failure?.code, "UPSTREAM_TIMEOUT");
assert.match(nFinish?.reason?.failure?.message ?? "", /no output/, "timeout message");
assert.ok(killCalls.length > noOutputKillsBefore, "watchdog killed the stuck child");

// ---------- 9. stall watchdog: text arrived, then codex goes silent ----------
// Guard for mid-stream upstream drops: once output started, a long silence
// must surface as an error instead of leaving the turn running forever.
const stallKillsBefore = killCalls.length;
const stallChunks = await collectWithin(
  baseOptions,
  makeHangingSpawn([
    { type: "thread.started", thread_id: "th_9" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "一半" } },
    // no turn.completed, no further events, no exit: upstream stalled
  ], { trackKills: true }),
  { noOutputTimeoutMs: 0, stallTimeoutMs: 60 },
  2000,
  "stall-watchdog",
);
assertInvariant(stallChunks, "stall-watchdog");
const sFinish = stallChunks.find((c) => c.type === "finish");
assert.equal(sFinish?.reason?.kind, "error", "stall -> error finish");
assert.equal(sFinish?.reason?.failure?.code, "UPSTREAM_TIMEOUT");
assert.match(sFinish?.reason?.failure?.message ?? "", /no codex events/, "stall message");
assert.ok(killCalls.length > stallKillsBefore, "stall watchdog killed the stuck child");

// ---------- 10. sandbox/working-root flags: codex must be able to edit files ----------
// Regression for "codex cannot modify files": the bridge must not pin the
// spawned exec to read-only, and it must point codex at a writable working
// root (cwd) plus any extra writable dirs (--add-dir).
{
  const { resolveConfig } = await import("../src/index.js");
  const defaults = resolveConfig({});
  assert.equal(
    defaults.sandboxMode, "workspace-write",
    "default sandbox allows writes inside the working root",
  );
  assert.equal(defaults.transport, "app-server",
    "default transport exposes true incremental deltas");
  assert.equal(resolveConfig({ transport: "exec" }).transport, "exec",
    "legacy exec transport remains available");
  assert.equal(resolveConfig({ transport: "bogus" }).transport, "app-server",
    "invalid transport falls back to app-server");
  assert.deepEqual(defaults.addDirs, [], "no extra writable dirs by default");
  assert.equal(resolveConfig({ sandboxMode: "read-only" }).sandboxMode, "read-only",
    "read-only opt-out honored");
  assert.equal(resolveConfig({ sandboxMode: "danger-full-access" }).sandboxMode,
    "danger-full-access", "full-access opt-in honored");
  assert.equal(resolveConfig({ sandboxMode: "bogus" }).sandboxMode, "workspace-write",
    "invalid sandbox falls back to workspace-write");
  assert.deepEqual(
    resolveConfig({ addDirs: ["D:/a", "", 5, "D:/b"] }).addDirs,
    ["D:/a", "D:/b"],
    "addDirs keeps only non-empty strings",
  );

  const sandboxSpawnCalls = spawnCalls.length;
  const projectDir = "D:\\repos\\my-project";
  const sandboxChunks = await collect(
    { ...baseOptions, messages: [{ role: "user", content: [{ type: "text", text: "edit a file" }] }] },
    makeFakeSpawn({
      events: [
        { type: "turn.started" },
        { type: "item.completed", item: { id: "ag_1", type: "agent_message", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } },
      ],
    }),
    {
      sandboxMode: undefined, // exercise the adapter's own fallback
      cwd: projectDir,
      addDirs: ["D:\\repos\\shared-lib", "D:\\repos\\docs"],
    },
  );
  assertInvariant(sandboxChunks, "sandbox-flags");
  const sandboxCall = spawnCalls[sandboxSpawnCalls];
  const sArgs = sandboxCall.args;
  assert.equal(sArgs[sArgs.indexOf("-s") + 1], "workspace-write",
    "sandbox flag defaults to workspace-write, not read-only");
  assert.ok(!sArgs.includes("read-only"), "never silently pins codex to read-only");
  assert.equal(sArgs[sArgs.indexOf("-C") + 1], projectDir,
    "explicit codex working root");
  assert.equal(sandboxCall.options.cwd, projectDir, "spawn cwd matches the working root");
  const addDirValues = sArgs.reduce(
    (acc, arg, i) => (arg === "--add-dir" ? [...acc, sArgs[i + 1]] : acc), [],
  );
  assert.deepEqual(addDirValues, ["D:\\repos\\shared-lib", "D:\\repos\\docs"],
    "extra writable dirs passed as --add-dir");
  assert.equal(sandboxChunks.find((c) => c.type === "finish")?.reason?.kind, "stop");

  const sessionSpawnCalls = spawnCalls.length;
  const sessionDir = "D:\\repos\\danmu_api";
  const sessionChunks = await collect(
    {
      ...baseOptions,
      system: undefined,
      messages: [
        {
          role: "system",
          content: [{
            type: "text",
            text: `Harness instructions.\n\nYour working directory is ${sessionDir}.`,
          }],
        },
        { role: "user", content: [{ type: "text", text: "edit globals.js" }] },
      ],
    },
    makeFakeSpawn({
      events: [
        { type: "turn.started" },
        { type: "item.completed", item: { id: "ag_session", type: "agent_message", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } },
      ],
    }),
    { sandboxMode: "workspace-write" },
  );
  assertInvariant(sessionChunks, "session-working-root");
  const sessionCall = spawnCalls[sessionSpawnCalls];
  assert.equal(sessionCall.args[sessionCall.args.indexOf("-C") + 1], sessionDir,
    "DSH session working directory becomes the Codex working root");
  assert.equal(sessionCall.options.cwd, sessionDir,
    "spawn cwd follows DSH's role=system session context instead of the desktop host");

  const overrideSpawnCalls = spawnCalls.length;
  const overrideDir = "D:\\repos\\configured-project";
  await collect(
    {
      ...baseOptions,
      system: `Your working directory is ${sessionDir}.`,
      messages: [{ role: "user", content: [{ type: "text", text: "edit configured project" }] }],
    },
    makeFakeSpawn({
      events: [
        { type: "item.completed", item: { id: "ag_override", type: "agent_message", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } },
      ],
    }),
    { cwd: overrideDir },
  );
  const overrideCall = spawnCalls[overrideSpawnCalls];
  assert.equal(overrideCall.options.cwd, overrideDir,
    "explicit plugin cwd overrides the inferred DSH session directory");
}

// ---------- 11. app-server transport emits true incremental deltas ----------
{
  const appServerRequests = [];
  const appServerSpawnCalls = spawnCalls.length;
  const projectDir = "D:\\repos\\stream-project";
  const appServerChunks = [];
  for await (const chunk of streamCodexExec(
    {
      ...baseOptions,
      system: undefined,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: `Your working directory is ${projectDir}.` }],
        },
        { role: "user", content: [{ type: "text", text: "say hello" }] },
      ],
    },
    {
      transport: "app-server",
      sandboxMode: "workspace-write",
      defaultReasoningEffort: "high",
      codexBin: "fake-codex",
      spawnImpl: makeFakeAppServerSpawn(appServerRequests),
      addDirs: ["D:\\repos\\shared"],
      noOutputTimeoutMs: 1000,
      stallTimeoutMs: 1000,
    },
  )) {
    appServerChunks.push(chunk);
  }
  assertInvariant(appServerChunks, "app-server-streaming");
  assert.deepEqual(
    appServerChunks.filter((c) => c.type === "text-delta").map((c) => c.text),
    ["你", "好"],
    "app-server forwards agent message deltas without waiting for item completion",
  );
  assert.deepEqual(
    appServerChunks.filter((c) => c.type === "reasoning-delta").map((c) => c.text),
    ["思", "考"],
    "app-server forwards reasoning deltas",
  );
  const appUsage = appServerChunks.find((c) => c.type === "usage")?.usage;
  assert.equal(appUsage?.inputTokens, 8, "app-server usage excludes cached input");
  assert.equal(appUsage?.outputTokens, 5, "app-server usage output");
  const appCall = spawnCalls[appServerSpawnCalls];
  assert.deepEqual(appCall.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(appCall.options.cwd, projectDir);
  const initialize = appServerRequests.find((request) => request.method === "initialize");
  assert.equal(initialize?.params?.capabilities?.experimentalApi, true,
    "runtime workspace roots opt into the gated app-server capability");
  const threadStart = appServerRequests.find((request) => request.method === "thread/start");
  assert.equal(threadStart?.params?.cwd, projectDir);
  assert.deepEqual(
    threadStart?.params?.runtimeWorkspaceRoots,
    [projectDir, "D:\\repos\\shared"],
  );
  assert.equal(threadStart?.params?.sandbox, "workspace-write");
  assert.equal(threadStart?.params?.approvalPolicy, "never");
  const turnStart = appServerRequests.find((request) => request.method === "turn/start");
  assert.equal(turnStart?.params?.effort, "high");
}

console.log("ALL 11 SCENARIOS PASSED (incl. llm/stream invariant grammar)");
console.log("1 happy | 2 multi-block indices | 3 reconnect survives | 4 turn.failed | 5 empty | 6 abort | 7 completed-terminates | 8 no-output watchdog | 9 stall watchdog | 10 sandbox/working-root flags | 11 app-server true deltas");
