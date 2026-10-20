# Shared World voice-first View

Refs:
- roccho-dev/apps#2
- roccho-dev/adrs#387

## Canonical model

```text
Shared World = entities + typed relations
View         = query + projection
dimension    = needed only when a projection is geometrized
```

Time, causality, dependency, ownership, purpose, and evidence are typed relations/properties in the same Shared World.

Timeline, causal graph, dependency graph, table, map, and compact output are Views, not separate SSOTs.

## Product scale

```text
Purpose
  ↓
Feature
  ↓
Variant
```

Product meaning stays in `apps`.

Voice/type/touch are interaction capabilities, not Purpose packages.

A generic voice interaction may be promoted to `ui` after proven reuse; Hayamimi/runtime remains in `ops`.

## Target experience

```text
voice / type / touch
        ↓
Actor request
        ↓
Purpose
        ↓
Feature
        ↓
Shared World query
        ↓
projection
        ↓
graph / table / timeline / compact / agent input
```
