import { OPAQUE_FAILURE } from "./messages.ts";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { readFrames } from "./framing.ts";
import { initialize } from "./initialize.ts";
import { argumentError } from "./validator.ts";
import { writeConfirmed } from "./write-confirmed.ts";

export const ERROR = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603, INVALID_PARAMS: -32602, NOT_INITIALIZED: -32002 } as const;
export class ResultTooLarge extends Error {
  constructor(public readonly limit: number) { super("result too large"); this.name = "ResultTooLarge"; }
}
export interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }
export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export interface ServeOptions {
  name: string; version: string; instructions?: string;
  tools: readonly Tool[]; handlers: Record<string, Handler>;
  input?: Readable; output?: Writable; close?: () => void | Promise<void>;
  limits?: { frameBytes?: number; resultBytes?: number; defaultStringLength?: number; toolFrameBytes?: (name: string) => number | undefined };
  failureText?: (error: unknown) => string | undefined;
  onEmitted?: (tool: string, id: string | number, value: unknown) => void | Promise<void>;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** MCP basic/transports: newline stdio only. Sequential, bounded, no listener or timer. */
export async function serve(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const frameBytes = options.limits?.frameBytes ?? 65_536, resultBytes = options.limits?.resultBytes ?? 262_144;
  let phase: "new" | "initializing" | "ready" = "new";
  let confirmedWriteFailed = false;
  const send = async (response: unknown) => { if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain"); };
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const handle = async (line: string) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { await error(null, ERROR.PARSE_ERROR, "Parse error"); return; }
    if (!plain(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { await error(null, ERROR.INVALID_REQUEST, "Invalid request"); return; }
    if (!Object.hasOwn(msg, "id")) {
      if (msg.method === "notifications/initialized" && phase === "initializing") phase = "ready";
      return;
    }
    const id = msg.id;
    if (!(typeof id === "string" && id.length <= 200 || typeof id === "number" && Number.isSafeInteger(id))) { await error(null, ERROR.INVALID_REQUEST, "Invalid request id"); return; }
    if (msg.method === "ping") { await send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (msg.method === "initialize") {
      const result = initialize(msg.params, options.name, options.version, options.instructions);
      if (phase !== "new" || !result) { await error(id, ERROR.INVALID_PARAMS, "Invalid initialization"); return; }
      phase = "initializing"; await send({ jsonrpc: "2.0", id, result }); return;
    }
    if (phase !== "ready") { await error(id, ERROR.NOT_INITIALIZED, "Initialize the session first"); return; }
    if (msg.method === "tools/list") {
      const params = msg.params;
      if (params !== undefined && params !== null && (!plain(params) || Object.keys(params).some(key => key !== "cursor" && key !== "_meta") || params.cursor !== undefined && params.cursor !== null || params._meta !== undefined && (!plain(params._meta) || Object.keys(params._meta).length > 0))) { await error(id, ERROR.INVALID_PARAMS, "Invalid tool listing arguments"); return; }
      await send({ jsonrpc: "2.0", id, result: { tools: options.tools } }); return;
    }
    if (msg.method !== "tools/call") { await error(id, ERROR.METHOD_NOT_FOUND, "Method not found"); return; }
    const params = msg.params;
    if (!plain(params) || Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) || typeof params.name !== "string") { await error(id, ERROR.INVALID_PARAMS, "Invalid tool call"); return; }
    const bound = options.limits?.toolFrameBytes?.(params.name);
    if (bound !== undefined && Buffer.byteLength(line, "utf8") + 1 > bound) { await error(id, ERROR.INVALID_REQUEST, `${params.name} request exceeds ${bound % 1024 === 0 ? `${bound / 1024} KiB` : `${bound} bytes`} as the frame it was sent in; shorten the request or split the batch`); return; }
    const definition = options.tools.find(t => t.name === params.name), args = params.arguments ?? {};
    const handler = definition && Object.hasOwn(options.handlers, definition.name) ? options.handlers[definition.name] : undefined;
    if (!definition || !handler) { await error(id, ERROR.INVALID_PARAMS, "Invalid tool name or arguments"); return; }
    const invalid = argumentError(args, definition.inputSchema, "", options.limits?.defaultStringLength);
    if (invalid) { await error(id, ERROR.INVALID_PARAMS, invalid); return; }
    let result: unknown, observedValue: unknown, succeeded = false;
    try {
      const value = await handler(args as Record<string, unknown>), text = JSON.stringify(value);
      if (text === undefined) throw new Error("result unavailable");
      if (Buffer.byteLength(text) > resultBytes) throw new ResultTooLarge(resultBytes);
      result = { content: [{ type: "text", text }] }; observedValue = value; succeeded = true;
    } catch (failure) {
      let text: string | undefined;
      try { text = options.failureText?.(failure); } catch { /* failure shaping cannot break the protocol */ }
      result = { isError: true, content: [{ type: "text", text: text ?? OPAQUE_FAILURE }] };
    }
    if (succeeded && options.onEmitted) {
      try { await writeConfirmed(output, JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
      catch (failure) { confirmedWriteFailed = true; throw failure; }
      try { await options.onEmitted(definition.name, id as string | number, observedValue); } catch { /* observation never changes the response */ }
    } else await send({ jsonrpc: "2.0", id, result });
  };
  try {
    await readFrames(input, frameBytes, async line => {
      try { await handle(line); } catch (failure) {
        if (confirmedWriteFailed || output.destroyed || output.errored) throw failure;
        let id: string | number | null = null;
        try { const msg: unknown = JSON.parse(line); if (plain(msg) && (typeof msg.id === "string" && msg.id.length <= 200 || typeof msg.id === "number" && Number.isSafeInteger(msg.id))) id = msg.id as string | number; } catch { /* malformed requests have no usable id */ }
        await error(id, ERROR.INTERNAL_ERROR, "Internal error");
      }
    }, async kind => {
      if (kind === "overflow") await error(null, ERROR.INVALID_REQUEST, `Request exceeds the ${frameBytes % 1024 === 0 ? `${frameBytes / 1024} KiB` : `${frameBytes} bytes`} frame bound`);
      else if (kind === "utf8") await error(null, ERROR.PARSE_ERROR, "Invalid UTF-8 input");
      else await error(null, ERROR.PARSE_ERROR, "Incomplete request at EOF");
    });
  } finally { await options.close?.(); }
}
