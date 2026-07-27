export type NavigationHistoryEntry = {
  pathname: string;
  search: string;
  key: string;
  timestamp: number;
};

const MAX_ENTRIES = 40;

export class NavigationHistoryController {
  private entries: NavigationHistoryEntry[] = [];

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, private readonly storageKey: string) {
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) || "[]");
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is NavigationHistoryEntry =>
          Boolean(entry) && typeof entry.pathname === "string" && typeof entry.search === "string" && typeof entry.key === "string" && typeof entry.timestamp === "number"
        ).slice(-MAX_ENTRIES);
      }
    } catch {
      this.entries = [];
    }
  }

  record(pathname: string, search: string, key: string, timestamp = Date.now()) {
    const route = `${pathname}${search}`;
    const latest = this.entries[this.entries.length - 1];
    if (latest && `${latest.pathname}${latest.search}` === route) return;
    this.entries.push({ pathname, search, key, timestamp });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.persist();
  }

  previous(currentRoute: string, isSafe: (route: string) => boolean) {
    while (this.entries.length && this.routeOf(this.entries[this.entries.length - 1]) === currentRoute) this.entries.pop();
    while (this.entries.length) {
      const entry = this.entries.pop()!;
      const route = this.routeOf(entry);
      if (isSafe(route)) {
        this.persist();
        return route;
      }
    }
    this.persist();
    return null;
  }

  clear() {
    this.entries = [];
    this.storage.removeItem(this.storageKey);
  }

  snapshot() {
    return [...this.entries];
  }

  private routeOf(entry: NavigationHistoryEntry) {
    return `${entry.pathname}${entry.search}`;
  }

  private persist() {
    this.storage.setItem(this.storageKey, JSON.stringify(this.entries));
  }
}
