/**
 * Worker thread for a single plugin invocation (issue #580).
 *
 * This file is the worker entry point: the host (`host.ts`) spawns it once
 * per invocation with the plugin bytes and the input JSON in `workerData`,
 * and the worker posts exactly one message back — the transformed JSON, a
 * drop, or an error string. It never touches the network, the filesystem,
 * or any host state; the WASM module it instantiates has no imports, so
 * the only code that runs is the plugin's own `transform`.
 *
 * A runaway plugin (infinite loop, unbounded memory growth) cannot be
 * stopped from inside this thread — that is the host's job, which
 * terminates the whole worker on timeout. This file therefore does no
 * budgeting of its own beyond the static checks the host already applied.
 */
import { parentPort, workerData } from "node:worker_threads";
import { INPUT_OFFSET, MAX_OUTPUT_BYTES, OUTPUT_OFFSET } from "./abi.js";

export interface PluginWorkerData {
  bytes: Uint8Array;
  input: string;
  maxMemoryPages: number;
}

export type PluginWorkerResult =
  | { dropped: true }
  | { output: string }
  | { error: string };

const { bytes, input, maxMemoryPages } = workerData as PluginWorkerData;

function reply(result: PluginWorkerResult): void {
  parentPort?.postMessage(result);
}

try {
  const module = new WebAssembly.Module(new Uint8Array(bytes) as BufferSource);
  const instance = new WebAssembly.Instance(module, {});
  const memory = instance.exports.memory as WebAssembly.Memory | undefined;
  const transform = instance.exports.transform as ((a: number, b: number) => number) | undefined;
  if (!memory) throw new Error("plugin exports no memory");
  if (typeof transform !== "function") throw new Error("plugin exports no transform function");
  if (memory.buffer.byteLength > maxMemoryPages * 65536) {
    throw new Error("plugin memory exceeds the configured page limit");
  }

  const inputBytes = new TextEncoder().encode(input);
  new Uint8Array(memory.buffer).set(inputBytes, INPUT_OFFSET);
  // Re-read the buffer after the call: the plugin may have grown memory,
  // which detaches the old ArrayBuffer.
  const outputLen = transform(INPUT_OFFSET, inputBytes.length);
  if (outputLen === -1) {
    reply({ dropped: true });
  } else if (!Number.isInteger(outputLen) || outputLen < 0 || outputLen > MAX_OUTPUT_BYTES) {
    reply({ error: `plugin returned invalid output length ${outputLen}` });
  } else {
    const outputBytes = new Uint8Array(memory.buffer, OUTPUT_OFFSET, outputLen);
    reply({ output: new TextDecoder().decode(outputBytes) });
  }
} catch (err) {
  reply({ error: err instanceof Error ? err.message : String(err) });
}
