#!/usr/bin/env bash
set -euo pipefail
# Build from a pinned Buildroot release, not from Ubuntu/Alpine/Debian images.
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SOURCE_DIR/../.." && pwd)"
BUILDROOT_TAG="2026.08.1"
BUILDROOT_DIR="${BUILDROOT_DIR:-$ROOT/.cache/buildroot-$BUILDROOT_TAG}"
OUT_DIR="${MICROBOXES_BUILD_DIR:-$ROOT/.cache/microboxes-build-aarch64}"
OUTPUT_DIR="${MICROBOXES_OUTPUT_DIR:-$ROOT/dist/microboxes/sparky-micro-aarch64}"
if [[ ! -f "$BUILDROOT_DIR/Makefile" ]]; then
  mkdir -p "$(dirname "$BUILDROOT_DIR")"
  git clone --depth=1 --branch "$BUILDROOT_TAG" \
    https://gitlab.com/buildroot.org/buildroot.git "$BUILDROOT_DIR"
fi
mkdir -p "$OUT_DIR" "$OUTPUT_DIR"
# Make the Buildroot post-build hook executable before the expensive compile.
# This is also robust to source archives that do not preserve POSIX modes.
chmod 0755 "$SOURCE_DIR/post-build.sh"
test -x "$SOURCE_DIR/post-build.sh"
make -C "$BUILDROOT_DIR" O="$OUT_DIR" qemu_aarch64_virt_defconfig
# Adjust the upstream Buildroot QEMU reference config into a dedicated Sparky
# distro: musl + BusyBox, Weston desktop shell, Pixman software rendering.
cat >> "$OUT_DIR/.config" <<EOF
BR2_TOOLCHAIN_BUILDROOT_MUSL=y
BR2_TOOLCHAIN_BUILDROOT_CXX=y
BR2_ENABLE_LOCALE=y
BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV=y
# No guest NIC is present by default; never block boot waiting for eth0.
BR2_SYSTEM_DHCP=""
BR2_TARGET_GENERIC_GETTY=n
BR2_TARGET_GENERIC_HOSTNAME="sparky-micro"
BR2_PACKAGE_EUDEV=y
BR2_PACKAGE_SEATD=y
BR2_PACKAGE_SEATD_DAEMON=y
BR2_PACKAGE_PIXMAN=y
BR2_PACKAGE_WESTON=y
BR2_PACKAGE_FOOT=y
BR2_PACKAGE_DEJAVU=y
BR2_PACKAGE_DEJAVU_MONO=y
BR2_PACKAGE_WESTON_DEFAULT_DRM=y
BR2_PACKAGE_WESTON_SHELL_DESKTOP=y
BR2_PACKAGE_WESTON_SIMPLE_CLIENTS=y
BR2_PACKAGE_WESTON_DEMO_CLIENTS=n
BR2_ROOTFS_OVERLAY="$SOURCE_DIR/overlay"
BR2_ROOTFS_POST_BUILD_SCRIPT="$SOURCE_DIR/post-build.sh"
BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES="$SOURCE_DIR/kernel.fragment"
BR2_TARGET_ROOTFS_EXT2_SIZE="1024M"
# BR2_PACKAGE_HOST_QEMU is not set
# BR2_PACKAGE_HOST_QEMU_SYSTEM_MODE is not set
EOF
make -C "$BUILDROOT_DIR" O="$OUT_DIR" olddefconfig
for flag in BR2_PACKAGE_WESTON BR2_PACKAGE_WESTON_DEFAULT_DRM BR2_PACKAGE_EUDEV BR2_PACKAGE_SEATD_DAEMON BR2_PACKAGE_FOOT BR2_PACKAGE_DEJAVU; do
  grep -q "^${flag}=y$" "$OUT_DIR/.config" || {
    echo "Required setting ${flag} was not enabled by Buildroot." >&2
    grep -E '^(BR2_ROOTFS_DEVICE_CREATION|BR2_PACKAGE_HAS_UDEV|BR2_PACKAGE_EUDEV|BR2_INSTALL_LIBSTDCPP|BR2_ENABLE_LOCALE|BR2_PACKAGE_WESTON|BR2_TOOLCHAIN_BUILDROOT)' "$OUT_DIR/.config" >&2 || true
    exit 1;
  }
done
make -C "$BUILDROOT_DIR" O="$OUT_DIR" -j"${JOBS:-$(nproc)}"
KCONFIG="$(find "$OUT_DIR/build" -maxdepth 2 -path '*/linux-*/.config' -type f -print -quit)"
test -n "$KCONFIG" && test -s "$KCONFIG"
for flag in CONFIG_USB_XHCI_HCD CONFIG_USB_XHCI_PCI CONFIG_USB_HID CONFIG_INPUT_EVDEV; do
  grep -q "^${flag}=y$" "$KCONFIG" || { echo "Required kernel input driver missing: $flag" >&2; exit 1; }
done
if ! grep -Fq '# BR2_TARGET_GENERIC_GETTY is not set' "$OUT_DIR/.config"; then
  echo "Graphical Boxes image must not enable getty" >&2
  exit 1
fi
KERNEL="$OUT_DIR/images/Image"
ROOTFS="$OUT_DIR/images/rootfs.ext2"
test -s "$KERNEL" && test -s "$ROOTFS"
cp "$KERNEL" "$OUTPUT_DIR/Image"
cp "$ROOTFS" "$OUTPUT_DIR/rootfs.ext2"
cat > "$OUTPUT_DIR/image.json" <<'EOF'
{
  "id": "sparky-micro-aarch64",
  "name": "Sparky Micro Linux",
  "kind": "linux-kernel",
  "architecture": "aarch64",
  "file": "rootfs.ext2",
  "kernel": "Image",
  "append": "root=/dev/vda rw console=ttyAMA0"
}
EOF
(
  cd "$OUTPUT_DIR"
  sha256sum Image rootfs.ext2 image.json > SHA256SUMS
)
echo "Sparky Micro Linux image produced: $OUTPUT_DIR"
