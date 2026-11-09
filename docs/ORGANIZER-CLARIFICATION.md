# Selective editor-source reuse: organizer clarification

Status: not sent. The native browser connection timed out while opening the competition tab. This file is a prepared question, not organizer approval.

## What the supplied brief establishes

- Page 3 encourages reuse of editor-side open-source code, requires attribution and an exact source commit, and requires the agent loop to run on TrueForge.
- Page 6 permits the write-up's starting point to be an upstream repository and commit or "from scratch"; the repository requirements say to declare a fork point "if any".
- Page 11 requires an open-source submission licence compatible with reused upstream code.
- Pages 11-12 direct competition-rule questions to the Techfest Competition Portal's Doubt section and say queries sent by email will not be answered.

These passages explicitly allow a from-scratch starting point. A written answer can still confirm how the judges want selected borrowed files represented when there is no shared Git ancestry.

## Question for the competition portal's Doubt section

Subject: From-scratch repository with attributed Cline editor-source reuse

Our VS Code extension repository started from scratch. We later adapted Cline's read-only VS Code diff-preview component and a focus-preservation test from source commit `7a7878cb52fc33967d8b464b3e3d899beac42d4d`. The README declares the upstream URL, exact source commit, borrowed paths, changes and reasons, our initial commit, and the actual commit that introduced the adaptation. The upstream Apache-2.0 licence and copyright notice are preserved. All agent model/tool iteration runs on TrueForge.

Page 6 allows "from scratch" and asks for a fork point "if any". Is this selective source reuse acceptable without Cline's Git ancestry, and should judges review our history from our initial commit? The existing import is already in an apply/undo commit; we are preserving that history and will use dedicated attribution/import commits for future reuse. Please confirm whether any additional provenance format is required.

## Follow-up

After submitting, record the portal question reference here. Record the organizer's answer and date when received; do not describe this question as approved until an answer exists.
