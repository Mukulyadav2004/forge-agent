# Agent definition

The canonical executable inline agent specification is in `src/agent/ForgeSession.ts` (the `sessions.create` call). It takes the configured model from VS Code settings. The extension registers its current editor MCP connection under a name specific to the window and attaches that connector to the session. It enables only `read_file`, `list_files`, and `propose_edit`, with explicit approval for `propose_edit`. TrueForge owns the agent loop.

A separate deployment definition will be extracted when a real configured model/server is validated. There is deliberately no second JSON specification to keep synchronized at this stage.

The instructions are owned by `src/agent/instructions.ts`. The runtime disables OpenUI, interactive question tools, dynamic subagents, the sandbox, and web search until the extension supports their interactions. Architecture requests include bounded source context from `src/context/projectContext.ts`; all model/tool iteration still runs in TrueForge.
