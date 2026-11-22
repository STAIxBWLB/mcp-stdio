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

`serve` accepts `instructions`, input/output streams, a close callback and limits for frame bytes, result bytes, default string length and individual tool frame bytes. Defaults are 64 KiB, 256 KiB and 64 KiB respectively. `failureText` can map a thrown error or `ResultTooLarge` to a safe, content-free response; otherwise failures are opaque. `onEmitted` observes successful calls only after the output callback confirms the write.

`validArguments(value, schema)` and `argumentError(value, schema)` validate the bounded schema vocabulary. `writeConfirmed(output, text)`, `PROTOCOL_VERSIONS`, `ERROR` and `ResultTooLarge` are also exported. `runTranscripts(options)` runs the shared protocol cases against the consumer tool table and the handler-dependent cases with fixture tools, retaining the consumer options. `runTranscripts(cases, options)` replays recorded input/output streams and returns exact comparison results.

To migrate a consumer, keep its tool definitions and handlers, pass its existing name, version, limits, instructions and safe failure mapping to `serve`, and remove its local loop and validator. Run the shared transcripts and preserve tests for the consumer's own tool behavior. For agent-decide, change the nested `question` and `request` schemas to include `additionalProperties: {}` so their existing fields remain accepted. Agent-mem can preserve its previous opaque wording through `failureText`. Review `fixtures/v1/DIVERGENCES.md` and the strict initialization and validation contract before migrating.

The first release is 0.1.0. During 0.x, transcript or breaking API changes require a minor version; other changes are patches. Version 1.0.0 follows the four consumer migrations. After 1.0.0, transcript or breaking API changes require a major version; new options or schema keywords a minor version; fixes a patch. Publishing uses npm trusted publishing, after registration and release consent.

Each JSONL record contains an `id`, an input stream and its recorded output. Repeated overflow input is represented by a repeated string, count and suffix and expanded by the helper. A `packageOutput` field marks an intentional recorded divergence; the helper compares against that field when present. Consumer-specific recordings use the recorded tool table and frame limit for that case; the core cases use the fixture tools shown in the tests.
