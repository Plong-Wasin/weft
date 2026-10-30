#!/usr/bin/env bash
set -euo pipefail

runs=${RUNS:-101}
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

for files in 1 10 100; do
  repo="$root/repo-$files"
  git init -q "$repo"
  git -C "$repo" config user.name Benchmark
  git -C "$repo" config user.email benchmark@example.invalid
  mkdir -p "$repo/notes"
  for n in $(seq 1 "$files"); do
    printf '# Note %s\n\nBaseline text.\n' "$n" > "$repo/notes/$n.md"
  done
  git -C "$repo" add .
  git -C "$repo" commit -qm baseline
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -qb proposal
  for n in $(seq 1 "$files"); do
    printf '# Note %s\n\nProposed text.\n' "$n" > "$repo/notes/$n.md"
  done
  git -C "$repo" commit -qam proposal
  proposal=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q main 2>/dev/null || git -C "$repo" checkout -q master
  diff_bytes=$(git -C "$repo" diff "$base..$proposal" | wc -c)
  printf 'files=%s diff_bytes=%s runs=%s state=warm\n' "$files" "$diff_bytes" "$runs"
  python3 - "$repo" "$base" "$proposal" "$runs" <<'PY'
import statistics, subprocess, sys, time
repo, base, proposal, runs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
values = []
for _ in range(runs):
    start = time.perf_counter_ns()
    subprocess.run(["git", "-C", repo, "merge-tree", "--write-tree", base, proposal],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    values.append((time.perf_counter_ns() - start) / 1_000_000)
values.sort()
p95 = values[min(len(values) - 1, int(len(values) * .95))]
print(f"merge_tree_ms median={statistics.median(values):.3f} p95={p95:.3f} min={values[0]:.3f} max={values[-1]:.3f}")
PY
done
