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
| 2.2.16 | 65959416565740224277909a36427019034c5f67 | 869ff29d30bc4165a7f708633510e16c84623076839f745cfe4357de52a65e0f | 40085474531 (round 16) |
| 2.2.17 | 3895be45d7948d19394f9d4fba672fca9f2532e2 | 758bdb9c8d0866fb9cbaad0ae76dbbf7ece716b7526d3484c9020ebc88cdd692 | 40094569194 (round 17) |
| 2.2.18 | 90595f4670b774a41f225923940865a940a66a4d | f81298f1cf56a13c38936525f892abdb107fbb026b95fbcffd1ca0f3cc1341e3 | 40108703075 (round 18) |
| 2.2.19 | b5aead8b047f505ac2583d3a52563e50f976a74e | 9f82ed55e19f0d48c8815e41eefcd1ecc06b0e1aa997c0e97e3fa5cb4757de5e | 40288680977 (round 19) |
| 2.2.20 | 1dccf248a132bcedc34cfefa12da03e23d363f35 | ff1c25f77afeb948339d948aabd487e33c78800c2027fe4731bae8b408d268e8 | 40305193658 (round 20) |
| 2.2.21 | 49d250ecc1662ab329138d6c9cb14dc655e3ea31 | 6dd2f8211ac5ff04e61391fa099f9b4ffc8a2d49d8a67a1c5e83e646831a714b | 40653550132 (round 21) |
