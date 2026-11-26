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
// Recorded bare object schemas were enforced as closed objects.
function recordedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...schema };
  const child = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
    ? recordedSchema(value as Record<string, unknown>)
    : value;
  if (normalized.properties && typeof normalized.properties === "object") {
    normalized.properties = Object.fromEntries(Object.entries(normalized.properties).map(([key, value]) => [key, child(value)]));
  }
  if (Object.hasOwn(normalized, "items")) normalized.items = child(normalized.items);
  if (Object.hasOwn(normalized, "additionalProperties")) normalized.additionalProperties = child(normalized.additionalProperties);
  if (Array.isArray(normalized.oneOf)) normalized.oneOf = normalized.oneOf.map(child);
  const types = Array.isArray(normalized.type) ? normalized.type : [normalized.type];
  if (types.includes("object") && !Object.hasOwn(normalized, "properties") && !Object.hasOwn(normalized, "additionalProperties")) {
    normalized.additionalProperties = false;
  }
  return normalized;
}

function normalizeRecordedTools(tools: ServeOptions["tools"]): ServeOptions["tools"] {
  return tools.map(tool => ({ ...tool, inputSchema: recordedSchema(tool.inputSchema) }));
}

for (const file of readdirSync("fixtures/v1").filter(name => name.endsWith(".jsonl"))) {
  test(file, async () => {
    const cases = readFileSync(`fixtures/v1/${file}`, "utf8").trim().split("\n").map(line => JSON.parse(line) as TranscriptCase & { packageOutput?: string; tools?: ServeOptions["tools"]; frameBytes?: number; handlerNames?: string[]; fixtureKind?: string; resultBytes?: number; limitText?: string });
    const names: Record<string, [string, string]> = { "agent-mem.jsonl": ["amem", "fixture"], "vault-mem.jsonl": ["vault-mem", "fixture"], "agent-research.jsonl": ["agent-research", "fixture"], "agent-decide.jsonl": ["adec", "0.0.0"] };
    const identity = names[file.replace(/-(protocol|handler)\.jsonl$/, ".jsonl")];
    const copyLimits: Record<string, { frameBytes: number; resultBytes: number }> = {
      "amem": { frameBytes: 65_536, resultBytes: 262_144 },
      "vault-mem": { frameBytes: 65_536, resultBytes: 262_144 },
      "agent-research": { frameBytes: 131_072, resultBytes: 2_097_152 },
      "adec": { frameBytes: 1_048_576, resultBytes: Infinity },
    };
    const options = identity ? { ...base, name: identity[0], version: identity[1], limits: copyLimits[identity[0]] } : base;
    for (const item of cases) {
      const handlers = item.fixtureKind ? { fixture: item.fixtureKind === "handler-throw" ? () => { throw Error("fixture failure"); } : item.fixtureKind === "handler-oversize" ? () => "x".repeat(item.resultBytes! + 1) : () => ({ ok: true }) } : item.handlerNames ? Object.fromEntries(item.handlerNames.map(name => [name, () => ({})])) : options.handlers;
      const limits = item.resultBytes ? { resultBytes: item.resultBytes } : item.frameBytes ? { frameBytes: item.frameBytes } : options.limits;
      const failureText = item.fixtureKind ? (error: unknown) => error instanceof ResultTooLarge ? item.limitText : undefined : options.failureText;
      const [result] = await runTranscripts([item], { ...options, tools: item.tools ? normalizeRecordedTools(item.tools) : options.tools, handlers, limits, failureText });
      expect(result.actual, result.id).toBe(item.packageOutput ?? result.expected);
    }
  });
}

test("shared cases run with each consumer's options and tool schemas", async () => {
  const data = JSON.parse(readFileSync("test/schema-samples.json", "utf8")) as { rows: { name: string; schema: Record<string, unknown> }[] };
  const recordedTools = (file: string) => {
    const cases = readFileSync(`fixtures/v1/${file}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return normalizeRecordedTools(cases.find(item => item.tools?.length)?.tools as ServeOptions["tools"]);
  };
  const schemas = (prefix: string) => data.rows.filter(row => row.name.startsWith(`${prefix}:`)).map(row => ({ name: row.name.slice(prefix.length + 1), description: "", inputSchema: recordedSchema(row.schema) }));
  const copies = [
    { name: "amem", tools: recordedTools("agent-mem"), frameBytes: 65_536, resultBytes: 262_144 },
    { name: "vault-mem", tools: schemas("vault"), frameBytes: 65_536, resultBytes: 262_144, instructions: "fixture instructions", toolFrameBytes: (name: string) => name.startsWith("vmem_proposal_") || ["vmem_assert", "vmem_assertions", "vmem_assertions_purge", "vmem_assertions_exposure"].includes(name) ? 48 * 1024 : undefined },
    { name: "agent-research", tools: schemas("research"), frameBytes: 131_072, resultBytes: 2_097_152 },
    { name: "adec", tools: recordedTools("agent-decide"), frameBytes: 1_048_576, resultBytes: Infinity },
  ];
  for (const copy of copies) {
    const results = await runTranscripts({ name: copy.name, version: "fixture", tools: copy.tools, handlers: Object.fromEntries(copy.tools.map(tool => [tool.name, () => ({})])), instructions: copy.instructions,
      limits: { frameBytes: copy.frameBytes, resultBytes: copy.resultBytes, toolFrameBytes: copy.toolFrameBytes },
      failureText: error => error instanceof ResultTooLarge ? "result limit" : (error as { code?: string }).code === "candidate_queue_full" ? "queue full" : undefined,
    });
    for (const result of results) expect(result.actual, `${copy.name}:${result.id}`).toBe(result.expected);
  }
});
