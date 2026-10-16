// Which side-panel cards the learner folded to their header, kept per card in localStorage.
// Storage can be missing or throw (private windows, blocked site data): then cards start open
// and folding still works for the page's lifetime.

const KEY_PREFIX = "go-tutor:collapsed:";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether card `id` was left collapsed. */
export function readCollapsed(id: string, store: KeyValueStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(KEY_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

/** Remember whether card `id` is collapsed (an open card leaves no entry). */
export function writeCollapsed(id: string, collapsed: boolean, store: KeyValueStore | null = defaultStore()): void {
  try {
    if (collapsed) store?.setItem(KEY_PREFIX + id, "1");
    else store?.removeItem(KEY_PREFIX + id);
  } catch {
    // Not remembered; the card still folds.
  }
}
