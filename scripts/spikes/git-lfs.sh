#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Weft spike'
export GIT_AUTHOR_EMAIL='spike@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

pass() {
    printf 'PASS: %s\n' "$1"
}

git --version
git lfs version

# merge-tree computes a merge result without checking it out or moving refs.
repo="$root/merge"
git init -q "$repo"
cd "$repo"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
printf 'base\n' > note.md
git add note.md
base=$(git commit -qm base && git rev-parse HEAD)
git branch ours "$base"
git branch theirs "$base"
git checkout -q ours
printf 'ours\n' > note.md
git commit -qam ours
ours=$(git rev-parse HEAD)
git checkout -q theirs
printf 'theirs\n' > other.md
git add other.md
git commit -qm theirs
theirs=$(git rev-parse HEAD)
git checkout -q ours
refs_before=$(git show-ref)
worktree_before=$(git status --porcelain=v1)
tree=$(git merge-tree --write-tree "$ours" "$theirs" | head -n 1)
[[ $(git show -s --format=%T "$tree" 2>/dev/null || git cat-file -t "$tree") ]] || fail 'merge tree was not written'
[[ $(git show-ref) == "$refs_before" ]] || fail 'merge-tree moved a ref'
[[ $(git status --porcelain=v1) == "$worktree_before" ]] || fail 'merge-tree touched the worktree'
pass 'merge-tree writes a tree without touching the worktree or refs'

# commit-tree writes an object only; update-ref is the separately guarded mutation.
proposal=$(printf 'prepared proposal\n' | git commit-tree "$tree" -p "$ours" -p "$theirs")
git cat-file -e "$proposal^{commit}"
[[ $(git show-ref) == "$refs_before" ]] || fail 'commit-tree moved a ref'
git branch main "$ours"
git update-ref refs/heads/main "$proposal" "$ours"
if git update-ref refs/heads/main "$theirs" "$ours" 2>/dev/null; then
    fail 'stale compare-and-swap unexpectedly succeeded'
fi
[[ $(git rev-parse refs/heads/main) == "$proposal" ]] || fail 'failed compare-and-swap changed the ref'
pass 'commit-tree creates an unreferenced commit; update-ref compare-and-swap rejects a stale writer'

# Hide internal proposal refs from upload-pack advertisement.
git update-ref refs/weft/proposals/hidden "$proposal"
git config uploadpack.hideRefs refs/weft/proposals
git config transfer.hideRefs refs/weft/proposals
[[ $(git config --get uploadpack.hideRefs) == refs/weft/proposals ]] || fail 'upload-pack hideRefs is missing'
[[ $(git config --get transfer.hideRefs) == refs/weft/proposals ]] || fail 'transfer hideRefs is missing'
git upload-pack "$repo" </dev/null > "$root/ref-advertisement" 2>/dev/null || true
grep -a 'refs/heads/main' "$root/ref-advertisement" >/dev/null || fail 'normal refs were not advertised'
if grep -a 'refs/weft/proposals' "$root/ref-advertisement" >/dev/null; then
    fail 'upload-pack advertised an internal proposal ref'
fi
pass 'upload-pack hides internal proposal refs while advertising normal refs'

