// ========================================
// Semlink - Semantic Map Archive Store
// ========================================
// Persists the progressive "semantic map" (nodes + links + layout) to a
// standalone JSON file under the plugin's data directory, mirroring
// ChatHistoryStore's synchronous-fs pattern. Single archive: saved on every
// change and restored on the next visit, so exploration continues seamlessly.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** A node in the persisted map: just enough to rebuild the graph + layout. */
export interface MapArchiveNode {
	path: string;
	name: string;
	x: number;
	y: number;
	expanded: boolean;
	isCenter: boolean;
}

export interface MapArchiveLink {
	source: string;
	target: string;
}

export interface MapArchive {
	centerPath: string | null;
	nodes: MapArchiveNode[];
	links: MapArchiveLink[];
}

export class MapArchiveStore {
	private filePath: string;
	private archive: MapArchive | null = null;
	private loaded = false;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "map-archive.json");
	}

	/** Load the archive from disk (once; subsequent calls return the cache). */
	load(): MapArchive | null {
		if (this.loaded) return this.archive;
		try {
			if (existsSync(this.filePath)) {
				const raw = readFileSync(this.filePath, "utf-8");
				const parsed = JSON.parse(raw);
				this.archive = parsed && Array.isArray(parsed.nodes) ? (parsed as MapArchive) : null;
			}
		} catch {
			this.archive = null;
		}
		this.loaded = true;
		return this.archive;
	}

	/** Persist the archive to disk (synchronous; best-effort, never throws). */
	save(archive: MapArchive): void {
		this.archive = archive;
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(archive, null, 2), "utf-8");
		} catch (e) {
			console.error("[Semlink] Failed to save map archive:", e);
		}
	}

	/** Clear the persisted archive to an empty map. */
	clear(): void {
		this.save({ centerPath: null, nodes: [], links: [] });
	}
}
