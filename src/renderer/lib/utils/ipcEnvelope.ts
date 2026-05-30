/**
 * Re-export of the shared envelope helper. The real implementation lives
 * in `src/shared/ipcEnvelope.ts` so preload + renderer can both use it
 * (Phase 1, CONSOLIDATION_PLAN_2026-05-25.md). Existing renderer
 * imports continue to work unchanged via this barrel.
 */
export { IpcEnvelopeError, assertIpcOk } from '@shared/ipcEnvelope';
