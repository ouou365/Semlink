// ========================================
// Semlink - coffee cup canvas (guide's index step)
// ========================================
// The WHOLE coffee scene is drawn on one canvas: cup body + handle + saucer,
// waving coffee liquid with rising bubbles, the model's latte-art chip riding
// the surface, the pour stream + splash droplets per note, the file-name tag
// fading above the rim, and steam once the brew is done.
//
// Layout (logical px): canvas spans up to 200px, centered by CSS; the cup is
// centered in that width.
//   y 0..30   steam + pour-tag zone
//   y 48..122 cup body (62x74, centered)
//   y 130..137 saucer
//
// Lifecycle: the rAF loop starts lazily on the first setLevel()/celebrate()
// and stops by itself when the canvas leaves the DOM (guide re-render / view
// close) or when the brew has settled (not brewing, calm surface, 3s idle).
// The loop is exception-proof: the next frame is scheduled BEFORE drawing.

/** One recorded jank moment: when it happened and what the scene looked
 *  like. kind "block" = the rAF callback itself arrived late (the main
 *  thread was busy doing something else); kind "slow" = two drawn frames
 *  more than 50ms apart (perceptible stutter). */
export interface CoffeeJankEvent {
	t: number;
	kind: "block" | "slow";
	gap: number;
	draw: number;
	level: number;
	bubbles: number;
	droplets: number;
	pourT: number;
}

/** Snapshot for the on-screen debug readout. */
export interface CoffeeStats {
	mountSec: number;
	fps: number;
	drawAvgMs: number;
	drawMaxMs: number;
	gapMaxMs: number;
	skipped: number;
	drawn: number;
	w: number;
	h: number;
	dpr: number;
	level: number;
	agitation: number;
	brewing: boolean;
	running: boolean;
	bubbles: number;
	droplets: number;
	pourT: number;
	jank: CoffeeJankEvent[];
}

/** Interactive coffee scene for the guide's index step. */
export interface CoffeeCanvas {
	/** Set the fill level (0-100). splash=true agitates the surface and
	 *  throws a few droplets (call per progress event / file completion). */
	setLevel(pct: number, splash: boolean): void;
	/** Pause: bubbles stop spawning and the surface settles. */
	setBrewing(brewing: boolean): void;
	/** A new note starts brewing: pour it into the cup from above. The
	 *  latte chip wobbles. */
	pour(fileName: string): void;
		/** Finish the brew: big splash + bubble burst + steam before settling. */
	celebrate(): void;
	/** Stop the loop immediately and release the canvas. */
	destroy(): void;
	/** Diagnostic snapshot for the debug readout (null if canvas unavailable). */
	getStats(): CoffeeStats | null;
}

interface Bubble {
	x: number;
	y: number;
	r: number;
	speed: number;
	phase: number;
}

interface Droplet {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	life: number;
}

/** Truncate text to fit `maxWidth` (cheap canvas ellipsis). */
const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let t = text;
	while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
	return t + "…";
};

/** Middle truncation: keep head + tail — note names carry meaning at both
 *  ends (dates, versions, markers), so chopping only the tail loses more
 *  than it has to. Falls back to a bare head when even that overflows. */
const middleFit = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let len = text.length;
	while (len > 6) {
		const keep = Math.floor(len / 2) - 1;
		const cand = text.slice(0, keep) + "…" + text.slice(text.length - keep);
		if (ctx.measureText(cand).width <= maxWidth) return cand;
		len = keep + 1;
	}
	return text.slice(0, 2) + "…";
};

