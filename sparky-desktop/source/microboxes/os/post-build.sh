#!/bin/sh
set -eu
TARGET="$1"
chmod 0755 "$TARGET/etc/init.d/S90sparky-micro" "$TARGET/etc/init.d/S45sparky-network"
mkdir -p "$TARGET/root" "$TARGET/run/user/0"
chmod 0700 "$TARGET/root" "$TARGET/run/user/0"
# Empty default root password is acceptable only because this guest is not exposed
# on the network by default. Never reuse an image with host data embedded.

# The Buildroot seatd package installs only libseat unless its daemon option
# is selected. Fail image construction instead of shipping a login-only guest.
for required in "$TARGET/usr/bin/seatd" "$TARGET/usr/bin/weston" "$TARGET/usr/bin/foot" "$TARGET/etc/init.d/S70seatd"; do
  if [ ! -x "$required" ]; then
    echo "Sparky Micro Linux desktop dependency missing: $required" >&2
    exit 1
  fi
done
if grep -Eq '^[[:space:]]*auto[[:space:]]+eth0([[:space:]]|$)' "$TARGET/etc/network/interfaces"; then
  echo "Sparky Micro Linux must not wait for eth0 when guest networking is disabled." >&2
  exit 1
fi

# A text login on the framebuffer steals keyboard focus from the agent and can
# cover the Wayland desktop. This purpose-built guest must never start getty.
if grep -Eq '^[[:space:]]*[^#[:space:]].*getty' "$TARGET/etc/inittab"; then
  echo "Sparky Micro Linux must boot directly to the GUI, not a login prompt." >&2
  exit 1
fi
