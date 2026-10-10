# Miniclaw runtime migration

This document is the migration ledger for replacing the Claude Agent SDK
execution engine with the Pi Agent Runtime while keeping the existing host,
IPC, workspace, memory, channel, scheduler, and delivery contracts stable.

## Before architecture

The container runner previously owned a Claude `query()` / `MessageStream`
loop directly. Claude SDK messages were interpreted by `StreamEventProcessor`,
Claude MCP tools were created with the SDK `tool()` helper, and Claude session
transcripts were resumed from the provider-specific session directory. The
host process only saw the framed `ContainerOutput` protocol.

## Current architecture

The runner now has a runtime-neutral contract in
`container/agent-runner/src/runtime/types.ts`. Pi is the product runtime and
the compiled/container entry point is `container/agent-runner/src/pi-index.ts`.
The old Claude runner is retained only as an uncompiled rollback reference;
the production entry point fails fast if `AGENT_RUNTIME=claude` is requested.
The Pi path is composed of:

- `PiRuntimeAdapter`: Pi `ModelRuntime`, `SessionManager`, `DefaultResourceLoader`,
  skills, extensions, and `AgentSession` construction.
- `PiRuntimeSession`: Pi event/session methods mapped to runtime-neutral events.
- `adaptClaudeMcpToolsToPi`: existing capability handlers exposed as Pi custom
  tools under the stable `mcp__miniclaw__*` names.
- `PiSubAgentAdapter`: the documented `pi-subagents` spawn/stop RPC and
  lifecycle event bridge. Result lookup and steering remain explicit extension
  tool operations because the installed package does not publish those RPCs.
- `runPiQueryAttempt`: the runtime-neutral session is projected back into the
  existing `ContainerOutput` and durable IPC turn protocol.

The host and web layers do not select or inspect the runtime. They continue to
consume the existing framed output and delivery receipts.

## Capability matrix

| Existing capability  | Pi implementation                                                                                          | Status                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Prompt and streaming | `AgentSession.prompt()` + runtime event adapter                                                            | Implemented                                   |
| Tool calling         | Pi custom tools; Miniclaw handlers are reused                                                             | Implemented                                   |
| Session persistence  | Pi `SessionManager` in the per-group Pi session directory                                                  | Implemented                                   |
| Resume               | Open the Pi JSONL session by session id                                                                    | Implemented for Pi-created sessions           |
| Abort                | `AgentSession.abort()` and IPC interrupt sentinel                                                          | Implemented                                   |
| Steer / follow-up    | `AgentSession.followUp()` for queued IPC turns                                                             | Implemented in Pi bridge                      |
| Compaction           | Pi native session compaction; product toggle maps to `SettingsManager.setCompactionEnabled` via `autoCompactEnabled`; legacy percentage/window knobs advisory | Implemented; live-model validation pending |
| Skills               | Pi `DefaultResourceLoader` skill paths                                                                     | Implemented                                   |
| Workspace memory     | Existing Miniclaw MCP handlers, adapted as Pi tools                                                       | Implemented in Pi path                        |
| MCP/capabilities     | In-process capability handlers, namespaced as Pi tools                                                     | Implemented                                   |
| Subagents            | `@tintinweb/pi-subagents` extension plus adapter                                                           | Implemented; result/steer are extension tools |
| Background subagents | `run_in_background` is passed through the extension tool contract                                          | Validation pending                            |
| Providers            | Pi `ModelRuntime`, including Anthropic-compatible custom endpoints                                         | Implemented                                   |
| Web search/fetch     | No silent Pi substitute; these Claude-only built-ins are omitted until a Pi capability adapter is selected | Explicit limitation                           |

## Packages

The runner pins:

- `@earendil-works/pi-coding-agent@0.84.2`
- `@tintinweb/pi-subagents@0.16.1`
- `typebox@1.3.7`

Pi core intentionally leaves MCP and subagent behavior to extensions or
custom-tool adapters. The migration therefore keeps Miniclaw capability
authorization in the existing context and handler layer instead of creating a
second unrestricted MCP server.

## Compatibility decisions

- `AGENT_RUNTIME` defaults to `pi`. A Claude selector is rejected by the
  production Pi-only entry point rather than silently changing engines.
- `MINICLAW_*` environment variables and stored session/database identifiers
  remain readable while the branding migration introduces Miniclaw defaults.
- Claude MCP tool names are preserved as `mcp__miniclaw__<name>` in Pi so
  prompt and capability policy references remain stable.
- Unsupported Pi mappings fail explicitly or remain visible in this matrix;
  they are not silently routed to Claude.
