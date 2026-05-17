import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Search policy:
 *   1. Activate the built-in `grep` tool on session start (it is off by default).
 *   2. Block the built-in `find` tool — `grep` covers filename discovery too.
 *   3. Block bash commands that invoke `find`, shell `grep`/`egrep`/`fgrep`,
 *      `git grep`, `fd`/`fdfind`, `ag`, `ack`, or `xargs <banned>`. `rg` is
 *      allowed only for the documented exception for ignored paths; use `rg`
 *      patterns/flags directly rather than piping to shell `grep`.
 *
 * Blocked calls return a reason explaining what to use instead, so the agent
 * can self-correct and switch to the built-in `grep` tool.
 */

const REDIRECT_HINT =
	"Use the built-in `grep` tool for filename and content search " +
	"(it respects .gitignore and truncates output). For intentionally " +
	"ignored/excluded paths (e.g. node_modules, generated output, vendor " +
	"files) use Bash `rg -n --hidden --no-ignore '<pattern>' <path>`.";

const BANNED_BINARIES = new Set([
	"find",
	"grep",
	"egrep",
	"fgrep",
	"fd",
	"fdfind",
	"ag",
	"ack",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Returns the offending command name (e.g. "find", "git grep", "xargs grep")
 * if the bash command line invokes a banned search utility, otherwise null.
 *
 * The scan splits the command line at shell boundaries (`|`, `;`, `&`, `&&`,
 * `||`, newlines, `$(`, backticks) and inspects the head of each segment
 * after stripping leading `VAR=value` env assignments. A shell `grep` segment
 * is allowed only when it is filtering a pipeline whose first command is `rg`.
 */
function detectBannedSearchCommand(command: string): string | null {
	const segments = command.split(/(\$\(|`|\|\||&&|;|\||&|\n)/);
	let firstPipelineBase: string | null = null;
	let lastSeparator: string | null = null;

	for (const seg of segments) {
		if (/^(?:\$\(|`|\|\||&&|;|\||&|\n)$/.test(seg)) {
			lastSeparator = seg;
			if (seg !== "|") firstPipelineBase = null;
			continue;
		}

		const trimmed = seg.trim();
		if (!trimmed) continue;
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i])) i++;
		const head = tokens[i];
		if (!head) continue;
		const base = (head.split("/").pop() ?? head).replace(/^\\/, "");

		if (lastSeparator !== "|") firstPipelineBase = base;

		if (BANNED_BINARIES.has(base)) {
			return base;
		}

		if (base === "git" && tokens[i + 1] === "grep") return "git grep";

		if (base === "xargs") {
			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j];
				if (t.startsWith("-")) continue;
				const tb = (t.split("/").pop() ?? t).replace(/^\\/, "");
				if (BANNED_BINARIES.has(tb)) return `xargs ${tb}`;
				break;
			}
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		if (!active.includes("grep")) {
			pi.setActiveTools([...active, "grep"]);
		}
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "find") {
			return {
				block: true,
				reason: `The built-in \`find\` tool is disabled. ${REDIRECT_HINT}`,
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (typeof command !== "string") return;
			const offender = detectBannedSearchCommand(command);
			if (offender) {
				return {
					block: true,
					reason:
						`Bash \`${offender}\` is disabled for codebase/file search. ` +
						REDIRECT_HINT,
				};
			}
		}
	});
}
