#!/usr/bin/env bash
set -euo pipefail

VERSION="${MC_VERSION:-26.2}"
MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/realmcraft-textures.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

for command in curl jq unzip shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

echo "Resolving Minecraft Java Edition $VERSION..."
manifest="$(curl --fail --silent --show-error --location "$MANIFEST_URL")"
version_url="$(jq -r --arg version "$VERSION" '.versions[] | select(.id == $version) | .url' <<<"$manifest")"
if [[ -z "$version_url" || "$version_url" == "null" ]]; then
  echo "Minecraft version $VERSION was not found in the Mojang manifest." >&2
  exit 1
fi

metadata="$(curl --fail --silent --show-error --location "$version_url")"
client_url="$(jq -r '.downloads.client.url' <<<"$metadata")"
client_sha1="$(jq -r '.downloads.client.sha1' <<<"$metadata")"
client_jar="$TMP_DIR/minecraft-client-$VERSION.jar"

echo "Downloading the official client..."
curl --fail --silent --show-error --location "$client_url" --output "$client_jar"
printf '%s  %s\n' "$client_sha1" "$client_jar" | shasum -a 1 -c -

textures=(
  grass_block_top grass_block_side grass_block_side_overlay dirt stone sand snow
  oak_log oak_log_top oak_leaves gravel bedrock oak_planks short_grass dandelion
  poppy spruce_log spruce_log_top spruce_leaves water_still
  destroy_stage_0 destroy_stage_3 destroy_stage_6 destroy_stage_9
)

entries=()
for texture in "${textures[@]}"; do
  entries+=("assets/minecraft/textures/block/$texture.png")
done

mkdir -p "$ROOT_DIR/public"
unzip -o "$client_jar" "${entries[@]}" -d "$ROOT_DIR/public" >/dev/null

echo "Installed ${#textures[@]} textures into public/assets/minecraft/textures/block/."
