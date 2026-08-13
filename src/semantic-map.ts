// ========================================
// Semlink - Semantic Map Controller
// ========================================
// Wraps force-graph: renders a force-directed map of notes semantically
// related to the active note. Supports incremental expansion — clicking a
// node opens that note AND adds its neighbours, while existing nodes/links
// stay (a progressive map grows with exploration). The controller only does
// rendering + layout; retrieval (embed + search) is done by the view, which
// feeds nodes/links in via addNode/addLink.
//
// Persistence note: node objects are passed to force-graph BY REFERENCE, so
// it can mutate x/y on them and positions survive re-renders. Links are
// passed as COPIES, because force-graph rewrites link.source/target into
// object references and we must keep our store holding plain path strings.

import ForceGraph from "force-graph";
import type { MapArchive, MapArchiveLink, MapArchiveNode } from "./map-archive-store";

export interface MapNode {
	id: string; // === notePath
	path: string;
	name: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	expanded: boolean;
	isCenter: boolean;
}

interface MapLink {
	source: string;
	target: string;
}

export class SemanticMapController {
	private container: HTMLElement;
	private onNodeClick: (path: string) => void;
	// force-graph mutates node objects; typed loosely to avoid generic friction.
	private graph: any = null;
	private nodes = new Map<string, MapNode>();
	private links = new Map<string, MapLink>(); // key: sorted "src|tgt"
	private centerPath: string | null = null;
	private accent = "#7c3aed";
	private textColor = "#ddd";
	private fontFamily = "sans-serif";

	constructor(container: HTMLElement, onNodeClick: (path: string) => void) {
		this.container = container;
		this.onNodeClick = onNodeClick;
	}

	/** Create the force-graph instance inside the container. Idempotent. */
	init(): void {
		if (this.graph) return;
		const cs = getComputedStyle(this.container);
		this.accent = cs.getPropertyValue("--interactive-accent").trim() || this.accent;
		this.textColor = cs.getPropertyValue("--text-normal").trim() || this.textColor;
		this.fontFamily = cs.fontFamily || this.fontFamily;
		const muted = cs.getPropertyValue("--text-muted").trim() || "rgba(120,120,140,1)";
		const linkCol = cs.getPropertyValue("--background-modifier-border").trim() || "rgba(120,120,140,0.4)";

		const g = new ForceGraph(this.container) as any;
		g.nodeRelSize(5)
			.nodeLabel((n: any) => n.name || n.id)
			.nodeColor((n: any) => (n.isCenter ? this.accent : muted))
			.linkColor(() => linkCol)
			.linkWidth(1)
			.linkDirectionalArrowLength(3)
			.linkHoverPrecision(8)
			.d3VelocityDecay(0.3)
			// Draw the note name above each node, but ONLY as an overlay AFTER
			// the default node circle — this keeps force-graph's built-in hit
			// detection (clicks still work) while making nodes readable.
			.nodeCanvasObjectMode(() => "after")
			.nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
				if (globalScale < 1.3) return;
				const label = node.name || node.id;
				if (!label) return;
				const fs = 11 / globalScale;
				ctx.font = `${fs}px ${this.fontFamily}`;
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillStyle = this.textColor;
				ctx.fillText(label, node.x, (node.y ?? 0) + 6 / globalScale);
			})
			.onNodeClick((n: any) => {
				if (n && n.path) this.onNodeClick(n.path);
			});
		this.graph = g;
		this.resize();
		this.render();
	}

	/** Match the canvas size to its container (call on resize). */
	resize(): void {
		if (!this.graph) return;
		this.graph.width(this.container.clientWidth);
		this.graph.height(this.container.clientHeight);
	}

	/** Rebuild nodes/links from an archive (restores layout incl. x/y). */
	loadArchive(archive: MapArchive): void {
		this.nodes.clear();
		this.links.clear();
		this.centerPath = archive.centerPath;
		for (const n of archive.nodes) {
			this.nodes.set(n.path, {
				id: n.path,
				path: n.path,
				name: n.name,
				x: n.x,
				y: n.y,
				expanded: n.expanded,
				isCenter: n.isCenter,
			});
		}
		for (const l of archive.links) {
			this.links.set(this.linkKey(l.source, l.target), { source: l.source, target: l.target });
		}
		this.render();
	}

	/** Add a node if absent. Returns true if newly created. */
	addNode(path: string, name: string, opts?: { isCenter?: boolean; x?: number; y?: number; expanded?: boolean }): boolean {
		const existing = this.nodes.get(path);
		if (existing) {
			if (opts?.isCenter) existing.isCenter = true;
			return false;
		}
		this.nodes.set(path, {
			id: path,
			path,
			name,
			isCenter: !!opts?.isCenter,
			x: opts?.x,
			y: opts?.y,
			expanded: !!opts?.expanded,
		});
		return true;
	}

	/** Add an undirected link if absent. Returns true if newly created. */
	addLink(source: string, target: string): boolean {
		const key = this.linkKey(source, target);
		if (this.links.has(key)) return false;
		this.links.set(key, { source, target });
		return true;
	}

	markExpanded(path: string): void {
		const n = this.nodes.get(path);
		if (n) n.expanded = true;
	}

	isExpanded(path: string): boolean {
		return this.nodes.get(path)?.expanded ?? false;
	}

	hasNode(path: string): boolean {
		return this.nodes.has(path);
	}

	setCenter(path: string): void {
		this.centerPath = path;
		const n = this.nodes.get(path);
		if (n) n.isCenter = true;
	}

	/** Push current nodes/links into force-graph (re-runs the simulation). */
	render(): void {
		if (!this.graph) return;
		// SAME node refs → positions preserved; link COPIES → store not polluted.
		const nodes = Array.from(this.nodes.values());
		const links = Array.from(this.links.values()).map((l) => ({ source: l.source, target: l.target }));
		this.graph.graphData({ nodes, links });
	}

	/** Re-fit the viewport to all nodes. */
	zoomToFit(): void {
		if (this.graph) this.graph.zoomToFit(400, 40);
	}

	/** Kick the simulation again (e.g. right after adding nodes). */
	reheat(): void {
		if (this.graph) this.graph.d3ReheatSimulation();
	}

	/** Snapshot the current map + layout for persistence. */
	exportArchive(): MapArchive {
		const outNodes: MapArchiveNode[] = Array.from(this.nodes.values()).map((n) => ({
			path: n.path,
			name: n.name,
			x: typeof n.x === "number" ? n.x : 0,
			y: typeof n.y === "number" ? n.y : 0,
			expanded: !!n.expanded,
			isCenter: !!n.isCenter,
		}));
		const outLinks: MapArchiveLink[] = Array.from(this.links.values()).map((l) => ({
			source: l.source,
			target: l.target,
		}));
		return { centerPath: this.centerPath, nodes: outNodes, links: outLinks };
	}

	/** Empty the map (does not touch the persisted file — caller saves). */
	clear(): void {
		this.nodes.clear();
		this.links.clear();
		this.centerPath = null;
		if (this.graph) this.graph.graphData({ nodes: [], links: [] });
	}

	private linkKey(a: string, b: string): string {
		return a < b ? `${a}|${b}` : `${b}|${a}`;
	}

	/** Tear down force-graph and free the container. */
	dispose(): void {
		if (this.graph) {
			try {
				this.graph.pauseAnimation();
				this.graph._destructor();
			} catch {
				// best-effort teardown
			}
			this.graph = null;
		}
		this.nodes.clear();
		this.links.clear();
		this.container.innerHTML = "";
	}
}
