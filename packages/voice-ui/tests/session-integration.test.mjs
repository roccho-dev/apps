// The repository's current flake check discovers top-level *.test.mjs files.
// Keep the scenario implementation in its final integration directory while
// this small discovery bridge makes it part of the existing fast core gate.
import "./integration/scenario.test.mjs";
