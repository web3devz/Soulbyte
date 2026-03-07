import crypto from 'crypto';
import { StateUpdate } from '../engine/engine.types.js';
import { debugLog } from '../utils/debug-log.js';

export type OnchainJobType =
  | 'AGENT_TRANSFER_SBYTE'
  | 'AGENT_TRANSFER_MON'
  | 'BUSINESS_TRANSFER_SBYTE'
  | 'BUSINESS_TRANSFER_MON'
  | 'RAW_SBYTE_TRANSFER';

export interface OnchainJobPayload {
  [key: string]: unknown;
}

export function createOnchainJobUpdate(params: {
  jobType: OnchainJobType;
  payload: OnchainJobPayload;
  actorId?: string | null;
  relatedIntentId?: string | null;
  relatedTxId?: string | null;
}): { jobId: string; update: StateUpdate } {
  const jobId = crypto.randomUUID();
  const update: StateUpdate = {
    table: 'onchainJob',
    operation: 'create',
    data: {
      id: jobId,
      jobType: params.jobType,
      status: 'queued',
      payload: params.payload,
      actorId: params.actorId ?? null,
      relatedIntentId: params.relatedIntentId ?? null,
      relatedTxId: params.relatedTxId ?? null,
      retryCount: 0,
      nextAttemptAt: new Date(),
    },
  };

  debugLog('onchain_queue.enqueue', {
    jobId,
    jobType: params.jobType,
    actorId: params.actorId ?? null,
    relatedIntentId: params.relatedIntentId ?? null,
    relatedTxId: params.relatedTxId ?? null,
  });

  return { jobId, update };
}
