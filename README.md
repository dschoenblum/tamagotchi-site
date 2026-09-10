# tamagotchi-site

This repository is a generated mirror. The source lives in a private repository
and is deployed here automatically by a GitHub Actions workflow, so nothing here
is edited by hand. Please do not open pull requests or issues against this
repository — they cannot be merged or tracked, and the next deploy will
overwrite whatever is here.

Every deploy force-pushes a single fresh commit, so the history is rewritten
each time. A clone of this repository will not fast-forward; re-clone or reset
hard instead of pulling.

The page is served at https://dschoenblum.github.io/tamagotchi-site/.

What it is: a readable reimplementation of the 1996 Bandai Tamagotchi P1's game
rules as a JavaScript state machine, with correctness established by diffing its
state against the real ROM running under emulation. The ROM itself is Bandai's,
is not included here, and is not distributed.
