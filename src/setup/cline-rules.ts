// Cline rules `kanban setup` installs into Cline's global rules dir (~/.cline/rules; cline 3.x loads every file
// there into every Cline task). Kept byte-identical to the legacy kit's machine/cline-rules/*.md, so a machine set up
// by the kit reports them as installed. Each rule came from an incident (docs/team/HISTORY.md): bounded-output
// (archive/devteam-kit@0a3d1fc), keep-acting (@050d390), small-tool-calls (@8590bad), status-line (@ebde195),
// tool-call-json (@16879d1). The kit's dev-servers.md is Pawsome-specific and belongs in that project (plan §2.5).
export const CLINE_RULE_FILES: Readonly<Record<string, string>> = {
	"bounded-output.md": `# Keep command output small

Your context window is limited. One huge tool result can crash the session for good.
- Never run \`ls -R\`, \`find .\`, \`tree\`, or a bare \`grep -r\` from the repo root. They walk \`node_modules\`, \`.next\`, and \`.git\`.
- The built-in search/regex tool does NOT skip gitignored files. Don't point it at the repo root: \`playwright-report/index.html\` and \`coverage/\` are single huge lines, and one match returned 9 MB (de30c, 10/05). Give it a source folder (\`src\`, \`server\`, \`e2e\`) or use \`git grep\` instead.
- List the source like this: \`git ls-files | head -200\`, or \`git ls-files src server e2e\`.
- Search like this: \`git grep -n <pattern>\`, or \`grep -rn --exclude-dir={node_modules,.next,.git,coverage,playwright-report,test-results} <pattern> .\`
- Pipe anything that might be long through \`| head -100\` or \`| tail -100\`. Read big files in parts.
`,
	"keep-acting.md": `# Keep acting until the task is done

- Never end a turn by describing what you'll do next ("Now let me read the files:", "Next I'll add the tests."). If you know the next step, call the tool for it in the same reply.
- A reply with no tool call ends your turn and sends the card to review, so only reply without a tool call when the whole task is finished (or you're truly blocked; then say exactly what's blocking you).
- Before you stop, check the task's requirements and run its tests or typecheck. Don't stop halfway.
`,
	"small-tool-calls.md": `# Keep each tool call small

Your replies can be cut off at about 4096 output tokens (some models, e.g. Opus 5.5 on Bedrock in this Cline version). A cut-off reply is thrown away completely: the tool call never runs, the reply arrives empty and your turn ends.
- Keep each reply's tool call under about 200 lines / 2500 tokens of content.
- Write a big file in parts: create it with the first part, then add the rest with further edits.
- Don't put several large files or long plans into one reply.
`,
	"status-line.md": `# End every finished turn with a status line

When you stop (a reply with no tool call), the LAST line of that reply must be exactly one of these:

- \`STATUS: DONE\`: the whole task is finished and you ran its checks (tests, typecheck, build as the task asks).
- \`STATUS: BLOCKED: <one sentence>\`: you cannot continue without something outside your worktree, such as missing access, a broken environment you are not allowed to fix, or requirements that contradict each other.
- \`STATUS: NEEDS_INPUT: <your question>\`: the task is ambiguous and the answer changes what you build.

Put nothing after that line. Don't use BLOCKED for problems you can fix yourself: fix them. Don't report API, network or tool crashes; the system records those itself.
`,
	"tool-call-json.md": `# Tool calls must be valid JSON

Your tool calls sometimes fail with "emitted invalid JSON arguments". Every failure wastes a turn. Avoid them:

- Keep each tool call small. Never write a whole large file in one editor call. Create the file with the first ~80 lines, then add the rest in further edits of similar size.
- Inside string arguments, escape every \`"\` as \`\\"\`, every backslash as \`\\\\\`, and every newline as \`\\n\`. Take extra care with code that has template literals, regexes, Windows paths, or JSON inside strings.
- In shell commands, avoid nested quotes. Use single quotes on the outside (\`git commit -m 'feat: add auth'\`). For long or multi-line text, write it to a file first and pass the file (\`git commit -F /tmp/msg.txt\`).
- Don't put heredocs or multi-line scripts inside run_commands. Write the script to a file with the editor, then run the file.
- If a tool call fails with invalid JSON, don't resend the same payload. Split it into smaller pieces or simplify the quoting.
`,
};
