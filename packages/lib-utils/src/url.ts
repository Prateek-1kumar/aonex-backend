const TRACKING_PARAM_PATTERNS = [
  /^utm_/,
  /^_ga$/,
  /^_gl$/,
  /^fbclid$/,
  /^gclid$/,
  /^mc_eid$/,
  /^mc_cid$/,
  /^msclkid$/,
  // Amazon-specific
  /^ref$/,
  /^ref_$/,
  /^crid$/,
  /^dib$/,
  /^dib_tag$/,
  /^keywords$/,
  /^qid$/,
  /^sprefix$/,
  /^sr$/,
  /^th$/,
  /^psc$/,
];

export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }

  u.hostname = u.hostname.toLowerCase();

  // Strip tracking params
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAM_PATTERNS.some((p) => p.test(k))) {
      keep.push([k, v]);
    }
  }
  // Rebuild searchParams
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // Normalize trailing slash (but keep "/" for root)
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  // For Amazon, strip /ref=… segments from the path
  if (/(^|\.)amazon\.[a-z.]+$/.test(u.hostname)) {
    u.pathname = u.pathname.replace(/\/ref=[^/]+/g, "");
  }

  return u.toString();
}

export function domainOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
