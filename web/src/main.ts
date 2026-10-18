import "./style.css";
import {
  JUDGE_MODES,
  TUTOR_LEVELS,
  type ChatMessage,
  type ClientAction,
  type Color,
  type GameView,
  type GameSettings,
  type JudgeMode,
  type ProfileResponse,
  type TutorLevel,
} from "../../src/shared/types.ts";
import { atLevelOf, judgedLoss } from "../../src/shared/judge.ts";
import { ratingToRank } from "../../src/shared/rank.ts";
import { JUDGE_MODE_TEXT, TUTOR_LEVEL_TEXT, categoryLabel, colorName, formatScore, rankEstimateText, secondsUntil } from "../../src/shared/text.ts";
import { type ConnectionState, type Transport, httpTransport } from "./api.ts";
import { BoardView } from "./board.ts";
import { readCollapsed, writeCollapsed } from "./collapse.ts";
import { gtpLine, moveGtp, movePoint } from "../../src/shared/coords.ts";
import {
  attemptsLeftText,
  formatLoss,
  humanMoves,
  lastHumanMove,
  latestEstimate,
  lossLevel,
  nextBotText,
  positionBefore,
  generationFact,
  problemHeading,
  problemResult,
  ratingChangeFor,
  ratingSparkPoints,
  recentMoveLabels,
  sparklinePoints,
  thresholdFact,
  topCategories,
} from "./geometry.ts";
import { thresholdFor } from "../../src/shared/threshold.ts";

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
  captionRow: $("caption-row"),
  hideOverlay: $<HTMLButtonElement>("hide-overlay"),
  levelOptions: $("level-options"),
  levelDesc: $("level-desc"),
  levelSummary: $("level-summary"),
  judgeOptions: $("judge-options"),
  judgeDesc: $("judge-desc"),
  conn: $("conn"),
  turn: $("turn"),
  captures: $("captures"),
  botRank: $("bot-rank"),
  tutorDot: $("tutor-dot"),
  tutorText: $("tutor-text"),
  pass: $<HTMLButtonElement>("pass"),
  takeBack: $<HTMLButtonElement>("take-back"),
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
  prEstimate: $("pr-estimate"),
  prBot: $("pr-bot"),
  prGames: $("pr-games"),
  prCats: $("pr-cats"),
  prThreshold: $("pr-threshold"),
  prProblemsRow: $("pr-problems-row"),
  prProblems: $("pr-problems"),
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
  renderLevels(v);
  renderMoment(v);
  renderProblem(v);
  renderEval(v);
  renderChat(v);
  renderProgress();
  renderResult(v);
  renderResultRating();
}

/** The board before move `fromMove`, memoized by the moves that lead to it (a take-back and a different replay change it, not just the count) and whether the move is on the board at all. */
function boardBefore(v: GameView, settings: GameSettings, fromMove: number): ReturnType<typeof positionBefore> {
  const key = `${v.gameId}|${fromMove}|${fromMove <= v.moves.length}|${gtpLine(v.moves.slice(0, fromMove - 1), settings.size).join(" ")}`;
  if (beforeCache?.key !== key) beforeCache = { key, value: positionBefore(v.moves, settings, fromMove) };
  return beforeCache.value;
}

function renderBoard(v: GameView | null): void {
  if (!v) return;
  const last = v.moves.at(-1);
  const canMove = can(v, "play") && !!v.settings;
  // A variation that replaces a move is drawn on the board from before that move.
  const fromMove = v.overlay?.variation?.fromMove;
  const before = fromMove !== undefined && v.settings ? boardBefore(v, v.settings, fromMove) : null;
  board.setScene({
    board: before?.board ?? v.board,
    lastMove: before ? before.lastMove : movePoint(last?.move),
    overlay: v.overlay,
    // Only what the drawing holds: KataGo's highlighted move goes when the drawing is hidden or cleared.
    bestMove: v.overlay?.best ?? null,
    recentLabels: recentMoveLabels(v),
    hoverColor: canMove && !before ? v.settings!.humanColor : null,
  });
  el.boardWrap.classList.toggle("locked", !canMove);
  const label = [v.overlay?.variation?.label, before && `position before move ${fromMove}`].filter(Boolean).join(" · ");
  el.variationLabel.textContent = label;
  // Any drawing gets a Hide button (Esc too); it stays until the learner moves on or hides it.
  el.captionRow.hidden = !v.overlay;
  el.hideOverlay.disabled = !can(v, "clear_overlay");
}

