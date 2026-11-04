import { receiveWhatsAppMessage as receiveCoachingMessage } from './coaching/receptionist.js';
import { receiveGymWhatsAppMessage } from './gymReceptionist.js';
import { onInboundMessage } from './whatsapp.js';

/**
 * Hooks the WhatsApp receptionists onto every tenant's socket. Each one
 * resolves the tenant from the socket's slug and answers only for its own
 * vertical, so a message goes to CoachBook's admissions assistant first and,
 * when the account is not a CoachBook one, on to GymBook's front desk.
 * Idempotent.
 */
export function startReceptionists() {
  onInboundMessage(async (event) => {
    const coaching = await receiveCoachingMessage(event);
    return coaching.reason === 'not_coaching' ? receiveGymWhatsAppMessage(event) : coaching;
  });
}
