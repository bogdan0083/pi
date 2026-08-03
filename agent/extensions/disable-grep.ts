import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep the built-in grep tool unavailable, including if another extension enables it. */
export default function (pi: ExtensionAPI) {
	const disableGrep = () => {
		const active = pi.getActiveTools();
		if (active.includes("grep")) {
			pi.setActiveTools(active.filter((tool) => tool !== "grep"));
		}
	};

	pi.on("session_start", disableGrep);

	pi.on("tool_call", (event) => {
		if (event.toolName === "grep") {
			return {
				block: true,
				reason: "The grep tool is disabled.",
			};
		}
	});
}
