# Opt-in code-review evaluator (issue #69)

This is a **separate host-operator evaluation mode**, not a replacement for interactive card QA. It never records
PASS/FAIL/STALLED on a card, starts agents, changes provider/model defaults, edits credentials, promotes models or
rewrites benchmark history. Normal QA still owns browser acceptance and its existing verdict-file contract.
Interactive CLI prompt/file validation is **not** claimed to enable native constrained decoding.

## Explicit invocation

```sh
kanban qa evaluate --profile /private/profile.json --suite /private/suite.json \
  --image <existing-immutable-64-hex-local-image-id> --out /private/new-evaluation
```

This defaults to a read-only dry-run: it validates operator inputs/image metadata and describes capabilities, but
makes no model request and runs no sandbox. Actual evaluation requires **both** `--execute` and
`--provider-idle-confirmed`. The latter is the user's attestation, not a native card-capacity reservation. Do not
contend with live inference work. Requests/variants execute sequentially on one selected model; no model is loaded,
unloaded, reconfigured or selected automatically by Kanban beyond the explicit provider request itself.

Use an unprivileged/rootless Linux operator host with Podman, not an inference/container/card process. Root/session callers are refused in every
isolation mode. Profile/suite files must be operator-owned regular files, not symlinks or group/other-writable files,
and at most 1 MiB each. The output must be a **new**, private directory outside Git application/shared workspaces,
with an existing parent. Existing output is refused, not resumed or overwritten. No live provider call is performed
by automated tests; fake-provider fixtures and independent offline CPU sandbox checks validate the implementation.

## Capability profile

```json
{
  "version": 1,
  "provider": "operator-selected-endpoint",
  "model": "operator-verified-thinking-model",
  "adapter": "openai-compatible",
  "baseUrl": "https://operator-endpoint.example/v1",
  "apiKeyEnv": "OPERATOR_QA_API_KEY",
  "capabilities": {
    "schema": "native_json_schema",
    "streaming": "sse",
    "outputTokenParameter": "max_tokens",
    "reasoning": {"kind": "enable_thinking", "transport": "chat_template_kwargs"},
    "evidence": "Operator-verified model/runtime capability and version reference"
  },
  "limits": {"maxOutputTokens": 1024, "requestTimeoutSec": 60}
}
```

Capabilities are **explicit operator declarations**, not guesses from a model name and not a certificate inferred
from HTTP 200 or schema-valid JSON. Check the actual model/runtime documentation and configuration first. Gemma-style
`enable_thinking` is sent only for that declared profile and explicit boolean variant, under `chat_template_kwargs`.
A reasoning-effort profile instead uses `{"kind":"reasoning_effort","values":["low","high"]}` and can select
`max_completion_tokens` as its output limit parameter. A non-thinking profile uses `{"kind":"none"}`. A variant's
`kind: none` omits controls; it does not prove that a provider's internal/default reasoning is disabled.

The supported direct adapter is the OpenAI-compatible chat-completions wire protocol. Other provider/CLI transports
use `adapter: unsupported` or `schema: unsupported` and produce an explicit no-request capability outcome. Unsupported
reasoning values or streaming also make no request. There is no silent plaintext fallback, universal thinking flag,
parser switch to expose raw thoughts, automatic capability probe, credential fallback or request retry. A provider
rejection stops the matrix, with a sanitized capability/HTTP outcome; unknown requests stop too, without replay.

Credentials are env references only; the tool does not read/write an agent's provider files. Authenticated HTTP to a
non-loopback endpoint requires explicit `allowInsecureHttpAuth: true`; prefer HTTPS. Redirects are refused. Provider
errors/bodies and echoed credentials are not printed or saved. Optional flat prices are
`{"inputPerMillion": 1, "outputPerMillion": 2}`; absent/invalid usage or absent pricing remains unknown, not zero.

## Trusted suite and named regression inputs

```json
{
  "version": 1,
  "id": "operator-clamp-controls-v1",
  "variants": [
    {"id":"thinking-off","reasoning":{"kind":"enable_thinking","enabled":false},"stream":false},
    {"id":"thinking-on","reasoning":{"kind":"enable_thinking","enabled":true},"stream":true}
  ],
  "cases": [{
    "id":"seeded-clamp-bug",
    "requirement":"Return value bounded to min and max.",
    "source":"exports.clamp=function(value,min,max){return value<min?min:value>max?min:value;}",
    "fixedSource":"exports.clamp=function(value,min,max){return Math.max(min,Math.min(max,value));}",
    "oracleSource":"exports.clamp=function(value,min,max){if(value<min)return min;if(value>max)return max;return value;}",
    "functionName":"clamp",
    "parameters":["value","min","max"],
    "expectedHasBug":true,
    "trustedTests":[
      {"inputs":{"value":5,"min":0,"max":10},"expected":5},
      {"inputs":{"value":11,"min":0,"max":10},"expected":10}
    ]
  }]
}
```

