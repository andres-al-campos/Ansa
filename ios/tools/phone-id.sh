#!/usr/bin/env bash
# Prints the paired iPhone's identifier from `xcrun devicectl list devices`
# on stdin, or nothing when there is none.
#
# Only rows marked physical: the listing also carries simulators, and a booted
# one is "connected" too. Read from the column before "(UDID)" rather than by
# shape, since a phone's identifier is a hardware id (00008120-0002493E21BBA01E)
# and a simulator's is a UUID; matching the UUID shape picked the simulator.
#
# Any paired phone counts, including one the listing calls "disconnected".
# That state is stale rather than true — `list devices` reports the last
# session until something opens a tunnel, and `devicectl install` opens one
# itself.
grep -E '[[:space:]]physical[[:space:]]*$' \
  | grep -oE '[0-9A-Fa-f-]+ \(UDID\)' \
  | head -1 \
  | cut -d' ' -f1
