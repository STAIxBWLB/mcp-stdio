import type { Writable } from "node:stream";

/** Shared callback-confirmed emission; close/error are failures and never delivery evidence. */
export const writeConfirmed = (output: Writable, text: string): Promise<void> => new Promise((resolve, reject) => {
    let settled = false, writing = true, callbackDone = false, callbackFailure: Error | null | undefined;
    const finish = (failure?: Error | null) => {
      if (settled) return; settled = true; output.removeListener("close", closed);
      // A Writable callback failure precedes its error event; keep that one-shot listener until the event arrives.
      if (!failure) output.removeListener("error", failed);
      if (failure) reject(failure); else resolve();
    };
    const failed = (failure: Error) => { finish(failure); output.removeListener("error", failed); };
    const closed = () => { finish(Error("output closed before emission")); output.removeListener("error", failed); };
    output.once("error", failed); output.once("close", closed);
    try {
      output.write(text, failure => { callbackDone = true; callbackFailure = failure; if (!writing) finish(failure); });
      writing = false; if (callbackDone) finish(callbackFailure);
    } catch (failure) { writing = false; finish(failure as Error); output.removeListener("error", failed); }
  });
