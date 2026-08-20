import { parentPort, workerData } from 'node:worker_threads';
import { keySolidBackground } from './sourceKeyingKernel.js';

const frame = {
  data: new Uint8Array(workerData.data),
  width: workerData.width,
  height: workerData.height,
};

Promise.resolve()
  .then(() => keySolidBackground(frame))
  .then((result) => {
    const transferList = result?.data?.buffer ? [result.data.buffer] : [];
    parentPort.postMessage({ type: 'complete', result }, transferList);
  })
  .catch((error) => parentPort.postMessage({
    type: 'error',
    error: error.message || String(error),
  }));
