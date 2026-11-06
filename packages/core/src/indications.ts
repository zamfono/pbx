/**
 * The tones `core` plays from the one zone `images/asterisk/conf/indications.conf` defines (spec
 * §9.1), ITU-T E.180's, for every tenant whatever its `settings.country`.
 */
const ITU_ZONE = 'itu';

/** The short error tone of an empty parking slot (§10.1 Outbound step 3): the `itu` zone's
 * `congestion` tone, played for {@link ERROR_TONE_MS}. */
export const ERROR_TONE_MEDIA = `tone:congestion;tonezone=${ITU_ZONE}`;

/** How long the error tone plays: five of its 400 ms cycles. */
export const ERROR_TONE_MS = 2000;
