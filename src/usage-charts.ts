// ========================================
// Semlink - SVG chart helpers for the usage dashboard
// ========================================
// Hand-rolled, dependency-free charts matching the DeepSeek-style usage
// design: rounded-top stacked bars and smooth monotone area curves on a
// shared frame (3 horizontal gridlines + sparse date labels). Elements are
// built via createElementNS into the host's own document so popout windows
// render correctly; classes are styled centrally in styles.css.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(doc: Document, tag: string, attrs: Record<string, string | number> = {}): SVGElement {
	const el = doc.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}

/** Round `maxV` up to a clean axis top whose half is also clean: small
 *  integer ranges get even tops (3 → 4, gridlines 0/2/4), larger values
 *  get 1/2/3/4/5/6/8 × 10^k (765M → 800M, gridlines 0/400M/800M). */
export function niceScale(maxV: number): { top: number } {
	if (maxV <= 0) return { top: 1 };
	if (maxV <= 8) {
		let top = Math.max(2, Math.ceil(maxV));
		if (top % 2) top++;
		return { top };
	}
	const exp = Math.floor(Math.log10(maxV));
	const base = Math.pow(10, exp);
	const f = maxV / base;
	const step = [1, 2, 3, 4, 5, 6, 8, 10].find((s) => f <= s) ?? 10;
	return { top: step * base };
}

/** Compact y-axis numbers: full grouping below 10k ("1,400"), then
 *  500M / 250M / 100K style — matching the reference design. */
export function fmtCompact(n: number): string {
	if (n === 0) return "0";
	if (n < 10000) return n.toLocaleString("en-US");
	const trim = (v: number): string => (v % 1 === 0 ? String(v) : v.toFixed(1));
	if (n >= 1e9) return trim(n / 1e9) + "B";
	if (n >= 1e6) return trim(n / 1e6) + "M";
	return trim(n / 1e3) + "k";
}

/** Cycle palette for per-model series. */
export const USAGE_MODEL_COLORS = ["#3B82F6", "#7C3AED", "#06B6D4", "#F59E0B", "#10B981", "#EC4899", "#8B5CF6", "#EF4444"];

/** Input/output pair (dark blue base, light blue top — per the design). */
export const USAGE_IN_COLOR = "#2563EB";
export const USAGE_OUT_COLOR = "#7CB3F5";

export interface StackSeg {
	name: string;
	value: number;
	color: string;
}

export interface StackBar {
	label: string;
	/** Ordered bottom → top. */
	segs: StackSeg[];
}

export interface StackedBarsOpts {
	/** SVG height in px (default 220). */
	height?: number;
	yFormat?: (n: number) => string;
	/** Bar hover callbacks; null = pointer left the plot. */
	onHover?: (bar: StackBar | null, ev: MouseEvent) => void;
}

/** Sparse x-label indices: every label for short spans, ≤5 evenly stepped
 *  ones (always including the newest day) for long spans. */
function xLabelIndices(n: number): number[] {
	if (n <= 6) return Array.from({ length: n }, (_, i) => i);
	const step = Math.ceil(n / 4);
	const idxs: number[] = [];
	for (let i = 0; i < n; i += step) idxs.push(i);
	const last = idxs[idxs.length - 1];
	if (last !== n - 1) {
		if (n - 1 - last >= Math.max(2, step * 0.5)) idxs.push(n - 1);
		else idxs[idxs.length - 1] = n - 1;
	}
	return idxs;
}

interface FrameGeom {
	svg: SVGElement;
	width: number;
	height: number;
	padL: number;
	padT: number;
	plotW: number;
	plotH: number;
	slot: number;
	top: number;
}

/** Shared chart frame: measured-width SVG + 3 gridlines with y labels +
 *  sparse x labels. `padL` leaves room for the y tick text. */
function drawFrame(
	container: HTMLElement,
	labels: string[],
	maxValue: number,
	opts: { height?: number; yFormat?: (n: number) => string },
): FrameGeom {
	const doc = container.ownerDocument;
	const width = Math.max(240, Math.floor(container.clientWidth || 320));
	const height = opts.height ?? 220;
	const fmt = opts.yFormat ?? fmtCompact;
	const padL = 46;
	const padR = 10;
	const padT = 10;
	const padB = 22;
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const count = labels.length;

	const svg = svgEl(doc, "svg", {
		width,
		height,
		viewBox: `0 0 ${width} ${height}`,
		class: "semlink-usage-svg",
	});
	container.appendChild(svg);

	const { top } = niceScale(maxValue);
	for (const tick of [0, top / 2, top]) {
		const y = padT + plotH * (1 - tick / top);
		svg.appendChild(svgEl(doc, "line", {
			x1: padL, x2: width - padR, y1: y, y2: y, class: "semlink-usage-gridline",
		}));
		const label = svgEl(doc, "text", {
			x: padL - 6, y: y + 3, "text-anchor": "end", class: "semlink-usage-axis",
		});
		label.textContent = fmt(tick);
		svg.appendChild(label);
	}
	for (const i of xLabelIndices(count)) {
		const label = svgEl(doc, "text", {
			x: padL + (plotW / count) * i + plotW / count / 2,
			y: height - 6,
			"text-anchor": "middle",
			class: "semlink-usage-axis",
		});
		label.textContent = labels[i] ?? "";
		svg.appendChild(label);
	}
	return { svg, width, height, padL, padT, plotW, plotH, slot: plotW / count, top };
}

