// Canvas Go board: wood, grid, stones, overlays, hover ghost. Knows nothing about the network.
//
// Everything but the hover ghost is drawn once per scene (or resize) into an offscreen layer;
// moving the mouse copies that layer and draws only the ghost stone on top.

import { starPoints } from "../../src/engine/board.ts";
import { samePoint } from "../../src/shared/coords.ts";
import type { Board, Color, Overlay, Point } from "../../src/shared/types.ts";
import { type BoardLayout, columnLabel, computeLayout, pixelToPoint, pointToPixel, rowLabel } from "./geometry.ts";

export interface BoardScene {
  board: Board;
  lastMove: Point | null;
  overlay: Overlay | null;
  /** KataGo's preferred move, highlighted during a fallback. */
  bestMove: Point | null;
  /** Color of the hover ghost, or null when the board does not accept input. */
  hoverColor: Color | null;
}

interface Palette {
  woodLight: string;
  woodDark: string;
  grain: string;
  grid: string;
  label: string;
  accent: string;
  best: string;
}

const STONE_RADIUS = 0.48; // in cells

type Ctx = CanvasRenderingContext2D;

export class BoardView {
  private readonly ctx: Ctx;
  private scene: BoardScene | null = null;
  private layout: BoardLayout = computeLayout(400, 9);
  private hover: Point | null = null;
  private wood: { key: string; canvas: HTMLCanvasElement } | null = null;
  /** The scene without the hover ghost, in device pixels; null when it needs drawing again. */
  private layer: HTMLCanvasElement | null = null;
  private readonly layerCanvas = document.createElement("canvas");
  private palette: Palette;

  /** Called with the point the user clicked, only while hoverColor is set. */
  onPlay: (p: Point) => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    container: HTMLElement,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.palette = readPalette(canvas);

