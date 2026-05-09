# Offload MCP Rules for Windsurf

> Merge this content into your `.windsurfrules` file.
> When the offload MCP server is connected, follow these rules:

## Best Offload Candidates

- **Commit messages**: prefer `offload_source(task="commit_message", source="git_diff")`; otherwise `offload(task="commit_message", content=<the diff>)`
- **PR descriptions**: prefer `offload_source(task="pr_description", source="git_diff")`; otherwise `offload(task="pr_description", content=<combined diff>)`
- **Code summaries**: prefer `offload_source(task="code_summary", source="file", path=<path>)`; otherwise `offload(task="code_summary", content=<the code>)`
- **Translation** (any direction): `offload(task="translate", content=<the text>)`
- **Changelog entries**: prefer `offload_source(task="changelog_entry", source="git_diff")`; otherwise `offload(task="changelog_entry", content=<the diff>)`
- **Naming suggestions**: `offload(task="naming_suggestion", content=<description>)`

## Offload in Batch (Tier 2)

Use when processing multiple items in a session:

- **Text classification**: `offload(task="classify", content=<text + categories>)`
- **Data extraction**: `offload(task="extract_data", content=<text + what to extract>)`
- **Single-function code review**: `offload(task="code_review_single", content=<the function>)`
- **Docstring generation**: `offload(task="docstring", content=<the function>)`
- **Email subject lines**: `offload(task="subject_lines", content=<email description>)`

## Freeform (any routine task)

For anything not listed above, use freeform with a custom prompt:

`offload(task="freeform", content=<the text>, prompt=<your instruction>)`

For local files or diffs, prefer `offload_source(task="freeform", source="file", path=<path>, prompt=<your instruction>)`.

Good candidates: rewriting error messages, summarizing logs, formatting data, extracting action items, rephrasing text, generating test names, writing regex patterns.

## Never Offload

Handle these yourself:

- Multi-file code changes
- Architecture decisions
- Complex debugging
- Anything requiring the offload model to call tools or inspect live project state beyond the provided source
- Security-sensitive reviews
- Secrets, private customer data, proprietary code, or regulated data unless policy allows sending it to the Gemini API
- Plan writing or execution

## Quota

Check `offload_status` if you get a quota warning. If quota is exceeded, handle all tasks locally without mentioning the offload system.
