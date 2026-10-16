import type { Color, GameResult, GameSettings, Move, MoveRecord, Point } from "../shared/types.ts";
import { handicapPoints } from "./board.ts";

/** Comments keyed by move number; 0 is the root node (before the first move). */
export type SgfComments = ReadonlyMap<number, string> | Readonly<Record<number, string>>;

export interface SgfWriteOptions {
  /** Extra setup stones beyond the settings' handicap (e.g. a problem position). */
  setup?: readonly { color: Color; point: Point }[];
  playerBlack?: string;
  playerWhite?: string;
}

export interface SgfGame {
  size: number;
  komi: number;
  handicap: number;
  /** Setup stones from AB/AW in the root node (handicap stones included). */
  setup: { color: Color; point: Point }[];
  playerBlack?: string;
  playerWhite?: string;
  result: GameResult | null;
  /** The raw RE value, if any. */
  resultText?: string;
  /** Main-line moves. */
  moves: Move[];
  /** Comments keyed by move number; 0 is the root node. */
  comments: Map<number, string>;
}

const BOT_PREFIX = "KataGo";

export function writeSgf(
  settings: GameSettings,
  moves: readonly (Move | MoveRecord)[],
  result?: GameResult | null,
  comments?: SgfComments,
  options: SgfWriteOptions = {},
): string {
  const commentMap = toMap(comments);
  const bot = `${BOT_PREFIX} ${settings.botRank}`;
  const root: [string, string[]][] = [
    ["GM", ["1"]],
    ["FF", ["4"]],
    ["CA", ["UTF-8"]],
    ["AP", ["GoTutor"]],
    ["RU", ["Chinese"]],
    ["SZ", [String(settings.size)]],
    ["KM", [String(settings.komi)]],
  ];
  if (settings.handicap >= 2) root.push(["HA", [String(settings.handicap)]]);
  root.push(["PB", [options.playerBlack ?? (settings.humanColor === "B" ? "Human" : bot)]]);
  root.push(["PW", [options.playerWhite ?? (settings.humanColor === "W" ? "Human" : bot)]]);
  if (result) root.push(["RE", [formatResult(result)]]);

  const setup = [
    ...handicapPoints(settings.size, settings.handicap).map((point) => ({ color: "B" as Color, point })),
    ...(options.setup ?? []),
  ];
  for (const color of ["B", "W"] as const) {
    const pts = setup.filter((s) => s.color === color).map((s) => toSgfPoint(s.point));
    if (pts.length > 0) root.push([`A${color}`, pts]);
  }
  const rootComment = commentMap.get(0);
  if (rootComment) root.push(["C", [rootComment]]);

  let out = `(;${root.map(([id, values]) => formatProp(id, values)).join("")}`;
  moves.forEach((item, i) => {
    const move = "move" in item ? item.move : item;
    out += `\n;${formatProp(move.color, ["pass" in move ? "" : toSgfPoint(move.point)])}`;
    const comment = commentMap.get(i + 1);
    if (comment) out += formatProp("C", [comment]);
  });
  return `${out})\n`;
}

/** Parse the main line of an SGF game (the first variation at every branch). Throws on malformed input. */
export function parseSgf(text: string): SgfGame {
  const nodes = mainLine(text);
  const root = nodes[0];
  if (!root) throw new Error("SGF has no nodes");
  const one = (id: string): string | undefined => root.get(id)?.[0];

  const size = Number((one("SZ") ?? "19").split(":")[0]);
  if (!Number.isInteger(size) || size < 2 || size > 25) throw new Error(`Unsupported SGF board size "${one("SZ")}"`);
  const komi = one("KM") === undefined ? 0 : Number(one("KM"));
  const handicap = one("HA") === undefined ? 0 : Number(one("HA"));

  const setup: SgfGame["setup"] = [];
  for (const color of ["B", "W"] as const) {
    for (const value of root.get(`A${color}`) ?? []) {
      for (const point of expandPoints(value, size)) setup.push({ color, point });
    }
  }

  const comments = new Map<number, string>();
  const rootComment = one("C");
  if (rootComment !== undefined) comments.set(0, rootComment);

  const moves: Move[] = [];
  for (const node of nodes) {
    for (const color of ["B", "W"] as const) {
      const value = node.get(color)?.[0];
      if (value === undefined) continue;
      const point = parseSgfPoint(value, size);
      moves.push(point ? { color, point } : { color, pass: true });
      const comment = node.get("C")?.[0];
      if (comment !== undefined && node !== root) comments.set(moves.length, comment);
    }
  }

  const resultText = one("RE");
  return {
    size,
    komi: Number.isFinite(komi) ? komi : 0,
    handicap: Number.isInteger(handicap) ? handicap : 0,
    setup,
    playerBlack: one("PB"),
    playerWhite: one("PW"),
    result: resultText === undefined ? null : parseResult(resultText),
    resultText,
    moves,
    comments,
  };
}

/** Best-effort GameSettings for an SGF written by writeSgf (the bot is the player named "KataGo <rank>"). */
export function settingsFromSgf(game: SgfGame): GameSettings | null {
  if (game.size !== 9 && game.size !== 13 && game.size !== 19) return null;
  const botName = [game.playerBlack, game.playerWhite].find((n) => n?.startsWith(`${BOT_PREFIX} `));
  if (!botName) return null;
  return {
    size: game.size,
    komi: game.komi,
    humanColor: botName === game.playerBlack ? "W" : "B",
    botRank: botName.slice(BOT_PREFIX.length + 1),
    handicap: game.handicap,
  };
}

