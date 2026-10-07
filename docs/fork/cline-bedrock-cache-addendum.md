# DRAFT (not posted): addendum to "Bedrock prompt cache checkpoint stuck on the first user message in agent loops"

Addendum to the kit's draft `docs/upstream/cline-bedrock-cache.md` (in the kit home). Checked on **cline 3.0.69
(@cline/llms 0.0.91)**, 2026-10-07. Minified names are from `node_modules/@cline/llms/dist/providers.js`.

## 1. Same "last role=user" bug in the anthropic-cache-control path

The request builder `nw()` has two cache paths:

```js
if (Jp(e,t)) return ec(a), a;            // Bedrock: format "bedrock-cache-point"
if (!_i(e,t)) return a;                  // everyone else: format "anthropic-cache-control"
let n = Ge({modelId:e.modelId, family:pe(t)});
for (let o = a.length-1; o >= 0; o--) if (a[o]?.role === "user") { Up(a[o], e.providerId, n); break }
```

The second loop (providers with `routing.promptCache.format: "anthropic-cache-control"`: the OpenAI-compatible
gateways with `{matcher:"anthropic-compatible"}`, the `qwen` family route with `requiredCapability:"prompt-cache"`,
MiniMax) has the same bug as the Bedrock helper: in the AI-SDK message list tool results are `role: "tool"`, so in an
agent loop the marked message is always the original task prompt, and only system + tools + first prompt is cached.
`Up()` only marks `type: "text"` parts, so the fix there also has to mark the tool message's last tool-result part
(or the provider's equivalent), not just widen the role check. We haven't measured this path (our cards use Bedrock),
so this is from reading the code.

## 2. Bedrock route: Amazon Nova never gets a cache point

The Bedrock provider's routing is

```js
Zp = { routing: { promptCache: { format: "bedrock-cache-point", routes: [{ matcher: "anthropic-compatible" }] }, ... } }
```

so only Claude models get a `cachePoint`. The catalog marks Nova models `capabilities: [..., "prompt-cache"]` and has
cache prices (`amazon.nova-2-lite-v1:0`: cacheRead 0.0825), but no Nova session ever caches. Ours: 18 Nova 2 Lite
sessions, 320M input tokens, 0 cache reads, $20.64; one alone 31.4M input, $10.47.

AWS documents explicit caching for Nova 2 Lite (model card: min 1K tokens per checkpoint, max 4 checkpoints, 5 min
TTL, fields `system` and `messages`, "Nova models support a maximum of 20K tokens for prompt caching").
Direct Converse calls, `us.amazon.nova-2-lite-v1:0`, us-west-2:

| Request | Result |
| --- | --- |
| ~2.5K system + `cachePoint` in `system`, twice | write 2,528, then read 2,528 |
| ~23K system, `cachePoint` after the user text, twice (run twice) | write 22,861, then read 22,861; on the repeat run write both times (likely another region of the `us.` profile). No error above 20K |
| user turn `[toolResult, text, cachePoint]`, twice | write 3,321, then read 3,321 |
| user turn `[toolResult, cachePoint]` (Cline's shape for a `tool` message) | **400** `extraneous key [cachePoint] is not permitted` |
| assistant turn `[text, toolUse, cachePoint]` | **400**, same message |

So Nova can't just join the Anthropic route with the fix from the main report (last non-assistant message): for Nova
the checkpoint must follow a text block, which in Cline's message shapes means the last `role: "user"` message.
Suggested fix: a Nova route (`{matcher:"model-family", family:"nova", requiredCapability:"prompt-cache"}`, or per model
id) whose placement is "last user message", and the Anthropic route with "last non-assistant message".

Other Bedrock models we use reject a `cachePoint` outright (HTTP 403 "You invoked an unsupported model or your
request did not allow prompt caching"): `qwen.qwen3-vl-235b-a22b`, `mistral.mistral-large-3-675b-instruct`,
`deepseek.v3-v1:0`. Their model cards list no explicit caching (Mistral Large 3: implicit only), so they must stay
off the route.

## 3. Missing cost for some Bedrock models

Cline records no `metrics.cost` for `qwen.qwen3-vl-235b-a22b` and `mistral.mistral-large-3-675b-instruct` turns
(3 and 6 sessions here, 19.6M and 2.7M input tokens), although its catalog has prices for both ids (0.53/2.66 and
0.5/1.5). `deepseek.v3-v1:0` turns do get a cost. We haven't tracked down why; Kanban prices these turns from its own
table meanwhile.

## Workaround we use

`deploy/patch-cline-bedrock-cache.mjs` in the vombor/kanban fork, at image build time: a same-length rewrite of the
route check and the placement (`Jp`/`ec`). It's on for family `"nova"` with "last user message" and keeps
"last non-assistant message" for the Anthropic route. The anthropic-cache-control path (§1) is not patched.
