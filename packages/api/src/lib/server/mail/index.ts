export {
  PLACEHOLDERS,
  loadBuiltinTemplate,
  type TemplateSource
} from './templates.js';
export {
  compileTemplate,
  resolveTemplate,
  type CompiledTemplate
} from './render.js';
export {
  isRelayConfigured,
  relayFromSettings,
  type RelayConfig
} from './relay.js';
export {
  RELAY_ERROR_CLASSES,
  relayState,
  type RelayOutcome
} from './relayState.js';
export {
  sendMail,
  type AnyMailRequest,
  type MfaChangedRequest,
  type SetupOrResetRequest,
  type UpdateMailRequest
} from './send.js';
