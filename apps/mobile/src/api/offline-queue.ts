/**
 * Pravshi OS  Mobile Offline Mutation Queue.
 *
 * Implements an optimistic mutation queue for mobile devices:
 * 1. Enqueues offline changes (e.g. creating a lead, updating task status).
 * 2. Assigns local optimistic IDs for immediate UI responsiveness.
 * 3. Persists queue state into tenant-isolated metadata storage.
 * 4. Automatically replays mutations in order once connectivity returns.
 * 5. Handles conflicts and moves unrecoverable items to a dead-letter queue.
 */

import { z } from 'zod';
import type { ITenantIsolatedCache } from '@pravshi/mobile-platform';
import type { MobileApiClient } from './client';

export const QueuedMutationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  endpoint: z.string().min(1),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  body: z.unknown().optional(),
  idempotencyKey: z.string(),
  optimisticId: z.string().optional(),
  entityType: z.string(),
  createdAt: z.number().int().positive(),
  retryCount: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
});

export type QueuedMutation = z.infer<typeof QueuedMutationSchema>;

export interface SyncProgress {
  total: number;
  completed: number;
  failed: number;
  isSyncing: boolean;
}

export type SyncListener = (progress: SyncProgress) => void;

export class OfflineMutationQueue {
  private readonly storageKey = 'mutation_queue';
  private readonly deadLetterKey = 'dead_letter_queue';
  private syncInProgress = false;
  private listeners: Set<SyncListener> = new Set();

  constructor(
    private readonly cache: ITenantIsolatedCache,
    private readonly apiClient: MobileApiClient,
    private readonly maxRetries: number = 5,
  ) {}

  /**
   * Enqueues an optimistic mutation while offline or preparing offline work.
   */
  async enqueue(
    tenantId: string,
    mutation: Omit<
      QueuedMutation,
      'id' | 'tenantId' | 'createdAt' | 'retryCount' | 'idempotencyKey'
    >,
  ): Promise<QueuedMutation> {
    const queue = await this.getQueue(tenantId);

    const queuedItem: QueuedMutation = {
      ...mutation,
      id: crypto.randomUUID(),
      tenantId,
      idempotencyKey: crypto.randomUUID(),
      createdAt: Date.now(),
      retryCount: 0,
    };

    queue.push(queuedItem);
    await this.cache.set(tenantId, this.storageKey, queue);
    this.notifyProgress(queue.length, 0, 0);

    return queuedItem;
  }

  /**
   * Gets pending mutation queue for a tenant.
   */
  async getQueue(tenantId: string): Promise<QueuedMutation[]> {
    const items = await this.cache.get<QueuedMutation[]>(tenantId, this.storageKey);
    return items ?? [];
  }

  /**
   * Returns count of pending mutations for the tenant.
   */
  async getPendingCount(tenantId: string): Promise<number> {
    const queue = await this.getQueue(tenantId);
    return queue.length;
  }

  /**
   * Replays all queued mutations sequentially against the server.
   */
  async processQueue(tenantId: string): Promise<{
    succeeded: number;
    failed: number;
    remaining: number;
  }> {
    if (this.syncInProgress) {
      return { succeeded: 0, failed: 0, remaining: await this.getPendingCount(tenantId) };
    }

    this.syncInProgress = true;
    const queue = await this.getQueue(tenantId);
    const initialTotal = queue.length;

    let succeeded = 0;
    let failed = 0;
    const remainingQueue: QueuedMutation[] = [];
    const deadLetterItems: QueuedMutation[] = [];

    this.notifyProgress(initialTotal, 0, 0);

    for (const item of queue) {
      try {
        await this.apiClient.request(item.endpoint, {
          method: item.method,
          body: item.body,
          idempotencyKey: item.idempotencyKey,
        });

        succeeded++;
        this.notifyProgress(initialTotal, succeeded, failed);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        item.retryCount++;
        item.lastError = errorMsg;

        if (item.retryCount >= this.maxRetries) {
          // Move permanently failing items to dead-letter queue
          deadLetterItems.push(item);
          failed++;
        } else {
          remainingQueue.push(item);
        }

        this.notifyProgress(initialTotal, succeeded, failed);
      }
    }

    // Persist remaining items and dead letter queue
    await this.cache.set(tenantId, this.storageKey, remainingQueue);

    if (deadLetterItems.length > 0) {
      const existingDeadLetter =
        (await this.cache.get<QueuedMutation[]>(tenantId, this.deadLetterKey)) ?? [];
      await this.cache.set(tenantId, this.deadLetterKey, [
        ...existingDeadLetter,
        ...deadLetterItems,
      ]);
    }

    this.syncInProgress = false;
    this.notifyProgress(remainingQueue.length, succeeded, failed);

    return {
      succeeded,
      failed,
      remaining: remainingQueue.length,
    };
  }

  /**
   * Clears the entire queue for a tenant.
   */
  async clearQueue(tenantId: string): Promise<void> {
    await this.cache.remove(tenantId, this.storageKey);
    this.notifyProgress(0, 0, 0);
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyProgress(total: number, completed: number, failed: number): void {
    for (const listener of this.listeners) {
      listener({
        total,
        completed,
        failed,
        isSyncing: this.syncInProgress,
      });
    }
  }
}