/** Mount the full coffee scene into `container` (full panel width). */
export function mountCoffeeCanvas(
	container: HTMLElement,
	opts: { modelLogoSvg?: string; modelName: string; onModelReady?: () => void },
): CoffeeCanvas {
	const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
	const canvas = container.createEl("canvas", { cls: "semlink-guide-index-cupcanvas" });
	// The scene is narrow (cup + saucer + a tag overhead) — cap the canvas at
	// 200 logical px and let CSS center it. Filling the full panel width
	// (×dpr) cost 3-4× the pixels for empty margin on both sides.
	const w = Math.min(container.clientWidth || 200, 200);
	// Tall sky: the document cards need room above AND below without
	// crowding the latte chip or the rim.
	const h = 150;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = `${w}px`;
	canvas.style.height = `${h}px`;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return { setLevel() {}, setBrewing() {}, pour() {}, celebrate() {}, destroy() {}, getStats: () => null };
	}
	ctx.scale(dpr, dpr);

	// --- jank diagnostics ---
	const mountedAt = performance.now();
	let drawn = 0;
	let skipped = 0;
	let drawAvg = 0;
	let drawMax = 0;
	let drawLast = 0;
	let gapMax = 0;
	let lastRaf = 0;
	let lastJankAt = 0;
	const recentGaps: number[] = [];
	const jank: CoffeeJankEvent[] = [];
	/** Record a jank moment (deduped to one entry per 150ms so a single stall
	 *  doesn't flood the list). */
	const recordJank = (
		kind: "block" | "slow",
		now: number,
		gap: number,
		draw: number,
	): void => {
		if (now - lastJankAt < 150) return;
		lastJankAt = now;
		jank.push({
			t: (now - mountedAt) / 1000,
			kind,
			gap,
			draw,
			level,
			bubbles: bubbles.length,
			droplets: droplets.length,
			pourT,
		});
		if (jank.length > 6) jank.shift();
	};

	// --- scene geometry ---
	const cupW = 62;
	const cupH = 74;
	const cupX = (w - cupW) / 2;
	const cupY = 56;
	const cupCX = cupX + cupW / 2;

	// Static gradients — created once, reused every frame (per-frame gradient
	// construction showed up as measurable frame cost).
	const glossGrad = ctx.createLinearGradient(cupX, 0, cupX + cupW * 0.4, 0);
	glossGrad.addColorStop(0, "rgba(255, 255, 255, 0.2)");
	glossGrad.addColorStop(1, "rgba(255, 255, 255, 0)");

	// --- model logo raster (SVG string → image) ---
	const modelImg = new Image();
	let modelImgReady = false;
	if (opts.modelLogoSvg) {
		modelImg.onload = () => {
			modelImgReady = true;
			opts.onModelReady?.();
		};
		modelImg.src = "data:image/svg+xml;utf8," + encodeURIComponent(opts.modelLogoSvg);
	} else {
		// No logo to load — the model is "ready" right away (microtask, so
		// the caller can finish mounting first).
		queueMicrotask(() => opts.onModelReady?.());
	}

	// --- state ---
	let level = 0;
	let target = 0;
	let agitation = 0;
	let brewing = false;
	let done = false;
	let running = false;
	let raf = 0;
	let last = 0;
	let idleSince = 0;
	let pourT = 0; // seconds left in the current pour
	const POUR_DUR = 1.9;
	let latteWobble = 0; // 0-1 — latte chip reaction to a fresh pour
	const bubbles: Bubble[] = [];
	const droplets: Droplet[] = [];

	// Saucer gradient — static, hoisted out of the frame loop.
	const saucerGrad = ctx.createLinearGradient(0, cupY + cupH + 8, 0, cupY + cupH + 15);
	saucerGrad.addColorStop(0, "#8b5cf6");
	saucerGrad.addColorStop(1, "#7c3aed");

	// A single wisp at a time: one plume, born at the cup, rising and
	// fading as it climbs — then the next puff starts.
	const STEAM_PLUMES = [
		{ dx: 0, width: 8, speed: 1, phase: 0 },
	];
	let steamLevel = 0;

	const surfaceY = (): number => cupY + cupH * (1 - level) - cupH * 0.04 * (1 - level);

	const spawnDroplets = (count: number, atX: number): void => {
		const surf = surfaceY();
		for (let i = 0; i < count && droplets.length < 26; i++) {
			droplets.push({
				x: atX + (Math.random() - 0.5) * 10,
				y: surf + 2,
				vx: (Math.random() - 0.5) * 1.6,
				vy: -(1.4 + Math.random() * 1.8),
				r: 1 + Math.random() * 1.6,
				life: 1,
			});
		}
	};

	const frame = (now: number): void => {
		// Schedule the next frame FIRST — an exception in the draw code must
		// never silently kill the loop (that froze the cup on one frame).
		raf = requestAnimationFrame(frame);
		try {
			if (!canvas.isConnected) {
				running = false;
				cancelAnimationFrame(raf);
				return;
			}
			// A late rAF callback means the MAIN THREAD was busy elsewhere
			// (indexing work, DOM, serialization) — record it separately from
			// slow draws so the two causes are distinguishable.
			const rafGap = lastRaf ? now - lastRaf : 0;
			lastRaf = now;
			if (rafGap > 40) recordJank("block", now, rafGap, drawLast);
			// ~30fps cap: half the rAF frames are skips — the liquid is slow
			// motion, and this halves the canvas cost during long index runs.
			if (now - last < 28) {
				skipped++;
				return;
			}
			const rawDtMs = now - last;
			const dt = Math.min(0.05, rawDtMs / 1000 || 0.016);
			last = now;
			drawn++;
			recentGaps.push(rawDtMs);
			if (recentGaps.length > 30) recentGaps.shift();
			gapMax = Math.max(gapMax, rawDtMs);
			if (!Number.isFinite(level)) level = 0;
			if (!Number.isFinite(target)) target = 0;
			const surf = surfaceY();

			// Ease the level; decay turbulence, pour, tag and wobble timers.
			level += (target - level) * Math.min(1, dt * 3.2);
			agitation = Math.max(0, agitation - dt * 0.45);
			if (pourT > 0) {
				pourT = Math.max(0, pourT - dt);
				agitation = Math.min(1, agitation + dt * 0.55);
				if (Math.random() < dt * 9) spawnDroplets(1, cupCX);
			}
			latteWobble = Math.max(0, latteWobble - dt * 1.4);

			// Bubbles spawn only while actively brewing and there is liquid.
			if (brewing && level > 0.1 && Math.random() < dt * 4 && bubbles.length < 14) {
				bubbles.push({
					x: cupX + 5 + Math.random() * (cupW - 10),
					y: cupY + cupH - 3,
					r: 1 + Math.random() * 1.8,
					speed: 14 + Math.random() * 16,
					phase: Math.random() * Math.PI * 2,
				});
			}
			for (let i = bubbles.length - 1; i >= 0; i--) {
				const b = bubbles[i];
				b.y -= b.speed * dt;
				b.x += Math.sin(now * 0.004 + b.phase) * 0.25;
				if (b.y <= surf + 4) {
					bubbles.splice(i, 1);
					agitation = Math.min(1, agitation + 0.03);
				}
			}

			// Droplets: gravity, fade, remove when back below the surface.
			for (let i = droplets.length - 1; i >= 0; i--) {
				const d = droplets[i];
				d.vy += 9 * dt;
				d.x += d.vx;
				d.y += d.vy;
				d.life -= dt * 0.9;
				if (d.life <= 0 || d.y > surfaceY() + 6) droplets.splice(i, 1);
			}

			// --- draw ---
			const drawStart = performance.now();
			ctx.clearRect(0, 0, w, h);
			const amp = 0.9 + agitation * 3.4;
			const bob = Math.sin(now * 0.0021) * 0.8;
			const yAt = (x: number): number =>
				surf + bob
				+ Math.sin(x * 0.11 + now * 0.005) * amp
				+ Math.sin(x * 0.05 - now * 0.003) * amp * 0.55
				+ Math.sin(x * 0.023 + now * 0.0016) * amp * 0.35;

			// Cup interior path (inset by the border) — clip for the liquid.
			ctx.save();
			ctx.beginPath();
			ctx.roundRect(cupX + 3, cupY + 3, cupW - 6, cupH - 6, [3, 3, 17, 17]);
			ctx.clip();

			// Liquid body.
			ctx.beginPath();
			ctx.moveTo(cupX, cupY + cupH);
			ctx.lineTo(cupX, yAt(cupX));
			for (let x = cupX + 3; x <= cupX + cupW; x += 3) ctx.lineTo(x, yAt(x));
			ctx.lineTo(cupX + cupW, cupY + cupH);
			ctx.closePath();
			const grad = ctx.createLinearGradient(0, surf - amp, 0, cupY + cupH);
			grad.addColorStop(0, "rgb(199, 186, 253)");
			grad.addColorStop(0.45, "rgb(139, 92, 246)");
			grad.addColorStop(1, "rgb(109, 40, 217)");
			ctx.fillStyle = grad;
			ctx.fill();

			// Crema band: a soft light strip hugging the wave (espresso crema).
			ctx.beginPath();
			ctx.moveTo(cupX, yAt(cupX) + 1.2);
			for (let x = cupX + 3; x <= cupX + cupW; x += 3) ctx.lineTo(x, yAt(x) + 1.2);
			ctx.lineTo(cupX + cupW, yAt(cupX) + 7);
			for (let x = cupX + cupW; x >= cupX; x -= 3) ctx.lineTo(x, yAt(x) + 7);
			ctx.closePath();
			ctx.fillStyle = "rgba(255, 255, 255, 0.26)";
			ctx.fill();

			// Left-side gloss strip (glass reflection).
			ctx.fillStyle = glossGrad;
			ctx.fillRect(cupX, cupY, cupW * 0.4, cupH);

			// Bubbles: translucent body + a tiny top-left highlight.
			for (const b of bubbles) {
				ctx.beginPath();
				ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
				ctx.fill();
				ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
				ctx.lineWidth = 0.9;
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.28, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
				ctx.fill();
			}

			// Splash droplets above the surface.
			for (const d of droplets) {
				ctx.beginPath();
				ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(139, 92, 246, ${Math.max(0, d.life)})`;
				ctx.fill();
			}
			ctx.restore(); // end liquid clip

			// The pour stream: a swaying ribbon from the rim into the liquid.
			if (pourT > 0) {
				const elapsed = POUR_DUR - pourT;
				const alpha = Math.min(1, elapsed / 0.12, pourT / 0.22);
				const sx = cupCX + Math.sin(now * 0.006) * 1.5;
				const sy = surfaceY() + Math.sin(now * 0.005) * amp * 0.6;
				const streamGrad = ctx.createLinearGradient(sx, cupY, sx, sy);
				streamGrad.addColorStop(0, `rgba(196, 181, 253, ${0.9 * alpha})`);
				streamGrad.addColorStop(1, `rgba(139, 92, 246, ${0.95 * alpha})`);
				ctx.beginPath();
				ctx.moveTo(sx - 1.6, cupY - 2);
				ctx.lineTo(sx + 1.6, cupY - 2);
				ctx.lineTo(sx + 1, sy);
				ctx.lineTo(sx - 1, sy);
				ctx.closePath();
				ctx.fillStyle = streamGrad;
				ctx.fill();
				// Impact glow on the surface.
				ctx.beginPath();
				ctx.ellipse(sx, sy, 7, 2.4, 0, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(255, 255, 255, ${0.3 * alpha})`;
				ctx.fill();
			}

			// Cup body over the liquid: white interior is already behind the
			// clip, draw only the purple wall + rim here.
			ctx.beginPath();
			ctx.roundRect(cupX, cupY, cupW, cupH, [5, 5, 20, 20]);
			ctx.strokeStyle = "#7c3aed";
			ctx.lineWidth = 3;
			ctx.stroke();

			// Handle: an arc attached at the cup's right wall.
			ctx.beginPath();
			ctx.arc(cupX + cupW - 1, cupY + 24, 12, -Math.PI / 2.4, Math.PI / 2.4);
			ctx.strokeStyle = "#7c3aed";
			ctx.lineWidth = 3;
			ctx.stroke();

			// Saucer: a plain translucent ellipse stands in for the shadow —
			// shadowBlur here was the single priciest call per frame.
			ctx.fillStyle = "rgba(124, 58, 237, 0.18)";
			ctx.beginPath();
			ctx.ellipse(cupCX, cupY + cupH + 16, cupW * 0.62, 3, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.beginPath();
			ctx.roundRect(cupCX - cupW * 0.68, cupY + cupH + 8, cupW * 1.36, 7, 4);
			ctx.fillStyle = saucerGrad;
			ctx.fill();

			// Latte-art chip: the model's logo PERCHED ON TOP of the cup rim
			// (drawn after the wall so nothing covers it), bobbing gently and
			// wobbling when a note pours in. Once the brew is served the chip
			// is cleared away — the rim stays empty under the steam.
			if (!done) {
				const wob = latteWobble;
				const latteY = cupY - 18 + Math.sin(now * 0.003) * 1.2;
				ctx.save();
				ctx.translate(cupCX, latteY);
				ctx.rotate(wob * Math.sin(now * 0.02) * 0.35);
				ctx.scale(1 + wob * 0.3, 1 + wob * 0.3);
				ctx.beginPath();
				ctx.arc(0, 0, 12, 0, Math.PI * 2);
				ctx.fillStyle = "#ffffff";
				ctx.fill();
				ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
				ctx.lineWidth = 1.5;
				ctx.stroke();
				if (modelImgReady) {
					ctx.drawImage(modelImg, -7.5, -7.5, 15, 15);
				} else {
					ctx.fillStyle = "#7c3aed";
					ctx.font = "12px sans-serif";
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText("✦", 0, 0.5);
				}
				ctx.restore();
			}

			// Steam: smoke rises ALONG the serpentine path — the column is
			// anchored to the rim and both the undulation and the alpha
			// travel upward with the phase; nothing translates straight up.
			steamLevel += ((done ? 1 : 0) - steamLevel) * Math.min(1, dt * 1.5);
			if (steamLevel > 0.02) {
				const rimY = cupY - 1;
				const total = 44;
				const breathe = 0.62 + 0.2 * Math.sin(now * 0.0011);
				const wander = Math.sin(now * 0.0004) * 4;
				const flow = now * 0.0016; // phase travel along the path
				const STEPS = 22;
				const plume = STEAM_PLUMES[0];
				const edgeAt = (h: number): { x: number; y: number; w: number } => {
					const y = rimY - h * total;
					const amp = (1.2 + h * 4.2) * (1 + Math.sin(now * 0.0011) * 0.15);
					const x = cupCX + plume.dx + wander * h
						+ Math.sin(h * Math.PI * 2.2 - flow * 3 + plume.dx * 0.35) * amp;
					const w = plume.width * (1 - h * 0.7) * (1 + h * 0.5);
					return { x, y, w };
				};
				for (const pass of [{ spread: 2.1, mul: 0.4 }, { spread: 1, mul: 1 }]) {
					ctx.beginPath();
					for (let i = 0; i <= STEPS; i++) {
						const p = edgeAt(i / STEPS);
						if (i === 0) ctx.moveTo(p.x - p.w * pass.spread, p.y);
						else ctx.lineTo(p.x - p.w * pass.spread, p.y);
					}
					for (let i = STEPS; i >= 0; i--) {
						const p = edgeAt(i / STEPS);
						ctx.lineTo(p.x + p.w * pass.spread, p.y);
					}
					ctx.closePath();
					// Alpha: strongest at the rim, dissolving toward the top,
					// with a shimmer traveling upward.
					const g = ctx.createLinearGradient(0, rimY, 0, rimY - total);
					const base = 0.55 * steamLevel * breathe * pass.mul;
					g.addColorStop(0, `rgba(216, 212, 230, ${base})`);
					g.addColorStop(0.7, `rgba(216, 212, 230, ${base * 0.36})`);
					g.addColorStop(1, "rgba(216, 212, 230, 0)");
					ctx.fillStyle = g;
					ctx.fill();
				}
			}
			// Frame accounting: draw cost EMA + a jank event when two drawn
			// frames land more than 50ms apart (below ~20fps — perceptible).
			const drawMs = performance.now() - drawStart;
			drawAvg = drawAvg * 0.9 + drawMs * 0.1;
			drawLast = drawMs;
			if (drawMs > drawMax) drawMax = drawMs;
			if (rawDtMs > 50) recordJank("slow", now, rawDtMs, drawMs);

			// Settle: stop the loop once the brew is over and everything is calm.
			if (!brewing && !done && agitation < 0.01 && droplets.length === 0 && bubbles.length === 0 && pourT <= 0) {
				if (!idleSince) idleSince = now;
				if (now - idleSince > 3000) {
					running = false;
					cancelAnimationFrame(raf);
					return;
				}
			} else {
				idleSince = 0;
			}
		} catch (e) {
			// Never let a draw failure kill the loop — log and keep going.
			console.error("Semlink: coffee canvas frame failed", e);
		}
	};

	const ensureLoop = (): void => {
		if (running || !canvas.isConnected) return;
		running = true;
		idleSince = 0;
		last = performance.now();
		raf = requestAnimationFrame(frame);
	};

	// Paint the idle scene immediately — an empty cup waiting to brew.
	ensureLoop();

	return {
		setLevel(pct, splash) {
			const t = Math.max(0, Math.min(1, pct / 100));
			// Splash only when the level actually moved — repeated identical
			// events would keep the surface at max turbulence forever.
			const changed = Math.abs(t - target) > 0.0008;
			target = t;
			brewing = true;
			if (splash && changed) {
				agitation = Math.min(1, agitation + 0.3);
				spawnDroplets(3 + Math.floor(Math.random() * 3), cupCX);
			}
			ensureLoop();
		},
		setBrewing(b) {
			brewing = b;
			if (b) ensureLoop();
		},
		pour(fileName) {
			// A pour still in flight keeps playing — restarting it on every
			// file would hold the surface at max turbulence forever.
			if (pourT > POUR_DUR * 0.3) return;
			pourT = POUR_DUR;
			latteWobble = 1;
			ensureLoop();
		},
		celebrate() {
			brewing = false;
			done = true;
			target = 1;
			agitation = 1;
			spawnDroplets(16, cupCX);
			for (let i = 0; i < 10; i++) {
				bubbles.push({
					x: cupX + 5 + Math.random() * (cupW - 10),
					y: cupY + cupH - Math.random() * cupH * 0.8,
					r: 1 + Math.random() * 2,
					speed: 18 + Math.random() * 20,
					phase: Math.random() * Math.PI * 2,
				});
			}
			ensureLoop();
		},
		destroy() {
			cancelAnimationFrame(raf);
			running = false;
			canvas.remove();
		},
		getStats() {
			if (!canvas.isConnected) return null;
			const avgGap = recentGaps.length
				? recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length
				: 0;
			return {
				mountSec: (performance.now() - mountedAt) / 1000,
				fps: avgGap ? 1000 / avgGap : 0,
				drawAvgMs: drawAvg,
				drawMaxMs: drawMax,
				gapMaxMs: gapMax,
				skipped,
				drawn,
				w,
				h,
				dpr,
				level,
				agitation,
				brewing,
				running,
				bubbles: bubbles.length,
				droplets: droplets.length,
				pourT,
				jank: jank.slice(),
			};
		},
	};
}


