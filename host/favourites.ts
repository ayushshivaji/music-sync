import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type Favourite = {
  id: string;
  url: string;
  name: string;
  addedAt: string;   // ISO8601
};

type PersistedShape = { version: 1; items: Favourite[] };

export class FavouritesStore {
  private items: Favourite[] = [];
  private ready: Promise<void>;
  private listeners = new Set<() => void>();
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {
    this.ready = this.load();
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  all(): Favourite[] {
    // Stable order: newest first (addedAt desc).
    return [...this.items].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async add(url: string, name?: string): Promise<Favourite | null> {
    await this.ready;
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return null;
    // Dedup by URL — re-adding the same URL is a no-op so "★" is idempotent.
    const existing = this.items.find((f) => f.url === trimmedUrl);
    if (existing) return existing;
    const fav: Favourite = {
      id: `fav-${randomUUID()}`,
      url: trimmedUrl,
      name: sanitizeName(name, trimmedUrl),
      addedAt: new Date().toISOString(),
    };
    this.items.push(fav);
    this.scheduleSave();
    this.notify();
    return fav;
  }

  async remove(id: string): Promise<boolean> {
    await this.ready;
    const idx = this.items.findIndex((f) => f.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.scheduleSave();
    this.notify();
    return true;
  }

  async rename(id: string, name: string): Promise<boolean> {
    await this.ready;
    const fav = this.items.find((f) => f.id === id);
    if (!fav) return false;
    fav.name = sanitizeName(name, fav.url);
    this.scheduleSave();
    this.notify();
    return true;
  }

  get(id: string): Favourite | undefined {
    return this.items.find((f) => f.id === id);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && "items" in parsed && Array.isArray((parsed as PersistedShape).items)) {
        this.items = (parsed as PersistedShape).items.filter(isValidFavourite);
        console.log(`[favourites] loaded ${this.items.length} from ${this.filePath}`);
      } else {
        console.log(`[favourites] file exists but shape unrecognized; starting empty`);
        this.items = [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(`[favourites] no file at ${this.filePath}; starting empty`);
      } else {
        console.error(`[favourites] load failed: ${(err as Error).message}; starting empty`);
      }
      this.items = [];
    }
  }

  private scheduleSave(): void {
    // Serialize writes so concurrent mutations can't interleave an atomic swap.
    this.saveQueue = this.saveQueue.then(() => this.saveNow()).catch((err) => {
      console.error(`[favourites] save error: ${err?.message ?? err}`);
    });
  }

  private async saveNow(): Promise<void> {
    const payload: PersistedShape = { version: 1, items: this.items };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

function sanitizeName(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  const source = trimmed || fallback;
  return source.slice(0, 200);
}

function isValidFavourite(x: unknown): x is Favourite {
  if (!x || typeof x !== "object") return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.url === "string" &&
    typeof f.name === "string" &&
    typeof f.addedAt === "string"
  );
}

export function defaultFavouritesPath(): string {
  const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  return join(dir, "favourites.json");
}
