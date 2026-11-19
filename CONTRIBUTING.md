# Contributing to Dispatch

Thank you for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Before you write code

For anything larger than a small fix, open an issue first and say what you would like to change. It saves you from
building something that does not fit where Dispatch is going.

Security problems go to the address in [SECURITY.md](SECURITY.md), not to a public issue.

## Set up

You need Node.js 22. The desktop app also needs Rust (stable) and, on Linux, the WebKitGTK packages listed in
[CLAUDE.md](CLAUDE.md) under "Commands".

    npm ci
    npm run dev          # web app on http://localhost:5173
    npm run tauri dev    # desktop app with hot reload

## Before you open a pull request

    npm run typecheck
    npm test
    npm run build

- Keep a pull request to one change, and say in its description what it does and how you checked it.
- Add or update a test for what you changed. Tests live in `tests/`.
- New text in the app, the site or the docs follows the same voice as the rest: plain, warm, and about what the
  person can do. Do not describe Dispatch by comparing it with another product. Other tools are named only as file
  formats that Dispatch imports or exports.
- Do not paste real tokens, passwords or private URLs into issues, tests or screenshots.

## Licence

Dispatch is MIT licensed. By sending a pull request you agree that your contribution is released under the same
licence. Fonts and other bundled material keep their own licences; see
[THIRD-PARTY-NOTICES](public/THIRD-PARTY-NOTICES.txt).
