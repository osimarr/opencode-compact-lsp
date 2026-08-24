# Estimated LSP hook savings statistics

## Status / Date

**Accepted** — 2026-08-23

## Context

`opencode-compact-lsp` is an OpenCode server plugin that runs a
`tool.execute.after` hook for the builtin `lsp` tool. OpenCode may already have
truncated the tool output, and an earlier plugin hook may already have changed
it, before this plugin runs. This plugin can then reconstruct a full rewrite
from `metadata.result`. Consequently, the useful product metric is the actual
effect of this plugin's hook on output context, not pure DTO compaction.

Users need a durable, visibly estimated view of that effect for the current
OpenCode session and for the project. Linked Git worktrees must share the
project total. Statistics must not change tool behavior, block the OpenCode
event loop, expose source identities or LSP data at rest, or be presented as
billing data.

In this ADR, **estimated context-token delta** is the numeric metric and **LSP
hook savings** is its product name. “Savings” never means pure DTO compaction.

## Decision

Record the estimated context-token delta in locked, revision-fenced immutable
`stats-v1` JSON snapshots per canonical project. Use the fixed `o200k_base`
proxy described below. Display independent Session and Project aggregates in an
AFT-style TUI sidebar.

The headline is the actual hook effect: the token count of the exact string at
entry to this plugin's hook minus the token count of the exact string after
this plugin's existing rewrite. This deliberately includes OpenCode
pre-hook truncation and this plugin's possible reconstruction from full
metadata. Truncated calls remain included, and a negative delta is truthful:
the plugin emitted more estimated output-context tokens than it received.

## Component boundaries and interfaces

The feature has five boundaries:

1. **Hook adapter:** runs the existing rewrite and submits a statistics job.
   It owns no tokenizer or filesystem code.
2. **Recorder seam:** a synchronous, non-throwing `record(job): void`
   interface. Production uses a bounded worker-backed recorder; tests can
   inject either that recorder or a no-op recorder. Enabling statistics cannot
   select a different rewrite path.
3. **Shared identity module:** a small server/TUI-safe module implementing the
   exact state-root, canonical-project, and HMAC byte contracts below. It has no
   tokenizer, lock, worker, recorder, queue, or aggregate dependency. Its narrow
   adapters may use Node `fs`, `path`, `crypto`, and Git identity helpers.
4. **Server activation bootstrap and statistics worker:** activation resolves
   immutable project context from `PluginInput.directory`, consumes/creates the
   identity key, and starts the server-only recorder worker. The worker owns the
   tokenizer, capability probe/marker, queue processing, project locking,
   aggregate update, retention, and immutable snapshot publication.
   Tokenization, lock waits, and persistence never execute on the OpenCode
   event loop.
5. **TUI snapshot reader:** uses the shared identity module, reads and validates
   final `identity-v1` directly, derives its own opaque project/session keys,
   checks capability, reads snapshots without a project lock, and formats
   sidebar state. It may import the listed Node/Git identity helpers but must
   not import tokenizer, `proper-lockfile`, worker, or recorder modules.

The shared module has no mutable process state. State-root calculation and HMAC
construction are pure functions of explicit inputs; canonicalization receives
narrow Node path/realpath and Git-command adapters. Server and TUI use the same
core and platform adapters, preventing duplicated byte/path rules without
pulling server statistics dependencies into the TUI.

A normal statistics job contains only the two strings, their exact combined
UTF-8 byte count, the host session ID, the
`hostTruncatedAtEntry = (metadata.truncated === true)` boolean captured at hook
entry. An oversize-exclusion job contains only the host session ID and entry
truncation boolean; it contains no output strings or project data. Raw project
identity, directory, state root, project key, arguments, call IDs, output paths,
titles, attachments, and other metadata are never submitted in a job.

The exact job envelopes are:

```text
normal:   { kind: "measure", sessionID, hostTruncatedAtEntry,
            before, after, combinedUtf8Bytes }
oversize: { kind: "oversize", sessionID, hostTruncatedAtEntry }
```

At plugin activation, the server bootstrap derives one immutable process-lifetime
worker context from `PluginInput.directory`. Worker data contains exactly the
resolved state root, canonical project identity, project key, project directory,
plugin version, and metric version. Every normal or oversize job shares that
context. This makes even a first-call oversize exclusion independent of hook
directory/init data.

## Hook data flow and fail-open contract

For each call where `input.tool === "lsp"`, the hook performs these operations
in order:

1. Capture `before` as the exact `output.output` string at entry to this
   plugin's `tool.execute.after` hook. This is after OpenCode `Tool.wrap`
   processing/truncation and any earlier plugin hooks. At the same entry point,
   capture `hostTruncatedAtEntry` as
   `output.metadata.truncated === true`; later mutations cannot change it.
2. Run the existing `applyLspOutput` behavior and assign its return value to
   `output.output`.
3. Capture `after` as the exact `output.output` string immediately after that
   assignment.
4. Inside a statistics-only `try/catch`, compute the O(1), checked combined
   UTF-16-code-unit length `before.length + after.length`. If it is greater than
   4 MiB (`4 × 1024 × 1024` code units), classify the call as oversize without
   calling `Buffer.byteLength` on either string.
5. Otherwise compute exactly
   `Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8")` with
   checked safe-integer addition. This scans at most 4 MiB combined UTF-16 code
   units. If the exact UTF-8 sum is greater than 4 MiB, classify oversize.
6. For an admitted call, submit both strings, the exact UTF-8 sum,
   `input.sessionID`, and `hostTruncatedAtEntry`. For either oversize path,
   submit only the small exclusion job; do not retain or transfer either string
   and do not claim an exact UTF-8 size.
7. Return normally without awaiting tokenization, worker startup, locking,
   fsync, or persistence.

The rewrite remains outside the statistics `try/catch`, preserving its current
error semantics. Once rewrite assignment succeeds, all statistics failures are
swallowed. Debug logging, if enabled, contains only a generic event code and
numeric diagnostics; it never contains payloads, paths, arguments, call IDs,
session IDs, project identities, titles, attachments, `metadata.result`, or
`metadata.outputPath`.

Statistics do not modify metadata. `title` and `attachments` are output fields.
`result`, `truncated`, and `outputPath` are metadata fields. The existing
rewrite may use `metadata.result` as its source, but `metadata.result` is never
the metric baseline. The on/off recorder seam must leave all output bytes and
all metadata identical.

## Tokenizer and metric semantics

Pin `gpt-tokenizer@4.0.0` (MIT) and import the explicit
`gpt-tokenizer/encoding/o200k_base` entry from the worker only. Its roughly
27 MiB unpacked package size is an accepted server packaging cost. The metric
identifier is exactly:

```text
o200k_base:gpt-tokenizer@4.0.0:v1
```

The worker tokenizes `before` and `after` independently as JavaScript strings.
Empty strings are valid measurements with zero tokens. Token counts and all
aggregate arithmetic must remain nonnegative safe integers.

For a measured aggregate:

```text
saved = beforeTokens - afterTokens
compressionPercent = beforeTokens > 0
  ? (saved / beforeTokens) * 100
  : null
```

`saved` and `compressionPercent` are derived, never persisted. Both can be
negative. The UI renders `compressionPercent` to one decimal place. A null
value is unavailable (`—`), not zero percent.

## Queue admission and observation boundary

Exactly 4 MiB (`4 × 1024 × 1024` bytes) is both the maximum transferred string
payload and the tokenization cap. A normal job at the cap is admissible. An
over-cap call is represented by its small exclusion job, so its output strings
never enter the statistics queue or worker.

The worker-backed recorder permits at most 16 admitted jobs and 8 MiB of actual
UTF-8 output-string bytes per server process, including the active job. Normal
jobs are charged the exact combined byte count computed by the hook;
exclusion jobs are charged zero string bytes but still consume one job slot.
Fixed job-envelope overhead is outside the string-byte cap. If either limit
would be exceeded, the recorder drops the newest normal or exclusion job before
retaining or posting it; tool output is unaffected.

The process increments a process-local `droppedQueueCalls` diagnostic for such
drops. It is neither persisted nor shown in the headline or sidebar. It is
available only to generic process diagnostics and resets on process restart.

The persisted observation boundary is successful admission to the worker.
This distinction is required by the counter algebra: a dropped job has no
persistable outcome and cannot truthfully be called measured, oversize, or a
tokenizer error. Therefore persisted `observedCalls` excludes queue-dropped
calls. Every targeted LSP call is either admitted and governed by the exact
algebra below, or represented only by process-local `droppedQueueCalls`.
Crashes can also lose admitted but uncommitted work. The sidebar must not imply
that persisted observed calls equal all LSP calls made by the host.

Credits for an admitted job are released only after the worker reports that
the job has finished, so queued and active strings are both bounded. A worker
startup or messaging failure turns the recorder into a no-op for subsequent
calls and remains fail-open.

