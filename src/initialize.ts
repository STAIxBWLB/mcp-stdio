export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type ProtocolVersion = typeof PROTOCOL_VERSIONS[number];

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The strict initialize request contract used by the agent-mem server. */
export function initialize(params: unknown, name: string, version: string, instructions?: string): (Record<string, unknown> & { protocolVersion: ProtocolVersion }) | undefined {
  if (!plain(params) || typeof params.protocolVersion !== "string" || !plain(params.capabilities) || !plain(params.clientInfo)) return undefined;
  const requested = params.protocolVersion as ProtocolVersion;
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name, version },
    ...(instructions === undefined ? {} : { instructions }),
  };
}
