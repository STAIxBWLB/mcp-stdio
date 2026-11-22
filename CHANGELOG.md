# Changelog

All notable changes to `@staix/mcp-stdio` are recorded here. The format follows Keep a Changelog. During 0.x, a breaking API change or a changed transcript is a minor release and anything else a patch; from 1.0.0, those changes are a major release.

## Unreleased

## [0.1.0] - 2026-11-22

First release: a zero-runtime-dependency MCP stdio server core for Bun 1.4.4 or later, extracted from the four copies of `src/mcp.ts` in agent-mem, vault-mem, agent-research and agent-decide (#1, #2).

### Added

- `serve(options)`: newline-delimited JSON-RPC on stdio with the `new` / `initializing` / `ready` phases, `ping`, `initialize` negotiation over `2025-06-18`, `2025-03-26` and `2024-11-05`, `tools/list` and `tools/call`.
  - Limits for frame bytes, result bytes, default string length and per-tool frame bytes (defaults 64 KiB, 256 KiB, 64 KiB).
  - `failureText` maps a handler throw or `ResultTooLarge` to a content-free text; otherwise failures are opaque. `Error.message` never reaches a response.
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

[0.1.0]: https://github.com/STAIxBWLB/mcp-stdio/releases/tag/v0.1.0
