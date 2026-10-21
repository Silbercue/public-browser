# Sealed secret part

About a third of the bug catalog stays unpublished until the final measurement (phase 3), so that the
sessions developing the browser tools under test can never tune against it. It was written by a
separate session from the public brief [`AUTHOR-BRIEF.md`](AUTHOR-BRIEF.md) and is stored here only in
encrypted form. The plaintext is never in this repository.

| File | Content |
|---|---|
| `recipient.pub` | Public X25519 key (base64). Anyone can seal with it; nobody can unseal with it. |
| `sealed.bin` | The secret part: bug modules, secret decoys and their check spec. |
| `sealed.bin.sha256` | SHA-256 of `sealed.bin`. Convenience only: it sits in the same repository as `sealed.bin`, so it proves nothing. |
| `plaintext.sha256` | SHA-256 of the packed plaintext. After unsealing in phase 3, compare against it. |

## Format

`sealed.bin` = `CPSEAL1\n` + one JSON header line `{ epk, iv, tag }` + ciphertext. The sender creates an
ephemeral X25519 key `epk`; the shared secret (`diffieHellman`) goes through HKDF-SHA256 (salt
`epk || recipient`, info `coder-parcours-seal-v1`) into an AES-256-GCM key. The plaintext is the
canonical JSON `{ "files": { "<path>": "<base64>" } }` with sorted paths (`packDir` in
`harness/seal.mjs`), so `plaintext.sha256` can be reproduced from the unsealed folder.

The private key exists only as an encrypted PKCS8 file (`aes-256-cbc`) outside the repository; its
passphrase is held by the maintainer alone. A session that finds the key file still cannot unseal.
The PKCS8 file format derives its key with only 2048 PBKDF2 rounds (Node offers no setting), so a stolen
key file is protected by the passphrase alone: use a long one, at least 20 characters (counted as
characters, not bytes), ideally 5 or more random words.

The package is not authenticated (anyone can seal with the public key). Whoever replaces `sealed.bin` in
the public repository could smuggle in code the maintainer would run after unsealing. Therefore `unseal`
requires `--expect-sha256 <hex>`: the checksum of `sealed.bin` from the author's reply, **not** the
`.sha256` file from the repository. A mismatch aborts before anything is written. `--no-verify` skips
the check (tests only).

## Commands

```bash
# once, by the maintainer, in a terminal (asks for the passphrase twice, at least 20 characters)
node harness/seal.mjs keygen --out ~/.coder-parcours/seal.key

# seal a folder (no passphrase needed)
node harness/seal.mjs seal --in <dir> --recipient secret/recipient.pub --out secret/sealed.bin

# phase 3, by the maintainer, in a terminal
node harness/seal.mjs unseal --key ~/.coder-parcours/seal.key --in secret/sealed.bin --out <dir> \
  --expect-sha256 <sealed.bin checksum from the author's reply>
```

`keygen` refuses a key path inside a git working tree. `unseal` asks for the passphrase without echo,
aborts without a terminal, and refuses a target folder inside a git working tree unless `--allow-repo`
is given (only in phase 3, when the secret part is published).