/**
 * A segmented control: one radio per option in `container`, labeled from the shared wording, that
 * sends `pick(option)` when chosen. Built once.
 */
function radioGroup<T extends string>(
  options: readonly T[],
  name: string,
  text: Record<T, { label: string; learner: string }>,
  container: HTMLElement,
  pick: (option: T) => ClientAction,
): HTMLInputElement[] {
  return options.map((option) => {
    const label = document.createElement("label");
    label.title = text[option].learner;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = option;
    const span = document.createElement("span");
    span.textContent = text[option].label;
    label.append(input, span);
    container.append(label);
    input.addEventListener("change", () => {
      if (input.checked) void act(pick(option));
    });
    return input;
  });
}

const levelInputs = radioGroup(TUTOR_LEVELS, "tutor-level", TUTOR_LEVEL_TEXT, el.levelOptions, (level) => ({ type: "set_tutor_level", level }));
const judgeInputs = radioGroup(JUDGE_MODES, "judge-mode", JUDGE_MODE_TEXT, el.judgeOptions, (mode) => ({ type: "set_judge_mode", mode }));

/** Check the radio for `value` and enable the group when the server takes `action`. */
function renderRadios(inputs: HTMLInputElement[], value: string, v: GameView | null, action: ClientAction["type"]): void {
  for (const input of inputs) {
    // While a change is on its way, keep the learner's pick rather than flicker back to the old one.
    if (!pending) input.checked = input.value === value;
    input.disabled = !can(v, action);
  }
}

function renderLevels(v: GameView | null): void {
  const level: TutorLevel = v?.tutorLevel ?? "coach";
  const judge: JudgeMode = v?.judgeMode ?? "optimal";
  renderRadios(levelInputs, level, v, "set_tutor_level");
  renderRadios(judgeInputs, judge, v, "set_judge_mode");
  el.levelDesc.textContent = TUTOR_LEVEL_TEXT[level].learner;
  const rank = judge === "at_level" && v?.atLevelRank ? ` This game: ${v.atLevelRank}.` : "";
  el.judgeDesc.textContent = `${JUDGE_MODE_TEXT[judge].learner}${rank}`;
  el.levelSummary.textContent = `Tutor: ${TUTOR_LEVEL_TEXT[level].label} · Judge: ${JUDGE_MODE_TEXT[judge].label}`;
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
  if (v.result) return "You resigned. KataGo is finishing its verdict on your last move…";
  if (v.status === "paused") return "Paused for a teaching moment.";
  if (v.toPlay === s.humanColor) return v.engineBusy ? "Analyzing your position…" : `Your move (${colorName(s.humanColor)}).`;
  return "Bot is thinking…";
}

