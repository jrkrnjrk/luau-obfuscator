import { parentPort, workerData } from 'node:worker_threads';
import { InputError, obfuscate } from './obfuscator.js';

try {
  const result = await obfuscate(workerData.source, workerData.options);
  parentPort.postMessage({ type: 'veil:result', ok: true, result });
} catch (error) {
  parentPort.postMessage({
    type: 'veil:result',
    ok: false,
    error: error instanceof Error ? error.message : 'Unknown transformation error.',
    status: error instanceof InputError ? 400 : 500,
  });
}
