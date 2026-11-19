# Security

Dispatch holds API keys, tokens and passwords for the people who use it, so reports about anything that could expose
them are taken seriously and answered first.

## Reporting a problem

Please do not open a public issue for a security problem. Write to **hello@ogcrafts.cloud** with:

- what you found and where (desktop app, web app or the `dispatch-run` CLI, and the version),
- the steps to reproduce it,
- what someone could do with it.

Leave real secrets out of the report; made-up values are enough to show the problem.

You will get a reply within a few days. Dispatch is maintained by a very small team, so a fix can take a little
longer, and we will tell you where it stands. Once a fix is released we credit the reporter in the release notes,
unless you would rather not be named.

## Which versions get fixes

Only the newest release. Dispatch updates itself on desktop (you are asked first), and the web app is always the
newest version.

## What counts

- Secrets leaving the device, or stored or exported unencrypted where they should not be.
- The local connection for AI assistants (off by default) answering without its token, or showing a value it should
  hide.
- A collection, import file, shared HTML page or response that runs code or reads data it should not.
- Problems in the installers or in the update check.

Scripts in a collection run when you send its requests; that is how collections work, so only import collections
from people you trust. A script doing what scripts are allowed to do is not a vulnerability, but a script reaching
something it should not (files, other workspaces, the device) is, and so is a way to make scripts run without a
request being sent.