The bounded `Buffer.byteLength` work is part of hook admission. Its cost for
combined inputs of at most 64 KiB is included in the enqueue acceptance gate.
The O(1) UTF-16 length short-circuit and exact scans near the 4 MiB boundary are
benchmarked separately. No admission path invokes `Buffer.byteLength` after the
combined code-unit threshold has been exceeded, including rewrites reconstructed
from metadata into outputs tens of MiB long.

## Aggregate algebra

The aggregate shape is exactly (persisted as `calls` for `observedCalls`):

```ts
type Aggregate = {
  calls: number // observedCalls per contract; measuredCalls derived
  beforeTokens: number
  afterTokens: number
  truncatedCalls: number
  passThroughCalls: number
  excludedOversizeCalls: number
  tokenizerErrorCalls: number
  lastSeenAtMs: number
}
// measuredCalls = calls - excludedOversizeCalls - tokenizerErrorCalls
```

> **Implementation note (v1):** the persisted field is `calls` (alias `observedCalls`). `measuredCalls` is not stored separately; it is derived as `calls - excludedOversizeCalls - tokenizerErrorCalls` (`deriveMeasuredCalls` in `src/stats/contract.ts:7`). This preserves the invariants `observedCalls = measuredCalls + excludedOversizeCalls + tokenizerErrorCalls` and `calls` == `observedCalls` without requiring migration of existing v1 snapshots, which already use `calls`. All validation, worker, store, and TUI code uses `calls` as observed and derives measured.

For every admitted targeted LSP call whose update is committed,
`observedCalls` increments exactly once. `truncatedCalls` increments
independently when `hostTruncatedAtEntry` is true. It therefore means “host
truncated at this plugin's hook entry,” not that the final rewrite is
truncated. Exactly one outcome then applies:

- **Measurement success:** increment `measuredCalls`, add the two token counts,
  and increment `passThroughCalls` if and only if `before === after` as exact
  JavaScript strings. This matches the tokenizer inputs and does not collapse
  distinct unpaired-surrogate strings that may encode to the same replacement
  bytes in UTF-8.
- **Oversize exclusion:** for an admitted over-cap exclusion job, increment
  `excludedOversizeCalls` and add no token sums. The hook has already computed
  the exact combined UTF-8 byte length and transferred no strings.
- **Tokenizer failure:** if either tokenization fails or yields an invalid
  count, increment `tokenizerErrorCalls` and add no token sums.

The invariants are:

```text
observedCalls = measuredCalls + excludedOversizeCalls + tokenizerErrorCalls
passThroughCalls <= measuredCalls
truncatedCalls <= observedCalls
```

Every field is a safe nonnegative integer. Checked-arithmetic failure aborts
the update and leaves the prior snapshot unchanged. Locking, reading, or
persistence failure likewise causes no partial counter update and is not
misreported as a tokenizer error.

The worker updates the Project and current Session aggregates in the same
locked transaction. It samples and validates one nonnegative safe-integer
`nowMs` from the UTC Unix epoch for the entire transaction. On every committed
measurement, oversize exclusion, or tokenizer-error outcome, each affected
`lastSeenAtMs` becomes `max(previousLastSeenAtMs, nowMs)`. This makes timestamps
monotonic across wall-clock regression. The Project aggregate is an independent
historical total. It remains unchanged when session buckets are pruned and
therefore does not equal the sum of retained sessions.

## Persistence schema and state layout

The complete state layout is:

```text
<stateRoot>.lock/                 # transient proper-lockfile identity lock
<stateRoot>/
  identity-v1
  .identity-v1.<pid>.<random>.tmp
  projects/
    <projectKey>/                    # existing proper-lockfile target
      capability-v1.json
      .capability-v1.<pid>.<random>.tmp
      snapshots/
        stats-v1.<revision>.json
        .stats-v1.<revision>.<pid>.<random>.tmp
        .capability-probe.<pid>.<random>.tmp
        .capability-probe.<pid>.<random>.final
    <projectKey>.lock/            # transient proper-lockfile writer lock
```

The exact completed-snapshot path pattern is:

```text
<stateRoot>/projects/<projectKey>/snapshots/stats-v1.<revision>.json
```

`<revision>` is canonical positive decimal: it matches `[1-9][0-9]*`, has no
leading zero or sign, and parses first as an arbitrary-precision integer that
must be no greater than `Number.MAX_SAFE_INTEGER`. The JSON `revision` must
equal the filename revision exactly. A completed candidate name matches only
`^stats-v1\.([1-9][0-9]*)\.json$`. A name matching that expression whose
revision exceeds the safe-integer limit makes state unavailable; it is not
ignored as an unrelated file.

A snapshot temp name matches only
`^\.stats-v1\.([1-9][0-9]*)\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$`, where the
captures are revision, process ID, and 128-bit random lowercase hexadecimal
suffix. Temps are transient and never current; zero or more can remain after
crashes. An entry beginning `stats-v1.` that is not an exact completed name
is not a candidate. An exact completed name that is not a regular file makes
state unavailable if it has the highest candidate revision. Unrelated entries,
malformed names, and exact temp names are ignored for current selection but
still count toward the directory-entry scan bound.

A directory refresh streams at most 512 entries and accepts at most 64 exact
completed candidates. Exceeding either bound makes state unavailable. Among
accepted names, current is the candidate with the numerically highest revision;
the reader opens and duplicate-parses only that file. If it is corrupt,
unsupported, unreadable, or disagrees with its filename revision, state is
unavailable and the reader never falls back to a lower revision. If no completed
candidate exists, identity state is valid, and capability is freshly available,
state is zero. A transient `ENOENT` while opening the selected file restarts the
bounded scan once after 25 ms.

A snapshot contains schema and metric metadata, its revision, one Project
aggregate, and opaque-keyed Session aggregates. It contains no raw LSP or
identity data. For example, the following document is stored as
`snapshots/stats-v1.17.json`:

```json
{
  "schemaVersion": "stats-v1",
  "metric": "o200k_base:gpt-tokenizer@4.0.0:v1",
  "revision": 17,
  "project": {
    "observedCalls": 42,
    "measuredCalls": 39,
    "beforeTokens": 128400,
    "afterTokens": 47600,
    "truncatedCalls": 3,
    "passThroughCalls": 1,
    "excludedOversizeCalls": 2,
    "tokenizerErrorCalls": 1,
    "lastSeenAtMs": 1787443200000
  },
  "sessions": {
    "5eb8cc163d5b20c03375312980c0c0f92e4a0f2cbaa66ea5a8569a70e83d33b1": {
      "observedCalls": 12,
      "measuredCalls": 10,
      "beforeTokens": 38200,
      "afterTokens": 13400,
      "truncatedCalls": 1,
      "passThroughCalls": 0,
      "excludedOversizeCalls": 1,
      "tokenizerErrorCalls": 1,
      "lastSeenAtMs": 1787443200000
    }
  }
}
```

Every completed snapshot has a positive safe-integer `revision`. A normal
serialized writer derives revision `N + 1` from current revision `N`; a stale
writer can publish a lower revision but cannot replace any existing file. The
TUI uses the selected highest revision to skip unchanged rerenders.

The zero aggregate has every numeric field, including `lastSeenAtMs`, set to
zero. No completed snapshot candidate means no Session bucket until the first
committed outcome for that session.

This remains a locked snapshot architecture, not an audit journal. The two
retained immutable revisions exist only for fenced publication and crash
recovery; they are not per-call history. No journal, SQLite database, raw event
rows, or TUI-only recent window is part of this design. There is no historical
backfill. A future schema or tokenizer metric requires an explicit migration
decision; v1 never silently interprets, rewrites, or resets an unsupported
snapshot.

### Strict snapshot validation

Validation occurs under the project lock before any update. A duplicate-aware
JSON parse/AST pass rejects duplicate object member names at every nesting
level before conversion to typed values. Typed validation then enforces all of
the following:

- The top-level object has exactly `schemaVersion`, `metric`, `revision`,
  `project`, and `sessions`; every Aggregate has exactly the nine declared
  members. Unknown or missing members are rejected.
- `schemaVersion` and `metric` exactly match the v1 constants. A present
  snapshot has a positive safe-integer `revision`.
- Every Session member name is exactly 64 lowercase hexadecimal characters.
  The project directory key and the locally derived expected project key
  satisfy the same format and must match.
- Every Aggregate field is a nonnegative safe integer and satisfies the
  existing algebra. `measuredCalls === 0` implies `beforeTokens === 0` and
  `afterTokens === 0`.
- `observedCalls === 0` implies every counter, both token sums, and
  `lastSeenAtMs` are zero. A zero Project Aggregate is valid only in a
  structurally new snapshot with `revision === 1` and no Session members.
  Zero-observation Session buckets are never persisted.
