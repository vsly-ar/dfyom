# Documentation conventions

Status: accepted · Principle: [principles.md §3](../principles.md#3-documentation-before-implementation)

## Rules

1. **Docs first.** A feature is documented (status ≥ draft, ideally accepted) before it is implemented. Update the doc in the same change as the code.
2. **Single owner per topic.** Each fact lives in exactly one place. Elsewhere, **link** to it – never copy or paraphrase it. If you find duplication, replace it with a link.
3. **Contracts live in code.** Types/interfaces in `src/` are the contract. The doc links to the file; the file's header comment links back to the doc.
4. **Status line** at the top of every doc: `stub | draft | accepted | implemented` (meanings: [README.md](../README.md#status-values)).
5. **Index.** Every doc is listed in [docs/README.md](../README.md).
6. **Decisions** with trade-offs go into an ADR in [decisions/](../decisions/) (`NNNN-kebab-title.md`: Context, Decision, Consequences). ADRs are immutable once accepted; supersede instead of editing.
7. **Use industry-standard terms** and add new ones to [glossary.md](../glossary.md).

## Written for LLMs (and humans)

- Short files, one topic each; descriptive file names; headings that work as anchors.
- Prefer tables and lists over prose; state rules imperatively.
- Explicit "Open questions" sections instead of vague text.
- Relative links only, so they resolve both on disk and on Git hosting.
