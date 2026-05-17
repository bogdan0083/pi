/**
 * Prompt History Extension
 *
 * Adds Ctrl+R shortcut to show a searchable, selectable prompt history
 * from ALL projects. Selected prompts are pasted into the editor.
 *
 * Features:
 * - Ctrl+R or /prompt-history to open
 * - Search as you type (filters history by text match)
 * - Arrow keys to navigate, Enter to select
 * - Shows project context for each entry
 * - History loaded from all session files across projects
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Key,
  type Focusable,
  matchesKey,
  visibleWidth,
  CURSOR_MARKER,
} from "@earendil-works/pi-tui";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PromptEntry {
  text: string;
  project: string;
  timestamp: number;
  sessionId: string;
}

interface SessionHeader {
  type: string;
  cwd?: string;
  id?: string;
}

interface SessionMessage {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
  timestamp?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a timestamp that can be a number (epoch ms) or ISO string.
 */
function normalizeTimestamp(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Sanitize text for safe terminal display:
 * - Replace newlines with a visible symbol
 * - Strip ANSI escape / control sequences
 */
function sanitizeForDisplay(text: string): string {
  // Replace newlines/carriage returns with visible marker
  let s = text.replace(/\r?\n/g, "⏎ ");
  // Strip ANSI escape sequences: ESC + [...m or other CSI sequences
  s = s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Strip any other ASCII control chars (except tab)
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Collapse multiple spaces
  s = s.replace(/  +/g, " ");
  return s.trim();
}

/**
 * Decode a session directory name as fallback.
 */
function decodeDirName(dirName: string): string {
  const inner = dirName.replace(/^--|--$/g, "");
  return "/" + inner.split("-").join("/");
}

/**
 * Get a short display label for a project path.
 */
function shortProject(path: string): string {
  const home = process.env.HOME || "";
  if (path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

/**
 * Extract a session id from a session filename as a fallback.
 */
function sessionIdFromFileName(fileName: string): string {
  const match = fileName.match(/_([0-9a-f-]{36})\.jsonl$/i);
  return match?.[1] ?? fileName.replace(/\.jsonl$/i, "");
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load all user prompts from session files.
 * Scans all session directories under the agent dir, processing newer files first.
 */
async function loadAllPrompts(maxEntries = 500): Promise<PromptEntry[]> {
  const agentDir = getAgentDir();
  const sessionsDir = join(agentDir, "sessions");

  if (!existsSync(sessionsDir)) {
    return [];
  }

  const projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  const seen = new Set<string>();
  const entries: PromptEntry[] = [];

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;

    const dirPath = join(sessionsDir, projectDir.name);

    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    // Sort files by mtime descending (newest first) to stop early
    const jsonlFiles = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, path: join(dirPath, f) }));

    // Get file stats in parallel for sorting
    const withStats = await Promise.all(
      jsonlFiles.map(async (f) => {
        try {
          const s = await stat(f.path);
          return { ...f, mtime: s.mtimeMs };
        } catch {
          return { ...f, mtime: 0 };
        }
      }),
    );
    withStats.sort((a, b) => b.mtime - a.mtime);

    for (const file of withStats) {
      if (entries.length >= maxEntries) break;

      try {
        const content = await readFile(file.path, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length === 0) continue;

        // Extract project path and session id from session header (first line)
        let projectPath: string;
        let sessionId = sessionIdFromFileName(file.name);
        try {
          const header: SessionHeader = JSON.parse(lines[0]!);
          projectPath = header.type === "session" && header.cwd
            ? header.cwd
            : decodeDirName(projectDir.name);
          if (header.type === "session" && header.id) {
            sessionId = header.id;
          }
        } catch {
          projectPath = decodeDirName(projectDir.name);
        }

        for (let i = 1; i < lines.length && entries.length < maxEntries; i++) {
          const line = lines[i]!;
          try {
            const parsed: SessionMessage = JSON.parse(line);
            if (
              parsed.type === "message" &&
              parsed.message?.role === "user" &&
              parsed.message.content
            ) {
              const textParts = parsed.message.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!);

              if (textParts.length > 0) {
                const text = textParts.join("\n").trim();
                if (text.length > 0) {
                  const ts = normalizeTimestamp(
                    parsed.message.timestamp ?? parsed.timestamp,
                  );
                  // Deduplicate by text + project to show same prompt across projects
                  const key = `${text.toLowerCase()}|${projectPath}`;
                  if (!seen.has(key)) {
                    seen.add(key);
                    entries.push({ text, project: projectPath, timestamp: ts, sessionId });
                  }
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (entries.length >= maxEntries) break;
  }

  // Sort final list by timestamp descending
  entries.sort((a, b) => b.timestamp - a.timestamp);

  return entries.slice(0, maxEntries);
}

// ─── Overlay Component ────────────────────────────────────────────────────────

class PromptHistoryOverlay implements Focusable {
  readonly width = 80;

  /** Focusable interface - set by TUI when focus changes */
  focused = false;

  /** Search query state */
  private query = "";
  private cursor = 0;

  /** Selection state */
  private selectedIndex = 0;

  /** Computed filtered list of entries */
  private filtered: PromptEntry[] = [];

  constructor(
    private allEntries: PromptEntry[],
    private theme: Theme,
    private done: (result: string | null) => void,
  ) {
    this.filtered = allEntries;
  }

  /** Match a prompt entry against a search query (case-insensitive) */
  private matches(entry: PromptEntry, query: string): boolean {
    if (!query) return true;
    const lowerQuery = query.toLowerCase();
    return (
      entry.text.toLowerCase().includes(lowerQuery) ||
      entry.project.toLowerCase().includes(lowerQuery) ||
      entry.sessionId.toLowerCase().includes(lowerQuery) ||
      `@@${entry.sessionId}`.toLowerCase().includes(lowerQuery)
    );
  }

  /** Recompute the filtered list and clamp selection */
  private refilter(): void {
    this.filtered = this.allEntries.filter((e) => this.matches(e, this.query));
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filtered.length - 1));
  }

  /** Sanitize text for display (single line, no control chars) */
  private displayText(raw: string, maxLen: number): string {
    const clean = sanitizeForDisplay(raw);
    return clean.length > maxLen
      ? clean.slice(0, maxLen - 1) + "…"
      : clean;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (this.filtered.length > 0) {
        const selected = this.filtered[this.selectedIndex];
        if (selected) {
          this.done(selected.text);
        }
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.filtered.length - 1,
        this.selectedIndex + 1,
      );
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(
        this.filtered.length - 1,
        this.selectedIndex + 10,
      );
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.selectedIndex = this.filtered.length - 1;
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.query =
          this.query.slice(0, this.cursor - 1) +
          this.query.slice(this.cursor);
        this.cursor--;
        this.refilter();
      }
      return;
    }

    if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.query.length) {
        this.query =
          this.query.slice(0, this.cursor) +
          this.query.slice(this.cursor + 1);
        this.refilter();
      }
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(this.query.length, this.cursor + 1);
      return;
    }

    // Printable character input
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query =
        this.query.slice(0, this.cursor) +
        data +
        this.query.slice(this.cursor);
      this.cursor++;
      this.refilter();
    }
  }

  render(_width: number): string[] {
    const w = this.width;
    const th = this.theme;
    const innerW = w - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    // ── Top border ──
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

    // ── Title ──
    lines.push(
      row(
        ` ${th.fg("accent", "🔍 Prompt History")}  ${th.fg(
          "dim",
          `(${this.filtered.length} entries)`,
        )}`,
      ),
    );

    lines.push(row(""));

    // ── Search input ──
    const searchPrefix = " > ";
    let searchDisplay = this.query;
    if (this.focused) {
      const before = searchDisplay.slice(0, this.cursor);
      const cursorChar =
        this.cursor < searchDisplay.length
          ? searchDisplay[this.cursor]
          : " ";
      const after = searchDisplay.slice(this.cursor + 1);
      const marker = this.focused ? CURSOR_MARKER : "";
      searchDisplay = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
    }
    lines.push(row(`${searchPrefix}${searchDisplay}`));

    lines.push(row(""));

    // ── Results ──
    if (this.filtered.length === 0) {
      lines.push(row(` ${th.fg("dim", "No matching prompts found.")}`));
    } else {
      // Available height: rough estimate (terminal usually has enough)
      // We'll render up to ~20 visible items
      const maxVisible = 20;
      const total = this.filtered.length;
      const halfVisible = Math.floor(maxVisible / 2);

      let startIdx: number;
      let endIdx: number;

      if (total <= maxVisible) {
        startIdx = 0;
        endIdx = total;
      } else if (this.selectedIndex <= halfVisible) {
        startIdx = 0;
        endIdx = maxVisible;
      } else if (this.selectedIndex >= total - halfVisible) {
        startIdx = total - maxVisible;
        endIdx = total;
      } else {
        startIdx = this.selectedIndex - halfVisible;
        endIdx = this.selectedIndex + halfVisible;
      }

      if (startIdx > 0) {
        lines.push(
          row(` ${th.fg("dim", `⋯ ${startIdx} more above`)}`),
        );
      }

      const maxTextLen = innerW - 10; // leave room for prefix + project label

      for (let i = startIdx; i < endIdx && i < total; i++) {
        const entry = this.filtered[i]!;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? " ▶ " : "   ";
        const displayText = this.displayText(entry.text, maxTextLen);
        const projectLabel = shortProject(entry.project);
        const threadLabel = `@@${entry.sessionId}`;

        // Prompt text line
        if (isSelected) {
          const line = `${prefix}${displayText}`;
          const linePadded = pad(line, innerW - 4);
          lines.push(row(`\x1b[7m ${linePadded} \x1b[27m`));
        } else {
          lines.push(row(`${prefix}${th.fg("text", displayText)}`));
        }

        // Project + thread/session id line (dimmed)
        const projLine = `   📁 ${projectLabel}  🧵 ${threadLabel}`;
        if (isSelected) {
          const padded = pad(projLine, innerW - 4);
          lines.push(row(`\x1b[7m ${padded} \x1b[27m`));
        } else {
          lines.push(row(`   ${th.fg("dim", `📁 ${projectLabel}  🧵 ${threadLabel}`)}`));
        }
      }

      if (endIdx < total) {
        lines.push(
          row(` ${th.fg("dim", `⋯ ${total - endIdx} more below`)}`),
        );
      }
    }

    lines.push(row(""));

    // ── Footer ──
    lines.push(
      row(
        ` ${th.fg(
          "dim",
          "↑↓ navigate · Page Up/Down scroll · type to search · Enter select · Esc cancel",
        )}`,
      ),
    );

    // ── Bottom border ──
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prompt cache
  let promptCache: PromptEntry[] = [];
  let lastLoadTime = 0;
  const CACHE_TTL_MS = 10_000; // 10 seconds

  async function refreshCache(): Promise<void> {
    promptCache = await loadAllPrompts();
    lastLoadTime = Date.now();
  }

  // Load on startup
  pi.on("session_start", async () => {
    await refreshCache();
  });

  // Also try loading immediately
  refreshCache().catch(() => {
    // Silently fail; will retry on session_start or first use
  });

  // ── Common handler for showing prompt history ──
  async function showPromptHistory(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      return;
    }

    // Refresh cache if stale, otherwise use cached
    if (Date.now() - lastLoadTime > CACHE_TTL_MS) {
      ctx.ui.setStatus("prompt-history", "Loading prompt history...");
      try {
        await refreshCache();
      } catch {
        // Keep existing cache on error
      }
      ctx.ui.setStatus("prompt-history", undefined);
    }

    if (promptCache.length === 0) {
      ctx.ui.notify("No prompt history found. Start a conversation first!", "warning");
      return;
    }

    const result = await ctx.ui.custom<string | null>(
      (_tui, theme, _keybindings, done) =>
        new PromptHistoryOverlay(promptCache, theme, done),
      { overlay: true },
    );

    if (result) {
      ctx.ui.pasteToEditor(result);
    }
  }

  // ── Register shortcut: Ctrl+R ──
  pi.registerShortcut(Key.ctrl("r"), {
    description: "Show prompt history (searchable, cross-project)",
    handler: async (ctx) => {
      await showPromptHistory(ctx);
    },
  });

  // ── Register command: /prompt-history ──
  pi.registerCommand("prompt-history", {
    description: "Show prompt history from all projects (searchable, Ctrl+R)",
    handler: async (_args, ctx) => {
      await showPromptHistory(ctx);
    },
  });
}
