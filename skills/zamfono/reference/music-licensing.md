# Hold music licensing

The bundled hold-music class is Asterisk's own opsound set, installed in the image from Debian's
`asterisk-moh-opsound-wav` and `asterisk-moh-opsound-g722` packages (8 kHz and 16 kHz, so a
wideband call gets wideband music) and seeded at first boot as five `audio_assets` rows. It is
licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), which permits the
commercial use a phone system makes of it provided the artists are credited (below) and any
redistributed adaptation carries the same licence. The artists are not registered with a
collecting society, which is what makes this bundled set free of GEMA (Germany) and AKM (Austria)
fees.

| Track          | Artist       | File (`<artist>-<track>`)    |
| -------------- | ------------ | ---------------------------- |
| Cold Day       | Macroform    | `macroform-cold_day`         |
| Robot Dity     | Macroform    | `macroform-robot_dity`       |
| The Simplicity | Macroform    | `macroform-the_simplicity`   |
| Morning Coffee | Manolo Camp  | `manolo_camp-morning_coffee` |
| System         | Reno Project | `reno_project-system`        |

Music a tenant uploads through `audio.create` (`POST /api/v1/audio`) (kind `moh`) and sets as
`settings.holdMohAudioId` or a ring group's `mohAudioId` is the tenant's own licensing matter — a
track from a personal music library, a jingle a marketing agency produced, or anything else the
tenant did not clear for commercial phone-system playback can attract a GEMA/AKM claim or a
copyright notice the same way playing it in a shop would. Clear the rights, or a collecting-society
licence, before uploading anything beyond the bundled set.
