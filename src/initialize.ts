const INITIALIZE_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const STATELESS_VERSION = "2026-07-28";
export const PROTOCOL_VERSIONS = [STATELESS_VERSION, ...INITIALIZE_VERSIONS] as const;

type InitializeVersion = typeof INITIALIZE_VERSIONS[number];

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The strict initialize request contract used by the agent-mem server. */
export function initialize(params: unknown, name: string, version: string, instructions?: string): (Record<string, unknown> & { protocolVersion: InitializeVersion }) | undefined {
  if (!plain(params) || typeof params.protocolVersion !== "string" || !plain(params.capabilities) || !plain(params.clientInfo)) return undefined;
  const requested = params.protocolVersion as InitializeVersion;
  return {
    protocolVersion: INITIALIZE_VERSIONS.includes(requested) ? requested : INITIALIZE_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name, version },
    ...(instructions === undefined ? {} : { instructions }),
  };
}
