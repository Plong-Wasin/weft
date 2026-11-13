# Offline common-password blocklist

`10k-most-common-passwords.txt` is the SecLists `10k-most-common.txt` corpus from [danielmiessler/SecLists](https://github.com/danielmiessler/SecLists), downloaded from its `master` branch on 2026-11-13. The source repository is licensed under the MIT License (see its [LICENSE](https://github.com/danielmiessler/SecLists/blob/master/LICENSE)); this copy is redistributed under that license.

The list is checked case-insensitively when Have I Been Pwned is unavailable or disabled. Do not add logging of candidate passwords or their hashes around this check.
