import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { readFrames } from "../src/framing.ts";
import { argumentError, schemaError, validArguments, writeConfirmed } from "../src/index.ts";

describe("validator", () => {
  test("validates union branches, limits and unsafe values", () => {
    const schema = { oneOf: [{ type: "string", pattern: "^a", maxLength: 4 }, { type: "integer", minimum: 1 }] };
    expect(validArguments("abc", schema)).toBe(true);
    expect(validArguments(2, schema)).toBe(true);
    expect(validArguments("xyz", schema)).toBe(false);
    expect(validArguments("a\0", {})).toBe(false);
    expect(validArguments(JSON.parse('{"constructor":1}'), {})).toBe(false);
    expect(validArguments("x", { type: "string", unknown: true })).toBe(false);
    expect(argumentError({ x: "abc" }, { type: "object", properties: { x: { type: "string", maxLength: 2 } } })).toBe("x: longer than 2");
  });
});

test("frame overflow recovers and incomplete and invalid UTF-8 are refused", async () => {
  const frames: string[] = [], errors: string[] = [];
  await readFrames(Readable.from([Buffer.from("123456\nok\npartial")]), 5, async line => { frames.push(line); }, async error => { errors.push(error); });
  expect(frames).toEqual(["ok"]);
  expect(errors).toEqual(["overflow", "incomplete"]);
  errors.length = 0;
  await readFrames(Readable.from([Buffer.from([0xc3])]), 5, async () => {}, async error => { errors.push(error); });
  expect(errors).toEqual(["utf8"]);
});

test("writeConfirmed waits for the write callback", async () => {
  let done: ((error?: Error | null) => void) | undefined;
  const output = new Writable({ write(_chunk, _encoding, callback) { done = callback; } });
  let resolved = false;
  const write = writeConfirmed(output, "response\n").then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  done?.();
  await write;
  expect(resolved).toBe(true);
});

test("initialize requires capabilities and client info and negotiates protocol", async () => {
  const { initialize } = await import("../src/initialize.ts");
  expect(initialize({ protocolVersion: "unknown" }, "example", "1")).toBeUndefined();
  expect(initialize({ protocolVersion: "unknown", capabilities: {}, clientInfo: {} }, "example", "1")?.protocolVersion).toBe("2025-06-18");
});

test("observer runs only after a successful response write", async () => {
  const { serve } = await import("../src/index.ts");
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fail", arguments: {} } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  const writes: string[] = [], observations: unknown[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback(); } });
  await serve({ name: "fixture", version: "1", input: Readable.from([request]), output,
    tools: ["echo", "fail"].map(name => ({ name, description: name, inputSchema: { type: "object", additionalProperties: false } })),
    handlers: { echo: () => ({ ok: true }), fail: () => { throw Error("sensitive"); } },
    onEmitted: (tool, id, value) => { observations.push([tool, id, value, writes.length]); },
  });
  expect(observations).toEqual([["echo", 2, { ok: true }, 2]]);
  expect(writes.join("")).not.toContain("sensitive");
});

// agent-decide has no schema validator, so its original admission is unconditional.
test("consumer schemas preserve recorded validator samples", async () => {
  const { samples, rows } = await Bun.file("test/schema-samples.json").json() as { samples: unknown[]; rows: { name: string; schema: unknown; results: boolean[]; accepted: unknown; originalAccepted: boolean }[] };
  for (const row of rows) {
    expect(samples.map(sample => validArguments(row.name.startsWith("agent-mem:") ? sample ?? {} : sample, row.schema)), row.name).toEqual(row.results);
    expect(row.originalAccepted, `${row.name}: original accepts sample`).toBe(true);
    expect(validArguments(row.accepted, row.schema), `${row.name}: accepted sample`).toBe(true);
  }
});

