/**
 * The SIP final responses core releases a call with or reads from a trunk's answer (RFC 3261
 * §21), and the Q.850 causes Asterisk reports for a phone's busy or decline (`AST_CAUSE_*` in
 * Asterisk's causes.h).
 */
export const SIP_FORBIDDEN = 403;
export const SIP_NOT_FOUND = 404;
export const SIP_TEMPORARILY_UNAVAILABLE = 480;
export const SIP_ADDRESS_INCOMPLETE = 484;
export const SIP_BUSY_HERE = 486;
export const SIP_SERVER_ERROR = 500;
export const SIP_SERVICE_UNAVAILABLE = 503;
export const SIP_BUSY_EVERYWHERE = 600;
export const SIP_DECLINE = 603;

/** Asterisk's cause for a normal hangup; chan_pjsip answers a release with it as 603 Decline. */
export const AST_CAUSE_NORMAL_CLEARING = 16;
/** Asterisk's cause for SIP 486 Busy Here and 600 Busy Everywhere. */
export const AST_CAUSE_USER_BUSY = 17;
/** Asterisk's cause for SIP 603 Decline. */
export const AST_CAUSE_CALL_REJECTED = 21;
/** Q.850 "network out of order": the cause a channel that went with its Asterisk is ended with. */
export const AST_CAUSE_NETWORK_OUT_OF_ORDER = 38;
