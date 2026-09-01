// ========================================
// Semlink - coffee cup canvas (guide's index step)
// ========================================
// The WHOLE coffee scene is drawn on one canvas: cup body + handle + saucer,
// waving coffee liquid with rising bubbles, the model's latte-art chip riding
// the surface, the pour stream + splash droplets per note, the file-name tag
// fading above the rim, and steam once the brew is done.
//
// Layout (logical px): canvas spans the panel width; the cup is centered.
//   y 0..26   steam + pour-tag zone
//   y 30..96  cup body (54x66, centered)
//   y 100..108 saucer
//
// Lifecycle: the rAF loop starts lazily on the first setLevel()/celebrate()
// and stops by itself when the canvas leaves the DOM (guide re-render / view
// close) or when the brew has settled (not brewing, calm surface, 3s idle).
// The loop is exception-proof: the next frame is scheduled BEFORE drawing.

/** Interactive coffee scene for the guide's index step. */
export interface CoffeeCanvas {
	/** Set the fill level (0-100). splash=true agitates the surface and
	 *  throws a few droplets (call per progress event / file completion). */
	setLevel(pct: number, splash: boolean): void;
	/** Pause: bubbles stop spawning and the surface settles. */
	setBrewing(brewing: boolean): void;
	/** A new note starts brewing: pour it into the cup from above. The
	 *  file name fades in above the rim; the latte chip wobbles. */
	pour(fileName: string): void;
	/** Finish the brew: big splash + bubble burst + steam before settling. */
	celebrate(): void;
	/** Stop the loop immediately and release the canvas. */
	destroy(): void;
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

interface SteamWisp {
	x: number;
	phase: number;
}

/** Truncate text to fit `maxWidth` (cheap canvas ellipsis). */
const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let t = text;
	while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
	return t + "…";
};

/** Mount the full coffee scene into `container` (full panel width). */
export function mountCoffeeCanvas(
	container: HTMLElement,
	opts: { modelLogoSvg?: string; modelName: string; onModelReady?: () => void },
): CoffeeCanvas {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const canvas = container.createEl("canvas", { cls: "semlink-guide-index-cupcanvas" });
	const w = container.clientWidth || 296;
	const h = 126;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = `${w}px`;
	canvas.style.height = `${h}px`;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return { setLevel() {}, setBrewing() {}, pour() {}, celebrate() {}, destroy() {} };
	}
	ctx.scale(dpr, dpr);

	// --- scene geometry ---
	const cupW = 54;
	const cupH = 66;
	const cupX = (w - cupW) / 2;
	const cupY = 38;
	const cupCX = cupX + cupW / 2;

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
	let pourLabel = "";
	let pourLabelT = 0; // seconds left for the file-name tag
	let latteWobble = 0; // 0-1 — latte chip reaction to a fresh pour
	const bubbles: Bubble[] = [];
	const droplets: Droplet[] = [];
	const steam: SteamWisp[] = [
		{ x: cupX + 13, phase: 0 },
		{ x: cupX + 27, phase: 1.3 },
		{ x: cupX + 41, phase: 2.6 },
	];

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
			// ~30fps cap: half the rAF frames are skips — the liquid is slow
			// motion, and this halves the canvas cost during long index runs.
			if (now - last < 28) return;
			const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
			last = now;
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
			if (pourLabelT > 0) pourLabelT = Math.max(0, pourLabelT - dt);
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
			const gloss = ctx.createLinearGradient(cupX, 0, cupX + cupW * 0.4, 0);
			gloss.addColorStop(0, "rgba(255, 255, 255, 0.2)");
			gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
			ctx.fillStyle = gloss;
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

			// Saucer.
			ctx.save();
			ctx.shadowColor = "rgba(124, 58, 237, 0.35)";
			ctx.shadowBlur = 5;
			ctx.shadowOffsetY = 2;
			ctx.beginPath();
			ctx.roundRect(cupCX - 36, cupY + cupH + 8, 72, 7, 4);
			const sg = ctx.createLinearGradient(0, cupY + cupH + 8, 0, cupY + cupH + 15);
			sg.addColorStop(0, "#8b5cf6");
			sg.addColorStop(1, "#7c3aed");
			ctx.fillStyle = sg;
			ctx.fill();
			ctx.restore();

			// Latte-art chip: the model's logo PERCHED ON TOP of the cup rim
			// (drawn after the wall so nothing covers it), bobbing gently and
			// wobbling when a note pours in.
			const wob = latteWobble;
			const latteY = cupY - 12 + Math.sin(now * 0.003) * 1.2;
			ctx.save();
			ctx.translate(cupCX, latteY);
			ctx.rotate(wob * Math.sin(now * 0.02) * 0.35);
			ctx.scale(1 + wob * 0.3, 1 + wob * 0.3);
			ctx.beginPath();
			ctx.arc(0, 0, 9, 0, Math.PI * 2);
			ctx.fillStyle = "#ffffff";
			ctx.fill();
			ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
			ctx.lineWidth = 1.5;
			ctx.stroke();
			if (modelImgReady) {
				ctx.drawImage(modelImg, -5.5, -5.5, 11, 11);
			} else {
				ctx.fillStyle = "#7c3aed";
				ctx.font = "9px sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText("✦", 0, 0.5);
			}
			ctx.restore();

			// Pour tag: the file name fading above the chip.
			if (pourLabelT > 0 && pourLabel) {
				const a = Math.min(1, (POUR_DUR + 0.6 - pourLabelT) / 0.3, pourLabelT / 0.4);
				ctx.fillStyle = `rgba(120, 120, 128, ${0.9 * Math.max(0, Math.min(1, a))})`;
				ctx.font = "italic 9px 'Segoe UI', sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "alphabetic";
				ctx.fillText(fitText(ctx, pourLabel, 220), cupCX, cupY - 26);
			}

			// Steam: only once the brew is served.
			if (done) {
				for (const wsp of steam) {
					const t = (now * 0.0009 + wsp.phase) % 1;
					const sy2 = cupY - 6 - t * 20;
					const sx2 = wsp.x + Math.sin(t * Math.PI * 2 + wsp.phase) * 3;
					const a = Math.sin(t * Math.PI) * 0.5;
					ctx.beginPath();
					ctx.arc(sx2, sy2, 2.2 - t, 0, Math.PI * 2);
					ctx.fillStyle = `rgba(160, 150, 170, ${a})`;
					ctx.fill();
				}
			}

			// Settle: stop the loop once the brew is over and everything is calm.
			if (!brewing && !done && agitation < 0.01 && droplets.length === 0 && bubbles.length === 0 && pourT <= 0 && pourLabelT <= 0) {
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
			pourLabel = fileName;
			pourLabelT = POUR_DUR + 0.6;
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
	};
}
