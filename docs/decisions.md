# Decisions

One line per decision. Detail lives in `docs/decisions/`.

| # | Date | Decision |
|---|---|---|
| [001](decisions/001-score-providers.md) | 2026-11-23 | Live scores come from a configurable primary and secondary provider behind one shared cache row per league and date; boards read it and never call a provider themselves; the host's entries always win. |
