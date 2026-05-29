---
'@flowchestra/prisma-guarddog-core': patch
---

Fix `p.fn(name, ...args)` crashing with `s.replace is not a function` on `emit`/`diff`/`migrate` when the schema is loaded via the CLI (jiti) and the call has one or more arguments (#19).

`fnArgToExpr` discriminated arguments with `instanceof FluentExpr`. When the CLI loads `guarddog.ts` via jiti, the consumer's `col(...)` is a `FluentExpr` from jiti's module instance while the predicate builder runs in the CLI's instance — so `instanceof` is false across that realm boundary, and a `col(...)`/built-expression argument was mis-wrapped as a `literal` whose value was the `FluentExpr` object, then blew up in `formatLiteral`/`quoteString`. Zero-arg calls never hit the argument path, which is why they worked.

Now discriminates by duck-typing on `.ast` (the same way every other builder method handles `FluentExpr` arguments), so `p.fn` with arguments compiles correctly regardless of module-instance boundaries. Covered by a new full-CLI (jiti `loadSchema` → `emit`) regression test.
