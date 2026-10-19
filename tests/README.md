# Tests

Layout is **flat**: all files live directly under `tests/` (no nested folders).

Injection corpus fixtures (P23 / BX-24):

- `file_approve_plan.txt`
- `pr_description_exfil.txt`
- `ci_log_fragment.txt`
- `plan_node_injection.txt`

They are data, not instructions. See `tests/injection-corpus.test.mjs` and `tests/p23-acceptance.test.mjs`.