/** Mount the order-ticket deck: the stack of receipt cards (one per
 *  concurrently indexing note) hanging under the printer capsule.
 *  Rendered statically — tickets only repaint when the roster changes. */
/** Mount the order-ticket deck: ONE receipt card under the printer capsule,
 *  listing every concurrently indexing note (name left, chunk progress
 *  right — like line items on a barista's order). Static render: the
 *  ticket only repaints when the roster changes. */
/** Mount the order-ticket deck: ONE receipt card under the printer capsule,
 *  listing every concurrently indexing note (name left, chunk progress
 *  right — like line items on a barista's order). Static render: the
 *  ticket only repaints when the roster changes. */
export function mountTicketDeck(
	container: HTMLElement,
	width?: number,
): { setFiles(files: Array<{ name: string; progress: string }>): void } {
	const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
	const canvas = container.createEl("canvas", { cls: "semlink-guide-index-deckcanvas" });
	const w = width ?? Math.max(120, Math.min(container.clientWidth || 200, 200));
	const h = 50;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = `${w}px`;
	canvas.style.height = `${h}px`;
	const ctx = canvas.getContext("2d");
	if (!ctx) return { setFiles() {} };
	ctx.scale(dpr, dpr);
	let fileTags: Array<{ name: string; progress: string }> = [];
	const draw = (): void => {
		ctx.clearRect(0, 0, w, h);
		if (fileTags.length === 0) return;
		ctx.textBaseline = "middle";
		const cardW = Math.max(60, w - 16);
		const cardH = fileTags.length * 13 + 11;
		const x0 = (w - cardW) / 2, x1 = x0 + cardW;
		const y0 = 0, y1 = y0 + cardH;
		const step = 9, depth = 2.5;
		const ticketPath = (): void => {
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(x1, y0);
			ctx.lineTo(x1, y1 - depth);
			let px = x1;
			while (px - step / 2 > x0 + 1) {
				px -= step / 2;
				ctx.lineTo(px, y1);
				px -= step / 2;
				ctx.lineTo(px, y1 - depth);
			}
			ctx.lineTo(x0, y0);
			ctx.closePath();
		};
		ctx.fillStyle = "rgba(60, 50, 90, 0.10)";
		ctx.save();
		ctx.translate(1, 1.5);
		ticketPath();
		ctx.fill();
		ctx.restore();
		ctx.fillStyle = "#fffef7";
		ticketPath();
		ctx.fill();
		// line items: note name left, chunk progress right
		ctx.font = "10px 'Segoe UI', sans-serif";
		ctx.textAlign = "left";
		fileTags.forEach((f, li) => {
			const base = y0 + 10 + li * 13;
			const prog = f.progress ? `(${f.progress})` : "";
			const progW = prog ? ctx.measureText(prog).width : 0;
			const name = fitText(ctx, f.name, cardW - 14 - progW);
			ctx.fillStyle = "rgba(85, 80, 74, 0.95)";
			ctx.fillText(name, x0 + 7, base);
			if (prog) {
				ctx.fillStyle = "rgba(120, 120, 128, 0.85)";
				ctx.textAlign = "right";
				ctx.fillText(prog, x1 - 7, base);
				ctx.textAlign = "left";
			}
		});
	};
	return {
		setFiles(files) {
			fileTags = files.slice(0, 3);
			draw();
		},
	};
}