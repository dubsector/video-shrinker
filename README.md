# Chrome for the emulator tests

Google Chrome 154.0.8037.94 for x86_64 (base, chrome, en and on-demand
splits), used by the Android Emulator Test workflow in place of the
emulator image's older Chrome. It is tarred, xz-compressed and encrypted
(`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`) with the
CHROME_APK_KEY repository secret, then split into parts under GitHub's
file size limit, so it can't be downloaded and used from here.

To update: replace the parts and push to this branch.
