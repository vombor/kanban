// Structural domain links: no server, Node, agent SDK, routing policy or installation imports.
export interface ObjectiveTaskLink {
	taskId: string;
	parentTaskId: string | null;
	kind: string;
}

export function createObjectiveTaskLineage(tasks: readonly ObjectiveTaskLink[]) {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	if (byId.size !== tasks.length) throw new Error("Objective task ids must be unique.");
	const roots = new Map<string, string>();
	const rootOf = (taskId: string): string => {
		const visited = new Set<string>();
		let current = taskId;
		while (true) {
			if (visited.has(current)) throw new Error("Objective task lineage contains a cycle.");
			visited.add(current);
			const task = byId.get(current);
			if (!task) throw new Error("Objective task lineage has a missing parent.");
			if (task.parentTaskId === null) {
				if (task.kind !== "dev") throw new Error("Only explicit dev tasks may be objective roots.");
				return task.taskId;
			}
			if (task.kind === "dev") throw new Error("A dev objective root cannot be a derived task.");
			if (byId.get(task.parentTaskId)?.kind === "qa")
				throw new Error("A QA task cannot parent implementation work.");
			current = task.parentTaskId;
		}
	};
	for (const task of tasks) roots.set(task.taskId, rootOf(task.taskId));
	return {
		rootOf: (taskId: string) => roots.get(taskId) ?? null,
		workFor: (rootTaskId: string) =>
			tasks.filter((task) => task.kind !== "qa" && roots.get(task.taskId) === rootTaskId).map((task) => task.taskId),
	};
}
