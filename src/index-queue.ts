// ========================================
// Semlink - Index Queue (Persistent)
// ========================================

import type { QueueItem, QueueAction, QueueItemStatus } from "./types";

/**
 * Queue management backed by SQLite in VectorStore.
 * This class operates on the same Database handle.
 */
export class IndexQueue {
	private db: any; // sql.js Database

	constructor(db: any) {
		this.db = db;
	}

	/** Enqueue a single item */
	enqueue(notePath: string, action: QueueAction, priority = 2): void {
		// Avoid duplicates for the same path+action that are still pending
		const existing = this.db.exec(
			"SELECT id FROM queue WHERE note_path = ? AND action = ? AND status = 'pending'",
			[notePath, action]
		);
		if (existing.length > 0 && existing[0].values.length > 0) return;

		this.db.run(
			"INSERT INTO queue (note_path, action, priority, status, retries, error, created_at) VALUES (?, ?, ?, 'pending', 0, NULL, ?)",
			[notePath, action, priority, Date.now()]
		);
	}

	/** Enqueue multiple items */
	enqueueMany(items: Array<{ notePath: string; action: QueueAction; priority?: number }>): void {
		for (const item of items) {
			this.enqueue(item.notePath, item.action, item.priority ?? 2);
		}
	}

	/** Dequeue the next batch of pending items */
	dequeue(limit = 64): QueueItem[] {
		const results = this.db.exec(
			"SELECT id, note_path, action, priority, status, retries, error, created_at FROM queue WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT ?",
			[limit]
		);

		if (results.length === 0) return [];

		const items = this.mapItems(results);

		// Mark as processing
		for (const item of items) {
			if (item.id != null) {
				this.db.run("UPDATE queue SET status = 'processing' WHERE id = ?", [item.id]);
			}
		}

		return items;
	}

	/** Mark an item as completed */
	complete(id: number): void {
		this.db.run("UPDATE queue SET status = 'completed' WHERE id = ?", [id]);
	}

	/** Mark an item as failed and increment retries */
	fail(id: number, error: string): void {
		this.db.run(
			"UPDATE queue SET status = 'failed', error = ?, retries = retries + 1 WHERE id = ?",
			[error, id]
		);
	}

	/** Re-queue failed items for retry */
	retryFailed(): number {
		const result = this.db.run(
			"UPDATE queue SET status = 'pending', error = NULL WHERE status = 'failed' AND retries < 5"
		);
		return result.changes;
	}

	/** Count pending items */
	get pendingCount(): number {
		const results = this.db.exec("SELECT COUNT(*) FROM queue WHERE status = 'pending'");
		if (results.length > 0 && results[0].values.length > 0) {
			return results[0].values[0][0] as number;
		}
		return 0;
	}

	/** Count items by status */
	getCounts(): { pending: number; processing: number; failed: number; completed: number } {
		const counts = { pending: 0, processing: 0, failed: 0, completed: 0 };
		const results = this.db.exec("SELECT status, COUNT(*) FROM queue GROUP BY status");
		if (results.length > 0) {
			for (const row of results[0].values) {
				const status = row[0] as string;
				const count = row[1] as number;
				if (status in counts) (counts as any)[status] = count;
			}
		}
		return counts;
	}

	/** Clean up completed items older than cutoff */
	cleanup(cutoffMs: number): void {
		this.db.run(
			"DELETE FROM queue WHERE status = 'completed' AND created_at < ?",
			[Date.now() - cutoffMs]
		);
	}

	/** Clear all queue items */
	clear(): void {
		this.db.run("DELETE FROM queue");
	}

	/** Get all pending paths */
	getPendingPaths(): string[] {
		const results = this.db.exec(
			"SELECT note_path FROM queue WHERE status IN ('pending', 'processing', 'failed') ORDER BY priority ASC, created_at ASC"
		);
		if (results.length === 0) return [];
		return results[0].values.map((r: any[]) => r[0] as string);
	}

	private mapItems(results: any[]): QueueItem[] {
		if (results.length === 0) return [];
		const cols = results[0].columns;
		return results[0].values.map((row: any[]) => {
			const obj: Record<string, any> = {};
			cols.forEach((c: string, i: number) => (obj[c] = row[i]));
			return {
				id: obj.id,
				notePath: obj.note_path,
				action: obj.action as QueueAction,
				priority: obj.priority || 2,
				status: obj.status as QueueItemStatus,
				retries: obj.retries || 0,
				error: obj.error,
				createdAt: obj.created_at,
			} as QueueItem;
		});
	}
}
