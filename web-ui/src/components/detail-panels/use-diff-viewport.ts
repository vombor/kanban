import { type RefObject, useEffect, useState } from "react";

/**
 * Keep stable section anchors (and visited bodies/state) rather than recycling file
 * components. react-use's per-target useIntersection does not share an observer or
 * bound activation work; Virtuoso would recycle comment/context state and anchors.
 */
export function useDiffViewport(
	root: RefObject<HTMLDivElement>,
	paths: string[],
	active: boolean,
	selectedPath: string | null,
): Set<string> {
	const [ready, setReady] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		if (!active) return;
		const allowed = new Set(paths);
		setReady((previous) => {
			const next = new Set([...previous].filter((path) => allowed.has(path)));
			if (selectedPath && allowed.has(selectedPath)) next.add(selectedPath);
			return next.size === previous.size && [...next].every((path) => previous.has(path)) ? previous : next;
		});
	}, [active, paths, selectedPath]);
	useEffect(() => {
		const container = root.current;
		if (!active || !container) return;
		if (typeof IntersectionObserver === "undefined") {
			setReady(new Set(paths));
			return;
		}
		const pending = new Set<string>();
		let frame: number | null = null;
		const activate = () => {
			frame = null;
			const batch = [...pending].slice(0, 2);
			for (const path of batch) pending.delete(path);
			if (batch.length) {
				setReady((previous) =>
					batch.every((path) => previous.has(path)) ? previous : new Set([...previous, ...batch]),
				);
				for (const path of batch) {
					const section = sectionsByPath.get(path);
					if (section) observer.unobserve(section);
				}
			}
			if (pending.size) frame = requestAnimationFrame(activate);
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const path = (entry.target as HTMLElement).dataset.diffPath;
					if (!path) continue;
					if (entry.isIntersecting) pending.add(path);
					else pending.delete(path);
				}
				if (pending.size && frame === null) frame = requestAnimationFrame(activate);
			},
			{ root: container, rootMargin: "300px 0px" },
		);
		const sectionsByPath = new Map<string, HTMLElement>();
		for (const section of container.querySelectorAll<HTMLElement>("[data-diff-path]")) {
			if (section.dataset.diffPath) sectionsByPath.set(section.dataset.diffPath, section);
			observer.observe(section);
		}
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [active, paths, root]);
	return ready;
}