function renderControls(v: GameView | null): void {
  el.pass.disabled = !can(v, "pass");
  // Take back: the learner's last move (and the bot's reply), on their turn or in a pause.
  el.takeBack.disabled = !can(v, "take_back");
  // Hints are for the human's move, not while paused or while the bot is to move.
  el.hint.disabled = !can(v, "ask_tutor");
  el.resign.disabled = !can(v, "resign");
  el.practice.disabled = !can(v, "next_problem") || v.mode === "problem";
  const generating = v?.generation?.current;
  el.practice.title = generating
    ? `Practice problems: from your mistakes, and generated at your level (generating ${generating.found}/${generating.target})`
    : "Practice problems: from your mistakes, and generated at your level";
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
  const atLevel = record && atLevelOf(record);
  const best = record?.eval?.bestMove;
  el.moment.classList.toggle("fallback", m.state === "fallback");
  el.moment.classList.toggle("awaiting", !!m.awaitingLearner);
  const against = atLevel ? ` vs a ${atLevel.rank}'s ${atLevel.move}` : "";
  el.momentTitle.textContent = `Move ${m.moveNumber}: ${played} lost ${m.pointLoss.toFixed(1)} points${against}`;

  if (m.state === "waiting") {
    el.momentText.textContent = v.tutorAttached
      ? "Take a look at the position. Your tutor is on the way."
      : "Take a look at the position before KataGo shows its answer.";
    const tick = () => {
      el.momentCountdown.textContent =
        m.deadline !== undefined ? `${secondsUntil(m.deadline, Date.now())}s` : "";
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  } else {
    el.momentCountdown.textContent = "";
    el.momentText.textContent = m.awaitingLearner
      ? "Your tutor is done — take your time, then press Continue."
      : m.state === "tutor"
        ? m.moveNumber > v.moves.length
          ? "Your tutor took this move back. Find a better one."
          : "Your tutor is discussing this move in the chat."
        : atLevel
          ? `A ${atLevel.rank} player would most likely play ${atLevel.move}. The highlighted line shows how it continues.`
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
  if (!p || !v) return;
  el.problemTitle.textContent = problemHeading(p, v.board.length);
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
  el.evalLoss.className = "loss card-summary";
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
  const level = (loss: number) => lossLevel(loss, v.mistakeThreshold, v.settings!.size);
  const last = lastHumanMove(v.moves, human);
  if (!last) {
    clearEval();
  } else if (!last.eval) {
    el.evalLoss.textContent = "…";
    el.evalLoss.className = "loss card-summary";
    el.evalDetail.textContent = `Move ${last.number} · ${moveGtp(last.move, size)} · analyzing`;
  } else {
    const e = last.eval;
    const played = moveGtp(last.move, size);
    // Judged at level, the score is against the reference move, and beating it shows as a gain.
    const atLevel = atLevelOf(last);
    const loss = judgedLoss(last)!;
    const gain = atLevel && atLevel.loss <= -0.05 ? -atLevel.loss : 0;
    el.evalLoss.textContent = gain ? `+${gain.toFixed(1)} pts` : `${formatLoss(loss)} pts`;
    el.evalLoss.className = `loss card-summary ${gain ? "good" : level(loss)}`;
    const best = atLevel
      ? atLevel.move === played
        ? ` · a ${atLevel.rank}'s move`
        : ` · vs ${atLevel.rank} ${atLevel.move}`
      : e.pointLoss >= 0.05 && e.bestMove !== played
        ? ` · best ${e.bestMove}`
        : "";
    el.evalDetail.textContent = `Move ${last.number} · ${played}${best} · win ${Math.round(e.winrateAfter * 100)}%`;
  }
  const losses = humanMoves(v.moves, human).flatMap((m) => {
    const loss = judgedLoss(m);
    return loss === undefined ? [] : [loss];
  });
  const base = svg("line", { class: "base", x1: "0", x2: "300", y1: "3", y2: "3" });
  sparkline(el.spark, sparklinePoints(losses, 300, 44), losses.map((l) => ({ class: level(l), title: `${formatLoss(l)} pts` })), [base]);
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
  el.prRank.title = `Estimated rank (rating ${p.rating.toFixed(1)}), mostly from how your own moves compare with players of each rank`;
  const estimate = latestEstimate(p);
  el.prEstimate.textContent = p.estimating?.length ? "estimating…" : (estimate?.short ?? "–");
  el.prEstimate.title = estimate?.long ?? "Your rank estimated from the moves you play without help, after each game of 10+ moves.";
  el.prBot.textContent = nextBotText(p);
  el.prGames.textContent = String(p.gamesPlayed);
  const cats = topCategories(p.mistakeCounts);
  el.prCats.textContent = cats.length ? cats.join(", ") : "–";
  // In a game (also once it's over), the threshold it is played with, as the eval colors use it;
  // otherwise the next game's, on the board size picked in the new-game form.
  const game = view?.mode === "game" && view.settings ? { size: view.settings.size, points: view.mistakeThreshold } : null;
  const size = game?.size ?? (Number(el.ngSize.value) as GameSettings["size"]);
  const fact = thresholdFact(game?.points ?? thresholdFor(p.mistakeThreshold, size), size, p.mistakeThreshold);
  el.prThreshold.textContent = fact.short;
  el.prThreshold.title = fact.long;
  // Problem generation comes with every view, so the count moves as problems are found.
  const generation = generationFact(view?.generation);
  el.prProblemsRow.hidden = !generation;
  el.prProblems.textContent = generation?.short ?? "–";
  el.prProblemsRow.title = generation?.long ?? "";
  el.prCats.title = profile?.focus ? `Suggested focus: ${categoryLabel(profile.focus.category)}. ${profile.focus.reason}` : "";
  // Start from the rating before the first shown game, so one game already draws a line.
  const history = p.ratingHistory.slice(-20);
  const first = history[0];
  const values = first ? [first.rating - (first.delta ?? 0), ...history.map((h) => h.rating)] : [];
  const dots = history.map((h) => ({
    class: h.won ? "dot-won" : "dot-lost",
    title: `${h.won ? "Won" : "Lost"} vs ${h.botRank}: ${ratingToRank(h.rating)} (${h.rating.toFixed(1)})${h.estimate ? `. ${rankEstimateText(h.estimate)}` : ""}`,
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
  el.resultRating.hidden = false;
  // The rank estimate runs after the game ends; the profile arrives again when it is done.
  if (p.estimating?.includes(gameId)) {
    el.resultRating.textContent = "Estimating your rank from your moves…";
    return;
  }
  const change = ratingChangeFor(p, gameId);
  if (!change) {
    el.resultRating.textContent = "Rating unchanged: games under 10 moves don't count.";
    return;
  }
  const delta = document.createElement("span");
  delta.className = change.delta > 0 ? "up" : change.delta < 0 ? "down" : "";
  delta.textContent = `${change.delta >= 0 ? "+" : "−"}${Math.abs(change.delta).toFixed(1)}`;
  const rank = change.before === change.after ? `rank ${change.after}` : `rank ${change.before} → ${change.after}`;
  const estimate = change.estimate ? ` ${change.estimate}.` : "";
  el.resultRating.replaceChildren("Rating ", delta, ` (${rank}).${estimate} Next bot: ${nextBotText(p)}.`);
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

  // The server's mistakes (worst first, at the threshold the game was played with).
  const mistakes = (v.summary?.mistakes ?? []).slice(0, 3);
  el.resultMistakes.replaceChildren(
    ...mistakes.map((m) => {
      const li = document.createElement("li");
      const tried = m.takenBack !== undefined ? ", taken back" : "";
      li.textContent = `Move ${m.moveNumber} (${m.move}${tried}): ${formatLoss(m.pointLoss)} pts, best ${m.bestMove}`;
      return li;
    }),
  );
  if (!el.resultDialog.open) el.resultDialog.showModal();
}

// --- wiring --------------------------------------------------------------

el.pass.addEventListener("click", () => void act({ type: "pass" }));
el.takeBack.addEventListener("click", () => void act({ type: "take_back" }));
// Hint sits by the chat input: whatever the learner typed goes along as their question.
el.hint.addEventListener("click", () => {
  if (!can(view, "ask_tutor")) return; // keep the typed text when the hint can't go out
  const text = el.chatInput.value.trim();
  el.chatInput.value = "";
  void act(text ? { type: "ask_tutor", text } : { type: "ask_tutor" });
});
el.continueBtn.addEventListener("click", () => void act({ type: "continue" }));
el.retry.addEventListener("click", () => void act({ type: "retry" }));
el.nextProblem.addEventListener("click", () => void act({ type: "next_problem" }));
el.practice.addEventListener("click", () => void act({ type: "next_problem" }));
el.leaveProblem.addEventListener("click", () => void act({ type: "leave_problem" }));
el.hideOverlay.addEventListener("click", () => void act({ type: "clear_overlay" }));

// Collapsible cards: the header button folds the card to its header line, remembered per card.
for (const card of document.querySelectorAll<HTMLElement>(".card.collapsible")) {
  const id = card.dataset.card ?? card.id;
  const toggle = card.querySelector<HTMLButtonElement>(".card-toggle");
  if (!toggle) continue;
  const apply = (collapsed: boolean) => {
    card.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  apply(readCollapsed(id));
  toggle.addEventListener("click", () => {
    const collapsed = !card.classList.contains("collapsed");
    apply(collapsed);
    writeCollapsed(id, collapsed);
  });
}

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
  s.addEventListener("change", () => {
    ngFormTouched = true;
    renderProgress(); // the next game's threshold follows the size picked
  });
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

/** Where keys belong to the focused control: any input, select, textarea, editable text, or a form's buttons. */
const FORM_CONTROLS = "input, select, textarea, [contenteditable]:not([contenteditable=false]), form button";

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (el.resultDialog.open) return; // Esc closes the dialog
  // Esc hides the drawing on the board, except in a form control, which keeps its own Esc.
  if (e.key === "Escape" && !target?.closest(FORM_CONTROLS) && can(view, "clear_overlay")) {
    e.preventDefault();
    void act({ type: "clear_overlay" });
    return;
  }
  if (target?.closest("input, textarea, select, dialog")) return;
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
