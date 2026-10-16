import "./style.css";
import type { ChatMessage, ClientAction, Color, GameView, GameSettings } from "../../src/shared/types.ts";
import { type ConnectionState, type Transport, httpTransport } from "./api.ts";
import { BoardView } from "./board.ts";
import { tryFromGtp } from "../../src/shared/coords.ts";
import {
  canRetry,
  formatLoss,
  humanMoves,
  lastHumanMove,
  lossLevel,
  moveLabel,
  positionBefore,
  secondsLeft,
  sparklinePoints,
} from "./geometry.ts";

const RANKS = [
  ...Array.from({ length: 20 }, (_, i) => `${20 - i}k`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}d`),
];

const $ = <T extends Element = HTMLElement>(id: string): T => {
  const el = document.getElementById(id) as Element | null;
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const el = {
  boardWrap: $("board-wrap"),
  canvas: $<HTMLCanvasElement>("board"),
  variationLabel: $("variation-label"),
  conn: $("conn"),
  turn: $("turn"),
  captures: $("captures"),
  botRank: $("bot-rank"),
  tutorDot: $("tutor-dot"),
  tutorText: $("tutor-text"),
  pass: $<HTMLButtonElement>("pass"),
  hint: $<HTMLButtonElement>("hint"),
  resign: $<HTMLButtonElement>("resign"),
  newGame: $<HTMLFormElement>("new-game"),
  ngSize: $<HTMLSelectElement>("ng-size"),
  ngRank: $<HTMLSelectElement>("ng-rank"),
  ngColor: $<HTMLSelectElement>("ng-color"),
  moment: $("moment"),
  momentTitle: $("moment-title"),
  momentText: $("moment-text"),
  momentCountdown: $("moment-countdown"),
  continueBtn: $<HTMLButtonElement>("continue"),
  retry: $<HTMLButtonElement>("retry"),
  problem: $("problem"),
  problemText: $("problem-text"),
  nextProblem: $<HTMLButtonElement>("next-problem"),
  evalLoss: $("eval-loss"),
  evalDetail: $("eval-detail"),
  spark: $<SVGSVGElement>("spark"),
  chatLog: $<HTMLOListElement>("chat-log"),
  chatForm: $<HTMLFormElement>("chat-form"),
  chatInput: $<HTMLInputElement>("chat-input"),
  resultDialog: $<HTMLDialogElement>("result-dialog"),
  resultTitle: $("result-title"),
  resultText: $("result-text"),
  resultMistakes: $<HTMLUListElement>("result-mistakes"),
  resultNew: $<HTMLButtonElement>("result-new"),
  resultClose: $<HTMLButtonElement>("result-close"),
  toast: $("toast"),
};

const colorName = (c: Color) => (c === "B" ? "Black" : "White");

// --- state ---------------------------------------------------------------

let view: GameView | null = null;
let pending = false;
let shownResultFor: string | null = null;
let renderedChatKey = "";
let ngFormTouched = false;

let transport: Transport = httpTransport;

const board = new BoardView(el.canvas, el.boardWrap);
board.onPlay = (point) => void act({ type: "play", point });

el.ngRank.append(...RANKS.map((r) => new Option(r, r)));
el.ngRank.value = "18k";

// --- actions -------------------------------------------------------------

async function act(action: ClientAction): Promise<void> {
  // Chat never waits; game actions are serialized so a double click can't send two moves.
  const gated = action.type !== "chat";
  if (gated) {
    if (pending) return;
    pending = true;
    render();
  }
  try {
    const res = await transport.send(action);
    if (res.view) setView(res.view);
    if (!res.ok) toast(res.error ?? "Something went wrong.");
  } finally {
    if (gated) {
      pending = false;
      render();
    }
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string): void {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 3500);
}

function setView(v: GameView): void {
  view = v;
  render();
}

/** Whether the board and turn-based controls accept input right now. */
function humanCanMove(v: GameView | null): v is GameView & { settings: GameSettings } {
  return (
    !!v?.settings &&
    v.mode !== "idle" &&
    v.status === "playing" &&
    !v.engineBusy &&
    !pending &&
    v.toPlay === v.settings.humanColor
  );
}

// --- rendering -----------------------------------------------------------

function render(): void {
  const v = view;
  renderBoard(v);
  renderStatus(v);
  renderControls(v);
  renderMoment(v);
  renderProblem(v);
  renderEval(v);
  renderChat(v);
  renderResult(v);
}

function renderBoard(v: GameView | null): void {
  if (!v) return;
  const size = v.board.length;
  const last = v.moves.at(-1);
  const moment = v.moment;
  const bestGtp =
    moment?.state === "fallback" ? v.moves[moment.moveNumber - 1]?.eval?.bestMove : undefined;
  const canMove = humanCanMove(v);
  // A variation that replaces a move is drawn on the board from before that move.
  const fromMove = v.overlay?.variation?.fromMove;
  const before = fromMove !== undefined && v.settings ? positionBefore(v.moves, v.settings, fromMove) : null;
  board.setScene({
    board: before?.board ?? v.board,
    lastMove: before ? before.lastMove : last && "point" in last.move ? last.move.point : null,
    overlay: v.overlay,
    bestMove: bestGtp ? (tryFromGtp(bestGtp, size) ?? null) : null,
    hoverColor: canMove && !before ? v.settings!.humanColor : null,
  });
  el.boardWrap.classList.toggle("locked", !canMove);
  const label = [v.overlay?.variation?.label, before && `position before move ${fromMove}`].filter(Boolean).join(" · ");
  el.variationLabel.hidden = !label;
  el.variationLabel.textContent = label;
}

function renderStatus(v: GameView | null): void {
  if (!v) return;
  const s = v.settings;
  el.turn.textContent = turnText(v);
  el.captures.textContent = `● ${v.captures.B}  ○ ${v.captures.W}`;
  el.captures.title = `Black has captured ${v.captures.B}, White has captured ${v.captures.W}`;
  el.botRank.textContent = s ? s.botRank : "–";
  el.tutorDot.classList.toggle("on", v.tutorAttached);
  el.tutorText.textContent = v.tutorAttached ? "connected" : "offline";
}

function turnText(v: GameView): string {
  const s = v.settings;
  if (v.mode === "idle" || !s) return "Start a new game to begin.";
  if (v.status === "finished") return "Game over.";
  if (v.status === "paused") return "Paused for a teaching moment.";
  if (v.toPlay === s.humanColor) return v.engineBusy ? "Analyzing your position…" : `Your move (${colorName(s.humanColor)}).`;
  return "Bot is thinking…";
}

function renderControls(v: GameView | null): void {
  const canMove = humanCanMove(v);
  const inGame = !!v?.settings && v.mode === "game" && v.status !== "finished";
  el.pass.disabled = !canMove;
  // Hints are for the human's move, not while paused or while the bot is to move.
  el.hint.disabled = !inGame || pending || v.status !== "playing" || v.toPlay !== v.settings!.humanColor;
  el.resign.disabled = !inGame || pending;
  el.chatInput.disabled = !v;

  // Keep the new-game form in sync with the current game unless the user is editing it.
  if (v?.settings && !ngFormTouched) {
    el.ngSize.value = String(v.settings.size);
    el.ngRank.value = v.settings.botRank;
    el.ngColor.value = v.settings.humanColor;
  }
}

let countdownTimer: ReturnType<typeof setInterval> | undefined;

function renderMoment(v: GameView | null): void {
  const m = v?.moment;
  const show = !!v && !!m && m.state !== "resolved" && v.status !== "finished";
  el.moment.hidden = !show;
  clearInterval(countdownTimer);
  if (!show || !v || !m) return;

  const record = v.moves[m.moveNumber - 1];
  const size = v.board.length;
  const played = record ? moveLabel(record, size) : `move ${m.moveNumber}`;
  const best = record?.eval?.bestMove;
  el.moment.classList.toggle("fallback", m.state === "fallback");
  el.momentTitle.textContent = `Move ${m.moveNumber}: ${played} lost ${m.pointLoss.toFixed(1)} points`;

  const retryable = canRetry(v);
  if (m.state === "waiting") {
    el.momentText.textContent = v.tutorAttached
      ? "Take a look at the position. Your tutor is on the way."
      : "Take a look at the position before KataGo shows its answer.";
    const tick = () => {
      el.momentCountdown.textContent =
        m.deadline !== undefined ? `${secondsLeft(m.deadline, Date.now())}s` : "";
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  } else {
    el.momentCountdown.textContent = "";
    el.momentText.textContent =
      m.state === "tutor"
        ? m.moveNumber > v.moves.length
          ? "Your tutor took this move back. Find a better one."
          : "Your tutor is discussing this move in the chat."
        : best
          ? `KataGo preferred ${best}. The highlighted line shows how it continues.`
          : "KataGo's suggestion is shown on the board.";
  }

  el.continueBtn.disabled = pending || v.status !== "paused";
  // After a rethink the move is already taken back; the server would refuse another Try again.
  el.retry.hidden = !retryable;
  el.retry.disabled = pending || !retryable;
}

function renderProblem(v: GameView | null): void {
  const p = v?.mode === "problem" ? v.problem : null;
  el.problem.hidden = !p;
  if (!p) return;
  el.problemText.textContent = p.solved
    ? `Solved! ${p.prompt}`
    : `${p.prompt}${p.attempts ? ` (attempts: ${p.attempts})` : ""}`;
  el.nextProblem.disabled = pending;
}

function renderEval(v: GameView | null): void {
  const human = v?.settings?.humanColor;
  if (!v || !human) {
    el.evalLoss.textContent = "–";
    el.evalLoss.className = "loss";
    el.evalDetail.textContent = "No moves yet.";
    el.spark.replaceChildren();
    return;
  }
  const size = v.board.length;
  const last = lastHumanMove(v.moves, human);
  if (!last) {
    el.evalLoss.textContent = "–";
    el.evalLoss.className = "loss";
    el.evalDetail.textContent = "No moves yet.";
  } else if (!last.eval) {
    el.evalLoss.textContent = "…";
    el.evalLoss.className = "loss";
    el.evalDetail.textContent = `Move ${last.number} · ${moveLabel(last, size)} · analyzing`;
  } else {
    const e = last.eval;
    el.evalLoss.textContent = `${formatLoss(e.pointLoss)} pts`;
    el.evalLoss.className = `loss ${lossLevel(e.pointLoss)}`;
    const best = e.pointLoss >= 0.05 && e.bestMove !== moveLabel(last, size) ? ` · best ${e.bestMove}` : "";
    el.evalDetail.textContent = `Move ${last.number} · ${moveLabel(last, size)}${best} · win ${Math.round(e.winrateAfter * 100)}%`;
  }
  renderSparkline(humanMoves(v.moves, human).flatMap((m) => (m.eval ? [m.eval.pointLoss] : [])));
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderSparkline(losses: number[]): void {
  const W = 300;
  const H = 44;
  const pts = sparklinePoints(losses, W, H);
  const nodes: SVGElement[] = [];
  const base = document.createElementNS(SVG_NS, "line");
  base.setAttribute("class", "base");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", String(W));
  base.setAttribute("y1", "3");
  base.setAttribute("y2", "3");
  nodes.push(base);
  if (pts.length > 1) {
    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("class", "line");
    line.setAttribute("points", pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    nodes.push(line);
  }
  // The viewBox stretches horizontally, so dots are tall rounded rects that render roughly round.
  pts.forEach((p, i) => {
    const dot = document.createElementNS(SVG_NS, "rect");
    dot.setAttribute("class", lossLevel(losses[i]!));
    dot.setAttribute("x", (p.x - 1.5).toFixed(1));
    dot.setAttribute("y", (p.y - 2.5).toFixed(1));
    dot.setAttribute("width", "3");
    dot.setAttribute("height", "5");
    dot.setAttribute("rx", "1.5");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${formatLoss(losses[i]!)} pts`;
    dot.append(title);
    nodes.push(dot);
  });
  el.spark.replaceChildren(...nodes);
}

