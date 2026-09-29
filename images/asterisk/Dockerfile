FROM debian:trixie-slim

# Links the published package to its repository (§6.3 "Images"). CI adds
# org.zamfono.asterisk.version, the installed package's version, after the build: a LABEL cannot
# read what a RUN installed.
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

# Zamfono APT repository (built by the sibling asterisk-builder repo for Debian 13, spec §4):
# fetch its archive keyring package, register the source, install Asterisk 22 plus the module
# and sound packages the stack needs (spec §9.1, §9.3, §9.4).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/zamfono-archive-keyring.deb \
       https://packages.zamfono.com/debian/asterisk/22/pool/main/z/zamfono-archive-keyring/zamfono-archive-keyring_1.0_all.deb \
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
       asterisk-core-sounds-en-wav asterisk-core-sounds-es-wav asterisk-core-sounds-fr-wav \
       asterisk-core-sounds-it-wav asterisk-core-sounds-ru-wav \
       asterisk-core-sounds-en-g722 asterisk-core-sounds-es-g722 asterisk-core-sounds-fr-g722 \
       asterisk-core-sounds-it-g722 asterisk-core-sounds-ru-g722 \
       asterisk-prompt-de \
       asterisk-moh-opsound-wav \
       asterisk-moh-opsound-g722 \
       gettext-base \
       openssl \
    && rm -rf /var/lib/apt/lists/*

# The community sound packages install into locale+voice directories (`es_MX_f_Allison`,
# `fr_CA_f_June`, `it_IT_m_Carlo`, `ru_RU_f_IvrvoiceRU`); Asterisk resolves a channel's prompts
# at `sounds/<language>`, so each tenant language needs a directory of that exact name. `en` and
# `de` get theirs from `asterisk-core-sounds-en`/`asterisk-prompt-de`'s own alternatives; there is
# no equivalent alternative package for the other four (spec §9.1).
RUN ln -s es_MX_f_Allison /usr/share/asterisk/sounds/es \
    && ln -s fr_CA_f_June /usr/share/asterisk/sounds/fr \
    && ln -s it_IT_m_Carlo /usr/share/asterisk/sounds/it \
    && ln -s ru_RU_f_IvrvoiceRU /usr/share/asterisk/sounds/ru

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
# indications.conf ships as the image's own static file (spec §9.1, §9.4 "Cross-trunk failover"):
# the single `itu` zone for ITU-T E.180's special information tone, no environment variable feeds
# it, so it is copied here rather than templated at start like hep.conf/rtp.conf. res_indications
# is not a loadable module (main/indications.c is linked into the core binary), so there is
# nothing to keep out of modules.conf's noload list for it.
COPY conf/asterisk.conf conf/extensions.conf conf/logger.conf conf/sorcery.conf \
     conf/indications.conf /etc/asterisk/
COPY conf/musiconhold.conf.static /etc/asterisk/musiconhold.conf

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it.
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

ENTRYPOINT ["/entrypoint.sh"]
