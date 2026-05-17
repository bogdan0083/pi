import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const MAX_ITEMS = 20;
const CACHE_TTL_MS = 10_000;

type SessionAutocompleteItem = AutocompleteItem & {
  sessionId?: string;
};

function extractSessionPrefix(lines: string[], cursorLine: number, cursorCol: number): { prefix: string; query: string } | null {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  const match = beforeCursor.match(/(?:^|[ \t])(@@([^\s@]*))$/);
  if (!match) return null;
  return {
    prefix: match[1] ?? "@@",
    query: match[2] ?? "",
  };
}

function shortPath(path: string): string {
  const home = process.env.HOME || "";
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function shortId(id: string): string {
  return id.length > 13 ? id.slice(0, 13) : id;
}

function oneLine(text: string, max = 70): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`;
  return date.toLocaleDateString();
}

function searchableText(info: SessionInfo): string {
  return [info.id, `@@${info.id}`, info.name, info.cwd, info.firstMessage]
    .filter(Boolean)
    .join(" ");
}

function toItem(info: SessionInfo): SessionAutocompleteItem {
  const title = oneLine(info.name || info.firstMessage, 220) || "unnamed session";
  const project = shortPath(info.cwd || "unknown cwd");
  return {
    value: `@@${info.id}`,
    // Keep everything in the primary label. SelectList constrains labels to a
    // narrow primary column whenever description is set, so using description
    // makes long session messages look artificially truncated even in wide windows.
    label: `${title}  · @@${shortId(info.id)} · ${project} · ${formatRelativeTime(info.modified)} · ${info.messageCount} messages`,
    sessionId: info.id,
  };
}

function applySessionCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
  const replacement = item.value.endsWith(" ") ? item.value : `${item.value} `;
  const nextLines = [...lines];
  const line = nextLines[cursorLine] ?? "";
  const start = Math.max(0, cursorCol - prefix.length);
  nextLines[cursorLine] = line.slice(0, start) + replacement + line.slice(cursorCol);
  return {
    lines: nextLines,
    cursorLine,
    cursorCol: start + replacement.length,
  };
}

class SessionAutocompleteProvider implements AutocompleteProvider {
  private cachedSessions: SessionInfo[] = [];
  private lastLoadTime = 0;
  private hasLoaded = false;
  private loading: Promise<SessionInfo[]> | null = null;

  constructor(private current: AutocompleteProvider) {}

  private async getSessions(): Promise<SessionInfo[]> {
    const now = Date.now();
    if (this.hasLoaded && now - this.lastLoadTime < CACHE_TTL_MS) {
      return this.cachedSessions;
    }
    if (!this.loading) {
      this.loading = SessionManager.listAll()
        .then((sessions) => {
          this.cachedSessions = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
          this.lastLoadTime = Date.now();
          this.hasLoaded = true;
          return this.cachedSessions;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const sessionPrefix = extractSessionPrefix(lines, cursorLine, cursorCol);
    if (sessionPrefix) {
      const sessions = await this.getSessions();
      if (options.signal.aborted) return null;

      const query = sessionPrefix.query.trim();
      const matches = query
        ? fuzzyFilter(sessions, query, searchableText)
        : sessions;
      const items = matches.slice(0, MAX_ITEMS).map(toItem);
      return items.length > 0 ? { items, prefix: sessionPrefix.prefix } : null;
    }

    return this.current.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    if (prefix.startsWith("@@") && item.value.startsWith("@@")) {
      return applySessionCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => new SessionAutocompleteProvider(current));
  });
}