- Every persisted Session has `observedCalls > 0`. A committed snapshot has at
  most 256 Session members. Every retained Session also satisfies
  `session.lastSeenAtMs <= project.lastSeenAtMs`.
- For each additive field—`observedCalls`, `measuredCalls`, `beforeTokens`,
  `afterTokens`, `truncatedCalls`, `passThroughCalls`,
  `excludedOversizeCalls`, and `tokenizerErrorCalls`—the checked safe-integer
  sum across retained Sessions is less than or equal to the corresponding
  Project value. The Project value may be greater because it retains pruned
  history.

Failure of duplicate detection, typed validation, any exact-member check, or
any invariant makes that snapshot corrupt/unsupported and preserves its bytes.
If it is the highest exact candidate, all future writes for that project remain
blocked until manual recovery or reset; a lower invalid candidate is never used
as current and is not silently deleted by cleanup.

## State-root and identity contract

Both processes resolve the state root with the same rules:

1. If `XDG_STATE_HOME` is set to a nonempty absolute path, use
   `<XDG_STATE_HOME>/opencode/opencode-compact-lsp`.
2. A set but non-absolute `XDG_STATE_HOME` is invalid and makes statistics
   unavailable; do not silently choose a different root.
3. If it is unset on Linux or macOS, use
   `~/.local/state/opencode/opencode-compact-lsp`.
4. If it is unset on Windows, use the platform path-join operation with
   `LOCALAPPDATA`, `opencode`, and `opencode-compact-lsp`. Literal backslashes
   are not persisted as part of any schema contract.
5. If the required home or `LOCALAPPDATA` value cannot be resolved, statistics
   are unavailable.

The root is normalized to an absolute path before identity derivation.
The state root is created before locking with mode `0700` where POSIX modes are
supported; every other plugin-owned directory uses the same mode.

The identity key is exactly `<stateRoot>/identity-v1` and exactly 32
cryptographically random bytes. The server activation bootstrap acquires
`proper-lockfile` on the existing `<stateRoot>` directory with `realpath: false`
and the bounded profile below before server-side creation/consumption and temp
cleanup. The lock reduces normal contention; no correctness depends on it after
stale takeover.

The TUI does not acquire that lock or import `proper-lockfile`. It reads only the
final `identity-v1` regular file. No-clobber publication guarantees the final
name never exposes the creator's partial temp. The TUI accepts the key only when
the read returns exactly 32 bytes; missing, short, long, unreadable, or
non-regular identity state is not consumed.

Under the identity lock, the server validates an existing key as exactly 32
bytes before using it. If the key is absent and `projects/` contains any project
directory, state is orphaned and unavailable and no replacement is created. If
the key and prior project state are both absent, the server creator:

1. generates 32 random bytes;
2. writes them to a unique same-directory
   `.identity-v1.<pid>.<random>.tmp` file with mode `0600` where supported;
3. fsyncs and closes that temporary file;
4. atomically creates the final `identity-v1` hard link from the temp, requiring
   no-clobber semantics;
5. fsyncs `<stateRoot>` where supported to confirm final-name durability;
6. removes the temp name after successful publication; and
7. fsyncs `<stateRoot>` again where supported to confirm temp cleanup.

The temp name must match
`^\.identity-v1\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$`; readers consume only the
final `identity-v1` regular file and only after validating exactly 32 bytes.
Successful no-clobber hard-link creation is the key publication point. A stale
lock holder cannot replace the final file. If publication returns `EEXIST`, the
loser deletes its temp and reads/validates the winner; it never regenerates or
replaces the final key. If the winner is malformed, state is unavailable.

Before publication, failure or creator crash leaves at most an ignored temp and
no reader consumes it. Once publication succeeds, the key is used even if temp
unlink, directory fsync, compromise notification, or lock release fails;
post-publication failure never causes key regeneration. Generic warnings may
report reduced durability, temp-cleanup failure, or release failure but contain
no key or identity. Exact identity temps older than 24 hours are removed
opportunistically under the identity lock.

If same-filesystem hard-link creation with atomic no-clobber semantics is not
supported, identity state and statistics are unavailable on that filesystem.
There is no overwrite, rename-over-final, copy, or check-then-create fallback.

After one locked, valid server read, the process may cache those immutable 32
bytes for its lifetime. It never watches, reloads, or rotates the key. Lock
release failure after a valid read emits a generic warning but does not cause a
second read or key generation. The TUI independently reads and validates the
same final bytes when resolving a mounted project.

The first creation of `projects/` fsyncs `<stateRoot>`, and the first creation
of a `<projectKey>` directory fsyncs `projects/`, where directory fsync is
supported. Unsupported or failed namespace sync leaves atomic visibility but
power-loss durability best-effort.

The complete `<stateRoot>`—`identity-v1` and every project directory—is one
inseparable backup/restore unit. Identity-key replacement or rotation and
partial restore are unsupported. A valid but replaced key can silently derive
different opaque names and orphan existing totals; this is an accepted
residual risk. A malformed or unreadable key is unavailable and byte-preserved.

For project identity, both processes use the canonical OpenCode directory
context and run:

```text
git -C <directory> rev-parse --path-format=absolute --git-common-dir
```

On success, they pass the absolute result through Node `fs.realpath`. If that
form is unsupported or fails, they retry with
`git -C <directory> rev-parse --git-common-dir`; an absolute result is passed
directly to Node `fs.realpath`, and a relative result is resolved against
`<directory>` first. If Git identity cannot be obtained, including for a
non-Git directory, they use Node `fs.realpath(<directory>)`. Thus linked
worktrees share the Git common directory.

The exact canonical identity string is the Node realpath result after platform
`path.normalize`, with trailing platform separators removed except when the
normalized string equals its filesystem root. There is no Unicode
normalization, case folding, locale transformation, trimming, or slash-style
conversion. Canonical identity bytes are Node UTF-8 encoding of that exact
string. Windows drive and UNC roots retain their root separator.

The server session source is hook `input.sessionID`. The TUI source is sidebar
`props.session_id`, which is valid for derivation if and only if it is a
non-empty JavaScript string; whitespace is not trimmed. Missing, empty, or
non-string TUI session IDs make statistics unavailable. Any non-empty value is
valid whether or not the server has observed it. A valid derived key with no
Session bucket displays Session empty plus any Project data; there is no
server-observation predicate.

Keys are lowercase hexadecimal HMAC-SHA-256 values using the exact byte
contract below. Prefixes are ASCII followed by one literal NUL byte `0x00`.
The project key embedded in the session message is its 64-byte lowercase ASCII
hex representation, not the raw 32-byte digest. Session ID bytes are Node UTF-8
encoding of the exact non-empty JavaScript string with no normalization,
trimming, or case transformation:

```text
projectMessage = ASCII("project-v1") || 0x00 || UTF8(canonicalProjectIdentity)
projectKey = lowercaseHex(HMAC-SHA-256(identityKeyBytes, projectMessage))

sessionMessage = ASCII("session-v1") || 0x00 || ASCII(projectKey) ||
                 0x00 || UTF8(sessionID)
sessionKey = lowercaseHex(HMAC-SHA-256(identityKeyBytes, sessionMessage))
```

The frozen golden vector is:

```text
identity key bytes: 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f
                    10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f
canonical identity: /repo/.git
session ID:         ses_123
project message hex:
70726f6a6563742d7631002f7265706f2f2e676974
projectKey:
9877aa91fdb53af2fb9b1089b1db1c6e47f352b8ac10f2ac57bdafdeeee9463a
session message hex:
73657373696f6e2d76310039383737616139316664623533616632666239623130383962316462316336653437663335326238616331306632616335376264616664656565653934363361007365735f313233
sessionKey:
85c4febf5950d803cc78712e340004ff787a33d84c13d4a19207e39f0ded717f
```

Golden identity tests also cover Windows-normalized drive/UNC strings and prove
canonically distinct NFC and NFD strings remain distinct through UTF-8 and HMAC.

No raw canonical project identity or session ID is persisted or logged.

## Worker project context and publication capability

Server activation resolves state root and canonical project identity from the
immutable `PluginInput.directory`, consumes/creates `identity-v1`, derives the
project key, and computes
`projectDir = <stateRoot>/projects/<projectKey>`. It starts the recorder worker
at activation, before any hook job, with immutable worker data containing only:

```text
stateRoot
canonicalProjectIdentity
projectKey
projectDir
pluginVersion
metricVersion = o200k_base:gpt-tokenizer@4.0.0:v1
```

The canonical identity is process-lifetime context, never a queue field. All
normal and oversize jobs use this context and carry no raw project identity,
directory, state root, project key, plugin version, or metric version.
Jobs admitted while the startup probe is running remain inside the existing
16-job/8-MiB queue bounds and are processed only after a fresh available marker
has been published. Failed initialization drops those jobs without affecting
tool output.

