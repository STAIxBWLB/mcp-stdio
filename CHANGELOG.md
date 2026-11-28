# Changelog

All notable changes to `@staix/mcp-stdio` are recorded here. The format follows Keep a Changelog. During 0.x, a breaking API change or a changed transcript is a minor release and anything else a patch. 1.0.0 follows the four consumer migrations; from then on, those changes are a major release.

## [Unreleased]

## [0.4.0] - 2026-11-29

### Changed

- Stateless requests select the era only after their metadata passes validation. Three new transcripts cover successful initialization after rejected requests.

### Fixed

- A stateless request with malformed metadata or an unsupported version no longer blocks later initialization. On an undecided process, an `initialize` carrying stateless metadata explains how to retry in either era (#20).
- Documented that `limits.toolFrameBytes` has no default and that the global frame limit applies when it returns no value (#19).

## [0.3.0] - 2026-11-28

### Changed

- The initialize-era `tools/list` metadata transcripts now expect a tool list for agent-mem, vault-mem, agent-research and agent-decide. Core transcripts cover integer and string progress tokens and rejection of non-object metadata.

### Fixed

- Initialize-era `tools/list` accepts plain-object `params._meta`, including the progress token sent by Codex (#13).

## [0.2.0] - 2026-11-26

### Added

- Stateless MCP `2026-07-28` over stdio. `server/discover` returns supported revisions and capabilities. Stateless requests supply version and client capabilities in `params._meta`, and results include `resultType: "complete"` and server identity. Discovery and pre-initialize `ping` leave the era undecided. Once selected, the era is fixed for the process. `ping` is available in the initialize era.
- `listCache` for stateless `tools/list`. Tool listings and discovery default to private caching with a zero TTL.
- Optional tool titles, icons, output schemas and annotation titles.
- `structuredContent` for tools with `outputSchema` under `2025-06-18`, `2025-11-25` and `2026-07-28`. The result carries the validated JSON alongside the existing text block. Output mismatches use the existing handler-failure response and `failureText` mapper.
- The exported `schemaError` checker. `additionalProperties: true` accepts extra fields under the same input safety rules as `additionalProperties: {}`.

### Changed

- `serve` rejects unsupported, malformed or ambiguous input and output schemas before reading input. Bare objects such as agent-decide's `question` and `request` (agent-decide#18) and the agent-research arguments tracked in agent-research#198 need explicit properties or an `additionalProperties` policy.
- `initialize` now prefers `2025-11-25` when the requested revision is unsupported. The exported `PROTOCOL_VERSIONS` starts with `2026-07-28`, the stateless revision.
- Sessions using `2025-11-25` or `2026-07-28` return schema validation failures as tool results with `isError: true` and a text diagnostic (SEP-1303). Earlier negotiated revisions keep JSON-RPC `-32602` for these failures. Unknown tools and malformed call parameters remain JSON-RPC errors.
- Stateless requests with missing required metadata receive `-32602` naming the field. Requests that supply an unsupported revision receive `-32022` with the supported revisions.
- Argument validation rejects NUL characters in property names, including names inside objects accepted by an empty schema.
- Consumer conformance includes the versioned transcripts. Prior recorded cases retain their responses. The harness expresses recorded bare object schemas as explicitly closed, so the generated `tools/list` case reflects that fixture policy. `tools/list` still returns the supplied tool table.

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

[Unreleased]: https://github.com/STAIxBWLB/mcp-stdio/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/STAIxBWLB/mcp-stdio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/STAIxBWLB/mcp-stdio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/STAIxBWLB/mcp-stdio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/STAIxBWLB/mcp-stdio/releases/tag/v0.1.0
