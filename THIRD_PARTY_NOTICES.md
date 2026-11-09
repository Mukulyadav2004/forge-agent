# Third-party source attribution

## Cline editor preview

- Upstream: https://github.com/cline/cline
- Local fork used: https://github.com/Mukulyadav2004/myAiCodingAssistant
- Exact source commit: `7a7878cb52fc33967d8b464b3e3d899beac42d4d`
- Copyright: 2026 Cline Bot Inc.
- License: Apache License 2.0; the original license and copyright notice are retained in `licenses/Cline-Apache-2.0.txt`.
- Source: `apps/vscode/src/hosts/vscode/VscodeEditPreview.ts`.
- Adapted implementation: `src/editor/ClineEditPreview.ts`.
- Original import in Forge Agent: `4e1a109b966c47f7dcf2e7527d4251283937e613` (`buid apply and undo`), together with Forge Agent's transaction implementation. This repository started from scratch; the Cline source commit is not a Git ancestor.
- Changes: Forge URI scheme, instance-owned content store, cryptographic preview IDs, explicit disposal, options-object parameters, and immediate final diff rendering. Animation, decorations, Cline logging, and the Cline SDK executor connection are omitted. Exact matching of original/modified virtual-document URIs and focus-preserving preview behavior are retained.
- The real VS Code tests cover focus preservation, independent previews for the same path, closing only the selected preview, and leaving the real file unchanged before acceptance. `test/edits/realEditor.ts` includes an adaptation of the focus-preservation test from `apps/vscode/src/hosts/vscode/VscodeEditPreview.test.ts` at the same source commit.

The apply/undo transaction service and workspace guards are Forge Agent's implementation. No Cline agent loop, provider client, or disk-writing SDK executor is included.
