#!/usr/bin/env bash
# Inspect and assemble env files WITHOUT ever printing values.
#
#   scripts/env-keys.sh names <keys-dir>             list KEY names found in <keys-dir>/*
#   scripts/env-keys.sh check <keys-dir> [template]  required/missing/extra vs template
#   scripts/env-keys.sh build <keys-dir> <out> [template]
#                                                    write <out> (mode 600) with the
#                                                    template's keys, values taken from
#                                                    <keys-dir>; first file wins on dupes
#
# template defaults to ops/.env.example. Only KEY=VALUE / export KEY=VALUE lines
# are read; comments and blanks are ignored.
set -euo pipefail

cmd=${1:-}; keys_dir=${2:-}
[[ -n $cmd && -d $keys_dir ]] || { sed -n '2,12p' "$0"; exit 2; }

key_re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)='

key_files() { find "$keys_dir" -maxdepth 1 -type f ! -name '.*.swp' | sort; }

names_in() { sed -nE "s/${key_re}.*/\2/p" "$1"; }

template_keys() { names_in "$1"; }

required_keys() { grep -E "$key_re" "$1" | grep -E '#[[:space:]]*required' | sed -nE "s/${key_re}.*/\2/p"; }

all_names() { local f; key_files | while read -r f; do names_in "$f"; done | sort -u; }

# Print the raw value for a key from the first file that defines it (internal use only).
value_of() {
  local key=$1 f
  while read -r f; do
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$f"; then
      grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$f" | head -1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}=//"
      return 0
    fi
  done < <(key_files)
  return 1
}

case $cmd in
  names)
    while read -r f; do
      echo "== $(basename "$f")"
      names_in "$f" | sed 's/^/  /'
    done < <(key_files)
    ;;
  check)
    tpl=${3:-ops/.env.example}
    have=$(all_names)
    echo "missing (required):"; comm -23 <(required_keys "$tpl" | sort -u) <(echo "$have") | sed 's/^/  /'
    echo "missing (optional):"; comm -23 <(template_keys "$tpl" | sort -u) <(echo "$have") | comm -23 - <(required_keys "$tpl" | sort -u) | sed 's/^/  /'
    echo "extra (in keys, not in template):"; comm -13 <(template_keys "$tpl" | sort -u) <(echo "$have") | sed 's/^/  /'
    ;;
  build)
    out=${3:?output path required}; tpl=${4:-ops/.env.example}
    umask 077
    : > "$out"
    set_n=0; miss=()
    while read -r k; do
      if v=$(value_of "$k"); then printf '%s=%s\n' "$k" "$v" >> "$out"; set_n=$((set_n+1))
      else miss+=("$k"); fi
    done < <(template_keys "$tpl")
    chmod 600 "$out"
    echo "wrote $out: $set_n keys set"
    ((${#miss[@]})) && printf 'not set: %s\n' "${miss[*]}"
    req_missing=$(comm -12 <(printf '%s\n' "${miss[@]:-}" | sort -u) <(required_keys "$tpl" | sort -u) || true)
    [[ -z $req_missing ]] || { echo "ERROR required keys missing: $(echo $req_missing)"; exit 1; }
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
