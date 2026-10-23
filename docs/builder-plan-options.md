# Builder recommendation options

The needs flow now compares distinct plans before customization. Budget priority explicitly uses 1080p, the recommended plan retains the requested resolution, and the upgrade raises the graphics policy tier (or RAM/storage for office use). Identical complete selections collapse into one option. Missing NVIDIA tiers remain unavailable rather than silently switching vendors. Selecting a different resolution requires confirmation; existing custom/owned parts are retained.

Recommendations apply the requested mainstream board, RAM, SSD and PSU brand lists and NVIDIA GPUs from ASUS, Gigabyte or MSI. This is a selection preference, not a blanket quality or FPS certification. Customization retains other brands. Case and cooler selection continues to use known compatibility facts.

Every catalogue category has brand, source subgroup and price filters. The eight build steps additionally expose known category facts; unknown Wi-Fi, dimensions and other facts remain unknown. Filters never clear compatibility restrictions.

`builder-media.js` maps exact catalogue IDs AND complete product names to local images, product sources and check dates. The initial set contains eight verified model/color entries. Add individually verified entries as photos become available; do not reuse similar models or different colors. Missing images display an explicit placeholder. The selected case's actual product image is primary; the generic rotatable placement schematic remains an optional secondary view. Product marketing photos do not represent the exact assembled configuration. Model-specific photorealistic 3D and complete catalogue photo coverage are not implemented.

Validation: 83 regression checks passed, including plan uniqueness/prices/vendor preferences, unavailable 4K NVIDIA tiers, product identity and media files, UI draft/custom-photo preservation, desktop/mobile browsers, schema/provider mocks and disabled external research. After adding catalogue facets, the 25 affected UI/browser checks passed again. No live backend schema or paid research configuration changed.


## Guided display and catalogue image coverage

The desktop shell now uses up to 1840px with a compact introduction and an independently scrolling summary. The six-stage navigation shows the current stage and allows available paths without resetting the draft. Each step explains its purpose and next choices. Part steps have eight direct category links, a current-selection panel, a specification-based reason and explicit alternative/custom-entry actions.

Comparison cards show the active plan, four main components, price differences, always-visible reasons, and expandable complete configurations. Current parts use a responsive card grid. Reasons are shared between overview, comparison details and individual part selection, including why an available 32GB kit can exceed a 16GB minimum target. These remain selection-policy estimates, never FPS guarantees.

`builder-catalog-media.js` adds 2,092 exact normalized listing-name associations across CPU, board, RAM, SSD, air cooler, GPU, case and PSU categories. Source-assigned images are labeled reference imagery because series packaging, labels, capacities and included accessories can vary. The eight individually checked entries in `builder-media.js` take precedence. Twenty-one frequently used reference images are cached locally, covering 32 catalogue entries; the remaining references load from the public source. Missing or failed images show a readable fallback, and untrusted image paths or mismatched names cannot render.

Run `node scripts/sync-builder-media.mjs` manually to refresh associations without changing catalogue prices. It rejects empty categories and unexpected shrinkage, and preserves cached assets only for matching source image URLs. No runtime paid lookup or database writes are involved.

Validation: 64 regression checks passed. After final guidance/compact-header refinements, the 28 affected UI and desktop/mobile browser checks passed again, including 2048px width, 390px layout, visible reasons, media identity/path checks, saved custom drafts and an intentionally blocked image fallback.

QA previews: [Wide desktop](previews/builder-guided-wide.png), [Mobile part advice](previews/builder-guided-part-mobile.png).