test("shared conformance uses consumer tools for protocol and fixture handlers for calls", async () => {
  const { runTranscripts, ResultTooLarge } = await import("../src/index.ts");
  const observed: string[] = [];
  const results = await runTranscripts({
    name: "consumer", version: "2", instructions: "fixture instructions",
    tools: [{ name: "special", description: "real tool", inputSchema: { type: "object", additionalProperties: false } }],
    handlers: { special: () => { throw Error("notification invoked a handler"); } },
    limits: { frameBytes: 1024, resultBytes: 128, toolFrameBytes: name => name === "special" ? 512 : undefined },
    failureText: error => error instanceof ResultTooLarge ? "limited" : (error as { code?: string }).code === "candidate_queue_full" ? "queue full" : undefined,
    onEmitted: name => { observed.push(name); },
  });
  for (const result of results) expect(result.actual, result.id).toBe(result.expected);
  expect(results.some(result => result.id === "tool-frame-bound")).toBe(true);
  expect(observed).toEqual(["echo"]);
});

test("exclusive minimum and unique arrays are enforced", () => {
  expect(validArguments(1, { type: "number", exclusiveMinimum: 0 })).toBe(true);
  expect(validArguments(0, { type: "number", exclusiveMinimum: 0 })).toBe(false);
  const schema = { type: "array", items: {}, uniqueItems: true };
  expect(validArguments(["a", "b"], schema)).toBe(true);
  expect(validArguments([{ a: 1, b: 2 }, { b: 2, a: 1 }], schema)).toBe(false);
});

test("invalid calls report the schema limit without echoing values", async () => {
  const { runTranscripts } = await import("../src/index.ts");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const input = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } }) + line({ jsonrpc: "2.0", method: "notifications/initialized" }) + line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "secret" } } }) + line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "missing" } });
  const expected = line({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fixture", version: "1" } } }) + line({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "text: longer than 3" } }) + line({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid tool name or arguments" } });
  const [result] = await runTranscripts([{ id: "limit", input, output: expected }], { name: "fixture", version: "1", tools: [{ name: "echo", description: "", inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false } }], handlers: { echo: () => ({}) }, limits: { defaultStringLength: 3 } });
  expect(result.actual).toBe(expected);
  expect(result.actual).not.toContain("secret");
});

test("deep arguments and unexpected request failures do not end the session", async () => {
  const { serve, ERROR } = await import("../src/index.ts");
  let output = "";
  const writer = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const init = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } }) + line({ jsonrpc: "2.0", method: "notifications/initialized" });
  const deep = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"v":' + "[".repeat(32_000) + "0" + "]".repeat(32_000) + '}}}\n';
  const crash = line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "crash" } });
  const ping = line({ jsonrpc: "2.0", id: 4, method: "ping" });
  await serve({ name: "test", version: "1", input: Readable.from([init + deep + crash + ping]), output: writer,
    tools: [{ name: "echo", description: "", inputSchema: { type: "object", properties: { v: {} }, additionalProperties: false } }],
    handlers: { echo: () => true }, limits: { toolFrameBytes: name => { if (name === "crash") throw Error("private detail"); return undefined; } },
  });
  const messages = output.trim().split("\n").map(row => JSON.parse(row));
  expect(messages.find(item => item.id === 2).error).toEqual({ code: -32602, message: "v: nested deeper than 64" });
  expect(messages.find(item => item.id === 3).error).toEqual({ code: ERROR.INTERNAL_ERROR, message: "Internal error while handling the request; retry, and report it to the server maintainer if it persists" });
  expect(messages.find(item => item.id === 4).result).toEqual({});
  expect(output).not.toContain("private detail");
});

test("confirmed write failure rejects and closes the server", async () => {
  const { serve } = await import("../src/index.ts");
  const failure = Object.assign(new Error("write failed"), { code: "EPIPE" });
  let writes = 0, closed = false, observed = false;
  const output = new Writable({ write(_chunk, _encoding, callback) { writes++; callback(writes === 2 ? failure : undefined); } });
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const input = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } }) + line({ jsonrpc: "2.0", method: "notifications/initialized" }) + line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
  await expect(serve({ name: "fixture", version: "1", input: Readable.from([input]), output,
    tools: [{ name: "echo", description: "", inputSchema: { type: "object", additionalProperties: false } }],
    handlers: { echo: () => ({ ok: true }) }, onEmitted: () => { observed = true; }, close: () => { closed = true; },
  })).rejects.toBe(failure);
  expect(closed).toBe(true);
  expect(observed).toBe(false);
  expect(writes).toBe(2);
});

