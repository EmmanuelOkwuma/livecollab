# LiveCollab

**Asynchronous multiplayer AI for software teams.**

Each developer works with their own AI, on their own time. The team's shared room keeps the context: what was done, why, and what's still open. The next teammate or agent picks up from there instead of starting over.

## What exists today (0.3.7)

- A macOS app for Apple Silicon and Intel. Download it from [livecollab.dev/product](https://livecollab.dev/product).
- Rooms: create a room, or join one with an invite code.
- Roles: owner, editor and viewer.
- Room chat, with mentions of teammates and of the room's files.
- Accounts: sign-in happens on the LiveCollab website, so the app never handles your password.

## What's next

The shared AI layer. It starts with research into how it should work. Nothing in its design is decided yet.

## Stack

- Built on Code - OSS, the open source core of Visual Studio Code, as an Electron desktop app (Electron 42).
- TypeScript.
- Yjs, with y-monaco, keeps the room's files in sync between members.
- Socket.IO client for the connection to the LiveCollab server, which is not part of this repository.

## Build from source

You need macOS and Node.js 24 (see `.nvmrc`).

```bash
npm install
npm run watch          # compiles the sources; leave it running
./scripts/code.sh      # starts a dev build
```

A dev build connects to the production LiveCollab service. To point it at another server, set `LIVECOLLAB_SERVER_URL` (and `LIVECOLLAB_SIGNIN_URL` for its sign-in page) before starting it.

To build the macOS app zips (Apple Silicon and Intel):

```bash
LIVECOLLAB_BUILD_FLAVOR=release scripts/livecollab/build-bundles.sh
```

## Repository layout

- `src/vs/workbench/contrib/livecollab/`: the room: chat, members, roles and file sync.
- `src/vs/code/electron-browser/workbench/livecollab-bootstrap.html`: the sign-in page and the dashboard of rooms.
- `scripts/livecollab/`: the macOS build.
- Everything else is Code - OSS. See its layout in `src/vs/` (`base`, `platform`, `editor`, `workbench`).

## Licence

MIT. See [LICENSE.txt](LICENSE.txt). LiveCollab is an independent project, not affiliated with or endorsed by Microsoft.
