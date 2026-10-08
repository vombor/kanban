// Kit landing vetoes: what a kit feature may say against a land before the core's landing gate
// (src/server/task-landing-gate.ts) lands a card. A veto belongs to a built-in feature and is asked only for
// workspaces whose resolved kit lists that feature, so a `default` board (no features) is never vetoed. The core
// never reads a feature's own files: the team kit's `runoffs` veto reads runoffs.json (src/kits/team/runoffs/).
import type { RuntimeBoardCard } from "../core/api-contract";
import type { KitDocument, KitFeature } from "./kit-schema";

export interface KitLandVetoInput {
	workspaceId: string;
	card: RuntimeBoardCard;
	/** The card holds a pipeline hold (only a `hold_release` land gets this far with one). */
	held: boolean;
}

export interface KitLandVetoAnswer {
	reason: string;
}

export interface KitLandVeto {
	feature: KitFeature;
	vetoLand: (input: KitLandVetoInput) => Promise<KitLandVetoAnswer | null>;
}

/** The first veto of a feature the kit lists, with that feature's name; null = the land may go ahead. */
export async function findKitLandVeto(
	vetoes: readonly KitLandVeto[],
	kit: KitDocument,
	input: KitLandVetoInput,
): Promise<(KitLandVetoAnswer & { feature: KitFeature }) | null> {
	const active = new Set(kit.features ?? []);
	for (const veto of vetoes) {
		if (!active.has(veto.feature)) {
			continue;
		}
		const answer = await veto.vetoLand(input);
		if (answer) {
			return { ...answer, feature: veto.feature };
		}
	}
	return null;
}
