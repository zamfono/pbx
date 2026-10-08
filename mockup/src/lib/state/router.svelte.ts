/**
 * Navigation: `router.route` is the current path, its segments and query, read from `page`; `go`
 * navigates with `goto`; `highlight` names a row a "Show me" link flashes once. Links in the app
 * are site paths (`href`).
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';

export type Route = {
  path: string;
  segments: string[];
  query: URLSearchParams;
};

const highlightState = $state<{ id: string | null }>({ id: null });

function parse(url: { pathname: string; search: string }): Route {
  return {
    path: url.pathname,
    segments: url.pathname.split('/').filter(Boolean),
    query: new URLSearchParams(url.search)
  };
}

export const router = {
  get route(): Route {
    return parse(page.url);
  },
  get highlight(): string | null {
    return highlightState.id;
  },
  set highlight(id: string | null) {
    highlightState.id = id;
  }
};

const HIGHLIGHT_MS = 2600;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Flashes the row with id `id` on the current page once. */
export function highlight(id: string): void {
  highlightState.id = id;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightState.id = null;
  }, HIGHLIGHT_MS);
}

export function go(
  path: string,
  options: { highlight?: string; replace?: boolean } = {}
): void {
  if (options.highlight !== undefined) {
    highlight(options.highlight);
  }
  void goto(href(path), { replaceState: options.replace === true });
}

/** The link to app path `path`; the mockup is served at the site's root. */
export function href(path: string): string {
  return path;
}

/** Matches `pattern` (`/users/:id/:tab?`) against `path`; params or null. */
export function match(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  if (pathParts.length > patternParts.length) {
    return null;
  }
  for (const [index, part] of patternParts.entries()) {
    const value = pathParts[index];
    if (part.startsWith(':')) {
      const optional = part.endsWith('?');
      const name = part.slice(1, optional ? -1 : undefined);
      if (value === undefined) {
        if (!optional) {
          return null;
        }
        continue;
      }
      params[name] = decodeURIComponent(value);
    } else if (part !== value) {
      return null;
    }
  }
  return params;
}
