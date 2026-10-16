// Rank scale: 30k = 0 … 1k = 29, 1d = 30 … 9d = 38 (see RANK_SCALE_NOTE in types.ts).

export const MIN_RATING = 0;
export const MAX_RATING = 38;

/** KataGo's human-SL profiles cover 20k … 9d. */
const MIN_HUMAN_SL_RATING = 10;

/** "20k" → 10, "1k" → 29, "1d" → 30, "9d" → 38. Accepts "20K", "20 kyu", "3dan". Throws on anything else. */
export function rankToRating(rank: string): number {
  const match = /^\s*(\d+)\s*(k|kyu|d|dan)\s*$/i.exec(rank);
  if (!match) throw new RangeError(`"${rank}" is not a rank (expected e.g. "20k" or "2d")`);
  const n = Number(match[1]);
  const isDan = match[2]!.toLowerCase().startsWith("d");
  if (isDan ? n < 1 || n > 9 : n < 1 || n > 30) {
    throw new RangeError(`"${rank}" is out of range (30k … 9d)`);
  }
  return isDan ? 29 + n : 30 - n;
}

/** Nearest rank for a rating, clamped to 30k … 9d. */
export function ratingToRank(rating: number): string {
  const r = clampRating(Math.round(rating));
  return r <= 29 ? `${30 - r}k` : `${r - 29}d`;
}

export function clampRating(rating: number): number {
  if (Number.isNaN(rating)) return MIN_RATING;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, rating));
}

/** Normalize a rank string ("20K" → "20k"). Throws on invalid input. */
export function normalizeRank(rank: string): string {
  return ratingToRank(rankToRating(rank));
}

/**
 * KataGo human-SL profile name for a bot rank: "20k" → "rank_20k", "1D" → "rank_1d"; "rank_5k" is
 * accepted too. Throws for anything outside the profiles KataGo has (20k … 9d).
 */
export function toHumanSLProfile(rank: string): string {
  return `rank_${normalizeBotRank(rank.trim().replace(/^rank_/i, ""))}`;
}

/** A bot rank normalized ("18K" → "18k"). Throws unless KataGo has a human-SL profile for it (20k … 9d). */
export function normalizeBotRank(rank: string): string {
  const rating = rankToRating(rank);
  if (rating < MIN_HUMAN_SL_RATING) throw new RangeError(`Bot rank "${rank.trim()}" is outside KataGo's human profiles (20k … 9d)`);
  return ratingToRank(rating);
}
