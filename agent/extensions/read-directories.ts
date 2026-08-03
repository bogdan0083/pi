import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
	createReadToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

type TreeNode = Map<string, TreeNode>;

function renderTree(paths: string[]): string {
	const root: TreeNode = new Map();
	for (const path of paths) {
		let node = root;
		for (const part of path.split("/").filter(Boolean)) {
			let child = node.get(part);
			if (!child) {
				child = new Map();
				node.set(part, child);
			}
			node = child;
		}
	}

	const lines = ["."];
	function visit(node: TreeNode, prefix: string): void {
		const entries = [...node.entries()];
		entries.forEach(([name, child], index) => {
			const last = index === entries.length - 1;
			lines.push(`${prefix}${last ? "└── " : "├── "}${name}${child.size ? "/" : ""}`);
			if (child.size) visit(child, `${prefix}${last ? "    " : "│   "}`);
		});
	}
	visit(root, "");
	return lines.join("\n");
}

async function readFileOrDirectory(path: string): Promise<Buffer> {
	if (!(await stat(path)).isDirectory()) return readFile(path);

	// rg recursively lists files while honoring .gitignore and other ignore files.
	// Hidden files remain excluded, matching rg's default behavior.
	let stdout: Buffer;
	try {
		({ stdout } = await execFileAsync(
			"rg",
			["--files", "--sort", "path", "--color", "never", "."],
			{ cwd: path, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
		));
	} catch (error) {
		// rg exits with status 1 when the directory contains no visible,
		// non-ignored files.
		if ((error as { code?: number }).code !== 1) throw error;
		stdout = Buffer.alloc(0);
	}
	const paths = stdout
		.toString("utf8")
		.split("\n")
		.map((entry) => entry.replace(/^\.\//, ""))
		.filter(Boolean);
	return Buffer.from(renderTree(paths), "utf8");
}

export default function (pi: ExtensionAPI) {
	const read = createReadToolDefinition(process.cwd(), {
		operations: {
			readFile: readFileOrDirectory,
			access: (path) => access(path, constants.R_OK),
			async detectImageMimeType(path) {
				if ((await stat(path)).isDirectory()) return null;
				const bytes = (await readFile(path)).subarray(0, 12);
				if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
				if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
				if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
				if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
				if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
				return null;
			},
		},
	});

	read.description =
		"Read a file or directory. Files support text and images; directory paths return their full recursive hierarchy while respecting .gitignore. Output is truncated to 2,000 lines or 50KB. Use offset/limit to continue large results.";
	pi.registerTool(read);
}
