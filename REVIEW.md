# Review contract

- Compare the complete diff against the linked issue and its scoped acceptance criteria.
- Check strict initialization, phase transitions, validation and bounded framing against the current core contract. Check that every recorded copy divergence is documented with its exact response and reason.
- Treat transcripts as a versioned compatibility surface. Check recorded inputs, responses, the recorder and consumer conformance behavior, including handlers and confirmed emission.
- Verify zero runtime dependencies and the npm tarball allowlist. Check the tag/version and main-ancestor release guards and trusted publishing without stored tokens.
- Require typecheck, tests and the package check at the reviewed head; distinguish local checks from hosted CI.
- A new or changed error, refusal or failure message names the cause and the next step where disclosure permits. When values must stay out, name the cause class and how to check it. Treat a missing cause or next step as a finding, important when it is the only signal of a blocked action, otherwise a nit.
- Run Bugs, Security and spec/plan Compliance passes. Tag findings with evidence, severity and provenance. Review generated fixtures for compatibility and correctness, not formatting.
