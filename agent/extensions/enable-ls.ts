import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Enables the built-in `ls` tool (off by default) on session start.
 */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		if (!active.includes("ls")) {
			pi.setActiveTools([...active, "ls"]);
		}
	});
}
