export {
  PLACEHOLDERS,
  loadBuiltinTemplate,
  type Language,
  type TemplateKind,
  type TemplateSource
} from './templates.js';
export {
  compileTemplate,
  resolveTemplate,
  type CompiledTemplate
} from './render.js';
export { relayFromSettings, type RelayConfig } from './relay.js';
export {
  sendMail,
  type AnyMailRequest,
  type SetupOrResetRequest,
  type UpdateMailRequest
} from './send.js';
