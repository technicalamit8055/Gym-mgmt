import { receiveWhatsAppMessage as receiveCoachingMessage } from './coaching/receptionist.js';
import { receiveGymWhatsAppMessage } from './gymReceptionist.js';
import { receiveVoiceAdminMessage } from './voiceAdmin.js';
import { onInboundMessage } from './whatsapp.js';

/**
 * Hooks the WhatsApp receptionists onto every tenant's socket. Each one
 * resolves the tenant from the socket's slug and answers only for its own
 * vertical, so a message goes to CoachBook's admissions assistant first and,
 * when the account is not a CoachBook one, on to GymBook — where the owner's
 * own commands (src/voiceAdmin.js) are picked out before the front desk
 * answers everyone else. Idempotent.
 */
export function startReceptionists() {
  onInboundMessage(async (event) => {
    const coaching = await receiveCoachingMessage(event);
    if (coaching.reason !== 'not_coaching') return coaching;
    const command = receiveVoiceAdminMessage(event);
    return command.handled ? command : receiveGymWhatsAppMessage(event);
  });
}
