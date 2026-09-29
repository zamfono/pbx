// Registers every operations area (§10.3): importing this module for its side effects fills the
// registry the REST route table, the MCP tool list and the OpenAPI document all read from. Grows
// with each task; each adds its own line, alphabetized.
import './audio/index.js';
import './audit/index.js';
import './backups/index.js';
import './blockedNumbers/index.js';
import './calls/index.js';
import './contacts/index.js';
import './devices/index.js';
import './didBlocks/index.js';
import './dids/index.js';
import './hours/index.js';
import './mailTemplates/index.js';
import './menus/index.js';
import './ooo/index.js';
import './outboundRoutes/index.js';
import './parking/index.js';
import './presenceLog/index.js';
import './provisioning/index.js';
import './recordings/index.js';
import './ringGroups/index.js';
import './search/index.js';
import './settings/index.js';
import './system/index.js';
import './stats/index.js';
import './trunks/index.js';
import './userGroups/index.js';
import './users/index.js';
import './voicemails/index.js';
import './webhooks/index.js';
