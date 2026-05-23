# Architecture Decision Records

Decisions that shape `prisma-guarddog` live here. Each ADR captures one decision: the context, the choice, the consequences, and what was considered and rejected.

## Process

1. **One decision per file.** No bundling. Easier to amend or supersede individually.
2. **Filenames are numeric and immutable.** `NNNN-kebab-case-title.md`. Once merged, the number is forever.
3. **Status lifecycle:** `Proposed` → `Accepted` → `Superseded by NNNN` / `Deprecated`. Never delete or edit an ADR's substantive content after acceptance — supersede with a new one.
4. **Write before code.** ADRs are foundational; if a structural decision isn't worth writing down, it isn't worth making yet.

## Template

Copy [`template.md`](./template.md) for new ADRs.

## When to write a new ADR

- Choosing between materially different architectural options
- Reversing or amending a prior decision (supersede the old one)
- Codifying a constraint that future contributors must respect (e.g., "DDL must be idempotent")

## When NOT to write an ADR

- Implementation details that follow from a higher-level decision
- Coding-style or naming conventions (use `CLAUDE.md` / `AGENTS.md`)
- Bugfixes or feature additions that don't change architecture

## Index

See [`../README.md`](../README.md) for the full numbered table.
