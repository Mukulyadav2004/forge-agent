// Prints the full TrueForge agent spec Forge Agent sends when it creates a session: src/agent/forge-agent.json
// plus the model, an example editor MCP server name and the instructions. Run through `pnpm run agent:spec [provider/model]`.
import { agentSpec } from '../out/agent/ForgeSession.js';

const model = process.argv[2] ?? 'google-gemini/gemini-3-1-flash-lite';
console.log(JSON.stringify(agentSpec({ model, connector: 'forge-editor-<window-id>' }), null, 2));