test("unbounded result limit preserves large successful results", async () => {
  const { serve } = await import("../src/index.ts");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const input = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } }) + line({ jsonrpc: "2.0", method: "notifications/initialized" }) + line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "large" } });
  let output = "";
  await serve({ name: "fixture", version: "1", input: Readable.from([input]), output: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }), limits: { resultBytes: Infinity }, tools: [{ name: "large", description: "", inputSchema: { type: "object", additionalProperties: false } }], handlers: { large: () => "x".repeat(300_000) } });
  const result = JSON.parse(output.trim().split("\n")[1]).result;
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text).length).toBe(300_000);
  expect(validArguments("abcd", { type: "string" }, 3)).toBe(false);
});

test("schemaError reports unsupported forms and nested paths", () => {
  const cases: [unknown, string, string][] = [
    [{ type: "string", format: "uri" }, '$["format"]', "supported keyword"],
    [{ type: ["array", "null"] }, "$.items", "add an item schema"],
    [{ oneOf: [] }, "$.oneOf", "1 to 16 schema objects"],
    [{ oneOf: [{}], type: "string" }, "$.oneOf", "no sibling keywords"],
    [{ oneOf: [false] }, "$.oneOf[0]", "expected a schema object"],
    [{ type: ["object", "null"] }, "$", "declare properties"],
    [{ type: "object", properties: { "a.b": { type: "object" } } }, '$.properties["a.b"]', "declare properties"],
    [{ type: "array", items: { type: "array" } }, "$.items.items", "add an item schema"],
    [{ type: "object", additionalProperties: { type: "object" } }, "$.additionalProperties", "declare properties"],
    [{ oneOf: [{ type: "object" }] }, "$.oneOf[0]", "declare properties"],
  ];
  for (const [schema, path, fix] of cases) {
    const error = schemaError(schema);
    expect(error?.startsWith(path + ":")).toBe(true);
    expect(error).toContain(fix);
  }
  for (const schema of [
    {},
    { type: "object", properties: { name: { type: "string" } } },
    { type: "object", additionalProperties: false },
    { type: "object", additionalProperties: true },
    { type: "object", additionalProperties: {} },
    { oneOf: [{ type: ["array", "null"], items: {} }, { type: "string" }] },
  ]) {
    expect(schemaError(schema)).toBeUndefined();
  }
});

test("additionalProperties true uses empty-schema validation", () => {
  for (const additionalProperties of [true, {}]) {
    const schema = { type: "object", additionalProperties };
    expect(validArguments({ a: 1 }, schema)).toBe(true);
    expect(validArguments({ a: "\0" }, schema)).toBe(false);
    expect(validArguments({ ["a\0"]: 1 }, schema)).toBe(false);
    expect(validArguments({ a: { ["b\0"]: 1 } }, schema)).toBe(false);
    expect(validArguments({ ["__proto__"]: 1 }, schema)).toBe(false);
  }
});

test("serve rejects an invalid tool schema before reading or writing", async () => {
  const { serve } = await import("../src/index.ts");
  let reads = 0, writes = 0;
  const input = new Readable({ read() { reads++; this.push(null); } });
  const output = new Writable({ write(_chunk, _encoding, callback) { writes++; callback(); } });
  await expect(serve({
    name: "fixture", version: "1", input, output,
    tools: [
      { name: "valid", description: "", inputSchema: { type: "object", properties: {} } },
      { name: "invalid", description: "", inputSchema: { type: "object", properties: { arg: { type: "object" } } } },
    ],
    handlers: {},
  })).rejects.toThrow(/Tool "invalid" inputSchema at \$\.properties\["arg"\].*declare properties/);
  expect(reads).toBe(0);
  expect(writes).toBe(0);
});
