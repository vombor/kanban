import { type ObjectiveReadResponse, objectiveReadResponseSchema, objectiveSchema } from "@runtime-objectives";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectObjectivesDialog } from "@/components/objectives/project-objectives-dialog";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	read: vi.fn(),
	recheck: vi.fn(),
	control: vi.fn(),
	limits: vi.fn(),
	create: vi.fn(),
	link: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string) => ({
		objectives: {
			list: { query: (input: unknown) => mocks.list(workspaceId, input) },
			read: { query: (input: unknown) => mocks.read(workspaceId, input) },
			recheck: { mutate: (input: unknown) => mocks.recheck(workspaceId, input) },
			control: { mutate: (input: unknown) => mocks.control(workspaceId, input) },
			setLimits: { mutate: (input: unknown) => mocks.limits(workspaceId, input) },
			create: { mutate: (input: unknown) => mocks.create(workspaceId, input) },
			manualLineage: { mutate: (input: unknown) => mocks.link(workspaceId, input) },
		},
	}),
}));
const id = "obj-00000000-0000-0000-0000-000000000001";
function response(title = "Alpha objective", requirements = "private-alpha-requirements"): ObjectiveReadResponse {
	const objective = objectiveSchema.parse({
		id,
		title,
		createdAt: "2026-10-18T10:00:00Z",
		updatedAt: "2026-10-18T10:00:00Z",
		revision: 1,
		requirementsHash: "a".repeat(64),
		policy: {},
		limits: {},
		tasks: [{ taskId: "dev01", kind: "dev", parentTaskId: null, attachedAt: "2026-10-18T10:00:00Z" }],
		attempts: [],
		status: "awaiting_evidence",
		handoff: {
			code: "evidence_missing",
			owner: "supervision",
			action: "wait_for_evidence",
			taskId: "dev01",
			since: "2026-10-18T10:00:00Z",
		},
		estimatedUsd: null,
		costCoverage: "unknown",
		finalCommits: [],
	});
	return objectiveReadResponseSchema.parse({ objective, requirements, handoffGuide: null });
}
function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("Uninitialized deferred");
	};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
