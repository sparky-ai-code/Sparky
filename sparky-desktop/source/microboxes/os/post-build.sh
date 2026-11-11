#!/bin/sh
set -eu
TARGET="$1"
chmod 0755 "$TARGET/etc/init.d/S90sparky-micro"
mkdir -p "$TARGET/root" "$TARGET/run/user/0"
chmod 0700 "$TARGET/root" "$TARGET/run/user/0"
# Empty default root password is acceptable only because this guest is not exposed
# on the network by default. Never reuse an image with host data embedded.
