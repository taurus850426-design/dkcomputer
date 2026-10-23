# Budget-aware customer configuration

The current needs flow uses `builder-fit.js` to combine use, resolution, explicit medium/high/ultra quality, a 60/144/240 FPS planning target, workload, appearance and the tower-parts budget. Windows, monitors and peripherals remain optional separate purchases. CoolPC snapshot prices are reference prices, not DK stock or a final quotation.

The solver compares compatible CPU/platform/RAM generations and NVIDIA variants, including DDR4 budget platforms. It retains low-cost paths and platform alternatives alongside useful affordable upgrades, then chooses complete builds within the stated budget. A bounded search and explicit planning priorities are used; the result is not a proof of a globally optimal configuration or measured FPS. Extra budget is not spent on higher specifications without an assigned use priority.

The customer can compare the lowest-cost target candidate, a budget-constrained recommendation and a meaningful upgrade. When a target is too expensive, a separate medium-quality/60 FPS compromise may be offered at the SAME resolution and appearance. It must be confirmed before adoption, even if no previous build is selected. If it is still too expensive, the remaining difference is shown honestly. Missing hardware is left missing, never represented as a complete affordable tower.

Full listing prices, known compatibility, actual GPU VRAM, CPU platform, RAM generation/capacity/modules and selected-GPU PSU requirements are checked. Existing supplied/owned parts are preserved and do not receive invented prices. Unknown software and unparsed advanced requirements stay explicitly uncovered.

`fitVersion: 1` identifies the new client planning path; the earlier pure requirement compiler remains for legacy callers and the disabled research backend. No database migration, provider deployment or paid lookup was introduced.

## Evidence scope

Official sources were checked on 2026-10-23:

- VALORANT specs: <https://playvalorant.com/zh-tw/specs/>. Separate FPS reference hardware exists, but resolution/settings are not fully specified.
- PUBG support requirements: <https://support.pubg.com/hc/en-us/articles/115002108373-What-are-the-minimum-and-recommended-requirements-to-play-PUBG>. General and competitive guidance differ; these are not a current 1440p benchmark of the selected tower.
- Cyberpunk 2077 requirements: <https://support.cdprojektred.com/en/cyberpunk/pc/installation-sp/issue/1556/cyberpunk-2077-system-requirements>. Resolution, presets and ray tracing have distinct requirements.
- NVIDIA RTX 5060 family: <https://www.nvidia.com/en-sg/geforce/graphics-cards/50-series/rtx-5060-family/>. The 1440p marketing comparison uses 5060 Ti 16GB and DLSS/frame-generation conditions. These numbers are not imported as native FPS promises.

CPU/GPU classes and search utility are explicit selection-policy priorities, not invented benchmark results. The UI and copied summary label FPS as a planning target, with ray tracing/frame generation excluded by default. References and scope limitations are available on the comparison page.

## Validation cases

Using the retained CoolPC snapshot, tests demonstrate that 2K office use needs no gaming GPU, light competitive titles can use different parts from PUBG, a 30,000 budget can select a DDR4 tower for LOL, increasing a PUBG budget changes GPU allocation, 144 FPS increases explicit CPU/RAM conditions, unaffordable goals are flagged and compromises retain 1440p until confirmed. Unit and browser coverage also verifies saved goals, custom/owned-part preservation, complete totals, preferred brands, all-white requests, unknown demands, missing 4K hardware, image fallbacks and mobile layout.
