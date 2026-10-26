-- Every watched domain is refreshed monthly (due again on the 1st), so a watch no
-- longer has its own interval. watch_log.refresh_days stays as history.
ALTER TABLE watches DROP COLUMN refresh_days;
