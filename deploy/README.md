# Web release

Production web can run a committed release while the shared checkout contains
unfinished work. From the project root:

```sh
bash tools/deploy-web.sh <commit>             # prepare without restarting
bash tools/deploy-web.sh <commit> --activate  # restart web and check health
```

The helper archives the specified Git commit into `data/web-releases/<SHA>`.
It shares the checkout's installed `node_modules` and persistent `data` directory;
the lockfile must match. The existing systemd `EnvironmentFile` and Node command
stay in effect. A web-only drop-in sets `WorkingDirectory` to
`data/web-release-current`. Subsequent deployments must use the helper: restarting
the service alone continues serving the selected release.

Activation records the previous target and drop-in, checks `/healthz`, and restores
the prior configuration if startup or health fails. It does not run migrations,
write manual traffic records, or restart the worker. Verify the public page and
asset hashes after activation; health alone does not check the UI.

To roll back, activate the previous committed SHA with the same helper. To return
to serving the checkout, remove only
`~/.config/systemd/user/traffic-observe-web.service.d/20-committed-release.conf`,
run `systemctl --user daemon-reload`, and restart `traffic-observe-web.service`.
Only do this once the checkout is suitable for production.
