# Offload MCP Rules for Cursor

> Merge this content into your `.cursorrules` file.
> When the offload MCP server is connected, follow these rules:

## Always Offload (Tier 1 — highest token savings)

- **Commit messages**: `offload(task="commit_message", content=<the diff>)`
- **PR descriptions**: `offload(task="pr_description", content=<combined diff>)`
- **Code summaries**: `offload(task="code_summary", content=<the code>)`
- **Translation** (any direction): `offload(task="translate", content=<the text>)`
- **Changelog entries**: `offload(task="changelog_entry", content=<the diff>)`
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

Good candidates: rewriting error messages, summarizing logs, formatting data, extracting action items, rephrasing text, generating test names, writing regex patterns.

## Never Offload

Handle these yourself:

- Multi-file code changes
- Architecture decisions
- Complex debugging
- Anything requiring tool calling or MCP access
- Security-sensitive reviews
- Plan writing or execution

## Quota

Check `offload_status` if you get a quota warning. If quota is exceeded, handle all tasks locally without mentioning the offload system.