function renderChat(v: GameView | null): void {
  const chat = v?.chat ?? [];
  const key = `${chat.length}|${chat.at(-1)?.id ?? ""}|${chat.length === 0 && !!v?.tutorAttached}`;
  if (key === renderedChatKey) return;
  renderedChatKey = key;

  const log = el.chatLog;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (chat.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = v?.tutorAttached
      ? "Your tutor is here. Ask anything about the game."
      : "Messages from your tutor and KataGo appear here.";
    log.replaceChildren(li);
    return;
  }
  log.replaceChildren(...chat.map(chatItem));
  if (nearBottom || chat.at(-1)?.from === "user") log.scrollTop = log.scrollHeight;
}

function chatItem(m: ChatMessage): HTMLLIElement {
  const li = document.createElement("li");
  li.className = m.from;
  li.textContent = m.text;
  li.title = new Date(m.ts).toLocaleTimeString();
  return li;
}

function renderResult(v: GameView | null): void {
  if (!v || v.status !== "finished" || !v.result || !v.gameId) return;
  if (shownResultFor === v.gameId) return;
  shownResultFor = v.gameId;

  const r = v.result;
  const human = v.settings?.humanColor;
  const won = r.winner !== null && r.winner === human;
  el.resultTitle.textContent = r.winner === null ? "Draw" : won ? "You won" : "You lost";
  const margin = Math.abs(r.margin).toFixed(1);
  el.resultText.textContent =
    r.winner === null
      ? "The game ended in a draw."
      : r.reason === "resign"
        ? `${colorName(r.winner)} wins by resignation.`
        : r.reason === "abandon"
          ? `${colorName(r.winner)} wins; the game was abandoned.`
          : `${colorName(r.winner)} wins by ${margin} points.`;

  const size = v.board.length;
  const mistakes = human
    ? humanMoves(v.moves, human)
        .filter((m) => m.eval && lossLevel(m.eval.pointLoss) === "mistake")
        .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
        .slice(0, 3)
    : [];
  el.resultMistakes.replaceChildren(
    ...mistakes.map((m) => {
      const li = document.createElement("li");
      li.textContent = `Move ${m.number} (${moveLabel(m, size)}): ${formatLoss(m.eval!.pointLoss)} pts, best ${m.eval!.bestMove}`;
      return li;
    }),
  );
  if (!el.resultDialog.open) el.resultDialog.showModal();
}

