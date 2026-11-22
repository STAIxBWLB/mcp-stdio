import type { Readable } from "node:stream";

/** Consume bounded newline frames. Incomplete frames are never passed to the handler. */
export async function readFrames(
  input: Readable,
  frameBytes: number,
  handle: (line: string) => Promise<void>,
  error: (message: "overflow" | "utf8" | "incomplete") => Promise<void>,
): Promise<void> {
  let pending = "", overflow = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const consume = async (chunk: string) => {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start), part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (!overflow) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > frameBytes) { overflow = true; pending = ""; }
        else pending += part;
      }
      if (newline < 0) return;
      if (overflow) await error("overflow");
      else if (pending.trim()) await handle(pending);
      pending = ""; overflow = false; start = newline + 1;
    }
  };
  for await (const chunk of input) {
    let decoded: string;
    try { decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }); }
    catch { await error("utf8"); return; }
    await consume(decoded);
  }
  let tail: string;
  try { tail = decoder.decode(); } catch { await error("utf8"); return; }
  await consume(tail);
  if (pending.trim() || overflow) await error("incomplete");
}
