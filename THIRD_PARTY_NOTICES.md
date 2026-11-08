# Third-party source attribution

## Cline editor preview

- Upstream: https://github.com/cline/cline
- Local fork used: https://github.com/Mukulyadav2004/myAiCodingAssistant
- Exact source commit: `7a7878cb52fc33967d8b464b3e3d899beac42d4d`
- Copyright: 2026 Cline Bot Inc.
- License: Apache License 2.0; the original license and copyright notice are retained in `licenses/Cline-Apache-2.0.txt`.
- Source: `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts`.
- Adapted implementation: `src/editor/ClineEditPreview.ts`.
- Changes: Forge URI scheme, instance-owned content store, cryptographic preview IDs, explicit disposal, options-object parameters, and immediate final diff rendering. Animation, decorations, Cline logging, and the Cline SDK executor connection are omitted. Exact matching of original/modified virtual-document URIs and focus-preserving preview behavior are retained.
- The real VS Code tests cover focus preservation, independent previews for the same path, closing only the selected preview, and leaving the real file unchanged before acceptance. These scenarios include an adaptation of Cline's `VscodeEditPreview.test.ts` focus-preservation test.

The apply/undo transaction service and workspace guards are Forge Agent's implementation. No Cline agent loop, provider client, or disk-writing SDK executor is included.
