# AutoAI Seva Corporate Operations and RTPS Form QA

- Reference: official Bihar ServicePlus form captured at 1440 × 1000 from `serviceonline.bihar.gov.in`.
- Product viewports: 1440 × 1000 desktop and 390 × 844 mobile.
- User journey: search → multi-match confirmation → service preflight → application → secure draft resume → review.
- Operations journey: admin overview → filters → case controls → assignment → requirement/protected action → quality/SLA/escalation.

## Evidence

- `output/playwright/official-rtps-form-reference.png` — current official Bihar ServicePlus visual reference.
- `output/playwright/seva-preflight-desktop.png` — truthful service preflight with non-government disclaimer.
- `output/playwright/rtps-application-step-desktop.png` — bilingual desktop application form.
- `output/playwright/rtps-application-production-mobile.png` — production-build mobile application form.
- `output/playwright/seva-operations-admin-final.png` — dark corporate admin operations workspace after final metric-card and filter-layout QA.

## Comparison

The implementation uses the official form's plain bilingual section hierarchy, mandatory markers, dense two-column desktop fields, pale instruction panel, flat borders and explicit declaration/review flow. It deliberately keeps AutoAI navigation and security notices distinct so the product cannot be mistaken for an official government portal.

The operations workspace uses the existing AutoAI shell with a dark, high-contrast command surface, structured capacity form, live metrics, server-side filters and a case-control panel. Application forms remain light and simple; agent/admin operations remain dark and information-dense.

## Findings and fixes

- [P1 fixed] Search previously created a task before the user confirmed the correct service; discovery is now non-mutating.
- [P1 fixed] Drafts were device-only; server drafts now resume with optimistic version conflict handling.
- [P1 fixed] Sensitive draft fields now use encrypted persistence; OTP/password/CAPTCHA remain excluded.
- [P1 fixed] Quality-required cases could reach submission without review; backend gate and immutable decisions added.
- [P1 fixed] Operations metric cards inherited a light background and unreadable text; dark scoped cards added.
- [P1 fixed] Operations Search button collapsed vertically; deterministic responsive grid added.
- [P2 fixed] Form fields were presented as one long screen; RTPS-style steps and final review/edit links added.
- [P2 fixed] Agent assignment ignored specialization; service/category/department/queue/language matching added before least-load selection.
- [P2 fixed] Expected stream cancellation was logged as a browser error; intentional aborts are now silent.

## Verification

- Official reference and implementation inspected at matching desktop viewport.
- Desktop and 390px mobile application states render without clipping or horizontal overflow.
- Production target route console: 0 errors, 0 warnings.
- Full backend: 350 passed.
- Full frontend: 54 files, 277 passed.
- Production TypeScript/Vite build and build budgets passed.

final result: passed
