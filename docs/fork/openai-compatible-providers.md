# OpenAI-compatible model servers (`providers.openaiCompatible`)

A model server that speaks the OpenAI chat API (Triton/TensorRT-LLM's router, vLLM, ...) is set up for Cline cards
with config only, no code (user request, 2026-10-12). Its entry in Kanban's `config.json`:

```json
{
  "providers": {
    "openaiCompatible": {
      "triton": {
        "name": "Triton (TensorRT-LLM)",
        "baseUrl": "http://triton.tailedf020.ts.net/v1",
        "local": true
      }
    }
  }
}
```

| Key | Required | What |
|---|---|---|
| `name` | yes | Cline's display name for the provider |
| `baseUrl` | yes | the OpenAI API base with its version path: where Cline sends chat completions and Kanban reads `GET <baseUrl>/models` |
| `apiKeyEnv` | no | the variable in Kanban's environment holding the server's key; `kanban setup-provider <id>` stores it in providers.json (never printed) and the pipeline checks never see it. None: a keyless server |
| `local` | yes | `true` for the user's own hardware: turns price at 0 and a QA card takes no cloud QA slot (`isLocalProvider()`) |
| `models.<model>.contextWindow` / `.maxTokens` | no | the window (and max output tokens) to write for a model when the server reports none or the wrong one |

The id (`triton`) is Cline's provider id, what a card's `-P` and a kit role's `provider` name. It can't be one of
the providers with their own setup code (`lemonade`, `bedrock`, `cline-pass`) or `cline`. A bad entry makes the whole
`providers` section fall back to its defaults, with an issue in `kanban config show` and doctor.

Kanban itself never writes config.json for this: add the entry by hand, then run `kanban setup-provider <id>` (the
user's, [setup-provider.md](setup-provider.md)).

## What `kanban setup-provider <id>` writes

Only the `<id>` entry of each file, after a backup into `<home>/backups/cline/`, atomically, and nothing when a file
changed meanwhile (src/setup/cline-openai-compatible-provider.ts):

- models.json `providers.<id>.provider`: `name`, `baseUrl`, `protocol: "openai-chat"`, `defaultModelId` (a model
  the entry has), and `capabilities: ["tools"]` for a new entry. The provider's other keys are kept.
- models.json `providers.<id>.models`: **never adds or removes a model**, and a `modelsSourceUrl` in the provider is
  dropped (Cline would offer every id it returns). That list is the orchestrator's: it is Cline's allow list. For each model it already has, the command fills in
  `contextWindow` from the config, else the server's list, else the window the entry already has, else
  **32768** (`OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW`, conservative, because Triton doesn't say what its engines
  allow). `maxTokens` comes from the config, else a quarter of the window, at most 32K. A local provider's models get
  zero prices. The command lists the server's models that aren't in the entry, and entry models the server doesn't list.
- providers.json `providers.<id>.settings`: `provider`, `baseUrl`, `model` (the stored one if the entry still has it,
  else `defaultModelId`) and `apiKey` from `apiKeyEnv`. Cline 3.0.70's TUI opens its sign-in screen for a keyless custom
  provider unless `baseUrl` **and** `model` are stored there, and models.json's `baseUrl` doesn't count. That was
  verified for Triton with a real `cline --tui` run in a throwaway `CLINE_DIR`/`CLINE_DATA_DIR`, 2026-10-12. So while
  the entry has no model, doctor warns that `<id>` cards would open the sign-in screen.

With the server down the command still writes the provider entries, but only the config's windows. Doctor's row
(src/doctor/openai-compatible-provider-checks.ts) runs the same plan and prints `kanban setup-provider <id>` for any
difference.

## What else Kanban does with it

- **Outage:** an unreachable server (refused, reset, DNS) is a provider outage: backoff retries, then recovery's
  outage hold. The probe is `GET <baseUrl>/models` (up on 200 with a model list). It is never counted as a model error.
- **Loading:** a server whose list has `loaded` per model (Triton's) answers the vet probe's "is the model loaded?",
  so a model that is still loading isn't counted as silence. A local provider's first reply also gets the load allowance.
- **Context windows** read from the list where a server sends them: `max_model_len` (vLLM), `context_length`,
  `context_window`.
- **Capacity:** `models.providerCapacity.<id>` is left unset unless the server reports a limit; none does today.
- **Vendors:** the ids are read through `getModelVendor()`'s family table (src/kits/policy.ts).
- **No model-list route:** Cline's `modelsSourceUrl` isn't used for these providers (see above).

## The user's Triton server (probed 2026-10-12, ~03:30 to 04:15Z)

`http://triton.tailedf020.ts.net`, behind envoy: a router in front of TensorRT-LLM servers, one port per model.
Facts as observed, read-only apart from three small chat completions:

- `GET /v1/models`: 200, OpenAI list of `qwen3.6-35b-a3b`, `ornith-1.5-35b-a3b`, `qwen3-coder-next`,
  `gemma-4-26b-a4b-it`, `laguna-s-2.1`, `glm-5.3-flash`, each `owned_by: "trtllm"` with `loaded: true|false`.
  It reports **no context window and no max output tokens**.
- `GET /health`: `{"status": "ok"}`. `GET /status`: `gpu_free_gib_min` and, per model it has started, `loaded`,
  `inflight`, `port`, `idle_seconds`. It reports **no limit on loaded models**. Two models were being loaded at once
  (one loaded, another loading), so it isn't one-at-a-time. Kanban sets no `models.providerCapacity.triton`.
- Every other path (`/`, `/v1/health`, `/metrics`, `/v2/...` KServe routes, `/v1/models/<id>`, `/openapi.json`, ...):
  404 `{"error": {"type": "router_error", ...}}`.
- Loads on demand: the first request to an unloaded `qwen3.6-35b-a3b` took **~8 min** (envoy upstream time 476 s).
  After about 5 min idle the model was unloaded again (`loaded: false`, `idle_seconds` 300), and the next Cline turn took
  ~2 min. No key was needed.
- `POST /v1/chat/completions`: works, streaming too (SSE `chat.completion.chunk`, `stream_options.include_usage`
  answered with usage). Reasoning comes as `reasoning_content` (and an empty `reasoning`). `max_tokens: 10000000` was
  accepted without an error, so nothing tells the window.
- **Tool calls don't work yet:** with `tools` given, `qwen3.6-35b-a3b` answered `tool_calls: []`, `finish_reason:
  "stop"`, and the call as Qwen's XML in `content` (`<tool_call><function=get_time><parameter=tz>UTC...`). In the real
  Cline TUI run the model "called" `editor` that way and Cline took it as a final text answer: the turn ended, no file
  was written. That has to be fixed on the server: TensorRT-LLM's OpenAI server needs a tool-call parser for the model.
  Until then Triton models can't do card work. Only `qwen3.6-35b-a3b` was tried; the others weren't loaded for this.
