// The `runoffs` feature's landing veto (src/kits/land-veto.ts): a card that lost a decided runoff, or raced in a
// bench-only one, never lands, whoever asks (the board's Approve & land or "land or discard?", `kanban task done
// --land|approve|release-hold --land`, a PASS). The core landing gate asks; only this file reads runoffs.json for it.

import { getWatchdogWorkspacePaths } from "../../../state/kanban-home";
import type { KitLandVeto } from "../../land-veto";
import { describeRunoffLandBar, describeRunoffLoserWayOut, findRunoffBarringLand, readRunoffs } from "./runoffs-store";

export interface RunoffsLandVetoDependencies {
	/** runoffs.json of a workspace (default `<home>/data/<ws>/runoffs.json`). */
	getRunoffsPath?: (workspaceId: string) => string;
}

export function createRunoffsLandVeto(deps: RunoffsLandVetoDependencies = {}): KitLandVeto {
	const getRunoffsPath =
		deps.getRunoffsPath ?? ((workspaceId: string) => getWatchdogWorkspacePaths(workspaceId).runoffs);
	return {
		feature: "runoffs",
		vetoLand: async ({ workspaceId, card, held }) => {
			// No runoffs.json reads as no runoffs: nothing is vetoed.
			const runoff = findRunoffBarringLand((await readRunoffs(getRunoffsPath(workspaceId))).runoffs, card.id);
			if (!runoff) {
				return null;
			}
			return {
				reason: `Task "${card.id}" raced in runoff ${runoff.name}, which is ${describeRunoffLandBar(runoff)}; it must not land. ${describeRunoffLoserWayOut(card.id, held)}`,
			};
		},
	};
}
