# Agent definition

The canonical executable inline agent specification is in `src/agent/ForgeSession.ts` (the `sessions.create` call). It takes the configured model and MCP connector name from VS Code settings. It enables only `read_file`, `list_files`, and `propose_edit`, with explicit approval for `propose_edit`. TrueForge owns the agent loop.

A separate deployment definition will be extracted when a real configured model/server is validated. There is deliberately no second JSON specification to keep synchronized at this stage.