At every worker startup—including when a valid identity key and snapshots were
restored—the worker tests the exact `snapshots/` filesystem before accepting
snapshot writes. It first removes the prior `capability-v1.json` marker;
successful removal or `ENOENT` is required before probing. Any other removal
failure runs the unavailable-marker sequence below and stops startup. The worker
then writes and fsyncs a unique
`.capability-probe.<pid>.<32-lowercase-hex>.tmp` file inside `snapshots/`, closes
it, atomically hard-links it with no-clobber semantics to the corresponding
unique `.capability-probe.<pid>.<32-lowercase-hex>.final`, and removes both
names. Probe names never match snapshot final/temp names and are never parsed as
snapshots. Exact abandoned probe artifacts older than 24 hours are cleaned
opportunistically.

The capability marker path is exactly `<projectDir>/capability-v1.json`. Its
JSON has exact members only and is duplicate-aware parsed:

```json
{
  "protocol": "stats-capability-v1",
  "status": "available",
  "checkedAtMs": 1787443200000
}
```

`protocol` is exactly `stats-capability-v1`; `status` is exactly `available` or
`unavailable`; and `checkedAtMs` is a nonnegative UTC epoch-millisecond safe
integer. No generation, reason, path, identity, or other member is permitted.
The worker writes a complete marker to a unique same-directory
`.capability-v1.<pid>.<32-lowercase-hex>.tmp`, closes it, and atomically renames
that temp over `capability-v1.json`. Marker replacement provides whole-file
visibility only; it is neither a statistics commit point nor a fencing
boundary. Exact abandoned marker temps older than 24 hours are cleaned
opportunistically under the project lock.

After a successful probe and cleanup, the worker atomically publishes
`available` and refreshes it every 2 seconds with a new `checkedAtMs` while
statistics remain enabled. Before each refresh and each snapshot hard-link, it
strictly rereads the marker. A valid fresh `available` marker permits the
operation; `unavailable`, missing, malformed, unreadable, or expired state makes
that worker stop and drop subsequent jobs. A snapshot hard-link is therefore
attempted only while both in-memory capability and the filesystem marker are
available and `abs(workerNowMs - checkedAtMs) <= 5000`. Probe failure or
available-marker publication failure stops statistics for that project.

At startup and before any permanent write-side disable, the worker first tries
to remove the prior available marker so readers cannot treat it as current. It
then best-effort atomically publishes `unavailable`. If unavailable-marker
publication fails, it removes `capability-v1.json` again. If neither rewrite nor
removal succeeds, the worker stops and performs no refresh; the old marker ages
past the 5-second acceptance window and becomes unavailable without process
generation knowledge.

Any later snapshot publication failure reported as `ENOSYS`, `ENOTSUP`,
`EOPNOTSUPP`, `EXDEV`, or a permanent hard-link policy failure (`EPERM` or
`EACCES` from the snapshots-filesystem publication operation) immediately sets
the in-memory capability state to unavailable, runs that disable sequence, and
drops the failed and all subsequent jobs. It never falls back to mutable
publication. A transient non-capability publication error retains the existing
one-retry rule and does not rewrite capability unless the retry establishes a
permanent failure.

The TUI first validates `props.session_id`; a missing, empty, or non-string value
is immediately unavailable and does not enter initialization grace. For a valid
non-empty string, it resolves the state root and canonical project identity with
the shared module. On first-run missing identity state with no existing project
directory, it starts the project's single 5-second initialization deadline and
displays initializing while the server bootstrap may publish the key. Missing
identity with existing project state or malformed identity is immediately
unavailable. Otherwise it remains initializing while elapsed time is at most
5,000 ms and becomes unavailable when elapsed time is greater than 5,000 ms.
Key appearance does not restart the deadline. Once the TUI has exactly 32 final
key bytes, it derives project/session keys locally.

On mount, every 2-second poll, and every watch-triggered refresh, the TUI reads
and validates capability before scanning snapshots:

- A missing marker uses the same per-project 5-second deadline, starting it only
  if missing identity has not already done so. During grace the UI is
  `Stats initializing` and hides all last-good values while elapsed time is at
  most 5,000 ms; missing when elapsed time is greater than 5,000 ms is
  `Stats unavailable`. A valid marker clears the deadline; a project change
  creates a new project deadline; key appearance and a session-only switch do
  not restart it.
- An `unavailable`, malformed, duplicate-member, unsupported, non-regular, or
  non-transiently unreadable marker is immediately `Stats unavailable` and
  hides last-good and snapshot values.
- An `available` marker is accepted only when
  `abs(tuiNowMs - checkedAtMs) <= 5000`. An older or too-far-future marker is
  `Stats unavailable`. Only an accepted available marker permits snapshot
  scanning and current/zero display.
- `EINTR`, `EAGAIN`, or `EBUSY` while reading the marker is a transient marker
  read failure. With last-good values and a last accepted available marker still
  inside its 5-second window, the UI displays `Stats stale`; without last-good,
  or after that window expires, it displays `Stats unavailable`. `ENOENT` uses
  the missing-marker rule; every other marker error is unavailable.

Thus no snapshot is displayed as current or zero without a fresh available
marker. No custom OpenCode event, RPC, or other cross-process communication API
is part of this design.

## Privacy and threat model

Snapshots and their names contain only schema/metric metadata, safe numeric
aggregates, and opaque HMAC keys. They contain no raw payload, path, argument,
call ID, canonical project identity, canonical session identity, title,
attachment, `metadata.result`, or `metadata.outputPath`. Raw before/after
strings and raw job session IDs exist transiently in bounded server-process
memory and worker messages only. The canonical project identity exists in
activation
bootstrap/immutable worker data and TUI identity-derivation memory; it is never
a hook job field, snapshot/marker field, filename, or log value.

HMAC prevents accidental disclosure and prevents a state-only reader from
directly learning project/session identities. It does not protect against an
attacker who can read both `identity-v1` and state and can guess candidate
identities. Aggregate values are not encrypted at rest. An attacker with
process memory, host privileges, crash dumps, or access to raw OpenCode output
is outside this storage privacy boundary. Stronger adversaries, state sharing
between machines, or a requirement to hide numeric aggregates requires a
security review and a separate encryption/key-management decision.

## Locking, atomicity, and crash behavior

Pin `proper-lockfile@4.1.2` (MIT). Server-side identity publication/consumption
locks the existing state-root directory; TUI identity reads are lock-free and
consume only the validated final file. Snapshot writers lock the existing
`<stateRoot>/projects/<projectKey>` directory, producing the project-scoped
`<stateRoot>/projects/<projectKey>.lock` directory. Snapshot readers do not
take the project lock.

Every proper-lockfile acquisition uses this exact profile:

```text
realpath: false
stale: 10000
update: 2000
retries: {
  retries: 5,
  factor: 1.5,
  minTimeout: 25,
  maxTimeout: 150,
  randomize: true
}
total acquisition deadline: <= 500 ms
```

The external 500 ms deadline stops further attempts even if randomized retry
timing would otherwise exceed it. A dead owner becomes recoverable after the
10-second stale threshold, so stale takeover can produce overlapping holders.
The lease is an optimization for low normal contention, not the correctness or
fencing boundary. No safety claim assumes it remains exclusive after takeover.

The proper-lockfile compromise callback sets a holder-local compromised flag
and emits only a generic warning. Every identity publisher and snapshot writer
checks that flag immediately before no-clobber publication and aborts if it has
observed compromise. If notification is delayed until after the check,
immutable no-clobber publication still prevents replacement.

For one admitted worker job, a snapshot attempt:

1. acquires the project lock within the bounded profile;
2. performs the bounded filename scan and duplicate-parses/strictly validates
   the highest completed candidate, or starts from revision zero only when no
   completed candidate exists, identity state is valid, and capability is
   freshly available;
3. samples one validated `nowMs`, applies the job with checked arithmetic,
   performs Session retention, and sets the document revision to checked
   `N + 1` from the selected current revision `N`;
4. writes the complete UTF-8 JSON document with mode `0600` where supported to
   a unique temp in `snapshots/`, fsyncs where supported, and closes it;
5. checks the lock-compromised flag immediately before publication;
6. atomically hard-links the temp to the exact unused final name
   `snapshots/stats-v1.<N+1>.json`, requiring same-filesystem no-clobber
   semantics;
7. after successful publication, fsyncs `snapshots/` where supported, removes
   the temp name, performs bounded completed-snapshot/temp cleanup, fsyncs
   `snapshots/` again where supported, and releases the lock.

Successful no-clobber creation of the final hard link in step 6 is the
visibility commit point for that immutable file. The link is published only
after the complete temp has been written and closed, so readers never
intentionally observe partial JSON. There is no overwrite operation and no
rollback. Once publication succeeds, the worker never retries or reapplies that
job, even if temp unlink, cleanup, directory fsync, compromise notification, or
lock release subsequently fails. Those post-publication failures emit generic
cleanup/durability/release warnings only.

