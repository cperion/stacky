# Stacky memory and tool contract

Stacky separates **responsibility**, **attention**, and **experience**:

- The active stack determines what may execute. Only its top frame is executable.
- A bounded LRU holds the views currently shown to the model.
- A durable archive retains observable events, closed frames, immutable snapshots,
  and tool-output artifacts. Eviction and `pop` do not erase that archive.

The model still has eight tools: `bash`, `read`, `edit`, `push`, `pop`, `todo`,
`spawn`, `user`. There is no separate pagination, search, or memory-management tool.

## Agent-facing example

References below are illustrative; actual references must be copied from results.

```ts
read({ path: "src/auth.ts" })
```

A bounded current view appears in WORKING CONTEXT:

```text
## LIVE src/auth.ts ref=8de version=c71
[a7c|40] function shouldRefresh(auth) {
[19d|41]   return auth.expiresAt <= Date.now()
[bb2|42] }
```

The bracket contains an exact line anchor and a display-only line number.

```ts
edit({ edits: [{
  from: "19d",
  through: "19d",
  text: "  return auth.expiresAt <= Date.now() + 60_000"
}] })
```

The runtime checks the base revision and visible coverage, applies the edit,
transforms/promotes the affected view, and returns new anchors. Later actions use
those new references. Unchanged surrounding context is retained where it fits;
large insertions prioritize the edited region and expose continuations.

## `read`: inspect, search, page, recover

Supply exactly one of `path` or `ref`:

```ts
read({ path: "src/auth.ts" })
read({ ref: "8de" })
read({ path: "src/auth.ts", find: "expiresAt" })
read({ ref: "e72", budgetTokens: 2000 })
```

- A **path/file-resource reference** opens the current file.
- A **file-page reference** continues its captured revision. It is editable only
  if the file still has that revision; otherwise it becomes a read-only snapshot
  with current-file recovery guidance.
- A **version or line reference** opens the original snapshot as read-only.
- An **artifact reference** opens recorded command output or another observation.
- A **frame/event/history reference** opens read-only execution history.
- `find` is case-sensitive literal search, not regex or semantic retrieval.

File/artifact searches return bounded match lists (up to 20 matches per search
page), with references to open contextual views. Search snippets alone do not
confer edit authority. Continuations stay bound to the same snapshot even when
new output/events/files appear. Empty searches explicitly report no matches.

History searches cover the selected agent/frame's **event descriptors**. A frame
search excludes descendant-owned events, and linked artifact bodies are not
implicitly searched. Follow the child or output reference and search that source.
This deliberate scope is stated in the result; there is no hidden all-history RAG.
Searching a continuation starts at that cursor in its captured source. An explicitly
supplied new query replaces the previous query, rather than being silently ignored.

Unknown references fail explicitly. Reopening a historical observation never
reactivates a frame, executes a command, or rolls back a file.

## Stable references

The SQLite registry stores canonical descriptors and full SHA-256 identities.
Visible references start at three hexadecimal characters. When a short alias is
occupied, the new alias is extended; existing aliases are never changed or reused.
Resolution is **exact lookup**, not prefix matching. Full-identity collisions are
verified and rejected rather than ambiguously resolved.

A line descriptor includes its file-version reference and position. Repeated `}`
lines therefore have distinct identities. A content hash alone would not identify
which occurrence to edit. References are scoped to their archive; do not copy an
alias from an unrelated run and assume global identity.

## `edit`: guarded changes to inspected code

```ts
edit({ edits: [{ from: "a7c", through: "bb2", text: "replacement lines" }] })
edit({ edits: [{ before: "a7c", text: "inserted line" }] })
edit({ edits: [{ after: "bb2", text: "inserted line" }] })
edit({ edits: [{ from: "a7c", through: "bb2", text: "" }] }) // delete
```

Rules:

1. Range endpoints are inclusive and ordered.
2. Every affected line, including the interior of a range, must be fully visible
   in current live views. Fragmentary/evicted/historical coverage is insufficient.
3. All edits in a call use one file and one original revision. They are validated
   together and applied against that base, not sequentially against prior edits.
4. Overlap and ambiguous insertion boundaries are rejected before writing.
5. The current file must still match the inspected revision.
6. Full-line operations preserve the surrounding newline boundary; explicit
   before/after insertions are not special cases of ambiguous empty ranges.

Compatibility text replacement remains available, with the same current-visible
coverage guard:

```ts
edit({ path: "src/auth.ts", edits: [{ oldText: "old", newText: "new" }] })
edit({ path: "new-file.ts", edits: [{ oldText: "", newText: "file contents" }] })
```

The implementation validates first and atomically renames one replacement file.
The final revision check is optimistic, **not an OS-wide compare-and-swap**: an
external writer racing after that check cannot be excluded. Use isolated worktrees
for concurrent coding. Symlink replacement is refused; explicitly read/edit the
resolved target instead. This guard applies to `edit`, not arbitrary shell writes;
`bash` is not a filesystem sandbox.

