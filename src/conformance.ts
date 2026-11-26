import { OPAQUE_FAILURE } from "./messages.ts";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { serve, ResultTooLarge, type ServeOptions } from "./server.ts";

/** A recorded request stream and its exact response stream. */
export interface TranscriptCase { id: string; input: string | number[] | { repeat: string; count: number; suffix: string }; output: string; packageOutput?: string; spec?: string }
export interface TranscriptResult { id: string; expected: string; actual: string; passed: boolean }
/** Replay transcript cases against a consumer's actual tool table and options. */
export function runTranscripts(options: Omit<ServeOptions, "input" | "output" | "close">): Promise<TranscriptResult[]>;
export function runTranscripts(cases: readonly TranscriptCase[], options: Omit<ServeOptions, "input" | "output" | "close">): Promise<TranscriptResult[]>;
export async function runTranscripts(casesOrOptions: readonly TranscriptCase[] | Omit<ServeOptions, "input" | "output" | "close">, suppliedOptions?: Omit<ServeOptions, "input" | "output" | "close">): Promise<TranscriptResult[]> {
  if (!Array.isArray(casesOrOptions)) return runConformance(casesOrOptions as Omit<ServeOptions, "input" | "output" | "close">);
  const cases = casesOrOptions as readonly TranscriptCase[], options = suppliedOptions!;
  const results: TranscriptResult[] = [];
  for (const item of cases) {
    let actual = "";
    const output = new Writable({ write(chunk, _encoding, callback) { actual += chunk.toString(); callback(); } });
    const input = typeof item.input === "string" || Array.isArray(item.input) ? item.input : item.input.repeat.repeat(item.input.count) + item.input.suffix;
    await serve({ ...options, input: Readable.from([Buffer.from(input)]), output });
    const expected = item.packageOutput ?? item.output;
    results.push({ id: item.id, expected, actual, passed: actual === expected });
  }
  return results;
}

