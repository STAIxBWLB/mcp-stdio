import { OPAQUE_FAILURE } from "./messages.ts";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { readFrames } from "./framing.ts";
import { initialize, PROTOCOL_VERSIONS, STATELESS_VERSION } from "./initialize.ts";
import { argumentError, outputError, schemaError } from "./validator.ts";
import { writeConfirmed } from "./write-confirmed.ts";

export const ERROR = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603, INVALID_PARAMS: -32602, NOT_INITIALIZED: -32002, UNSUPPORTED_PROTOCOL_VERSION: -32022 } as const;
export class ResultTooLarge extends Error {
  constructor(public readonly limit: number) { super("result too large"); this.name = "ResultTooLarge"; }
}
interface ToolIcon {
  src: string;
  mimeType?: string;
  sizes?: readonly string[];
  theme?: "light" | "dark";
}
interface ToolAnnotations {
  // Boolean titles were allowed by the original boolean annotation map.
  title?: string | boolean;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [hint: string]: string | boolean | undefined;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  icons?: readonly ToolIcon[];
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}
export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export interface ServeOptions {
  name: string; version: string; instructions?: string;
  tools: readonly Tool[]; handlers: Record<string, Handler>;
  input?: Readable; output?: Writable; close?: () => void | Promise<void>;
  limits?: { frameBytes?: number; resultBytes?: number; defaultStringLength?: number; toolFrameBytes?: (name: string) => number | undefined };
  listCache?: { ttlMs: number; cacheScope: "private" | "public" };
  failureText?: (error: unknown) => string | undefined;
  onEmitted?: (tool: string, id: string | number, value: unknown) => void | Promise<void>;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const NO_CACHE = { ttlMs: 0, cacheScope: "private" } as const;

/** MCP basic/transports: newline stdio only. Sequential, bounded, no listener or timer. */
export async function serve(options: ServeOptions): Promise<void> {
  for (const tool of options.tools) {
    for (const field of ["inputSchema", "outputSchema"] as const) {
      const schema = tool[field];
      if (field === "outputSchema" && schema === undefined) continue;
      const invalid = schemaError(schema);
      if (invalid) throw new Error(`Tool ${JSON.stringify(tool.name)} ${field} at ${invalid}`);
    }
  }
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const frameBytes = options.limits?.frameBytes ?? 65_536, resultBytes = options.limits?.resultBytes ?? 262_144;
  let phase: "new" | "initializing" | "ready" = "new";
  let protocolVersion: (typeof PROTOCOL_VERSIONS)[number] | undefined;
  let stateless = false;
  const serverInfo = { name: options.name, version: options.version };
  let confirmedWriteFailed = false;
  const send = async (response: unknown) => { if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain"); };
  const error = (id: unknown, code: number, message: string, data?: unknown) =>
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const complete = (result: Record<string, unknown>) =>
    ({ resultType: "complete", ...result, _meta: { [SERVER_INFO_KEY]: serverInfo } });
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
    const params = msg.params;
    const meta = plain(params) && plain(params._meta) ? params._meta : undefined;
    const modernRequest = meta !== undefined && (Object.hasOwn(meta, VERSION_KEY) || Object.hasOwn(meta, CAPABILITIES_KEY));
    if (modernRequest && phase !== "new") {
      await error(id, ERROR.INVALID_PARAMS, "This process is in the initialize era. Send initialize-era requests without stateless metadata, or start a new server process for stateless requests."); return;
    }
    const discover = msg.method === "server/discover";
    const modern = modernRequest || stateless;

    if (modern) {
      if (msg.method === "initialize") {
        const message = stateless
          ? `This process is in the stateless era. Supported stateless versions: ${STATELESS_VERSION}. Send stateless requests with _meta, or start a new server process to initialize.`
          : `Initialize requests cannot carry stateless metadata. Send initialize without stateless metadata, or send stateless requests with both ${VERSION_KEY} and ${CAPABILITIES_KEY} in _meta. Supported stateless versions: ${STATELESS_VERSION}.`;
        await error(id, ERROR.METHOD_NOT_FOUND, message);
        return;
      }
      const requested = meta?.[VERSION_KEY];
      if (typeof requested !== "string") {
        await error(id, ERROR.INVALID_PARAMS, `Stateless requests require _meta["${VERSION_KEY}"] as a string`);
        return;
      }
      if (!plain(meta?.[CAPABILITIES_KEY])) {
        await error(id, ERROR.INVALID_PARAMS, `Stateless requests require _meta["${CAPABILITIES_KEY}"] as an object`);
        return;
      }
      if (requested !== STATELESS_VERSION) {
        await error(id, ERROR.UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: PROTOCOL_VERSIONS, requested });
        return;
      }
      if (discover) {
        if (!plain(params) || Object.keys(params).some(key => key !== "_meta")) {
          await error(id, ERROR.INVALID_PARAMS, "Invalid discovery parameters. Send only _meta in params."); return;
        }
        await send({ jsonrpc: "2.0", id, result: complete({
          supportedVersions: PROTOCOL_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
          ...NO_CACHE,
        }) });
        return;
      }
      stateless = true;
    }
    if (!modern && msg.method === "ping") { await send({ jsonrpc: "2.0", id, result: {} }); return; }
    if (msg.method === "initialize") {
      const result = initialize(msg.params, options.name, options.version, options.instructions);
      if (phase !== "new" || !result) { await error(id, ERROR.INVALID_PARAMS, "Invalid initialization"); return; }
      protocolVersion = result.protocolVersion;
      phase = "initializing"; await send({ jsonrpc: "2.0", id, result }); return;
    }
    if (!modern && phase !== "ready") { await error(id, ERROR.NOT_INITIALIZED, "Initialize the session first"); return; }
    if (msg.method === "tools/list") {
      if (params !== undefined && params !== null && (!plain(params) || Object.keys(params).some(key => key !== "cursor" && key !== "_meta") || params.cursor !== undefined && params.cursor !== null || !modern && params._meta !== undefined && !plain(params._meta))) { await error(id, ERROR.INVALID_PARAMS, "Invalid tool listing arguments"); return; }
      const result = { tools: options.tools };
      await send({ jsonrpc: "2.0", id, result: modern ? complete({ ...result, ...(options.listCache ?? NO_CACHE) }) : result });
      return;
    }
    if (msg.method !== "tools/call") { await error(id, ERROR.METHOD_NOT_FOUND, "Method not found"); return; }
    const invalidCall = modern ? "Invalid tool call; provide params.name as a string and, if supplied, params.arguments as an object" : "Invalid tool call";
    if (!plain(params) || Object.keys(params).some(k => !["name", "arguments", "_meta"].includes(k)) || typeof params.name !== "string") { await error(id, ERROR.INVALID_PARAMS, invalidCall); return; }
    const bound = options.limits?.toolFrameBytes?.(params.name);
    if (bound !== undefined && Buffer.byteLength(line, "utf8") + 1 > bound) { await error(id, ERROR.INVALID_REQUEST, `${params.name} request exceeds ${bound % 1024 === 0 ? `${bound / 1024} KiB` : `${bound} bytes`} as the frame it was sent in; shorten the request or split the batch`); return; }
    const definition = options.tools.find(t => t.name === params.name), args = params.arguments ?? {};
    const handler = definition && Object.hasOwn(options.handlers, definition.name) ? options.handlers[definition.name] : undefined;
    if (!definition || !handler) { await error(id, ERROR.INVALID_PARAMS, "Invalid tool name or arguments"); return; }
    const revision = modern ? STATELESS_VERSION : protocolVersion ?? "";
    const toolArgumentErrors = revision >= "2025-11-25";
    if (toolArgumentErrors && Object.hasOwn(params, "arguments") && !plain(params.arguments)) {
      await error(id, ERROR.INVALID_PARAMS, invalidCall); return;
    }
    const invalid = argumentError(args, definition.inputSchema, "", options.limits?.defaultStringLength);
    if (invalid) {
      if (toolArgumentErrors) {
        const result = { isError: true, content: [{ type: "text", text: invalid }] };
        await send({ jsonrpc: "2.0", id, result: modern ? complete(result) : result });
      } else await error(id, ERROR.INVALID_PARAMS, invalid);
      return;
    }
    let result: Record<string, unknown>, observedValue: unknown, succeeded = false;
    try {
      const value = await handler(args as Record<string, unknown>), text = JSON.stringify(value);
      if (text === undefined) throw new Error("result unavailable");
      if (Buffer.byteLength(text) > resultBytes) throw new ResultTooLarge(resultBytes);
      result = { content: [{ type: "text", text }] };
      if (definition.outputSchema !== undefined && revision >= "2025-06-18") {
        // Validate the JSON on the wire and reuse it so both content representations agree.
        const structuredContent: unknown = JSON.parse(text);
        const invalidOutput = outputError(structuredContent, definition.outputSchema);
        if (invalidOutput) throw new Error(`Tool result does not match outputSchema: ${invalidOutput}`);
        if (!modern && !plain(structuredContent)) {
          throw new Error("Structured tool results in the initialize era require a JSON object");
        }
        result.structuredContent = structuredContent;
      }
      observedValue = value;
      succeeded = true;
    } catch (failure) {
      let text: string | undefined;
      try { text = options.failureText?.(failure); } catch { /* failure shaping cannot break the protocol */ }
      result = { isError: true, content: [{ type: "text", text: text ?? OPAQUE_FAILURE }] };
    }
    if (modern) result = complete(result);
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
        await error(id, ERROR.INTERNAL_ERROR, "Internal error while handling the request; retry, and report it to the server maintainer if it persists");
      }
    }, async kind => {
      if (kind === "overflow") await error(null, ERROR.INVALID_REQUEST, `Request exceeds the ${frameBytes % 1024 === 0 ? `${frameBytes / 1024} KiB` : `${frameBytes} bytes`} frame bound`);
      else if (kind === "utf8") await error(null, ERROR.PARSE_ERROR, "Invalid UTF-8 input");
      else await error(null, ERROR.PARSE_ERROR, "Incomplete request at EOF");
    });
  } finally { await options.close?.(); }
}
