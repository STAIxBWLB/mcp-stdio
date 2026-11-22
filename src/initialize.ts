export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The strict initialize request contract used by the agent-mem server. */
export function initialize(params: unknown, name: string, version: string, instructions?: string): Record<string, unknown> | undefined {
  if (!plain(params) || typeof params.protocolVersion !== "string" || !plain(params.capabilities) || !plain(params.clientInfo)) return undefined;
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion as typeof PROTOCOL_VERSIONS[number]) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name, version },
    ...(instructions === undefined ? {} : { instructions }),
  };
}
