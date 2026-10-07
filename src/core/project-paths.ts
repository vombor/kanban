// Project path rules the add-project dialog shares with the runtime (web-ui alias `@runtime-project-paths`, so no
// node:path here). They only pre-validate: the runtime's check is `resolvePathInsideProjectRoots()` in
// src/projects/project-roots.ts (realpath, symlinks), and it runs again on every create, clone and add.

/** A directory name for a new project: lowercase, `[a-z0-9._-]`, runs of anything else become one `-`. */
export function slugifyProjectName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._]+|[-.]+$/g, "");
}

function splitPathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}

/** True when the path has a `..` segment. Project paths must name their directory directly. */
export function hasParentDirectorySegment(path: string): boolean {
	return splitPathSegments(path).includes("..");
}

/** Characters a project directory name may use (one path segment). */
const PROJECT_DIRECTORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_DIRECTORY_NAME_MAX_LENGTH = 100;

/** Why `name` can't be a project directory directly under a projects root, or null when it can. */
export function validateProjectDirectoryName(name: string): string | null {
	if (name.length === 0) {
		return "Enter a directory name.";
	}
	if (/[\\/]/.test(name)) {
		return "The directory name can't contain slashes: projects go directly inside the projects root.";
	}
	if (name === "." || name === "..") {
		return `"${name}" is not a directory name.`;
	}
	if (name.length > PROJECT_DIRECTORY_NAME_MAX_LENGTH) {
		return `The directory name is longer than ${PROJECT_DIRECTORY_NAME_MAX_LENGTH} characters.`;
	}
	if (!PROJECT_DIRECTORY_NAME_PATTERN.test(name)) {
		return "Use letters, digits, '.', '_' and '-' only, starting with a letter or digit.";
	}
	return null;
}
