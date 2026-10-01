# The runtime base the api and core images both start from (docs/spec.md §6.3 "Images"): Node,
# ffmpeg, which api transcodes audio with and core mixes recordings with (§10.2), and the /data and
# /media mount points, owned by the `node` user. docker-bake.hcl builds it once as the `runtime-base`
# target and hands it to both as a build context, so the two images share its ~460 MB layer in
# CI's archive and in an operator's pull. It is never published on its own.
FROM node:26-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /media \
	&& chown node:node /data /media
