/** Standalone smoke test for the codex-bridge adapter (no DSH runtime). */
import { streamCodexExec, codexModelCatalog } from "../src/adapter.js";

const catalog = codexModelCatalog();
console.log("=== catalog ===");
for (const model of catalog) console.log(JSON.stringify(model));

console.log("\n=== stream test ===");
const options = {
  provider: "codex",
  model: catalog[0]?.id,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "用一句话介绍你自己，然后说出 7*6 的结果" }],
    },
  ],
  reasoningEffort: "high",
};

let text = "";
let reasoning = "";
for await (const chunk of streamCodexExec(options, {
  sandboxMode: "read-only",
  defaultReasoningEffort: "high",
})) {
  switch (chunk.type) {
    case "text-delta":
      text += chunk.text;
      break;
    case "reasoning-delta":
      reasoning += chunk.text;
      break;
    case "usage":
      console.log("[usage]", JSON.stringify(chunk.usage));
      break;
    case "finish":
      console.log("[finish]", JSON.stringify(chunk.reason));
      break;
    default:
      break;
  }
}
console.log("\n--- reasoning ---\n", reasoning.slice(0, 500));
console.log("\n--- text ---\n", text);