If publication returns `EEXIST`, another holder has already claimed that exact
revision. The writer treats this as a fencing collision or compromised
ownership, removes its temp where possible, drops this telemetry job, and emits
one generic warning. It never overwrites, retries, rebases, or reapplies a job
after `EEXIST`.

Before publication, an attempt is uncommitted. A transient lock, compromise,
temporary-file, or non-collision publication failure may be retried at most
once only while the same in-memory worker still owns that same job. A retry
acquires the lock again, repeats the bounded scan, and re-reads/revalidates the
highest current revision before applying the delta; it never reuses a
previously calculated next revision or serialized snapshot.
Validation/corruption, unsupported schema/metric, checked-overflow,
invalid-time, `EEXIST`, or unsupported no-clobber failures are non-retryable. A
lock release failure before publication is uncommitted and follows the same
one-retry maximum; release failure after publication is committed and never
retried.

Suppose a stale holder built revision `K` while another holder advanced current
to a revision greater than `K`. If `stats-v1.K.json` still exists, the stale
holder receives `EEXIST`. If cleanup had removed that lower name, the stale
holder can publish immutable revision `K`, but it cannot replace or outrank the
higher file. Readers continue selecting the numerically higher revision. The
stale delta can therefore be ignored or removed by cleanup; this accepted loss
is incomplete telemetry, not clobbering of committed totals.

After each successful publication, the writer rescans under the same bounds and
retains the two numerically highest completed snapshots that independently pass
duplicate-aware parsing, strict validation, and filename/document revision
agreement. It removes only older completed snapshots that also pass those
checks. It never deletes corrupt, unsupported, malformed, or unrelated entries,
and never removes either of the selected latest two valid revisions. A stale
writer's later lower publication cannot outrank them. Exact snapshot temps
older than 24 hours are removed opportunistically. Cleanup failure is nonfatal
and cannot change publication status.

`ENOSYS`, `EINVAL`, or `ENOTSUP` from a file or directory durability sync is
treated as unsupported durability. Before publication, an unsupported temp-file
sync permits publication with a generic warning; other temp write/sync errors
remain uncommitted. After publication, all directory-sync outcomes retain the
committed classification. Directory fsync confirms namespace durability where
supported; unsupported or failed sync means power-loss durability of the final
name is best-effort, not that visibility failed.

`ENOSYS`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, or the defined permanent
`EPERM`/`EACCES` policy failure from hard-link publication runs the capability
disable/marker sequence and drops all subsequent jobs. The implementation never
falls back to overwrite rename, copy, or check-then-create. Other non-`EEXIST`
publication errors follow the one-retry pre-publication rule and then fail open
for tool output.

The queue is in memory and has no replay journal. A process crash before
publication loses the job. A process crash after publication leaves the
immutable file visible and cannot replay the job, preventing crash-driven
double counting. A crash during post-publication cleanup may leave extra valid
revisions or temps but cannot replace a higher revision. Process-crash tests
validate visibility boundaries only; they do not prove power-loss durability.

Readers use the bounded immutable-file selection rules above and take no
project lock. Storage or filesystem corruption can still make the highest
candidate unreadable. Filesystems without atomic same-filesystem hard-link
no-clobber semantics are unsupported for statistics.

A highest exact candidate with duplicate members, corrupt syntax, unsupported
`schemaVersion`/`metric`, invalid fields, or failed invariants is
**unavailable** and byte-preserved. Future writes for that project stop until
manual recovery or reset; there is no fallback to a lower revision, silent
zero, or automatic salvage. A missing completed candidate with a valid identity
key and fresh available capability is a valid zero state. A missing key
alongside any existing project directory is unavailable/orphaned as specified
above.

There is no reset UI. Operationally, users may stop OpenCode and delete the
affected `<projectKey>` directory to reset that project, or remove the entire
state root to reset all identities and totals. Deleting only the highest
revision would expose a retained lower revision and is not a reset. Stopping
processes is guidance to avoid races, not an enforced synchronization
mechanism; manual deletion while writers are active has undefined operational
results.

## Retention

The transaction uses its one validated `nowMs` sample for both timestamp update
and retention. The current Session and Project timestamps become the maximum of
their previous values and `nowMs`. After that update, a writer removes a
non-current session only when `nowMs` is greater than its `lastSeenAtMs` and the
difference is strictly greater than
`30 × 24 × 60 × 60 × 1000` milliseconds. A session at exactly 30 days is
retained. A future timestamp is retained, tolerating wall-clock regression.

If more than 256 sessions remain, the writer removes non-current sessions in
ascending `(lastSeenAtMs, opaque session key)` order until 256 remain. The
current session is never removed by either rule. Retention never changes the
Project aggregate. The cap has no cross-process liveness signal: another
currently active session can be evicted if its committed timestamp is the
oldest. Its next committed call recreates its bucket without restoring prior
Session history. This is an accepted limitation; the independent Project total
remains intact.

## Sidebar UX and lifecycle

The TUI uses an AFT-style `sidebar_content` block with Session and Project
sections. Expanded content uses these labels:

```text
LSP hook savings (estimate)

Session
  Est. context-token delta  ≈12.4K
  Savings rate              ≈64.9%
  Measured calls            12
  Truncated                 1

Project
  Est. context-token delta  ≈1.8M
  Savings rate              ≈62.9%
  Measured calls            420

o200k_base estimate · output context
```

`Measured calls` is exactly `measuredCalls`. The footer is exactly
`o200k_base estimate · output context`. Approximation marks describe the fixed
tokenizer proxy. Token deltas below 1,000 use an integer; thousands and millions
use one-decimal `K`/`M` compact notation. A positive nonzero estimate prefixes
the magnitude with `≈` (`≈320`, `≈12.4K`), a negative estimate prefixes it with
the Unicode minus sign followed by approximation (`−≈320`, `−≈1.2K`), and zero
is exactly `0`. Values are rounded to the nearest displayed unit and never
clamped.

Savings rate uses the derived `compressionPercent`: positive `≈64.9%`, negative
`−≈5.1%`, exact zero `0.0%`, and a zero-token baseline `—`. Percentage output
always has one decimal when available.

When `measuredCalls === 0`, the Session section says exactly
`No measured calls yet` instead of showing a headline delta or rate. If Session
has no bucket/observations and Project has measurements, Project rows follow
immediately. A valid locally derived but never-observed Session key uses this
same empty state. When an aggregate has `measuredCalls === 0` but
`observedCalls`, `excludedOversizeCalls`, or `tokenizerErrorCalls` is nonzero,
expanded content still says `No measured calls yet` and then shows its nonzero
`Oversize exclusions` and `Tokenizer errors` diagnostic rows. Session shows
`Truncated` whenever a Session bucket exists, including zero, because host
truncation in the current session is immediately actionable.

Project omits `Truncated` intentionally to keep the persistent historical
section compact; its Aggregate value remains persisted. Sidebar details/help
state `Project Truncated remains persisted in stats.` without changing the
exact metric footer. Pass-through counts are retained for validation and
diagnostics but omitted from the v1 sidebar.

During the defined missing-key/marker startup grace, expanded content displays
exactly `Stats initializing` and hides cached/snapshot values. Invalid state
root, orphaned/malformed identity, missing/empty/non-string `props.session_id`,
an unavailable/expired/malformed capability marker, or a corrupt/unsupported
highest snapshot displays exactly `Stats unavailable` and hides cached values.
A valid available capability marker plus no completed snapshot is zero, not
unavailable.

A duplicate-member or otherwise corrupt highest snapshot is always unavailable,
even if an older in-memory value exists. After at least one valid snapshot read,
a transient snapshot filesystem read/watch failure under a still-accepted
available capability marker retains last-good values and adds exactly
`Stats stale`; successful reread clears stale. Capability-marker transient-read
staleness follows the stricter 5-second rule above. Stale is never inferred
solely from snapshot age because snapshots update only with LSP activity.

Collapsed examples define all special formatting:

```text
positive:                    LSP ≈12.4K session / ≈1.8M project
negative:                    LSP −≈320 session / −≈1.2K project
measured zero:               LSP 0 session / 0 project
diagnostics, no measurement: LSP no measured data
Session empty, Project data: LSP ≈1.8M project
both empty:                  LSP no data
initializing:                LSP stats initializing
unavailable/corrupt:         LSP stats unavailable
stale last-good:             LSP stats stale · ≈12.4K session / ≈1.8M project
```

Collapsed `LSP no measured data` applies when the current Session has no
measurements but has observed/exclusion/error diagnostics; if Session has no
bucket/observations and Project has measurements, the Project-only form wins.
If neither aggregate has measurements but either has diagnostics,
`LSP no measured data` applies. `LSP no data` requires no measurements and no
observed/exclusion/error diagnostics in either aggregate.

