import "./style.css";
import type { ChatMessage, ClientAction, Color, GameView, GameSettings, ProfileResponse } from "../../src/shared/types.ts";
import { ratingToRank } from "../../src/shared/rank.ts";
import { categoryLabel, colorName, formatScore } from "../../src/shared/text.ts";
import { type ConnectionState, type Transport, httpTransport } from "./api.ts";
import { BoardView } from "./board.ts";
import { moveGtp, movePoint, tryFromGtp } from "../../src/shared/coords.ts";
import {
  attemptsLeftText,
  formatLoss,
  humanMoves,
  lastHumanMove,
  lossLevel,
  nextBotText,
  positionBefore,
  problemHeading,
  problemResult,
  ratingChangeFor,
  ratingSparkPoints,
  secondsLeft,
  sparklinePoints,
  topCategories,
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
  practice: $<HTMLButtonElement>("practice"),
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
  problemTitle: $("problem-title"),
  problemAttempts: $("problem-attempts"),
  problemText: $("problem-text"),
  problemResult: $("problem-result"),
  nextProblem: $<HTMLButtonElement>("next-problem"),
  leaveProblem: $<HTMLButtonElement>("leave-problem"),
  evalCard: $("eval"),
  evalLoss: $("eval-loss"),
  evalDetail: $("eval-detail"),
  spark: $<SVGSVGElement>("spark"),
  chatLog: $<HTMLOListElement>("chat-log"),
  chatForm: $<HTMLFormElement>("chat-form"),
  chatInput: $<HTMLInputElement>("chat-input"),
  progress: $("progress"),
  prRank: $("pr-rank"),
  prBot: $("pr-bot"),
  prGames: $("pr-games"),
  prCats: $("pr-cats"),
  prSpark: $<SVGSVGElement>("pr-spark"),
  resultRating: $("result-rating"),
  resultDialog: $<HTMLDialogElement>("result-dialog"),
  resultTitle: $("result-title"),
  resultText: $("result-text"),
  resultMistakes: $<HTMLUListElement>("result-mistakes"),
  resultNew: $<HTMLButtonElement>("result-new"),
  resultClose: $<HTMLButtonElement>("result-close"),
  toast: $("toast"),
};

// --- state ---------------------------------------------------------------

let view: GameView | null = null;
/** The last stream frame's text, so an identical frame isn't rendered again (compared as sent, not re-serialized). */
let lastFrame: string | undefined;
let pending = false;
let shownResultFor: string | null = null;
let renderedChatKey = "";
let ngFormTouched = false;
let profile: ProfileResponse | null = null;
/** The view's profileVersion that `profile` was fetched for, and the one last asked for. */
let profileVersion: number | null = null;
let profileRequested: number | null = null;
/** The board before a variation's `fromMove`, for the game and move count it was built from. */
let beforeCache: { key: string; value: ReturnType<typeof positionBefore> } | null = null;

let transport: Transport = httpTransport;

const board = new BoardView(el.canvas, el.boardWrap);
board.onPlay = (point) => void act({ type: "play", point });

/** "auto" leaves the bot rank (and any handicap) to the learner's profile. */
const AUTO_RANK = "auto";
el.ngRank.append(new Option("Auto", AUTO_RANK), ...RANKS.map((r) => new Option(r, r)));
el.ngRank.value = AUTO_RANK;

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

/** `raw` is the stream frame the view came in; an action's response has none and always renders. */
function setView(v: GameView, raw?: string): void {
  // The server sends a frame per change, and some changes leave the view as it was.
  if (raw !== undefined && raw === lastFrame) return;
  lastFrame = raw;
  view = v;
  // The profile changed (a game or problem ended, a tag): fetch it again.
  if (v.profileVersion !== profileRequested) {
    profileRequested = v.profileVersion;
    void refreshProfile(v.profileVersion);
  }
  render();
}

async function refreshProfile(version: number): Promise<void> {
  const p = await transport.getProfile();
  if (!p || version !== profileRequested) return; // a newer change is being fetched
  profile = p;
  profileVersion = version;
  render();
}

/** Whether the server takes this action now (the view lists them) and no other action is on its way. */
function can(v: GameView | null, action: ClientAction["type"]): v is GameView {
  return !!v && !pending && v.allowed.includes(action);
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
  renderProgress();
  renderResult(v);
  renderResultRating();
}

/** The board before move `fromMove`, memoized: it only changes with the game, its moves and the move. */
function boardBefore(v: GameView, settings: GameSettings, fromMove: number): ReturnType<typeof positionBefore> {
  const key = `${v.gameId}|${v.moves.length}|${fromMove}`;
  if (beforeCache?.key !== key) beforeCache = { key, value: positionBefore(v.moves, settings, fromMove) };
  return beforeCache.value;
}