An evaluator suite has 1–5 cases and 1–2 explicit variants: at most ten requested model calls, no retries. Include
independent clean and seeded-bug controls, not just positive findings. The owner authors the requirement, signature,
expected label, tests, trusted oracle and canonical fix. They are verified in separate CPU executions **before** a
model request. A mismatched oracle/fix/control is a harness/fixture outcome, not a model rejection.

Functions must be synchronous, fixed-arity CommonJS exports with JSON inputs/outputs. Named keys must match the
declared signature exactly; argument order is the declared parameter list. There is no positional/nesting heuristic
or JSON repair. Closed native input/output shapes come from the owner's trusted examples, bounded to depth six.
Provide representative non-empty arrays/object shapes; unsupported/unknown shapes are reported without a request.
Throwing/non-JSON/asynchronous functions are outside this initial evaluation contract, not silently normalized.

The separate model output contract is **`kanban-code-review-v1`**. Its minimal clean result is exactly
`{"has_bug":false,"findings":[]}`. A finding needs non-null explanation, location and evidence, with a nullable
`regression`; executable regressions name an `inputs` object, `expected` JSON value and CommonJS `fixSource`.
Native requests carry the strict per-case JSON schema, and the receiver independently validates that same schema
and has-bug/findings consistency. Bad JSON, code fences, raw thoughts in final content, null explanations, unexpected
keys or wrong input nesting are not repaired into a successful answer.

Generated counterexamples are checked against the trusted oracle's independently computed expectation, then against
the original code and generated fix in separate containers. Model-provided expected outputs are never accepted as
the oracle. A schema-valid or classification-correct answer alone is not a verified finding. Clean false positives,
unverified regressions and unknown execution are reported separately.

## Isolation and lifecycle

Generated/trusted program bodies run **only** as stdin data to separate owned CPU containers, never via host eval,
an inference pod or a shared privileged workspace. The operator supplies an existing immutable local Node image;
the tool never pulls one. Image identity and a conservative image-env allowlist are checked; the operator must also
trust that image contains no embedded private data. No host/project/credential mount, GPU, browser or device is used.
Containers have network none, read-only root, no capabilities/new privileges, UID 65534, PID/memory/CPU limits and a
small temporary filesystem. The entrypoint is Node, not the image's normal app/agent startup.
User/system containers.conf defaults and automatic subscription/secret mounts are disabled for these child commands;
PID/IPC/UTS/cgroup namespaces are explicitly private. The subscription override uses Podman's upstream documented-in-source
`--default-mounts-file` behavior (`containers/container-libs` subscriptions.go), not edits to the host's configuration.

Kernel CPU limits and Podman's independent wall timeout bound code even if the operator client disappears. The host
watchdog also force-kills a stuck Podman client, verifies the exact generated owner label before killing/removing its
container, and verifies absence afterward. It never signals/removes the live pod or another owner's container.
Unknown ownership/cleanup stops further work and retains uncertainty; it is never converted to a passing regression.

A durable private `reservation.json` commits before any POST or sandbox execution. `progress.json` retains observed
rows; `report.json` records a completed or explicitly incomplete matrix. Lost/interrupted work is never resumed or
replayed automatically, and reusing its output directory is refused. Retain receipts and investigate unknown outcomes.
The default whole-run deadline is 300 seconds (`--max-total-sec`, 10–900); it is checked before more work, and an
already-started bounded operation can finish afterward. A canceled HTTP client does not prove server-side inference
stopped or spending was refunded.

Streaming uses a maintained bounded SSE parser; reasoning deltas are kept separate and discarded, never interpreted
as final JSON or saved as raw thoughts. A final stop plus stream completion is required; truncated/malformed output
does not become a clean verdict. Responses are bounded to 1 MiB and final text to 128 KiB.

Reports retain separate format assessment, classification correctness, false positives, independently verified
regressions, request latency, provider-reported token usage and optional flat cost estimates. Unknown values stay
unknown; estimates are not invoice totals or spending caps. Variant ids/settings and immutable suite/profile hashes
keep this contract distinct from old benchmark records. A small bounded A/B cohort—especially a fake-provider test—
does **not** establish that thinking or constrained decoding improves real QA, nor authorize model promotion/routing.
