# Agent definition

The canonical executable inline agent specification is in `src/agent/ForgeSession.ts` (the `sessions.create` call). It takes the configured model from VS Code settings. The extension registers its current editor MCP connection under a name specific to the window and attaches that connector to the session. It enables only `read_file`, `list_files`, and `propose_edit`, with explicit approval for `propose_edit`. The model must pass the opaque `base_revision` from `read_file` when staging an edit. Applying and undoing changes are user actions in the editor, not model tools. TrueForge owns the agent loop.

Sessions currently use the inline definition in `ForgeSession.ts`; there is no separate deployment manifest to synchronize.

For focused edits, `propose_edit` accepts optional inclusive `start_line` / `end_line` and replaces only those complete lines. The agent instructions prefer this over regenerating an entire file. The editor computes hunks locally; Accept hunk saves through the guarded transaction service, while Reject hunk leaves those lines unchanged. Neither action introduces another agent loop or model-facing apply tool.

The instructions are owned by `src/agent/instructions.ts`. The runtime disables OpenUI, interactive question tools, dynamic subagents, the sandbox, and web search until the extension supports their interactions. Architecture requests include bounded source context from `src/context/projectContext.ts`; all model/tool iteration still runs in TrueForge.
