# AutoAI Messages and Settings Mobile Design QA

- Source visual truth: Android Messages screenshot at `upload/01-Screenshot_20260729_124431.jpg` plus the user's Settings behavior description.
- Source pixel dimensions: 691 × 1536 px.
- Intended implementation viewport: Android mobile widths from 320–430 CSS px.
- State: authenticated peer Messages thread and Settings overview/detail categories.
- Implementation screenshot: unavailable.
- Density normalization: not possible without browser-rendered evidence.

## Full-view comparison evidence

The source screenshot shows approximately 130 px of empty space between the Messages composer and fixed mobile navigation. Source inspection and computed layout ownership identify two simultaneous bottom reserves: the app shell owns 77 CSS px for mobile navigation and `.um-page` adds another 76 CSS px. The screenshot also shows API message times that do not match the device clock because timezone-less UTC timestamps were parsed as local wall time.

This Work Mode session does not expose a cloud-browser navigation tool, so an authenticated implementation screenshot at the same viewport could not be captured. A valid source-versus-implementation image comparison therefore remains blocked.

## Focused region comparison evidence

Source focused-region evidence confirms the composer ends well above the mobile navigation rather than directly above the navigation reserve. Implementation capture is blocked. Additional required focused regions are the Settings title/header edge, horizontally scrolling category tabs, and section content after a category change.

## Findings

- [P1] Browser-rendered visual verification is unavailable.
  - Location: Settings header/tabs and Messages composer-to-navigation spacing.
  - Evidence: no callable cloud-browser navigation/capture tool is available in this session.
  - Impact: exact screenshot fidelity, device-specific safe-area values, and final pixel spacing cannot be certified from code/build output alone.
  - Fix: capture the authenticated Settings and Chat routes in a Work Mode browser that permits the local preview, then compare at the same Android viewport.

## Implemented fixes and code-level evidence

- Removed the duplicate Messages bottom reserve: `main` remains the single owner of the 77px mobile-navigation clearance and `.um-page` now adds zero.
- Reused the shared API timestamp parser so timezone-less backend values are treated as UTC and formatted in the device's real local timezone.
- Added semantic `dateTime` values and full local date/time tooltips to message timestamps.
- Added explicit native-runtime styling so Android's system status-bar inset is not applied again inside the Settings sticky header.
- Added scroll containment, scroll padding, compositor promotion, and scroll-anchor isolation to stabilize the Settings sticky header.
- On every category change, Settings content scrolls to the top and the active category is centered in the horizontal tab viewport.
- All existing Settings sections and their production handlers remain unchanged.
- Frontend tests: all passed, including timestamp, mobile navigation clearance, and native Settings sticky-header contracts.
- TypeScript and production Vite build: passed.
- `git diff --check`: passed.

## Required fidelity surfaces

- Fonts and typography: existing AutoAI typography and hierarchy are unchanged; visual verification blocked.
- Spacing and layout rhythm: duplicate Messages bottom reserve was removed and Settings scrolling ownership was made explicit; visual verification blocked.
- Colors and visual tokens: existing dark glass tokens and semantic accents are unchanged.
- Image quality and asset fidelity: no image or icon assets were replaced.
- Copy and content: no setting names, descriptions, routes, or feature controls were removed.

## Comparison history

- Attempt 1: requested a cloud-browser navigation/capture capability through tool discovery.
- Attempt 1 result: no browser navigation/capture tool was exposed in this session.
- No browser screenshot was available for a valid side-by-side comparison.

final result: blocked
