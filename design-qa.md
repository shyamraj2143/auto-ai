# AutoAI Seva RTPS Form and Agent Portal QA

- Source visual truth: user-provided Operations Workspace and Employee Assistance screenshots in the active request.
- Government references: Bihar RTPS portal, official Income Certificate form, and Bihar Applicant User Manual.
- Intended viewports: 1280 × 720 desktop and 390 × 844 mobile.
- States verified: public agent login; completed assisted form; automatic agent queue assignment.
- Implementation evidence:
  - `.playwright-cli/page-2026-08-09T03-53-08-422Z.png` — desktop agent login.
  - `.playwright-cli/page-2026-08-09T03-53-38-098Z.png` — mobile agent login.
  - `.playwright-cli/page-2026-08-09T03-52-24-288Z.png` — submitted application workspace.
  - `.playwright-cli/element-2026-08-09T03-52-41-724Z.png` — automatic agent-processing panel.

## Full-view comparison evidence

The original Operations screenshot had low-contrast headings, dark form controls on a gray panel, and a narrow wrapped create-agent button. The updated government-style surface uses a light workspace, navy section headers, white high-contrast controls, flat borders, and a full-width create-agent action.

The original user flow contained a second Employee Assistance purpose/consent form after application completion. The updated flow removes that duplicate step. Submitting an ASSIST application creates or reuses the work order automatically and immediately displays case ID, queue/agent, current work, pending user actions, and timeline.

The RTPS reference uses simple bilingual labels, explicit required-field markers, dense two-column sections, declarations, preview, annexure/document handling, submission, and acknowledgement/status. The updated dynamic form follows those conventions while retaining AutoAI security boundaries for OTP, CAPTCHA, passwords, and final confirmation.

## Focused region comparison evidence

- Agent login: desktop and 390 px mobile views have no cropped title, overflow, or inaccessible controls.
- Application form: global dark-theme input overrides were detected in the first browser pass and replaced with scoped white government-form controls.
- Agent processing: the final focused screenshot contains no Purpose field, consent handoff card, or `Request employee help` button.
- Operations workspace: agent creation fields now use labeled grid rows and a stable full-row submit action.

## Findings and fixes

- [P1 fixed] Unreadable Operations workspace contrast and compressed create-agent action.
- [P1 fixed] Redundant Employee Assistance form after application submission.
- [P1 fixed] No discoverable agent-login entry from the public website or normal login page.
- [P2 fixed] Global Action Hub input styles overrode the RTPS form controls.
- [P2 fixed] Agent Workspace heading cropped at desktop width.
- [P2 fixed] Employee terminology remained in user-facing agent status copy.

## Verification

- Browser: desktop/mobile agent login rendered correctly.
- Browser: completed assisted form automatically created case `SEVA-2026-BDA0E394` and entered agent queue.
- Frontend: 53 test files, 276 tests passed.
- Backend Seva operations: 6 tests passed, including agent login, password lifecycle, assignment, capacity, suspension, and notifications.
- Production TypeScript/Vite build passed.
- Python seed module compilation passed.
- `git diff --check` passed.

final result: passed
