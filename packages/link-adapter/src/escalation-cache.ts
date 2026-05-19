import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type EscalatedTo = "static" | "browser" | "unblock";

export interface EscalationState {
  escalatedTo: EscalatedTo;
  reasons: string[];
  costCredits: number;
}

export interface IEscalationCache {
  get(url: string): Promise<EscalationState | null>;
  set(url: string, state: EscalationState): Promise<void>;
}

export class FileEscalationCache implements IEscalationCache {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private load(): Record<string, EscalationState> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, EscalationState>;
    } catch {
      return {};
    }
  }

  async get(url: string): Promise<EscalationState | null> {
    return this.load()[url] ?? null;
  }

  async set(url: string, state: EscalationState): Promise<void> {
    const all = this.load();
    all[url] = state;
    writeFileSync(this.path, JSON.stringify(all), "utf8");
  }
}

export class InMemoryEscalationCache implements IEscalationCache {
  private store = new Map<string, EscalationState>();
  async get(url: string): Promise<EscalationState | null> {
    return this.store.get(url) ?? null;
  }
  async set(url: string, state: EscalationState): Promise<void> {
    this.store.set(url, state);
  }
}