- Claude model support is retained through Pi's Anthropic provider path; using
  an Anthropic model does not imply using the Claude Agent SDK runtime.

## Rename policy

The product-facing name is moving from Miniclaw to Miniclaw. Existing
environment variables, database keys, workspace paths, cookie names, and
deployment identifiers are compatibility surfaces and must not be changed
without a migration alias. New Miniclaw aliases should take precedence, with
the old Miniclaw values accepted as fallbacks.

Rename status: package metadata, README, CLAUDE.md, web title, settings
sections, channel onboarding texts, login/about pages, CLI/status output,
runtime identity and bootstrap prompts, MCP tool descriptions, subagent
contract text, and the built-in default Agent profile name (new installs and
lazy legacy migration) now use Miniclaw. Kept as compatibility surfaces:
`MINICLAW_*` env vars, `mcp__miniclaw__*` tool names, `miniclaw_owner_profile`
capability, localStorage/IndexedDB keys, `__MINICLAW_HASH_ROUTER__`, PWA
legacy cleanup, cookie aliases, the published Docker image name, and the
`miniclaw-backup-*` archive naming.

## Verification ledger

Baseline before runtime code changes:

- `npm run build:all`: passed after dependencies were installed.
- `npm run typecheck`: passed.
- `npm test -- --run`: 2848 passed, 23 skipped, 1 pre-existing failure in
  `tests/backup-restore-safety.test.ts` (hard-linked runtime archive safety).
- `npm run format:check` and `npm run docs:check` cannot run in this checkout
  because the workspace has no `.git` metadata and those scripts call `git`.

Final state after branding and compaction mapping:

- `npm run build:all`: passed (backend, web, agent-runner).
- `npm run typecheck`: passed.
- `npm test -- --run`: 2850 passed, 23 skipped, 1 pre-existing failure in
  `tests/backup-restore-safety.test.ts` (same hard-link archive safety case;
  unchanged from baseline).
- Changed source files were checked against Prettier; only the one file whose
  wrap point moved due to the rename was reformatted. Pre-existing style
  deviations in untouched files were left alone.

Migration slices verified:

- root, web, and runner TypeScript builds pass;
- the Docker entrypoint and host-mode spawn both run `dist/pi-index.js`;
  `src/index.ts` orphan cleanup matches the same `pi-index` pattern;
- the runner dependency tree contains Pi packages and no Claude Agent
  SDK/Claude Code packages (`@anthropic-ai/sdk` appears only as Pi's own
  transitive HTTP client for Claude-model access);
- the compiled `pi-index.js` closure contains no Claude SDK imports;
- `pi-index.ts` fails fast when `AGENT_RUNTIME` is not `pi`;
- Pi session construction smoke test passes without a live model
  (construct, subscribe, abort, dispose);
- Pi subagent extension session construction smoke test passes;
- focused runtime migration and subagent contract tests pass;
- full branding sweep: zero user-visible `Miniclaw` strings remain in
  `web/src`, `src`, runner prompts, or scripts; only documented compatibility
  surfaces keep the legacy name.

Remaining acceptance items that require a live model endpoint and a running
instance (not available in this checkout): end-to-end prompt/stream/tool
round trips, real compaction, background subagent completion, resume-after-
restart, and the Web/IM delivery path. The runtime-neutral contract, adapters,
and unit/integration coverage for each are in place.

## Known risks

- Existing Claude session ids cannot be resumed as Pi transcript ids; switching
  runtimes requires a fresh Pi session unless a history migration is added.
- `pi-subagents` is third-party code and its tool/event contract is pinned to
  the installed version.
- Pi does not provide Claude's WebSearch/WebFetch built-ins; a first-class Pi
  capability adapter is still needed for parity.
- The historical `AUTO_COMPACT_PERCENTAGE`/`AUTO_COMPACT_WINDOW` product knobs
  are now advisory: Pi runs native reserve-based compaction and decides its own
  threshold. The runtime contract exposes `autoCompactEnabled` and the Pi
  adapter maps it to `SettingsManager.setCompactionEnabled`; the percentage
  inputs no longer steer the trigger point.
- The built-in main Agent is renamed to Miniclaw; existing databases keep
  stored `Miniclaw`/`Default Agent` default-profile names until the next
  read, which lazily migrates them (one-time version bump and identity-hash
  recompute, so the main agent's sessions restart once).
- `src/index.ts` (host entry) and `container/agent-runner/src/index.ts` plus
  `runtime/claude/` remain as a rollback reference. They are not reachable
  from the package main, Docker entrypoint, or host-mode runner path and
  should be deleted after the transcript rollback window closes.