The TUI watches the plugin state snapshots directory
`<stateRoot>/projects/<projectKey>/snapshots`, never the source project
directory. It performs an immediate bounded scan/read when the sidebar
component mounts and polls every 2 seconds for the entire mounted lifetime,
whether expanded or collapsed. `fs.watch` is only a hint. Watch setup failure,
including an absent directory, is nonfatal; polling detects the first immutable
publication and then retries watch setup.

Watch events use a trailing 200 ms debounce. The reader ignores stale async
results and skips value rerender when `revision` and status are unchanged. A
project or session switch first closes the old watcher, clears its poll and
debounce timers, and invalidates in-flight reads; only then does it resolve new
keys, establish new resources, and perform an immediate read. Solid
`onCleanup` owns component watchers/timers. `api.lifecycle.onDispose` clears any
plugin-level identity cache or other module-lifetime read resource. No watcher,
timer, cache entry, or stale read may survive its owning lifecycle.

The collapsed preference alone is stored in namespaced TUI KV. Statistics are
never copied into TUI KV.

## Performance contract

All numbers in this section are **pre-release acceptance gates**, not claims
about measurements already taken. Each release candidate publishes its raw
samples and a benchmark manifest. The manifest pins exact Bun and Node runtime
versions, plugin version/commit, lockfile and resolved dependency versions,
benchmark source revision, and statistics-on/off configuration. It records the
GitHub-hosted `ubuntu-24.04` runner class, image release, architecture, CPU, and
available memory. Version aliases such as `latest` invalidate a run.

### Warm hook protocol

Use statistics disabled through the injected no-op recorder as the baseline,
then repeat with a ready, warm worker. Exercise exact combined UTF-8 sizes of
1 KiB, 8 KiB, 32 KiB, and 64 KiB for each of ASCII JSON, BMP Unicode, and emoji
input shapes. `before` and `after` split each combined size as evenly as the
encoding permits; fixtures are checked for exact byte size before timing.

Each shape/size/configuration receives 1,000 unreported warmup calls followed
by 10,000 measured calls. Repeat the complete matrix in 10 controlled runner
runs. For every matrix cell and run, report statistics-off and statistics-on
p50, p95, p99, and maximum hook duration, their percentile deltas, and event-loop
delay. Every warm-worker run must have statistics-on minus statistics-off p95
at most 1 ms and p99 at most 2 ms for every input at or below 64 KiB. The timed
hook includes exact `Buffer.byteLength`, admission accounting, and worker
message submission, but reports the existing rewrite separately so the delta
isolates statistics overhead. Cold worker startup is a separate gate and never
mixed into warm percentiles.

### Declared workload and queue protocol

After worker warmup, offer 10 LSP calls per second for 60 seconds and then 32
calls within one second. Use the representative size/shape matrix and real
tokenization plus revision-fenced immutable publication on the runner's local
filesystem.
Require zero queue drops, job and byte high-water marks no greater than 16 and
8 MiB, and complete drain no later than 5 seconds after the last offered call.

Report offered, admitted, completed, and dropped counts; job-depth and UTF-8
byte high-water marks; enqueue and completion latency; lock wait; worker and
host CPU; worker heap and RSS; event-loop delay; and drain duration. Drops under
load outside this declared workload remain accepted incomplete telemetry and
increment only process-local `droppedQueueCalls`; they are not converted into
persisted outcomes.

### Maximum-input protocol

For ASCII JSON, BMP Unicode, and emoji shapes, separately test: the maximum
admitted combined UTF-8 size of exactly 4 MiB; a combined code-unit length at
or below 4 MiB whose exact UTF-8 size exceeds the cap; the smallest shape-valid
combined code-unit length above 4 MiB; and a `metadata.result` reconstruction
whose `after` string is at least 32 MiB. Report main-hook length-classification
and enqueue time, `Buffer.byteLength` call count and total scanned code units,
transferred string bytes, worker heap/RSS, garbage-collection time/counts,
completion latency, and post-drain recovery.

Exactly-at-cap admitted jobs transfer and tokenize. Every over-cap path
transfers zero output-string bytes and commits only an oversize exclusion if its
small job is admitted. Instrumentation must prove the code-unit-over-cap and
tens-of-MiB cases execute the O(1) `.length` short-circuit and invoke
`Buffer.byteLength` zero times; no UTF-8 scan may scale with those strings.
Exact combined UTF-8 bytes are retained only for admitted calls. After each
case, the queue must drain and a subsequent 1 KiB job must complete normally.
Large-input timing is reported separately and is outside the <=64 KiB hook
latency gate.

### Packaging and worker budgets

For the release artifact, report exact bytes for the registry tarball, the
installed package, and the installed transitive graph rooted at the direct
tokenizer and lock dependencies. Gates are:

- plugin registry tarball no greater than 250 KiB;
- aggregate unpacked graph rooted at direct `gpt-tokenizer@4.0.0` and
  `proper-lockfile@4.1.2` dependencies no greater than 30 MiB;
- cold worker ready—identity consumed, exact snapshots-filesystem probe passed,
  fresh available marker published, tokenizer loaded, and queue consumable—no
  later than 500 ms on the reference runner;
- worker RSS no greater than 80 MiB in the cold-start and maximum-input runs;
  and
- zero tokenizer, proper-lockfile, worker, or recorder modules in the TUI
  import graph and bundle; the shared identity module and Node fs/path/crypto/
  Git helpers are allowed.

The measured roughly 27 MiB unpacked size of `gpt-tokenizer@4.0.0` is an
accepted part of the 30 MiB graph budget, not a waiver of that gate.

### TUI protocol

Use a valid fresh available capability marker and a maximum fixture with 256
retained Session buckets in each of the latest two completed revisions and the
exact bounded directory layout. The benchmark manifest pins and records the TUI
runtime/plugin/dependency versions and the same reference runner metadata used
by the server benchmarks. These are pre-release gates, not current measurements.

For capability-first refresh + bounded scan + read + duplicate-aware parse +
validation + aggregate derivation using the mounted project's already derived
keys, run 100 unreported warmups and 5,000 measured samples, repeated in 5
controlled runs. Report p50, p95, p99, and maximum for every run. Every run must
have p95 at most 10 ms. State-root/project/session key derivation occurs once on
mount or project/session switch and is reported separately in the lifecycle
protocol rather than hidden in recurring refresh samples.

For watch freshness, perform 100 atomic no-clobber snapshot publications per
run for 5 runs, sequencing them so each accepted revision is observed before
the next publication. Measure from successful final hard-link publication
timestamp to the Solid signal's revision update. Report p50, p95, p99, and
maximum; every run must have p95 at most 500 ms.

For polling-only freshness, disable watch, perform 20 accepted publications per
run for 3 runs, and require the maximum publication-to-Solid-signal duration to
be at most 2.5 seconds. Publication-to-signal is the only freshness endpoint.

For mounted-idle cost, run 60 seconds in each of 5 runs with no revision change.
Each run permits at most 31 poll refresh reads (one capability-first refresh
transaction per scheduled poll), at most 35 timer wakeups, and at most 100 ms
of process CPU consumed by the plugin, and permits no rerender when the selected
revision and status are unchanged.

For lifecycle cost, perform 100 alternating project/session switches per run
for 10 runs. After each run's cleanup and forced GC, plugin-attributable heap is
at most the pre-run baseline plus 2 MiB; active watcher and timer counts return
exactly to baseline. Renders are at most one initial render per switch plus one
for each accepted new revision, with no render for an unchanged selected
revision. Report CPU, wakeups, reads, rerenders, timer/watcher counts, heap/RSS,
and accepted revision counts for every run.

Failure of any gate blocks release. A TUI dependency leak requires packaging
review; a hook latency miss requires profiling of byte counting, transfer, and
queue accounting; and a filesystem lacking atomic same-filesystem hard-link
no-clobber publication is unsupported for statistics and requires
storage-specialist review before any new design.

## Alternatives considered

- **Pure DTO-compaction savings:** rejected because it would omit real
  truncation/untruncation effects and could turn truthful negative hook effects
  into misleading positive claims.
- **Synchronous tokenization or persistence in the hook:** rejected because
  tokenizer work, lock contention, and fsync would block OpenCode's event loop
  and tool completion.
- **TUI tokenization or a TUI-only recent window:** rejected because the TUI
  must stay lightweight and a recent message window cannot produce a durable
  Project total.
- **SQLite:** rejected because a numeric snapshot needs neither query planning
  nor another native/runtime packaging surface.
- **Journal plus snapshot:** rejected because per-call persistence and audit
  complexity are not warranted for estimated telemetry.
- **One mutable single-path snapshot:** rejected because a stale lease holder
  could replace a higher committed aggregate. Revision-named immutable
  no-clobber files fence stale holders without becoming an audit journal.
- **Raw paths/session IDs as keys:** rejected because opaque HMAC keys avoid
  accidental identity disclosure in filenames, snapshots, and logs.
