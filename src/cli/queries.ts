// Read-only server queries shared by the commands and `watch`.

import type { FocusRecommendation, Profile, ProfileResponse, SavedGame } from "../shared/types.ts";
import { Client, ServerError } from "./client.ts";
import { formatReview, reviewThreshold } from "./format.ts";

/** GET /api/profile: `{ profile, focus }` (an older server sent the bare profile). */
export async function getProfile(client: Client, signal?: AbortSignal): Promise<{ profile: Profile; focus: FocusRecommendation | null } | null> {
  const body = await client.getJson<ProfileResponse | Profile>("/api/profile", signal);
  if (!body) return null;
  return "profile" in body ? body : { profile: body, focus: null };
}

/** GET /api/game/:id; a missing game is a ServerError that names it. */
export async function getGame(client: Client, gameId: string, signal?: AbortSignal): Promise<SavedGame> {
  const game = await client.getJson<SavedGame>(`/api/game/${encodeURIComponent(gameId)}`, signal);
  if (!game) {
    throw new ServerError(gameId === "last" ? "no saved games yet (GET /api/game/last returned 404)" : `no saved game "${gameId}"`, 404);
  }
  return game;
}

/** `review <gameId>` as text (brief: without the full move list). */
export async function reviewText(client: Client, gameId: string, signal?: AbortSignal, brief = false): Promise<string> {
  const [game, profile] = await Promise.all([getGame(client, gameId, signal), getProfile(client, signal).catch(() => null)]);
  // The threshold the game was played with, on its board, decides what counted as a mistake.
  return formatReview(game, reviewThreshold(game, profile?.profile), brief);
}