# The server can create the canonical pointer and LFS content-addressed object itself.
lfsrepo="$root/lfs"
git init -q "$lfsrepo"
cd "$lfsrepo"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git lfs install --local >/dev/null
mkdir -p assets .git/lfs/objects
head -c 4096 /dev/urandom > assets/blob.bin
oid=$(sha256sum assets/blob.bin | cut -d ' ' -f 1)
size=$(wc -c < assets/blob.bin | tr -d ' ')
mkdir -p ".git/lfs/objects/${oid:0:2}/${oid:2:2}"
cp assets/blob.bin ".git/lfs/objects/${oid:0:2}/${oid:2:2}/$oid"
printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$oid" "$size" > pointer
grep -Fx "oid sha256:$oid" pointer >/dev/null || fail 'pointer hash does not match the object'
grep -Fx "size $size" pointer >/dev/null || fail 'pointer size does not match the object'
printf 'assets/*.bin filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
git hash-object -w --no-filters pointer >/dev/null
git hash-object -w --no-filters .gitattributes >/dev/null
git update-index --add --cacheinfo 100644 "$(git hash-object --no-filters pointer)" assets/blob.bin
git add .gitattributes
git commit -qm 'add LFS pointer and server-written object'
git lfs fsck --objects
[[ $(cat ".git/lfs/objects/${oid:0:2}/${oid:2:2}/$oid" | sha256sum | cut -d ' ' -f 1) == "$oid" ]] || fail 'LFS object hash mismatch'
pass 'server-written pointer and object pass git-lfs fsck without a client upload'

# A mirror clone preserves raw binary blobs and existing commit IDs.
raw="$root/raw-origin"
mirror="$root/imported.git"
git init -q "$raw"
cd "$raw"
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
head -c 8192 /dev/urandom > archive.bin
git add archive.bin
git commit -qm 'raw binary origin'
origin_head=$(git rev-parse HEAD)
origin_blob=$(git rev-parse HEAD:archive.bin)
git clone --mirror -q "$raw" "$mirror"
[[ $(git -C "$mirror" rev-parse HEAD) == "$origin_head" ]] || fail 'mirror import rewrote commit history'
[[ $(git -C "$mirror" rev-parse HEAD:archive.bin) == "$origin_blob" ]] || fail 'mirror import rewrote the raw binary blob'
[[ $(git -C "$mirror" cat-file -s "$origin_blob") == 8192 ]] || fail 'mirror import changed binary size'
pass 'mirror import preserves raw binary blobs and commit IDs without LFS migration'

# File-size exhaustion is a safe, deterministic stand-in for a full filesystem.
full="$root/full"
git init -q "$full"
cp "$raw/archive.bin" "$full/archive.bin"
if (ulimit -f 1; git -C "$full" hash-object -w archive.bin >/dev/null) 2>"$root/full.stderr"; then
    fail 'write unexpectedly succeeded under a 512-byte file limit'
fi
git -C "$full" fsck --full >/dev/null 2>&1 || fail 'write failure left an invalid object database'
pass 'a constrained object write fails without damaging the repository (file-limit simulation, not ENOSPC)'

# If git-lfs is absent, Git can still check out the committed pointer as text.
no_lfs="$root/no-lfs"
git init -q "$no_lfs"
git -C "$no_lfs" config user.name "$GIT_AUTHOR_NAME"
git -C "$no_lfs" config user.email "$GIT_AUTHOR_EMAIL"
mkdir -p "$no_lfs/assets"
printf 'assets/*.bin filter=lfs diff=lfs merge=lfs -text\n' > "$no_lfs/.gitattributes"
printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 4\n' 0 > "$no_lfs/assets/blob.bin"
git -C "$no_lfs" add .gitattributes assets/blob.bin
git -C "$no_lfs" commit -qm pointer
mkdir "$root/no-lfs-bin"
ln -s "$(command -v git)" "$root/no-lfs-bin/git"
rm "$no_lfs/assets/blob.bin"
if PATH="$root/no-lfs-bin" git -C "$no_lfs" checkout --force HEAD -- assets/blob.bin 2>"$root/no-lfs.stderr"; then
    checkout_without_lfs=success
else
    checkout_without_lfs=failed
fi
cat "$root/no-lfs.stderr"
head -n 1 "$no_lfs/assets/blob.bin" | grep -Fx 'version https://git-lfs.github.com/spec/v1' >/dev/null || fail 'checkout without git-lfs did not leave a pointer'
printf 'Checkout command without git-lfs: %s\n' "$checkout_without_lfs"
pass 'without git-lfs, the pointer blob is the only available content; no binary is materialized'

printf 'All git/LFS spike checks passed.\n'
