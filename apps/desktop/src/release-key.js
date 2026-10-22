// The project's release public keys (Ed25519, hex). The updater installs
// only releases signed by one of them; with none listed it can still tell
// you about new versions, but says they're unverified and won't install
// them by itself.
//
// To make the key (once, on the maintainer's own computer):
//   node scripts/release-key.mjs new
// then put the public key here and the private key in the repository's
// Actions secret RELEASE_SIGNING_KEY (and somewhere safe offline). More than
// one key may be listed while moving from an old key to a new one.

export const RELEASE_PUBLIC_KEYS = []