## LRU attention

`--file-budget` / `fileBudgetTokens` now limits **all resident views**, including
files, logs, search results and history. The existing configuration name is retained
for compatibility; the menu calls it the working-view budget.

- Default total: 24,000 estimated tokens.
- Default individual view: at most 4,096 estimated tokens.
- Explicit reads may request 128–24,000, capped by the total budget.
- The estimate is approximately four characters per token, not provider-exact
  tokenization. Headers, anchors, separators and continuations count toward it.
- Explicit read/edit promotes. Automatic refresh and prompt inclusion do not.
- Overlapping views are reused or replaced without silently charging duplicate
  overlapping live content. Historical and live authority remain separate.
- A too-small budget fails with a required-size hint rather than returning a
  non-advancing page. Oversized lines use progressing, read-only Unicode fragments.
- Eviction receipts identify how to reload the resource. Live-file recovery points
  to the current file, not an accidentally stale historical snapshot.

Before inference, live regions refresh from disk without changing recency. If a
partial region cannot be relocated unambiguously, its edit authority is removed
and recovery instructions replace the view. Current file beginnings may be
reopened after restart; changed nonzero saved regions require an explicit new read.

The prompt contains resident bodies once. Recent conversation contains compact
receipts/provenance, not additional copies of those bodies. The transcript has its
own FIFO budget; the stack and small local history map remain separate. The UI's
recent closed-frame projection is limited to 64; older frames remain in the archive.

## Durable frame history

Each frame has explicit parent ownership. Its own events are distinct from events
owned by children; execution can pause and resume across multiple child intervals.
The archive records observable conversation, model-context selections, exact tool
calls (including rejected ones), results/artifact references, lifecycle transitions,
and TODO changes. Identical command output from separate calls retains distinct
occurrence references. Private reasoning is excluded from this archive and from
new checkpoints; it can still be shown transiently in the UI.

`push` records the parent's suspension point. `pop` archives the disposition,
evidence and parent effects, then presents a return packet with the parent's next
unresolved step. Old frames are evidence, not executable stack entries.

A spawned runtime has a separate stack and working set but shares the archive with
a distinct agent identity. Parent reports include a child-frame reference. Raw child
transcripts do not enter the parent's model prompt. A report with unresolved child
frames is marked incomplete. Revisiting work means a new frame, not secretly
resuming an old archived runtime.

## Storage, limits and privacy

Archives are created by default under:

```text
${XDG_STATE_HOME:-~/.local/state}/stacky/history/<run-id>/
  memory.sqlite
  blobs/<content-hash>
```

`STACKY_HISTORY` overrides the archive root. Directories use mode `0700`; database
and blob files use `0600`. **They are not encrypted and can contain source code,
user messages, commands, output, and secrets that those sources included.** Do not
assume this archive has automatic secret redaction.

- Each text artifact retains at most 8 MiB. Bash also has an 8 MiB combined capture
  quota before display paging. Permanently omitted bytes are explicitly reported.
- Files reported larger than 64 MiB are refused by the regular-file reader. Invalid
  UTF-8 is refused rather than silently corrupting untouched bytes during edits;
  UTF-8 BOMs are preserved. Use bounded binary-aware shell queries when appropriate.
- Capture limits are different from paging: a continuation cannot recover data
  that was never retained.
- There is no automatic total-disk retention policy yet. Archives grow on disk;
  remove an unused run directory only after its runtime is closed and its history
  is no longer needed. Deleting it invalidates checkpoint references.
- `/new` clears working state and records abandonment of active frames, but retains
  their archive. It is not a privacy purge.
- Optional `--trace` output is separate and can include transient stream events,
  including reasoning. Treat it as sensitive too.

Use `--session path.json` for restart continuity. Version-3 checkpoints contain the
archive location, agent/workspace identity and view selections, not embedded file
snapshots. Keep the archive with the checkpoint; the JSON file alone is not a full
backup. Restoring under another workspace or with a missing archive fails explicitly.
Legacy checkpoints import only retained history; already-evicted old turns cannot
be reconstructed. Archive events are durable evidence, while control-state recovery
uses the checkpoint—automatic crash replay/rollback is not implemented.

## Human inspection and validation

- `/context`: the last context rendered for the model, without refreshing code
  behind an in-flight call.
- `/history [ref]`: frame/event navigation with continuation references.
- `/files`: resident live file views, not every archived file.
- `/status`: view usage and archive location.

Tests cover alias collisions, replay after reopening the store, pagination bounds,
Unicode fragments, live refresh, stale/partial/overlapping edits, scoped frame
history, search continuations and end-to-end scripted agent behavior. Provider-backed
inference is a separate integration check; fixture tests do not certify network/API
availability.