export function formatResult(result: GameResult): string {
  if (result.reason === "abandon" || (result.winner === null && result.reason !== "score")) return "Void";
  if (result.winner === null) return "0";
  if (result.reason === "resign") return `${result.winner}+R`;
  return `${result.winner}+${Math.abs(result.margin)}`;
}

export function parseResult(text: string): GameResult {
  const t = text.trim();
  if (/^(0|draw|jigo)$/i.test(t)) return { winner: null, margin: 0, reason: "score" };
  const match = /^([BW])\+(.*)$/i.exec(t);
  if (!match) return { winner: null, margin: 0, reason: "abandon" };
  const winner = match[1]!.toUpperCase() as Color;
  const detail = match[2]!.trim();
  const points = Number(detail);
  if (detail !== "" && Number.isFinite(points)) {
    return { winner, margin: winner === "B" ? points : -points, reason: "score" };
  }
  // B+R (resign), B+T (time), B+F (forfeit), or a bare "B+": the loser gave up.
  return { winner, margin: 0, reason: "resign" };
}

function toSgfPoint(p: Point): string {
  return String.fromCharCode(97 + p.x) + String.fromCharCode(97 + p.y);
}

/** null for a pass ("" or "tt" on boards up to 19×19). */
function parseSgfPoint(value: string, size: number): Point | null {
  if (value === "" || (value === "tt" && size <= 19)) return null;
  if (!/^[a-zA-Z]{2}$/.test(value)) throw new Error(`Bad SGF point "${value}"`);
  const p = { x: sgfIndex(value[0]!), y: sgfIndex(value[1]!) };
  if (p.x >= size || p.y >= size) throw new Error(`SGF point "${value}" is off a ${size}×${size} board`);
  return p;
}

function sgfIndex(ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 97 ? code - 97 : code - 65 + 26;
}

/** A point or a compressed rectangle "aa:cc". */
function expandPoints(value: string, size: number): Point[] {
  const [from, to] = value.split(":");
  const a = parseSgfPoint(from!, size);
  if (!a) return [];
  const b = to === undefined ? a : parseSgfPoint(to, size);
  if (!b) return [a];
  const out: Point[] = [];
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) out.push({ x, y });
  }
  return out;
}

function formatProp(id: string, values: readonly string[]): string {
  return id + values.map((v) => `[${v.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`).join("");
}

function toMap(comments: SgfComments | undefined): Map<number, string> {
  if (!comments) return new Map();
  if (comments instanceof Map) return new Map(comments);
  return new Map(Object.entries(comments).map(([k, v]) => [Number(k), v as string]));
}

type SgfNode = Map<string, string[]>;

interface SgfTree {
  nodes: SgfNode[];
  children: SgfTree[];
}

/** The nodes of the first game tree, following the first variation at every branch. */
function mainLine(text: string): SgfNode[] {
  const start = text.indexOf("(");
  if (start < 0) throw new Error("Not an SGF file: no game tree found");
  const nodes: SgfNode[] = [];
  for (let tree: SgfTree | undefined = new SgfParser(text, start).tree(); tree; tree = tree.children[0]) {
    nodes.push(...tree.nodes);
  }
  return nodes;
}

class SgfParser {
  constructor(
    private readonly text: string,
    private i: number,
  ) {}

  tree(): SgfTree {
    this.expect("(");
    const tree: SgfTree = { nodes: [], children: [] };
    for (;;) {
      this.skipSpace();
      const ch = this.text[this.i];
      if (ch === ";") {
        this.i++;
        tree.nodes.push(this.node());
      } else if (ch === "(") {
        tree.children.push(this.tree());
      } else if (ch === ")") {
        this.i++;
        return tree;
      } else if (ch === undefined) {
        throw new Error("Unterminated SGF game tree");
      } else {
        throw new Error(`Unexpected character "${ch}" in SGF at offset ${this.i}`);
      }
    }
  }

  private node(): SgfNode {
    const node: SgfNode = new Map();
    for (;;) {
      this.skipSpace();
      const begin = this.i;
      while (/[A-Za-z]/.test(this.text[this.i] ?? "")) this.i++;
      if (this.i === begin) return node;
      // FF[3] allows lowercase letters in identifiers; only the uppercase ones are significant.
      const id = this.text.slice(begin, this.i).replace(/[a-z]/g, "");
      const values: string[] = [];
      this.skipSpace();
      while (this.text[this.i] === "[") {
        values.push(this.value());
        this.skipSpace();
      }
      if (values.length === 0) throw new Error(`SGF property ${id} has no value`);
      node.set(id, [...(node.get(id) ?? []), ...values]);
    }
  }

  private value(): string {
    this.expect("[");
    let value = "";
    for (;;) {
      const ch = this.text[this.i++];
      if (ch === undefined) throw new Error("Unterminated SGF property value");
      if (ch === "]") return value;
      if (ch === "\\") {
        const next = this.text[this.i++];
        if (next === undefined) throw new Error("Unterminated SGF property value");
        // An escaped line break is a soft break and is removed.
        if (next === "\r" && this.text[this.i] === "\n") this.i++;
        if (next !== "\n" && next !== "\r") value += next;
        continue;
      }
      value += ch;
    }
  }

  private expect(ch: string): void {
    if (this.text[this.i] !== ch) throw new Error(`Expected "${ch}" in SGF at offset ${this.i}`);
    this.i++;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.i] ?? "")) this.i++;
  }
}
