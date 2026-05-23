# @flowchestra/prisma-guarddog-preset

Opinionated preset for Flowchestra: bundles the WorkOS JWT claim shape, the `app_user` / `app_system` dbRole pair, the canonical `tenant.*` / `workspace.*` / `workbench.*` appRole vocabulary, and the flat `Tenant → Workspace → Workbench` resource tree.

If you are **not** Flowchestra, don't import this — compose your own by calling the primitives in `@flowchestra/prisma-guarddog-core` directly. This package exists as a working reference for what a downstream preset looks like; see [ADR-0011](../../docs/adr/0011-extractable-core-with-flowchestra-preset.md).

## What lives here

- **`createFlowchestraGuarddog(opts?)`** — instantiate a `Guarddog` wired with every preset. Author policies by chaining off the return value.
- **`flowchestraClaims(opts?)`** — JWT claim shape with the canonical Supabase accessor (`request.jwt.claims`); override the accessor via `opts.accessor`.
- **`flowchestraDbRoles()`** — `app_user` (`NOLOGIN`) and `app_system` (`BYPASSRLS`, inherits `app_user`).
- **`flowchestraAppRoles()`** — `tenant.admin`, `workspace.{admin,editor,viewer}`, `workbench.{admin,editor,viewer}`.
- **`flowchestraResources()`** — flat `Tenant → Workspace → Workbench` tree.
- **`FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR`** — the string constant.

## Install

```sh
pnpm add @flowchestra/prisma-guarddog-preset
```

## 30-second usage

```ts
import { col } from '@flowchestra/prisma-guarddog-core'
import { createFlowchestraGuarddog } from '@flowchestra/prisma-guarddog-preset'

const guard = createFlowchestraGuarddog()

guard
  .model('Workspace')
  .policy('app_user')
  .select((p) => p.claim('tenantId').eq(col('tenantId')))
```

Or compose just the pieces you want:

```ts
import { defineSchema } from '@flowchestra/prisma-guarddog-core'
import {
  flowchestraAppRoles,
  flowchestraClaims,
  flowchestraDbRoles,
  flowchestraResources,
} from '@flowchestra/prisma-guarddog-preset'

export default defineSchema({
  claims: flowchestraClaims({ accessor: 'auth.claims' }),
  dbRoles: flowchestraDbRoles(),
  appRoles: flowchestraAppRoles(),
  resources: flowchestraResources(),
  policies(guard) { /* … */ },
})
```

## Where to read next

- [`docs/adr/0011-extractable-core-with-flowchestra-preset.md`](../../docs/adr/0011-extractable-core-with-flowchestra-preset.md) — why this lives outside core
- [`examples/flowchestra`](../../examples/flowchestra) — full schema authored on top of this preset
