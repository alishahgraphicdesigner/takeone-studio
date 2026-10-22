# TakeOne Studio builds

One line per installer build: version, the exact commit it was built from, and the
exe's SHA256. The sha256 is always CI-computed (SHA256.txt step or the hash-artifact
workflow) — never written by hand. A version maps to exactly one commit; rebuilding
the same version from a different commit is rejected by CI
(tools/check-version-unique.js, wired into build-installer.yml).

| version | commit | exe sha256 | CI run |
|---|---|---|---|
| 2.2.10 | 35db3825b42e6718b1be6610a8725b6fdedb05c9 | ae536efc35dd49a1c44dcaab6295c844ef471b78c9a3df81e0eb2fb7c184a6dc | 39710499911 (round 11) |
| 2.2.10 | c2104927cc137567fcfc7c625eaa967716cb16f5 | a520273d345f63d3cacd38cc4276f2daf9fdd7e043bd692ca2c9d94b13cca3f6 | 39739633597 (round 12) |
| 2.2.11 | 48ab2fd0e0ba3eb15b974aeebf4ec0bdfe036991 | 8580b22bec27ad39af24372b2e0100cb646123513c1d310c45f30d192a8503a3 | 39742914169 (round 13) |
