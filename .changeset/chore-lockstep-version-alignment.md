---
'@flowchestra/prisma-guarddog-core': patch
---

Adopt lockstep versioning. All `@flowchestra/*` packages are now a changesets `fixed` group, so they version and publish together at a single shared version from here on.

This realigns the suite after an alpha.6/alpha.7 split: two features (managed functions, then the column-privilege lint warning) released in two separate passes, leaving `@flowchestra/prisma-guarddog` + `…-lint` at alpha.7 and the rest at alpha.6. With the fixed group, this release brings every package up to the same alpha line.
