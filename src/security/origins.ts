// A12: the origins the API answers are an EXACT list (the variable ALLOWED_ORIGINS, comma separated): in production only the website's origin; never `*`, no patterns, no preview URLs.
// An entry is an origin the way the browser writes it in the Origin header, nothing more: https://host, or https://host:port when the port is not the default. Plain http is allowed only for
// the developer's own machine (localhost, 127.0.0.1, [::1]): the session cookie is Secure and a website served over http could not use it anyway. Anything else stops the start (config.ts).

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The entry as an origin, or null when it is not exactly one: a wildcard, a pattern, a path or trailing slash, a query, credentials, a default port written out, a capital letter in the host. */
export function parseOrigin(text: string): string | null {
  if (text === '' || /[\s*,]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // URL.origin is what the browser sends: lower-case host, no default port, no path. An entry that is not equal to it is not an origin.
  if (url.origin !== text) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/** The list of ALLOWED_ORIGINS, or null when it is empty or any entry is not an exact origin. Spaces around an entry are ignored; a repeated entry is kept once. */
export function parseAllowedOrigins(text: string): readonly string[] | null {
  const entries = text.split(',').map((e) => e.trim()).filter((e) => e !== '');
  if (entries.length === 0) return null;
  const list: string[] = [];
  for (const entry of entries) {
    const origin = parseOrigin(entry);
    if (origin === null) return null;
    if (!list.includes(origin)) list.push(origin);
  }
  return Object.freeze(list);
}

/** An Origin header is allowed only when it equals an entry of the list, character for character (OWASP: `https://example.org.attacker.com` must not pass). `null`, a missing header and a list of two headers are not. */
export function isAllowedOrigin(allowed: readonly string[], header: unknown): boolean {
  return typeof header === 'string' && allowed.includes(header);
}
