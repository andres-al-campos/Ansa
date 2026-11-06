#!/usr/bin/env bash
# Law: ios/build.sh installs on the phone, never on a booted simulator.
#
# devicectl lists simulators beside the phone, and a booted one reads
# "connected". The phone's id was once picked by UUID shape, which matched the
# simulator instead, so every phone install failed while a simulator ran.
#
#   tests/phone-id.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

listing='Name                 Hostname   Identifier                                    State       Model                            Reality
------------------   --------   -------------------------------------------   ---------   ------------------------------   ---------
iPhone 18 Pro                   D79E5795-46D7-4262-BFA1-39A63C3A4545 (UDID)   connected   iPhone 18 Pro (iPhone19,2)       simulated
Someone’s iPhone                00008120-000A1B2C3D4E5F60 (UDID)              connected   iPhone 15 (iPhone15,4)           physical
iPhone 17                       3DEA8263-4BD2-4C72-8D83-3B960FE21DD1 (UDID)   shutdown    iPhone 17 (iPhone18,3)           simulated'

got=$("$here/ios/tools/phone-id.sh" <<<"$listing")
if [ "$got" != "00008120-000A1B2C3D4E5F60" ]; then
  echo "✗ phone-id: picked '${got}' from a listing whose only phone is 00008120-000A1B2C3D4E5F60." >&2
  echo "  ios/tools/phone-id.sh must take the identifier from the row marked physical, not the first connected row." >&2
  exit 1
fi

got=$("$here/ios/tools/phone-id.sh" <<<"$(grep -v physical <<<"$listing")")
if [ -n "$got" ]; then
  echo "✗ phone-id: picked '${got}' from a listing with only simulators; it must print nothing." >&2
  exit 1
fi
echo "✓ phone-id: a booted simulator beside the phone, the phone's id is picked; simulators alone, none"
