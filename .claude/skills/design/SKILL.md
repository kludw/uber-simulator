---
name: design
description: Project code design rules - deep modules and information hiding (Ousterhout), type-driven design (illegal states unrepresentable, parse don't validate, branded IDs), DDD-lite (value objects, aggregates own invariants), functional core / imperative shell, AHA rule for abstractions. Use whenever designing or structuring modules, defining types/interfaces, deciding whether to extract or abstract, or reviewing code structure.
---

# Design

Goal: production code that stays easy to change. Complexity is the enemy; every rule below reduces it.

## 1. Deep modules (Ousterhout, primary)

1. Module = small interface, substantial hidden implementation. Judge by: how much does a caller need to know?
2. Information hiding: each design decision (grid geometry, matching strategy, event encoding, batching) lives in exactly one module. Changing it touches one place.
3. No shallow modules: no pass-through functions, no wrappers that only rename, no class/function per trivial step.
4. Interface designed for the common case. Callers shouldn't assemble 5 calls to do one thing.
5. Export the minimum. Unexported by default.
6. Comments explain *why* and non-obvious interface contracts. Never restate *what* the code does.

## 2. Type-driven design

1. Make illegal states unrepresentable. Entity state = discriminated union; each state carries only the fields valid in it:
   ```ts
   type Trip =
     | { state: "requested"; id: TripId; pickup: Cell; dropoff: Cell; requestedAt: Tick }
     | { state: "matched"; id: TripId; pickup: Cell; dropoff: Cell; requestedAt: Tick; driverId: DriverId }
     | ...
   ```
   No optional `driverId?` that "should be set after matching".
2. Parse, don't validate: Zod at the edge turns `unknown` into domain types (see `validation` skill). Core receives only parsed types and never re-checks.
3. Branded IDs and units: `TripId`, `DriverId`, `RiderId`, `Tick` not interchangeable. Zod `.brand<"TripId">()` (static-only, no runtime cost). Branded values created only by parsing or by one constructor in the owning module (e.g. ID generator, see `simulation` skill).
4. Exhaustive handling: `switch` on discriminant, `never` check in `default`.
5. Types serve correctness, not cleverness. If a type needs a comment to be understood, simplify it.

## 3. DDD-lite

1. Ubiquitous language: `domain` skill. Code names = domain terms.
2. Value objects: immutable, compared by value (`Cell`, `Distance`). Logic about them lives with them (e.g. distance between cells).
3. Aggregates own invariants: only the Trip module transitions trip state; it returns `Result` for invalid transitions (see `errors` skill). Nobody else mutates a trip.
4. Skip ceremony: no repositories/factories/services unless a concrete need appears.

## 4. Functional core, imperative shell

1. Core: pure functions over immutable data. No I/O, no clock, no randomness except injected (see `simulation` skill).
2. Shell: runners + adapters (NATS, ClickHouse, UI). Thin: translate, call core, perform effects.
3. Dependencies point inward: core imports nothing from shell.

## 5. When to abstract (AHA)

1. Duplicate once, maybe twice. Abstract on the third real use, when the shared shape is clear.
2. Extract a function when it hides complexity behind a simpler interface or is reused, not just because a block "has a name".
3. Wrong abstraction costs more than duplication. Prefer inlining a bad abstraction back over patching it with flags.
4. No interfaces with one implementation, except at the core/shell boundary (ports for clock, random, event sink).

## 6. Runtime scalability

1. Correctness and clarity first. Optimize only with a profile showing the per-tick cost.
2. If tick loop becomes the bottleneck at large agent counts: data-oriented design (flat arrays, batch processing per component) is the planned direction. Ask before switching.
3. Horizontal scale via NATS: components (sim, writers, UI gateway) run as separate processes.
