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
| 2.2.12 | 8321b7df9fec583a2d52ac916556141081785652 | 325cea8f8686a6317cafb310d9617fdd75a286947180064401d5da71bb0fdd87 | 39752992221 (round 14) |
| 2.2.13 | 78759be95c95e76ec44df1d1e192b58f29b14ed3 | 108f7c66aa3a5c0d32a419e7d4109fc1183b4ffcf066c78d339ab5dcd8ef00bb | 39931811504 (round 15 — FAILED smoke test, never shipped) |
| 2.2.14 | 1cf1db1f22cd597abc74c1b979936be8bc79ba2b | 6650998e4685fa225f067fd47d3c4be25a26a5d284efced8ee6b469f271ad859 | 39933861689 (round 15 — FAILED smoke test, never shipped) |
| 2.2.15 | 9e8150ffed6f79fec16122bbe0204531f935612c | 6c7b2f40a0dec761a1e5274d601453db76d2b0df14731c79f8b29f5c5b86ebad | 39935167720 (round 15) |
