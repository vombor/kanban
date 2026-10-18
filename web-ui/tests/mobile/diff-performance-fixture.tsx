import { Profiler, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { type DiffLineComment, DiffViewerPanel } from "../../src/components/detail-panels/diff-viewer-panel";
import { FileTreePanel } from "../../src/components/detail-panels/file-tree-panel";
import type { RuntimeWorkspaceFileChange } from "../../src/runtime/types";
import "../../src/styles/globals.css";

const lines = Array.from({ length: 2400 }, (_, index) => `export const value${index} = ${index};`);
const oldText = `${lines.join("\n")}\n`;
const newText = `${lines.map((line, index) => (index === 1200 ? "export const value1200 = 'changed';" : line)).join("\n")}\n`;
const files: RuntimeWorkspaceFileChange[] = Array.from({ length: 100 }, (_, index) => ({
	path: `src/file-${String(index).padStart(3, "0")}.ts`,
	status: "modified",
	additions: 1,
	deletions: 1,
	oldText,
	newText,
}));

export function mountDiffPerformanceFixture(container: HTMLElement): void {
	createRoot(container).render(<DiffPerformanceFixture />);
}

export function DiffPerformanceFixture(): React.ReactElement {
	const [mounted, setMounted] = useState(false);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [comments, setComments] = useState(new Map<string, DiffLineComment>());
	const [split, setSplit] = useState(false);
	const [tick, setTick] = useState(0);
	const [sent, setSent] = useState("");
	const onRender = useCallback((_id: string, phase: string, actualDuration: number) => {
		performance.measure(`diff-${phase}`, { start: performance.now() - actualDuration, duration: actualDuration });
	}, []);
	return (
		<div className="flex h-screen flex-col bg-surface-0 text-text-primary">
			<div className="flex gap-3 p-2">
				<button
					type="button"
					onClick={() => {
						performance.clearMeasures();
						setMounted(true);
					}}
				>
					Mount fixture
				</button>
				<button type="button" onClick={() => setTick(tick + 1)}>
					Parent tick {tick}
				</button>
				<button type="button" onClick={() => setSplit(!split)}>
					Toggle split
				</button>
				<output aria-label="Sent comments">{sent}</output>
			</div>
			{mounted ? (
				<Profiler id="diff" onRender={onRender}>
					<div className="flex min-h-0 flex-1" data-testid="diff-fixture">
						<DiffViewerPanel
							workspaceFiles={files}
							selectedPath={selectedPath}
							onSelectedPathChange={setSelectedPath}
							comments={comments}
							onCommentsChange={setComments}
							viewMode={split ? "split" : "unified"}
							onAddToTerminal={setSent}
							onSendToTerminal={setSent}
						/>
						<FileTreePanel
							workspaceFiles={files}
							selectedPath={selectedPath}
							onSelectPath={setSelectedPath}
							panelFlex="0 0 180px"
						/>
					</div>
				</Profiler>
			) : null}
		</div>
	);
}
