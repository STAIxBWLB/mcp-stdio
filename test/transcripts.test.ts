import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ResultTooLarge, runTranscripts, type TranscriptCase, type ServeOptions } from "../src/index.ts";

const schema = { type: "object", properties: { text: { type: "string" } }, additionalProperties: false };
const tools = ["echo", "fail", "named", "large"].map(name => ({ name, description: name, inputSchema: schema }));
const base: Omit<ServeOptions, "input" | "output" | "close"> = {
  name: "fixture", version: "1", tools,
  handlers: { echo: args => args, fail: () => { throw Error("private"); }, named: () => { throw { code: "named" }; }, large: () => "x".repeat(200) },
  limits: { frameBytes: 512, resultBytes: 100, toolFrameBytes: name => name === "echo" ? 180 : undefined },
  failureText: error => error instanceof ResultTooLarge ? "too large" : (error as { code?: string })?.code === "named" ? "named failure" : undefined,
};
for (const file of readdirSync("fixtures/v1").filter(name => name.endsWith(".jsonl"))) {
  test(file, async () => {
    const cases = readFileSync(`fixtures/v1/${file}`, "utf8").trim().split("\n").map(line => JSON.parse(line) as TranscriptCase & { packageOutput?: string; tools?: ServeOptions["tools"]; frameBytes?: number });
    const names: Record<string, [string, string]> = { "agent-mem.jsonl": ["amem", "fixture"], "vault-mem.jsonl": ["vault-mem", "fixture"], "agent-research.jsonl": ["agent-research", "fixture"], "agent-decide.jsonl": ["adec", "0.0.0"] };
    const identity = names[file];
    const options = identity ? { ...base, name: identity[0], version: identity[1] } : base;
    for (const item of cases) {
      const [result] = await runTranscripts([item], { ...options, tools: item.tools ?? options.tools, limits: item.frameBytes ? { frameBytes: item.frameBytes } : options.limits });
      expect(result.actual, result.id).toBe(item.packageOutput ?? result.expected);
    }
  });
}