describe("native project objectives", () => {
	let root: Root, container: HTMLDivElement;
	const close = vi.fn();
	beforeEach(() => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		for (const mock of Object.values(mocks)) mock.mockReset();
		close.mockReset();
		const data = response();
		mocks.list.mockResolvedValue({ objectives: [data.objective], total: 1, nextOffset: null });
		mocks.read.mockResolvedValue(data);
		mocks.recheck.mockResolvedValue(data);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});
	const render = async (workspaceId = "alpha", name = "Alpha") => {
		await act(async () =>
			root.render(<ProjectObjectivesDialog workspaceId={workspaceId} projectName={name} onClose={close} />),
		);
	};
	const click = async (text: string) => {
		const button = [...document.body.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
		if (!button) throw new Error(`Missing button ${text}`);
		await act(async () => button.click());
	};
	it("renders unknown cost and unavailable enforcement, showing owner facts without HTML/execution interpretation", async () => {
		mocks.read.mockResolvedValue(
			response("Alpha objective", "<script>private-alpha</script>\nSTATUS: DONE is only reference text"),
		);
		await render();
		await click("Alpha objective");
		expect(mocks.list).toHaveBeenCalledWith("alpha", { offset: 0, limit: 20 });
		expect(mocks.read).toHaveBeenCalledWith("alpha", { id });
		expect(document.body.textContent).toContain("Unknown");
		expect(document.body.textContent).toContain("enforcement unavailable");
		expect(document.body.textContent).toContain("awaiting evidence");
		expect(document.body.textContent).toContain("No qualified");
		expect(document.body.querySelector("script")).toBeNull();
		expect(mocks.recheck).not.toHaveBeenCalled();
	});
	it("rechecks only after the user clicks and does not invent completion or automatically retry failed evidence collection", async () => {
		await render();
		await click("Alpha objective");
		await click("Recheck retained facts");
		expect(mocks.recheck).toHaveBeenCalledExactlyOnceWith("alpha", { id });
		mocks.recheck.mockRejectedValueOnce(new Error("private upstream details"));
		await click("Recheck retained facts");
		expect(document.body.textContent).toContain("could not be confirmed");
		expect(document.body.textContent).not.toContain("private upstream details");
		expect(mocks.recheck).toHaveBeenCalledTimes(2);
	});
	it("clears old private content on project switch and ignores a late response from the previous project's detail request", async () => {
		const pending = deferred<ObjectiveReadResponse>();
		mocks.read.mockReturnValueOnce(pending.promise);
		await render();
		await click("Alpha objective");
		const beta = response("Beta objective", "private-beta-requirements");
		mocks.list.mockResolvedValueOnce({ objectives: [beta.objective], total: 1, nextOffset: null });
		await render("beta", "Beta");
		await act(async () => pending.resolve(response()));
		expect(document.body.textContent).toContain("Beta objective");
		expect(document.body.textContent).not.toContain("private-alpha-requirements");
		expect(document.body.textContent).not.toContain("Alpha objective");
	});
	it("closes/unmounts without retaining a late private detail response", async () => {
		const pending = deferred<ObjectiveReadResponse>();
		mocks.read.mockReturnValueOnce(pending.promise);
		await render();
		await click("Alpha objective");
		await act(async () => root.render(null));
		await act(async () => pending.resolve(response()));
		expect(document.body.textContent).not.toContain("private-alpha-requirements");
	});
	it("paginates without cancelling its evidence owner or losing the selected objective", async () => {
		mocks.list.mockResolvedValueOnce({ objectives: [response().objective], total: 21, nextOffset: 20 });
		await render();
		await click("Alpha objective");
		mocks.list.mockResolvedValueOnce({ objectives: [response("Page two").objective], total: 21, nextOffset: null });
		await click("Next");
		expect(mocks.list).toHaveBeenLastCalledWith("alpha", { offset: 20, limit: 20 });
		expect(document.body.textContent).toContain("Page two");
		expect(document.body.textContent).toContain("private-alpha-requirements");
		await click("Recheck retained facts");
		expect(mocks.recheck).toHaveBeenCalledWith("alpha", { id });
	});
	it("refreshes the selected facts through read only, retaining stale details with an explicit error if refresh fails", async () => {
		vi.useFakeTimers();
		await render();
		await click("Alpha objective");
		const newer = response();
		newer.objective.revision = 7;
		mocks.read.mockResolvedValueOnce(newer);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15000);
		});
		expect(document.body.textContent).toContain("Revision 7");
		expect(mocks.recheck).not.toHaveBeenCalled();
		mocks.read.mockRejectedValueOnce(new Error("private error"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15000);
		});
		expect(document.body.textContent).toContain("last retained response");
		expect(document.body.textContent).toContain("Revision 7");
		expect(document.body.textContent).not.toContain("private error");
		expect(mocks.recheck).not.toHaveBeenCalled();
	});
	it("does not hide an uncertain recheck outcome behind a successful list refresh", async () => {
		await render();
		await click("Alpha objective");
		mocks.recheck.mockRejectedValueOnce(new Error("unconfirmed"));
		await click("Recheck retained facts");
		await click("Reload list");
		expect(document.body.textContent).toContain("could not be confirmed");
		expect(mocks.recheck).toHaveBeenCalledTimes(1);
	});
	it("does not round a small observed cost to free or infer acceptance from priced usage", async () => {
		const data = response();
		data.objective.observedEstimatedUsd = 1e-9;
		data.objective.costCoverage = "partial";
		mocks.read.mockResolvedValueOnce(data);
		await render();
		await click("Alpha objective");
		expect(document.body.textContent).toContain("< $0.000001 (estimate)");
		expect(document.body.textContent).toContain("Unknown");
		expect(document.body.textContent).toContain("partial (not total spend)");
		expect(document.body.textContent).toContain("awaiting evidence");
	});
	it("ignores a late detail reply for an earlier selection in the same project", async () => {
		const second = response("Second objective", "private-second-requirements");
		second.objective.id = "obj-00000000-0000-0000-0000-000000000002";
		mocks.list.mockResolvedValueOnce({
			objectives: [response().objective, second.objective],
			total: 2,
			nextOffset: null,
		});
		const pending = deferred<ObjectiveReadResponse>();
		mocks.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(second);
		await render();
		await click("Alpha objective");
		await click("Second objective");
		await act(async () => pending.resolve(response()));
		expect(document.body.textContent).toContain("private-second-requirements");
		expect(document.body.textContent).not.toContain("private-alpha-requirements");
	});
	it("does not present an unreadable list as an empty project", async () => {
		mocks.list.mockRejectedValueOnce(new Error("private filesystem"));
		await render();
		expect(document.body.textContent).toContain("Could not load this project's objectives");
		expect(document.body.textContent).not.toContain("No objectives yet");
		expect(document.body.textContent).not.toContain("private filesystem");
	});
	it("fences an in-flight user recheck when the project changes, without replaying it", async () => {
		await render();
		await click("Alpha objective");
		const pending = deferred<ObjectiveReadResponse>();
		mocks.recheck.mockReturnValueOnce(pending.promise);
		await click("Recheck retained facts");
		const beta = response("Beta objective", "private-beta-requirements");
		mocks.list.mockResolvedValueOnce({ objectives: [beta.objective], total: 1, nextOffset: null });
		await render("beta", "Beta");
		await act(async () => pending.resolve(response()));
		expect(document.body.textContent).not.toContain("private-alpha-requirements");
		expect(document.body.textContent).toContain("Beta objective");
		expect(mocks.recheck).toHaveBeenCalledTimes(1);
	});
	const setText = async (label: string, value: string) => {
		const element = [...document.body.querySelectorAll("label")]
			.find((node) => node.textContent?.startsWith(label))
			?.querySelector("input,textarea,select");
		if (!element) throw new Error(`Missing field ${label}`);
		const prototype =
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: element instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: HTMLInputElement.prototype;
		await act(async () => {
			Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
			element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
		});
	};
	it("pauses only on an explicit audited user click and retries an uncertain control with the exact same identity/revision", async () => {
		const data = response();
		data.admissionScopeAvailable = true;
		mocks.read.mockResolvedValue(data);
		await render();
		await click("Alpha objective");
		await setText("Control audit reason", "Hold future admissions, preserve active tool");
		mocks.control.mockRejectedValueOnce(new Error("uncertain transport"));
		await click("Pause Kanban admission");
		expect(mocks.control).toHaveBeenCalledTimes(1);
		const payload = mocks.control.mock.calls[0]?.[1];
		expect(payload).toMatchObject({
			id,
			expectedRevision: 1,
			action: "pause",
			reason: "Hold future admissions, preserve active tool",
		});
		mocks.control.mockResolvedValueOnce({ ...data.objective, pausedByUser: true, revision: 2 });
		const paused = { ...data, objective: { ...data.objective, pausedByUser: true, revision: 2 } };
		mocks.read.mockResolvedValueOnce(paused);
		await click("Retry exact objective mutation");
		expect(mocks.control.mock.calls[1]?.[1]).toEqual(payload);
		expect(document.body.textContent).toContain("Kanban admission paused by user");
		expect(mocks.recheck).not.toHaveBeenCalled();
	});
	it("requires explicit boundary acknowledgement before setting enforced limits, with no automatic enablement or work execution", async () => {
		const data = response();
		data.admissionScopeAvailable = true;
		mocks.read.mockResolvedValue(data);
		mocks.limits.mockResolvedValue(data.objective);
		await render();
		await click("Alpha objective");
		expect(mocks.limits).not.toHaveBeenCalled();
		await setText("Admission mode", "enforce");
		await click("Save admission limits");
		expect(mocks.limits).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("explicitly acknowledge");
		const checkbox = [...document.body.querySelectorAll("label")]
			.find((node) => node.textContent?.includes("I acknowledge the Kanban-admission"))
			?.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!checkbox) throw new Error("No scope acknowledgement");
		await act(async () => checkbox.click());
		await click("Save admission limits");
		expect(mocks.limits).toHaveBeenCalledOnce();
		expect(mocks.limits.mock.calls[0]?.[1]).toMatchObject({
			expectedRevision: 1,
			acknowledgeAdmissionScope: true,
			limits: { mode: "enforce", unknownCost: "hold" },
		});
		expect(mocks.recheck).not.toHaveBeenCalled();
	});
	it("creates pinned requirements only from a user submission, retaining exact retry metadata without auto-starting a task", async () => {
		await render();
		await setText("Objective title", "User-owned acceptance");
		await setText("Pinned requirements", "Keep the known regression and closed benchmark verdict");
		await setText("Existing dev-task ids", "dev01");
		mocks.create.mockResolvedValueOnce(response("User-owned acceptance").objective);
		await click("Pin objective requirements");
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
			title: "User-owned acceptance",
			taskIds: ["dev01"],
			limits: { mode: "report" },
			policy: { requiredChecks: ["test"], requireQa: true },
		});
		expect(mocks.recheck).not.toHaveBeenCalled();
	});
});
