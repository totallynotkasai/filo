/**
 * Re-export of the shared envelope helper. The real implementation lives
 * in `src/shared/ipcEnvelope.ts` so preload + renderer can both use it;
 * renderer imports go through this barrel.
 */
export { IpcEnvelopeError, assertIpcOk } from '@shared/ipcEnvelope';
