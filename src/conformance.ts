import { Readable, Writable } from "node:stream";
import { serve, type ServeOptions } from "./server.ts";

/** A recorded request stream and its exact response stream. */
export interface TranscriptCase { id: string; input: string | number[]; output: string; packageOutput?: string }
export interface TranscriptResult { id: string; expected: string; actual: string; passed: boolean }
/** Replay transcript cases against a consumer's actual tool table and options. */
export async function runTranscripts(cases: readonly TranscriptCase[], options: Omit<ServeOptions, "input" | "output" | "close">): Promise<TranscriptResult[]> {
  const results: TranscriptResult[] = [];
  for (const item of cases) {
    let actual = "";
    const output = new Writable({ write(chunk, _encoding, callback) { actual += chunk.toString(); callback(); } });
    await serve({ ...options, input: Readable.from([typeof item.input === "string" ? Buffer.from(item.input) : Buffer.from(item.input)]), output });
    const expected = item.packageOutput ?? item.output;
    results.push({ id: item.id, expected, actual, passed: actual === expected });
  }
  return results;
}
