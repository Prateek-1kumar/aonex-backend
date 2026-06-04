// In-memory registry that maps a URL's hostname to a PerSiteParser.
//
// registerParser() appends and keeps the list priority-sorted; findParserForUrl()
// resolves a URL to the highest-priority parser whose domain matches by exact
// hostname or dotted suffix, returning null when none claim it. Callers in the
// ingestion pipeline use this to pick the right site-specific extractor.

import type { PerSiteParser } from "./types.js";

const parsers: PerSiteParser[] = [];

export function registerParser(p: PerSiteParser): void {
  parsers.push(p);
  parsers.sort((a, b) => b.priority - a.priority);
}

export function findParserForUrl(url: string): PerSiteParser | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const p of parsers) {
    for (const dom of p.domains) {
      const domLower = dom.toLowerCase();
      if (hostname === domLower || hostname.endsWith(`.${domLower}`)) return p;
    }
  }
  return null;
}

/** Snapshot of currently-registered parsers — useful for diagnostic logging. */
export function listRegisteredParsers(): ReadonlyArray<PerSiteParser> {
  return parsers.slice();
}

/** For tests only — reset registry */
export function _resetRegistry(): void {
  parsers.length = 0;
}
