FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# Links the published package to its repository (§6.3 "Images"). CI adds
# org.zamfono.asterisk.version, the installed package's version, after the build: a LABEL cannot
# read what a RUN installed.
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

# Zamfono APT repository (spec §4):
# fetch its archive keyring package, refused unless it is the one checked in here by its SHA-256
# (a new keyring package is a change to this line), register the source, install Asterisk 22 plus the module
# and music-on-hold packages the stack needs (spec §9.1, §9.3, §9.4), nftables and inotify-tools for
# the ban helper (§5.6), and coturn for the STUN server the `stun` service runs from this image
# (§6.1). The `asterisk` package pulls in Debian's English sounds, kept as the safety net for a
# prompt not yet generated (§9.1). ca-certificates stays installed:
# transport-tls checks a trunk provider's certificate against its bundle (§9.4 "Signaling").
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/zamfono-archive-keyring.deb \
       https://packages.zamfono.com/debian/asterisk/22/pool/main/z/zamfono-archive-keyring/zamfono-archive-keyring_1.0_all.deb \
    && echo '831397f10ab08cdf51e658026c873f98d3717fa4c27d2f5d76961148cfedbc34  /tmp/zamfono-archive-keyring.deb' \
       | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/zamfono-archive-keyring.deb \
    && rm /tmp/zamfono-archive-keyring.deb \
    && echo 'deb [signed-by=/usr/share/keyrings/zamfono-archive-keyring.gpg] https://packages.zamfono.com/debian/asterisk/22 trixie main' \
       > /etc/apt/sources.list.d/zamfono-asterisk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       asterisk \
       asterisk-modules-pjsip \
       asterisk-modules-ari \
       asterisk-modules-hep \
       asterisk-modules-opus \
       asterisk-modules-amr \
       asterisk-moh-opsound-wav \
       asterisk-moh-opsound-g722 \
       coturn \
       gettext-base \
       inotify-tools \
       nftables \
       openssl \
    && rm -rf /var/lib/apt/lists/*

# The prompt sets (spec §9.1), committed audio that scripts/generate-prompts.mjs made from
# prompts/<language>.json, one per voice; each holds every prompt the core can play in its
# language, under the channel language the core sets, `<language>_<voice>`.
COPY prompts/de/female /usr/share/asterisk/sounds/de_female
COPY prompts/de/male /usr/share/asterisk/sounds/de_male
COPY prompts/en/female /usr/share/asterisk/sounds/en_female
COPY prompts/en/male /usr/share/asterisk/sounds/en_male
COPY prompts/es/female /usr/share/asterisk/sounds/es_female
COPY prompts/es/male /usr/share/asterisk/sounds/es_male
COPY prompts/fr/female /usr/share/asterisk/sounds/fr_female
COPY prompts/fr/male /usr/share/asterisk/sounds/fr_male
COPY prompts/it/female /usr/share/asterisk/sounds/it_female
COPY prompts/it/male /usr/share/asterisk/sounds/it_male
COPY prompts/pl/female /usr/share/asterisk/sounds/pl_female
COPY prompts/pl/male /usr/share/asterisk/sounds/pl_male
COPY prompts/ru/female /usr/share/asterisk/sounds/ru_female
COPY prompts/ru/male /usr/share/asterisk/sounds/ru_male

# The Node images' shared volumes (media, asterisk-config) are written by the `node` user
# (uid/gid 1000); Asterisk is remapped to the same id so both sides can write them (spec §6.3
# "Migrations").
RUN usermod -u 1000 asterisk \
    && groupmod -g 1000 asterisk \
    && mkdir -p /media /etc/asterisk/gen /var/run/asterisk /var/lib/asterisk/astdb \
    && chown -R asterisk:asterisk \
       /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk \
       /media \
# An ARI `record` name resolves against Asterisk's recording directory, so that directory is the
# shared media volume: `core` records voicemail as `voicemail/<id>`, a phone-recorded greeting as
# `prompts/<id>` and a call's snoop pair as `recordings/<id>-{l,r}`, and `api` reads the same
# files back from /media under those names (§11.6).
    && rm -rf /var/spool/asterisk/recording \
    && ln -s /media /var/spool/asterisk/recording

# The `asterisk` package ships a sample .conf (and extensions.ael) per module, including a
# second dialplan source; only the image's own configuration remains (spec §9.1).
RUN rm -f /etc/asterisk/*.conf /etc/asterisk/*.ael

COPY conf/pjsip.conf.tmpl conf/ari.conf.tmpl conf/http.conf.tmpl conf/manager.conf.tmpl \
     conf/hep.conf.tmpl conf/rtp.conf.tmpl conf/modules.conf.tmpl /etc/asterisk/templates/
# indications.conf ships as the image's own static file (spec §9.1): the single `itu` zone, no
# environment variable feeds it, so it is copied here rather than templated at start like
# hep.conf/rtp.conf. res_indications is not a loadable module (main/indications.c is linked into
# the core binary), so there is nothing to keep out of modules.conf's noload list for it.
COPY conf/asterisk.conf conf/extensions.conf conf/logger.conf conf/sorcery.conf \
     conf/indications.conf conf/pjsip_wizard.conf /etc/asterisk/
COPY conf/musiconhold.conf.static /etc/asterisk/musiconhold.conf

COPY entrypoint.sh /entrypoint.sh
# Run by Asterisk itself through hep.conf's `#exec` (spec §7, §9.1).
COPY hep-capture-address.sh /usr/local/bin/hep-capture-address
# The ban helper and the container's healthcheck, its heartbeat (spec §6.3, §9.1).
COPY sip-ban-helper.sh /usr/local/bin/sip-ban-helper
COPY ban-helper-alive.sh /usr/local/bin/ban-helper-alive
RUN chmod +x /entrypoint.sh /usr/local/bin/hep-capture-address /usr/local/bin/sip-ban-helper \
    /usr/local/bin/ban-helper-alive

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it.
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

ENTRYPOINT ["/entrypoint.sh"]
