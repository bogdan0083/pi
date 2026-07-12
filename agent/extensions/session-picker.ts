import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const MAX_ITEMS = 20;
const CACHE_TTL_MS = 10_000;
const PROJECTS_FILE = `${process.env.HOME || ""}/.config/lazygit/fixed-repos.txt`;

type SessionAutocompleteItem = AutocompleteItem & {
  sessionId?: string;
};

type ProjectAutocompleteItem = AutocompleteItem & {
  projectPath: string;
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

function extractProjectPrefix(lines: string[], cursorLine: number, cursorCol: number): { prefix: string; query: string } | null {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  const match = beforeCursor.match(/(?:^|[ \t])(@@@([^\s@]*))$/);
  if (!match) return null;
  return {
    prefix: match[1] ?? "@@@",
    query: match[2] ?? "",
  };
}

function loadProjects(): string[] {
  if (!PROJECTS_FILE || !existsSync(PROJECTS_FILE)) return [];
  return readFileSync(PROJECTS_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && existsSync(line));
}

function toProjectItem(projectPath: string): ProjectAutocompleteItem {
  return {
    value: `@${projectPath}/`,
    label: `${basename(projectPath)}  · ${shortPath(projectPath)}`,
    projectPath,
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
  private projectCompletionPending = false;

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
    const projectPrefix = extractProjectPrefix(lines, cursorLine, cursorCol);
    if (projectPrefix) {
      const projects = loadProjects();
      const matches = projectPrefix.query
        ? fuzzyFilter(projects, projectPrefix.query, (projectPath) => `${basename(projectPath)} ${projectPath}`)
        : projects;
      const items = matches.slice(0, MAX_ITEMS).map(toProjectItem);
      return items.length > 0 ? { items, prefix: projectPrefix.prefix } : null;
    }

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
    if (prefix.startsWith("@@@") && "projectPath" in item) {
      this.projectCompletionPending = true;
      const replacement = item.value;
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
    if (prefix.startsWith("@@") && item.value.startsWith("@@")) {
      return applySessionCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    const completion = this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    if (this.projectCompletionPending && prefix.startsWith("@/")) {
      this.projectCompletionPending = false;
      const completedLine = completion.lines[completion.cursorLine] ?? "";
      const markerStart = Math.max(0, completion.cursorCol - item.value.length);
      if (completedLine[markerStart] === "@") {
        completion.lines[completion.cursorLine] = completedLine.slice(0, markerStart) + completedLine.slice(markerStart + 1);
        completion.cursorCol--;
      }
    }
    return completion;
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
