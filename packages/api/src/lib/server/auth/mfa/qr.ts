import { generate } from 'lean-qr';
import { toSvgSource } from 'lean-qr/extras/svg';

// The four-module quiet zone ISO/IEC 18004 requires around a code for scanners to find it.
const QUIET_ZONE = 4;

/** `text` as a QR code, inline SVG markup for the enrolment step (§5.2 "Two-factor
 *  authentication"): dark modules on white whatever the page's theme, since phone cameras read
 *  dark-on-light most reliably. */
export function qrSvg(text: string): string {
  return toSvgSource(generate(text), {
    on: '#000',
    off: '#fff',
    padX: QUIET_ZONE,
    padY: QUIET_ZONE,
    xmlDeclaration: false
  });
}
