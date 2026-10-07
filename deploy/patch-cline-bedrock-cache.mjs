#!/usr/bin/env node
// patch-cline-bedrock-cache: fix cline 3.x's Bedrock prompt-cache checkpoint (verified on 3.0.68/3.0.69,
// @cline/llms 0.0.90/0.0.91). Same-length text replacements (space-padded), so it is safe on the Bun-compiled
// binary bin/.cline too. Two fixes, in the bundle's Bedrock cache-point helpers (minified names vary per copy):
//
// 1. Placement (Anthropic). @cline/llms puts its single message-level `cachePoint` on the LAST message with role
//    "user". In the AI-SDK message format tool results have role "tool", so in an agent loop the "last user
//    message" stays the original task prompt: only system + tools + first prompt is ever cached (opus f496b 10/06:
//    every turn read exactly 13,146 cached tokens of up to 275K; 25.2M input, $107). The fix marks the last
//    non-assistant message (user OR tool), so the checkpoint moves with the conversation, as the Anthropic writer does.
// 2. Route (Amazon Nova 2 Lite, catalog family "nova"). The Bedrock route only places a cachePoint for
//    {matcher:"anthropic-compatible"}, so Nova sessions never cached (31.4M input, $10.47 in one session). Nova does
//    take a Converse cachePoint (verified 10/07: write 2,528 then read 2,528), but only after a text block: one after
//    a toolResult (a "tool" message) or after a toolUse (an assistant message) is a 400 "extraneous key [cachePoint]
//    is not permitted". So Nova keeps the checkpoint on the last role "user" message (cline's original rule).
//    Qwen3-VL, Mistral Large 3 and DeepSeek V3.1 answer any cachePoint with a 403, so they stay off the route.
//
// The route check (`Jp`) records "user messages only" on the placement function (`ec.n`); cline calls it right before
// the placement (`if(Jp(e,t))return ec(a),a;`). Roles compare as strings: "user" >= "u" keeps only user messages,
// >= "b" skips only "assistant". When the route region isn't found but the old placement loop is, only fix 1 is
// applied and a WARNING is printed.
// Usage: node patch-cline-bedrock-cache.mjs <file>... [--check]
//   Idempotent. Exit 1 when a file can't be fully patched (fix 2 missing), after writing what did apply.
import fs from "fs";

const CHECK = process.argv.includes("--check");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// The four helpers, adjacent in every copy (names from @cline/llms 0.0.91 dist/providers.js):
// function b5(e,t){...family:pe(t),capabilities:t.model.capabilities}))}function Jp(e,t){return b5(e,t)!==void 0}
// function W5(){return{bedrock:{cachePoint:{type:"default"}}}}function ec(e){for(let t=e.length-1;t>=0;t--){let i=e[t];
// if(i?.role!=="user")continue;i.providerOptions={...i.providerOptions,...W5()};return}}
// The placement condition is either cline's original or fix 1 alone (`i.role[0]=="a"` padded by two spaces).
const ROUTE_RE = new RegExp(
	[
		String.raw`(family:([\w$]+)\(\w\),capabilities:\w\.model\.capabilities\}\)\)\})`,
		String.raw`function ([\w$]+)\((\w),(\w)\)\{return ([\w$]+)\(\4,\5\)!==void 0\}`,
		String.raw`function ([\w$]+)\(\)\{return\{bedrock:\{cachePoint:\{type:"default"\}\}\}\}`,
		String.raw`function ([\w$]+)\((\w)\)\{for\(let (\w)=\9\.length-1;\10>=0;\10--\)\{let (\w)=\9\[\10\];`,
		String.raw`if\((?:\11\?\.role!=="user"|\11\.role\[0\]=="a" *)\)continue; *`,
		String.raw`\11\.providerOptions=\{\.\.\.\11\.providerOptions,\.\.\.\7\(\)\};return\}\}`,
	].join(""),
	"g",
);
const ROUTE_DONE_RE =
	/function ([\w$]+)\((\w),(\w)\)\{return\(([\w$]+)\.n=[\w$]+\(\3\)=="nova"\)\|\|[\w$]+\(\2,\3\)!==void 0\}function [\w$]+\(\)\{return\{bedrock:\{cachePoint:\{type:"default"\}\}\}\}function \4\(\w\)\{let \w=\w\.findLast\(/g;

// Fix 1 alone: for(let X=E.length-1;X>=0;X--){let V=E[X];if(V?.role!=="user")continue;V.providerOptions={...V.providerOptions,...
const PLACEMENT_RE = /if\((\w+)\?\.role!=="user"\)continue;(\1)\.providerOptions=\{\.\.\.\1\.providerOptions,\.\.\./g;
const PLACEMENT_DONE_RE = /if\(\w+\.role\[0\]=="a"\)continue; *\w+\.providerOptions=\{\.\.\./g;

function pad(replacement, original, file) {
	if (replacement.length > original.length) throw new Error(`replacement longer than original in ${file}`);
	return replacement + " ".repeat(original.length - replacement.length);
}

function routeReplacement(match, groups, file) {
	const [b5Tail, pe, jp, e, t, b5, w5, ec] = groups;
	// the new placement's locals must not shadow the minified names it calls
	const [m, i, x] = ["m", "i", "x", "k", "q", "z"].filter((n) => n !== ec && n !== w5);
	const rest =
		`function ${jp}(${e},${t}){return(${ec}.n=${pe}(${t})=="nova")||${b5}(${e},${t})!==void 0}` +
		`function ${w5}(){return{bedrock:{cachePoint:{type:"default"}}}}` +
		`function ${ec}(${m}){let ${i}=${m}.findLast((${x})=>${x}.role>=(${ec}.n?"u":"b"));` +
		`if(${i})${i}.providerOptions={...${i}.providerOptions,...${w5}()}}`;
	return pad(b5Tail + rest, match, file);
}

let bad = 0;
for (const f of files) {
	const buf = fs.readFileSync(f);
	const text = buf.toString("latin1"); // byte-preserving
	let routed = 0;
	let out = text.replace(ROUTE_RE, (m, ...groups) => {
		routed++;
		return routeReplacement(m, groups.slice(0, 8), f);
	});
	const routeDone = (text.match(ROUTE_DONE_RE) || []).length;
	let placed = 0;
	let placementDone = 0;
	if (!routed && !routeDone) {
		out = text.replace(PLACEMENT_RE, (m, v) => {
			placed++;
			const head = `if(${v}?.role!=="user")continue;`;
			// fix 1 only: drop the optional chaining ("?." → ".", messages here are never null) to fit the length.
			return pad(`if(${v}.role[0]=="a")continue;`, head, f) + m.slice(head.length);
		});
		placementDone = (text.match(PLACEMENT_DONE_RE) || []).length;
	}
	console.log(
		`${f}: route+placement ${routed} to patch, ${routeDone} already patched` +
			(routed || routeDone ? "" : `; placement only ${placed} to patch, ${placementDone} already patched`),
	);
	if (!routed && !routeDone) {
		bad++;
		console.error(
			placed || placementDone
				? `WARNING: ${f}: Bedrock route region not found, Nova prompt caching NOT enabled (Anthropic placement fix only)`
				: `WARNING: ${f}: no Bedrock cache-point code found, nothing patched (check upstream)`,
		);
	}
	if ((routed || placed) && !CHECK) {
		const outBuf = Buffer.from(out, "latin1");
		if (outBuf.length !== buf.length) throw new Error(`length changed in ${f}`);
		const st = fs.statSync(f);
		fs.writeFileSync(f, outBuf);
		fs.chmodSync(f, st.mode);
	}
}
process.exit(bad ? 1 : 0);
