# 0014 – License: GPL-3.0-or-later

Status: accepted · Date: 2026-11-16

## Context

DFYOM is open source. The license decides which libraries it may bundle: some of the best options for geometry and tracing are GPL (Potrace for raster tracing, CGAL for exact medial axis / straight skeleton – see [geometry.md](../architecture/geometry.md#open-questions)), and bundling them requires a GPL-compatible license for the whole app.

## Decision

DFYOM is licensed under the **GNU General Public License, version 3 or (at your option) any later version** (`GPL-3.0-or-later`). Full text: [LICENSE](../../LICENSE).

## Consequences

- GPL, LGPL and permissive (MIT, Apache-2.0, BSD, BSL, ISC) dependencies may all be used.
- Distributed builds and forks must provide source under GPL-compatible terms.
- Dependencies must stay GPL-3.0-compatible: no GPL-2.0-only, no proprietary or non-commercial-only licenses.
- "Or later" lets the project adopt future GPL versions without asking every contributor.
