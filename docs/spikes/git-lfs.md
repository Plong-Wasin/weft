# Git and Git LFS spike

Verified against the runtime image built from `docker/Dockerfile`, image ID
`sha256:8975bdcfde6a2b74a6bfc2254303226e983fb4f8a434f59dc14701fee70a2ae0`:
Git 2.39.5 and Git LFS 3.3.0 (linux/amd64). These are the versions in the
runtime stage of `docker/Dockerfile`; host versions are not evidence for this
spike.

Build the runtime image and run the repeatable checks from the repository root:

```sh
docker build -f docker/Dockerfile -t weft-runtime .
docker run --rm --entrypoint bash -v "$PWD:/w:ro" -w /w weft-runtime scripts/spikes/git-lfs.sh
```

The script creates disposable repositories under a temporary directory and
checks merge-tree/ref behavior, server-side LFS storage, a mirror import, a
stale compare-and-swap, upload-pack ref hiding, constrained object writes and
checkout behavior when `git-lfs` is absent. It does not modify a real Vault.

## Findings

- `git merge-tree --write-tree <ours> <theirs>` writes a tree object and leaves
  both the current worktree and all refs untouched. It computes the merge base
  itself. The result can be inspected before any branch is advanced.
- `git commit-tree <tree> -p <parent> ...` creates a commit object without
  creating or moving a ref. `git update-ref <ref> <new> <expected-old>` then
  provides compare-and-swap: two writers prepared from the same old object
  cannot both advance the ref. The loser fails and the winner's ref remains.
- Configure `uploadpack.hideRefs=refs/weft/proposals` to omit proposal refs
  from upload-pack advertisement, and `transfer.hideRefs=refs/weft/proposals`
  to cover transfer operations. The harness verifies the actual upload-pack
  advertisement includes ordinary refs but not the internal namespace. This
  is defense in depth; Weft still has no public git endpoint (ADR-0001).
- A server can produce the canonical LFS pointer with `git lfs pointer` and
  store the bytes directly at
  `.git/lfs/objects/<first-two-oid-chars>/<next-two-oid-chars>/<sha256>`. The
  pointer records the SHA-256 and byte size. The harness writes the pointer and
  object without an LFS client upload, then `git lfs fsck --objects` confirms
  the object is present and valid. Keep `.gitattributes` aligned with the
  pointer paths so subsequent checkouts invoke LFS filters.
- `git clone --mirror` preserves the source refs, commit IDs and raw binary
  blobs. It does not convert old binaries into LFS pointers; that is the
  required import behavior and avoids rewriting imported history. Newly
  written binaries can use LFS while historical raw blobs remain ordinary git
  objects.
- With no `git-lfs` executable/filter configuration, checkout succeeds but
  produces the committed pointer text; the binary itself is unavailable. Any
  Weft file-serving path must resolve LFS pointers to objects and report a
  missing/unavailable object as an error rather than serving pointer text as
  the binary.

## Failure behavior and operational consequences

- **Concurrent ref update:** demonstrated by two updates using the same
  expected-old value. The first succeeds; the stale compare-and-swap fails
  without overwriting the first result. Proposal apply must treat that as a
  conflict/recovery case, not retry with an unguarded update.
- **Disk full:** the harness simulates a constrained object write with a
  512-byte process file-size limit. Git reports failure and the object database
  remains readable (`git fsck --full`). This is a write-limit simulation, not
  an actual filesystem `ENOSPC` test. In production, do not advance a ref after
  a failed object or LFS write; surface the failure, restore space, clean up
  only verified stale temporary files, then retry from the unchanged ref.
- **Interrupted import:** a mirror import builds a separate destination and
  does not mutate the source. The spike did not inject a process kill during
  transfer. Import should therefore use a staging repository, verify refs and
  object connectivity before making it the active Vault repository, and
  discard/retry an interrupted staging import. Never expose a partially
  imported repository as a ready Vault.

No additional product-spec change is required: F12 already requires mirror
import without history rewriting and preservation of historical raw binaries;
ADR-0001 keeps git private and ADR-0002 requires compare-and-swap ref movement
and visible recovery for cross-store apply failures. The missing-object and
staging-import consequences above should be carried into the Knowledge import
and file-serving implementation.