- **Heuristic characters-per-token proxy:** rejected because a pinned
  `o200k_base` implementation provides reproducible, testable estimates.
- **Native/WASM tokenizer alternatives:** rejected for v1 because the selected
  pure-JS package has the simpler server packaging contract; its larger
  unpacked size is explicitly accepted.

## Delivery boundaries and approval order

This ADR does not authorize executable work. A separately approved delivery
must preserve these dependency boundaries in order:

1. Freeze schema, HMAC/domain vectors, shared state-root/canonical-identity
   contract, tokenizer goldens, and fail-open recorder contracts before
   integration.
2. Establish the isolated worker, bounded admission, lock optimization,
   revision-fenced immutable publisher, corruption behavior, and retention
   before connecting the hook.
3. Connect the injected recorder only after output/metadata compatibility and
   enqueue benchmarks pass.
4. Add the lock-free TUI reader and lifecycle only after snapshot, shared
   identity, and capability-marker behavior is stable; approve the package split
   before bundling.
5. Enable the sidebar only after multiprocess, crash-stage, privacy, lifecycle,
   performance, and LSP end-to-end gates pass.

Any schema/metric migration, encryption-at-rest requirement, broader threat
model, filesystem without hard-link no-clobber semantics, or relaxation of the
event-loop target requires a new architecture approval.

## Acceptance criteria

### Metric and counter behavior

- A counter-matrix test covers measured changed output, exact JavaScript-string
  pass-through (`before === after`), oversize exclusion, tokenizer failure, and
  each outcome with `hostTruncatedAtEntry` true and false. It proves truncation
  is captured before rewrite and cannot be changed by later metadata mutation.
  Unicode cases prove distinct unpaired-surrogate strings are not pass-through
  even if their UTF-8 replacement bytes match. Property tests assert the counter
  equations, nonnegative safe integers, checked overflow, zero-token behavior,
  and `passThroughCalls <= measuredCalls`.
- Golden hook cases cover ordinary compact rewrite; a truncated preview plus
  full `metadata.result` that produces negative savings; truncated parse-fail
  pass-through; `No results found` pass-through; and empty strings with zero
  tokens. They prove `metadata.result` is never the baseline.
- Admission tests assert exact UTF-8 byte counts for admitted ASCII, BMP, emoji,
  CRLF, and unpaired-surrogate strings. They cover exactly 4 MiB admitted,
  <=4 MiB code units but >4 MiB UTF-8, >4 MiB code units, and reconstructed
  `after` strings of at least 32 MiB. Instrumentation proves code-unit-over-cap
  cases call `Buffer.byteLength` zero times, transfer no strings, and use the
  O(1) length branch. A dropped exclusion remains process-local and never
  breaks persisted algebra.
- Derived-value tests cover positive, zero, negative, and null
  `compressionPercent` aggregates. Project-total tests prove pruning sessions
  does not alter the independent historical Project aggregate.

### Identity, environment, and privacy

- Identity tests cover linked worktrees, the absolute Git command, fallback
  for an unsupported `--path-format`, relative Git common-dir output, non-Git
  directories, Node realpath, platform `path.normalize`, root-preserving
  trailing-separator removal, no case folding/Unicode normalization, and exact
  server/TUI session-ID predicates.
- HMAC tests assert the frozen `00..1f` key vector byte-for-byte, including
  ASCII prefixes plus literal `0x00`, canonical-identity UTF-8, the 64-byte
  lowercase ASCII project key inside the session message, both message hex
  strings, and both expected digests. Additional vectors cover Windows drive/
  UNC normalization and preserve NFC/NFD strings as distinct.
- A dual-process first-run test creates one state root, acquires the root lock
  in both processes—including forced stale-lock overlap—publishes exactly one
  32-byte final key through no-clobber hard link, and proves the `EEXIST` loser
  deletes its temp and reads the winner. Both derive the same opaque keys. The
  test verifies `0700`/`0600` where supported, exact temp naming/isolation,
  exact-byte validation, parent-directory sync attempts, and temp cleanup.
- Identity crash tests terminate the creator before temp completion, after temp
  fsync but before hard-link publication, immediately after hard-link success,
  after directory sync, and during lock release. Before publication no reader
  consumes a temp; after publication no process regenerates or replaces the
  key. Unsupported hard-link capability and missing key with existing project
  directories are unavailable without fallback.
- Residual-behavior tests/documentation cover malformed keys, a valid replaced
  key, key-only backup/restore, project-only restore, and complete state-root
  restore. Corruption is unavailable; valid replacement/partial restore may
  silently orphan totals and is explicitly unsupported rather than repaired.
- TUI identity tests read only the final regular `identity-v1` without
  `proper-lockfile`, validate exactly 32 bytes, and derive project/session keys
  locally. Missing/empty/non-string `props.session_id` is unavailable. Any
  non-empty string is valid; a never-observed derived Session key renders
  Session empty plus Project data rather than unavailable.
- Environment tests cover absolute XDG roots, invalid relative XDG roots,
  Linux/macOS fallback, Windows `LOCALAPPDATA` path joining, unavailable home
  variables, different process environments, and a valid identity key present
  only under one environment root. Shared-module tests prove server and TUI
  independently derive identical state roots, canonical identities, project
  keys, and session keys from identical inputs.
- Privacy tests inspect snapshots, capability markers, filenames, temporary/
  probe files, serialized job envelopes, and captured logs for prohibited raw
  data, including every generic durability, compromise, and release warning.
  They prove canonical project identity appears only in immutable process
  context/local derivation memory, never in jobs or state; raw session ID is
  permitted only in its declared transient job field and never in persisted
  state/logs. Attacker-boundary tests demonstrate that state alone reveals no
  direct identities, while state plus `identity-v1` and a candidate identity
  can reproduce its HMAC; no encryption claim is made.

### Worker, tokenizer, and compatibility

- Activation tests prove immutable worker data is derived from
  `PluginInput.directory` and contains exactly state root, canonical project
  identity, project key, project directory, plugin version, and metric version.
  Normal and first-call oversize jobs contain no directory, state root,
  canonical identity, project key, or other project initialization context.
- Queue tests enforce 16 jobs and 8 MiB of exact UTF-8 output-string bytes,
  include the active job, charge exclusion envelopes zero string bytes, drop
  newest before retention, release credits only on completion, and prove
  `droppedQueueCalls` is process-local and absent from `Aggregate` and snapshot
  JSON. Persisted aggregate algebra remains valid after drops.
- Worker startup, worker crash, message failure, tokenizer failure, lock
  failure, and persistence failure never reject the statistics tail or affect
  tool output.
- Statistics-on and injected no-op runs produce byte-identical output fields
  and identical metadata, including `result`, `truncated`, and `outputPath`.
- Pinned tokenizer goldens assert exact counts for ASCII JSON, Unicode text,
  emoji, CRLF, empty strings, and unpaired-surrogate JavaScript strings.
- Package/license checks pin `gpt-tokenizer@4.0.0` and
  `proper-lockfile@4.1.2`, record MIT licenses and the accepted tokenizer size,
  enforce all package/worker byte and startup/RSS budgets, and fail if the TUI
  import graph or bundle includes tokenizer, lock, worker, or recorder code.
  The shared identity module and its Node fs/path/crypto/Git helpers are the
  only permitted identity/statistics-related TUI imports.

### Publication capability

- Startup tests remove an old marker, probe with unique non-snapshot temp/final
  names in the exact snapshots filesystem, and publish/refresh the strict
  `stats-capability-v1` marker. They repeat with an already valid restored key
  and snapshot on a hard-link-unsupported filesystem and require unavailable,
  proving restore cannot bypass the probe.
- Marker validation tests cover exact members, both statuses, safe
  `checkedAtMs`, duplicate/unknown members, malformed/non-regular files, the
  2-second refresh, absolute 5-second freshness window, and capability-first
  snapshot reads.
- UI state tests cover first-run key absence, marker absence during the 5-second
  startup grace (`Stats initializing`), missing beyond grace, explicit
  unavailable, expired/future marker, and fresh available with both zero and
  existing snapshots. Available is required before every current/zero display.
- Failure tests cover startup marker-removal failure, probe failure, available-
  marker write failure, later `ENOSYS`/`ENOTSUP`/`EOPNOTSUPP`/`EXDEV` and
  permanent-policy publication failure, unavailable-marker write failure, and
  marker removal failure. They prove the worker stops/drops subsequent jobs,
  old available state is not refreshed and expires within 5 seconds, and TUI
  polling moves last-good data to unavailable.
- Marker-read tests distinguish missing (`initializing` then unavailable),
  explicit/invalid/expired state (unavailable), and only
  `EINTR`/`EAGAIN`/`EBUSY` (stale while last-good and last accepted capability
  remain within 5 seconds). No test uses a custom event, RPC, generation, or
  process-identity side channel.

### Validation, locking, crash safety, and retention