/** Rounded-top stacked bar chart (DeepSeek-style). */
export function renderStackedBars(
	container: HTMLElement,
	bars: StackBar[],
	opts: StackedBarsOpts = {},
): void {
	const doc = container.ownerDocument;
	const frame = drawFrame(
		container,
		bars.map((b) => b.label),
		Math.max(0, ...bars.map((b) => b.segs.reduce((n, s) => n + s.value, 0))),
		opts,
	);

	const { padL, padT, plotH, slot, top } = frame;
	const barW = Math.min(Math.max(2, slot * 0.62), 30);
	const r0 = Math.min(4, barW / 2);
	const yBottom = padT + plotH;

	for (let i = 0; i < bars.length; i++) {
		const bar = bars[i];
		const total = bar.segs.reduce((n, s) => n + s.value, 0);
		// Invisible full-height hover zone per slot, even for empty days.
		if (opts.onHover) {
			const zone = svgEl(doc, "rect", {
				x: padL + slot * i, y: padT, width: slot, height: plotH,
				fill: "transparent", class: "semlink-usage-hoverzone",
			});
			zone.addEventListener("mouseenter", (ev) => opts.onHover?.(bar, ev));
			zone.addEventListener("mousemove", (ev) => opts.onHover?.(bar, ev));
			zone.addEventListener("mouseleave", (ev) => opts.onHover?.(null, ev));
			frame.svg.appendChild(zone);
		}
		if (total <= 0) continue;

		const x = padL + slot * i + (slot - barW) / 2;
		// Scale from the floored total so a 2px nub still splits its
		// segments proportionally.
		const hTotal = Math.max(2, plotH * (total / top));
		const lastNonzero = bar.segs.reduce((acc, s, si) => (s.value > 0 ? si : acc), -1);
		let yAcc = yBottom;
		bar.segs.forEach((seg, si) => {
			if (seg.value <= 0) return;
			const h = hTotal * (seg.value / total);
			const y0 = yAcc - h;
			if (si === lastNonzero) {
				// Rounded-top path for the uppermost visible segment.
				const r = Math.min(r0, h);
				frame.svg.appendChild(svgEl(doc, "path", {
					class: "semlink-usage-bar-seg",
					fill: seg.color,
					d: `M${x},${y0 + h} L${x},${y0 + r} Q${x},${y0} ${x + r},${y0}` +
						` L${x + barW - r},${y0} Q${x + barW},${y0} ${x + barW},${y0 + r}` +
						` L${x + barW},${y0 + h} Z`,
				}));
			} else {
				frame.svg.appendChild(svgEl(doc, "rect", {
					class: "semlink-usage-bar-seg", x, y: y0, width: barW, height: h, fill: seg.color,
				}));
			}
			yAcc = y0;
		});
	}
}

export interface AreaOpts {
	/** SVG height in px (default 180). */
	height?: number;
	/** Stroke + fill base color (default Semlink blue). */
	color?: string;
	yFormat?: (n: number) => string;
}

/** Fritsch–Carlson monotone cubic → cubic-bezier path: smooth like the
 *  reference design, guaranteed not to overshoot below 0. */
function monotonePath(pts: Array<{ x: number; y: number }>): string | null {
	const n = pts.length;
	if (n < 2) return null;
	const dx: number[] = [];
	const d: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		dx[i] = pts[i + 1].x - pts[i].x;
		d[i] = (pts[i + 1].y - pts[i].y) / dx[i];
	}
	const m: number[] = [d[0]];
	for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
	m[n - 1] = d[n - 2];
	for (let i = 0; i < n - 1; i++) {
		if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
		const a = m[i] / d[i];
		const b = m[i + 1] / d[i];
		const s = a * a + b * b;
		if (s > 9) {
			const t = 3 / Math.sqrt(s);
			m[i] = t * a * d[i];
			m[i + 1] = t * b * d[i];
		}
	}
	let path = `M${pts[0].x},${pts[0].y}`;
	for (let i = 0; i < n - 1; i++) {
		const h = dx[i] / 3;
		path += `C${pts[i].x + h},${pts[i].y + m[i] * h} ${pts[i + 1].x - h},${pts[i + 1].y - m[i + 1] * h}` +
			` ${pts[i + 1].x},${pts[i + 1].y}`;
	}
	return path;
}

/** Smooth area chart (daily request counts, per the design). Points spread
 *  edge-to-edge across the plot. */
export function renderAreaChart(
	container: HTMLElement,
	values: number[],
	labels: string[],
	opts: AreaOpts = {},
): void {
	const doc = container.ownerDocument;
	const color = opts.color ?? USAGE_MODEL_COLORS[0];
	const frame = drawFrame(container, labels, Math.max(0, ...values), opts);

	const { padL, padT, plotW, plotH, top } = frame;
	const n = values.length;
	if (n < 2) return;
	const pts = values.map((v, i) => ({
		x: padL + plotW * (i / (n - 1)),
		y: padT + plotH * (1 - v / top),
	}));
	const line = monotonePath(pts);
	if (!line) return;
	const baseline = padT + plotH;
	frame.svg.appendChild(svgEl(doc, "path", {
		class: "semlink-usage-area",
		fill: color,
		"fill-opacity": 0.25,
		d: `${line} L${pts[n - 1].x},${baseline} L${pts[0].x},${baseline} Z`,
	}));
	frame.svg.appendChild(svgEl(doc, "path", {
		class: "semlink-usage-line", fill: "none", stroke: color,
		"stroke-width": 2, "stroke-linecap": "round", d: line,
	}));
}