// --- wiring --------------------------------------------------------------

el.pass.addEventListener("click", () => void act({ type: "pass" }));
el.hint.addEventListener("click", () => void act({ type: "ask_tutor" }));
el.continueBtn.addEventListener("click", () => void act({ type: "continue" }));
el.retry.addEventListener("click", () => void act({ type: "retry" }));
el.nextProblem.addEventListener("click", () => void act({ type: "next_problem" }));

// Resign needs a second click within a few seconds.
let resignTimer: ReturnType<typeof setTimeout> | undefined;
el.resign.addEventListener("click", () => {
  if (el.resign.classList.contains("armed")) {
    disarmResign();
    void act({ type: "resign" });
    return;
  }
  el.resign.classList.add("armed");
  el.resign.textContent = "Confirm resign";
  resignTimer = setTimeout(disarmResign, 3000);
});
function disarmResign(): void {
  clearTimeout(resignTimer);
  el.resign.classList.remove("armed");
  el.resign.textContent = "Resign";
}

for (const s of [el.ngSize, el.ngRank, el.ngColor]) {
  s.addEventListener("change", () => (ngFormTouched = true));
}
function startNewGame(): void {
  ngFormTouched = false;
  el.resultDialog.close();
  void act({
    type: "new_game",
    settings: {
      size: Number(el.ngSize.value) as GameSettings["size"],
      botRank: el.ngRank.value,
      humanColor: el.ngColor.value as Color,
    },
  });
}
el.newGame.addEventListener("submit", (e) => {
  e.preventDefault();
  startNewGame();
});
el.resultNew.addEventListener("click", startNewGame);
el.resultClose.addEventListener("click", () => el.resultDialog.close());

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  el.chatInput.value = "";
  void act({ type: "chat", text });
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, dialog") || el.resultDialog.open) return;
  const key = e.key.toLowerCase();
  if (key === "p" && !el.pass.disabled) {
    e.preventDefault();
    void act({ type: "pass" });
  } else if (key === "h" && !el.hint.disabled) {
    e.preventDefault();
    void act({ type: "ask_tutor" });
  } else if (e.key === "Enter" && view?.status === "paused" && !el.moment.hidden && !el.continueBtn.disabled) {
    // Don't steal Enter from a focused button.
    if (target?.closest("button")) return;
    e.preventDefault();
    void act({ type: "continue" });
  }
});

function onConnection(s: ConnectionState): void {
  el.conn.hidden = s !== "reconnecting";
}

async function start(): Promise<void> {
  if (new URLSearchParams(location.search).has("mock")) {
    transport = (await import("./mock.ts")).createMockTransport();
  }
  transport.subscribe(setView, onConnection);
  transport.getState().then(setView, () => {
    if (!view) el.turn.textContent = "Can't reach the server. Retrying…";
  });
}

render();
void start();