/** Run the shared protocol and handler cases with a consumer's configuration. */
export async function runConformance(options: Omit<ServeOptions, "input" | "output" | "close">): Promise<TranscriptResult[]> {
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const request = (id: number, method: string, params?: unknown) => line({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  const response = (id: number | null, result: unknown) => line({ jsonrpc: "2.0", id, result });
  const err = (id: number | null, code: number, message: string) => line({ jsonrpc: "2.0", id, error: { code, message } });
  const ready = request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} }) + line({ jsonrpc: "2.0", method: "notifications/initialized" });
  const initializeResponse = (protocolVersion: string) => response(1, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name, version: options.version }, ...(options.instructions === undefined ? {} : { instructions: options.instructions }) });
  const initialized = initializeResponse("2025-06-18");
  const frameBytes = options.limits?.frameBytes ?? 65_536;
  const resultBytes = options.limits?.resultBytes ?? 262_144;
  const cases: { item: TranscriptCase; options: Omit<ServeOptions, "input" | "output" | "close"> }[] = [];
  const add = (id: string, input: string | number[], output: string, selected = options) => cases.push({ item: { id, input, output }, options: selected });
  add("phases", request(2, "ping") + request(3, "tools/list") + ready + request(4, "ping") + request(5, "unknown"), response(2, {}) + err(3, -32002, "Initialize the session first") + initialized + response(4, {}) + err(5, -32601, "Method not found"));
  add("reinitialize", ready + request(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} }), initialized + err(2, -32602, "Invalid initialization"));
  add("invalid-call-params", ready + request(2, "tools/call", []), initialized + err(2, -32602, "Invalid tool call"));
  add("list", ready + request(2, "tools/list") + request(3, "tools/list", { cursor: "x" }), initialized + response(2, { tools: options.tools }) + err(3, -32602, "Invalid tool listing arguments"));
  add("invalid-id", ready + line({ jsonrpc: "2.0", id: null, method: "ping" }), initialized + err(null, -32600, "Invalid request id"));
  add("notification", ready + line({ jsonrpc: "2.0", method: "tools/call", params: { name: options.tools[0]?.name ?? "missing", arguments: {} } }) + request(2, "ping"), initialized + response(2, {}));
  add("unknown-tool", ready + request(2, "tools/call", { name: "__mcp_stdio_unknown_tool__" }), initialized + err(2, -32602, "Invalid tool name or arguments"));
  add("overflow", "x".repeat(frameBytes + 1) + "\n" + request(2, "ping"), err(null, -32600, `Request exceeds the ${frameBytes % 1024 === 0 ? `${frameBytes / 1024} KiB` : `${frameBytes} bytes`} frame bound`) + response(2, {}));
  add("invalid-utf8", [195], err(null, -32700, "Invalid UTF-8 input"));
  add("incomplete", "{", err(null, -32700, "Incomplete request at EOF"));
  const objectTool = options.tools.find(tool => tool.inputSchema.type === "object" && Object.hasOwn(options.handlers, tool.name));
  if (objectTool) add("consumer-invalid-arguments", ready + request(2, "tools/call", { name: objectTool.name, arguments: [] }), initialized + err(2, -32602, "arguments: expected object"));
  const schema = { type: "object", properties: { text: { type: "string" } }, additionalProperties: false };
  const fixtureNames = ["echo", "fail", "named", "large"];
  const tools = fixtureNames.map(name => ({ name, description: name, inputSchema: schema }));
  const failure = new Error("fixture failure"), named = { code: "candidate_queue_full" };
  const fixtureOptions = { ...options, tools, handlers: { echo: (args: Record<string, unknown>) => args, fail: () => { throw failure; }, named: () => { throw named; }, large: () => "x".repeat(Number.isFinite(resultBytes) ? resultBytes + 1 : 262_145) } };
  const failureResult = (value: unknown) => {
    let text: string | undefined;
    try { text = options.failureText?.(value); } catch { /* same fallback as serve */ }
    return { isError: true, content: [{ type: "text", text: text ?? OPAQUE_FAILURE }] };
  };
  add("invalid-arguments", ready + request(2, "tools/call", { name: "echo", arguments: { text: 7 } }), initialized + err(2, -32602, "text: expected string"), fixtureOptions);
  const oversizeInput = Number.isFinite(resultBytes) ? request(4, "tools/call", { name: "large" }) : "";
  const oversizeOutput = Number.isFinite(resultBytes) ? response(4, failureResult(new ResultTooLarge(resultBytes))) : "";
  add("handler-failures", ready + request(2, "tools/call", { name: "fail" }) + request(3, "tools/call", { name: "named" }) + oversizeInput, initialized + response(2, failureResult(failure)) + response(3, failureResult(named)) + oversizeOutput, fixtureOptions);
  add("emitted", ready + request(2, "tools/call", { name: "echo", arguments: {} }), initialized + response(2, { content: [{ type: "text", text: "{}" }] }), fixtureOptions);
  const boundedName = options.tools.find(tool => { const bound = options.limits?.toolFrameBytes?.(tool.name); return bound !== undefined && bound < frameBytes; })?.name;
  if (boundedName) {
    const bound = options.limits!.toolFrameBytes!(boundedName)!;
    const boundedTools = [{ name: boundedName, description: "bound", inputSchema: schema }];
    const boundedOptions = { ...options, tools: boundedTools, handlers: { [boundedName]: () => ({}) } };
    const call = request(2, "tools/call", { name: boundedName, arguments: { text: "x".repeat(bound) } });
    if (Buffer.byteLength(call) - 1 <= frameBytes) add("tool-frame-bound", ready + call, initialized + err(2, -32600, `${boundedName} request exceeds ${bound % 1024 === 0 ? `${bound / 1024} KiB` : `${bound} bytes`} as the frame it was sent in; shorten the request or split the batch`), boundedOptions);
  }
  const results: TranscriptResult[] = [];
  for (const { item, options: selected } of cases) {
    let observed = 0;
    const current = item.id === "emitted" ? { ...selected, onEmitted: async (tool: string, id: string | number, value: unknown) => { observed++; await selected.onEmitted?.(tool, id, value); } } : selected;
    results.push(...await runTranscripts([item], current));
    if (item.id === "emitted") results.push({ id: "emitted-observation", expected: "1", actual: String(observed), passed: observed === 1 });
  }
  const versionedFixture = await readFile(new URL("../fixtures/v1/2025-11-25.jsonl", import.meta.url), "utf8");
  const versionedCases: TranscriptCase[] = versionedFixture.trimEnd().split("\n").map(line => {
    const item = JSON.parse(line) as TranscriptCase;
    // The fixture starts with initialize. Adapt only its server identity and instructions.
    const output = initializeResponse("2025-11-25") + item.output.slice(item.output.indexOf("\n") + 1);
    return { ...item, output };
  });
  results.push(...await runTranscripts(versionedCases, fixtureOptions));
  return results;
}
