/** Record protocol cases from sibling copies in place. Usage: bun scripts/record-copy-protocol.ts <source-root> */
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { ResultTooLarge } from "../src/server.ts";
import { runTranscripts, type TranscriptCase } from "../src/conformance.ts";

const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("Source root is required; pass the directory containing the four consumer checkouts.");
const line = (x: unknown) => JSON.stringify(x) + "\n";
const req = (id: unknown, method: string, params?: unknown) => line({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const ready = req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} }) + line({ jsonrpc: "2.0", method: "notifications/initialized" });
const cases: { name: string; input: string | number[] }[] = [
  { name: "phases-ping", input: req(2, "ping") + req(3, "tools/list") + ready + req(4, "ping") + req(5, "unknown/method") },
  { name: "notifications", input: ready + line({ jsonrpc: "2.0", method: "tools/call", params: { name: "nonexistent", arguments: {} } }) + req(2, "ping") },
  { name: "invalid-ids", input: ready + req(null, "ping") + req(true, "ping") + req(1.5, "ping") },
  { name: "invalid-utf8", input: [255] },
  { name: "truncated-eof", input: '{"jsonrpc":"2.0"' },
];
const identities: Record<string, [string, string]> = { "agent-mem": ["amem", "fixture"], "vault-mem": ["vault-mem", "fixture"], "agent-research": ["agent-research", "fixture"], "agent-decide": ["adec", "0.0.0"] };
let divergences = readFileSync("fixtures/v1/DIVERGENCES.md", "utf8").split("\n").filter(row => !row.includes("-protocol-") && !row.includes("-handler-") && !row.includes("-schema-")).join("\n").trimEnd() + "\n";
for (const copy of Object.keys(identities)) {
  const original = await import(resolve(sourceRoot, copy, "src/mcp.ts"));
  const [name, version] = identities[copy];
  const recordings = [];
  for (const test of cases) {
    let output = "", originalError: string | undefined;
    const input = typeof test.input === "string" ? Buffer.from(test.input) : Buffer.from(test.input);
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    try {
      if (copy === "agent-decide") await original.serveMcp("/tmp/mcp-stdio-fixture-home", Readable.from([input]), stream);
      else if (copy === "agent-mem") await original.serveMcp({ input: Readable.from([input]), output: stream, tools: {}, version });
      else await original.serveMcp({ input: Readable.from([input]), output: stream, tools: [], handlers: {}, name, version });
    } catch (error) { originalError = error instanceof Error ? error.name : "unknown"; }
    const item: TranscriptCase = { id: `${copy}-protocol-${test.name}`, input: test.input, output };
    const [result] = await runTranscripts([item], { name, version, tools: [], handlers: {}, ...(copy === "agent-decide" ? { limits: { resultBytes: Infinity } } : {}) });
    const recorded = { ...item, ...(originalError ? { originalError } : {}), ...(!result.passed ? { packageOutput: result.actual } : {}) };
    recordings.push(recorded);
    if (!result.passed) {
      const show = (value: string) => value.trim() ? value.trim().split("\n").map(text => `\`${text}\``).join(" ") : "no response";
      divergences += `| ${copy} | ${item.id} | ${show(output)}${originalError ? ` (throws ${originalError})` : ""} | ${show(result.actual)} | Protocol error behavior |\n`;
    }
  }
  writeFileSync(`fixtures/v1/${copy}-protocol.jsonl`, recordings.map(item => JSON.stringify(item)).join("\n") + "\n");
}
for (const copy of ["vault-mem", "agent-research"]) {
  const original = await import(resolve(sourceRoot, copy, "src/mcp.ts"));
  const resultBytes = copy === "vault-mem" ? 262_144 : 2_097_152;
  const limitText = JSON.stringify({ refused: true, issues: [{ code: "LIMIT", severity: "error", message: copy === "vault-mem" ? "result exceeds 256 KiB; narrow the request" : "result exceeds 2 MiB; narrow filters, lower the list limit or select fewer log streams" }] });
  const tests = [
    { kind: "handler-throw", schema: { type: "object", additionalProperties: false }, args: {}, handler: () => { throw Error("fixture failure"); } },
    { kind: "handler-oversize", schema: { type: "object", additionalProperties: false }, args: {}, handler: () => "x".repeat(resultBytes + 1) },
    ...(copy === "agent-research" ? [
      { kind: "schema-empty-nul", schema: { type: "object", properties: { v: {} }, required: ["v"], additionalProperties: false }, args: { v: "\0" }, handler: () => ({ ok: true }) },
      { kind: "schema-empty-forbidden", schema: { type: "object", properties: { v: {} }, required: ["v"], additionalProperties: false }, args: { v: JSON.parse('{"__proto__":1}') }, handler: () => ({ ok: true }) },
      { kind: "schema-empty-depth", schema: { type: "object", properties: { v: {} }, required: ["v"], additionalProperties: false }, args: { v: JSON.parse("[".repeat(65) + "0" + "]".repeat(65)) }, handler: () => ({ ok: true }) },
      { kind: "schema-unique", schema: { type: "object", properties: { citations: { type: "array", items: { type: "string" }, uniqueItems: true } }, required: ["citations"], additionalProperties: false }, args: { citations: ["a", "a"] }, handler: () => ({ ok: true }) },
      { kind: "schema-exclusive", schema: { type: "object", properties: { maxLoadRatio: { type: "number", exclusiveMinimum: 0 } }, required: ["maxLoadRatio"], additionalProperties: false }, args: { maxLoadRatio: 0 }, handler: () => ({ ok: true }) },
    ] : []),
  ];
  const recorded = [];
  for (const test of tests) {
    const tools = [{ name: "fixture", description: "fixture", inputSchema: test.schema, annotations: {} }];
    const handlers = { fixture: test.handler };
    const input = ready + req(2, "tools/call", { name: "fixture", arguments: test.args });
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    await original.serveMcp({ input: Readable.from([input]), output: stream, tools, handlers, name: copy, version: "fixture" });
    const item = { id: `${copy}-${test.kind}`, input, output };
    const [result] = await runTranscripts([item], { name: copy, version: "fixture", tools, handlers, limits: { resultBytes }, failureText: error => error instanceof ResultTooLarge ? limitText : undefined });
    recorded.push({ ...item, tools, fixtureKind: test.kind, resultBytes, limitText, ...(!result.passed ? { packageOutput: result.actual } : {}) });
    if (!result.passed) {
      const last = (value: string) => value.trim().split("\n").at(-1);
      divergences += `| ${copy} | ${item.id} | \`${last(output)}\` | \`${last(result.actual)}\` | ${test.kind === "handler-throw" ? "Opaque handler failure" : "Schema constraint enforcement"} |\n`;
    }
  }
  writeFileSync(`fixtures/v1/${copy}-handler.jsonl`, recorded.map(item => JSON.stringify(item)).join("\n") + "\n");
}
writeFileSync("fixtures/v1/DIVERGENCES.md", divergences);
