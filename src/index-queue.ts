// ========================================
// Semlink - Index Queue (delegates to VectorStore)
// ========================================
// Queue management backed by the same SQLite DB as the vector store. The queue
// table lives in the worker's DB, so all queue operations now go through the
// VectorStore async proxy (which routes them to the worker thread / fallback
// engine). This keeps queue churn off the main thread too.

import type { VectorStore } from "./vector-store";
import type { QueueItem, QueueAction } from "./types";

export class IndexQueue {
	private store: VectorStore;

	constructor(store: VectorStore) {
		this.store = store;
	}

	/** Enqueue a single item */
	async enqueue(notePath: string, action: QueueAction, priority = 2): Promise<void> {
		await this.store.enqueue(notePath, action, priority);
	}

	/** Enqueue multiple items */
	async enqueueMany(items: Array<{ notePath: string; action: QueueAction; priority?: number }>): Promise<void> {
		await this.store.enqueueMany(items);
	}

	/** Dequeue the next batch of pending items */
	async dequeue(limit = 64): Promise<QueueItem[]> {
		return await this.store.dequeue(limit);
	}

	/** Mark an item as completed */
	async complete(id: number): Promise<void> {
		await this.store.complete(id);
	}

	/** Mark an item as failed and increment retries */
	async fail(id: number, error: string): Promise<void> {
		await this.store.fail(id, error);
	}

	/** Re-queue failed items for retry */
	async retryFailed(): Promise<number> {
		return await this.store.retryFailed();
	}

	/** Count pending items */
	async getPendingCount(): Promise<number> {
		return await this.store.getPendingCount();
	}

	/** Count items by status */
	async getCounts(): Promise<{ pending: number; processing: number; failed: number; completed: number }> {
		return await this.store.getCounts();
	}

	/** Clean up completed items older than cutoff */
	async cleanup(cutoffMs: number): Promise<void> {
		await this.store.cleanup(cutoffMs);
	}

	/** Clear all queue items */
	async clear(): Promise<void> {
		await this.store.clearQueue();
	}

	/** Get all pending paths */
	async getPendingPaths(): Promise<string[]> {
		return await this.store.getPendingPaths();
	}
}
