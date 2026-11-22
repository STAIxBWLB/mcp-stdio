import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { readFrames } from "../src/framing.ts";
import { argumentError, validArguments, writeConfirmed } from "../src/index.ts";

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

test("consumer schemas preserve recorded validator samples", async () => {
  const { samples, rows } = await Bun.file("test/schema-samples.json").json() as { samples: unknown[]; rows: { name: string; schema: unknown; results: boolean[] }[] };
  for (const row of rows) expect(samples.map(sample => validArguments(row.name.startsWith("agent-mem:") ? sample ?? {} : sample, row.schema)), row.name).toEqual(row.results);
});
