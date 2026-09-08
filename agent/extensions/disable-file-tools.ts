import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep the built-in `read`, `edit`, and `write` tools unavailable; text files go through `bash`, images through `read-image`. */
const DISABLED = new Set(["read", "edit", "write"]);

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
				reason: `The ${event.toolName} tool is disabled; use bash for file operations (cat/sed/awk/printf, rg/fd).`,
			};
		}
	});
}
