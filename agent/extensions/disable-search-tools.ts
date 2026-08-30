import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep the built-in `grep` and `find` tools unavailable; search is done with bash `rg` / `fd`. */
const DISABLED = new Set(["grep", "find"]);

export default function (pi: ExtensionAPI) {
	const disable = () => {
		const active = pi.getActiveTools();
		if (active.some((tool) => DISABLED.has(tool))) {
			pi.setActiveTools(active.filter((tool) => !DISABLED.has(tool)));
		}
	};

	pi.on("session_start", disable);

	pi.on("tool_call", (event) => {
		if (DISABLED.has(event.toolName)) {
			return {
				block: true,
				reason: `The ${event.toolName} tool is disabled; use bash \`rg\` for content search and \`fd\` for finding files.`,
			};
		}
	});
}