- Duplicate-aware parser tests inject duplicate members at every object level.
  Strict-validator table/property tests cover exact members, unknown/missing
  fields, schema/metric values, positive revision, safe integers, exact
  64-lowercase-hex keys, all aggregate equations and zero implications,
  nonzero Session observations, the 256-bucket maximum, and checked retained
  Session sums no greater than Project fields. They also require every retained
  `session.lastSeenAtMs <= project.lastSeenAtMs`. Every rejected file remains
  byte-identical; a rejected highest candidate blocks subsequent writes.
- Filename/selection tests cover canonical positive decimal revisions, no
  leading zeros/signs, safe-integer overflow, exact temp/final regexes, regular
  files, filename/document revision equality, the 512-entry and 64-candidate
  bounds, empty state, scan-retry `ENOENT`, and highest-revision selection. A
  corrupt/unsupported highest candidate is unavailable with no fallback to a
  valid lower candidate.
- Lock-option tests assert `proper-lockfile@4.1.2`, `realpath: false`, the exact
  stale/update/retry profile, and the external <=500 ms acquisition deadline
  for both identity and project locks. Normal contention, a paused heartbeat,
  compromise callback, owner death, and recovery only after the stale threshold
  are exercised. Forced overlapping holders prove no correctness assertion
  depends on lease exclusivity.
- A multiprocess writer test proves normal serialized updates advance immutable
  revisions without lost committed deltas, preserve exact invariants, and expose
  only complete JSON to lock-free readers. Forced stale holders prove a lower
  publication cannot replace/outrank a higher revision and same-revision
  `EEXIST` drops the telemetry job without retry/rebase/reapply. Delayed
  compromise callbacks cannot defeat no-clobber fencing; an observed callback
  aborts immediately before publication.
- Failure-injection tests cover lock acquisition/release, temp create/write/fsync,
  validation, compromise, hard-link publication, `EEXIST`, unsupported
  no-clobber capability, temp unlink, cleanup, directory fsync, and
  post-publication lock release. Every retryable pre-publication attempt is
  limited to the same worker-owned job, occurs at most once, and rescans the
  current highest revision under a newly acquired lock. Publication success is
  committed exactly once; cleanup, directory-fsync, or release failure after
  publication emits a generic warning and never rolls back, retries, or
  reapplies.
- Process-crash tests terminate before temp write, during partial temp write,
  after temp fsync, immediately before hard-link publication, immediately after
  hard-link success, during temp unlink/retention cleanup, and before/after
  directory fsync. Readers observe only complete immutable files;
  pre-publication jobs are lost without replay, published files appear once,
  partial temps are ignored, and stale-temp cleanup runs. These tests make no
  claim about power-loss durability.
- Retention/cleanup tests keep the two highest independently valid completed
  revisions, delete only older valid completed files, preserve invalid and
  unknown bytes, clean exact temps older than 24 hours, and prove a later stale
  lower publication cannot become current.
- Corrupt JSON, duplicate members, unsupported schema/metric, invalid
  fields/invariants, transient `ENOENT`, unsupported durability sync, and other
  I/O failures exercise the exact unavailable, stale, retry, preservation, and
  fail-open rules.
- UTC retention tests use one `nowMs` per transaction and cover a regressed
  clock, monotonic max timestamps, exactly 30 days, 30 days plus 1 ms, future
  timestamps, the 256-session boundary, deterministic
  `(lastSeenAtMs, opaque key)` ties, current-writer protection, eviction of a
  different active-but-old session, recreation of that bucket, and unchanged
  Project totals.

### Reproducible performance

- Pre-release benchmark artifacts contain the exact pinned runtime/plugin/
  dependency and runner manifest, raw samples, and all required percentile,
  event-loop, queue, completion, lock, CPU, memory, GC, wakeup, read, and
  rerender reports. The report explicitly says the gates are release evidence,
  not historical claims in this ADR.
- Ten controlled warm-hook runs execute the 1,000-warmup/10,000-sample matrix
  for every 1/8/32/64 KiB and ASCII JSON/BMP/emoji cell against a statistics-off
  baseline. Every run meets p95 delta <=1 ms and p99 delta <=2 ms.
- The 10-calls/second-for-60-seconds plus 32-in-one-second workload completes
  with zero drops, bounded high-water marks, and <=5-second drain. Maximum-input
  tests cover exactly-at-cap and over-cap ASCII/BMP/emoji behavior, an at-least
  32-MiB reconstructed `after`, zero `Buffer.byteLength` calls on code-unit
  short-circuit cases, and recovery.
- Packaging, cold-ready, worker-memory, TUI parse/freshness/idle-read, and
  lifecycle gates execute the exact TUI protocols: 100 warmups + 5,000 samples
  across 5 read runs; 100 publications across each of 5 watch runs; 20
  publications across each of 3 poll-only runs; five 60-second idle runs; and
  100 switches across each of 10 lifecycle runs. Every per-run p95/max,
  read/wakeup/CPU, heap, resource-count, and rerender budget in the Performance
  contract must pass. No average can mask a failing required run.

### TUI and end to end

- Formatting tests assert exact rows and sign order for positive `≈`, negative
  `−≈`, token zero `0`, one-decimal percentages, null `—`, compact K/M,
  `No measured calls yet`, diagnostic rows, `LSP no measured data`, Project-only
  collapse for an unobserved Session, `LSP no data`, `Stats initializing`,
  `LSP stats initializing`, `Stats unavailable`, `LSP stats unavailable`, and
  stale last-good states. They cover measured-zero with observed/exclusion/error
  diagnostics, Session host-truncated display, and intentional Project
  Truncated omission plus persisted-detail text.
- Lifecycle tests cover immediate mount read, polling while mounted, collapsed
  polling with capability read before snapshot scan, trailing debounce, failed
  watch setup, snapshots directory `ENOENT`, first immutable publication,
  transient marker/scan/open errors, highest-revision selection,
  revision/status-based rerender suppression, initializing/unavailable/stale
  transitions, project/session teardown-before-setup, stale-read cancellation,
  Solid `onCleanup`, and `api.lifecycle.onDispose`, with no leaked component or
  plugin resources.
- End-to-end coverage enables `OPENCODE_EXPERIMENTAL_LSP_TOOL`, executes a real
  or protocol-faithful stubbed builtin `lsp` call through OpenCode. Using the
  same chosen non-empty session value through server hook `input.sessionID` and
  TUI `props.session_id`, it proves both processes independently derive
  identical state roots, canonical project identities, project keys, and
  session keys through the shared module. It
  asserts exact numeric Project/Session counters in the selected highest
  immutable revision, the retained-revision filename set, and exact
  expanded/collapsed sidebar rows. A second case derives a never-observed valid
  TUI session and shows Session empty plus Project data. The existing load-only
  smoke remains separate and does not satisfy this gate.

## Consequences and risks

The feature reports an estimate of output-context effect, not billing usage or
pure compaction. Queue pressure, process crashes, and persistence failures can
make totals incomplete by design, while negative values can surprise users.
The UI wording and local-drop limitation keep those trade-offs explicit.

The accepted dependencies add a sizable server-only tokenizer and a lock
library. Atomic visibility and durability ultimately depend on filesystem and
platform behavior. Corrupt or orphaned state intentionally remains unavailable
until manual action, preserving evidence at the cost of continued statistics.
Hard-link no-clobber publication commits immutable-file visibility even when a
later namespace fsync, cleanup, or lock release fails, so the latest visible
file may not survive power loss on every filesystem. In-memory pre-publication
work is intentionally lost on process crash rather than replayed with
double-count risk.

Proper-lockfile reduces ordinary collisions but cannot guarantee exclusivity
after stale takeover. Revision fencing prevents replacement; a stale lower
publication or `EEXIST` collision can still lose telemetry. That incompleteness
is accepted, and the retained pair of snapshots is not an audit history.

The identity key and project directories must be backed up and restored as one
unit. Key rotation/replacement and partial restore are unsupported and can
silently orphan otherwise valid totals. This residual is accepted because v1
stores no raw identity that could safely repair the mapping.

Security review is mandatory before storing raw data, sharing state or keys,
or claiming protection from a key-and-state attacker. Data/migration review is
mandatory before changing `stats-v1`, aggregate algebra, HMAC domains, or the
metric identifier. Performance review is mandatory if the TUI includes worker
code, queue limits change, or the enqueue p95 target is not met.

## Non-goals

- Pure DTO-compaction attribution.
- Billing-token measurement.
- By-operation persistence or sidebar views in v1.
- Raw call records, payloads, paths, arguments, call IDs, or identities at rest.
- A journal, SQLite database, or TUI-only recent-window aggregate.
- Historical backfill or automatic migration/salvage of unsupported state.
- Identity-key rotation/replacement or partial-state restore.
- A reset UI.
- Storing aggregates in TUI KV.
- Changing rewritten output bytes, titles, attachments, or tool metadata.
