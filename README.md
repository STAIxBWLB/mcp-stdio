# @staix/mcp-stdio

A zero-runtime-dependency MCP stdio server core for Bun 1.4.4 or later. Messages are newline-delimited JSON-RPC and requests are handled sequentially.

```ts
import { serve } from "@staix/mcp-stdio";

await serve({
  name: "example", version: "1.0.0",
  tools: [{ name: "echo", description: "Return a message", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } }],
  handlers: { echo: args => args },
});
```

`serve` accepts `instructions`, input/output streams, a close callback and limits for frame bytes, result bytes, default string length and individual tool frame bytes. Defaults are 64 KiB, 256 KiB and 64 KiB respectively. `failureText` can map a thrown error or `ResultTooLarge` to client-facing text. The consumer decides what is safe to disclose. The default response is opaque. `onEmitted` observes successful calls only after the output callback confirms the write.

`validArguments(value, schema)` and `argumentError(value, schema)` validate the bounded schema vocabulary. `writeConfirmed(output, text)`, `PROTOCOL_VERSIONS`, `ERROR` and `ResultTooLarge` are also exported. `runTranscripts(options)` runs the shared protocol cases against the consumer tool table and the handler-dependent cases with fixture tools, retaining the consumer options. `runTranscripts(cases, options)` replays recorded input/output streams and returns exact comparison results.

To return an application-defined refusal in the tool result's text block, pass the following `failureText` mapper to `serve` and throw `ToolRefusal` from the handler. Use a trusted error type for messages intended for clients and bound the length before serializing. Other errors retain the default opaque message.

```ts
class ToolRefusal extends Error {}

const failureText = (error: unknown) => error instanceof ToolRefusal
  ? JSON.stringify({ refused: true, issues: [error.message.slice(0, 200)] })
  : undefined;
```

## Contract

Changes to the package follow these rules:

1. `tools/call` validates arguments against the advertised `inputSchema` under the rules in Tool input schemas and the configured limits. `serve` refuses ambiguous schema forms at startup, so they never surface at call time.
2. Behaviour added for a newer protocol revision is gated on that revision. Sessions on older revisions keep their existing responses.
3. Transcripts are per protocol version. Supporting a new MCP revision adds transcript files and never edits existing ones. Within a major version, an existing expected response changes only for a bug fix, which the CHANGELOG records.
4. The API changes only additively. New `ServeOptions` and `Tool` fields are optional, and their defaults keep current behaviour.

## Protocol negotiation

`2025-11-25` is the preferred initialize-era revision. The server also negotiates `2025-06-18`, `2025-03-26`, and `2024-11-05` when requested. Under `2025-11-25`, arguments that fail a tool's input schema produce a tool result with `isError: true` and a text diagnostic ([SEP-1303](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)). Unknown tools and malformed `tools/call` parameters use JSON-RPC `-32602`. Earlier negotiated revisions also use `-32602` for schema validation failures.

| Revision | stdio entry | Schema validation failure |
| --- | --- | --- |
| `2026-07-28` | Per-request metadata, with optional `server/discover` | Tool result with `isError: true` |
| `2025-11-25` | `initialize` and `notifications/initialized` | Tool result with `isError: true` |
| `2025-06-18`, `2025-03-26`, `2024-11-05` | `initialize` and `notifications/initialized` | JSON-RPC `-32602` |

For `2026-07-28`, send `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in `params._meta` on every request. A missing required field yields `-32602`. An unsupported version yields `-32022` with the supported versions. `server/discover` and pre-initialize legacy `ping` leave the era undecided. The first initialize handshake or stateless operation selects the era for that stdio process. The stateless era has no `ping`; use `server/discover` to query server information.

Stateless results include `resultType: "complete"` and server identity in `_meta`. Discovery and tool listings default to `ttlMs: 0` and `cacheScope: "private"`. Set `listCache` to change those values for stateless `tools/list`.

Tool definitions can include `title`, `icons`, `outputSchema`, and annotations with a display title and boolean hints.

## Tool input schemas

`serve` checks every tool's `inputSchema` before reading stdio. It rejects unsupported keywords, arrays without an `items` schema, malformed `oneOf` (use 1 to 16 schema objects as the sole keyword), and object schemas that omit both `properties` and `additionalProperties`. Use a supported `type` (or an array of supported types) for every schema other than `{}` and standalone `oneOf`. Keyword values must have the expected shape, including valid regular expression strings, finite numeric bounds, and non-negative integer counts. Startup errors identify the tool, schema location and correction. Use `schemaError(schema)` to check a tool table before startup. It returns the first diagnostic or `undefined`.

An object with `properties` and no `additionalProperties` accepts only declared keys. Use `additionalProperties: false` to express this explicitly, a schema to validate extra values, or `additionalProperties: true` (equivalent to `{}`) to accept extra values subject to empty-schema safety checks.

## Structured tool results

Declare `outputSchema` to return the handler's JSON value in `structuredContent` as well as the existing JSON text block. This applies to `2025-06-18`, `2025-11-25` and `2026-07-28`. The two initialize-era revisions require a JSON object for structured content. The stateless revision supports any JSON value allowed by the schema.

`serve` checks output schemas at startup with the same schema rules as input schemas. A handler result that fails output validation uses the existing tool failure response and `failureText` mapper. Output validation uses the bounds declared in the output schema. As in JSON Schema, omitted `additionalProperties` allows extra output fields. The configured result byte limit still applies to the serialized handler value.

To migrate a consumer, keep its tool definitions and handlers, pass its existing name, version, limits, instructions and safe failure mapping to `serve`, and remove its local loop and validator. Run the shared transcripts and preserve tests for the consumer's own tool behavior. For agent-decide, pass `limits: { resultBytes: Infinity }` to keep its current unbounded result behavior, and change the nested `question` and `request` schemas to include `additionalProperties: {}` so their existing fields remain accepted. Agent-mem can preserve its previous opaque wording through `failureText`. Review `fixtures/v1/DIVERGENCES.md` and the strict initialization and validation contract before migrating.

The cases generated by `runConformance` are part of the versioned transcript contract alongside `fixtures/v1`. The first release is 0.1.0. During 0.x, transcript or breaking API changes require a minor version; other changes are patches. Version 1.0.0 follows the four consumer migrations. After 1.0.0, transcript or breaking API changes require a major version; new options or schema keywords a minor version; fixes a patch. Publishing uses npm trusted publishing, after registration and release consent.

Each JSONL record contains an `id`, an input stream and its recorded output. Repeated overflow input is represented by a repeated string, count and suffix and expanded by the helper. A `packageOutput` field marks an intentional recorded divergence; the helper compares against that field when present. Consumer-specific recordings use the recorded tool table and frame limit for that case; the core cases use the fixture tools shown in the tests.
