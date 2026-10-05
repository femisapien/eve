# Declarative tool stub verification

This fixture runs consumer evals with every real model in the `e2e-local`
matrix (`modelMatrix: full`). The tasks journey uses a semantic judge to
distinguish acknowledging a completed task from listing it as still open;
it carries the `real-model` tag. Matching and cross-turn playback also run
with the shared scripted responder in the Postgres and Vercel world suites.
A passing scripted world run is transport/durability evidence, not live-model evidence.

| Contract                                                                               | Primary proof                                                                                                           |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| List three tasks, complete the intended task, list two remaining tasks on a later turn | `evals/tasks.eval.ts`: tool arguments, counts, order, outputs, and final user-visible task list                         |
| Nested partial matching, regex and array membership, extra input fields                | `evals/matching.eval.ts`: actual model-generated arguments select the expected response                                 |
| Several calls to one tool within a turn, then continuation on a later turn             | `evals/matching.eval.ts`: pending → first result → next result                                                          |
| An unmatched call invokes the real executor                                            | `evals/matching.eval.ts`: distinct live marker                                                                          |
| Every admitted JSON Schema keyword and setup rejection                                 | `packages/eve/src/tool-stubs/schema.test.ts`: positive/negative values, malformed schemas, no coercion/default mutation |
| Independent rule sequences, ambiguity, replay, persistent-tool restrictions, bounds    | `packages/eve/src/tool-stubs/rules.test.ts` and existing runtime integration tests                                      |
| Concurrent admission, separate session state, multi-turn continuation                  | `agent-workflow-stress/evals/tool-stubs.eval.ts` with its deliberately scripted model                                   |

The matcher accepts 38 keywords: type, const, enum; five numeric constraints;
three string constraints; eight array constraints; nine object constraints;
seven composition/conditional keywords; and three annotations. `schema.test.ts` names the individual contracts rather than inferring expected
answers from the validator.

Tests use draft 2020-12 semantics, including [contains bounds](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.4.4),
[decimal multiples](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.2.1),
and [required properties](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.5.3).
Regression tests reproduced defects in the vendored validator's default
`minContains`, negative/tiny `multipleOf`, inherited property handling,
object/array equality, and dependency-map traversal before repair. Configuration-size rejection also has a reproduced regression.

This covers every admitted keyword, not every combination of schemas or every
possible model response. Live-model evals verify the model/runtime boundary;
they do not replace deterministic schema conformance tests. Schemas and inputs
are JSON values represented by JavaScript numbers; precision already lost while
parsing a number cannot be recovered by the matcher.
