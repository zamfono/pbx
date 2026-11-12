# Retired in 0.9.1 (docs/spec.md §6.3 "Updates"): api and the host agent do what the updater did.
# The image stays, so update.sh of 0.9.0 and earlier, which pulls a new release's images by its
# own compose.yaml and so names the updater, finds one to pull; the release it installs runs no
# updater. It is the proxy image, whose layers the host already holds, idle.
FROM proxy
ENTRYPOINT ["sleep", "infinity"]
CMD []
# `sleep` as PID 1 ignores SIGTERM, and there is nothing to stop cleanly.
STOPSIGNAL SIGKILL
