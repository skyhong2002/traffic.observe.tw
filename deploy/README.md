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


Both processes can now select committed archives independently:

```sh
bash tools/deploy-worker.sh <commit>              # prepare only
bash tools/deploy-worker.sh <commit> --activate   # worker only
```

The worker uses `data/worker-release-current` and its own service drop-in. It
checks startup and the running process's archive directory, restores the previous
configuration on failure, and records activation under `data/web-releases/`.
Every worker job log includes `sourceCommit`; `/healthz` and `/api/v1/status`
report the web revision. A checkout without a release marker reports null.
Apply additive migrations 0016–0018 before restarting either process. Roll back
each process with its previous SHA; disable `TRAFFIC_COMMUNITY_ENABLED` and
`TRAFFIC_QUEUE_OPTIMIZATION` to stop adoption/policy changes while preserving data.
Readiness now checks the database and existing worker/provider health within two
seconds. Liveness stays independent of the database.

These helpers never activate a release unless `--activate` is passed. Neither
helper changes systemd EnvironmentFile, provider rate limits, or database data.
