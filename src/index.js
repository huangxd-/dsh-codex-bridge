/**
 * dsh-codex-bridge: mount the locally logged-in Codex CLI as a DSH model
 * provider. The `codex` provider route drives `codex exec --json --ephemeral`
 * per request, so authentication, model access and quotas come from the
 * user's existing CLI login — no re-login, no credentials handled here.
 *
 * Composition (cordis.patch.yml):
 *   - insert:
 *       - id: llm-codex-bridge
 *         name: dsh-codex-bridge
 */

import {
  CODEX_BRIDGE_PROVIDER,
  CODEX_EFFORTS,
  codexModelCatalog,
  streamCodexExec,
} from "./adapter.js";

/** Stable Cordis plugin name. */
export const name = "llm-codex-bridge";

/** The LLM registry must exist before the adapter can register its route. */
export const inject = ["llm"];

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

/** Merge user config over defaults; tolerates a missing config object. */
function resolveConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  return {
    codexBin: typeof config.codexBin === "string" && config.codexBin.length > 0
      ? config.codexBin
      : undefined,
    sandboxMode: SANDBOX_MODES.includes(config.sandboxMode)
      ? config.sandboxMode
      : "read-only",
    cwd: typeof config.cwd === "string" && config.cwd.length > 0
      ? config.cwd
      : undefined,
    defaultReasoningEffort: CODEX_EFFORTS.includes(config.defaultReasoningEffort)
      ? config.defaultReasoningEffort
      : "high",
    // Watchdog windows (ms): codex should emit within noOutputTimeoutMs of
    // spawn, and keep emitting at least every stallTimeoutMs once started.
    // `0` disables the respective watchdog. Guards against silent hangs
    // (e.g. the CLI retrying a dead upstream forever) that would otherwise
    // leave the harness turn stuck in "running" with no output or error.
    noOutputTimeoutMs: clampTimeout(config.noOutputTimeoutMs, 120_000),
    stallTimeoutMs: clampTimeout(config.stallTimeoutMs, 300_000),
  };
}

/** Timeout value in ms; 0 disables, non-positive/absent falls back. */
function clampTimeout(raw, fallback) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 ? Math.floor(raw) : 0;
  }
  return fallback;
}

/** Create the LlmAdapter for the `codex` provider route. */
export function createCodexBridgeAdapter(rawConfig) {
  const config = resolveConfig(rawConfig);

  return {
    providerInfo(provider) {
      return {
        id: provider,
        name: "Codex CLI (local login)",
      };
    },

    /** No HTTP is made, so no provider-level retry policy applies. */
    providerRetryPolicy(_provider) {},

    /** Image generation is not offered through the codex CLI route. */
    imageRequestPricing(_provider, _model) {},

    listModels(_provider) {
      return Promise.resolve(
        codexModelCatalog().map((model) => ({
          provider: CODEX_BRIDGE_PROVIDER,
          id: model.id,
          name: model.name,
          ...("inputModalities" in model
            ? { inputModalities: model.inputModalities }
            : {}),
        })),
      );
    },

    async resolveModel(provider, model) {
      const catalog = codexModelCatalog();
      const entry = catalog.find((candidate) => candidate.id === model);
      const base = entry ?? {
        id: model,
        name: model,
        contextWindow: 128_000,
      };
      const effortIds = (base.reasoningEfforts ?? CODEX_EFFORTS).filter(
        (effort) => CODEX_EFFORTS.includes(effort),
      );
      const defaultEffort =
        base.defaultReasoningEffort ?? config.defaultReasoningEffort;
      const info = {
        provider,
        id: base.id,
        name: base.name,
        context: { contextWindow: base.contextWindow },
        defaultMaxTokens: 32_768,
        reasoning: {
          efforts: effortIds.map((effort) => ({ id: effort, name: effort })),
          ...(effortIds.includes(defaultEffort) ? { defaultEffort } : {}),
        },
      };
      if (Array.isArray(base.inputModalities)) {
        info.inputModalities = base.inputModalities;
      }
      return info;
    },

    async prepareCall(provider, model, signal) {
      const modelInfo = await this.resolveModel(provider, model, signal);
      return {
        model: modelInfo,
        stream: (options) => streamCodexExec(options, config),
      };
    },

    async *stream(options) {
      yield* streamCodexExec(options, config);
    },
  };
}

/** Register the `codex` provider route with the LLM registry. */
export function apply(ctx, rawConfig) {
  ctx.llm.registerAdapter(
    [CODEX_BRIDGE_PROVIDER],
    createCodexBridgeAdapter(rawConfig),
  );
}
