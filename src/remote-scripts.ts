export const PREPARE_REPOSITORY_SCRIPT = String.raw`set -euo pipefail
repo_path="$1"
remote_name="$2"
base_branch="$3"
workspace_branch="$4"
workspace_id="$5"
project_id="$6"

cd "$repo_path"
test -d .git
clean=true
if test -n "$(git status --porcelain)"; then clean=false; fi
identity_count=0
for path in "$HOME/.bb/host.json" "$HOME/.config/bb/host.json"; do
  if test -e "$path"; then identity_count=$((identity_count + 1)); fi
done
if test "$clean" != true || test "$identity_count" -gt 0; then
  base_sha="$(git rev-parse HEAD)"
  current_branch="$(git branch --show-current)"
  node -e 'console.log(JSON.stringify({clean:process.argv[1]==="true",baseSha:process.argv[2],branch:process.argv[3],copiedBbIdentityCount:Number(process.argv[4])}))' \
    "$clean" "$base_sha" "$current_branch" "$identity_count"
  exit 0
fi
git fetch --prune "$remote_name" "$base_branch"
base_sha="$(git rev-parse "$remote_name/$base_branch")"
git checkout -B "$workspace_branch" "$base_sha"

state_root="\${XDG_STATE_HOME:-$HOME/.local/state}/bb-exe/workspaces"
mkdir -p "$state_root"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({workspaceId:process.argv[2],projectId:process.argv[3],branch:process.argv[4],baseSha:process.argv[5],createdAt:Date.now()}), {mode:0o600})' \
  "$state_root/$workspace_id.json" "$workspace_id" "$project_id" "$workspace_branch" "$base_sha"

node -e 'console.log(JSON.stringify({clean:process.argv[1]==="true",baseSha:process.argv[2],branch:process.argv[3],copiedBbIdentityCount:Number(process.argv[4])}))' \
  "$clean" "$base_sha" "$workspace_branch" "$identity_count"`;

export const INSPECT_REPOSITORY_SCRIPT = String.raw`set -euo pipefail
repo_path="$1"
remote_name="$2"
base_branch="$3"
workspace_branch="$4"
workspace_id="$5"
cd "$repo_path"
clean=true
if test -n "$(git status --porcelain)"; then clean=false; fi
branch="$(git branch --show-current)"
head_sha="$(git rev-parse HEAD)"
git fetch --prune "$remote_name" "$base_branch" >/dev/null 2>&1 || true
ahead="$(git rev-list --count "$remote_name/$base_branch..HEAD")"
marker="\${XDG_STATE_HOME:-$HOME/.local/state}/bb-exe/workspaces/$workspace_id.json"
marker_matches=false
if test -f "$marker" && node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(x.workspaceId===process.argv[2]?0:1)' "$marker" "$workspace_id"; then marker_matches=true; fi
node -e 'console.log(JSON.stringify({clean:process.argv[1]==="true",ahead:Number(process.argv[2]),markerMatches:process.argv[3]==="true",branch:process.argv[4],headSha:process.argv[5]}))' \
  "$clean" "$ahead" "$marker_matches" "$branch" "$head_sha"`;

export function installBbCommand(serverUrl: string, joinCode: string, hostId: string, machineCode: string | null): string {
  const q = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const args = [`--join-code ${q(joinCode)}`, `--host-id ${q(hostId)}`, `--server ${q(serverUrl)}`];
  if (machineCode !== null) args.push(`--machine-code ${q(machineCode)}`);
  return `curl -fsSL ${q(`${serverUrl}/install.sh`)} | sh -s -- ${args.join(" ")}`;
}

export const DOCTOR_REPOSITORY_SCRIPT = String.raw`set -euo pipefail
repo_path="$1"
remote_name="$2"
base_branch="$3"
cd "$repo_path"
test -d .git
clean=true
if test -n "$(git status --porcelain)"; then clean=false; fi
git fetch --prune "$remote_name" "$base_branch" >/dev/null
base_sha="$(git rev-parse "$remote_name/$base_branch")"
identity_count=0
for path in "$HOME/.bb/host.json" "$HOME/.config/bb/host.json"; do
  if test -e "$path"; then identity_count=$((identity_count + 1)); fi
done
node -e 'console.log(JSON.stringify({clean:process.argv[1]==="true",baseSha:process.argv[2],branch:process.argv[3],copiedBbIdentityCount:Number(process.argv[4])}))' \
  "$clean" "$base_sha" "$base_branch" "$identity_count"`;
