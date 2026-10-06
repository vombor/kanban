#!/usr/bin/env node
// patch-cline-bedrock-cache: fix cline 3.x's Bedrock prompt-cache checkpoint for Anthropic models.
// @cline/llms puts its single message-level `cachePoint` on the LAST message with role "user". In the AI-SDK
// message format tool results have role "tool", so in an agent loop the "last user message" stays the original
// task prompt: only system + tools + first prompt is ever cached (opus f496b 10/06: every turn read exactly
// 13,146 cached tokens of up to 275K; 25.2M input, $107). The fix marks the last non-assistant message
// (user OR tool), so the checkpoint moves with the conversation, as the Anthropic writer does.
// Same-length text replacement (space-padded) so it is safe on the Bun-compiled binary bin/.cline too.
// Usage: node patch-cline-bedrock-cache.mjs <file>... [--check]   (idempotent; exit 1 if a file has no match)
import fs from "fs";

const CHECK = process.argv.includes("--check");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// for(let X=E.length-1;X>=0;X--){let V=E[X];if(V?.role!=="user")continue;V.providerOptions={...V.providerOptions,...
const RE = /if\((\w+)\?\.role!=="user"\)continue;(\1)\.providerOptions=\{\.\.\.\1\.providerOptions,\.\.\./g;
let bad = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  const text = buf.toString("latin1"); // byte-preserving
  let n = 0;
  const out = text.replace(RE, (m, v) => {
    n++;
    const head = `if(${v}?.role!=="user")continue;`;
    const fixed = `if(${v}?.role=="assistant")continue;`;
    // pad/shrink to the original byte length: the fixed form is longer by 4, so drop the optional chaining
    // ("?." → ".", messages here are never null) and compare with a short literal instead.
    let rep = `if(${v}.role[0]=="a")continue;`;
    if (rep.length > head.length) throw new Error(`replacement longer than original in ${f}`);
    rep = rep + " ".repeat(head.length - rep.length);
    return rep + m.slice(head.length);
  });
  const already = (text.match(/if\(\w+\.role\[0\]=="a"\)continue; *\w+\.providerOptions=\{\.\.\./g) || []).length;
  console.log(`${f}: ${n} to patch, ${already} already patched`);
  if (!n && !already) bad++;
  if (n && !CHECK) {
    const outBuf = Buffer.from(out, "latin1");
    if (outBuf.length !== buf.length) throw new Error(`length changed in ${f}`);
    const st = fs.statSync(f);
    fs.writeFileSync(f, outBuf);
    fs.chmodSync(f, st.mode);
  }
}
process.exit(bad ? 1 : 0);
