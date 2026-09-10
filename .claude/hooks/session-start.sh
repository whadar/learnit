#!/bin/bash
#
# Claude Code on the web hands a rebuilt container a workspace restored from a cached image,
# not a fresh clone. That image can be badly stale: this repo has repeatedly come back with
# HEAD ~60 commits behind origin, a dirty working tree, and a .git whose reflog ends days ago —
# so work that was already pushed looked missing, and a stale file left in the tree would have
# silently reverted later work if anything were built on top of it.
#
# So on every session start: fast-forward the checkout to whatever origin already has, and make
# sure the game's dependencies are installed.
#
# Safety rules, in order of importance:
#   - Never discard work. Anything dirty is stashed with a label, never dropped.
#   - Only ever fast-forward. If HEAD holds commits origin does not have, this does nothing at
#     all — an unpushed local commit is real work and is not the hook's to move.
#   - Never fail the session. Every step is advisory; the hook always exits 0.
set -uo pipefail

say() { printf '[session-start] %s\n' "$1"; }

# Local checkouts are not restored from an image and do not have this problem.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  say "not a remote session — nothing to do"
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" || exit 0

/usr/bin/env git rev-parse --git-dir >/dev/null 2>&1 || { say "not a git checkout — skipping sync"; exit 0; }

branch="$(git symbolic-ref --short -q HEAD || true)"
if [ -z "$branch" ]; then
  say "detached HEAD — leaving the checkout alone"
elif ! git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  say "origin has no '$branch' — leaving the checkout alone"
else
  git fetch --quiet origin "$branch" 2>/dev/null || say "fetch failed (offline?) — continuing"
  remote="origin/$branch"
  if ! git rev-parse --verify --quiet "$remote" >/dev/null; then
    say "no $remote after fetch — leaving the checkout alone"
  elif [ "$(git rev-parse HEAD)" = "$(git rev-parse "$remote")" ]; then
    say "already at $remote ($(git rev-parse --short HEAD))"
  elif ! git merge-base --is-ancestor HEAD "$remote"; then
    # HEAD has commits origin does not. That is unpushed work — never touch it.
    say "HEAD has commits not on $remote — NOT syncing, push or rebase by hand"
  else
    behind="$(git rev-list --count "HEAD..$remote")"
    if [ -n "$(git status --porcelain)" ]; then
      stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      if git stash push -u -m "session-start: restored-image debris $stamp" >/dev/null 2>&1; then
        say "stashed a dirty tree as 'session-start: restored-image debris $stamp' (git stash list)"
      else
        say "could not stash the dirty tree — NOT syncing, resolve by hand"
        behind=""
      fi
    fi
    if [ -n "$behind" ] && git merge --ff-only "$remote" >/dev/null 2>&1; then
      say "fast-forwarded $behind commit(s) to $(git rev-parse --short HEAD)"
    elif [ -n "$behind" ]; then
      say "fast-forward failed — resolve by hand"
    fi
  fi
fi

# The game is the only thing here with real dependencies; the repo root is an unrelated legacy
# Express app pinned to node 0.6 that must not be installed.
if [ -f game/package.json ]; then
  if [ -x game/node_modules/.bin/vite ]; then
    say "game/node_modules already present"
  else
    say "installing game dependencies"
    ( cd game && npm install --no-audit --no-fund --silent ) \
      && say "npm install done" || say "npm install failed — run it by hand in game/"
  fi
fi

exit 0
