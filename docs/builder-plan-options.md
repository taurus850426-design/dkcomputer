# Builder recommendation options

The needs flow now compares distinct plans before customization. Budget priority explicitly uses 1080p, the recommended plan retains the requested resolution, and the upgrade raises the graphics policy tier (or RAM/storage for office use). Identical complete selections collapse into one option. Missing NVIDIA tiers remain unavailable rather than silently switching vendors. Selecting a different resolution requires confirmation; existing custom/owned parts are retained.

Recommendations apply the requested mainstream board, RAM, SSD and PSU brand lists and NVIDIA GPUs from ASUS, Gigabyte or MSI. This is a selection preference, not a blanket quality or FPS certification. Customization retains other brands. Case and cooler selection continues to use known compatibility facts.

Every catalogue category has brand, source subgroup and price filters. The eight build steps additionally expose known category facts; unknown Wi-Fi, dimensions and other facts remain unknown. Filters never clear compatibility restrictions.

`builder-media.js` maps exact catalogue IDs AND complete product names to local images, product sources and check dates. The initial set contains eight verified model/color entries. Add individually verified entries as photos become available; do not reuse similar models or different colors. Missing images display an explicit placeholder. The selected case's actual product image is primary; the generic rotatable placement schematic remains an optional secondary view. Product marketing photos do not represent the exact assembled configuration. Model-specific photorealistic 3D and complete catalogue photo coverage are not implemented.

Validation: 83 regression checks passed, including plan uniqueness/prices/vendor preferences, unavailable 4K NVIDIA tiers, product identity and media files, UI draft/custom-photo preservation, desktop/mobile browsers, schema/provider mocks and disabled external research. After adding catalogue facets, the 25 affected UI/browser checks passed again. No live backend schema or paid research configuration changed.