    new ResizeObserver(() => this.resize(container)).observe(container);
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        this.palette = readPalette(canvas);
        this.wood = null;
        this.layer = null;
        this.draw();
      });

    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      this.setHover(this.eventPoint(e));
    });
    canvas.addEventListener("pointerleave", () => this.setHover(null));
    canvas.addEventListener("click", (e) => {
      const p = this.eventPoint(e);
      if (p && this.canPlayAt(p)) this.onPlay(p);
    });
    this.resize(container);
  }

  setScene(scene: BoardScene): void {
    this.scene = scene;
    if (scene.board.length !== this.layout.size) {
      this.layout = computeLayout(this.layout.cssSize, scene.board.length);
      this.wood = null;
    }
    this.layer = null;
    this.draw();
  }

  private eventPoint(e: MouseEvent): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    return pixelToPoint(this.layout, e.clientX - rect.left, e.clientY - rect.top);
  }

  private canPlayAt(p: Point): boolean {
    const s = this.scene;
    return !!s && s.hoverColor !== null && s.board[p.y]?.[p.x] === null;
  }

  private setHover(p: Point | null): void {
    if (samePoint(p, this.hover) || (p === null && this.hover === null)) return;
    this.hover = p;
    this.canvas.style.cursor = p && this.canPlayAt(p) ? "pointer" : "default";
    this.draw();
  }

  private resize(container: HTMLElement): void {
    const css = Math.max(200, Math.floor(Math.min(container.clientWidth, container.clientHeight || Infinity)));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.layout = computeLayout(css, this.scene?.board.length ?? this.layout.size);
    this.wood = null;
    this.layer = null;
    this.draw();
  }

  draw(): void {
    const { ctx, layout } = this;
    const dpr = this.canvas.width / layout.cssSize;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer(dpr), 0, 0);
    const s = this.scene;
    if (this.hover && s?.hoverColor && this.canPlayAt(this.hover)) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawStone(ctx, this.hover, s.hoverColor, layout.cell * STONE_RADIUS, 0.45);
    }
  }

  /** Wood, grid, labels, stones and overlays: everything but the hover ghost. */
  private staticLayer(dpr: number): HTMLCanvasElement {
    if (this.layer) return this.layer;
    const c = this.layerCanvas;
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext("2d")!;
    const { layout } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, layout.cssSize, layout.cssSize);
    g.drawImage(this.woodCanvas(dpr), 0, 0, layout.cssSize, layout.cssSize);
    this.drawGrid(g, dpr);

    const s = this.scene;
    if (s) {
      const r = layout.cell * STONE_RADIUS;
      s.board.forEach((row, y) =>
        row.forEach((c, x) => {
          if (c) this.drawStone(g, { x, y }, c, r, 1);
        }),
      );
      if (s.bestMove) this.drawBestMove(g, s.bestMove, r);
      if (s.lastMove) {
        const c = s.board[s.lastMove.y]?.[s.lastMove.x];
        if (c) this.drawLastMove(g, s.lastMove, c, r);
      }
      if (s.overlay?.variation) this.drawVariation(g, s.overlay.variation.moves, s.board, r);
      for (const m of s.overlay?.marks ?? []) this.drawMark(g, m, s.board, r);
    }
    this.layer = c;
    return c;
  }

  // --- wood -------------------------------------------------------------

  private woodCanvas(dpr: number): HTMLCanvasElement {
    const px = Math.round(this.layout.cssSize * dpr);
    const key = `${px}|${this.palette.woodLight}|${this.palette.woodDark}`;
    if (this.wood?.key === key) return this.wood.canvas;

    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d")!;
    const base = g.createLinearGradient(0, 0, px, px);
    base.addColorStop(0, this.palette.woodLight);
    base.addColorStop(1, this.palette.woodDark);
    g.fillStyle = base;
    g.fillRect(0, 0, px, px);

    // Grain: gently wavy, nearly horizontal lines with seeded variation.
    const rand = mulberry32(7);
    g.strokeStyle = this.palette.grain;
    for (let i = 0; i < 70; i++) {
      const y0 = rand() * px;
      const amp = (2 + rand() * 6) * dpr;
      const freq = (0.6 + rand() * 1.6) / px;
      const phase = rand() * Math.PI * 2;
      g.globalAlpha = 0.05 + rand() * 0.12;
      g.lineWidth = (0.5 + rand() * 1.6) * dpr;
      g.beginPath();
      for (let x = 0; x <= px; x += 6 * dpr) {
        const y = y0 + Math.sin(x * freq * Math.PI * 2 + phase) * amp + (x / px) * amp;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;

    // Soft vignette so the edges feel like a board, not a rectangle.
    const v = g.createRadialGradient(px / 2, px / 2, px * 0.3, px / 2, px / 2, px * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(60,30,0,0.12)");
    g.fillStyle = v;
    g.fillRect(0, 0, px, px);

    this.wood = { key, canvas: c };
    return c;
  }

  // --- grid -------------------------------------------------------------

  private drawGrid(ctx: Ctx, dpr: number): void {
    const { layout, palette } = this;
    const { size, cell, margin } = layout;
    const end = margin + (size - 1) * cell;
    // Snap 1px lines to the device pixel grid so they stay sharp.
    const half = Math.round(dpr) % 2 === 1 ? 0.5 : 0;
    const crisp = (v: number) => (Math.round(v * dpr) + half) / dpr;

    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < size; i++) {
      const p = crisp(margin + i * cell);
      ctx.moveTo(crisp(margin), p);
      ctx.lineTo(crisp(end), p);
      ctx.moveTo(p, crisp(margin));
      ctx.lineTo(p, crisp(end));
    }
    ctx.stroke();
    // Slightly heavier border.
    ctx.lineWidth = 1.6;
    ctx.strokeRect(crisp(margin), crisp(margin), end - margin, end - margin);

    ctx.fillStyle = palette.grid;
    const starR = Math.max(2, cell * 0.09);
    for (const p of starPoints(size)) {
      const { x, y } = pointToPixel(layout, p);
      ctx.beginPath();
      ctx.arc(x, y, starR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = palette.label;
    ctx.font = `500 ${Math.max(9, cell * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const off = margin - cell * 0.72;
    for (let i = 0; i < size; i++) {
      const pos = margin + i * cell;
      ctx.fillText(columnLabel(i), pos, off);
      ctx.fillText(columnLabel(i), pos, end + (margin - off));
      ctx.fillText(rowLabel(i, size), off, pos);
      ctx.fillText(rowLabel(i, size), end + (margin - off), pos);
    }
  }

  // --- stones and overlays ---------------------------------------------

  private drawStone(ctx: Ctx, p: Point, color: Color, r: number, alpha: number): void {
    const { x, y } = pointToPixel(this.layout, p);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (alpha === 1) {
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = r * 0.35;
      ctx.shadowOffsetX = r * 0.08;
      ctx.shadowOffsetY = r * 0.12;
    }
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    if (color === "B") {
      grad.addColorStop(0, "#5c5c5c");
      grad.addColorStop(0.45, "#232323");
      grad.addColorStop(1, "#0b0b0b");
    } else {
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.6, "#ecebe6");
      grad.addColorStop(1, "#c6c4bc");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawLastMove(ctx: Ctx, p: Point, color: Color, r: number): void {
    const { x, y } = pointToPixel(this.layout, p);
    ctx.strokeStyle = color === "B" ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.75)";
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawBestMove(ctx: Ctx, p: Point, r: number): void {
    const { x, y } = pointToPixel(this.layout, p);
    ctx.save();
    ctx.strokeStyle = this.palette.best;
    ctx.fillStyle = this.palette.best;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.stroke();
    ctx.restore();
  }

  private drawVariation(ctx: Ctx, moves: { color: Color; point: Point }[], board: Board, r: number): void {
    moves.forEach((m, i) => {
      const occupied = board[m.point.y]?.[m.point.x] != null;
      if (!occupied) this.drawStone(ctx, m.point, m.color, r, 0.62);
      const { x, y } = pointToPixel(this.layout, m.point);
      const under = board[m.point.y]?.[m.point.x] ?? m.color;
      ctx.fillStyle = under === "B" ? "#fff" : "#111";
      ctx.font = `600 ${r * (i + 1 >= 10 ? 0.8 : 0.95)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y + r * 0.05);
    });
  }

  private drawMark(ctx: Ctx, m: NonNullable<Overlay["marks"]>[number], board: Board, r: number): void {
    const { x, y } = pointToPixel(this.layout, m.point);
    const stone = board[m.point.y]?.[m.point.x] ?? null;
    const color = stone === "B" ? "#fff" : stone === "W" ? "#111" : this.palette.accent;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.8, r * 0.14);
    const s = r * 0.55;
    ctx.beginPath();
    switch (m.kind) {
      case "circle":
        ctx.arc(x, y, s, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "triangle":
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.92, y + s * 0.6);
        ctx.lineTo(x - s * 0.92, y + s * 0.6);
        ctx.closePath();
        ctx.stroke();
        break;
      case "square":
        ctx.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
        ctx.stroke();
        break;
      case "x":
        ctx.moveTo(x - s * 0.75, y - s * 0.75);
        ctx.lineTo(x + s * 0.75, y + s * 0.75);
        ctx.moveTo(x + s * 0.75, y - s * 0.75);
        ctx.lineTo(x - s * 0.75, y + s * 0.75);
        ctx.stroke();
        break;
      case "label": {
        const text = m.text ?? "";
        if (!stone) {
          // Clear the grid under the label so it reads cleanly.
          ctx.fillStyle = this.palette.woodLight;
          ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = color;
        }
        ctx.font = `700 ${r * (text.length > 1 ? 0.8 : 1)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x, y + r * 0.05);
        break;
      }
    }
    ctx.restore();
  }
}

function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    woodLight: v("--wood-light", "#e3bd7a"),
    woodDark: v("--wood-dark", "#cf9f58"),
    grain: v("--wood-grain", "#8a5a22"),
    grid: v("--grid", "#3b2a14"),
    label: v("--board-label", "rgba(59,42,20,0.75)"),
    accent: v("--mark", "#b4231b"),
    best: v("--best", "#1f8a4c"),
  };
}

/** Small seeded PRNG so the grain is identical across redraws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
