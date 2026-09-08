import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import {
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Image formats pi can attach to a model request. */
const SUPPORTED_IMAGE_TYPES = "jpg, png, gif, webp, bmp";

const readImageParameters = Type.Object({
	path: Type.String({ description: "Path to the image file (relative or absolute)" }),
});

/**
 * Image-only companion to the disabled `read` tool.
 *
 * `read`, `edit`, and `write` are disabled so file operations go through bash,
 * but bash cannot attach image bytes to a model request. This tool reuses pi's
 * read pipeline (mime sniffing, resizing, provider limits) for images only and
 * rejects text files and directories with a pointer back to bash.
 */
export default function (pi: ExtensionAPI) {
	const read = createReadToolDefinition(process.cwd(), {
		operations: {
			access: (path) => access(path, constants.R_OK),
			async detectImageMimeType(path) {
				if ((await stat(path)).isDirectory()) {
					throw new Error(
						`read-image only reads image files (${SUPPORTED_IMAGE_TYPES}); "${path}" is a directory. Use bash (ls/fd) to list directories.`,
					);
				}
				return detectSupportedImageMimeTypeFromFile(path);
			},
			async readFile(path) {
				// Reached from the text branch when the path is not an image; the
				// image branch only gets here after mime detection succeeded.
				const mimeType = await detectSupportedImageMimeTypeFromFile(path);
				if (!mimeType) {
					throw new Error(
						`read-image only reads image files (${SUPPORTED_IMAGE_TYPES}); "${path}" is not a supported image. Use bash (cat/sed/rg) to read text files.`,
					);
				}
				return readFile(path);
			},
		},
	});

	const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = read;

	pi.registerTool({
		...definition,
		name: "read-image",
		label: "read-image",
		description:
			`Read an image file (${SUPPORTED_IMAGE_TYPES}) and attach it so you can see it. ` +
			"Only image files are supported; use bash for text files and directories.",
		parameters: readImageParameters,
		promptSnippet: `read-image: Read an image file (${SUPPORTED_IMAGE_TYPES}) and attach it for viewing.`,
		promptGuidelines: [
			`Use read-image to look at image files (${SUPPORTED_IMAGE_TYPES}); use bash for text files, directories, and everything else.`,
		],
	});
}
