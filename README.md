# Go Tutor

A Go (the board game) tutor that helps you improve through actual game play. You play in the
browser against KataGo's human-style bot, KataGo analyzes every move, and a Claude Code session
attached through the `tutor` CLI acts as the teacher. Without a Claude session the app still works,
with KataGo-only feedback.

## Setup (once)

```sh
brew install katago        # if not installed
npm install
npm run setup:katago       # downloads the human-style network, writes katago/analysis.cfg
```

## Use

Open Claude Code in this folder and ask it to start a tutoring session. `CLAUDE.md` tells it how
to start the server, open the board in Chrome, attach with `npm run -s tutor -- watch`, and teach.

To play without a tutor: `npm start`, then open http://localhost:4747. KataGo takes 30–70 s to
start; the board says when it is ready.

## Develop

```sh
npm run dev        # server with reload + Vite dev UI on http://localhost:5173 (?mock for a fake backend)
npm test           # all tests; the KataGo integration and e2e tests take a few minutes
npm run typecheck
```

See `ARCHITECTURE.md` for how the pieces fit together.
