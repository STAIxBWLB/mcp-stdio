# Changelog

All notable changes to `@staix/mcp-stdio` are recorded here. The format follows Keep a Changelog. During 0.x, a breaking API change or a changed transcript is a minor release and anything else a patch. 1.0.0 follows the four consumer migrations; from then on, those changes are a major release.

## [Unreleased]

- Tools with `outputSchema` return validated `structuredContent` alongside the JSON text block in revisions that support structured output, starting with `2025-06-18`. Invalid output schemas stop startup. Results that fail output validation use the existing handler-failure response and `failureText` mapper.

- Support stateless MCP `2026-07-28` alongside the initialize-era revisions, including `server/discover`, per-request metadata validation and stateless result metadata. Initialize-era responses are preserved. After a process selects an era, requests in the other era are rejected.
- The exported `PROTOCOL_VERSIONS` now starts with `2026-07-28`. The preferred revision for `initialize` remains `2025-11-25`.
- Add `listCache` for stateless `tools/list`. Tool listings and discovery default to private caching with a zero TTL.

- `initialize` prefers `2025-11-25` when the requested revision is unsupported. In sessions negotiated at `2025-11-25`, tool input schema failures return a tool result with `isError: true` and the validation message (SEP-1303). Earlier revisions keep their JSON-RPC validation errors.
- The `Tool` type supports optional titles, icons, output schemas and annotation titles.

- `serve` now refuses unsupported or ambiguous tool input schemas at startup, before reading input. Use the exported `schemaError` to check tool tables. Existing bare object arguments, including agent-decide's `question` and `request` (agent-decide#18) and the agent-research bare-object arguments (agent-research#198), need explicit object properties or an `additionalProperties` policy.
- `additionalProperties: true` accepts extra fields under the same safety rules as `additionalProperties: {}`.
- Argument validation rejects NUL characters in property names, including names inside objects accepted by an empty schema.
- Recorded transcripts keep their existing responses. The test harness declares the recorded bare objects as closed with `additionalProperties: false`, so the generated `tools/list` case advertises that explicit policy. `tools/list` still returns the supplied tool table.

## [0.1.0] - 2026-11-22

First release: a zero-runtime-dependency MCP stdio server core for Bun 1.4.4 or later, extracted from the four copies of `src/mcp.ts` in agent-mem, vault-mem, agent-research and agent-decide (#1, #2).

### Added

- `serve(options)`: newline-delimited JSON-RPC on stdio with the `new` / `initializing` / `ready` phases, `ping`, `initialize` negotiation over `2025-06-18`, `2025-03-26` and `2024-11-05`, `tools/list` and `tools/call`.
  - Limits for frame bytes, result bytes, default string length and an optional per-tool frame bound (defaults 64 KiB, 256 KiB and 64 KiB; no per-tool default).
  - `failureText` maps a handler throw or `ResultTooLarge` to a content-free text; otherwise failures are opaque. The core never puts `Error.message` into a response on its own.
  - `onEmitted` runs only after the write callback confirms the response.
  - An unexpected exception while handling one request answers `-32603` and the session continues; a failed confirmed write still ends the session.
- `validArguments` and `argumentError`: one bounded validator with the union vocabulary of the four copies plus `uniqueItems` and `exclusiveMinimum`. Nesting is bounded to 64 levels, NUL and the keys `__proto__`, `prototype` and `constructor` are refused, and errors name a path and a limit, never a value.
- `writeConfirmed`, `PROTOCOL_VERSIONS`, `ERROR` and `ResultTooLarge`.
- Conformance transcripts in `fixtures/v1/*.jsonl` and `runTranscripts` / `runConformance`, so consumers run the shared cases with their own options. The generated cases are part of the versioned contract.

### Behaviour changes for consumers

- The core is strict, with no option to relax it: `initialize` requires `protocolVersion`, `capabilities` and `clientInfo`, every `tools/call` validates its arguments, and an unknown tool gets `-32602 Invalid tool name or arguments`.
- Each case where a copy behaves differently today is listed in `fixtures/v1/DIVERGENCES.md`. The README migration recipe covers the agent-decide limits.

### Release note

- 0.1.0 was published to npm from a local checkout, so it carries no provenance attestation. The tag-triggered workflow run stopped at publish because the version already existed; the registry tarball shasum `5668cc66acbd5eda3ebd55a376c7a223f40d472c` matches the one it built from the tag. Later versions publish through the workflow with npm trusted publishing.

[Unreleased]: https://github.com/STAIxBWLB/mcp-stdio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/STAIxBWLB/mcp-stdio/releases/tag/v0.1.0