function renderBoard(v: GameView | null): void {
  if (!v) return;
  const size = v.board.length;
  const last = v.moves.at(-1);
  const moment = v.moment;
  const bestGtp =
    moment?.state === "fallback" ? v.moves[moment.moveNumber - 1]?.eval?.bestMove : undefined;
  const canMove = can(v, "play") && !!v.settings;
  // A variation that replaces a move is drawn on the board from before that move.
  const fromMove = v.overlay?.variation?.fromMove;
  const before = fromMove !== undefined && v.settings ? boardBefore(v, v.settings, fromMove) : null;
  board.setScene({
    board: before?.board ?? v.board,
    lastMove: before ? before.lastMove : movePoint(last?.move),
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
  el.botRank.textContent = s && v.mode === "game" ? s.botRank : "–";
  el.tutorDot.classList.toggle("on", v.tutorAttached);
  el.tutorText.textContent = v.tutorAttached ? "connected" : "offline";
}

function turnText(v: GameView): string {
  const s = v.settings;
  const p = v.problem;
  if (v.mode === "problem" && p) {
    if (p.revealed) return p.solved ? "Problem solved." : "Here's the answer.";
    return v.engineBusy ? "Checking your move…" : `Problem: ${colorName(p.toPlay)} to play.`;
  }
  if (v.mode === "idle" || !s) return "Start a new game to begin.";
  if (v.status === "finished") return "Game over.";
  if (v.status === "paused") return "Paused for a teaching moment.";
  if (v.toPlay === s.humanColor) return v.engineBusy ? "Analyzing your position…" : `Your move (${colorName(s.humanColor)}).`;
  return "Bot is thinking…";
}

function renderControls(v: GameView | null): void {
  el.pass.disabled = !can(v, "pass");
  // Hints are for the human's move, not while paused or while the bot is to move.
  el.hint.disabled = !can(v, "ask_tutor");
  el.resign.disabled = !can(v, "resign");
  el.practice.disabled = !can(v, "next_problem") || v.mode === "problem";
  el.chatInput.disabled = !v;

  // Keep the new-game form in sync with the current game unless the user is editing it.
  if (v?.settings && v.mode === "game" && !ngFormTouched) {
    el.ngSize.value = String(v.settings.size);
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
  const played = record ? moveGtp(record.move, size) : `move ${m.moveNumber}`;
  const best = record?.eval?.bestMove;
  el.moment.classList.toggle("fallback", m.state === "fallback");
  el.momentTitle.textContent = `Move ${m.moveNumber}: ${played} lost ${m.pointLoss.toFixed(1)} points`;

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

  el.continueBtn.disabled = !can(v, "continue");
  // After a rethink the move is already taken back; the server would refuse another Try again.
  el.retry.hidden = !v.allowed.includes("retry");
  el.retry.disabled = !can(v, "retry");
}

function renderProblem(v: GameView | null): void {
  const p = v?.mode === "problem" ? v.problem : null;
  el.problem.hidden = !p;
  if (!p) return;
  el.problemTitle.textContent = problemHeading(p);
  el.problemAttempts.textContent = attemptsLeftText(p);
  el.problemText.textContent = p.prompt;
  const result = problemResult(p);
  el.problemResult.hidden = !result;
  el.problemResult.className = `problem-result ${result?.tone ?? ""}`;
  el.problemResult.textContent = result?.text ?? "";
  el.nextProblem.disabled = !can(v, "next_problem");
  el.leaveProblem.disabled = !can(v, "leave_problem");
}

/** The eval strip before there is a human move to show. */
function clearEval(): void {
  el.evalLoss.textContent = "–";
  el.evalLoss.className = "loss";
  el.evalDetail.textContent = "No moves yet.";
}

function renderEval(v: GameView | null): void {
  // The eval strip is about the game's moves; a problem has its own card.
  el.evalCard.hidden = v?.mode === "problem";
  const human = v?.settings?.humanColor;
  if (!v || !human) {
    clearEval();
    el.spark.replaceChildren();
    return;
  }
  const size = v.board.length;
  const last = lastHumanMove(v.moves, human);
  if (!last) {
    clearEval();
  } else if (!last.eval) {
    el.evalLoss.textContent = "…";
    el.evalLoss.className = "loss";
    el.evalDetail.textContent = `Move ${last.number} · ${moveGtp(last.move, size)} · analyzing`;
  } else {
    const e = last.eval;
    const played = moveGtp(last.move, size);
    el.evalLoss.textContent = `${formatLoss(e.pointLoss)} pts`;
    el.evalLoss.className = `loss ${lossLevel(e.pointLoss)}`;
    const best = e.pointLoss >= 0.05 && e.bestMove !== played ? ` · best ${e.bestMove}` : "";
    el.evalDetail.textContent = `Move ${last.number} · ${played}${best} · win ${Math.round(e.winrateAfter * 100)}%`;
  }
  const losses = humanMoves(v.moves, human).flatMap((m) => (m.eval ? [m.eval.pointLoss] : []));
  const base = svg("line", { class: "base", x1: "0", x2: "300", y1: "3", y2: "3" });
  sparkline(el.spark, sparklinePoints(losses, 300, 44), losses.map((l) => ({ class: lossLevel(l), title: `${formatLoss(l)} pts` })), [base]);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * A sparkline in `target`: a polyline through `pts` and a dot with a tooltip for each of `dots`
 * (matched to the last points). The viewBox stretches horizontally, so dots are tall rounded rects
 * that render roughly round.
 */
function sparkline(target: SVGSVGElement, pts: { x: number; y: number }[], dots: { class: string; title: string }[], before: SVGElement[] = []): void {
  const nodes = [...before];
  if (pts.length > 1) nodes.push(svg("polyline", { class: "line", points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") }));
  pts.slice(pts.length - dots.length).forEach((p, i) => {
    const dot = svg("rect", { class: dots[i]!.class, x: (p.x - 1.5).toFixed(1), y: (p.y - 2.5).toFixed(1), width: "3", height: "5", rx: "1.5" });
    const title = svg("title", {});
    title.textContent = dots[i]!.title;
    dot.append(title);
    nodes.push(dot);
  });
  target.replaceChildren(...nodes);
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

function renderProgress(): void {
  const p = profile?.profile;
  el.progress.hidden = !p;
  const auto = el.ngRank.options[0];
  if (auto) auto.text = p ? `Auto (${nextBotText(p)})` : "Auto";
  if (!p) return;
  el.prRank.textContent = ratingToRank(p.rating);
  el.prRank.title = `Estimated rank (rating ${p.rating.toFixed(1)})`;
  el.prBot.textContent = nextBotText(p);
  el.prGames.textContent = String(p.gamesPlayed);
  const cats = topCategories(p.mistakeCounts);
  el.prCats.textContent = cats.length ? cats.join(", ") : "–";
  el.prCats.title = profile?.focus ? `Suggested focus: ${categoryLabel(profile.focus.category)}. ${profile.focus.reason}` : "";
  // Start from the rating before the first shown game, so one game already draws a line.
  const history = p.ratingHistory.slice(-20);
  const first = history[0];
  const values = first ? [first.rating - (first.delta ?? 0), ...history.map((h) => h.rating)] : [];
  const dots = history.map((h) => ({
    class: h.won ? "dot-won" : "dot-lost",
    title: `${h.won ? "Won" : "Lost"} vs ${h.botRank}: ${ratingToRank(h.rating)} (${h.rating.toFixed(1)})`,
  }));
  sparkline(el.prSpark, ratingSparkPoints(values, 300, 32), dots);
}

/** The result dialog's rating line, once the profile the finished game changed has arrived. */
function renderResultRating(): void {
  const gameId = shownResultFor;
  const p = profile?.profile;
  if (!gameId || !p || profileVersion !== view?.profileVersion) {
    el.resultRating.hidden = true;
    return;
  }
  const change = ratingChangeFor(p, gameId);
  el.resultRating.hidden = false;
  if (!change) {
    el.resultRating.textContent = "Rating unchanged: games under 10 moves don't count.";
    return;
  }
  const delta = document.createElement("span");
  delta.className = change.delta > 0 ? "up" : change.delta < 0 ? "down" : "";
  delta.textContent = `${change.delta >= 0 ? "+" : "−"}${Math.abs(change.delta).toFixed(1)}`;
  const rank = change.before === change.after ? `rank ${change.after}` : `rank ${change.before} → ${change.after}`;
  el.resultRating.replaceChildren("Rating ", delta, ` (${rank}). Next bot: ${nextBotText(p)}.`);
}

function renderResult(v: GameView | null): void {
  if (!v || v.status !== "finished" || !v.result || !v.gameId) return;
  if (shownResultFor === v.gameId) return;
  shownResultFor = v.gameId;

  const r = v.result;
  const human = v.settings?.humanColor;
  const won = r.winner !== null && r.winner === human;
  el.resultTitle.textContent = r.winner === null ? "Draw" : won ? "You won" : "You lost";
  el.resultText.textContent = r.winner === null ? "The game ended in a draw." : `${formatScore(r)}.`;

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
      li.textContent = `Move ${m.number} (${moveGtp(m.move, size)}): ${formatLoss(m.eval!.pointLoss)} pts, best ${m.eval!.bestMove}`;
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
el.practice.addEventListener("click", () => void act({ type: "next_problem" }));
el.leaveProblem.addEventListener("click", () => void act({ type: "leave_problem" }));

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
  const rank = el.ngRank.value;
  void act({
    type: "new_game",
    settings: {
      size: Number(el.ngSize.value) as GameSettings["size"],
      ...(rank !== AUTO_RANK && { botRank: rank }),
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
  } else if (e.key === "Enter" && can(view, "continue") && !el.moment.hidden) {
    // Don't steal Enter from a focused button.
    if (target?.closest("button")) return;
    e.preventDefault();
    void act({ type: "continue" });
  }
});

function onConnection(s: ConnectionState): void {
  el.conn.hidden = s !== "reconnecting";
  if (s === "reconnecting" && !view) el.turn.textContent = "Can't reach the server. Retrying…";
}

async function start(): Promise<void> {
  if (new URLSearchParams(location.search).has("mock")) {
    transport = (await import("./mock.ts")).createMockTransport();
  }
  // The stream's first frame is the current view; setView fetches the profile for it.
  transport.subscribe(setView, onConnection);
}

render();
void start();
