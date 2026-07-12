import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Enables the built-in `ls` tool and removes the built-in `find` tool on
 * session start.
 */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const active = pi.getActiveTools().filter((tool) => tool !== "find");
		if (!active.includes("ls")) {
			active.push("ls");
		}
		pi.setActiveTools(active);
	});
}
